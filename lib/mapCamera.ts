/**
 * mapCamera — the shared 2.5D camera core for the Map's two skins.
 *
 * This is the "generalize atlasEngine into a shared core" step from
 * review/practice/practice-engine-roadmap.html §4: the pan / pinch-zoom /
 * zoom-to-cursor / constrained-tilt / parallax-projection primitives the Sky's
 * `lib/atlasEngine.ts` proved out, lifted into ONE framework-agnostic module so
 * the two skins don't re-solve them:
 *
 *   • open-map skin (Sky)   — omnidirectional, free idle sway (its own engine
 *     still owns star/label/bridge rendering; it re-uses `projectPoint` here so
 *     the projection is single-sourced across both skins).
 *   • tech-tree skin (Map)  — X frozen to DAG depth (left→right), a CONSTRAINED
 *     ±TILT_MAX_TREE tilt so the X-reading never breaks, translateZ parallax
 *     lanes, arrowed prereq edges. Uses the full `createMapCamera` controller.
 *
 * The controller is deliberately render-agnostic: give it a viewport + a scene
 * element, and it writes the CSS-3D transform each frame and hands back a
 * screen-space `project()` (identical to the one it applies) so a consumer can
 * glue SVG overlays / do its own hit-testing exactly where the user sees nodes.
 *
 * iPad rules baked in (roadmap §4): pan + pinch-zoom always; TILT is a
 * deliberate toggle, never a two-finger spin; `prefers-reduced-motion` and the
 * flat default collapse to a pure 2D plane.
 */

// perspective depth — MUST match the CSS `perspective` on the viewport element.
export const PERSPECTIVE = 1200;

// Tilt ceilings (degrees). The tree stays near-flat and clamped so left→right
// reading is never lost; the sky may sway a touch more freely.
export const TILT_MAX_TREE = 15;
export const TILT_MAX_SKY = 12;

export const clamp = (v: number, a: number, b: number): number =>
  Math.max(a, Math.min(b, v));

// ── Pure screen projection ───────────────────────────────────────────────────
// Mirrors the CSS-3D transform the camera applies to the scene, so overlays
// (SVG edges, labels) and hit-testing land exactly on the rendered nodes. Kept
// side-effect-free and shared verbatim by BOTH skins (the Sky's atlasEngine
// calls this too — one projection, two skins).

export type ProjectionState = {
  cRx: number; // cos(rotateX)
  sRx: number; // sin(rotateX)
  cRy: number; // cos(rotateY)
  sRy: number; // sin(rotateY)
  sc: number; // effective scale (zoom, incl. the open-fade nudge)
  vsy: number; // extra vertical scale (row-height cap; 1 = none)
  ox: number; // viewport centre x (px)
  oy: number; // viewport centre y (px)
  panX: number;
  panY: number;
  perspective: number;
};

export function projectPoint(
  s: ProjectionState,
  xPct: number,
  yPct: number,
  z: number,
  vpW: number,
  vpH: number,
): { sx: number; sy: number } {
  const cx0 = (xPct / 100) * vpW - s.ox;
  const cy0 = (yPct / 100) * vpH - s.oy;
  const cz0 = z;
  const x1 = cx0 * s.cRy + cz0 * s.sRy;
  const z1 = -cx0 * s.sRy + cz0 * s.cRy;
  const y1 = cy0 * s.vsy; // vertical-cap scale (around the viewport centre)
  const y2 = y1 * s.cRx - z1 * s.sRx;
  const z2 = y1 * s.sRx + z1 * s.cRx;
  const x2 = x1;
  const X = x2 * s.sc + s.ox + s.panX;
  const Y = y2 * s.sc + s.oy + s.panY;
  const Z = z2;
  const m = s.perspective / (s.perspective - Z);
  return { sx: s.ox + (X - s.ox) * m, sy: s.oy + (Y - s.oy) * m };
}

// ── pointer → element-local coordinates (CSS-zoom / transform agnostic) ────────
// A pointer event's clientX/clientY and getBoundingClientRect() are in ON-SCREEN
// pixels, but the camera projects / inverse-projects in the element's LAYOUT-pixel
// space (offsetWidth space, the same space as vp.clientWidth). Under an ancestor
// CSS `zoom` (the native iPad Tree wraps the embedded Map in `zoom: 1.5`) — or any
// CSS transform on an ancestor — those two spaces differ by the zoom factor, so
// `clientX - rect.left` alone lands the pick a factor of `zoom` off (down-and-right
// under zoom:1.5). Panning is immune because it only uses deltas.
//
// Normalizing the on-screen offset by (layout size / rendered size) maps it back
// into the camera's layout-px space regardless of any ancestor zoom/transform:
//   • desktop (no zoom): rect.width === offsetWidth → ratio 1 → identical behaviour.
//   • under zoom:1.5:     ratio is 1/1.5 → taps land under the finger.
// `el` MUST be the SAME element the camera reads its rect / dims from (the
// viewport `vp`). Guards a zero rect (fall back to ratio 1) so a detached /
// display:none element can't divide by zero.
function localPoint(
  clientX: number,
  clientY: number,
  el: HTMLElement,
): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const sx = rect.width > 0 ? el.offsetWidth / rect.width : 1;
  const sy = rect.height > 0 ? el.offsetHeight / rect.height : 1;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

// ── The controller ───────────────────────────────────────────────────────────

export type MapSkin = "sky" | "tree";

export type FrameInfo = {
  zoom: number;
  baseZoom: number;
  /** Quantized LOD bucket 0..3 relative to the fitted baseZoom. */
  bucket: number;
  /** Whether the camera is currently tilted (2.5D) vs. flat (2D). */
  tilted: boolean;
  /** Extra vertical scale currently applied (row-height cap; 1 = none). A
   *  consumer counter-scales its node glyphs by 1/vScaleY to keep them round. */
  vScaleY: number;
};

export type ContentBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type MapCameraOptions = {
  skin: MapSkin;
  /** The element whose CSS-3D transform the camera writes each frame. */
  scene: HTMLElement;
  /**
   * Called every animation frame AFTER the scene transform is written, with a
   * fresh screen-space projector + camera info. Consumers use it to reposition
   * SVG overlays and drive LOD.
   */
  onFrame?: (
    project: (xPct: number, yPct: number, z: number) => { sx: number; sy: number },
    info: FrameInfo,
  ) => void;
  /**
   * A genuine tap (pointer down+up with negligible movement) at viewport-local
   * coords — the consumer does its own hit-testing (via `project`) to select a
   * node, or treats a miss as a background deselect.
   */
  onTap?: (localX: number, localY: number) => void;
  /**
   * Pointer moved over the (idle, not-dragging) viewport at viewport-local
   * coords — the consumer hit-tests (via `project`) to drive hover affordances
   * (cursor, label reveal). Not fired while dragging/panning. MOUSE-ONLY: a
   * touch/pen never fires this (touch has no hover and no pointer-leave, so it
   * would leave a stale hover that outranks the open/selected node).
   */
  onHover?: (localX: number, localY: number) => void;
  /** Pointer left the viewport — clear any hover affordance. */
  onHoverLeave?: () => void;
  perspective?: number;
  /** Deepest zoom, as a multiple of the fitted baseZoom (default 4). */
  maxZoomFactor?: number;
};

export function createMapCamera(vp: HTMLElement, opts: MapCameraOptions) {
  const PD = opts.perspective ?? PERSPECTIVE;
  const maxZoomFactor = opts.maxZoomFactor ?? 4;
  const tree = opts.skin === "tree";
  const tiltMax = tree ? TILT_MAX_TREE : TILT_MAX_SKY;
  const scene = opts.scene;

  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  vp.style.perspective = `${PD}px`;
  scene.style.transformStyle = "preserve-3d";
  scene.style.willChange = "transform";

  // ── camera state ──
  let panX = 0, panY = 0, zoom = 1, zt = 1, baseZoom = 1;
  let rx = 0, ry = 0; // applied tilt
  let ptx = 0, pty = 0, px = 0, py = 0; // pointer-parallax target / eased
  let zoomCX = 0, zoomCY = 0, zoomAnchored = false;
  // How fast interactive zoom eases toward its target per frame. Finger-pinch
  // (touch/iPad) keeps a soft glide; the mouse wheel / trackpad-pinch (web) snaps
  // to 1:1 with the input so it feels direct, not floaty. Set by whichever input
  // last drove the zoom (onWheel vs. the pinch handler).
  const ZOOM_EASE_TOUCH = 0.18;
  let zoomEase = 1; // web-first default (instant); pinch lowers it for the glide
  // Optional row-height cap: once a yPct-delta of `refSpanYPct` would render taller
  // than `maxPx`, an extra vertical scale (vsy ≤ 1) freezes it there — the vertical
  // analogue of the node-size cap. Off (vsy = 1) unless a consumer sets it.
  let verticalCap: { maxPx: number; refSpanYPct: number } | null = null;
  let vsy = 1;
  // Tilt is OFF by default (a flat 2D plane); a deliberate toggle turns it on.
  // prefers-reduced-motion forces it off and keeps it off.
  let tiltOn = false;

  let vpW = vp.clientWidth || 1040;
  let vpH = vp.clientHeight || 620;
  const measure = () => {
    vpW = vp.clientWidth || 1040;
    vpH = vp.clientHeight || 620;
  };
  measure();

  // ── projection snapshot (rebuilt each frame) ──
  let proj: ProjectionState = {
    cRx: 1, sRx: 0, cRy: 1, sRy: 0, sc: 1, vsy: 1, ox: vpW / 2, oy: vpH / 2,
    panX: 0, panY: 0, perspective: PD,
  };
  function refreshProjection() {
    const rxr = (rx * Math.PI) / 180, ryr = (ry * Math.PI) / 180;
    proj = {
      cRx: Math.cos(rxr), sRx: Math.sin(rxr),
      cRy: Math.cos(ryr), sRy: Math.sin(ryr),
      sc: zoom, vsy, ox: vpW / 2, oy: vpH / 2, panX, panY, perspective: PD,
    };
  }
  const project = (xPct: number, yPct: number, z: number) =>
    projectPoint(proj, xPct, yPct, z, vpW, vpH);

  // ── LOD bucket (relative to the fitted baseZoom) ──
  const bucketOf = (z: number): number => {
    const r = z / baseZoom;
    if (r < 1.3) return 0;
    if (r < 1.9) return 1;
    if (r < 2.8) return 2;
    return 3;
  };

  // ── fit to content ──
  function fit(box: ContentBox, animate = false) {
    measure();
    const mx = (box.minX + box.maxX) / 2;
    const my = (box.minY + box.maxY) / 2;
    const spanX = Math.max(8, box.maxX - box.minX);
    const spanY = Math.max(8, box.maxY - box.minY);
    // leave a comfortable margin (content occupies ~80% of the viewport). The
    // tree skin may zoom OUT further than the sky (a wide left→right graph needs
    // to fit); a "focus" fit of a small frontier box can still zoom in to 2.4×.
    baseZoom = clamp(Math.min(80 / spanX, 80 / spanY), tree ? 0.35 : 0.6, 2.4);
    zt = baseZoom;
    zoomAnchored = false;
    const tpx = -((mx / 100) * vpW - vpW / 2) * baseZoom;
    const tpy = -((my / 100) * vpH - vpH / 2) * baseZoom;
    if (animate) {
      // eased in the rAF loop toward zt / (panTX,panTY)
      panTX = tpx; panTY = tpy; camAnim = true;
    } else {
      zoom = baseZoom; panX = tpx; panY = tpy; panTX = tpx; panTY = tpy; camAnim = false;
    }
  }
  let panTX = 0, panTY = 0, camAnim = false;

  // ── the rAF loop ──
  let raf = 0;
  function frame(now: number) {
    const t = now / 1000;
    // idle sway — only when tilted; the tree stays perfectly flat when off.
    const idleY = tiltOn ? Math.sin(t / 7) * (tree ? 1.1 : 1.6) : 0;
    const idleX = tiltOn ? Math.cos(t / 9) * (tree ? 0.7 : 1.0) : 0;
    px += (ptx - px) * 0.06;
    py += (pty - py) * 0.06;

    if (camAnim) {
      zoom += (zt - zoom) * 0.12;
      panX += (panTX - panX) * 0.14;
      panY += (panTY - panY) * 0.14;
      if (
        Math.abs(zoom - zt) < 0.004 &&
        Math.abs(panX - panTX) < 0.6 &&
        Math.abs(panY - panTY) < 0.6
      ) {
        zoom = zt; panX = panTX; panY = panTY; camAnim = false;
      }
    } else {
      const prevZoom = zoom;
      zoom += (zt - zoom) * zoomEase;
      if (Math.abs(zoom - prevZoom) > 1e-5) {
        const r = zoom / prevZoom;
        const ax = zoomAnchored ? zoomCX : vpW / 2;
        const ay = zoomAnchored ? zoomCY : vpH / 2;
        panX = (ax - vpW / 2) * (1 - r) + r * panX;
        panY = (ay - vpH / 2) * (1 - r) + r * panY;
      }
    }

    if (tiltOn) {
      rx = clamp(idleX + py, -tiltMax, tiltMax);
      ry = clamp(idleY + px, -tiltMax, tiltMax);
    } else {
      rx = 0; ry = 0;
    }

    // Row-height cap → extra vertical scale (freezes strand spacing past a zoom).
    vsy = 1;
    if (verticalCap && verticalCap.refSpanYPct > 0) {
      const natural = (verticalCap.refSpanYPct / 100) * vpH * zoom;
      if (natural > verticalCap.maxPx) vsy = verticalCap.maxPx / natural;
    }

    scene.style.transform =
      `translate(${panX.toFixed(2)}px,${panY.toFixed(2)}px) scale(${zoom.toFixed(4)})` +
      ` rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scaleY(${vsy.toFixed(4)})`;

    refreshProjection();
    opts.onFrame?.(project, {
      zoom, baseZoom, bucket: bucketOf(zoom), tilted: tiltOn, vScaleY: vsy,
    });
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // ── interaction: drag-pan ──
  let dragging = false, lastX = 0, lastY = 0, moved = 0;
  const onDown = (e: PointerEvent) => {
    if (e.button != null && e.button !== 0) return;
    // A touch/pen interaction must never leave a stale hover behind: hover is
    // mouse-only (see onVpMove), so any non-mouse press clears it so the
    // highlight falls back to the open/selected node.
    if (e.pointerType !== "mouse") opts.onHoverLeave?.();
    dragging = true; camAnim = false;
    lastX = e.clientX; lastY = e.clientY;
    moved = 0;
    vp.style.cursor = "grabbing";
  };
  const onWinMove = (e: PointerEvent) => {
    if (!dragging) return;
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    vp.style.cursor = "grab";
    // A tap = down+up with negligible travel → let the consumer hit-test.
    // Normalize to the camera's layout-px space so the pick lands under the
    // finger even under an ancestor CSS zoom (see `localPoint`).
    if (moved <= 6 && opts.onTap) {
      const p = localPoint(e.clientX, e.clientY, vp);
      opts.onTap(p.x, p.y);
    }
  };
  // pointer-parallax: track the cursor for the subtle tilt lean (tilt-on only),
  // and drive hover affordances (cursor / label reveal) when not dragging.
  const onVpMove = (e: PointerEvent) => {
    // Layout-px local coords (zoom-agnostic; see `localPoint`). The parallax
    // fraction below is `p / layoutSize`, which is identical to the old
    // `(clientX - rect.left) / rect.width` on desktop (both dimensionless) but
    // stays correct under an ancestor CSS zoom.
    const p = localPoint(e.clientX, e.clientY, vp);
    const w = vp.offsetWidth || 1, h = vp.offsetHeight || 1;
    ptx = ((p.x / w) - 0.5) * 8;
    pty = -((p.y / h) - 0.5) * 6;
    // Hover is a MOUSE-ONLY affordance. A touch/pen sets `dragging=false` on a
    // pinch/tap, which would otherwise let this hover path run — but touch has
    // no pointer-leave, so the hover would stick and (via `hoveredKey ??
    // selectedKey`) override the tapped/open node. Gating on pointerType keeps
    // hover null on touch so the arrows follow the selected node.
    if (!dragging && opts.onHover && e.pointerType === "mouse")
      opts.onHover(p.x, p.y);
  };
  const onVpLeave = () => { opts.onHoverLeave?.(); };
  const onWheel = (e: WheelEvent) => {
    // Only hijack the wheel for a deliberate ZOOM gesture (trackpad pinch =
    // ctrl+wheel, or ctrl/⌘-held mouse wheel). A plain wheel / two-finger
    // scroll must pass through so the PAGE can scroll — the map is an inline
    // 600px panel, not a full-viewport surface, so eating scroll traps the
    // reader. (Pan is still available by dragging; zoom via pinch or ctrl.)
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    camAnim = false;
    zoomEase = 1; // wheel / trackpad-pinch: snap 1:1 with the input (no glide)
    // Anchor zoom-to-cursor in the camera's layout-px space (zoom-agnostic).
    const p = localPoint(e.clientX, e.clientY, vp);
    zoomCX = p.x; zoomCY = p.y; zoomAnchored = true;
    const factor = Math.exp(-e.deltaY * 0.0016 * 6);
    zt = clamp(zt * factor, baseZoom * 0.6, baseZoom * maxZoomFactor);
  };

  // ── interaction: two-finger PINCH-zoom (never a spin — roadmap §4) ──
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const onTouchDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      dragging = false;
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      // Anchor the pinch on the gesture midpoint, in the camera's layout-px
      // space (zoom-agnostic — matters on the iPad Tree's zoom:1.5 wrapper).
      const mid = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2, vp);
      zoomCX = mid.x; zoomCY = mid.y;
      zoomAnchored = true;
    }
  };
  const onTouchMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        camAnim = false;
        zoomEase = ZOOM_EASE_TOUCH; // finger pinch keeps the soft glide
        zt = clamp(zt * (d / pinchDist), baseZoom * 0.6, baseZoom * maxZoomFactor);
      }
      pinchDist = d;
    }
  };
  const onTouchUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
  };

  const onResize = () => { measure(); };
  // A panel drag-resize changes the viewport size WITHOUT firing window.resize,
  // which left the screen-space edge overlay projecting against stale vp dims
  // (nodes reflow via CSS %, but the arrows went stale). Observe the vp directly.
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;

  vp.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onWinMove);
  window.addEventListener("pointerup", onUp);
  vp.addEventListener("pointermove", onVpMove);
  vp.addEventListener("pointerleave", onVpLeave);
  vp.addEventListener("wheel", onWheel, { passive: false });
  vp.addEventListener("pointerdown", onTouchDown);
  vp.addEventListener("pointermove", onTouchMove);
  window.addEventListener("pointerup", onTouchUp);
  window.addEventListener("pointercancel", onTouchUp);
  window.addEventListener("resize", onResize);
  ro?.observe(vp);
  vp.style.cursor = "grab";
  vp.style.touchAction = "none";

  return {
    project,
    fit,
    /** Toggle the 2.5D tilt on/off (the "Flatten / Tilt" control). No-op under
     *  prefers-reduced-motion (stays flat). Returns the resulting state. */
    setTilt(on: boolean): boolean {
      tiltOn = reducedMotion ? false : on;
      return tiltOn;
    },
    isTilted: () => tiltOn,
    canTilt: () => !reducedMotion,
    /** Cap the on-screen height of a strand row: pass the yPct-delta between
     *  adjacent lanes as `refSpanYPct`; once that would render taller than `maxPx`
     *  an extra vertical scale freezes it. `null` disables the cap. */
    setVerticalCap(cap: { maxPx: number; refSpanYPct: number } | null) {
      verticalCap = cap;
    },
    getInfo: (): FrameInfo => ({
      zoom, baseZoom, bucket: bucketOf(zoom), tilted: tiltOn, vScaleY: vsy,
    }),
    measure,
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      vp.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onWinMove);
      window.removeEventListener("pointerup", onUp);
      vp.removeEventListener("pointermove", onVpMove);
      vp.removeEventListener("pointerleave", onVpLeave);
      vp.removeEventListener("wheel", onWheel);
      vp.removeEventListener("pointerdown", onTouchDown);
      vp.removeEventListener("pointermove", onTouchMove);
      window.removeEventListener("pointerup", onTouchUp);
      window.removeEventListener("pointercancel", onTouchUp);
      window.removeEventListener("resize", onResize);
      vp.style.cursor = "";
      vp.style.touchAction = "";
    },
  };
}

export type MapCamera = ReturnType<typeof createMapCamera>;
