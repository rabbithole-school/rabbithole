/**
 * atlasEngine — the Concept Atlas renderer, extracted from the converged design
 * spike (session decluttering spike) so the live React surface can use it.
 *
 * A framework-agnostic engine: give it a viewport element + an onNodeClick
 * callback, then feed it a lens ("atlas" | "sky" | "galaxy") + that lens's data.
 * It owns a custom CSS-3D "living night-sky": every concept is a star at its
 * shared (x,y) atlas coordinate, so the three lenses live in ONE coordinate
 * space and SWITCHING lenses FLIES the camera between framings (a smooth glide,
 * not a cut), with labels/threads deferred until the camera settles.
 *
 * What it does (the decluttering-spike treatments):
 *   • de-clump projection (push the dense core out so clusters separate)
 *   • level-of-detail by zoom — quantized buckets, labels cross-fade in/out
 *   • crisp screen-space labels + bridges that parallax-track the tilted stars
 *     (projectStar replicates the CSS-3D transform so overlays align exactly)
 *   • prominence-gated faint constellation bridges (atlas) / scholar threads (sky)
 *   • viewport culling (don't paint off-screen stars when zoomed in)
 *   • natural default framing (centre of gravity, not bbox) + zoom-to-cursor
 *
 * The live node set is capped (~900) per lens, so unlike the spike (one fixed
 * 3125-node set) we REBUILD the star DOM per lens — cheap at this size — rather
 * than repaint-in-place; the camera glide + deferred label/bridge fade carry the
 * transition smoothness.
 */

import { projectPoint, PERSPECTIVE, clamp as sharedClamp } from "./mapCamera";
import { MAP_LABEL, mapLabelBoxCss, mapLabelHeightPx, mapLabelLines } from "./mapLabelStyle";
import { classifySkyNode, domainColor as domColor, layoutAtlasPoint } from "../shared/skyTiers";

export type AtlasLens = "atlas" | "sky" | "galaxy";

export type AtlasNode = {
  id: string;
  label: string;
  domain: string;
  source: string;
  x: number;
  y: number;
  refCount?: number;
  /** sky lens: hop-distance tier from the scholar's touched set (0 touched · 1 ·
   *  2–3 · 4+/unreached=3) — drives the zoom-reveal grading. */
  hopTier?: number;
};

export type AtlasEdge = { s: string; t: string; k: "bridge" | "explicit"; w?: number };

export type LensData = {
  nodes: AtlasNode[];
  edges?: AtlasEdge[];                 // atlas
  lit?: Record<string, number>;        // sky: mastery concept id → level
  standardLit?: string[];              // sky: standard concept ids reached
  seeds?: string[];                    // sky/galaxy: seed invitation concept ids (gold ring)
  starter?: string[];                  // sky: cold-start "someday" ids (see skyMuseum.ts) — a faint, muted, tappable-with-no-CTA layer
  interactiveSeeds?: string[];         // sky: all live invitations, including zoom-revealed overflow
  threads?: [string, string][];        // sky/galaxy: mastery→standard, mastery→seed
  prereqEdges?: { s: string; t: string }[]; // sky: directed prereq→unlock lattice
  heat?: Record<string, number>;       // galaxy: concept id → # scholars w/ mastery
  reached?: string[];                  // galaxy: standard concept ids ≥1 scholar reached (not lit)
};

export type AtlasEngineOptions = {
  onNodeClick?: (conceptId: string) => void;
  declumpK?: number; // 0..1, default 0.7
};

const h01 = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
// Single-sourced from mapCamera so both skins share one clamp / one projection.
const clamp = sharedClamp;

const SVGNS = "http://www.w3.org/2000/svg";
const PD = PERSPECTIVE; // perspective depth — MUST match the vp's CSS perspective

// The LOD CSS (scoped under the engine root class). Tiers fade in by zoom bucket;
// the ghost territory in sky stays faintly visible at every bucket.
const ENGINE_CSS = `
.atlasEng .ascene{position:absolute;inset:0;transform-style:preserve-3d;will-change:transform;z-index:3}
.atlasEng .abridges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;overflow:visible;transition:opacity .3s ease}
.atlasEng .alabels{position:absolute;inset:0;pointer-events:none;z-index:8;transition:opacity .3s ease}
.atlasEng .albl{position:absolute;left:0;top:0;will-change:transform,opacity;transition:opacity .4s ease}
.atlasEng .astar{cursor:pointer;transition:opacity .5s ease, background-color .5s ease, border-color .5s ease, transform .35s ease}
.atlasEng .astar:hover{filter:brightness(1.7) drop-shadow(0 0 5px #fff)}
.atlasEng .astar.hov{filter:brightness(1.7) drop-shadow(0 0 5px #fff)}
/* Sky lens: only seed stars are interactive. Inert (non-seed) stars keep the
   default cursor, take no hover brightness, and let pointer events fall through
   to the viewport (so pan/drag/zoom over them is unaffected). */
.atlasEng .astar.inert{cursor:default;pointer-events:none}
.atlasEng .astar.inert:hover,.atlasEng .astar.inert.hov{filter:none}
.atlasEng .cull{display:none !important}
.atlasEng .subhide{display:none !important}
.atlasEng .t1,.atlasEng .t2,.atlasEng .t3,.atlasEng .t4{opacity:0;visibility:hidden;pointer-events:none}
.atlasEng .zl1 .t1{opacity:1;visibility:visible;pointer-events:auto}
.atlasEng .zl2 .t1,.atlasEng .zl3 .t1{opacity:1;visibility:visible;pointer-events:auto}
.atlasEng .zl2 .t2,.atlasEng .zl3 .t2{opacity:1;visibility:visible;pointer-events:auto}
.atlasEng .zl2 .t4,.atlasEng .zl3 .t4{opacity:.16;visibility:visible}
.atlasEng .zl3 .t3{opacity:.72;visibility:visible;pointer-events:auto}
.atlasEng .sky .t4{opacity:.085 !important;visibility:visible !important}
`;

type RObj = { el: HTMLDivElement; cid: string; node: AtlasNode; x: number; y: number; z: number; tier: number; r: number; sub: boolean; culled: boolean; inert: boolean; meta: string };
type LabelCand = { x: number; y: number; z: number; label: string; c: string; imp: number; tier: number };
type Bridge = { el: SVGLineElement; ax: number; ay: number; az: number; bx: number; by: number; bz: number; arrow?: boolean };
type LiveLabel = { el: HTMLDivElement; x: number; y: number; z: number; dom: boolean };

export function createAtlasEngine(vp: HTMLElement, opts: AtlasEngineOptions = {}) {
  // ── DOM scaffold inside the viewport ──
  vp.classList.add("atlasEng");
  vp.style.perspective = `${PD}px`;
  let styleEl: HTMLStyleElement | null = document.querySelector("style[data-atlas-engine]");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.dataset.atlasEngine = "1";
    styleEl.textContent = ENGINE_CSS;
    document.head.appendChild(styleEl);
  }
  const scene = document.createElement("div"); scene.className = "ascene";
  const bridgesEl = document.createElementNS(SVGNS, "svg") as SVGSVGElement; bridgesEl.setAttribute("class", "abridges");
  // Arrowhead markers for the directed prereq→unlock lattice (sky). Unique ids per
  // engine instance so two maps on one page can't cross-resolve marker-end urls.
  const _mkUid = Math.random().toString(36).slice(2, 8);
  const LAT_ARROW_B = `latB-${_mkUid}`, LAT_ARROW_F = `latF-${_mkUid}`;
  {
    const mk = (id: string, size: number, fill: string) => {
      const m = document.createElementNS(SVGNS, "marker");
      m.setAttribute("id", id); m.setAttribute("markerWidth", String(size)); m.setAttribute("markerHeight", String(size));
      m.setAttribute("refX", (size * 0.84).toFixed(2)); m.setAttribute("refY", (size / 2).toFixed(2));
      m.setAttribute("orient", "auto"); m.setAttribute("markerUnits", "userSpaceOnUse");
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", `M0,0 L${size},${(size / 2).toFixed(2)} L0,${size} Z`); p.setAttribute("fill", fill);
      m.appendChild(p); return m;
    };
    const defs = document.createElementNS(SVGNS, "defs");
    defs.appendChild(mk(LAT_ARROW_B, 5, "#8b96e8"));
    defs.appendChild(mk(LAT_ARROW_F, 4.4, "rgba(123,134,221,0.34)"));
    bridgesEl.appendChild(defs);
  }
  const labelsEl = document.createElement("div"); labelsEl.className = "alabels";
  const tip = document.createElement("div");
  tip.style.cssText = "position:absolute;left:0;top:0;opacity:0;pointer-events:none;z-index:20;transition:opacity .12s;max-width:240px;background:#1a1438;color:#efe9ff;font-size:11px;line-height:1.35;padding:5px 9px;border-radius:7px;border:1px solid #3a2d70";
  vp.appendChild(bridgesEl); vp.appendChild(scene); vp.appendChild(labelsEl); vp.appendChild(tip);

  // ── state ──
  let lens: AtlasLens = "atlas";
  let nodes: AtlasNode[] = [];
  let heat: Record<string, number> = {};
  let edges: AtlasEdge[] = [];
  let latticeEdges: { s: string; t: string }[] = []; // sky: directed prereq→unlock
  const LIT = new Map<string, "mastery" | "standard" | "seed" | "starter">();
  const INTERACTIVE_SEEDS = new Set<string>();
  let THREADS: [string, string][] = [];
  let declumpK = opts.declumpK ?? 0.7;

  let cx = 50, cy = 50;
  let panX = 0, panY = 0, zoom = 1, zt = 1, rx = 0, ry = 0, ptx = 0, pty = 0, px = 0, py = 0;
  let hoverId: string | null = null, zoomCX = 0, zoomCY = 0, zoomAnchored = false;
  let panTX = 0, panTY = 0, camAnim = false, transitioning = false, baseZoom = 1;
  let vpW = vp.clientWidth || 1040, vpH = vp.clientHeight || 620;
  const measureVp = () => { vpW = vp.clientWidth || 1040; vpH = vp.clientHeight || 620; };

  let posAll = new Map<string, { x: number; y: number }>();
  let domCentroids: { domain: string; x: number; y: number; n: number; color: string }[] = [];
  let nodeArr: RObj[] = [];
  let nodeById = new Map<string, RObj>();
  let labelCands: LabelCand[] = [];
  let liveBridges: Bridge[] = [];
  let curBucket = -1;
  const lblEls = new Map<string, HTMLDivElement>();
  let liveLabels: LiveLabel[] = [];
  let openAt = performance.now();

  // ── 3D projection mirroring the scene's CSS transform (for screen-space overlays) ──
  let _cRx = 1, _sRx = 0, _cRy = 1, _sRy = 0, _sc = 1, _ox = vpW / 2, _oy = vpH / 2;
  function updateProjection(opv: number) {
    const rxr = rx * Math.PI / 180, ryr = ry * Math.PI / 180;
    _cRx = Math.cos(rxr); _sRx = Math.sin(rxr); _cRy = Math.cos(ryr); _sRy = Math.sin(ryr);
    _sc = zoom * (0.97 + 0.03 * opv); _ox = vpW / 2; _oy = vpH / 2;
  }
  function projectStar(xPct: number, yPct: number, z: number) {
    // Delegates to the shared projection (mapCamera.projectPoint) so the Sky and
    // the tech-tree skin are guaranteed to project identically — one formula,
    // two skins. Behavior-preserving: the state fed in is exactly the locals
    // updateProjection() maintains.
    return projectPoint(
      {
        cRx: _cRx, sRx: _sRx, cRy: _cRy, sRy: _sRy,
        sc: _sc, vsy: 1, ox: _ox, oy: _oy, panX, panY, perspective: PD,
      },
      xPct, yPct, z, vpW, vpH,
    );
  }

  function layoutXY(n: AtlasNode) {
    return layoutAtlasPoint(n, { x: cx, y: cy }, declumpK);
  }
  function ensureLayout() {
    cx = nodes.reduce((a, n) => a + n.x, 0) / (nodes.length || 1);
    cy = nodes.reduce((a, n) => a + n.y, 0) / (nodes.length || 1);
    posAll = new Map();
    const agg: Record<string, { sx: number; sy: number; n: number }> = {};
    for (const n of nodes) {
      const p = layoutXY(n); posAll.set(n.id, p);
      const k = n.domain || "other"; (agg[k] = agg[k] || { sx: 0, sy: 0, n: 0 }); agg[k].sx += p.x; agg[k].sy += p.y; agg[k].n++;
    }
    domCentroids = Object.entries(agg).filter(([, a]) => a.n >= 6)
      .map(([d, a]) => ({ domain: d, x: a.sx / a.n, y: a.sy / a.n, n: a.n, color: domColor(d) }))
      .sort((a, b) => b.n - a.n);
  }

  function classify(n: AtlasNode): { tier: number; c: string; r: number; glow: number; meta: string; ring?: boolean } {
    const hh = heat[n.id] || 0, dom = domColor(n.domain);
    if (lens === "galaxy") {
      const role = LIT.get(n.id);
      // ≥2 scholars have demonstrated it → a CONVERGENCE (the loudest signal).
      // Bright gold, scaled + glowing with the crowd — the group-assignment cue.
      if (hh >= 2) return { tier: 0, c: "#f1d98a", r: 2.6 + Math.min(hh, 7) * 1.1, glow: 2.2, meta: hh + " scholars · convergence" };
      // A live invitation for SOMEONE in the cohort — hollow gold ring, same as
      // the scholar Sky's seed star (an idea the cohort is being pulled toward).
      if (role === "seed") return { tier: 0, c: "#e7c25c", r: 2.5, glow: 1.2, meta: "an invitation in the cohort", ring: true };
      if (hh >= 1) return { tier: 0, c: "#c79cf2", r: 3.0, glow: 1.5, meta: "1 scholar" }; // (hh>=2 handled above)
      // Reached toward (a standard ≥1 scholar demonstrated) — a grounded, mid star.
      if (role === "standard") return { tier: 2, c: dom, r: 2.0, glow: 0.9, meta: "reached" };
      return { tier: 4, c: dom, r: 2.0, glow: 0, meta: "not yet touched" };
    }
    if (lens === "sky") {
      const role = LIT.get(n.id);
      return classifySkyNode({ role, domain: n.domain, refCount: n.refCount, hopTier: n.hopTier });
    }
    if (n.source === "mastery") return { tier: 0, c: "#b78ce8", r: 3.0 + ((n.refCount ?? 1) > 1 ? 0.7 : 0), glow: 1.7, meta: "demonstrated mastery" };
    if (n.source === "standard") { const big = (n.refCount ?? 1) > 1; return { tier: big ? 1 : 2, c: dom, r: 1.9 + (big ? 0.7 : 0), glow: 1.2, meta: "standard" }; }
    return { tier: 3, c: dom, r: 1.7, glow: 0.8, meta: "seed" };
  }

  // ── star raster supersampling + zoom attenuation ──
  // Stars are laid out TINY (2–5px) inside one big CSS-3D scene that scales up
  // to ~10× on deep zoom. Chrome rasterizes each star layer at its layout size
  // and the idle-sway rAF keeps the scene transform perpetually animating, so
  // the raster is never refreshed at the new scale — magnified stars smear into
  // mushy squares (verified via pixel crops, 2026-07-03). Fix: SUPERSAMPLE —
  // build each star RASTER× larger and counter-scale it down in its own
  // transform, so the backing raster has RASTER× headroom before it blurs.
  const RASTER = 8;
  // Per-bucket visual growth damping: without it a 2.3px territory dot becomes
  // a ~22px blob at deep zoom, swamping the gold seeds ("the deep field is too
  // distracting"). Stars still grow with zoom — just sublinearly.
  const ATTEN = [1, 0.9, 0.72, 0.55];
  const starScale = (b: number) => (ATTEN[Math.max(0, Math.min(3, b))] / RASTER);
  // Sky parity with native: the non-seed / non-mastery field (standards +
  // territory) renders at 0.7× so the gold seeds stay the headline and the deep
  // field reads as quiet background. Mirrors NON_SEED_DOT_SCALE in native sky.tsx.
  // (Web's labels already reveal by tier+bucket, so only the size needs matching.)
  const NON_SEED_DOT_SCALE = 0.7;

  // Build + style the star DOM for the current lens (rebuild — node set differs per lens).
  function buildScene() {
    ensureLayout();
    let html = "";
    for (let i = 0; i < 40; i++) { const s = (Math.random() > 0.85 ? 3 : 2) * RASTER; html += `<div style="position:absolute;border-radius:50%;background:#cfd0ee;left:${(Math.random() * 98 + 1).toFixed(1)}%;top:${(Math.random() * 96 + 2).toFixed(1)}%;width:${s}px;height:${s}px;opacity:${(0.16 + Math.random() * 0.28).toFixed(2)};transform:scale(${(1 / RASTER).toFixed(4)})"></div>`; }
    labelCands = [];
    for (const n of nodes) {
      const p = posAll.get(n.id)!; const s = classify(n);
      const sub = lens === "sky" && s.tier === 4 && h01(n.id + "g") > 0.2; // ghost subsample
      if (sub) continue;
      const zoff = Math.round((h01(n.id + "z") - 0.5) * 70);
      // Sky lens: only seed stars are interactive. Everything else (mastery,
      // standard, territory) is INERT — no pointer cursor, no tooltip, no hover
      // brightness, and pointer-events:none so gestures pass through to the vp.
      const skyRole = lens === "sky" ? LIT.get(n.id) : undefined;
      const inert = lens === "sky" && !INTERACTIVE_SEEDS.has(n.id);
      // 0.7× the non-seed / non-mastery / non-starter field (parity with
      // native sky.tsx). Mastery and starter already carry their own smaller,
      // dimmer intrinsic r/glow (shared/skyTiers.ts classifySkyNode), so they
      // read below a seed without this extra shrink — applying it too would
      // make a cold-start scholar's ONLY content nearly invisible.
      const rMul =
        lens === "sky" && skyRole !== "seed" && skyRole !== "mastery" && skyRole !== "starter"
          ? NON_SEED_DOT_SCALE
          : 1;
      const tag = `class="astar${inert ? " inert" : ""} t${s.tier}" data-z="${zoff}" data-cid="${n.id}" data-label="${esc(n.label)}" data-domain="${esc(n.domain)}" data-meta="${esc(s.meta)}" data-r="${(s.tier === 4 ? 2.2 : s.r).toFixed(1)}"`;
      const base = `position:absolute;left:${p.x}%;top:${p.y}%;transform:translate(-50%,-50%) translateZ(${zoff}px) scale(${starScale(0).toFixed(4)});border-radius:50%;`;
      if (s.tier === 4) html += `<div ${tag} style="${base}width:${(2.2 * RASTER * rMul).toFixed(1)}px;height:${(2.2 * RASTER * rMul).toFixed(1)}px;background:${s.c}"></div>`;
      // Ring (seed) stars: border-box + a border ~28% of the diameter keeps a
      // real hole in the middle at every zoom (a fixed 1.4px border under
      // border-box swallowed the whole box → seeds read as solid discs).
      else if (s.ring) html += `<div ${tag} style="${base}width:${(s.r * RASTER).toFixed(1)}px;height:${(s.r * RASTER).toFixed(1)}px;background:transparent;box-sizing:border-box;border:${(s.r * RASTER * 0.28).toFixed(1)}px solid ${s.c};box-shadow:0 0 ${(s.r * s.glow * RASTER).toFixed(1)}px ${s.c}"></div>`;
      else html += `<div ${tag} style="${base}width:${(s.r * RASTER * rMul).toFixed(1)}px;height:${(s.r * RASTER * rMul).toFixed(1)}px;background:${s.c};box-shadow:0 0 ${(s.r * s.glow * RASTER).toFixed(1)}px ${s.c}"></div>`;
      const hh = heat[n.id] || 0; let imp = 0;
      if (lens === "galaxy") {
        const role = LIT.get(n.id);
        // Labels de-densified: convergences loudest, then cohort invitations, then
        // single-scholar lit (the latter is tier 1 → reveals on zoom, not at rest).
        if (hh >= 2) imp = 3 + hh;
        else if (role === "seed") imp = 2.2;
        else if (hh >= 1) imp = 1;
      }
      // Seed labels win first (the brightest, most actionable layer), then
      // mastery, then reached standards, then a cold-start starter (still
      // labeled — a fresh scholar needs to read what these stars ARE), then
      // plain territory (label reveals only on deep zoom).
      else if (lens === "sky") { const role = LIT.get(n.id); if (role === "seed") imp = 3; else if (role === "mastery") imp = 2 + ((n.refCount ?? 1) > 1 ? 0.5 : 0); else if (role === "standard") imp = 1.4; else if (role === "starter") imp = 1.1; else imp = 0.5; /* territory — its label reveals on deep zoom */ }
      else { if (n.source === "mastery") imp = 2 + ((n.refCount ?? 1) > 1 ? 1 : 0); else if (n.source === "seed") imp = 0.6; }
      if (imp > 0) labelCands.push({ x: p.x, y: p.y, z: zoff, label: n.label, c: s.c, imp, tier: s.tier });
    }
    scene.innerHTML = html;
    scene.classList.toggle("sky", lens === "sky");
    nodeArr = []; nodeById = new Map();
    for (const el of Array.from(scene.querySelectorAll<HTMLDivElement>(".astar"))) {
      const cid = el.dataset.cid!; const n = posAll.get(cid); if (!n) continue;
      const o: RObj = { el, cid, node: nodes.find((x) => x.id === cid)!, x: n.x, y: n.y, z: +el.dataset.z!, tier: +(el.className.match(/t(\d)/)?.[1] ?? 4), r: +(el.dataset.r ?? 2), sub: false, culled: false, inert: el.classList.contains("inert"), meta: el.dataset.meta ?? "" };
      nodeArr.push(o); nodeById.set(cid, o);
    }
    curBucket = -1; lblEls.clear(); labelsEl.innerHTML = "";
  }

  // ── viewport culling ──
  let lastCullZoom = 0, lastCullPanX = 0, lastCullPanY = 0;
  function cull(force?: boolean) {
    if (!force) { const dz = Math.abs(zoom - lastCullZoom), dp = Math.abs(panX - lastCullPanX) + Math.abs(panY - lastCullPanY); if (dz < lastCullZoom * 0.03 && dp < 46) return; }
    lastCullZoom = zoom; lastCullPanX = panX; lastCullPanY = panY;
    const z = zoom, hw = vpW / 2, hh = vpH / 2, m = 90; let flipped = false;
    for (const N of nodeArr) {
      const sx = hw + (N.x / 100 * vpW - hw) * z + panX, sy = hh + (N.y / 100 * vpH - hh) * z + panY;
      const out = sx < -m || sx > vpW + m || sy < -m || sy > vpH + m;
      if (out !== N.culled) { N.culled = out; N.el.classList.toggle("cull", out); flipped = true; }
    }
    if (flipped && !transitioning) renderBridges();
  }

  // ── bridges (prominence-gated, parallax-tracking, screen-space) ──
  const PROM = [1.0, 0.78, 0.55, 0.34, 0.0];
  // Galaxy: above this many union threads, draw only convergence-/seed-touching
  // lines at rest (the rest reveal on hover) — keeps the union legible at scale.
  const GALAXY_THREAD_REST_CAP = 150;
  function tierVisibleNow(t: number) { return t === 0 || (t === 1 && curBucket >= 1) || (t === 2 && curBucket >= 2) || (t === 3 && curBucket >= 3); }
  function bridgeEndpointOk(N: RObj | undefined) { return !!N && !N.culled && tierVisibleNow(N.tier) && N.tier <= 1; }
  function computeBridges() {
    liveBridges = [];
    // clear lines but keep the <defs>/markers
    for (const ch of Array.from(bridgesEl.childNodes)) if ((ch as Element).nodeName !== "defs") bridgesEl.removeChild(ch);
    const add = (A: RObj, B: RObj, stroke: string, w: number) => {
      const ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("stroke", stroke); ln.setAttribute("stroke-width", String(w));
      bridgesEl.appendChild(ln); liveBridges.push({ el: ln, ax: A.x, ay: A.y, az: A.z, bx: B.x, by: B.y, bz: B.z });
    };
    // directed prereq (A) → unlock (B); arrowhead at B, endpoints inset in positionBridges
    const addLattice = (A: RObj, B: RObj, bright: boolean) => {
      const ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("stroke", bright ? "rgba(139,150,232,.92)" : "rgba(123,134,221,.15)");
      ln.setAttribute("stroke-width", bright ? "1" : "0.6");
      ln.setAttribute("marker-end", `url(#${bright ? LAT_ARROW_B : LAT_ARROW_F})`);
      bridgesEl.appendChild(ln); liveBridges.push({ el: ln, ax: A.x, ay: A.y, az: A.z, bx: B.x, by: B.y, bz: B.z, arrow: true });
    };
    if (lens === "sky") {
      // The prereq/unlock lattice grades with focus: faint-global once you're deep
      // in the field (bucket 3), and the hovered/tapped node's incident lattice
      // lights up bright at any zoom (its prereqs behind + unlocks ahead).
      if (curBucket >= 3) {
        for (const e of latticeEdges) {
          if (hoverId && (e.s === hoverId || e.t === hoverId)) continue; // drawn bright below
          const A = nodeById.get(e.s), B = nodeById.get(e.t);
          if (!A || !B || (A.culled && B.culled)) continue;
          addLattice(A, B, false);
        }
      }
      for (const [a, b] of THREADS) { const A = nodeById.get(a), B = nodeById.get(b); if (A && B && (!A.culled || !B.culled)) add(A, B, "rgba(206,190,242,.62)", 0.7); }
      if (hoverId) {
        for (const e of latticeEdges) { if (e.s !== hoverId && e.t !== hoverId) continue; const A = nodeById.get(e.s), B = nodeById.get(e.t); if (A && B && !(A.culled && B.culled)) addLattice(A, B, true); }
        for (const e of edges) { if (e.s !== hoverId && e.t !== hoverId) continue; const A = nodeById.get(e.s), B = nodeById.get(e.t); if (A && B) add(A, B, "rgba(245,225,150,.9)", 1); }
      }
      positionBridges(); return;
    }
    if (lens === "galaxy") {
      // The union of every in-scope scholar's constellation lines. Faint at rest;
      // the hovered star's own threads light up gold (its convergences + seeds).
      const many = THREADS.length > GALAXY_THREAD_REST_CAP;
      for (const [a, b] of THREADS) {
        if (hoverId && (a === hoverId || b === hoverId)) continue; // drawn bright below
        const A = nodeById.get(a), B = nodeById.get(b);
        if (!A || !B || (A.culled && B.culled)) continue;
        if (many) {
          const keep = (heat[a] || 0) >= 2 || (heat[b] || 0) >= 2 || LIT.get(a) === "seed" || LIT.get(b) === "seed";
          if (!keep) continue;
        }
        add(A, B, "rgba(206,190,242,.16)", 0.6);
      }
      if (hoverId) {
        for (const [a, b] of THREADS) {
          if (a !== hoverId && b !== hoverId) continue;
          const A = nodeById.get(a), B = nodeById.get(b);
          if (A && B && !(A.culled && B.culled)) add(A, B, "rgba(245,225,150,.9)", 1);
        }
      }
      positionBridges(); return;
    }
    if (lens !== "atlas") return;
    if (hoverId) for (const e of edges) { if (e.s !== hoverId && e.t !== hoverId) continue; const A = nodeById.get(e.s), B = nodeById.get(e.t); if (A && B) add(A, B, "rgba(245,225,150,.9)", 1); }
    for (const e of edges) {
      if (hoverId && (e.s === hoverId || e.t === hoverId)) continue;
      const A = nodeById.get(e.s), B = nodeById.get(e.t); if (!A || !B) continue;
      if (!(bridgeEndpointOk(A) && bridgeEndpointOk(B))) continue;
      const op = (e.k === "bridge" ? 0.40 : 0.42) * Math.min(PROM[A.tier], PROM[B.tier]);
      if (op < 0.05) continue;
      add(A, B, (e.k === "bridge" ? "rgba(241,210,120," : "rgba(205,190,242,") + op.toFixed(2) + ")", 0.5);
    }
    positionBridges();
  }
  function positionBridges() {
    for (const L of liveBridges) {
      const a = projectStar(L.ax, L.ay, L.az), b = projectStar(L.bx, L.by, L.bz);
      let ax = a.sx, ay = a.sy, bx = b.sx, by = b.sy;
      if (L.arrow) {
        // inset both ends in screen space: clear the source dot, and leave room at
        // the target for the arrowhead to sit just outside the dot.
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        ax += ux * 5; ay += uy * 5; bx -= ux * 7; by -= uy * 7;
      }
      L.el.setAttribute("x1", ax.toFixed(1)); L.el.setAttribute("y1", ay.toFixed(1));
      L.el.setAttribute("x2", bx.toFixed(1)); L.el.setAttribute("y2", by.toFixed(1));
    }
  }
  const renderBridges = computeBridges;

  // ── quantized zoom buckets (relative to baseZoom) ──
  const bucketOf = (z: number) => { const r = z / baseZoom; if (r < 1.3) return 0; if (r < 1.9) return 1; if (r < 2.8) return 2; return 3; };
  const DOM_OP = [0.80, 0.50, 0.28, 0.14], CON_OP = [0.0, 0.62, 0.86, 0.90];

  function relayoutLabels() {
    const b = curBucket; if (b < 0) return; measureVp();
    const S_DOM = 15, S_CON = MAP_LABEL.fontSizePx, MAXL = lens === "galaxy" ? 40 : 70, PADEM = 0.3;
    const items: { lid: string; x: number; y: number; z: number; label: string; c: string; kind: "domain" | "concept"; op: number; score: number }[] = [];
    if (DOM_OP[b] > 0.12) {
      const dscale = lens === "sky" ? 0.5 : 1;
      for (const d of domCentroids) items.push({ lid: "dom:" + d.domain, x: d.x, y: d.y, z: 0, label: d.domain, c: d.color, kind: "domain", op: DOM_OP[b] * dscale, score: lens === "sky" ? 2.5 : d.n * 4 });
    }
    if (CON_OP[b] > 0.05 || lens === "sky") {
      for (const l of labelCands) {
        const vis = l.tier === 0 || (l.tier === 1 && b >= 1) || (l.tier === 2 && b >= 2) || (l.tier === 3 && b >= 3);
        if (!vis) continue;
        let op: number;
        if (lens === "sky") op = Math.min(0.96, (l.imp >= 3 ? 0.92 : l.imp >= 2 ? 0.8 : 0.66));
        else op = l.imp >= 2 ? Math.max(CON_OP[b], 0.55) : CON_OP[b];
        items.push({ lid: l.label, x: l.x, y: l.y, z: l.z, label: l.label, c: l.c, kind: "concept", op, score: (lens === "sky" ? l.imp * 4 : l.imp * 2) });
      }
    }
    items.sort((a, b2) => b2.score - a.score);
    updateProjection(Math.min(1, (performance.now() - openAt) / 1200));
    const placed: { x: number; y: number; w: number; h: number }[] = []; const keep = new Set<string>();
    const collide = (B: { x: number; y: number; w: number; h: number }) => placed.some((p) => !(B.x + B.w < p.x || p.x + p.w < B.x || B.y + B.h < p.y || p.y + p.h < B.y));
    for (const it of items) {
      if (placed.length >= MAXL) break;
      const S = it.kind === "domain" ? S_DOM : S_CON, pad = PADEM * S, p = projectStar(it.x, it.y, it.z);
      if (p.sx < -220 || p.sx > vpW + 220 || p.sy < -140 || p.sy > vpH + 140) continue;
      // Concept labels share the Tree's metrics (font/width/lines via MAP_LABEL):
      // cap the width at maxWidth + reserve up to `lineClamp` wrapped lines so the
      // de-confliction reflects the real (wrapped) box. Domain labels unchanged.
      const singleW = it.label.length * S * 0.56;
      const w = (it.kind === "domain" ? singleW : Math.min(singleW, MAP_LABEL.maxWidthPx)) + pad * 2;
      const h = (it.kind === "domain" ? S * 1.4 + S * 1.05 : mapLabelHeightPx(mapLabelLines(singleW))) + pad * 2;
      const B = { x: p.sx - (it.kind === "domain" ? w / 2 : 0), y: p.sy - h / 2, w, h };
      if (collide(B)) continue; placed.push(B); keep.add(it.lid);
      let el = lblEls.get(it.lid);
      if (!el) {
        el = document.createElement("div"); el.className = "albl"; el.style.opacity = "0";
        el.dataset.x = String(it.x); el.dataset.y = String(it.y); el.dataset.z = String(it.z); el.dataset.kind = it.kind;
        if (it.kind === "domain") {
          el.innerHTML = `<div style="text-align:center"><svg width="${(S_DOM * 0.95).toFixed(0)}" height="${(S_DOM * 0.95).toFixed(0)}" viewBox="0 0 24 24" style="display:block;margin:0 auto;opacity:.7"><path d="M12 1.5 L13.7 10.3 L22.5 12 L13.7 13.7 L12 22.5 L10.3 13.7 L1.5 12 L10.3 10.3 Z" fill="${it.c}"/></svg><div style="font-size:${S_DOM}px;font-weight:800;letter-spacing:.09em;color:${it.c};text-transform:uppercase;text-shadow:0 1px 5px #0a0718">${esc(it.label)}</div></div>`;
        } else {
          el.innerHTML = `<div style="${mapLabelBoxCss()};color:${it.c};font-weight:600;text-shadow:0 1px 3px #0a0718">${esc(it.label)}</div>`;
        }
        labelsEl.appendChild(el); lblEls.set(it.lid, el);
        const fadeTo = it.op; requestAnimationFrame(() => { el!.style.opacity = String(fadeTo); });
      } else {
        el.dataset.x = String(it.x); el.dataset.y = String(it.y); el.style.opacity = String(it.op);
      }
    }
    for (const [lid, el] of lblEls) { if (!keep.has(lid)) { el.style.opacity = "0"; lblEls.delete(lid); setTimeout(() => el.remove(), 450); } }
    liveLabels = []; for (const [, el] of lblEls) liveLabels.push({ el, x: +el.dataset.x!, y: +el.dataset.y!, z: +el.dataset.z!, dom: el.dataset.kind === "domain" });
    positionLabels();
  }
  function positionLabels() {
    for (const L of liveLabels) {
      const p = projectStar(L.x, L.y, L.z);
      L.el.style.transform = `translate(${p.sx.toFixed(1)}px,${p.sy.toFixed(1)}px) ${L.dom ? "translate(-50%,-50%)" : "translate(8px,-50%)"}`;
    }
  }

  function updateBucket(force?: boolean) {
    const b = bucketOf(zoom);
    if (b === curBucket && !force) return;
    curBucket = b;
    scene.classList.remove("zl0", "zl1", "zl2", "zl3"); scene.classList.add("zl" + b);
    // Re-scale every star for this bucket (sublinear growth — see ATTEN). A
    // discrete per-bucket step, smoothed by the .astar transform transition;
    // rewriting ~900 inline transforms only on bucket change is cheap.
    const k = starScale(b).toFixed(4);
    for (const N of nodeArr) N.el.style.transform = `translate(-50%,-50%) translateZ(${N.z}px) scale(${k})`;
    if (transitioning) return;
    relayoutLabels(); renderBridges();
  }

  // ── natural framing (prominence-weighted centroid + spread) ──
  function framingWeight(n: AtlasNode) {
    const hh = heat[n.id] || 0;
    if (lens === "galaxy") {
      if (hh >= 2) return 4;
      if (hh >= 1) return 2;
      const role = LIT.get(n.id);
      if (role === "seed") return 1.2;
      if (role === "standard") return 0.6;
      return 0.12;
    }
    // Seed invitations dominate the opening camera composition — the sky's
    // brightest layer must also be what the camera centers on, so a lit
    // mastery cluster never crowds out (or out-frames) a scholar's real
    // invitations. Mastery/starter still pull the frame gently toward them
    // (weight > 0) so they're not entirely ignored when few/no seeds exist.
    if (lens === "sky") { const role = LIT.get(n.id); if (role === "seed") return 3; if (role === "standard") return 1.6; if (role === "mastery") return 1.2; if (role === "starter") return 0.9; return 0.0; }
    if (n.source === "mastery") return 3;
    if (n.source === "standard") return (n.refCount ?? 1) > 1 ? 1.6 : 1.0;
    return 0.15;
  }
  function frameToContent(animated: boolean) {
    measureVp();
    let sw = 0, sx = 0, sy = 0;
    for (const n of nodes) { const p = posAll.get(n.id); if (!p) continue; const w = framingWeight(n); sw += w; sx += w * p.x; sy += w * p.y; }
    if (!sw) { baseZoom = 1; zt = 1; panTX = panTY = 0; if (!animated) { zoom = 1; panX = panY = 0; } camAnim = animated; return; }
    const mx = sx / sw, my = sy / sw;
    let vx = 0, vy = 0; for (const n of nodes) { const p = posAll.get(n.id); if (!p) continue; const w = framingWeight(n); vx += w * (p.x - mx) ** 2; vy += w * (p.y - my) ** 2; }
    const sdx = Math.sqrt(vx / sw), sdy = Math.sqrt(vy / sw);
    const K = lens === "sky" ? 2.3 : 1.9;
    const rxe = Math.max(7, K * sdx), rye = Math.max(7, K * sdy);
    baseZoom = clamp(Math.min(50 / rxe, 50 / rye), 1.0, 2.4);
    zt = baseZoom; zoomAnchored = false;
    panTX = -(mx / 100 * vpW - vpW / 2) * baseZoom;
    panTY = -(my / 100 * vpH - vpH / 2) * baseZoom;
    if (animated) camAnim = true;
    else { zoom = baseZoom; panX = panTX; panY = panTY; camAnim = false; }
  }

  // ── rAF loop ──
  let raf = 0, lastFrameZoom = zoom;
  function frame(now: number) {
    const t = now / 1000, iy = Math.sin(t / 7) * 1.6, ix = Math.cos(t / 9) * 1.0;
    px += (ptx - px) * 0.06; py += (pty - py) * 0.06;
    const op = Math.min(1, (now - openAt) / 1200);
    const prevZoom = zoom;
    if (camAnim) {
      zoom += (zt - zoom) * 0.10; panX += (panTX - panX) * 0.12; panY += (panTY - panY) * 0.12;
      rx = ix + py; ry = iy + px;
      if (Math.abs(zoom - zt) < 0.004 && Math.abs(panX - panTX) < 0.8 && Math.abs(panY - panTY) < 0.8) {
        zoom = zt; panX = panTX; panY = panTY; camAnim = false; transitioning = false;
        curBucket = -1; updateBucket(true);
        labelsEl.style.opacity = "1"; bridgesEl.style.opacity = "1"; cull(true);
      }
    } else {
      zoom += (zt - zoom) * 0.18; rx = ix + py; ry = iy + px;
      if (Math.abs(zoom - prevZoom) > 1e-5) {
        const r = zoom / prevZoom, ax = (zoomAnchored ? zoomCX : vpW / 2), ay = (zoomAnchored ? zoomCY : vpH / 2);
        panX = (ax - vpW / 2) * (1 - r) + r * panX; panY = (ay - vpH / 2) * (1 - r) + r * panY;
      }
    }
    scene.style.transform = `translate(${panX}px,${panY}px) scale(${(zoom * (0.97 + 0.03 * op)).toFixed(3)}) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    if (Math.abs(zoom - lastFrameZoom) > 0.0005) lastFrameZoom = zoom;
    updateBucket(false); updateProjection(op); positionLabels(); positionBridges(); cull(false);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // ── interaction ──
  // NOTE: native hit-testing (the browser routing pointer events to the right
  // .astar) is UNRELIABLE here — the stars live in a `preserve-3d` + perspective
  // subtree with per-element translateZ, and Chrome frequently hit-tests the
  // parent scene plane instead of the star. So we pick in SCREEN SPACE ourselves,
  // using the same projectStar() that places the labels/bridges → the hit region
  // matches exactly what the user sees, everywhere on the map.
  let dragging = false, lastX = 0, lastY = 0, panDirty = false, downX = 0, downY = 0;
  let hovEl: HTMLDivElement | null = null;
  const HITR = 11; // base screen-px hit radius (forgiving)
  function pickAt(mx: number, my: number): RObj | null {
    let best: RObj | null = null, bestD = Infinity;
    for (const N of nodeArr) {
      if (N.culled) continue;
      if (N.inert) continue; // sky lens: non-seed stars are non-interactive
      if (!(N.tier === 0 || tierVisibleNow(N.tier))) continue; // only what's actually visible now
      const p = projectStar(N.x, N.y, N.z);
      const dx = p.sx - mx, dy = p.sy - my, d = dx * dx + dy * dy;
      const lim = Math.max(HITR, N.r * zoom * ATTEN[Math.max(0, Math.min(3, curBucket))] * 0.85); // larger stars get a larger target
      if (d <= lim * lim && d < bestD) { bestD = d; best = N; }
    }
    return best;
  }
  function setHover(N: RObj | null, clientX: number, clientY: number) {
    const r = vp.getBoundingClientRect();
    if (N) {
      vp.style.cursor = dragging ? "grabbing" : "pointer";
      if (hovEl !== N.el) { if (hovEl) hovEl.classList.remove("hov"); hovEl = N.el; hovEl.classList.add("hov"); }
      tip.innerHTML = `<b>${esc(N.node.label)}</b><br><span style="opacity:.6">${esc(N.node.domain ?? "")} · ${esc(N.meta)}</span>`;
      tip.style.opacity = "1"; tip.style.left = `${clientX - r.left + 14}px`; tip.style.top = `${clientY - r.top + 14}px`;
      if (hoverId !== N.cid) { hoverId = N.cid; renderBridges(); }
    } else {
      vp.style.cursor = dragging ? "grabbing" : "grab";
      if (hovEl) { hovEl.classList.remove("hov"); hovEl = null; }
      tip.style.opacity = "0";
      if (hoverId) { hoverId = null; renderBridges(); }
    }
  }
  const onDown = (e: PointerEvent) => { dragging = true; camAnim = false; lastX = e.clientX; lastY = e.clientY; downX = e.clientX; downY = e.clientY; setHover(null, e.clientX, e.clientY); vp.style.cursor = "grabbing"; };
  const onUp = (e: PointerEvent) => { if (dragging) { dragging = false; if (panDirty) { panDirty = false; relayoutLabels(); cull(true); } const r = vp.getBoundingClientRect(); setHover(pickAt(e.clientX - r.left, e.clientY - r.top), e.clientX, e.clientY); } };
  const onWinMove = (e: PointerEvent) => { if (dragging) { panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; panDirty = true; } };
  const onVpMove = (e: PointerEvent) => {
    const r = vp.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    ptx = (mx / r.width - 0.5) * 8; pty = -(my / r.height - 0.5) * 6;
    if (!dragging) setHover(pickAt(mx, my), e.clientX, e.clientY);
  };
  const onLeave = () => setHover(null, 0, 0);
  const onClick = (e: MouseEvent) => {
    if (!opts.onNodeClick) return;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) return; // it was a pan-drag, not a click
    const r = vp.getBoundingClientRect();
    const N = pickAt(e.clientX - r.left, e.clientY - r.top);
    if (N) opts.onNodeClick(N.cid);
  };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); camAnim = false; const r = vp.getBoundingClientRect(); zoomCX = e.clientX - r.left; zoomCY = e.clientY - r.top; zoomAnchored = true; zt = clamp(zt * Math.exp(-e.deltaY * 0.0016 * (e.ctrlKey ? 6 : 1)), baseZoom * 0.6, baseZoom * 4); };
  const onResize = () => { measureVp(); positionLabels(); };
  vp.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointermove", onWinMove);
  vp.addEventListener("pointermove", onVpMove);
  vp.addEventListener("pointerleave", onLeave);
  vp.addEventListener("click", onClick);
  vp.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", onResize);

  // ── public API ──
  function ingest(next: AtlasLens, data: LensData) {
    lens = next;
    nodes = data.nodes ?? [];
    heat = data.heat ?? {};
    edges = data.edges ?? [];
    LIT.clear();
    INTERACTIVE_SEEDS.clear();
    if (next === "sky") {
      for (const id of Object.keys(data.lit ?? {})) LIT.set(id, "mastery");
      for (const id of data.standardLit ?? []) if (!LIT.has(id)) LIT.set(id, "standard");
      for (const id of data.seeds ?? []) if (!LIT.has(id)) LIT.set(id, "seed");
      for (const id of data.starter ?? []) if (!LIT.has(id)) LIT.set(id, "starter");
      for (const id of data.interactiveSeeds ?? data.seeds ?? []) {
        INTERACTIVE_SEEDS.add(id);
      }
      THREADS = data.threads ?? [];
      latticeEdges = data.prereqEdges ?? [];
    } else if (next === "galaxy") {
      // Reuse the LIT map for the galaxy's non-mastery roles (mastery is `heat`):
      // seed = a cohort invitation (gold ring), reached = a standard ≥1 kid reached.
      for (const id of data.reached ?? []) LIT.set(id, "standard");
      for (const id of data.seeds ?? []) LIT.set(id, "seed");
      THREADS = data.threads ?? [];
      latticeEdges = [];
    } else { THREADS = []; latticeEdges = []; }
  }

  let started = false;
  return {
    setData(next: AtlasLens, data: LensData, o: { animate?: boolean } = {}) {
      const animate = o.animate ?? started;
      ingest(next, data);
      buildScene();
      if (animate) { transitioning = true; labelsEl.style.opacity = "0"; bridgesEl.style.opacity = "0"; frameToContent(true); cull(true); }
      else { frameToContent(false); updateBucket(true); cull(true); labelsEl.style.opacity = "1"; bridgesEl.style.opacity = "1"; openAt = performance.now(); }
      started = true;
    },
    setDeclump(k: number) { declumpK = clamp(k, 0, 1); buildScene(); frameToContent(false); updateBucket(true); cull(true); },
    reframe() { frameToContent(true); openAt = performance.now(); },
    destroy() {
      cancelAnimationFrame(raf);
      vp.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onWinMove);
      vp.removeEventListener("pointermove", onVpMove);
      vp.removeEventListener("pointerleave", onLeave);
      vp.removeEventListener("click", onClick);
      vp.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      scene.remove(); bridgesEl.remove(); labelsEl.remove(); tip.remove();
      vp.style.cursor = ""; vp.classList.remove("atlasEng");
    },
  };
}
