/**
 * LaTeX tutor-prose gallery on iPad — reach it at the `/dev-latex` route
 * (deep-link). Renders sample tutor PROSE containing inline `$...$` / display
 * `$$...$$` math through the production `Markdown` → `MathFlow` → `MathView`
 * path, i.e. natively via SwiftMath (`MTMathUILabel`) in the Fira Math face —
 * no WebView, the SAME constrained-LaTeX strings the web KaTeX renderer
 * consumes. The twin of the web KaTeX prose render, so web ↔ iPad parity is
 * eyeball-checkable.
 *
 * Deliberately Convex-FREE (no useQuery / no auth) so a screenshot always proves
 * the render even if sign-in fails.
 */

import { useMemo } from "react";
import { Stack } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Markdown } from "@/components/Markdown";
import { MathView } from "../../modules/expo-math-view";
import { fonts, useColors } from "@/theme";

// Bare LaTeX strings rendered directly through MathView (full power), the same
// strings the web spike proved in KaTeX.
const RAW: { label: string; latex: string; display?: boolean }[] = [
  { label: "Fraction", latex: "\\frac{3}{4}" },
  { label: "Mixed number", latex: "9\\frac{4}{9}" },
  { label: "Fill-in blank", latex: "\\frac{1}{2} + \\frac{1}{3} = \\square" },
  { label: "Exponent", latex: "10^{3} = 1000" },
  { label: "Negative exponent", latex: "10^{-3}" },
  { label: "Segment / angle / parallel", latex: "\\overline{AB} \\perp \\overline{CD},\\ \\angle ACB" },
  { label: "Ray (stretchy vector)", latex: "\\vec{AB}" },
  { label: "Integral (display)", latex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}", display: true },
  { label: "Sum (display)", latex: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", display: true },
];

// Full production path: Markdown parses the prose, MathFlow splits `$...$`
// segments, MathView renders each natively. Words stay outside the math.
const PROSE: string[] = [
  "Nice! So three-quarters is $\\frac{3}{4}$, and a quarter more makes $\\frac{3}{4} + \\frac{1}{4} = 1$ whole.",
  "Let's line them up: $\\frac{1}{2} + \\frac{1}{3} = \\square$ — what's the common denominator?",
  "A mixed number like $9\\frac{4}{9}$ means 9 wholes and four-ninths more.",
  "You can write it with an exponent: $10^{3} = 1000$, and $2^{n}$ doubles each time.",
  "In the triangle, $\\overline{AB}$ is opposite $\\angle ACB$, and $\\overline{AB} \\parallel \\overline{CD}$.",
  "For the older kids: $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$ and $$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}.$$",
  "You have $5 and you spend $3 on apples — how much is left? (money stays plain text)",
];

// Repro of the reported bug: a multi-paragraph tutor message where ONE paragraph
// carries an inline fraction and the others are plain prose. Before the fix, the
// fraction-bearing paragraph rendered its words at RN's default 14pt while the
// plain paragraphs were 18pt (visibly "downsized"). All paragraphs must now match.
const MIXED =
  "A measure in $\\frac{4}{4}$ time is just a container that holds exactly 4 beats worth of notes.\n\n" +
  "You get to pick which notes fill it up — like choosing whole notes, half notes, quarter notes, or eighth notes — as long as they add up to exactly 4 beats total.\n\n" +
  "So if you had a whole note (4 beats), that alone fills the measure. But you need to mix at least three different kinds of notes to fill it. What note values do you want to try putting together first?";

export default function DevLatex() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <>
      <Stack.Screen options={{ title: "LaTeX (SwiftMath)" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Full-power LaTeX — SwiftMath / Fira Math</Text>
        <Text style={styles.sub}>
          Native MTMathUILabel, no WebView. Same constrained-LaTeX strings the web KaTeX path renders.
        </Text>

        {RAW.map((c) => (
          <View key={c.label} style={styles.card}>
            <Text style={styles.caseLabel}>{c.label}</Text>
            <Text style={styles.mono}>{c.latex}</Text>
            <View style={styles.render}>
              <MathView
                latex={c.latex}
                fontSize={c.display ? 30 : 26}
                color={colors.fg}
                typesettingStyle={c.display ? "display" : "text"}
              />
            </View>
          </View>
        ))}

        <Text style={styles.h2}>Tutor prose (Markdown → MathFlow → MathView)</Text>
        <Text style={styles.sub}>
          The tutor talks math in prose; words flow around native math runs, and money stays literal.
        </Text>

        {PROSE.map((p, i) => (
          <View key={i} style={styles.card}>
            <Markdown content={p} />
          </View>
        ))}

        <Text style={styles.h2}>Size parity — fraction paragraph vs plain paragraphs</Text>
        <Text style={styles.sub}>
          A multi-paragraph message where only the first paragraph has an inline fraction. Every
          paragraph must render at the same body size (the old bug shrank the math paragraph).
        </Text>
        <View style={styles.card}>
          <Markdown content={MIXED} />
        </View>
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
