/**
 * LaunchpadContent (native) — the RN twin of web
 * `components/practice/LaunchpadContent.tsx`. Presentation only: it renders a
 * Launchpad's instructional atoms in authored order and owns no lifecycle.
 *
 * Five atom kinds:
 *  - `story_hook`    — a short real-world framing (why this move exists),
 *  - `micro_explain` — the plain statement of the move,
 *  - `worked_example`— a GENUINE worked example: a named strategy, ordered
 *    steps, and one fully-worked problem WITH its answer. Showing the answer is
 *    deliberate and safe: the example uses its OWN canonical numbers, decoupled
 *    from any served item, so it can never leak a graded answer.
 *  - `try_it`        — the INTERACTIVE twin of `worked_example`: the same steps,
 *    but the final answer is FADED and the scholar types it, graded CLIENT-SIDE
 *    with the SHARED `gradeTryItAtom` (same as web). Records nothing.
 *  - `manipulative`  — an UNGRADED instance of the existing manipulative
 *    primitive, rendered by the SAME `NativeManipulative` stage; its own
 *    `isSolved` self-check drives the "you did it" chip. Never a mastery write.
 *  - `video`         — a clipped, tap-to-play YouTube clip in a locked-down
 *    WebView (`InstructionVideo.native`): caption-first, poster-first, always
 *    attributed, with app-owned fallback for player errors.
 *
 * Parity note (2026-07-04 standing rule): this is held in lockstep with the web
 * renderer on TYPE SCALE and structure, not merely feature existence — the same
 * 15/16px body, the same numbered-step rail, the same "See it work" footer. Math
 * goes through `FractionText` + `superscriptExponents`, so `3/4` and `5^2`
 * render the way they do everywhere else in the app.
 */

import { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { FractionText } from "@/components/FractionText";
import { fonts, useColors, type Colors } from "@/theme";
import { superscriptExponents } from "../../../vendor/shared/mathNotation";
import {
  gradeTryItAtom,
  tryItFade,
  type InstructionAtom,
} from "../../../vendor/practice/instructionEntries";
import type { AnswerType } from "../../../vendor/practice/answers";
import { parseInstructionManipulative } from "../../../vendor/manipulative/types";
import { WorkedSteps, type FadeResult } from "@/components/practice/WorkedSteps";
import {
  isNativeManipulativeKind,
  NativeManipulative,
} from "@/components/manipulatives/NativeManipulative";
import { MultiStepSequenceNative } from "@/components/manipulatives/MultiStepSequence.native";
import { InstructionVideo } from "@/components/practice/InstructionVideo.native";
import { AppTextInput } from "@/components/AppTextInput";

/** Math-bearing text with the app's fraction/exponent treatment. */
function MathText({
  value,
  fontSize = 15,
  color,
}: {
  value: string;
  fontSize?: number;
  color: string;
}) {
  return (
    <FractionText
      value={superscriptExponents(value)}
      inline
      fontSize={fontSize}
      align="left"
      color={color}
    />
  );
}

function StoryHook({ hook, colors }: { hook: string; colors: Colors }) {
  const styles = makeStyles(colors);
  return (
    <View style={styles.hookBox}>
      <Text style={styles.hookText}>{hook}</Text>
    </View>
  );
}

function MicroExplain({ text, colors }: { text: string; colors: Colors }) {
  const styles = makeStyles(colors);
  return <Text style={styles.explainText}>{superscriptExponents(text)}</Text>;
}

/** Copy for the accumulating "Show me the move" reveal — kept byte-identical to
 *  the web twin (`components/practice/LaunchpadContent.tsx`) for parity. */
const WORKED_NEXT_STEP_LABEL = "Show me the next step";
const WORKED_SEE_IT_WORK_LABEL = "See it work";

/**
 * Pure reveal state for the accumulating worked example (F2) — the RN mirror of
 * web `workedExampleReveal`. Step 1 starts visible; each tap appends the next
 * step below the prior ones; the FINAL reveal is the "See it work" answer, so it
 * is not pre-spoiled. No timer, no auto-advance.
 */
function workedExampleReveal(
  stepCount: number,
  revealed: number,
): { visibleStepCount: number; showAnswer: boolean; hasMore: boolean; nextLabel: string } {
  const total = stepCount + 1;
  const clamped = Math.max(1, Math.min(revealed, total));
  const visibleStepCount = Math.min(clamped, stepCount);
  const showAnswer = clamped > stepCount;
  const hasMore = clamped < total;
  const nextLabel = clamped >= stepCount ? WORKED_SEE_IT_WORK_LABEL : WORKED_NEXT_STEP_LABEL;
  return { visibleStepCount, showAnswer, hasMore, nextLabel };
}

function WorkedExample({
  strategyLabel,
  steps,
  examplePrompt,
  exampleAnswer,
  colors,
}: {
  strategyLabel: string;
  steps: string[];
  examplePrompt: string;
  exampleAnswer: string;
  colors: Colors;
}) {
  const styles = makeStyles(colors);
  // Start with only step 1 visible; each tap appends the next step below, and
  // the last tap reveals the "See it work" answer (see `workedExampleReveal`).
  const [revealed, setRevealed] = useState(1);
  const fade = useMemo<FadeResult>(
    () => ({ revealed: steps.map((text) => ({ text })), faded: [] }),
    [steps],
  );
  const { visibleStepCount, showAnswer, hasMore, nextLabel } = workedExampleReveal(
    steps.length,
    revealed,
  );

  return (
    <View style={styles.workedCard}>
      <Text style={styles.strategyLabel}>{strategyLabel.toUpperCase()}</Text>

      {/* Accumulating reveal through the SAME faded-scaffold surface (F2);
          tap-to-hear each step via `speakable`, never auto-played. */}
      <WorkedSteps steps={fade} label="Step by step" speakable revealedCount={visibleStepCount} />

      {showAnswer ? (
        <View style={styles.seeItWork}>
          <Text style={styles.seeItWorkLabel}>SEE IT WORK</Text>
          <MathText value={examplePrompt} fontSize={15} color={colors.fg} />
          <View style={styles.givesRow}>
            <Text style={styles.givesLabel}>gives</Text>
            <MathText value={exampleAnswer} fontSize={18} color={colors.green} />
          </View>
        </View>
      ) : null}

      {hasMore ? (
        <Pressable
          onPress={() => setRevealed((r) => r + 1)}
          style={({ pressed }) => [styles.nextStepButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={nextLabel}
        >
          <Text style={styles.nextStepButtonText}>{nextLabel} ▾</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * `try_it` (native) — interactive twin of `WorkedExample`. Same strategy +
 * steps, but the final, answer-producing step is FADED behind a blank (the
 * shared `tryItFade` → the SAME `WorkedSteps` fade surface the post-miss
 * teaching moment uses), so the answer is never shown verbatim. The scholar
 * types it and it's graded CLIENT-SIDE with the shared `gradeTryItAtom`.
 * Ungraded, records nothing.
 */
function TryItAtom({
  strategyLabel,
  steps,
  examplePrompt,
  exampleAnswer,
  answerType,
  colors,
}: {
  strategyLabel: string;
  steps: string[];
  examplePrompt: string;
  exampleAnswer: string;
  answerType?: AnswerType;
  colors: Colors;
}) {
  const styles = makeStyles(colors);
  const [input, setInput] = useState("");
  const [attempt, setAttempt] = useState<{ correct: boolean; input: string } | null>(null);

  const fade = useMemo(() => tryItFade(steps) as FadeResult, [steps]);
  const completed: FadeResult = {
    revealed: [...fade.revealed, { text: attempt?.correct ? attempt.input : exampleAnswer }],
    faded: [],
  };

  const onCheck = () => {
    if (!input.trim() || attempt) return;
    setAttempt({ correct: gradeTryItAtom(input, { exampleAnswer, answerType }), input: input.trim() });
  };

  return (
    <View style={styles.workedCard}>
      <Text style={styles.strategyLabel}>{strategyLabel.toUpperCase()}</Text>
      <MathText value={examplePrompt} fontSize={15} color={colors.fg} />
      <WorkedSteps steps={attempt ? completed : fade} label="Now you try — finish the last step" showWhenOnlyFaded />
      {attempt ? (
        attempt.correct ? (
          <View style={styles.tryRow}>
            <Text style={styles.tryCorrect}>That&apos;s it! </Text>
            <MathText value={exampleAnswer} fontSize={16} color={colors.green} />
          </View>
        ) : (
          <View style={styles.tryRow}>
            <Text style={styles.tryIncorrect}>Not quite — the answer is </Text>
            <MathText value={exampleAnswer} fontSize={15} color={colors.charcoalSubtle} />
          </View>
        )
      ) : (
        <View style={styles.tryRow}>
          <AppTextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={onCheck}
            placeholder="type the last step"
            placeholderTextColor={colors.charcoalSubtle}
            style={styles.tryInput}
            accessibilityLabel="try it answer"
          />
          <Pressable
            onPress={onCheck}
            disabled={!input.trim()}
            style={({ pressed }) => [
              styles.checkButton,
              !input.trim() && styles.checkButtonDisabled,
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Check"
          >
            <Text style={styles.checkButtonText}>Check</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/**
 * `manipulative` (native) — an UNGRADED "try the move" instance. Reuses the
 * SAME `NativeManipulative` stage + the SHARED `parseManipulativeSpec`; the
 * stage's own `isSolved` self-check (via `onSolvedChange`) drives a local "you
 * did it" chip. Nothing is submitted or written.
 *
 * Honest fallback: unlike a SERVED manipulative item (which hands an unsupported
 * kind to the `/embed/manipulative` WebView via its `itemId`), an instructional
 * atom has NO served item id, so no embed handoff is possible here. A kind
 * without a native renderer, or an unparseable spec, therefore shows truthful
 * web-only copy — never a dead "open on web" affordance that does nothing.
 */
function ManipulativeAtom({ spec: specJson, colors }: { spec: string; colors: Colors }) {
  const styles = makeStyles(colors);
  const [solved, setSolved] = useState(false);

  const parsed = parseInstructionManipulative(specJson);

  // A GUIDED sequence — the staged concrete teaching arc. `MultiStepSequenceNative`
  // owns its own per-step stage, verdict and honest web-only fallback, so it is
  // returned whole rather than unwrapped into the single-instance chrome below.
  if (parsed?.mode === "sequence") {
    return (
      <View style={styles.manipCard}>
        <MultiStepSequenceNative spec={parsed.spec} />
      </View>
    );
  }

  const spec = parsed?.spec ?? null;

  if (!spec || !isNativeManipulativeKind(spec.kind)) {
    return (
      <View style={styles.hookBox}>
        <Text style={styles.hookText}>
          This one is web-only for now — try it on the web app; iPad support for this kind is coming.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.manipCard}>
      <Text style={styles.strategyLabel}>{spec.concept.toUpperCase()}</Text>
      <MathText value={spec.prompt} fontSize={15} color={colors.fg} />
      <View style={styles.manipStage}>
        <NativeManipulative spec={spec} onSolvedChange={setSolved} />
      </View>
      {solved ? <Text style={styles.tryCorrect}>You did it! ✓</Text> : null}
    </View>
  );
}

/** Render a Launchpad's atoms in authored order. Unknown kinds are skipped. */
export function LaunchpadAtoms({ atoms }: { atoms: InstructionAtom[] }) {
  const colors = useColors();
  return (
    <View style={{ width: "100%", gap: 14 }}>
      {atoms.map((atom, i) => {
        if (atom.kind === "story_hook") return <StoryHook key={i} hook={atom.hook} colors={colors} />;
        if (atom.kind === "micro_explain") return <MicroExplain key={i} text={atom.text} colors={colors} />;
        if (atom.kind === "worked_example") {
          return (
            <WorkedExample
              key={i}
              strategyLabel={atom.strategyLabel}
              steps={atom.steps}
              examplePrompt={atom.examplePrompt}
              exampleAnswer={atom.exampleAnswer}
              colors={colors}
            />
          );
        }
        if (atom.kind === "try_it") {
          return (
            <TryItAtom
              key={i}
              strategyLabel={atom.strategyLabel}
              steps={atom.steps}
              examplePrompt={atom.examplePrompt}
              exampleAnswer={atom.exampleAnswer}
              answerType={atom.answerType}
              colors={colors}
            />
          );
        }
        if (atom.kind === "manipulative") {
          return <ManipulativeAtom key={i} spec={atom.spec} colors={colors} />;
        }
        if (atom.kind === "video") {
          return <InstructionVideo key={i} atom={atom} />;
        }
        return null;
      })}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    hookBox: {
      backgroundColor: c.bgSubtle,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    hookText: {
      fontFamily: fonts.regular,
      fontSize: 14.5,
      lineHeight: 23,
      color: c.fgMuted,
      fontStyle: "italic",
    },
    explainText: {
      fontFamily: fonts.regular,
      fontSize: 16,
      lineHeight: 26,
      color: c.fg,
    },
    workedCard: {
      width: "100%",
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      padding: 16,
      gap: 14,
    },
    strategyLabel: {
      fontFamily: fonts.bold,
      fontSize: 13,
      letterSpacing: 0.4,
      color: c.green,
    },
    nextStepButton: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: c.teal,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    nextStepButtonText: { fontFamily: fonts.bold, fontSize: 13.5, color: c.teal },
    seeItWork: {
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingTop: 12,
      gap: 6,
    },
    seeItWorkLabel: {
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.6,
      color: c.charcoalSubtle,
    },
    givesRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    givesLabel: {
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.charcoalSubtle,
    },
    tryRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
    tryInput: {
      minWidth: 120,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontFamily: fonts.regular,
      fontSize: 16,
      color: c.fg,
      backgroundColor: c.bg,
    },
    checkButton: {
      backgroundColor: c.teal,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    checkButtonDisabled: { opacity: 0.4 },
    checkButtonText: { fontFamily: fonts.bold, fontSize: 14, color: c.white },
    pressed: { opacity: 0.82 },
    tryCorrect: { fontFamily: fonts.bold, fontSize: 15, color: c.green },
    tryIncorrect: { fontFamily: fonts.regular, fontSize: 14, color: c.charcoalSubtle },
    manipCard: {
      width: "100%",
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      padding: 16,
      gap: 12,
    },
    manipStage: { alignItems: "center", justifyContent: "center", paddingVertical: 6 },
  });
}
