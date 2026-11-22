// The box a star's label takes on a kid's own Sky (TRA-699): the contract
// the layout (convex/lib/skyLayout.ts) keeps clear and both renderers draw.
// It lives here, not in convex/, so the BunnyPad can vendor it (native
// scripts/sync-vendor.js) and size its labels from the same numbers.
//
// Units: em, the label's font size; y grows downward. The star's dot is at
// (x, y) and its label sits centered under it, wrapped at SKY_LABEL.lineChars
// characters to at most SKY_LABEL.maxLines lines.

export const SKY_LABEL = {
  /** Average width of one character, in em. */
  charEm: 0.55,
  /** A label wraps at this many characters... */
  lineChars: 24,
  /** ...to at most this many lines (a renderer ellipsizes the rest). */
  maxLines: 2,
  lineEm: 1.3,
  /** The star's dot, which sits above the label. */
  dotEm: 0.8,
  /** The least clear space between two label boxes. */
  gapEm: 0.5,
} as const;

export type SkyPoint = { x: number; y: number };
export type SkyBox = { left: number; right: number; top: number; bottom: number };

/** The box a label takes, in em: its width and height (dot included). */
export function skyLabelSize(label: string): { w: number; h: number } {
  const chars = Math.max(1, Array.from(label).length);
  const lines = Math.min(SKY_LABEL.maxLines, Math.ceil(chars / SKY_LABEL.lineChars));
  const widest = Math.min(chars, SKY_LABEL.lineChars);
  return {
    w: Math.max(SKY_LABEL.dotEm, widest * SKY_LABEL.charEm),
    h: SKY_LABEL.dotEm + lines * SKY_LABEL.lineEm,
  };
}

/** The box of a star at `p`: the dot on top, the label centered under it. */
export function skyLabelBox(p: SkyPoint, label: string): SkyBox {
  const { w, h } = skyLabelSize(label);
  return {
    left: p.x - w / 2,
    right: p.x + w / 2,
    top: p.y - SKY_LABEL.dotEm / 2,
    bottom: p.y - SKY_LABEL.dotEm / 2 + h,
  };
}

/** Do two boxes come closer than the gap? */
export function skyBoxesOverlap(a: SkyBox, b: SkyBox, gap: number = SKY_LABEL.gapEm): boolean {
  return (
    a.left < b.right + gap &&
    b.left < a.right + gap &&
    a.top < b.bottom + gap &&
    b.top < a.bottom + gap
  );
}
