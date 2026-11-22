import { createContext, createElement, useContext, type ReactNode } from "react";
import { useColorScheme } from "react-native";

/**
 * Every color and font the keypad and editor draw with. In Rabbithole these
 * were the app's theme tokens (`useColors()` / `fonts` from `@/theme`); here
 * they are a small, explicit contract with light and dark defaults taken from
 * the same palette, so the package looks finished out of the box.
 */
export type MathKeypadTheme = {
  colors: {
    /** Key face. */
    keyBackground: string;
    /** Key outline. */
    keyBorder: string;
    /** Key face while pressed. */
    keyPressed: string;
    /** Key label text. */
    keyText: string;
    /** Editor glyphs, fraction bars, radical strokes, glyph-key drawings. */
    ink: string;
    /** The caret and the focused box's border. The ONLY "you can type here"
     *  color: nothing else on the surface should use it. */
    accent: string;
    /** The focused box's fill. */
    accentSubtle: string;
    /** An unfocused box's outline (dashed while empty). */
    emptyBox: string;
    /** An invalid root index (e.g. `1`). */
    danger: string;
    /** The hardware-keyboard hint line. */
    hint: string;
    /** The 2-D editor's passive outer border. */
    fieldBorder: string;
  };
  fonts: {
    /** Key labels. Undefined = system font at weight 600. */
    key?: string;
    /** Editor digits. Undefined = system font at weight 500. If you set a
     *  custom face, check `EXPR_DIGIT_ADVANCE_EM` (see boxMetrics.ts). */
    editor?: string;
    /** Algebra-mode variables (`x`, `y`, `i`). A custom `editor` face needs
     *  its real italic face named here: iOS draws a custom family upright for
     *  `fontStyle: "italic"`. Undefined = `editor` with `fontStyle: "italic"`. */
    editorItalic?: string;
    /** Hint line. Undefined = system font. */
    hint?: string;
  };
};

export const lightTheme: MathKeypadTheme = {
  colors: {
    keyBackground: "#f9fafa",
    keyBorder: "#e6e8ea",
    keyPressed: "#e6e8ea",
    keyText: "#364153",
    ink: "#364153",
    accent: "#2ECCDF",
    accentSubtle: "#f0fbfc",
    emptyBox: "#a3aab3",
    danger: "#8a561c",
    hint: "#6d7584",
    fieldBorder: "#e6e8ea",
  },
  fonts: {},
};

export const darkTheme: MathKeypadTheme = {
  colors: {
    keyBackground: "#232b37",
    keyBorder: "#303a4a",
    keyPressed: "#303a4a",
    keyText: "#f9fafa",
    ink: "#f0f1f3",
    accent: "#68dce9",
    accentSubtle: "#0f3536",
    emptyBox: "#a3aab3",
    danger: "#ffbe6b",
    hint: "#a3aab3",
    fieldBorder: "#303a4a",
  },
  fonts: {},
};

export type MathKeypadThemeOverride = {
  colors?: Partial<MathKeypadTheme["colors"]>;
  fonts?: Partial<MathKeypadTheme["fonts"]>;
};

const ThemeContext = createContext<MathKeypadTheme | null>(null);

/** Optional: give every keypad component below it one theme. Without a
 *  provider, components follow the system color scheme. */
export function MathKeypadThemeProvider({
  theme,
  children,
}: {
  theme: MathKeypadTheme;
  children?: ReactNode;
}) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function mergeTheme(
  base: MathKeypadTheme,
  override?: MathKeypadThemeOverride,
): MathKeypadTheme {
  if (!override) return base;
  return {
    colors: { ...base.colors, ...override.colors },
    fonts: { ...base.fonts, ...override.fonts },
  };
}

/** The theme a component should draw with: provider → system scheme, then a
 *  per-component override on top. */
export function useMathKeypadTheme(override?: MathKeypadThemeOverride): MathKeypadTheme {
  const provided = useContext(ThemeContext);
  const scheme = useColorScheme();
  const base = provided ?? (scheme === "dark" ? darkTheme : lightTheme);
  return mergeTheme(base, override);
}
