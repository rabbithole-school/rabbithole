"use client";

/**
 * The Manipulative frame — the single entry point that renders any
 * `ManipulativeSpec`. It owns only the Jobs-minimal chrome (a concept eyebrow,
 * the one-line prompt, a mode badge, the self-check chip, and reset) and
 * dispatches the interactive stage to the matching kind. Whether a challenge is
 * solved comes from the pure predicates in `logic.ts` (the kind reports it up).
 *
 * Explainer vs challenge is decided by `spec.goal` or `spec.answer`:
 *   • neither  → "Explore" badge, no pass/fail, free play.
 *   • goal     → "Challenge" badge + a self-correcting Done check.
 *   • answer   → the material is a scaffold; the typed number is the verdict.
 */
import { Box, Field, Flex, Input, Text } from "@chakra-ui/react";
import { useCallback, useState } from "react";
import "mafs/core.css";
import "./mafs-theme.css";
import { isChallenge, type ManipulativeSpec } from "@/lib/manipulative/types";
import { C, wash } from "./colors";
import { answerSolved } from "@/lib/manipulative/logic";
import { PartitionManipulative } from "./kinds/PartitionManipulative";
import { NumberLineManipulative } from "./kinds/NumberLineManipulative";
import { ArrayManipulative } from "./kinds/ArrayManipulative";
import { BalanceManipulative } from "./kinds/BalanceManipulative";
import { AreaPerimeterManipulative } from "./kinds/AreaPerimeterManipulative";
import { DistributeManipulative } from "./kinds/DistributeManipulative";
import { RekenrekManipulative } from "./kinds/RekenrekManipulative";
import { DistributorManipulative } from "./kinds/DistributorManipulative";
import { RiemannManipulative } from "./kinds/RiemannManipulative";
import { FunctionMachineManipulative } from "./kinds/FunctionMachineManipulative";
import { PlaceValueManipulative } from "./kinds/PlaceValueManipulative";
import { DiceManipulative } from "./kinds/DiceManipulative";
import { ProtractorManipulative } from "./kinds/ProtractorManipulative";
import { CoordinatePlaneManipulative } from "./kinds/CoordinatePlaneManipulative";
import { GeoLocateManipulative } from "./kinds/GeoLocateManipulative";
import { RulerManipulative } from "./kinds/RulerManipulative";
import { ClockManipulative } from "./kinds/ClockManipulative";
import { LiquidManipulative } from "./kinds/LiquidManipulative";
import { MoneyManipulative } from "./kinds/MoneyManipulative";

export interface KindProps<S extends ManipulativeSpec = ManipulativeSpec> {
  spec: S;
  onSolvedChange: (solved: boolean) => void;
  /** Reports the kind's own runtime state up (the kind-matched shape `logic.ts`
   *  expects — e.g. `NumberLineState`, `BalanceState`) whenever it changes.
   *  Optional: only the practice-item path (Done → server grade) needs it. */
  onStateChange?: (state: unknown) => void;
  /**
   * The frame's own live `spec.answer` input (raw text, as typed). Only
   * `functionMachine` reads this: that kind has nothing to manipulate
   * in-canvas — its whole verdict IS the typed prediction (see
   * `FunctionMachineManipulative`) — so it must echo this string into its own
   * `onStateChange`-reported `{predicted}` state, or `state` would stay
   * `null` forever and a practice-mode Done could never fire. Every other
   * kind's own manipulation IS the state; they ignore this prop.
   */
  typedAnswer?: string;
}

/**
 * Dispatches a spec to its kind renderer. Exported so any wrapper that needs
 * to render a bare kind stage outside the full `Manipulative` card chrome can
 * reuse the SAME dispatch instead of duplicating this switch — e.g.
 * `MultiStepSequenceChallenge` (any Model-A sequence, hosted inside the
 * standard `MultiStepChallenge` frame instead of this component's own chrome).
 */
export function ManipulativeStage({ spec, onSolvedChange, onStateChange, typedAnswer }: KindProps) {
  switch (spec.kind) {
    case "partition":
      return <PartitionManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "numberline":
      return <NumberLineManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "array":
      return <ArrayManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "balance":
      return <BalanceManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "areaPerimeter":
      return <AreaPerimeterManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "distribute":
      return <DistributeManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "rekenrek":
      return <RekenrekManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "distributor":
      return <DistributorManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "riemann":
      return <RiemannManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "functionMachine":
      return (
        <FunctionMachineManipulative
          spec={spec}
          onSolvedChange={onSolvedChange}
          onStateChange={onStateChange}
          typedAnswer={typedAnswer}
        />
      );
    case "dice":
      return <DiceManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "placeValue":
      return <PlaceValueManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "protractor":
      return <ProtractorManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "coordinatePlane":
      return <CoordinatePlaneManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "geoLocate":
      return <GeoLocateManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "ruler":
      return <RulerManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "clock":
      return <ClockManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "liquid":
      return <LiquidManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
    case "money":
      return <MoneyManipulative spec={spec} onSolvedChange={onSolvedChange} onStateChange={onStateChange} />;
  }
}

function ModeBadge({ spec, challenge }: { spec: ManipulativeSpec; challenge: boolean }) {
  const label = spec.extraCredit ? "Extra credit ★" : challenge ? "Challenge" : "Explore";
  return (
    <Box
      flexShrink={0}
      fontSize="11px"
      fontWeight="700"
      px="10px"
      py="4px"
      borderRadius="999px"
      bg={spec.extraCredit ? "bg.muted" : challenge ? "colorPalette.subtle" : "bg.muted"}
      color={spec.extraCredit ? "brand.primary" : challenge ? "colorPalette.fg" : "fg.muted"}
      css={{ "--chakra-colors-color-palette-subtle": C.cyan }}
      style={
        spec.extraCredit
          ? { background: wash(C.yellow, 0.5), color: C.navy }
          : challenge
            ? { background: "#e7fbfe", color: C.teal }
            : undefined
      }
    >
      {label}
    </Box>
  );
}

export function Manipulative({
  spec,
  onCommit,
}: {
  spec: ManipulativeSpec;
  /**
   * Practice-item mode (lane 2): when present, Done hands the locked-in
   * runtime state up as JSON — `manipulativeSubmitArgs` / the server grader
   * in `lib/manipulative/grade.ts` is the authority, so this component stops
   * computing/showing its own verdict and just reports "submitted, waiting".
   * The caller (the practice session) drives correct/incorrect feedback from
   * the server response, exactly like a numeric item. Absent (the Manipulative
   * Library / Rehearse / authoring preview), the standalone local self-check
   * chip below behaves exactly as before.
   */
  onCommit?: (stateJson: string) => void;
}) {
  const challenge = isChallenge(spec);
  const practiceMode = onCommit != null;
  // liveSolved = whether the CURRENT state satisfies the goal (never shown directly
  // for a challenge). verdict = what we reveal, and only on an explicit "Done":
  // "idle" until they commit; any subsequent change clears it back to "idle" so a
  // student can't scrub into the green light without locking in a guess.
  const [liveSolved, setLiveSolved] = useState(false);
  const [verdict, setVerdict] = useState<"idle" | "correct" | "incorrect">("idle");
  const [typedAnswer, setTypedAnswer] = useState("");
  const [resetKey, setResetKey] = useState(0);
  // The kind's own runtime state, lifted only so practice mode can hand it to
  // `onCommit` on Done — the standalone gallery never reads this.
  const [state, setState] = useState<unknown>(null);
  // Practice mode's anti-scrub lock: freezes the stage the instant Done is
  // tapped, so a scholar can't keep reshaping a "submitted" material while the
  // session is off grading it server-side. (Standalone mode gets the same
  // guarantee for free — see onSolvedChange — since any post-Done edit there
  // resets verdict to "idle", forcing a fresh Done before green can show.)
  const [committed, setCommitted] = useState(false);

  const onSolvedChange = useCallback((s: boolean) => {
    setLiveSolved(s);
    setVerdict("idle"); // any manipulation invalidates the last check — re-commit required
  }, []);
  const onStateChange = useCallback((s: unknown) => {
    setState(s);
  }, []);
  const check = () => {
    if (practiceMode) {
      if (committed || state === null) return;
      setCommitted(true);
      onCommit(JSON.stringify(state));
      return;
    }
    const solved = spec.answer ? answerSolved(spec.answer, typedAnswer) : liveSolved;
    setVerdict(solved ? "correct" : "incorrect");
  };
  const reset = () => {
    setLiveSolved(false);
    setVerdict("idle");
    setTypedAnswer("");
    setResetKey((k) => k + 1);
  };

  return (
    <Box
      className="manip-root"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="18px"
      bg="white"
      p={{ base: 4, md: 5 }}
      boxShadow="0 6px 22px rgba(34,38,86,.06)"
      maxW="620px"
      w="100%"
    >
      <Flex justify="space-between" align="flex-start" gap={3} mb={1}>
        <Box minW={0}>
          <Text fontSize="11px" fontWeight="700" letterSpacing="0.08em" textTransform="uppercase" color="fg.muted">
            {spec.concept}
          </Text>
          <Text fontSize={{ base: "17px", md: "19px" }} fontWeight="700" color="brand.primary" lineHeight="1.25">
            {spec.prompt}
          </Text>
        </Box>
        <ModeBadge spec={spec} challenge={challenge} />
      </Flex>

      <Box
        mt={3}
        css={{ touchAction: "none", userSelect: "none" }}
        // Practice mode's anti-scrub lock: once Done is tapped the stage
        // freezes solid (no more pointer/touch input reaches it) — a scholar
        // can't keep reshaping a "submitted" material while the session is
        // off grading it server-side. Never engages in standalone mode
        // (committed stays false there).
        pointerEvents={committed ? "none" : "auto"}
        opacity={committed ? 0.6 : 1}
        transition="opacity .2s ease"
      >
        <ManipulativeStage
          key={resetKey}
          spec={spec}
          onSolvedChange={onSolvedChange}
          onStateChange={onStateChange}
          typedAnswer={typedAnswer}
        />
      </Box>

      {spec.answer && (
        <Field.Root mt={4}>
          <Field.Label fontSize="14px" fontWeight="700" color="brand.primary">
            {spec.answer.prompt}
          </Field.Label>
          <Flex gap={2} align="center">
            <Input
              value={typedAnswer}
              onChange={(e) => {
                setTypedAnswer(e.currentTarget.value);
                setVerdict("idle");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") check();
              }}
              disabled={committed}
              inputMode="numeric"
              type="number"
              minW="130px"
              maxW="180px"
              h="48px"
              fontSize="24px"
              fontWeight="800"
              textAlign="center"
              borderRadius="14px"
              borderColor="border.default"
              color="brand.primary"
              aria-label={spec.answer.prompt}
            />
            {spec.answer.unit && (
              <Text fontSize="15px" fontWeight="700" color="fg.muted">
                {spec.answer.unit}
              </Text>
            )}
          </Flex>
        </Field.Root>
      )}

      <Flex mt={3} align="center" justify="space-between" gap={3} minH="40px" wrap="wrap">
        {challenge ? (
          <Box
            fontSize="14px"
            fontWeight="700"
            px="12px"
            py="6px"
            borderRadius="999px"
            style={{
              // Practice mode never reveals a verdict here (see check()) — the
              // parent session shows correct/incorrect from the SERVER's
              // grade, exactly like a numeric item. This chip only ever
              // reports "not yet submitted" / "submitted, waiting" in that
              // mode, so it always renders in the neutral (idle) color.
              background:
                !practiceMode && verdict === "correct"
                  ? "rgba(0,221,145,.16)"
                  : !practiceMode && verdict === "incorrect"
                    ? "rgba(255,166,57,.16)"
                    : C.cream,
              color:
                !practiceMode && verdict === "correct"
                  ? "#00875a"
                  : !practiceMode && verdict === "incorrect"
                    ? "#b4650f"
                    : C.charcoal,
              transition: "all .3s ease",
              transform: !practiceMode && verdict === "correct" ? "scale(1.04)" : "scale(1)",
            }}
          >
            {practiceMode
              ? committed
                ? "Submitted — checking…"
                : spec.answer
                  ? "Type your answer, then tap Done."
                  : "Set it up, then tap Done."
              : verdict === "correct"
                ? "That's it! ✓"
                : verdict === "incorrect"
                  ? "Not quite — take another look."
                  : spec.answer
                    ? "Type your answer, then tap Done."
                    : "Set your answer, then tap Done."}
          </Box>
        ) : (
          <Text fontSize="13px" color="fg.subtle">
            Play with it — notice what changes.
          </Text>
        )}
        <Flex align="center" gap={2}>
          {(practiceMode ? !committed : challenge && verdict !== "correct") && (
            <Box
              as="button"
              onClick={check}
              aria-disabled={practiceMode && state === null}
              opacity={practiceMode && state === null ? 0.5 : 1}
              fontSize="14px"
              fontWeight="700"
              color="white"
              bg="brand.primary"
              px="18px"
              py="8px"
              borderRadius="10px"
              _hover={{ bg: "navy.700" }}
              css={{ cursor: practiceMode && state === null ? "not-allowed" : "pointer" }}
            >
              Done
            </Box>
          )}
          {!(practiceMode && committed) && (
            <Box
              as="button"
              onClick={reset}
              fontSize="13px"
              fontWeight="600"
              color="fg.muted"
              px="10px"
              py="8px"
              borderRadius="8px"
              _hover={{ bg: "bg.muted" }}
              css={{ cursor: "pointer" }}
            >
              Reset
            </Box>
          )}
        </Flex>
      </Flex>
    </Box>
  );
}
