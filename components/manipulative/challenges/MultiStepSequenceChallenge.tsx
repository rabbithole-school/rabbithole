"use client";

/**
 * The ONE generic renderer for Model A (see `MultiStepSequenceSpec` in
 * `lib/manipulative/types.ts`): a data-authored, ordered playlist of linked
 * `ManipulativeSpec` steps — state does NOT carry across steps, each is
 * independently graded, and advancing just moves to the next spec. Hosted in
 * the SAME standard `MultiStepChallenge` frame Model B (a game, e.g. the
 * Factor Game) uses — same commit → feedback → advance rhythm, "Step X of Y"
 * dots instead of an open-ended move counter, and each step's "Done" reveals
 * its own correct/incorrect (mirroring `Manipulative.tsx`'s own verdict chip).
 *
 * Nothing here is specific to any one sequence — a curriculum author supplies
 * `steps` as plain data (see `TWO_STEP_DEMO_SEQUENCE` in `library.ts`) and
 * this component renders it generically. The step-advance/progress math
 * itself is pure and lives in `logic.ts` (`currentSequenceStep`,
 * `isSequenceComplete`, `advanceSequence`, `sequenceProgress`) so it's
 * unit-tested without a DOM — this component is just the thin React wiring.
 */
import { useCallback, useState } from "react";
import { Box, Text } from "@chakra-ui/react";
import { isChallenge, type MultiStepSequenceSpec } from "@/lib/manipulative/types";
import {
  advanceSequence,
  currentSequenceStep,
  isSequenceComplete,
  isSolved,
  sequenceProgress,
} from "@/lib/manipulative/logic";
import { ManipulativeStage } from "../Manipulative";
import { MultiStepChallenge } from "../MultiStepChallenge";
import { C } from "../colors";

export function MultiStepSequenceChallenge({ spec }: { spec: MultiStepSequenceSpec }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [liveSolved, setLiveSolved] = useState(false);
  const [verdict, setVerdict] = useState<"idle" | "correct" | "incorrect">("idle");
  const [state, setState] = useState<unknown>(null);
  const [resetKey, setResetKey] = useState(0);

  const step = currentSequenceStep(spec, stepIndex);
  const complete = isSequenceComplete(spec, stepIndex);
  const progress = sequenceProgress(spec, stepIndex);

  // An EXPLORE step (no goal / no answer — `isChallenge` false) has nothing to
  // check: every `*Solved` predicate returns false without a goal, so gating
  // "Next" on a correct verdict would strand the scholar on it forever. Free
  // play can't be failed, so such a step offers Next directly instead of Done.
  // This is what lets a guided teaching sequence open with a concrete
  // familiarisation rung ("push some beads — see what happens") before the
  // directed steps.
  const exploreStep = step != null && !isChallenge(step);

  const onSolvedChange = useCallback((s: boolean) => {
    setLiveSolved(s);
    setVerdict("idle");
  }, []);
  const onStateChange = useCallback((s: unknown) => setState(s), []);

  const check = () => {
    const solved = step ? isSolved(step, state) : liveSolved;
    setVerdict(solved ? "correct" : "incorrect");
  };
  const next = () => {
    setStepIndex(advanceSequence);
    setVerdict("idle");
    setLiveSolved(false);
    setState(null);
    setResetKey((k) => k + 1);
  };
  const playAgain = () => {
    setStepIndex(0);
    setVerdict("idle");
    setLiveSolved(false);
    setState(null);
    setResetKey((k) => k + 1);
  };

  return (
    <MultiStepChallenge
      testId="multi-step-sequence-challenge"
      concept={spec.concept}
      title={complete ? spec.title : (step?.prompt ?? spec.title)}
      extraCredit={spec.extraCredit}
      source={spec.source}
      progress={{ mode: "steps", current: progress.current, total: progress.total }}
      complete={complete}
      completeSummary={spec.completeSummary}
      onReset={playAgain}
      footer={
        verdict === "correct" || exploreStep ? (
          <Box
            as="button"
            onClick={next}
            fontSize="14px"
            fontWeight="700"
            color="white"
            bg="brand.primary"
            px="18px"
            py="10px"
            minH="44px"
            borderRadius="10px"
            _hover={{ bg: "navy.700" }}
            css={{ cursor: "pointer" }}
          >
            {progress.current === progress.total ? "Finish" : "Next step"}
          </Box>
        ) : (
          <Box
            as="button"
            onClick={check}
            fontSize="14px"
            fontWeight="700"
            color="white"
            bg="brand.primary"
            px="18px"
            py="10px"
            minH="44px"
            borderRadius="10px"
            _hover={{ bg: "navy.700" }}
            css={{ cursor: "pointer" }}
          >
            Done
          </Box>
        )
      }
    >
      {!complete && step && (
        <>
          <ManipulativeStage key={resetKey} spec={step} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />
          <Text
            mt={3}
            fontSize="14px"
            fontWeight="700"
            px="12px"
            py="6px"
            borderRadius="999px"
            display="inline-block"
            style={{
              background:
                verdict === "correct" ? "rgba(0,221,145,.16)" : verdict === "incorrect" ? "rgba(255,166,57,.16)" : C.cream,
              color: verdict === "correct" ? "#00875a" : verdict === "incorrect" ? "#b4650f" : C.charcoal,
            }}
          >
            {verdict === "correct"
              ? "That's it! ✓"
              : verdict === "incorrect"
                ? "Not quite — take another look."
                : exploreStep
                  ? "Have a play. There's nothing to get wrong here."
                  : "Set it up, then tap Done."}
          </Text>
        </>
      )}
    </MultiStepChallenge>
  );
}
