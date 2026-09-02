/**
 * WorkedSteps — the RN analogue of web `components/practice/WorkedSteps.tsx`,
 * rendering the server-computed backward-faded worked-example scaffold
 * (SPIKE — Renkl/Atkinson faded worked examples, run as a COMPLETION problem;
 * see `convex/lib/practice/fadedSteps.ts`'s `FadeResult`).
 *
 * The early revealed steps render as a plain numbered list; the remaining
 * (trailing) faded steps render as quiet blanked placeholder rows for the
 * scholar to finish (even borders on every row — no accent stripe or gradient,
 * per `.claude/rules/visual-design.md`); the completion prompt (when present)
 * sits below the list. Purely a display of what the server already decided — no
 * answer text (the answer-producing final step is always faded), no
 * client-side fade logic, and a faded step's real text never reaches this
 * component (the server never sends it). Renders only when there's at least one
 * revealed step to build on; a fully-bare item is just a plain problem and
 * shows no scaffold card.
 *
 * Mirrors `native/src/app/practice.tsx`'s stem-box treatment (same corner
 * radius, same even border, theme tokens instead of the web spike's raw
 * hex so this respects light/dark mode) and reuses the shared
 * `superscriptExponents` + native `FractionText` so step text with exponents
 * or fractions renders identically to the stem.
 */

import { StyleSheet, Text, View } from "react-native";

import { FractionText } from "@/components/FractionText";
import { SpeakableLabel } from "@/components/SpeakableLabel";
import { fonts, useColors, type Colors } from "@/theme";
import { superscriptExponents } from "../../../vendor/shared/mathNotation";

export type RevealedWorkedStep = { text: string };
export type FadedWorkedStep = { blankText: string };

/** The client-safe fade result — mirrors
 *  `convex/lib/practice/fadedSteps.ts`'s `FadeResult` (kept as a local type,
 *  not an import, since native doesn't reach into `convex/lib/*`; see the
 *  `ServedItem` type at the top of `native/src/app/practice.tsx`). */
export type FadeResult = {
  revealed: RevealedWorkedStep[];
  faded: FadedWorkedStep[];
  selfExplainPrompt?: string;
};

export function WorkedSteps({
  steps,
  // When set (the teach-as-action moment), each REVEALED step is tap-to-hear
  // through the native TTS path — never auto-played. Off elsewhere (the
  // answering scaffold stays silent). Respects ttsEnabled inside SpeakableLabel.
  speakable = false,
  label = "Let’s start it together",
  showWhenOnlyFaded = false,
  acknowledgedRevealedIndexes = [],
  revealedCount,
}: {
  steps: FadeResult;
  speakable?: boolean;
  label?: string;
  showWhenOnlyFaded?: boolean;
  /** Revealed only because the scholar attempted the blank; render muted. */
  acknowledgedRevealedIndexes?: number[];
  /** Caller-controlled accumulating reveal (the Launchpad "Show me the move"
   *  path): show only the first `revealedCount` revealed steps and NO faded
   *  rows, so the caller can append steps one tap at a time. Undefined (every
   *  existing caller) keeps the server-decided fade verbatim. */
  revealedCount?: number;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  // When the caller drives an accumulating reveal, clamp the revealed list and
  // drop the faded blanks (the caller is walking a fully-known example, not a
  // completion problem); otherwise render exactly what the server decided.
  const revealed =
    revealedCount == null ? steps.revealed : steps.revealed.slice(0, revealedCount);
  const faded = revealedCount == null ? steps.faded : [];
  const selfExplainPrompt = steps.selfExplainPrompt;
  if (revealed.length === 0 && !(showWhenOnlyFaded && faded.length > 0)) return null;

  return (
    <View style={styles.card} accessibilityLabel="worked steps" testID="worked steps">
      <Text style={styles.label}>{label}</Text>
      <View style={styles.list}>
        {revealed.map((step, i) => (
          <View key={`revealed-${i}`} style={styles.row}>
            <Text
              style={[
                styles.revealedIndex,
                acknowledgedRevealedIndexes.includes(i) && styles.acknowledgedIndex,
              ]}
            >
              {i + 1}.
            </Text>
            <View style={styles.rowContent}>
              {speakable ? (
                <SpeakableLabel text={step.text} tapAnywhere accessibilityLabel="Hear this step">
                  <FractionText
                    value={superscriptExponents(step.text)}
                    inline
                    fontSize={15}
                    align="left"
                    color={
                      acknowledgedRevealedIndexes.includes(i)
                        ? colors.charcoalSubtle
                        : colors.fg
                    }
                  />
                </SpeakableLabel>
              ) : (
                <FractionText
                  value={superscriptExponents(step.text)}
                  inline
                  fontSize={15}
                  align="left"
                  color={
                    acknowledgedRevealedIndexes.includes(i)
                      ? colors.charcoalSubtle
                      : colors.fg
                  }
                />
              )}
            </View>
          </View>
        ))}
        {faded.map((step, i) => (
          <View key={`faded-${i}`} style={styles.row}>
            <Text style={styles.fadedIndex}>{revealed.length + i + 1}.</Text>
            <View style={styles.blankBox}>
              <Text style={styles.blankText}>{step.blankText}</Text>
            </View>
          </View>
        ))}
      </View>
      {selfExplainPrompt ? (
        <Text style={styles.selfExplainText}>{selfExplainPrompt}</Text>
      ) : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      padding: 16,
    },
    label: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.fg,
      marginBottom: 10,
    },
    list: { gap: 8 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    rowContent: { flex: 1 },
    revealedIndex: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.green,
      minWidth: 18,
    },
    acknowledgedIndex: {
      color: c.charcoalSubtle,
    },
    fadedIndex: {
      fontFamily: fonts.bold,
      fontSize: 13.5,
      color: c.charcoalSubtle,
      minWidth: 18,
    },
    blankBox: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    blankText: {
      fontFamily: fonts.regular,
      fontSize: 14,
      fontStyle: "italic",
      color: c.charcoalSubtle,
    },
    selfExplainText: {
      marginTop: 12,
      fontFamily: fonts.regular,
      fontSize: 13.5,
      fontStyle: "italic",
      color: c.fgMuted,
    },
  });
}
