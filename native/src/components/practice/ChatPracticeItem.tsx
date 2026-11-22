import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation } from "convex/react";

import { NativeManipulative } from "@/components/manipulatives/NativeManipulative";
import { PracticePadAnswer } from "@/components/practice/NativePracticeControls";
import { PromptVisual } from "@/components/practice/PromptVisual";
import { StemText } from "@/components/practice/StemText";
import { api, type Doc, type Id } from "@/lib/convex";
import {
  applyKey,
  applyUnitKey,
  unitKeyFamily,
  UNIT_MISSING_NUDGE,
  nearMissNudge,
  type PadAnswerType,
} from "@/lib/practicePad";
import {
  formNudgeOf,
  isAnswerPalette,
  usesAlgebraEditor,
} from "../../../vendor/shared/practiceAnswerForm";
import { fonts, type Colors, useColors } from "@/theme";
import { hasUnitToken } from "../../../vendor/practice/answers";
import type { ManipulativeSpec } from "../../../vendor/manipulative/types";
import { computeTiming, makeClientEventId } from "../../../vendor/shared/practiceLoop";
import { AppTextInput } from "@/components/AppTextInput";

export type ChatPracticePayload = NonNullable<
  Doc<"messages">["chatPractice"]
>;

function parseSpec(json: string): ManipulativeSpec | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { kind?: unknown }).kind === "string"
      ? (parsed as ManipulativeSpec)
      : null;
  } catch {
    return null;
  }
}

/** Native parity renderer for the full problems-in-chat item union. */
export function ChatPracticeItem({
  scholarId,
  sessionId,
  item,
}: {
  scholarId: Id<"users">;
  /** The durable session the item was served in — routes a storyThread item to
   *  its feedback-only grader. Always present: the item is only ever rendered
   *  inside a session transcript. */
  sessionId: Id<"sessions">;
  item: ChatPracticePayload;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const submitAnswer = useMutation(api.practiceSkills.submitAnswer);
  const submitStory = useMutation(
    api.practiceSkills.submitStoryThreadApplication,
  );
  const [value, setValue] = useState("");
  const [manipulativeState, setManipulativeState] = useState<unknown>(null);
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "correct" | "miss">("idle");
  const [error, setError] = useState<string | null>(null);
  // The "so close" line for the last attempt: our own pre-submit unit refusal
  // (no attempt spent) or the server's unit/form verdict. Cleared on the next
  // input change.
  const [nearMiss, setNearMiss] = useState<string | null>(null);
  const itemRenderAtRef = useRef(0);
  const firstKeyAtRef = useRef<number | null>(null);
  const clientEventIdRef = useRef<{ answer: string; id: string } | null>(null);
  // Form nudges this item has had ("right value, not yet in the form asked").
  const formNudgesUsedRef = useRef(0);
  const spec = useMemo(
    () => (item.kind === "manipulative" ? parseSpec(item.manipulativeSpec) : null),
    [item],
  );

  useEffect(() => {
    itemRenderAtRef.current = Date.now();
    firstKeyAtRef.current = null;
  }, [item.itemId]);

  // A manipulative's first touch starts the same clock a keystroke does (TRA-221).
  const onManipulativeTouchStart = useCallback(() => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
  }, []);

  const submit = useCallback(
    async (answer: string) => {
      const normalized = answer.trim();
      if (!normalized || busy || status === "correct") return;
      setBusy(true);
      setError(null);
      try {
        const timing = computeTiming({
          firstAttempt: attempts === 0,
          nowMs: Date.now(),
          renderAtMs: itemRenderAtRef.current,
          firstKeyAtMs: firstKeyAtRef.current,
        });
        const result =
          item.mode === "storyThread"
            ? // The one application on a durable story thread grades through the
              // feedback-only path (no mastery, no attempt row); it still
              // returns correct/unitOutcome so the UI behaves identically.
              await submitStory({
                sessionId,
                itemId: item.itemId,
                answer: normalized,
              })
            : await submitAnswer({
                scholarId,
                itemId: item.itemId,
                answer: normalized,
                record: attempts === 0,
                clientEventId:
                  clientEventIdRef.current?.answer === normalized
                    ? clientEventIdRef.current.id
                    : (clientEventIdRef.current = {
                        answer: normalized,
                        id: makeClientEventId("practice-answer"),
                      }).id,
                ...timing,
                formNudgesUsed: formNudgesUsedRef.current,
              });
        clientEventIdRef.current = null;
        // Right value, not yet in the form asked: nothing was recorded. Keep
        // the answer for an edit and say what form is wanted.
        const nudge = formNudgeOf(result);
        if (nudge) {
          formNudgesUsedRef.current += 1;
          setNearMiss(nudge);
          return;
        }
        setAttempts((count) => count + 1);
        setStatus(result.correct ? "correct" : "miss");
        setNearMiss(nearMissNudge(result));
        if (!result.correct) setValue("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't check that — try again.");
      } finally {
        setBusy(false);
      }
    },
    [attempts, busy, item.itemId, item.mode, scholarId, sessionId, status, submitAnswer, submitStory],
  );

  // A unit-bearing item ("…in cubic centimeters") is answered by value AND
  // unit — the server grades both, so a bare number is INCORRECT. Only typed
  // items can carry one; a tapped choice or a manipulative state has nowhere to
  // write it.
  const answerUnit =
    item.kind === "typed" && item.answerType !== "multipleChoice"
      ? item.answerUnit
      : undefined;
  const onChangeValue = useCallback((next: string) => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setNearMiss(null);
    setValue(next);
  }, []);
  const onPadKey = useCallback((key: string) => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setNearMiss(null);
    setValue((previous) => applyKey(previous, key));
  }, []);
  // A tapped unit key REPLACES any trailing unit, so cm² → cm³ is one tap.
  const onPickUnit = useCallback((unit: string) => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setNearMiss(null);
    setValue((prev) => applyUnitKey(prev, unit));
  }, []);
  const submitTyped = useCallback(() => {
    // Nudge instead of spending the attempt on a formatting slip. Any trailing
    // unit token passes — a WRONG unit is the grader's call, not ours.
    if (answerUnit && value.trim() && !hasUnitToken(value.trim())) {
      setNearMiss(UNIT_MISSING_NUDGE);
      return;
    }
    void submit(value);
  }, [answerUnit, submit, value]);
  const submitManipulative = useCallback(() => {
    if (manipulativeState !== null) {
      void submit(JSON.stringify(manipulativeState));
    }
  }, [manipulativeState, submit]);
  const onSolvedChange = useCallback(() => {}, []);
  // A digits-only soft keyboard would make the unit literally untypeable, so a
  // unit item keeps the full keyboard even though its VALUE is numeric.
  const numeric =
    item.kind === "typed" &&
    !answerUnit &&
    (item.answerType === "integer" || item.answerType === "decimal");
  // An algebra item (served with an answer palette, or a set of solutions)
  // is typed on the algebra pad. Read defensively: older payloads lack it.
  const rawPalette = item.kind === "typed" ? (item as { answerPalette?: unknown }).answerPalette : undefined;
  const answerPalette = isAnswerPalette(rawPalette) ? rawPalette : undefined;
  const algebraItem =
    item.kind === "typed" && usesAlgebraEditor({ answerType: item.answerType, answerPalette });
  const templatePadType: PadAnswerType | null =
    item.kind === "typed" &&
    (algebraItem ||
      (item.answerShape === "twoD" &&
        (item.answerType === "fraction" || item.answerType === "expression")))
      ? (item.answerType as PadAnswerType)
      : null;

  return (
    <View
      style={[
        styles.card,
        status === "correct" && styles.cardCorrect,
        status === "miss" && styles.cardMiss,
      ]}
    >
      <Text style={styles.eyebrow}>QUICK PRACTICE · {item.skillLabel.toUpperCase()}</Text>

      {item.kind === "typed" ? (
        <>
          <StemText value={item.stem} fontSize={18} align="left" color={colors.charcoal} />
          {item.promptVisual ? (
            <View style={styles.visual}>
              <PromptVisual spec={item.promptVisual} />
            </View>
          ) : null}
        </>
      ) : spec ? (
        <>
          <Text style={styles.stem}>{spec.prompt}</Text>
          <View
            style={[styles.manipulative, status === "correct" && styles.disabled]}
            pointerEvents={status === "correct" ? "none" : "auto"}
            onTouchStart={onManipulativeTouchStart}
          >
            <NativeManipulative
              spec={spec}
              onSolvedChange={onSolvedChange}
              onStateChange={setManipulativeState}
            />
          </View>
        </>
      ) : (
        <Text style={styles.error}>This practice item could not be loaded.</Text>
      )}

      {status === "correct" ? (
        <Text style={styles.correct}>Nice — you got it. Back to it →</Text>
      ) : (
        <>
          {item.kind === "manipulative" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Check manipulative"
              disabled={busy || manipulativeState === null || !spec}
              onPress={submitManipulative}
              style={({ pressed }) => [
                styles.button,
                (busy || manipulativeState === null || !spec) && styles.buttonDisabled,
                pressed && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.buttonText}>Done</Text>
              )}
            </Pressable>
          ) : item.answerType === "multipleChoice" && (item.choices?.length ?? 0) > 0 ? (
            <View style={styles.choices}>
              {item.choices!.map((choice, index) => (
                <Pressable
                  key={`${index}-${choice}`}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void submit(String(index))}
                  style={({ pressed }) => [
                    styles.choice,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.choiceText}>{choice}</Text>
                </Pressable>
              ))}
            </View>
          ) : templatePadType ? (
            <View style={styles.answerStack}>
              <PracticePadAnswer
                answerType={templatePadType}
                answerShape={algebraItem ? undefined : "twoD"}
                answerPalette={answerPalette}
                value={value}
                enabled={!busy}
                focusKey={`${item.itemId}:${attempts}:answering`}
                placeholderColor={colors.charcoalSubtle}
                styles={styles}
                onChange={onChangeValue}
                onKey={onPadKey}
                onSubmit={submitTyped}
              />
              <Pressable
                accessibilityRole="button"
                disabled={busy || !value.trim()}
                onPress={submitTyped}
                style={({ pressed }) => [
                  styles.button,
                  (busy || !value.trim()) && styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <Text style={styles.buttonText}>Check</Text>
                )}
              </Pressable>
            </View>
          ) : (
            <View style={styles.answerStack}>
              {answerUnit ? (
                // The whole dimension family (cm / cm² / cm³), never just the
                // expected one: picking length vs. area vs. volume is part of
                // the task. A tap replaces any trailing unit token.
                <View style={styles.unitKeys}>
                  {unitKeyFamily(answerUnit).map((unit) => (
                    <Pressable
                      key={unit}
                      accessibilityRole="button"
                      accessibilityLabel={`Add the unit ${unit}`}
                      disabled={busy}
                      onPress={() => onPickUnit(unit)}
                      style={({ pressed }) => [styles.choice, styles.unitKey, pressed && styles.pressed]}
                    >
                      <Text style={styles.choiceText}>{unit}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={styles.answerRow}>
                <AppTextInput
                  accessibilityLabel="Your answer"
                  value={value}
                  onChangeText={onChangeValue}
                  onSubmitEditing={submitTyped}
                  editable={!busy}
                  keyboardType={numeric ? "decimal-pad" : "default"}
                  placeholder="Your answer"
                  placeholderTextColor={colors.charcoalSubtle}
                  style={styles.input}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || !value.trim()}
                  onPress={submitTyped}
                  style={({ pressed }) => [
                    styles.button,
                    (busy || !value.trim()) && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator color={colors.white} />
                  ) : (
                    <Text style={styles.buttonText}>Check</Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}
          {/* A unit or form slip names itself and REPLACES the generic miss line: the
              value was right, so "take another look" would send the scholar
              back over correct work. */}
          {nearMiss || status === "miss" ? (
            <Text style={styles.miss}>
              {nearMiss ?? "Not quite — take another look and try again."}
            </Text>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bg,
      padding: 16,
      gap: 12,
    },
    cardCorrect: { borderColor: c.green },
    cardMiss: { borderColor: c.orange },
    eyebrow: {
      color: c.charcoalMuted,
      fontFamily: fonts.semibold,
      fontSize: 12,
      letterSpacing: 0.7,
    },
    stem: {
      color: c.charcoal,
      fontFamily: fonts.semibold,
      fontSize: 18,
      lineHeight: 25,
    },
    visual: { alignItems: "center" },
    manipulative: { width: "100%", minHeight: 220 },
    disabled: { opacity: 0.65 },
    answerStack: { gap: 10 },
    answerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    unitKeys: { flexDirection: "row", gap: 8 },
    unitKey: { flex: 1, paddingHorizontal: 8 },
    input: {
      flex: 1,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bgSubtle,
      color: c.charcoal,
      fontFamily: fonts.regular,
      fontSize: 17,
      paddingHorizontal: 13,
    },
    button: {
      minWidth: 92,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
      backgroundColor: c.teal,
      paddingHorizontal: 16,
    },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: c.white, fontFamily: fonts.bold, fontSize: 15 },
    primaryBtn: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
      backgroundColor: c.teal,
      paddingHorizontal: 16,
    },
    primaryBtnDisabled: { opacity: 0.45 },
    primaryBtnText: { color: c.white, fontFamily: fonts.bold, fontSize: 15 },
    inputBox: {
      minHeight: 56,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.bgSubtle,
      paddingHorizontal: 13,
      paddingVertical: 10,
    },
    inputText: { color: c.charcoal, fontFamily: fonts.semibold, fontSize: 22 },
    keyboardHint: {
      color: c.charcoalSubtle,
      fontFamily: fonts.regular,
      fontSize: 13,
      textAlign: "center",
      paddingVertical: 4,
    },
    noteMiss: { color: c.orange, fontFamily: fonts.regular, fontSize: 14 },
    padWrap: { gap: 10 },
    padGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: 10,
    },
    padKey: {
      width: "31.5%",
      height: 54,
      borderRadius: 12,
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    padKeyHidden: { opacity: 0, borderWidth: 0, backgroundColor: "transparent" },
    padKeyPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
    padKeyText: { color: c.charcoal, fontFamily: fonts.semibold, fontSize: 21 },
    padWide: {
      height: 48,
      borderRadius: 12,
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    choices: { gap: 8 },
    choice: {
      minHeight: 44,
      justifyContent: "center",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.teal,
      backgroundColor: c.bgSubtle,
      paddingHorizontal: 14,
    },
    choiceText: {
      color: c.charcoal,
      fontFamily: fonts.semibold,
      fontSize: 16,
      textAlign: "center",
    },
    pressed: { opacity: 0.72 },
    correct: { color: c.green, fontFamily: fonts.bold, fontSize: 15 },
    miss: { color: c.orange, fontFamily: fonts.regular, fontSize: 14 },
    error: { color: c.statusRed, fontFamily: fonts.regular, fontSize: 14 },
  });
}
