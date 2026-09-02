import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Whether the math is laid out inline with running text (`text`, tighter) or as
 * a centered display block (`display`, looser, larger operators). Maps to
 * SwiftUIMath's `.mathTypesettingStyle(.text/.display)`.
 */
export type MathTypesettingStyle = 'text' | 'display';

export type MathViewProps = {
  /**
   * A constrained-LaTeX string (the SAME interchange format the web KaTeX
   * renderer and the cross-platform lite renderer consume). Produced by the
   * generator helpers in `shared/mathLatex.ts` (`fracLatex`, `mixedLatex`, …).
   * Example: `9\\frac{4}{9}\\quad \\frac{\\square}{9}`.
   */
  latex: string;
  /** Base point size for the rendered math. Defaults to 28. */
  fontSize?: number;
  /** Hex color for the glyphs, e.g. "#2B2B2B". Defaults to the label color. */
  color?: string;
  /** Inline (`text`) vs centered block (`display`). Defaults to `text`. */
  typesettingStyle?: MathTypesettingStyle;
  style?: StyleProp<ViewStyle>;
};
