"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Box, Flex, Text, Input, Button, VStack } from "@chakra-ui/react";
import { StemText } from "@/components/practice/StemText";
import { ExpressionEditor } from "@/components/practice/ExpressionEditor";
import { ExpressionKeypad } from "@/components/practice/ExpressionKeypad";
import { PromptVisual } from "@/components/practice/PromptVisual";
import { ManipulativeStage } from "@/components/manipulative/Manipulative";
import { CheckCircle, ArrowClockwise } from "@phosphor-icons/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import type { ManipulativeSpec } from "@/lib/manipulative/types";
import { haptic } from "@/lib/native";
import { superscriptExponents } from "@/shared/mathNotation";
import { computeTiming } from "@/shared/practiceLoop";
import { hasUnitToken } from "@/convex/lib/practice/answers";
import { UNIT_MISSING_NUDGE, unitOutcomeNudge } from "@/components/practice/unitAnswerCopy";
import { useExpressionTemplate } from "@/hooks/useExpressionTemplate";
import { useExpressionTemplateKeyboard } from "@/hooks/useExpressionTemplateKeyboard";

export type ChatPracticePayload = NonNullable<
  Doc<"messages">["chatPractice"]
>;

function parseManipulativeSpec(json: string): ManipulativeSpec | null {
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

/**
 * Inline practice uses the same item union and submitAnswer grading path as the
 * standalone surface. The first attempt records; retries grade with record:false.
 */
export function ChatPracticeItem({
  scholarId,
  item,
  interactive = true,
}: {
  scholarId: Id<"users">;
  item: ChatPracticePayload;
  /** False in read-only contexts (e.g. a teacher reading the transcript). */
  interactive?: boolean;
}) {
  const submit = useMutation(api.practiceSkills.submitAnswer);
  const [value, setValue] = useState("");
  const [manipulativeState, setManipulativeState] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "correct" | "miss">("idle");
  const [attempts, setAttempts] = useState(0);
  // Two different lifetimes: the pre-submit gate clears on the next edit; the
  // graded unit verdict persists with `status`, like any other miss line.
  const [unitGateNudge, setUnitGateNudge] = useState(false);
  const [unitOutcome, setUnitOutcome] = useState<"missing" | "wrong" | undefined>();
  const itemRenderAtRef = useRef(0);
  const firstKeyAtRef = useRef<number | null>(null);

  useEffect(() => {
    itemRenderAtRef.current = Date.now();
    firstKeyAtRef.current = null;
  }, [item.itemId]);

  const spec = useMemo(
    () =>
      item.kind === "manipulative"
        ? parseManipulativeSpec(item.manipulativeSpec)
        : null,
    [item],
  );
  // A unit-bearing item's answer is "112 cm³" — a decimal soft keyboard has no
  // letters, so the numeric inputMode is dropped for exactly those items.
  // Typed items only — a tapped choice submits an index, which has no unit.
  const answerUnit =
    item.kind === "typed" && item.answerType !== "multipleChoice"
      ? item.answerUnit
      : undefined;
  const numeric =
    item.kind === "typed" &&
    !answerUnit &&
    (item.answerType === "integer" || item.answerType === "decimal");
  const usesTemplateEditor =
    item.kind === "typed" &&
    item.answerShape === "twoD" &&
    (item.answerType === "fraction" || item.answerType === "expression");
  const onTypedChange = useCallback((next: string) => {
    if (firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
    setUnitGateNudge(false);
    setValue(next);
  }, []);
  const onTemplateSubmissionChange = useCallback((next: string) => {
    setUnitGateNudge(false);
    setValue(next);
  }, []);
  const onTemplateKeyDispatched = useCallback((isNav: boolean) => {
    if (!isNav && firstKeyAtRef.current === null) firstKeyAtRef.current = Date.now();
  }, []);
  const { templateState, onTemplateKey, onSetCaret, onInsertFraction, onInsertPower, onInsertSquareRoot, onInsertRoot } =
    useExpressionTemplate({
      enabled: usesTemplateEditor && interactive && status !== "correct",
      itemKey: `${item.itemId}:${attempts}`,
      seedSkeleton: null,
      onSubmissionChange: onTemplateSubmissionChange,
      onKeyDispatched: onTemplateKeyDispatched,
    });

  const onSubmit = useCallback(
    async (answer: string) => {
      if (busy || status === "correct") return;
      const normalized = answer.trim();
      if (!normalized) return;
      // A unit-bearing item wants "112 cm³"; a bare number now grades incorrect,
      // so hold it here rather than spending the kid's attempt on a fixable slip.
      // Never reached by a tapped choice or a manipulative (neither has a unit).
      if (answerUnit && !hasUnitToken(normalized)) {
        setUnitGateNudge(true);
        return;
      }
      setBusy(true);
      try {
        const timing = computeTiming({
          firstAttempt: attempts === 0,
          nowMs: Date.now(),
          renderAtMs: itemRenderAtRef.current,
          firstKeyAtMs: firstKeyAtRef.current,
        });
        const res = await submit({
          scholarId,
          itemId: item.itemId,
          answer: normalized,
          record: attempts === 0,
          ...timing,
        });
        setAttempts((n) => n + 1);
        setUnitOutcome(res.unitOutcome);
        if (res.correct) {
          setStatus("correct");
          haptic("medium");
        } else {
          setStatus("miss");
          haptic("light");
          setValue("");
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, status, submit, scholarId, item.itemId, attempts, answerUnit],
  );

  const submitTyped = useCallback(() => {
    void onSubmit(value);
  }, [onSubmit, value]);
  useExpressionTemplateKeyboard({
    enabled: usesTemplateEditor && interactive && status !== "correct" && !busy,
    onKey: onTemplateKey,
    onSubmit: submitTyped,
  });
  const submitManipulative = useCallback(() => {
    if (manipulativeState !== null) {
      void onSubmit(JSON.stringify(manipulativeState));
    }
  }, [manipulativeState, onSubmit]);
  const onSolvedChange = useCallback(() => {}, []);

  return (
    <Flex justify="flex-start" py={1}>
      <Box
        maxW={item.kind === "manipulative" ? "640px" : "440px"}
        w="full"
        bg="charcoal.50"
        borderWidth="1px"
        borderColor={
          status === "correct"
            ? "teal.300"
            : status === "miss"
              ? "amber.300"
              : "charcoal.200"
        }
        borderRadius="lg"
        px={4}
        py={3}
      >
        <Text
          fontSize="xs"
          textTransform="uppercase"
          letterSpacing="wide"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
          mb={1}
        >
          Quick practice · {superscriptExponents(item.skillLabel)}
        </Text>

        {item.kind === "typed" ? (
          <Box mb={3}>
            <StemText
              value={superscriptExponents(item.stem)}
              fontSize={17}
              align="left"
              color="charcoal.700"
            />
            {item.promptVisual && (
              <Box mt={3} display="flex" justifyContent="center">
                <PromptVisual spec={item.promptVisual} />
              </Box>
            )}
          </Box>
        ) : spec ? (
          <Box mb={3}>
            <Text fontSize="md" color="charcoal.700" fontWeight="600" mb={3}>
              {spec.prompt}
            </Text>
            <Box
              pointerEvents={interactive && status !== "correct" ? "auto" : "none"}
              opacity={status === "correct" ? 0.65 : 1}
            >
              <ManipulativeStage
                spec={spec}
                onSolvedChange={onSolvedChange}
                onStateChange={setManipulativeState}
              />
            </Box>
          </Box>
        ) : (
          <Text mb={3} color="red.600" fontSize="sm">
            This practice item could not be loaded.
          </Text>
        )}

        {status === "correct" ? (
          <Flex align="center" gap={2} color="teal.600">
            <CheckCircle size={20} weight="fill" />
            <Text fontSize="sm" fontFamily="body" fontWeight="600">
              Nice — you got it. Back to it →
            </Text>
          </Flex>
        ) : (
          <>
            {item.kind === "manipulative" ? (
              <Button
                size="sm"
                onClick={submitManipulative}
                loading={busy}
                disabled={!interactive || manipulativeState === null || !spec}
                colorPalette="teal"
              >
                Done
              </Button>
            ) : item.answerType === "multipleChoice" &&
              (item.choices?.length ?? 0) > 0 ? (
              <VStack gap={2} align="stretch">
                {item.choices!.map((choice, index) => (
                  <Button
                    key={`${index}-${choice}`}
                    size="sm"
                    variant="outline"
                    bg="white"
                    h="auto"
                    minH="40px"
                    py={2}
                    whiteSpace="normal"
                    textAlign="center"
                    onClick={() => void onSubmit(String(index))}
                    loading={busy}
                    disabled={!interactive}
                  >
                    {choice}
                  </Button>
                ))}
              </VStack>
            ) : usesTemplateEditor && templateState ? (
              <VStack gap={3} align="stretch">
                <Box
                  border="2px solid"
                  borderColor="teal.600"
                  borderRadius="md"
                  bg="white"
                  px={3}
                  py={2}
                  minH="52px"
                >
                  <ExpressionEditor
                    state={templateState}
                    onSetCaret={onSetCaret}
                    fontSize={22}
                    interactive={interactive && !busy}
                  />
                </Box>
                <Box pointerEvents={busy ? "none" : "auto"} opacity={busy ? 0.6 : 1}>
                  <ExpressionKeypad
                    onInsertFraction={onInsertFraction}
                    onInsertPower={onInsertPower}
                    onInsertSquareRoot={onInsertSquareRoot}
                    onInsertRoot={onInsertRoot}
                    showRadicals={item.answerType === "expression"}
                    onDelete={() => onTemplateKey("⌫")}
                    onDigit={onTemplateKey}
                    locked={!!templateState.structureLocked}
                    showDigits
                  />
                </Box>
                <Button
                  size="sm"
                  onClick={submitTyped}
                  loading={busy}
                  disabled={!interactive || !value.trim()}
                  colorPalette="teal"
                  alignSelf="flex-end"
                >
                  Check
                </Button>
              </VStack>
            ) : (
              <Flex gap={2} align="center">
                <Input
                  size="sm"
                  value={value}
                  onChange={(e) =>
                    // A unit item's typed caret ("cm^3") reads as the SAME real
                    // superscript the other practice surfaces' tapped unit keys
                    // produce ("cm³") — grading is unaffected either way
                    // (`splitUnitSuffix` recognizes both forms).
                    onTypedChange(
                      answerUnit ? superscriptExponents(e.target.value) : e.target.value,
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitTyped();
                    }
                  }}
                  placeholder="Your answer"
                  inputMode={numeric ? "decimal" : "text"}
                  disabled={!interactive || busy}
                  maxW="160px"
                  bg="white"
                />
                <Button
                  size="sm"
                  onClick={submitTyped}
                  loading={busy}
                  disabled={!interactive || !value.trim()}
                  colorPalette="teal"
                >
                  Check
                </Button>
              </Flex>
            )}
            {/* A unit slip names itself; the value was right, so the generic
                "take another look" would send the kid back over correct work. */}
            {(status === "miss" || unitGateNudge) && (
              <Flex align="center" gap={1.5} mt={2} color="amber.700">
                <ArrowClockwise size={15} weight="bold" />
                <Text fontSize="xs" fontFamily="body">
                  {unitGateNudge
                    ? UNIT_MISSING_NUDGE
                    : (unitOutcomeNudge(unitOutcome) ??
                      "Not quite — take another look and try again.")}
                </Text>
              </Flex>
            )}
          </>
        )}
      </Box>
    </Flex>
  );
}
