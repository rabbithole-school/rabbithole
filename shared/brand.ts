/**
 * Rabbithole brand primitives — the SINGLE SOURCE OF TRUTH for the color scheme
 * and typography, shared between the web app (Chakra) and the native iPad app
 * (React Native).
 *
 * Framework-agnostic by design: NO React, NO Chakra, NO React Native imports.
 * Just plain values, so both platforms can derive their own theme objects from
 * the same source and the brand can never drift between them.
 *
 *   web   →  lib/theme.ts          (builds the Chakra `createSystem` tokens)
 *   native →  native/src/theme.ts  (builds the flat RN color/font maps)
 *
 * The signature Rabbithole look the brand cares about lives here: the navy /
 * violet / charcoal palette and the Hanken Grotesk typeface.
 */

export const palette = {
  // Cool gray (neutral surfaces, borders)
  gray: {
    50: "#f9fafa",
    100: "#f0f1f3",
    200: "#e6e8ea",
    300: "#d0d4d9",
    400: "#a6adb7",
    500: "#758090",
    600: "#47556b",
    700: "#263750",
    800: "#16202f",
    900: "#121a26",
  },
  // Primary
  navy: {
    50: "#e8e9f0",
    100: "#c5c7d9",
    200: "#9ea2bf",
    300: "#777ca5",
    400: "#596091",
    500: "#222656", // Base
    600: "#1e224e",
    700: "#1a1d42", // Hover
    800: "#151837",
    900: "#0d0f22",
  },
  // Body text
  charcoal: {
    50: "#f5f6f7",
    100: "#e6e8eb",
    200: "#ccd0d5",
    300: "#a3aab3",
    400: "#6d7584",
    500: "#364153", // Base body text
    600: "#303a4a",
    700: "#2a3340", // Hover
    800: "#232b37",
    900: "#1a2029",
  },
  // Secondary
  yellow: {
    50: "#FFFDF5",
    100: "#FFFBEB",
    200: "#FFF9E6",
    300: "#FFF2B3",
    400: "#FFEC8A",
    500: "#FFE77C", // Base
    600: "#E6CC45",
    700: "#CCB230",
    800: "#B39920",
    900: "#8A7518",
  },
  violet: {
    50: "#faf6fb",
    100: "#ecdbf0",
    200: "#dbbbe3",
    300: "#c694d3",
    400: "#ba7eca",
    500: "#a960bc", // Base
    600: "#8f519f",
    700: "#734180", // Hover
    800: "#61376c",
    900: "#46284e",
  },
  cyan: {
    50: "#f0fbfc",
    100: "#ddf6f9",
    200: "#c9f2f7",
    300: "#a3e9f0",
    400: "#68dce9",
    500: "#2ECCDF", // Base
    600: "#29b8c9",
    700: "#24a3b3",
    800: "#1d828f",
    900: "#16626c",
  },
  // Tertiary
  green: {
    50: "#f0fdf8",
    100: "#dcfaed",
    200: "#ccf7e8",
    300: "#99efd0",
    400: "#4de5b0",
    500: "#00DD91", // Base
    600: "#00c882",
    700: "#00b574",
    800: "#008f5c",
    900: "#006a45",
  },
  orange: {
    50: "#fff9f3",
    100: "#fff2e6",
    200: "#ffe8cc",
    300: "#ffd7a3",
    400: "#ffbe6b",
    500: "#FFA639", // Base (accent)
    600: "#e69533",
    700: "#d98a2e",
    800: "#b36f24",
    900: "#8a561c",
  },
  darkCyan: {
    50: "#f0f7f7",
    100: "#d9ebec",
    200: "#b3d7d8",
    300: "#80bec0",
    400: "#4d9a9d",
    500: "#1F6F73", // Base
    600: "#1c6467",
    700: "#195a5d",
    800: "#144749",
    900: "#0f3536",
  },
  white: "#ffffff",
  black: "#000000",
} as const;

export const status = {
  green: "#00DD91",
  yellow: "#FFE77C",
  red: "#EF4444",
} as const;

/** The Rabbithole typeface (used for heading + body). */
export const fontFamilyName = "Hanken Grotesk";

/** Shared radius scale (rem on web, px*16 on native). */
export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  "2xl": 24,
  full: 9999,
} as const;

/** Shared type scale, in px. */
export const fontSizePx = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 48,
} as const;

export type ColorScale = keyof typeof palette;
