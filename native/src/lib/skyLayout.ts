// Pure layout helpers for the native star map. Seed-only radial layout remains
// for small cards/tests; the full Sky uses the shared atlas x/y coordinates plus
// shared display-tier rules from shared/skyTiers (vendored for Metro).

import {
  classifySkyNode,
  domainColor,
  layoutAtlasPoint,
  SKY_COLD_START_MIN_STARS,
  type SkyDisplayTier,
  type SkyRole,
} from "../../vendor/shared/skyTiers";

export type SkyStar = {
  _id: string;
  conceptId?: string;
  seedId?: string;
  topic: string;
  domain: string;
  blurb: string;
  connectionTo?: string | null;
  suggestionType?: string;
  reach?: number | null;
  pinned?: boolean;
  visited?: boolean;
  completed?: boolean;
  completedAt?: number | null;
  visitCount?: number;
  lastVisitedAt?: number | null;
  structured?: boolean;
  source?: string;
  refCount?: number;
  hopTier?: number;
  role?: Exclude<SkyRole, undefined> | "territory";
  displayTier?: SkyDisplayTier;
  color?: string;
  visualRadius?: number;
  glow?: number;
  ring?: boolean;
  meta?: string;
  skyX?: number;
  skyY?: number;
  // Cross-domain on-ramp target drill stamped on the seed (or null). Drives the
  // StarDrawer's optional "practice this" invitation — see lib/practiceDomain.ts.
  practiceDomain?: string | null;
  /** True for a real seed OR a night-museum float (mastery/starter) — anything
   *  the server attached `seedMeta` to, i.e. has a StarDrawer body to show.
   *  Mirrors web ConceptAtlasView's `Object.keys(seedMeta)` interactivity gate
   *  exactly, so both surfaces make the SAME stars tappable in the Sky lens.
   *  Plain standard/territory dots (no meta) stay inert. */
  interactive?: boolean;
};

export type PositionedStar = SkyStar & {
  x: number;
  y: number;
  /** 0..1 reach-derived depth, kept for layout diagnostics/future layers. */
  depth: number;
  conceptId: string;
  role: Exclude<SkyRole, undefined> | "territory";
  displayTier: SkyDisplayTier;
  color: string;
  visualRadius: number;
  glow: number;
  ring: boolean;
  meta: string;
  interactive: boolean;
};

/** Stable hash of a string → [0, 1). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export type Layout = {
  width: number;
  height: number;
  stars: PositionedStar[];
  cx: number;
  cy: number;
  latticeEdges: PositionedEdge[];
  threads: PositionedEdge[];
  showHub: boolean;
  // The camera the map should OPEN on: centered on the center-of-gravity of the
  // seeds (the scholar's live invitations), zoomed in enough that the seed
  // neighborhood — not the whole atlas — fills the viewport. Applied to
  // tx/ty/scale on first load, on a Sky/Tree switch, and by the Reset button.
  initialCamera: Camera;
};

export type Camera = { tx: number; ty: number; scale: number };

export type PositionedEdge = {
  s: string;
  t: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type SkyFieldSeedMeta = {
  // "seed" = a real teacher/AI-suggested invitation (launches "Begin Quest").
  // "mastery"/"starter" are the night-museum's display-only layers (see
  // convex/lib/skyMuseum.ts) — no seedId, no CTA.
  kind?: "seed" | "mastery" | "starter";
  seedId?: string;
  blurb: string;
  pinned: boolean;
  structured: boolean;
  visited: boolean;
  visitCount: number;
  completed: boolean;
  suggestionType: string;
  practiceDomain?: string | null;
  strand?: string | null;
};

export type SkyFieldPayload = {
  nodes: {
    id: string;
    label: string;
    domain: string;
    source: string;
    x: number;
    y: number;
    refCount: number;
    hopTier: number;
  }[];
  lit?: Record<string, number>;
  standardLit?: string[];
  seeds?: string[];
  /** Cold-start "someday" ids (see convex/lib/skyMuseum.ts) — a faint, muted,
   *  tappable-with-no-CTA layer blended in only while the scholar's real sky
   *  is nearly empty. */
  starter?: string[];
  threads?: [string, string][];
  prereqEdges?: { s: string; t: string }[];
  seedMeta?: Record<string, SkyFieldSeedMeta>;
};

function resolvedDisplay(star: SkyStar): Pick<
  PositionedStar,
  "conceptId" | "role" | "displayTier" | "color" | "visualRadius" | "glow" | "ring" | "meta" | "interactive"
> {
  const lit = !!(star.visited || star.completed);
  const role = star.role ?? "seed";
  const displayTier = star.displayTier ?? (star.pinned ? 0 : lit ? 1 : 2);
  const color = star.color ?? (role === "seed" ? "#e7c25c" : domainColor(star.domain));
  return {
    conceptId: star.conceptId ?? star._id,
    role,
    displayTier,
    color,
    visualRadius: star.visualRadius ?? (displayTier === 0 ? 2.5 : lit ? 2.4 : 2.0),
    glow: star.glow ?? (displayTier <= 1 ? 1.2 : 0),
    ring: star.ring ?? false,
    meta: star.meta ?? (role === "seed" ? "an invitation to explore" : "in the wider field"),
    // This layout is the seed-only radial layout (small cards/tests) — every
    // star it's given IS a seed, so it's always interactive.
    interactive: star.interactive ?? true,
  };
}

export function layoutSky(
  stars: SkyStar[],
  width: number,
  height: number,
): Layout {
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(width, height) * 0.46;

  // Group by domain, stable domain order.
  const domains = Array.from(new Set(stars.map((s) => s.domain))).sort();
  const byDomain = new Map<string, SkyStar[]>();
  for (const d of domains) byDomain.set(d, []);
  for (const s of stars) byDomain.get(s.domain)!.push(s);

  const positioned: PositionedStar[] = [];
  domains.forEach((domain, di) => {
    const group = byDomain.get(domain)!;
    // Each domain owns a wedge of the circle.
    const baseAngle = (di / Math.max(1, domains.length)) * Math.PI * 2;
    const wedge = (Math.PI * 2) / Math.max(1, domains.length);
    group.forEach((s, i) => {
      const n = hash01(s._id);
      // Spread across most of the domain's wedge, with hash jitter.
      const within =
        group.length > 1 ? (i / (group.length - 1) - 0.5) * wedge * 0.92 : 0;
      const angle = baseAngle + within + (n - 0.5) * 0.16;
      const reach = Math.max(0, Math.min(2, s.reach ?? 1));
      // Stagger radius in bands by index so same-domain stars don't pile up at
      // one distance (prevents the overlap when a domain has many seeds).
      const band = group.length > 1 ? (i % 3) * 0.14 : 0;
      const rFrac = 0.4 + (reach / 2) * 0.42 + band + (n - 0.5) * 0.14;
      const r = maxR * Math.max(0.3, Math.min(1, rFrac));
      positioned.push({
        ...s,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        depth: 0.35 + (reach / 2) * 0.65,
        ...resolvedDisplay(s),
      });
    });
  });

  // Relaxation pass: push apart any stars closer than minDist so dots + labels
  // don't overlap when a domain has many seeds. Cheap for the live-cap sky plus
  // its completed layer. Keeps each star outside a hub keep-out radius so the
  // centre stays clear.
  const minDist = 168;
  const hubKeepOut = maxR * 0.34;
  for (let iter = 0; iter < 40; iter++) {
    for (let a = 0; a < positioned.length; a++) {
      for (let b = a + 1; b < positioned.length; b++) {
        const pa = positioned[a];
        const pb = positioned[b];
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < minDist) {
          const push = (minDist - d) / 2;
          dx /= d;
          dy /= d;
          pa.x -= dx * push;
          pa.y -= dy * push;
          pb.x += dx * push;
          pb.y += dy * push;
        }
      }
    }
    // keep stars out of the hub
    for (const p of positioned) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy) || 0.01;
      if (d < hubKeepOut) {
        p.x = cx + (dx / d) * hubKeepOut;
        p.y = cy + (dy / d) * hubKeepOut;
      }
    }
  }

  // Radial seed-only layout (small cards/tests): already hub-centered and sized
  // to show whole, so it opens at the neutral identity camera.
  return { width, height, stars: positioned, cx, cy, latticeEdges: [], threads: [], showHub: true, initialCamera: { tx: 0, ty: 0, scale: 1 } };
}


type SkyFieldNode = SkyFieldPayload["nodes"][number];
type RoleContext = {
  lit: Record<string, number>;
  standardLit: Set<string>;
  seeds: Set<string>;
  starter: Set<string>;
};

function roleContext(field: SkyFieldPayload): RoleContext {
  return {
    lit: field.lit ?? {},
    standardLit: new Set(field.standardLit ?? []),
    seeds: new Set(field.seeds ?? []),
    starter: new Set(field.starter ?? []),
  };
}

function roleForNode(ctx: RoleContext, nodeId: string): SkyRole {
  if (ctx.seeds.has(nodeId)) return "seed";
  if (ctx.lit[nodeId] !== undefined) return "mastery";
  if (ctx.standardLit.has(nodeId)) return "standard";
  if (ctx.starter.has(nodeId)) return "starter";
  return undefined;
}

function positionedFieldStar(
  field: SkyFieldPayload,
  ctx: RoleContext,
  node: SkyFieldNode,
  p: { x: number; y: number },
): PositionedStar {
  const role = roleForNode(ctx, node.id);
  const display = classifySkyNode({
    role,
    domain: node.domain,
    refCount: node.refCount,
    hopTier: node.hopTier,
  });
  const meta = field.seedMeta?.[node.id];
  return {
    _id: node.id,
    conceptId: node.id,
    seedId: meta?.seedId,
    topic: node.label,
    domain: node.domain,
    blurb: meta?.blurb ?? display.meta,
    suggestionType: meta?.suggestionType,
    practiceDomain: meta?.practiceDomain ?? null,
    pinned: meta?.pinned ?? false,
    visited: meta?.visited ?? role === "mastery",
    visitCount: meta?.visitCount ?? (role === "mastery" ? 1 : 0),
    completed: meta?.completed ?? false,
    structured: meta?.structured ?? false,
    source: node.source,
    refCount: node.refCount,
    hopTier: node.hopTier,
    role: role ?? "territory",
    displayTier: display.tier,
    color: display.c,
    visualRadius: display.r,
    glow: display.glow,
    ring: display.ring ?? false,
    meta: display.meta,
    // Anything the server attached seedMeta to (a real seed OR a night-museum
    // float) is tappable; plain standard/territory dots have no meta, no tap.
    interactive: !!meta,
    reach: display.tier === 0 ? 0 : display.tier === 1 ? 0.4 : display.tier === 2 ? 1.1 : 2,
    x: p.x,
    y: p.y,
    skyX: node.x,
    skyY: node.y,
    depth: display.tier === 0 ? 0.35 : display.tier === 1 ? 0.5 : display.tier === 2 ? 0.72 : 1,
  };
}

function fieldEdges(
  field: SkyFieldPayload,
  byId: Map<string, PositionedStar>,
): Pick<Layout, "latticeEdges" | "threads"> {
  const edgeOf = (e: { s: string; t: string }): PositionedEdge | null => {
    const a = byId.get(e.s);
    const b = byId.get(e.t);
    if (!a || !b) return null;
    return { s: e.s, t: e.t, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };
  return {
    latticeEdges: (field.prereqEdges ?? []).flatMap((e) => {
      const positioned = edgeOf(e);
      return positioned ? [positioned] : [];
    }),
    threads: (field.threads ?? []).flatMap(([s, t]) => {
      const positioned = edgeOf({ s, t });
      return positioned ? [positioned] : [];
    }),
  };
}

// The OPENING zoom range. Deliberately narrower than skyDisplay's MIN/MAX_ZOOM
// gesture bounds — the map should open focused on the seeds, not at the gesture
// extremes. A lone/tight seed cluster hits the max; widely-spread seeds the min.
const INITIAL_ZOOM_MIN = 1.15;
const INITIAL_ZOOM_MAX = 2.4;
// A slightly tighter floor for framing the night-museum layer ALONE (no seeds
// at all) — purely a readability nicety now (mastery/starter are rest-visible
// at ANY zoom — shared/skyTiers.ts classifySkyNode forces them to display
// tier 0 — so this is no longer load-bearing for visibility, just keeps a
// sparse museum-only layer from opening too zoomed-out to read comfortably).
const MUSEUM_ZOOM_MIN = 1.35;
// Fraction of the viewport the seed bounding box should fill at open (leaves a
// margin of surrounding field for context).
const SEED_FRAME_FRACTION = 0.5;

function clampNum(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// The camera the map OPENS on: the center-of-gravity of the seed stars, zoomed so
// the seed neighborhood fills ~SEED_FRAME_FRACTION of the viewport (clamped to the
// opening range). Camera convention matches sky.tsx: screen = content*scale + t,
// so t = viewportCenter − centroid*scale centers the seed CoG. Falls back to
// framing the night-museum layer (mastery + cold-start starter stars — see
// convex/lib/skyMuseum.ts) when the scholar has no seeds yet, so a brand-new
// scholar's FIRST GLANCE is already zoomed onto their lit/starter stars rather
// than a flat, unzoomed field. Only truly empty (no seeds, no museum stars
// either) falls back to a whole-field fit (scale 1, centered).
function frameOn(
  stars: PositionedStar[],
  width: number,
  height: number,
  minScale: number,
): Camera | null {
  if (stars.length === 0) return null;

  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of stars) {
    sumX += s.x;
    sumY += s.y;
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  const cx = sumX / stars.length;
  const cy = sumY / stars.length;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const fit = Math.min(
    (width * SEED_FRAME_FRACTION) / spanX,
    (height * SEED_FRAME_FRACTION) / spanY,
  );
  const scale = clampNum(fit, minScale, INITIAL_ZOOM_MAX);
  return { tx: width / 2 - cx * scale, ty: height / 2 - cy * scale, scale };
}

function seedCamera(
  stars: PositionedStar[],
  width: number,
  height: number,
): Camera {
  const seeds = stars.filter((s) => s.role === "seed");
  const museum = stars.filter((s) => s.role === "mastery" || s.role === "starter");

  // A real, sizeable seed cluster frames on its own. But with too FEW seeds
  // to read as a cluster (the same "nearly empty" bar the server uses to
  // decide whether to blend in the museum layer — SKY_COLD_START_MIN_STARS),
  // blend the mastery/starter stars into the SAME framing set, so the opening
  // camera doesn't zoom tightly onto one or two lonely invitations while a
  // richer night-museum layer sits off-frame elsewhere on the map.
  const framingStars = seeds.length >= SKY_COLD_START_MIN_STARS ? seeds : [...seeds, ...museum];
  const frame = frameOn(
    framingStars,
    width,
    height,
    seeds.length > 0 ? INITIAL_ZOOM_MIN : MUSEUM_ZOOM_MIN,
  );
  if (frame) return frame;

  return { tx: 0, ty: 0, scale: 1 };
}


function fieldBounds(width: number, height: number) {
  const padX = Math.max(44, width * 0.08);
  const padTop = Math.max(112, height * 0.12);
  const padBottom = Math.max(112, height * 0.13);
  const usableW = Math.max(1, width - padX * 2);
  const usableH = Math.max(1, height - padTop - padBottom);
  return {
    toPixels: (p: { x: number; y: number }) => ({
      x: padX + (p.x / 100) * usableW,
      y: padTop + (p.y / 100) * usableH,
    }),
  };
}

export function layoutSkyField(
  field: SkyFieldPayload,
  width: number,
  height: number,
): Layout {
  const nodes = field.nodes ?? [];
  const center = nodes.length
    ? {
        x: nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length,
        y: nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length,
      }
    : { x: 50, y: 50 };

  const { toPixels } = fieldBounds(width, height);
  const ctx = roleContext(field);
  const byId = new Map<string, PositionedStar>();
  const stars = nodes.map((node) => {
    const p = toPixels(layoutAtlasPoint({ x: node.x, y: node.y }, center));
    const star = positionedFieldStar(field, ctx, node, p);
    byId.set(node.id, star);
    return star;
  });

  return {
    width,
    height,
    stars,
    cx: width / 2,
    cy: height / 2,
    ...fieldEdges(field, byId),
    showHub: false,
    initialCamera: seedCamera(stars, width, height),
  };
}
