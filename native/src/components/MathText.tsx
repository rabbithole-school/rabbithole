/**
 * MathText — the native (RN) "lite" renderer for the fraction-rendering spike.
 *
 * Takes a constrained-LaTeX string, parses it with the SHARED parser
 * (vendor/shared/mathLatex), and lays it out as a wrapping row of text runs and
 * **stacked fractions** (numerator over a horizontal bar / vinculum over
 * denominator) — the elementary-friendly form. Blanks (`\square` / `?`) render
 * as a rounded fill-in box.
 *
 * Dependency-free: plain View + Text + the brand font (Hanken Grotesk) + theme
 * colors — no SVG, no webview, no MathJax. This is the cross-platform fallback
 * that de-risks the SwiftUI native module (Spike B) and covers Android/Expo Go.
 *
 * Scope note: optimized for BLOCK math — a practice stem or answer, which is a
 * short, mostly-single-expression line rendered centered. Fractions embedded
 * mid-paragraph in the tutor's prose (true inline flow) are the case where the
 * SwiftUI renderer / KaTeX earn their keep; see the spike writeup.
 */

import { useMemo } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";

import { fonts, useColors } from "@/theme";
import { parseMath, latexToSpeech, type MathNode } from "../../vendor/shared/mathLatex";

type Props = {
  /** A constrained-LaTeX string, e.g. "Write 9\\frac{4}{9} as \\frac{\\square}{9}". */
  latex: string;
  /** Base glyph size in points. Numerator/denominator scale down from this. */
  fontSize?: number;
  /** Base text color; defaults to the theme foreground. */
  color?: string;
  /** Horizontal alignment of the whole line. Defaults to center (stem style). */
  align?: "center" | "left";
  /** Spoken label; defaults to a "3 over 4"-style reading of `latex` so
   *  VoiceOver never announces the stacked glyphs as "3 slash 4". */
  accessibilityLabel?: string;
  /** Flow inline within surrounding prose (tutor markdown) instead of as a
   *  standalone line. Inline hugs its content; block stretches to fill its
   *  parent so a long stem wraps. */
  inline?: boolean;
};

// Numerator/denominator sit a step smaller than the base — the standard display
// proportion (keeps a mixed number's whole part visually dominant).
const FRAC_SCALE = 0.82;

export function MathText({ latex, fontSize = 28, color, align = "center", accessibilityLabel, inline = false }: Props) {
  const colors = useColors();
  const resolved = color ?? colors.fg;
  const nodes = useMemo(() => parseMath(latex), [latex]);
  const label = useMemo(() => accessibilityLabel ?? latexToSpeech(latex), [accessibilityLabel, latex]);
  return (
    <View
      style={[styles.row, align === "center" ? styles.center : styles.left, inline ? null : styles.block]}
      accessible
      accessibilityLabel={label}
    >
      <NodeRow nodes={nodes} fontSize={fontSize} color={resolved} borderColor={colors.fg} blankBg={colors.cyanSubtle} blankBorder={colors.cyan} />
    </View>
  );
}

function NodeRow({
  nodes,
  fontSize,
  color,
  borderColor,
  blankBg,
  blankBorder,
}: {
  nodes: MathNode[];
  fontSize: number;
  color: string;
  borderColor: string;
  blankBg: string;
  blankBorder: string;
}) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.type === "text") {
          return (
            <Text key={i} style={[textStyle(fontSize), { color }]}>
              {n.value}
            </Text>
          );
        }
        if (n.type === "blank") {
          return <Blank key={i} fontSize={fontSize} bg={blankBg} border={blankBorder} />;
        }
        return (
          <Frac
            key={i}
            node={n}
            fontSize={fontSize}
            color={color}
            borderColor={borderColor}
            blankBg={blankBg}
            blankBorder={blankBorder}
          />
        );
      })}
    </>
  );
}

function Frac({
  node,
  fontSize,
  color,
  borderColor,
  blankBg,
  blankBorder,
}: {
  node: Extract<MathNode, { type: "frac" }>;
  fontSize: number;
  color: string;
  borderColor: string;
  blankBg: string;
  blankBorder: string;
}) {
  const inner = Math.max(12, Math.round(fontSize * FRAC_SCALE));
  const barThickness = Math.max(1.5, Math.round(fontSize * 0.07));
  return (
    <View style={styles.frac}>
      <View style={styles.fracPart}>
        <NodeRow nodes={node.num} fontSize={inner} color={color} borderColor={borderColor} blankBg={blankBg} blankBorder={blankBorder} />
      </View>
      <View style={[styles.vinculum, { height: barThickness, backgroundColor: borderColor, borderRadius: barThickness / 2 }]} />
      <View style={styles.fracPart}>
        <NodeRow nodes={node.den} fontSize={inner} color={color} borderColor={borderColor} blankBg={blankBg} blankBorder={blankBorder} />
      </View>
    </View>
  );
}

function Blank({ fontSize, bg, border }: { fontSize: number; bg: string; border: string }) {
  const size = Math.round(fontSize * 1.05);
  return (
    <View
      style={[
        styles.blank,
        { minWidth: size, height: size, borderColor: border, backgroundColor: bg, borderRadius: Math.round(fontSize * 0.18) },
      ]}
      accessibilityLabel="blank to fill in"
    />
  );
}

function textStyle(fontSize: number): TextStyle {
  return { fontFamily: fonts.semibold, fontSize, lineHeight: Math.round(fontSize * 1.15) };
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 },
  center: { justifyContent: "center" },
  left: { justifyContent: "flex-start" },
  block: { alignSelf: "stretch" },
  // A stacked fraction: a centered column, num / bar / den. Small horizontal
  // padding so the vinculum slightly overhangs the digits (typographic norm).
  frac: { flexDirection: "column", alignItems: "center", paddingHorizontal: 3, marginHorizontal: 2 },
  fracPart: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  vinculum: { alignSelf: "stretch", marginVertical: 3 },
  blank: {
    borderWidth: 2,
    borderStyle: "dashed",
    marginHorizontal: 2,
  },
});
