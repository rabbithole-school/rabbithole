/**
 * Grapheme reading-ramp — the framework-agnostic render core.
 *
 * Rabbithole's young-learners "reading ramp" (review/young-learners-plan.html
 * §10) colors grapheme teams ("sh", "th", "ea", …) inside the tutor's rendered
 * text so a pre-reader sees the two letters as one sound-unit, then FADES that
 * color toward normal ink per-team as the scholar's decoding confidence grows.
 *
 * This module is pure presentation math: given the text, the annotator's spans,
 * and each team's fade stage, it produces the ordered segments the platform
 * components (components/GraphemeText.tsx and
 * native/src/components/GraphemeText.tsx) paint. It has NO framework imports —
 * exactly like shared/brand.ts — so web and native render identically and the
 * palette can never drift. (Native consumes a vendored copy under
 * native/vendor/shared/, refreshed by native/scripts/sync-vendor.js.)
 *
 * Contract highlights (see graphemeSegments.test.ts for the full spec):
 *   • Segments concatenate EXACTLY back to the input text — the text is never
 *     altered, only partitioned.
 *   • Spans are character offsets [start, end) into `text`. Out-of-range or
 *     zero/negative-length spans are dropped; overlaps keep the first (by start,
 *     then longest) and drop the rest.
 *   • A span whose team is "graduated" (or unknown / missing from `stages`)
 *     produces a plain segment (no team, no stage) — the scaffold is gone.
 *
 * The annotator (a Haiku pass, landing separately) is responsible for matching
 * spans to real letters; this layer only range-checks defensively.
 */

/** A grapheme-team span from the annotator: character offsets [start, end). */
export type GraphemeSpan = {
  start: number;
  end: number;
  team: string;
};

/**
 * The per-team fade stage. Comes in as a prop today (the per-scholar confidence
 * map is deferred until PR #400's schema settles); teams absent from the map,
 * or explicitly "graduated", render as plain ink.
 */
export type GraphemeStage = "training" | "fading" | "graduated";

/** Stage lookup by team name. Missing / unknown teams default to "graduated". */
export type GraphemeStages = Record<string, GraphemeStage>;

/**
 * One piece of the rendered string. `team`/`stage` are present only for a
 * colored (training or fading) grapheme team; plain text carries neither.
 */
export type GraphemeSegment = {
  text: string;
  team?: string;
  stage?: Exclude<GraphemeStage, "graduated">;
};

// ── Palette ──────────────────────────────────────────────────────────────────
// Six distinguishable hues, one per common team family. Teams are assigned a
// hue deterministically by hashing the team string, so unknown teams still get
// a stable color and the same team always reads the same. These are picked for
// contrast against Rabbithole's charcoal body ink (#364153), echoing the §10
// sketch's violet / cyan / amber training-wheel colors. Framework-agnostic hex
// so web and native share them verbatim.
//
// Calibration: training = ~Chakra 500 weight — lighter + more saturated than
// body ink so a live team pops out of the surrounding charcoal prose. Each hue
// was shifted one palette step "down" from its original ~600/700 value by
// raising HSL saturation +12pp and lightness +8pp (hue unchanged, so the six
// stay mutually distinguishable and legible on white / light-gray bubbles).
// The prior values read too close to the ink. — Andy 2026-07-04
export const GRAPHEME_PALETTE = [
  "#9255fb", // violet  — §10 "sh"  (was #7c3aed)
  "#0699c1", // cyan    — §10 "th"  (was #0e7490)
  "#e66300", // amber   — §10 "ea"  (was #b45309)
  "#f20740", // rose               (was #be123c)
  "#0fae4b", // green              (was #15803d)
  "#574cdf", // indigo             (was #4338ca)
] as const;

/** The color a fully-graduated (plain) team would settle into: body ink. */
export const GRAPHEME_INK = "#364153";

// ── Fading derivation ─────────────────────────────────────────────────────────
// A "fading" team should read as calmer than training but UNMISTAKABLY still
// colored — the scaffold receding, not gone. Naive RGB blending toward the dark
// charcoal ink desaturates far too fast (50% numeric ≈ a washed-out grey), so we
// fade in HSL instead: keep the team's HUE exactly, keep MOST of its saturation,
// and move only its LIGHTNESS partway toward the ink's. The result is a deeper,
// quieter version of the same hue that still reads chromatic at a glance.
// — Andy 2026-07-04

/**
 * Fraction of a fading team's SATURATION to retain (1 = keep all, 0 = pull fully
 * to the ink's low chroma). Kept high so the fade never greys out.
 */
export const GRAPHEME_FADE_SAT_RETAIN = 0.9;

/**
 * How far a fading team's LIGHTNESS moves toward the ink's. 0 = training
 * lightness (no change), 1 = the ink's lightness. "Partway" = calmer, not gone.
 */
export const GRAPHEME_FADE_LIGHTNESS = 0.4;

/**
 * Deterministic team → palette index. A tiny FNV-1a-style string hash keeps the
 * same team on the same hue across reloads, platforms, and unknown teams.
 */
export function teamColorIndex(team: string): number {
  let hash = 2166136261;
  for (let i = 0; i < team.length; i++) {
    hash ^= team.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // >>> 0 → unsigned before modulo so the index is always non-negative.
  return (hash >>> 0) % GRAPHEME_PALETTE.length;
}

/** The full-strength hue for a team. */
export function teamColor(team: string): string {
  return GRAPHEME_PALETTE[teamColorIndex(team)];
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(n: number): string {
  const clamped = n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
  return clamped.toString(16).padStart(2, "0");
}

/**
 * Blend `color` toward `target` by `amount` (0 = color, 1 = target). A general
 * RGB-space lerp between two hex colors. Pure hex, no alpha — a blend must not
 * introduce transparency onto whatever surface the text sits on. (Fading no
 * longer uses this — see fadeTowardInk — but it stays as a reusable util.)
 */
export function blendHex(color: string, target: string, amount: number): string {
  const t = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const [r1, g1, b1] = parseHex(color);
  const [r2, g2, b2] = parseHex(target);
  return `#${toHex(r1 + (r2 - r1) * t)}${toHex(g1 + (g2 - g1) * t)}${toHex(
    b1 + (b2 - b1) * t,
  )}`;
}

/** sRGB [0–255] → HSL with h in [0,360), s and l in [0,1]. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l]; // achromatic
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  return [h * 60, s, l];
}

/** HSL (h in [0,360), s/l in [0,1]) → sRGB [0–255]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v]; // achromatic
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hn = h / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, hn + 1 / 3) * 255,
    hue2rgb(p, q, hn) * 255,
    hue2rgb(p, q, hn - 1 / 3) * 255,
  ];
}

/**
 * A team's "fading" color: same hue, most of its saturation, lightness pulled
 * partway toward the ink's. Hue-preserving (HSL) rather than an RGB lerp toward
 * the dark ink, so the fade stays chromatic instead of greying out — see the
 * §"Fading derivation" note above.
 */
export function fadeTowardInk(color: string): string {
  const [ch, cs, cl] = rgbToHsl(...parseHex(color));
  const [, inkS, inkL] = rgbToHsl(...parseHex(GRAPHEME_INK));
  const s = cs + (inkS - cs) * (1 - GRAPHEME_FADE_SAT_RETAIN);
  const l = cl + (inkL - cl) * GRAPHEME_FADE_LIGHTNESS;
  const [r, g, b] = hslToRgb(ch, s, l);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * The rendered color for a team at a given stage. "training" is the full hue;
 * "fading" is a hue-preserving, still-chromatic step toward the ink. (Graduated
 * teams never reach here — they become plain segments upstream.)
 */
export function stageColor(team: string, stage: Exclude<GraphemeStage, "graduated">): string {
  const base = teamColor(team);
  return stage === "fading" ? fadeTowardInk(base) : base;
}

/** A span that survived range/overlap validation, tagged with its effective stage. */
type ActiveSpan = {
  start: number;
  end: number;
  team: string;
  stage: Exclude<GraphemeStage, "graduated">;
};

/**
 * Turn text + annotator spans + per-team stages into an ordered, gap-filled
 * list of segments that concatenate exactly back to `text`.
 *
 * Defensive validation (the annotator already vetted letters; this guards the
 * render):
 *   • drop spans that are non-integer, out of [0, text.length], or empty/negative
 *   • drop spans whose team is graduated / unknown (they render as plain ink)
 *   • on overlap, keep the first span (earliest start, then longest) and drop
 *     any later span that intersects an already-kept one
 */
export function toSegments(
  text: string,
  spans: readonly GraphemeSpan[],
  stages: GraphemeStages,
): GraphemeSegment[] {
  if (text.length === 0) return [];

  const active: ActiveSpan[] = [];
  for (const span of spans) {
    const { start, end, team } = span;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > text.length ||
      end <= start
    ) {
      continue;
    }
    const stage = stages[team] ?? "graduated";
    if (stage === "graduated") continue;
    active.push({ start, end, team, stage });
  }

  // Sort by start, then by longest-first, so overlap resolution deterministically
  // keeps the earliest (and, on a tie, widest) span.
  active.sort((a, b) => a.start - b.start || b.end - a.end);

  const kept: ActiveSpan[] = [];
  let lastEnd = 0;
  for (const span of active) {
    if (span.start < lastEnd) continue; // intersects an already-kept span → drop
    kept.push(span);
    lastEnd = span.end;
  }

  const segments: GraphemeSegment[] = [];
  let cursor = 0;
  for (const span of kept) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start) });
    }
    segments.push({ text: text.slice(span.start, span.end), team: span.team, stage: span.stage });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments;
}
