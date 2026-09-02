// The single source of truth for how long a portfolioItems.label may be. The
// label is the human-assigned name the school gives a work — capped so it stays
// a name, not a paragraph. Every HUMAN writer of the field shares this cap: the
// staff uploads queue (portfolio.setLabels), the robotics kiosk
// (captureStations.setCaptureLabel), and the native capture editor's input.
// No AI/extraction path ever writes label, so this cap is the only one it needs.
//
// The cap counts USER-PERCEIVED characters (grapheme clusters), NOT UTF-16 code
// units, so a name of 41 emoji reads as 41 — not 82 — and a kid who names a
// capture in emoji is not silently cut off at half length. `labelGraphemeCount`
// is the ONE implementation both sides use: the server rejects at the same count
// the native input clamps to (`clampLabelToCap`), so client and server always
// agree on "too long".
export const LABEL_MAX_LENGTH = 80;

// A minimal structural type for Intl.Segmenter so this module type-checks under
// the convex tsconfig's ES2021 lib (which predates the Intl.Segmenter lib type)
// as well as the frontend/native esnext libs. We never depend on the global
// `Intl.Segmenter` type; we probe for it at runtime and fall back when absent
// (e.g. a Hermes build without full Intl).
type LabelSegmenter = { segment(input: string): Iterable<{ segment: string }> };

const graphemeSegmenter: LabelSegmenter | null = (() => {
  const maybe = (
    globalThis as {
      Intl?: {
        Segmenter?: new (
          locales?: string | string[],
          options?: { granularity?: "grapheme" | "word" | "sentence" },
        ) => LabelSegmenter;
      };
    }
  ).Intl?.Segmenter;
  if (typeof maybe !== "function") return null;
  try {
    return new maybe(undefined, { granularity: "grapheme" });
  } catch {
    return null;
  }
})();

/**
 * Count user-perceived characters (grapheme clusters) in a label. Uses
 * `Intl.Segmenter` where available; otherwise falls back to counting Unicode
 * code points (`[...str].length`), which still treats an astral emoji as one
 * unit rather than the two UTF-16 code units `String.length` would report.
 */
export function labelGraphemeCount(value: string): number {
  if (graphemeSegmenter) {
    let count = 0;
    for (const _ of graphemeSegmenter.segment(value)) count += 1;
    return count;
  }
  return [...value].length;
}

/** Whether a label is within the cap, counted by grapheme clusters. */
export function labelWithinCap(value: string): boolean {
  return labelGraphemeCount(value) <= LABEL_MAX_LENGTH;
}

/**
 * Truncate a label to at most `LABEL_MAX_LENGTH` grapheme clusters, never
 * splitting a multi-code-unit character. Used by the native input's
 * `onChangeText` so a scholar cannot enter a name the server would reject.
 */
export function clampLabelToCap(value: string): string {
  if (labelGraphemeCount(value) <= LABEL_MAX_LENGTH) return value;
  if (graphemeSegmenter) {
    let out = "";
    let count = 0;
    for (const { segment } of graphemeSegmenter.segment(value)) {
      if (count >= LABEL_MAX_LENGTH) break;
      out += segment;
      count += 1;
    }
    return out;
  }
  return [...value].slice(0, LABEL_MAX_LENGTH).join("");
}
