/**
 * Brand colors for the manipulative SVG layer, pulled from the single source of
 * truth (`@/shared/brand`) so the primitive can never drift from the theme.
 * The chrome (cards, buttons, text) uses Chakra tokens; the SVG stages use these.
 */
import { palette } from "@/shared/brand";

export const C = {
  navy: palette.navy[500], // #222656 — linework, axes, text on light
  charcoal: palette.charcoal[500], // #364153 — secondary ink
  violet: palette.violet[500], // #a960bc
  cyan: palette.cyan[500], // #2ECCDF
  green: palette.green[500], // #00DD91
  orange: palette.orange[500], // #FFA639
  yellow: palette.yellow[500], // #FFE77C
  teal: palette.darkCyan[500], // #1F6F73
  line: palette.gray[200], // #e6e8ea — faint grid / borders
  faint: palette.gray[100],
  bg: "#ffffff",
  cream: palette.gray[50],
} as const;

/** A subtle wash of a hue (for fills behind linework). */
export function wash(hex: string, alpha = 0.16): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
