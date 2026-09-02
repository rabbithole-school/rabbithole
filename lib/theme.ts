import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

import { palette, status } from "@/shared/brand";

// Convert a flat brand scale ({ 50: "#hex", … }) into the Chakra token shape
// ({ 50: { value: "#hex" } }). The hex values are the SINGLE SOURCE OF TRUTH in
// shared/brand.ts, consumed by both this web Chakra theme and the native theme
// (native/src/theme.ts) so the Rabbithole color scheme can never drift between
// platforms.
const scale = (s: Record<string | number, string>) =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { value: v }]));

const config = defineConfig({
  theme: {
    tokens: {
      colors: {
        gray: scale(palette.gray),
        navy: scale(palette.navy),
        charcoal: scale(palette.charcoal),
        yellow: scale(palette.yellow),
        violet: scale(palette.violet),
        cyan: scale(palette.cyan),
        green: scale(palette.green),
        orange: scale(palette.orange),
        darkCyan: scale(palette.darkCyan),
        status: {
          green: { value: status.green },
          yellow: { value: status.yellow },
          red: { value: status.red },
        },
      },
      fonts: {
        heading: { value: "var(--font-hanken-grotesk), sans-serif" },
        body: { value: "var(--font-hanken-grotesk), sans-serif" },
        mono: { value: "ui-monospace, monospace" },
      },
      fontSizes: {
        xs: { value: "0.75rem" },
        sm: { value: "0.875rem" },
        md: { value: "1rem" },
        lg: { value: "1.125rem" },
        xl: { value: "1.25rem" },
        "2xl": { value: "1.5rem" },
        "3xl": { value: "1.875rem" },
        "4xl": { value: "2.25rem" },
        "5xl": { value: "3rem" },
      },
      radii: {
        none: { value: "0" },
        sm: { value: "0.25rem" },
        md: { value: "0.5rem" },
        lg: { value: "0.75rem" },
        xl: { value: "1rem" },
        "2xl": { value: "1.5rem" },
        full: { value: "9999px" },
      },
    },
    semanticTokens: {
      colors: {
        // Background
        "bg.default": { value: "{colors.white}" },
        "bg.subtle": { value: "{colors.gray.50}" },
        "bg.muted": { value: "{colors.gray.100}" },
        "bg.emphasized": { value: "{colors.navy.500}" },
        // Foreground
        "fg.default": { value: "{colors.charcoal.500}" },
        "fg.muted": { value: "{colors.charcoal.400}" },
        "fg.subtle": { value: "{colors.charcoal.300}" },
        "fg.inverted": { value: "{colors.white}" },
        // Border
        "border.default": { value: "{colors.gray.200}" },
        "border.muted": { value: "{colors.gray.100}" },
        // Brand
        "brand.primary": { value: "{colors.navy.500}" },
        "brand.secondary": { value: "{colors.violet.500}" },
        "brand.accent": { value: "{colors.orange.500}" },
        // colorPalette="violet" support. Chakra ships these semantic tokens for
        // its built-in palette names (cyan, blue, …) but NOT for a custom one
        // like "violet", so without this block `colorPalette="violet"`
        // components (e.g. Progress bars) render their .solid fill as black.
        // Mirrors Chakra's standard per-palette token shape.
        violet: {
          solid: { value: "{colors.violet.600}" },
          contrast: { value: "{colors.white}" },
          fg: { value: "{colors.violet.700}" },
          muted: { value: "{colors.violet.100}" },
          subtle: { value: "{colors.violet.50}" },
          emphasized: { value: "{colors.violet.200}" },
          focusRing: { value: "{colors.violet.500}" },
        },
      },
    },
  },
  globalCss: {
    "*": {
      boxSizing: "border-box",
    },
    html: {
      scrollBehavior: "smooth",
    },
    body: {
      fontFamily: "body",
      color: "fg.default",
      bg: "bg.default",
      lineHeight: "1.6",
    },
    "h1, h2, h3, h4, h5, h6": {
      fontFamily: "heading",
      fontWeight: "600",
    },
  },
});

export const system = createSystem(defaultConfig, config);
