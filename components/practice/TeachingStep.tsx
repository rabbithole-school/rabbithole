"use client";

/**
 * Teach-as-action — the "I haven't learned this yet" teaching moment. Instead of
 * a streamed prose explanation (which a young scholar dismisses without reading),
 * the tutor reveals every worked step EXCEPT the final, answer-producing one and
 * asks the scholar to finish that single step: doing the step IS the reading.
 * Gated so the surface only lets them continue once they've ATTEMPTED it — one
 * attempt is enough to unlock "Next" (the scholar is never trapped), though a
 * wrong attempt drops them down the hint ladder rather than ending the moment.
 *
 * Purely instructional: it records nothing. The one blank is graded CLIENT-SIDE
 * with the SAME pure `parseAnswer`/`answersEqual` the server grader uses (so
 * representation like 6/8 ≡ 0.75 still matches), and no mutation is called — the
 * step can never move mastery or placement scoring. Steps + reveal value come
 * from the read-only `api.practiceSkills.teachingStep` query.
 *
 * When the item has no worked steps (a template drill item, a one-step item),
 * the query returns `steps: null` and this degrades to reveal-only: a supportive
 * line + the answer, and `onReady` fires so "Next" never dead-ends.
 *
 * ── THE HINT LADDER ────────────────────────────────────────────────────────
 * "I'm still stuck" always has somewhere to go that isn't the answer:
 *   tier 1  the blank NAMES the move       — "Add the partial quotients: ?"
 *   tier 2  the move, SET UP but not done  — "…: 100 + 30 + 6 = ?"  (`hint`)
 *   tier 3  a person — the Socratic handoff (`onEscalate`), the same companion
 *           two wrong guesses already unlock. Honesty must earn at least what
 *           guessing earns; before this it earned strictly less.
 * An item with no honest tier 2 (`hint: null`) escalates straight to tier 3.
 *
 * A WRONG ANSWER WALKS THE SAME LADDER as "I'm still stuck" — it does not spend
 * the reveal while a rung remains below it. The decision is
 * `nextTeachingMove` in `shared/teachingLadder.ts`, shared with native so the
 * two surfaces cannot drift.
 *
 * The rung reached is reported through `recordTeachingOutcome`, which patches
 * the scholar's existing don't-know row. That's the only thing this component
 * writes, it is best-effort, and it still cannot move mastery — the blank stays
 * client-graded.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, HStack, Text, VStack } from "@chakra-ui/react";
import { Check, Lightbulb } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FadeResult } from "@/convex/lib/practice/fadedSteps";
import { rawAnswersEqual, type AnswerType } from "@/convex/lib/practice/answers";
import { WorkedSteps } from "@/components/practice/WorkedSteps";
import { SpeakableLabel } from "@/components/SpeakableLabel";
import { applyKeyToInputBuffer } from "@/shared/practiceLoop";
import { nextTeachingMove, stillStuckAvailable } from "@/shared/teachingLadder";
import { useFlatAnswerKeyboard } from "@/hooks/useFlatAnswerKeyboard";

/** Grace period before an unresolved query unlocks "Next" on its own — a query
 *  stalling on flaky wifi must never trap the scholar behind a gated Continue. */
const RESOLVE_WATCHDOG_MS = 8_000;

export function TeachingStep({
  scholarId,
  itemId,
  onReady,
  onEscalate,
}: {
  scholarId: Id<"users">;
  itemId: string;
  /** Fired once the scholar may proceed — they attempted the step, OR there's no
   *  step to do (reveal-only) / the query stalled. */
  onReady: () => void;
  /** Tier 3 — hand off to the Socratic companion. Omit to hide the escalation
   *  (the ladder then ends at the tier-2 hint). */
  onEscalate?: () => void;
}) {
  const step = useQuery(api.practiceSkills.teachingStep, { scholarId, itemId });
  const recordOutcome = useMutation(api.practiceSkills.recordTeachingOutcome);
  const [input, setInput] = useState("");
  const inputBuffer = useRef("");
  const [attempt, setAttempt] = useState<{ correct: boolean; input: string } | null>(null);
  const [hintShown, setHintShown] = useState(false);
  const [missedOnce, setMissedOnce] = useState(false);

  // Bookkeeping only — a failure here must never break the teaching moment.
  const report = useCallback(
    (outcome: "solved" | "hint" | "stuck") => {
      void recordOutcome({ scholarId, itemId, outcome }).catch(() => {});
    },
    [recordOutcome, scholarId, itemId],
  );

  // Fire `onReady` at most once — the parent gates a boolean on it, so a stray
  // second call is harmless, but a ref keeps the effects from re-notifying.
  const readyRef = useRef(false);
  const notifyReady = () => {
    if (readyRef.current) return;
    readyRef.current = true;
    onReady();
  };

  // No interactive step (reveal-only) → unlock the moment immediately.
  useEffect(() => {
    if (step && step.steps === null) notifyReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Watchdog: if the query hasn't resolved in time, unlock anyway.
  useEffect(() => {
    if (step !== undefined) return;
    const t = setTimeout(notifyReady, RESOLVE_WATCHDOG_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Grade the one blank against the same pure comparator the server grader uses.
  // Defined before the early returns below so the keyboard hook — which must run
  // unconditionally — can call it; while loading / reveal-only these are inert.
  const answer = step?.steps ? step.answer ?? "" : "";
  const answerType = (step?.answerType ?? "integer") as AnswerType;
  const hint = step?.hint ?? null;
  const onCheck = () => {
    if (attempt) return;
    const submittedInput = inputBuffer.current.trim();
    const correct = rawAnswersEqual(submittedInput, answer, answerType);
    // Either way the scholar has now ATTEMPTED, so Next unlocks — a wrong guess
    // must never trap them, whatever the ladder does next.
    notifyReady();
    const move = nextTeachingMove(correct, { hasHint: !!hint, hintShown });
    report(move.outcome);
    if (move.kind === "hint") {
      setHintShown(true);
      setMissedOnce(true);
      setInput("");
      inputBuffer.current = "";
      return;
    }
    setAttempt({ correct, input: submittedInput });
  };

  // "I'm still stuck" — step DOWN the ladder, never straight to the answer:
  // the tier-2 hint first if there is one, then the companion tutor.
  const onStillStuck = () => {
    if (hint && !hintShown) {
      setHintShown(true);
      return;
    }
    report("stuck");
    notifyReady();
    onEscalate?.();
  };
  const stillStuckAvail = stillStuckAvailable({ hasHint: !!hint, hintShown }, !!onEscalate);

  // The last step is typed on the hardware keyboard — web assumes a laptop, so
  // there's no on-screen number pad (see `useFlatAnswerKeyboard`).
  useFlatAnswerKeyboard({
    enabled: !!step?.steps && !attempt,
    onKey: (key) => setInput(applyKeyToInputBuffer(inputBuffer, key)),
    onEnter: () => {
      if (input.trim()) onCheck();
    },
  });

  if (step === undefined) {
    return (
      <Text fontSize="14px" color="#9aa39a" fontStyle="italic" textAlign="center">
        Setting up one step…
      </Text>
    );
  }

  // Reveal-only degrade: no worked steps for this item.
  if (step.steps === null) {
    return (
      <VStack w="100%" gap={1.5} align="center">
        <Text fontSize="14px" fontWeight="600" color="#3a5563">
          Good to know 👍 Telling us is the smart move.
        </Text>
        {step.answer ? (
          <SpeakableLabel
            text={`The answer is ${step.answer} — now you've seen it.`}
            tapAnywhere
            ariaLabel="Hear the answer"
          >
            <Text fontSize="15px" color="#454b45">
              The answer is {step.answer} — now you&apos;ve seen it.
            </Text>
          </SpeakableLabel>
        ) : null}
      </VStack>
    );
  }

  const steps = step.steps;

  // Once attempted, show the fully-worked scaffold with the last step filled —
  // the scholar's value if they got it, otherwise the correct one.
  const completed: FadeResult = {
    revealed: [...steps.revealed, { text: attempt?.correct ? attempt.input : answer }],
    faded: [],
  };

  return (
    <VStack w="100%" gap={3} align="stretch">
      <Text fontSize="14px" fontWeight="600" color="#3a5563" textAlign="center">
        Good to know 👍 Let&apos;s do the last step together.
      </Text>

      {attempt ? <WorkedSteps steps={completed} speakable /> : <WorkedSteps steps={steps} speakable />}

      {!attempt && missedOnce ? (
        <Text fontSize="14px" color="#8a6d16" fontWeight="600" textAlign="center">
          Not quite — here&apos;s a nudge. Have another go.
        </Text>
      ) : null}

      {!attempt && hintShown && hint ? (
        <SpeakableLabel text={hint} tapAnywhere ariaLabel="Hear the hint">
          <HStack
            gap={2}
            align="flex-start"
            bg="#fdf6e3"
            borderWidth="1px"
            borderColor="#e8d9a8"
            borderRadius="10px"
            px={3}
            py={2.5}
          >
            <Box color="#8a6d16" mt="2px" flexShrink={0}>
              <Lightbulb weight="fill" />
            </Box>
            <Text fontSize="15px" color="#5b4a12" fontWeight="600">
              {hint}
            </Text>
          </HStack>
        </SpeakableLabel>
      ) : null}

      {attempt ? (
        attempt.correct ? (
          <HStack gap={1.5} color="#146c43" justify="center">
            <Check weight="bold" />
            <Text fontWeight="700" fontSize="14px">Nice — that&apos;s the step!</Text>
          </HStack>
        ) : (
          <SpeakableLabel
            text={`Not quite — the answer is ${answer} — now you've seen it.`}
            tapAnywhere
            ariaLabel="Hear the answer"
          >
            <Text fontSize="14px" color="#8a6d16" textAlign="center">
              Not quite — the answer is {answer} — now you&apos;ve seen it.
            </Text>
          </SpeakableLabel>
        )
      ) : (
        <>
          <Box
            w="100%"
            borderWidth="2px"
            borderStyle="solid"
            borderColor="#16707e"
            borderRadius="12px"
            bg="#f3fbfc"
            px={4}
            py={3}
            textAlign="center"
            fontSize="26px"
            fontWeight="700"
            color="#143"
            minH="56px"
            userSelect="none"
            style={{ WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
          >
            {input || <Text as="span" color="#9bbcc2">type the last step</Text>}
          </Box>
          <Button colorPalette="teal" size="lg" w="100%" onClick={onCheck} disabled={!input.trim()}>
            Check this step
          </Button>
          {stillStuckAvail ? (
            <Button
              variant="plain"
              size="sm"
              alignSelf="center"
              color="#6b7a70"
              fontWeight="600"
              textDecoration="underline"
              onClick={onStillStuck}
            >
              I&apos;m still stuck
            </Button>
          ) : null}
        </>
      )}
    </VStack>
  );
}
