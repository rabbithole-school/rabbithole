"use client";

import { useRef, useState } from "react";
import { Box, Button, Text, VStack } from "@chakra-ui/react";
import { rawAnswersEqual } from "@/convex/lib/practice/answers";
import { WorkedSteps } from "@/components/practice/WorkedSteps";
import { useFlatAnswerKeyboard } from "@/hooks/useFlatAnswerKeyboard";
import { applyKeyToInputBuffer } from "@/shared/practiceLoop";
import {
  completedHintLadderText,
  resolveHintLadderAttempt,
  type CompletedHintLadderRung,
  type HintLadderRung,
} from "@/shared/hintLadder";

export function HintLadderSteps({
  completed,
  active,
  onAttempt,
  onComplete,
}: {
  completed: CompletedHintLadderRung[];
  active: Extract<HintLadderRung, { kind: "completion" }> | null;
  onAttempt?: () => void;
  onComplete: (revealedAfterWrong: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const inputBuffer = useRef("");

  const check = () => {
    if (!active) return;
    const result = resolveHintLadderAttempt(
      active,
      inputBuffer.current.trim(),
      rawAnswersEqual,
    );
    onAttempt?.();
    onComplete(result.revealedAfterWrong);
  };

  useFlatAnswerKeyboard({
    enabled: !!active,
    onKey: (key) => setInput(applyKeyToInputBuffer(inputBuffer, key)),
    onEnter: () => {
      if (input.trim()) check();
    },
  });

  if (completed.length === 0 && !active) return null;
  const revealed = completed.map(({ rung }) => ({
    text:
      rung.kind === "completion"
        ? completedHintLadderText(rung)
        : rung.text,
  }));
  const acknowledgedRevealedIndexes = completed.flatMap((entry, index) =>
    entry.revealedAfterWrong ? [index] : [],
  );
  const lastWasRevealed =
    completed[completed.length - 1]?.revealedAfterWrong ?? false;

  return (
    <VStack w="100%" gap={2.5} align="stretch">
      <WorkedSteps
        label="Let’s work through it"
        steps={{
          revealed,
          faded: active ? [{ blankText: active.prompt }] : [],
        }}
        speakable
        showWhenOnlyFaded
        acknowledgedRevealedIndexes={acknowledgedRevealedIndexes}
      />
      {!active && lastWasRevealed ? (
        <Text fontSize="14px" color="#6b675f" fontWeight="600" textAlign="center">
          Not quite — here’s that step. Keep going.
        </Text>
      ) : null}
      {active ? (
        <>
          <Box
            w="100%"
            borderWidth="2px"
            borderColor="#16707e"
            borderRadius="12px"
            bg="#f3fbfc"
            px={4}
            py={3}
            textAlign="center"
            fontSize="24px"
            fontWeight="700"
            color="#143"
            minH="54px"
          >
            {input || (
              <Text as="span" color="#9bbcc2">
                finish this step
              </Text>
            )}
          </Box>
          <Button colorPalette="teal" size="md" onClick={check} disabled={!input.trim()}>
            Check this step
          </Button>
        </>
      ) : null}
    </VStack>
  );
}
