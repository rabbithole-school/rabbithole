import { Platform, useColorScheme } from "react-native";

import { palette, status } from "../vendor/shared/brand";
import { domainColor } from "../vendor/shared/skyTiers";

// Re-export the raw palette + status colors so native components can reach deep
// scale values (e.g. navy[900] for the star map, status.red for error text) via
// "@/theme" without another vendor import.
export { palette, status };

// Rabbithole brand tokens for the native app, derived from the SHARED brand
// source (shared/brand.ts) so the color scheme can never drift from web. Only
// the React-Native-shaped flattening lives here; the hex values live in shared.

// ─── Light colors (default) ──────────────────────────────────────────────────

const lightColors = {
  // Brand
  navy: palette.navy[500],
  navyHover: palette.navy[700],
  violet: palette.violet[500],
  violetSolid: palette.violet[600],
  violetSubtle: palette.violet[50],
  violetMuted: palette.violet[100],
  orange: palette.orange[500],
  orangeSubtle: palette.orange[50],
  orangeMuted: palette.orange[100],
  cyan: palette.cyan[500],
  cyanSubtle: palette.cyan[50],
  cyanMuted: palette.cyan[100],
  // Depth-indigo — the tree map's depth-arc color (COLOR_DEPTH in
  // treeGlyphs/KnowledgeNodeDial). Used by the practice "stretch" lane so
  // going-deeper UI reads as the same idea as the dial's depth flank.
  indigo: "#5663c6",
  indigoSubtle: "#f4f5fc",
  indigoMuted: "#b9c0ea",
  // Practice-teal — the Math Playlist identity accent. Mirrors web
  // PlaylistCard's GLYPH_COLOR / CTA (#16707e, an un-tokenized hex on web) so the
  // scholar-home Playlist card reads identically across surfaces (web↔native
  // parity, PR #549 §7).
  teal: "#16707e",
  green: palette.green[500],
  yellow: palette.yellow[500],

  // Neutrals
  charcoal: palette.charcoal[500],
  charcoalMuted: palette.charcoal[400],
  charcoalSubtle: palette.charcoal[300],
  gray50: palette.gray[50],
  gray100: palette.gray[100],
  gray200: palette.gray[200],
  gray300: palette.gray[300],
  white: palette.white,

  // Semantic
  bg: palette.white,
  bgSubtle: palette.gray[50],
  fg: palette.charcoal[500],
  fgMuted: palette.charcoal[400],
  border: palette.gray[200],

  // Status
  statusGreen: status.green,
  statusYellow: status.yellow,
  statusRed: status.red,
  danger: palette.orange[900],
} as const;

// ─── Dark colors ─────────────────────────────────────────────────────────────
// Backgrounds flip to dark charcoal; foregrounds flip to light grays.
// Accent hues (violet, cyan, green, orange) are shifted one step brighter so
// they stay vivid against dark surfaces. Navy is lightened so it reads as text.

const darkColors = {
  // Brand — slightly brighter so they pop on dark surfaces
  navy: palette.navy[300],        // #777ca5 — readable as title text + distinctive as user-bubble bg
  navyHover: palette.navy[200],   // #9ea2bf
  violet: palette.violet[400],    // #ba7eca — bumped for visibility
  violetSolid: palette.violet[500],
  violetSubtle: palette.navy[800],  // #151837 — dark violet-tinted bg
  violetMuted: palette.navy[700],   // #1a1d42
  orange: palette.orange[400],    // #ffbe6b
  orangeSubtle: "#2a1c0c", // deep warm-tinted near-black (no darkOrange scale; matches navy[800]/darkCyan[900] depth)
  orangeMuted: "#3a2814",  // pressed state — slightly lighter warm
  cyan: palette.cyan[400],        // #68dce9
  cyanSubtle: palette.darkCyan[900], // #0f3536 — dark cool-tinted bg
  cyanMuted: palette.darkCyan[800],  // #144749
  // Depth-indigo, brightened for dark surfaces (subtle = deep indigo-tinted bg).
  indigo: "#8d97e8",
  indigoSubtle: "#141833",
  indigoMuted: "#2a3168",
  // Practice-teal, brightened for dark surfaces — the exact #16707e (light) glyph
  // is too low-contrast on dark charcoal (the reason this parity fix was deferred
  // in #549). darkCyan[400] keeps the teal hue while staying legible on dark.
  teal: palette.darkCyan[400],    // #4d9a9d
  green: palette.green[400],      // #4de5b0
  yellow: palette.yellow[400],    // #FFEC8A

  // Neutrals — flipped: what was light is now dark and vice versa
  charcoal: palette.gray[100],        // #f0f1f3 — near-white body text
  charcoalMuted: palette.gray[300],   // #d0d4d9
  charcoalSubtle: palette.charcoal[300], // #a3aab3 — mid-gray (works on dark)
  gray50: palette.charcoal[800],      // #232b37 — lightest dark surface
  gray100: palette.charcoal[700],     // #2a3340
  gray200: palette.charcoal[600],     // #303a4a — skeleton / divider
  gray300: palette.charcoal[500],     // #364153 — disabled / placeholder
  white: palette.white,               // kept — explicit white (user bubble text etc.)

  // Semantic
  bg: palette.charcoal[900],       // #1a2029 — deepest background
  bgSubtle: palette.charcoal[800], // #232b37 — screen / list background
  fg: palette.gray[50],            // #f9fafa
  fgMuted: palette.gray[300],      // #d0d4d9
  border: palette.charcoal[600],   // #303a4a

  // Status — same hues (they're already vivid enough)
  statusGreen: status.green,
  statusYellow: status.yellow,
  statusRed: status.red,
  danger: palette.orange[400],
} as const;

// Colors type: same keys as lightColors, values are plain strings (not literals)
// so both lightColors and darkColors satisfy it regardless of their hex literals.
export type Colors = { readonly [K in keyof typeof lightColors]: string };

// ─── Static fallback (light) — kept for non-component callers (e.g. SECTION_META
// in index.tsx which runs at module scope). Components should use useColors().
export const colors: Colors = lightColors;

// ─── Hook — the right way to consume colors in components ────────────────────
/**
 * Returns the resolved color set for the current system appearance.
 * Call once at the top of each component; memoised by React per color-scheme.
 *
 * ```tsx
 * const colors = useColors();
 * const styles = useMemo(() => makeStyles(colors), [colors]);
 * ```
 */
export function useColors(): Colors {
  const scheme = useColorScheme();
  return scheme === "dark" ? darkColors : lightColors;
}

// Hanken Grotesk weights (from @expo-google-fonts/hanken-grotesk). The family
// strings match what `useFonts` registers in app/_layout.tsx.
export const fonts = {
  regular: "HankenGrotesk_400Regular",
  medium: "HankenGrotesk_500Medium",
  semibold: "HankenGrotesk_600SemiBold",
  bold: "HankenGrotesk_700Bold",
  // Hanken Grotesk ships no italic; synthesize italics via fontStyle. Code uses
  // the platform monospace face.
  mono: Platform.OS === "ios" ? "Menlo" : "monospace",
};

// Domain → color, mirroring the web sky (components/sky/skyVisuals.tsx). Used by
// the star map + concept surfaces so subjects read consistently across web/native.
export function colorForDomain(domain: string | null | undefined): string {
  return domainColor(domain);
}
