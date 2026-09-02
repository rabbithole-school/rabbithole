// Wet-ink streaming reveal — the PURE, framework-agnostic engine shared by the
// web (components/StreamingText.tsx) and native
// (native/src/components/StreamingText.tsx, via native/vendor/shared/)
// renderers, so both surfaces reveal live tutor text with IDENTICAL cadence,
// timing, and colour ramp. No React, no RN, no DOM here — only the timing
// constants, the colour-ramp maths, the leaky-bucket advance, and the per-frame
// view computation. Each renderer owns only its own requestAnimationFrame loop
// + framework-specific painting (RN <Text> spans vs DOM <span>s).
//
// The model: network tokens arrive in bursts (and, on web, the server buffers to
// sentence boundaries — a child-safety guard). We buffer the received text and
// RELEASE it roughly one character at a time at a steady pace (speeding up only
// when a backlog builds), decoupling the display cadence from the choppy network
// cadence — a smooth typewriter at any chunk size. Each released char is laid
// down "wet" and DRIES to solid over `fadeMs` on its own clock, so a pause in
// the stream visibly dries the trailing ink rather than freezing a gradient.

import { segmentParagraphs } from "./streamingParagraphs";

export { segmentParagraphs } from "./streamingParagraphs";

// ── Timing / feel constants (the single source of truth for BOTH surfaces) ──

/** Vertical gap between paragraph blocks — matches the tutor <Markdown/> body
 * paragraph margin so streaming → settled never shifts. */
export const PARA_GAP = 10;

/** Fallback ink colour when neither `ramp` nor `color` is supplied. */
export const DEFAULT_INK_COLOR = "#364153";

/** How long a released character stays "wet" before drying to solid (ms). */
export const DEFAULT_FADE_MS = 320;

/** The freshest character of a single-colour ramp starts at this opacity. */
export const TAIL_MIN_ALPHA = 0.25;

/** Leaky-bucket drip: base ≈ 1 char/frame (~60 cps) while streaming; a backlog
 * drains faster so we never fall far behind. `done` empties the bucket briskly
 * so the reply settles fast once the network is finished. */
export const CATCHUP_STREAMING = 0.14;
export const CATCHUP_DONE = 0.4;

// ── Colour ramp ─────────────────────────────────────────────────────────────

// A stop on the wet-ink ramp: at dryness `at` (0 = freshest ink, 1 = fully dry)
// the character reads as `color` at `alpha` opacity. Stops interpolate across
// BOTH hue and alpha, so ink can materialize in one colour and "dry" into
// another (e.g. navy 0% → navy 100% → black 100%).
export type InkStop = { at: number; color: string; alpha?: number };
export type ResolvedStop = { at: number; r: number; g: number; b: number; a: number };

/** One still-wet character at its current dried colour (an rgba() string). */
export type InkSpan = { key: number; ch: string; color: string };
/** A paragraph: a solid `body` prefix plus its still-wet trailing `spans`. */
export type ParaView = { body: string; spans: InkSpan[] };
/** The computed display for one animation frame. */
export type InkView = { paras: ParaView[] };

export function clamp01(t: number) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function easeOut(t: number) {
  const p = clamp01(t);
  return 1 - (1 - p) * (1 - p);
}

type Rgb = { r: number; g: number; b: number };

function parseHex(color: string): Rgb {
  const hex = color.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex)) {
    const [r, g, b] = hex.split("").map((v) => parseInt(v + v, 16));
    return { r, g, b };
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r: r || 0, g: g || 0, b: b || 0 };
}

export function buildRamp(ramp: InkStop[] | undefined, color: string | undefined): ResolvedStop[] {
  const base = color ?? DEFAULT_INK_COLOR;
  const stops: InkStop[] =
    ramp && ramp.length >= 2
      ? ramp
      : [
          { at: 0, color: base, alpha: TAIL_MIN_ALPHA },
          { at: 1, color: base, alpha: 1 },
        ];
  return stops
    .map((s) => {
      const { r, g, b } = parseHex(s.color);
      return { at: clamp01(s.at), r, g, b, a: s.alpha ?? 1 };
    })
    .sort((x, y) => x.at - y.at);
}

/** Sample the ramp at dryness d ∈ [0,1] → an rgba() string. */
export function sampleRamp(stops: ResolvedStop[], d: number): string {
  const q = clamp01(d);
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (q >= stops[i].at && q <= stops[i + 1].at) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi.at - lo.at;
  const t = span <= 0 ? 0 : (q - lo.at) / span;
  const r = Math.round(lo.r + (hi.r - lo.r) * t);
  const g = Math.round(lo.g + (hi.g - lo.g) * t);
  const b = Math.round(lo.b + (hi.b - lo.b) * t);
  const a = lo.a + (hi.a - lo.a) * t;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ── Leaky-bucket advance + per-frame view ────────────────────────────────────

/** Advance the leaky-bucket level by one frame. `released` is a float char
 * count; a backlog drains at `catchup` per frame (min 1 char), clamped to
 * `total`. Pure — the caller owns the ref that stores the running level. */
export function advanceReveal(released: number, total: number, done: boolean): number {
  const catchup = done ? CATCHUP_DONE : CATCHUP_STREAMING;
  const backlog = total - released;
  if (backlog <= 0) return Math.min(total, released);
  return Math.min(total, released + Math.max(1, backlog * catchup));
}

/**
 * Compute the display for one frame. `released` is the current bucket level
 * (float); `revealedAt[k]` is the timestamp char k was released (its dry clock).
 * Returns paragraphs, each a solid `body` prefix (fully-dry chars) plus trailing
 * `spans` (one per still-wet char, at its current dried colour). Pure: the
 * caller passes the ref VALUES; nothing here mutates.
 */
export function computeInkView(
  content: string,
  now: number,
  released: number,
  revealedAt: number[],
  stops: ResolvedStop[],
  dryMs: number,
): InkView {
  const total = content.length;
  const segments = segmentParagraphs(content);
  const shown = Math.min(total, Math.floor(released));
  const dryness = (k: number) => easeOut((now - (revealedAt[k] ?? now)) / dryMs);
  // Global fully-dry boundary: walk back over the still-wet trailing chars.
  let split = shown;
  while (split > 0 && dryness(split - 1) < 1) split -= 1;
  const paras: ParaView[] = [];
  for (const seg of segments) {
    if (shown <= seg.start) break; // paragraph not yet reached (segments ordered)
    const localShown = Math.min(seg.text.length, shown - seg.start);
    const localSplit = Math.max(0, Math.min(localShown, split - seg.start));
    const body = seg.text.slice(0, localSplit);
    const spans: InkSpan[] = [];
    for (let k = localSplit; k < localShown; k++) {
      const gk = seg.start + k;
      spans.push({ key: gk, ch: seg.text[k], color: sampleRamp(stops, dryness(gk)) });
    }
    paras.push({ body, spans });
  }
  return { paras };
}
