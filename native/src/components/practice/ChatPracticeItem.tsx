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
  UNIT_WRONG_NUDGE,
} from "@/lib/practicePad";
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
  item,
}: {
  scholarId: Id<"users">;
  item: ChatPracticePayload;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const submitAnswer = useMutation(api.practiceSkills.submitAnswer);
  const [value, setValue] = useState("");
  const [manipulativeState, setManipulativeState] = useState<unknown>(null);
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "correct" | "miss">("idle");
  const [error, setError] = useState<string | null>(null);
  // The unit half of the last attempt: "gate" is our own pre-submit refusal (no
  // attempt spent), the other two are the server's verdict. Cleared on the next
  // input change.
  const [unitNote, setUnitNote] = useState<"gate" | "missing" | "wrong" | null>(null);
  const itemRenderAtRef = useRef(0);
  const firstKeyAtRef = useRef<number | null>(null);
  const clientEventIdRef = useRef<{ answer: string; id: string } | null>(null);
  const spec = useMemo(
    () => (item.kind === "manipulative" ? parseSpec(item.manipulativeSpec) : null),
    [item],
  );

  useEffect(() => {
    itemRenderAtRef.current = Date.now();
    firstKeyAtRef.current = null;
  }, [item.itemId]);

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
        const result = await submitAnswer({
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
        });
        clientEventIdRef.current = null;
        setAttempts((count) => count + 1);
        setStatus(result.correct ? "correct" : "miss");
        setUnitNote(result.unitOutcome ?? null);
        if (!result.correct) setValue("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't check that — try again.");
      } finally {
        setBusy(false);
      }
    },
    [attempts, busy, item.itemId, scholarId, status, submitAnswer],
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
    setUnitNote(null);
    setValue(next);
  }, []);
  const onPadKey = useCallback((key: string) => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setUnitNote(null);
    setValue((previous) => applyKey(previous, key));
  }, []);
  // A tapped unit key REPLACES any trailing unit, so cm² → cm³ is one tap.
  const onPickUnit = useCallback((unit: string) => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setUnitNote(null);
    setValue((prev) => applyUnitKey(prev, unit));
  }, []);
  const submitTyped = useCallback(() => {
    // Nudge instead of spending the attempt on a formatting slip. Any trailing
    // unit token passes — a WRONG unit is the grader's call, not ours.
    if (answerUnit && value.trim() && !hasUnitToken(value.trim())) {
      setUnitNote("gate");
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
  const templatePadType =
    item.kind === "typed" &&
    item.answerShape === "twoD" &&
    (item.answerType === "fraction" || item.answerType === "expression")
      ? item.answerType
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
                answerShape="twoD"
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
          {/* A unit slip names itself and REPLACES the generic miss line: the
              value was right, so "take another look" would send the scholar
              back over correct work. */}
          {unitNote || status === "miss" ? (
            <Text style={styles.miss}>
              {unitNote === "wrong"
                ? UNIT_WRONG_NUDGE
                : unitNote
                  ? UNIT_MISSING_NUDGE
                  : "Not quite — take another look and try again."}
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
