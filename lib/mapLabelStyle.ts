/**
 * Shared node/star LABEL metrics — the Tree (`components/map/MapTreeCanvas`) and
 * the Sky (`lib/atlasEngine`) render their labels at the SAME font size, max
 * width, and wrapped line count, so the two lenses feel like one surface. Colour
 * is intentionally NOT shared here (it stays per-lens: charcoal on the daylight
 * tree, star-coloured on the night sky). This module is the single source of the
 * three metrics Andy asked to unify (font · width · lines).
 */
export const MAP_LABEL = {
  /** constant on-screen font size (px) — never scaled by the camera. */
  fontSizePx: 11,
  lineHeight: 1.25,
  /** wrap width (px). */
  maxWidthPx: 180,
  /** max wrapped lines before ellipsis. */
  lineClamp: 3,
} as const;

/** Height (px) of a `lines`-line label box (clamped to `lineClamp`). */
export function mapLabelHeightPx(lines: number): number {
  const n = Math.max(1, Math.min(MAP_LABEL.lineClamp, lines));
  return n * MAP_LABEL.fontSizePx * MAP_LABEL.lineHeight;
}

/** How many (clamped) lines a given single-line width would wrap to at maxWidth. */
export function mapLabelLines(singleLineWidthPx: number): number {
  return Math.max(1, Math.min(MAP_LABEL.lineClamp, Math.ceil(singleLineWidthPx / MAP_LABEL.maxWidthPx)));
}

/**
 * Inline-style CSS declarations for a wrapped label box, for the string-built
 * labels in `atlasEngine` (which can't use Chakra). The caller appends colour +
 * text-shadow (per-lens). Mirrors the Tree label's Chakra `css` exactly.
 */
export function mapLabelBoxCss(): string {
  return (
    `font-size:${MAP_LABEL.fontSizePx}px;` +
    `line-height:${MAP_LABEL.lineHeight};` +
    `max-width:${MAP_LABEL.maxWidthPx}px;` +
    `white-space:normal;` +
    `display:-webkit-box;-webkit-box-orient:vertical;` +
    `-webkit-line-clamp:${MAP_LABEL.lineClamp};overflow:hidden`
  );
}
