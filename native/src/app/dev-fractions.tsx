/**
 * Fraction-rendering gallery on iPad — reach it at the `/dev-fractions` route
 * (deep-link). Renders every ASCII edge case the renderer must handle — simple
 * fractions, mixed numbers, long/multi-digit, `?` fill-in blanks in either slot,
 * operators, and a fraction embedded in a stem sentence — through the native
 * `FractionText` renderer (stacked vinculum, no SVG/webview/MathJax). The twin
 * of the web `/dev-fractions` page, so web ↔ iPad parity is eyeball-checkable.
 *
 * Deliberately Convex-FREE (no useQuery / no auth) so a screenshot always proves
 * the bundle even if sign-in fails.
 */

import { useMemo } from "react";
import { Stack } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { FractionText } from "@/components/FractionText";
import { Markdown } from "@/components/Markdown";
import { fonts, useColors } from "@/theme";

const CASES: { label: string; value: string }[] = [
  { label: "Simple fraction", value: "3/4" },
  { label: "Mixed number", value: "9 4/9" },
  { label: "Long / multi-digit", value: "123/456" },
  { label: "Very long denominator", value: "7/100000" },
  { label: "Blank in numerator", value: "?/9" },
  { label: "Blank in denominator", value: "9/?" },
  { label: "Blank in both", value: "?/?" },
  { label: "Mixed + blank (the screenshot)", value: "Write 9 4/9 as ?/9" },
  { label: "Addition", value: "2/8 + 1/8 = ?" },
  { label: "Multiplication", value: "1/2 × 3/4" },
  { label: "Division", value: "1/2 ÷ 3 = ?" },
  { label: "Comparison", value: "2/3 > 1/2" },
  { label: "Mixed × whole", value: "12 3/8" },
  { label: "Fraction in a sentence", value: "How does 2/8 compare to 1/2?" },
  {
    label: "Wrapping stem (punctuation after a fraction must not orphan)",
    value: "Decompose 5/8 as 3/8 + 2/8: shade the first disc to 3/8 and the second disc to 2/8.",
  },
];

// Exercises the Markdown / MathFlow prose path (not raw FractionText): markdown
// is parsed first, then fractions are detected inside text spans. Markup that
// wraps a fraction keeps its styling; a fraction inside inline code stays literal.
const PROSE: { label: string; value: string }[] = [
  { label: "Plain sentence", value: "How does 2/8 compare to 1/2?" },
  { label: "Bold around a fraction", value: "Use **3/4** cup of flour." },
  { label: "Italic around a fraction", value: "About *1/2* of the class." },
  { label: "Fraction in inline code (stays literal)", value: "Type `3/4` exactly." },
  { label: "Blockquote (muted color follows the bar)", value: "> 2/3 of them agreed." },
];

export default function DevFractions() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <>
      <Stack.Screen options={{ title: "Fractions" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Stacked-fraction renderer</Text>
        <Text style={styles.sub}>
          Direct ASCII parser → FractionText. No LaTeX, no SVG, no webview, no MathJax.
        </Text>

        {CASES.map((c) => (
          <View key={c.label} style={styles.card}>
            <Text style={styles.caseLabel}>{c.label}</Text>
            <Text style={styles.mono}>{c.value}</Text>
            <View style={styles.render}>
              <FractionText value={c.value} fontSize={34} align="left" />
            </View>
          </View>
        ))}

        <Text style={styles.h2}>Prose (Markdown)</Text>
        <Text style={styles.sub}>
          The tutor talks math in prose. Markdown parses first, then fractions are
          detected in text spans — markup keeps its styling; code stays literal.
        </Text>

        {PROSE.map((c) => (
          <View key={c.label} style={styles.card}>
            <Text style={styles.caseLabel}>{c.label}</Text>
            <Text style={styles.mono}>{c.value}</Text>
            <View style={styles.render}>
              <Markdown content={c.value} />
            </View>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    content: { padding: 20, gap: 12, paddingBottom: 64 },
    h1: { fontFamily: fonts.bold, fontSize: 22, color: c.fg },
    h2: { fontFamily: fonts.bold, fontSize: 18, color: c.fg, marginTop: 18 },
    sub: { fontFamily: fonts.regular, fontSize: 14, color: c.fgMuted, marginBottom: 6 },
    card: {
      backgroundColor: c.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 8,
    },
    caseLabel: { fontFamily: fonts.semibold, fontSize: 13, color: c.fgMuted },
    mono: { fontFamily: fonts.mono, fontSize: 12, color: c.charcoalSubtle },
    render: { marginTop: 6, minHeight: 56, justifyContent: "center" },
  });
}
