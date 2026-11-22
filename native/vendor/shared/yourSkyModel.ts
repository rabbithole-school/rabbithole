/**
 * The pure half of a kid's own Sky (TRA-699), for both screens: web's
 * components/sky/YourSky.tsx and the BunnyPad's
 * native/src/components/sky/YourSky.tsx, which reads the copy that
 * native/scripts/sync-vendor.js makes. It holds the look, the camera, which
 * labels show, the lines drawn between stars, and the drawer's words. No
 * React and no platform code, so it is unit-tested once
 * (shared/__tests__/yourSkyModel.test.ts).
 *
 * Units: a star's x and y come from `skyStars.forSelf` in em, the label's
 * font size (shared/skyLabelBox.ts). The camera maps them to screen pixels
 * (points on the BunnyPad): `screen = world * k + t`, so `k` is pixels per
 * em. Labels are drawn at a fixed `LABEL_FONT_PX`, and their boxes are
 * `skyLabelBox` scaled by it, so the box a label takes on screen is the box
 * the layout kept clear for it. Once `k` reaches the font size no two labels
 * can overlap (the layout keeps `SKY_LABEL.gapEm` between boxes); below it,
 * `labelsToShow` keeps only the labels that fit, a few at rest and more as
 * the kid zooms in.
 */

import {
  SKY_LABEL,
  skyBoxesOverlap,
  skyLabelBox,
  type SkyBox,
  type SkyPoint,
} from "./skyLabelBox";

// ─── Look ─────────────────────────────────────────────────────────────

/** The design's sky colors (review/quests-rebuilt-proposal.html, sk6 and
 *  figure 9). The sky stays dark in both themes, like the Sky before it.
 *  `labelDim` is the web Quests tab band's quieter text. */
export const YOUR_SKY_COLORS = {
  space: "#0d0f22",
  dust: "#4b5080",
  label: "#d9d7ef",
  labelDim: "#9a9cc4",
  wonder: "#f4f0ff",
  quest: "#f3c969",
  nearby: "#8e86c9",
  trail: "#c79cf2",
} as const;

/** A four-point star centered on (cx, cy), `r` from center to tip: a
 *  Quest's star. */
export function sparklePath(cx: number, cy: number, r: number): string {
  const w = r * 0.3;
  return [
    `M${cx} ${cy - r}`,
    `L${cx + w} ${cy - w}`,
    `L${cx + r} ${cy}`,
    `L${cx + w} ${cy + w}`,
    `L${cx} ${cy + r}`,
    `L${cx - w} ${cy + w}`,
    `L${cx - r} ${cy}`,
    `L${cx - w} ${cy - w}`,
    "Z",
  ].join(" ");
}

/** A label's font size on screen, in px. */
export const LABEL_FONT_PX = 14;
/** How many labels show with the whole sky in view. */
const LABELS_AT_REST = 8;
/** The fitted view never magnifies past this many px per em, so a sky of
 *  one or two stars doesn't open as a close-up. */
const MAX_FIT_K = LABEL_FONT_PX * 1.4;
/** Clear space kept around the stars when the view fits them, in px, unless
 *  the screen asks for its own (`fitSkyCamera`'s `padPx`). */
const FIT_PAD_PX = 28;
/** Room kept above a star moved into view over a sheet: its selection
 *  ring, in px. */
const FRAME_TOP_PAD_PX = 22;

// ─── Stars ────────────────────────────────────────────────────────────

/** What the pure helpers read of a star (`skyStars.forSelf`'s `SkyStar`). */
export type SkyStarLike = {
  id: string;
  kind: "wonder" | "quest";
  label: string;
  x: number;
  y: number;
  bright: boolean;
  trailFromStarId: string | null;
  nearby: readonly string[];
  wonder: { askedAt: number } | null;
  quest: { shownAt: number | null } | null;
};

export type SkyCamera = { k: number; tx: number; ty: number };
/** The part of the screen the sky draws in: its size, and the strips along
 *  its top and bottom that a bar always covers (the BunnyPad's top bar). A
 *  sheet that comes and goes with the drawer is `cameraOnStar`'s
 *  `bottomInset` instead. */
export type SkyViewport = { w: number; h: number; top?: number; bottom?: number };

export function toScreen(p: SkyPoint, cam: SkyCamera): SkyPoint {
  return { x: p.x * cam.k + cam.tx, y: p.y * cam.k + cam.ty };
}

/** The box every star's label takes, in em, or null for an empty sky. */
function skyBounds(stars: readonly SkyStarLike[]): SkyBox | null {
  let box: SkyBox | null = null;
  for (const s of stars) {
    const b = skyLabelBox(s, s.label);
    box = box
      ? {
          left: Math.min(box.left, b.left),
          right: Math.max(box.right, b.right),
          top: Math.min(box.top, b.top),
          bottom: Math.max(box.bottom, b.bottom),
        }
      : b;
  }
  return box;
}

/** The view that fits every star and its label in the uncovered part of the
 *  viewport, centered there, with `padPx` clear around them. */
export function fitSkyCamera(
  stars: readonly SkyStarLike[],
  vp: SkyViewport,
  padPx = FIT_PAD_PX,
): SkyCamera {
  const top = vp.top ?? 0;
  const visibleH = Math.max(1, vp.h - top - (vp.bottom ?? 0));
  const midY = top + visibleH / 2;
  const box = skyBounds(stars);
  if (!box) return { k: LABEL_FONT_PX, tx: vp.w / 2, ty: midY };
  const bw = Math.max(1, box.right - box.left);
  const bh = Math.max(1, box.bottom - box.top);
  const k = Math.min(
    MAX_FIT_K,
    Math.max(0.5, Math.min((vp.w - 2 * padPx) / bw, (visibleH - 2 * padPx) / bh)),
  );
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  return { k, tx: vp.w / 2 - cx * k, ty: midY - cy * k };
}

/** How far a kid can zoom from the fitted view: out a little, and in until
 *  labels are well apart. */
export function zoomLimits(fitK: number): { min: number; max: number } {
  return { min: fitK * 0.6, max: Math.max(LABEL_FONT_PX * 3, fitK * 4) };
}

/** Zoom by `factor` around the screen point (sx, sy), which stays put. */
export function zoomAt(
  cam: SkyCamera,
  factor: number,
  sx: number,
  sy: number,
  limits: { min: number; max: number },
): SkyCamera {
  const k = Math.min(limits.max, Math.max(limits.min, cam.k * factor));
  const r = k / cam.k;
  return { k, tx: sx - (sx - cam.tx) * r, ty: sy - (sy - cam.ty) * r };
}

/**
 * The view that moves the sky to a star: the star centered in the part of
 * the viewport the drawer leaves uncovered (`rightInset` px on the right
 * beside a side drawer, `bottomInset` px at the bottom where a narrow web
 * screen's sheet sits), zoomed in far enough that its label and its
 * neighbors' labels read.
 */
export function cameraOnStar(
  star: SkyPoint,
  cam: SkyCamera,
  vp: SkyViewport,
  rightInset = 0,
  bottomInset = 0,
): SkyCamera {
  const k = Math.max(cam.k, LABEL_FONT_PX * 1.1);
  const visibleW = Math.max(vp.w - rightInset, vp.w * 0.4);
  const tx = visibleW / 2 - star.x * k;
  if (bottomInset <= 0) {
    const top = vp.top ?? 0;
    const midY = top + Math.max(1, vp.h - top - (vp.bottom ?? 0)) / 2;
    // The dot plus its label read as one thing: center the pair, not the dot.
    const labelDropEm = SKY_LABEL.lineEm;
    return { k, tx, ty: midY - (star.y + labelDropEm / 2) * k };
  }
  // Above a sheet the room is short, so place the dot from the label as it
  // is drawn (a fixed pixel size): the dot and the label's first line
  // centered in the uncovered part, the whole label inside it where it fits,
  // and the dot never above the top.
  const visibleH = Math.max(0, vp.h - bottomInset);
  const lineHeightPx = SKY_LABEL.lineEm * LABEL_FONT_PX;
  const labelBelowDotPx = (SKY_LABEL.dotEm / 2 + SKY_LABEL.maxLines * SKY_LABEL.lineEm) * LABEL_FONT_PX;
  const dotY = Math.max(
    FRAME_TOP_PAD_PX,
    Math.min(visibleH / 2 - lineHeightPx / 2, visibleH - labelBelowDotPx),
  );
  return { k, tx, ty: dotY - star.y * k };
}

// ─── Labels ───────────────────────────────────────────────────────────

/** A star's label box on screen, in px. */
export function screenLabelBox(star: SkyStarLike, cam: SkyCamera, fontPx = LABEL_FONT_PX): SkyBox {
  const at = toScreen(star, cam);
  const em = skyLabelBox({ x: 0, y: 0 }, star.label);
  return {
    left: at.x + em.left * fontPx,
    right: at.x + em.right * fontPx,
    top: at.y + em.top * fontPx,
    bottom: at.y + em.bottom * fontPx,
  };
}

/** Labels first: the shown Quests, then the wonders they grew from (the other
 *  end of each trail), then other Quests, then wonders, newest first within
 *  each. */
function labelOrder(trailStarts: ReadonlySet<string>) {
  const rank = (s: SkyStarLike) =>
    s.bright ? 0 : trailStarts.has(s.id) ? 1 : s.kind === "quest" ? 2 : 3;
  const when = (s: SkyStarLike) => s.wonder?.askedAt ?? s.quest?.shownAt ?? 0;
  return (a: SkyStarLike, b: SkyStarLike) => rank(a) - rank(b) || when(b) - when(a);
}

/** How many labels may show at camera scale `k`: a few with the whole sky in
 *  view, more as the kid zooms in. */
export function labelCap(k: number, fitK: number): number {
  const zoom = Math.max(1, k / fitK);
  return Math.round(LABELS_AT_REST * zoom * zoom);
}

/**
 * The stars whose labels show: in `labelOrder`, each label on screen whose
 * box clears every label already kept, up to `cap`. The selected star's
 * label always shows, and its nearby stars' labels come next. Off-screen
 * stars neither show nor count.
 */
export function labelsToShow(
  stars: readonly SkyStarLike[],
  cam: SkyCamera,
  vp: SkyViewport,
  opts: { cap: number; selectedId?: string | null; fontPx?: number },
): Set<string> {
  const fontPx = opts.fontPx ?? LABEL_FONT_PX;
  const gap = SKY_LABEL.gapEm * fontPx;
  const trailStarts = new Set(trailPairs(stars).map(([from]) => from));
  const ordered = [...stars].sort(labelOrder(trailStarts));
  const selected = opts.selectedId ? ordered.find((s) => s.id === opts.selectedId) : undefined;
  if (selected) {
    // The selected star, then the stars its drawer names as near it.
    const near = new Set(selected.nearby);
    const first = [selected, ...ordered.filter((s) => near.has(s.id))];
    ordered.splice(0, ordered.length, ...first, ...ordered.filter((s) => !first.includes(s)));
  }
  const kept: SkyBox[] = [];
  const shown = new Set<string>();
  for (const star of ordered) {
    if (shown.size >= opts.cap && star !== selected) break;
    const box = screenLabelBox(star, cam, fontPx);
    const onScreen = box.right > 0 && box.left < vp.w && box.bottom > 0 && box.top < vp.h;
    if (!onScreen) continue;
    if (star !== selected && kept.some((k) => skyBoxesOverlap(k, box, gap))) continue;
    kept.push(box);
    shown.add(star.id);
  }
  return shown;
}

// ─── Lines ────────────────────────────────────────────────────────────

/** The trails: from the wonder a shown Quest grew from, to that Quest. */
export function trailPairs(stars: readonly SkyStarLike[]): [string, string][] {
  const ids = new Set(stars.map((s) => s.id));
  return stars
    .filter((s) => s.trailFromStarId && ids.has(s.trailFromStarId))
    .map((s) => [s.trailFromStarId!, s.id]);
}

/** The faint lines: each star to the stars in its `nearby` list, once per
 *  pair, leaving out a pair a trail already joins. */
export function nearbyPairs(stars: readonly SkyStarLike[]): [string, string][] {
  const ids = new Set(stars.map((s) => s.id));
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const seen = new Set(trailPairs(stars).map(([a, b]) => key(a, b)));
  const pairs: [string, string][] = [];
  for (const s of stars) {
    for (const n of s.nearby) {
      if (!ids.has(n) || n === s.id) continue;
      const k = key(s.id, n);
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push([s.id, n]);
    }
  }
  return pairs;
}

// ─── The drawer's words ───────────────────────────────────────────────

const PLACE_WORDS = {
  quests: "You asked on Quests",
  prep: "You asked on Scholar’s Prep",
  build: "You asked while building",
} as const;

/** "October 31", with the year when it isn't this year's. */
function skyDate(atMs: number, nowMs: number, timeZone?: string): string {
  const year = (ms: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(new Date(ms));
  const sameYear = year(atMs) === year(nowMs);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(atMs));
}

/** A wonder's drawer line: "You asked on Quests · October 31". */
export function wonderAskedLine(
  askedOn: keyof typeof PLACE_WORDS | null,
  askedAt: number,
  nowMs: number,
  timeZone?: string,
): string {
  const place = (askedOn && PLACE_WORDS[askedOn]) || "You asked";
  return `${place} · ${skyDate(askedAt, nowMs, timeZone)}`;
}

const QUEST_KIND_WORDS = { app: "App", slides: "Slides", python: "Python" } as const;

/** A Quest's drawer line: "App · shown October 21", or just its kind before
 *  it is shown. */
export function questShownLine(
  kind: keyof typeof QUEST_KIND_WORDS | null,
  shownAt: number | null,
  nowMs: number,
  timeZone?: string,
): string {
  const word = (kind && QUEST_KIND_WORDS[kind]) || "Quest";
  return shownAt === null ? word : `${word} · shown ${skyDate(shownAt, nowMs, timeZone)}`;
}
