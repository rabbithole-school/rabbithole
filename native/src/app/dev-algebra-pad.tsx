/**
 * Algebra answer pad gallery on iPad — reach it at the `/dev-algebra-pad`
 * route (deep-link `native:///dev-algebra-pad`). Mounts the production
 * `PracticePadAnswer` on the algebra pad for each palette and for a solution
 * set, prints the exact submission string the practice screen would send under
 * each one, and renders a handful of stems with typeset `\( … \)` spans and
 * typeset answers through the production renderers.
 *
 * Deliberately Convex-FREE (no useQuery / no auth), like dev-latex, so a
 * screenshot proves the render even if sign-in fails.
 */

import { useMemo, useState } from "react";
import { Stack } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { PracticePadAnswer, type PracticeControlStyles } from "@/components/practice/NativePracticeControls";
import { StemText } from "@/components/practice/StemText";
import { AnswerMath } from "@/components/practice/AnswerMath";
import { fonts, useColors } from "@/theme";
import type { AnswerPalette } from "../../vendor/shared/practiceAnswerForm";
import { superscriptExponents } from "../../vendor/shared/mathNotation";
import { stemToSpeech } from "../../vendor/shared/practiceStemBlocks";

type Case = {
  id: string;
  label: string;
  answerType: "expression" | "solutionSet";
  palette?: AnswerPalette;
  answerForm?: string;
  stem: string;
};

const CASES: Case[] = [
  {
    id: "algebra",
    label: "Algebra palette — factored form",
    answerType: "expression",
    palette: "algebra",
    answerForm: "factored",
    stem: "Factor \\(x^2 + x - 6\\).",
  },
  {
    id: "complex",
    label: "Complex palette",
    answerType: "expression",
    palette: "complex",
    answerForm: "complexStandard",
    stem: "Simplify \\(\\frac{5 + 10i}{1 + 2i} + (3 - i)^2\\).",
  },
  {
    id: "logs",
    label: "Logs palette",
    answerType: "expression",
    palette: "logs",
    answerForm: "singleLog",
    stem: "Write as one logarithm: \\(\\log_{2} x + \\log_{2} (x + 1)\\).",
  },
  {
    id: "sequence",
    label: "Sequence palette",
    answerType: "expression",
    palette: "sequence",
    stem: "Find the nth term: \\(3, 6, 12, 24, \\ldots\\)",
  },
  {
    id: "set",
    label: "Solution set (algebra palette)",
    answerType: "solutionSet",
    palette: "algebra",
    stem: "Solve \\(x^2 + x - 6 = 0\\). Give every solution.",
  },
  {
    id: "set-complex",
    label: "Solution set (complex palette)",
    answerType: "solutionSet",
    palette: "complex",
    stem: "Solve \\(x^2 - 4x + 13 = 0\\).",
  },
];

const STEMS: string[] = [
  "Simplify \\(\\frac{x^2 - 9}{x^2 - x - 6}\\) and state the restriction.",
  "Evaluate \\(\\log_{2} 8 + \\ln e^{3}\\).",
  "Rewrite \\(x^{2/3}\\) as a radical: \\(\\sqrt[3]{x^2}\\).",
  "Find the sum. \\[\\sum_{k=1}^{10} (2k + 1)\\]",
  "For \\(f(x) = \\begin{cases} x^2 & x < 0 \\\\ 2x + 1 & x \\ge 0 \\end{cases}\\), find f(-3).",
  "A plain stem renders exactly as before: what is 3/4 of 12, and 2^3?",
];

const ANSWERS: string[] = ["(x+3)/(x-2)", "log_2(8)", "x^(2/3)", "2√3", "-1/2", "3±2i", "3,-2", "none", "y = 2x + 1"];

export default function DevAlgebraPad() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [submissions, setSubmissions] = useState<Record<string, string>>({});
  const [nudgeOn, setNudgeOn] = useState(false);

  return (
    <>
      <Stack.Screen options={{ title: "Algebra pad" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Algebra answer pad</Text>
        <Text style={styles.sub}>
          The production answer surface for items with an answer palette or a solution set. Under each pad is the
          exact string the practice screen would submit (empty means Check would stay off).
        </Text>
        <Pressable
          onPress={() => setNudgeOn((v) => !v)}
          style={[styles.toggle, nudgeOn && { borderColor: colors.cyan, backgroundColor: colors.cyanSubtle }]}
          accessibilityRole="button"
          accessibilityLabel="Toggle the form nudge preview"
        >
          <Text style={styles.toggleText}>{nudgeOn ? "Hide" : "Show"} the form nudge line</Text>
        </Pressable>

        {CASES.map((c) => (
          <View key={c.id} style={styles.card}>
            <Text style={styles.caseLabel}>{c.label}</Text>
            <View style={styles.stemBox}>
              <StemText value={superscriptExponents(c.stem)} fontSize={24} align="center" />
            </View>
            <PracticePadAnswer
              answerType={c.answerType}
              answerPalette={c.palette}
              answerForm={c.answerForm}
              formNudge={nudgeOn ? "That's equal to the answer. Now write it in factored form." : null}
              value={submissions[c.id] ?? ""}
              enabled
              focusKey={`dev-${c.id}:answering`}
              placeholderColor={colors.charcoalSubtle}
              styles={styles}
              onChange={(v) => setSubmissions((prev) => (prev[c.id] === v ? prev : { ...prev, [c.id]: v }))}
              onKey={() => {}}
              onSubmit={() => {}}
            />
            <Text style={styles.mono} accessibilityLabel={`submission for ${c.id}`}>
              submission: {JSON.stringify(submissions[c.id] ?? "")}
            </Text>
          </View>
        ))}

        <Text style={styles.h2}>Typeset stems (StemText → FractionText → MathView)</Text>
        {STEMS.map((stem, i) => (
          <View key={i} style={styles.card}>
            <StemText value={superscriptExponents(stem)} fontSize={24} align="center" />
            <Text style={styles.mono}>read aloud: {stemToSpeech(stem)}</Text>
          </View>
        ))}

        <Text style={styles.h2}>Typeset answers (reveals and choices)</Text>
        <View style={[styles.card, styles.answers]}>
          {ANSWERS.map((a) => (
            <View key={a} style={styles.answerCell}>
              <Text style={styles.mono}>{a}</Text>
              <AnswerMath value={a} fontSize={22} />
            </View>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

/** The practice screen's own keypad + field styles, restated for a
 *  Convex-free page (values from app/practice.tsx and lib/practiceShell). */
function makeStyles(c: ReturnType<typeof useColors>) {
  const pad = StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    content: { padding: 20, gap: 14, paddingBottom: 96, maxWidth: 620, width: "100%", alignSelf: "center" },
    h1: { fontFamily: fonts.bold, fontSize: 22, color: c.fg },
    h2: { fontFamily: fonts.bold, fontSize: 18, color: c.fg, marginTop: 18 },
    sub: { fontFamily: fonts.regular, fontSize: 14, color: c.fgMuted },
    card: {
      backgroundColor: c.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 12,
    },
    stemBox: { paddingVertical: 8 },
    caseLabel: { fontFamily: fonts.semibold, fontSize: 13, color: c.fgMuted },
    mono: { fontFamily: fonts.mono, fontSize: 12, color: c.charcoalSubtle },
    toggle: {
      alignSelf: "flex-start",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    toggleText: { fontFamily: fonts.semibold, fontSize: 14, color: c.fg },
    answers: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
    answerCell: { alignItems: "center", gap: 4, minWidth: 120 },
    inputBox: {
      minHeight: 56,
      borderWidth: 2,
      borderColor: c.cyan,
      borderRadius: 12,
      backgroundColor: c.cyanSubtle,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    inputText: { fontFamily: fonts.bold, fontSize: 26, color: c.fg },
    keyboardHint: {
      color: c.charcoalSubtle,
      fontFamily: fonts.regular,
      fontSize: 14,
      textAlign: "center",
      paddingVertical: 4,
    },
    noteMiss: { fontFamily: fonts.regular, fontSize: 14, color: c.orange, textAlign: "center" },
    padWrap: { gap: 10 },
    padGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
    padKey: {
      width: "31.5%",
      height: 58,
      borderRadius: 12,
      backgroundColor: c.gray50,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    padKeyHidden: { opacity: 0, borderWidth: 0, backgroundColor: "transparent" },
    padKeyPressed: { backgroundColor: c.gray200, transform: [{ scale: 0.96 }] },
    padKeyText: { fontFamily: fonts.semibold, fontSize: 22, color: c.fg },
    padWide: {
      height: 50,
      borderRadius: 12,
      backgroundColor: c.gray50,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtn: { height: 52, borderRadius: 12, backgroundColor: c.cyan, alignItems: "center", justifyContent: "center" },
    primaryBtnDisabled: { opacity: 0.5 },
    primaryBtnText: { fontFamily: fonts.bold, fontSize: 17, color: c.white },
  });
  return pad as typeof pad & PracticeControlStyles;
}
