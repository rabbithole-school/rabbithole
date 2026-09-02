"use client";

/**
 * ReprobeOffer — the "you're on a roll, jump ahead?" strand re-probe (raise-the-
 * ceiling plan §4 B1-Mechanism-2 + the §12 offer). Surfaced on the practice
 * session-complete screen when the engine notices a strand where the scholar has
 * repeatedly been accelerated (valve jumps) and there's headroom above their
 * current floor — i.e. they're plausibly under-placed. It's an OFFER, never
 * forced: the kid chooses to jump ahead or keep going.
 *
 * "Jump ahead" runs a short adaptive probe search UP the strand
 * (`reprobeProbes` serves one probe at a time given the answers so far),
 * finalized by `submitReprobe`, which credits the newly-cleared nodes
 * PROVISIONALLY (source "reprobe" — access granted, fluency not yet demonstrated;
 * the short half-life leash self-corrects anything shaky). The reveal frames it
 * as "your frontier moved" — a learning event, never a score/record.
 *
 * Mirrors Placement's probe-card + number-pad UX (same drill surface) — including
 * the unit affordance on a measurement probe (`answerUnit`). One asymmetry worth
 * knowing: a re-probe grades ONCE at finalize over the accumulated answers, so
 * unlike the drill and placement there is NO per-item verdict coming back — no
 * `unitOutcome`, no "so close, check your unit" moment. The pre-submit gate is
 * therefore the only thing standing between a slip and a spent probe.
 */

import { useCallback, useEffect, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, HStack, VStack, SimpleGrid, Button, Text } from "@chakra-ui/react";
import { FractionText } from "@/components/FractionText";
import { StemText } from "@/components/practice/StemText";
import { PromptVisual } from "@/components/practice/PromptVisual";
import { hasPracticeMath } from "@/shared/fractions";
import type { PracticePromptVisual } from "@/shared/practicePromptVisual";
import { ArrowRight } from "@phosphor-icons/react";
import { applyUnitKey, choiceSubmitValue } from "@/shared/practiceLoop";
import { superscriptExponents } from "@/shared/mathNotation";
import { hasUnitToken } from "@/convex/lib/practice/answers";
import { UnitKeys } from "@/components/practice/UnitKeys";
import { UNIT_MISSING_NUDGE } from "@/components/practice/unitAnswerCopy";
import { ExpressionEditor } from "@/components/practice/ExpressionEditor";
import { ExpressionKeypad } from "@/components/practice/ExpressionKeypad";
import { useExpressionTemplate } from "@/hooks/useExpressionTemplate";
import { useExpressionTemplateKeyboard } from "@/hooks/useExpressionTemplateKeyboard";

type Probe = {
  itemId: string;
  skillKey: string;
  stem: string;
  answerType: "integer" | "decimal" | "fraction" | "expression" | "multipleChoice";
  /** The measurement unit this probe must be answered in, DISPLAY form ("cm³")
   *  — mirrors the drill + placement wires. Present ⇒ the answer is value +
   *  unit ("112 cm³"), so the card widens its key allowlist, offers the unit
   *  keys, and holds a unit-less Next back; absent ⇒ unchanged. */
  answerUnit?: string;
  /** Option labels for a multipleChoice probe — rendered as tappable buttons. */
  choices?: string[];
  promptVisual?: PracticePromptVisual;
  answerShape?: "twoD";
};

type Answer = { itemId: string; answer: string };

export function ReprobeOffer({
  scholarId,
  strand,
  domain,
  onStart,
  onResolved,
}: {
  scholarId: Id<"users">;
  /** The strand the engine flagged for a jump-ahead (from reprobeCandidates). */
  strand: string;
  domain?: string;
  /** Called once, the instant the kid taps "Jump ahead" — before any network
   *  round-trip. Lets the parent settle a still-pending Moments story card:
   *  the completion arbiter's contract is that STARTING any bonus continuation
   *  (tune-up / challenge / re-probe) settles a story the scholar never
   *  touched (shared/completionOffers.ts). Optional — declining never calls it. */
  onStart?: () => void;
  /** Called once the kid has either declined or finished the re-probe, so the
   *  parent can refresh (a moved frontier changes the next session). */
  onResolved: () => void;
}) {
  const convex = useConvex();
  const submit = useMutation(api.practiceSkills.submitReprobe);

  const [phase, setPhase] = useState<"offer" | "probing" | "submitting" | "result">("offer");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [input, setInput] = useState("");
  // The unit gate fired on this probe; cleared by the next edit (and by the next
  // probe, which arrives with a cleared input).
  const [unitGateNudge, setUnitGateNudge] = useState(false);
  const [seed] = useState(() => Math.floor(Math.random() * 2_000_000_000));
  const [moved, setMoved] = useState<{ count: number } | null>(null);

  // Fetch the next adaptive probe for the accumulated answers, or finalize.
  const advance = useCallback(
    async (all: Answer[]) => {
      const res = await convex.query(api.practiceSkills.reprobeProbes, {
        scholarId,
        strand,
        domain,
        answers: all,
        seed,
      });
      if (res.done || !res.probe) {
        setPhase("submitting");
        const done = await submit({ scholarId, strand, domain, answers: all });
        setMoved({ count: done.creditedKeys.length });
        setPhase("result");
        return;
      }
      setProbe(res.probe as Probe);
    },
    [convex, scholarId, strand, domain, seed, submit],
  );

  const start = useCallback(() => {
    onStart?.();
    setPhase("probing");
    void advance([]);
  }, [advance, onStart]);

  // A unit-bearing probe ("…in cubic centimeters"): the unit is part of the
  // answer, so this card widens its key allowlist, offers the unit keys, and
  // holds a unit-less Next back. Typed probes only — a tapped choice commits an
  // option index, not a measurement (and never carries `answerUnit`).
  const answerUnit = probe && probe.answerType !== "multipleChoice" ? probe.answerUnit : undefined;
  const usesTemplateEditor =
    probe?.answerShape === "twoD" &&
    (probe.answerType === "fraction" || probe.answerType === "expression");
  const { templateState, onTemplateKey, onSetCaret, onInsertFraction, onInsertPower, onInsertSquareRoot, onInsertRoot } =
    useExpressionTemplate({
      enabled: phase === "probing" && usesTemplateEditor,
      itemKey: probe?.itemId,
      seedSkeleton: null,
      onSubmissionChange: setInput,
    });

  const onKey = useCallback((k: string) => {
    setUnitGateNudge(false); // any edit answers the "include the unit" nudge
    setInput((prev) => {
      const next = k === "⌫" ? prev.slice(0, -1) : prev + k;
      // A unit item's hardware-typed caret ("cm^3") reads as the SAME real
      // superscript a tapped unit key already produces ("cm³") — grading is
      // unaffected either way (`splitUnitSuffix` recognizes both forms).
      return answerUnit ? superscriptExponents(next) : next;
    });
  }, [answerUnit]);

  // A tapped unit key REPLACES any trailing unit, so cm² → cm³ is one tap.
  const onUnitKey = useCallback((unit: string) => {
    setUnitGateNudge(false);
    setInput((prev) => applyUnitKey(prev, unit));
  }, []);

  const commitAnswer = useCallback(
    (answer: string) => {
      if (!probe) return;
      const all = [...answers, { itemId: probe.itemId, answer }];
      setAnswers(all);
      setInput("");
      setUnitGateNudge(false); // the nudge belongs to the probe that raised it
      setProbe(null);
      void advance(all);
    },
    [probe, answers, advance],
  );

  // Skip — deliberately UNGATED. Whatever is in the field is committed as-is
  // (identical to before), because a scholar bailing out of a probe must never
  // be held behind a formatting nudge.
  const onSkip = useCallback(() => {
    if (!probe) return;
    commitAnswer(input.trim() || "skip");
  }, [probe, input, commitAnswer]);

  const onNext = useCallback(() => {
    if (!probe) return;
    const answer = input.trim();
    // A unit-bearing probe wants "112 cm³"; a bare number grades incorrect
    // (`gradeOutcomes` → `gradeSubmission` enforces the unit), and a re-probe
    // answer is spent the moment it's committed — the accumulated answers are
    // graded once at finalize, with no per-item verdict coming back. So THIS
    // gate is the only protection the surface has. An empty field is the skip
    // path and stays ungated.
    if (answerUnit && answer && !hasUnitToken(answer)) {
      setUnitGateNudge(true);
      return;
    }
    commitAnswer(answer || "skip");
  }, [probe, input, answerUnit, commitAnswer]);

  useEffect(() => {
    if (usesTemplateEditor) return;
    const h = (e: KeyboardEvent) => {
      if (phase !== "probing" || !probe) return;
      if (/^[0-9]$/.test(e.key) || e.key === "/" || e.key === "-") onKey(e.key);
      // The unit-item carve-out (mirrors `useFlatAnswerKeyboard`'s `allowUnit`):
      // the answer to "…in cubic centimeters" IS "112 cm³", so the numeric
      // allowlist would make it literally untypeable.
      else if (
        answerUnit &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (/^[a-zA-Z]$/.test(e.key) || e.key === " " || e.key === "^")
      ) {
        // Space would otherwise scroll the page out from under the problem.
        if (e.key === " ") e.preventDefault();
        onKey(e.key);
      } else if (e.key === "Backspace") onKey("⌫");
      else if (e.key === "Enter") onNext();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [phase, probe, answerUnit, onKey, onNext, usesTemplateEditor]);
  useExpressionTemplateKeyboard({
    enabled: phase === "probing" && usesTemplateEditor,
    onKey: onTemplateKey,
    onSubmit: onNext,
  });

  // ── The offer ──
  if (phase === "offer") {
    return (
      <Box
        w="100%"
        bg="#fff8ee"
        border="1px solid #f0d58a"
        borderRadius="14px"
        p={4}
      >
        <Text fontSize="16px" fontWeight="700" color="#7a5f1c" mb={1}>
          You&apos;re on a roll 🔥
        </Text>
        <Text fontSize="14px" color="#7a5f1c" mb={3}>
          Want to jump ahead and find your real frontier?
        </Text>
        <HStack gap={2}>
          <Button colorPalette="orange" onClick={start}>
            Jump ahead <ArrowRight />
          </Button>
          <Button variant="ghost" color="#8a6d2a" onClick={onResolved}>
            Keep going here
          </Button>
        </HStack>
      </Box>
    );
  }

  if (phase === "submitting") {
    return (
      <Box w="100%" bg="#fffdfa" border="1px solid #ded8cb" borderRadius="14px" p={4}>
        <Text color="#65706a" textAlign="center">Finding your edge…</Text>
      </Box>
    );
  }

  // ── The reveal — a learning event ("your frontier moved"), never a score ──
  if (phase === "result") {
    const count = moved?.count ?? 0;
    return (
      <Box w="100%" bg="#fff8ee" border="1px solid #f0d58a" borderRadius="14px" p={4}>
        <VStack gap={3} align="stretch">
          {count > 0 ? (
            <>
              <Text fontSize="16px" fontWeight="700" color="#7a5f1c">
                ⛰ Your frontier moved
              </Text>
              <Text fontSize="14px" color="#7a5f1c">
                {count} more skill{count === 1 ? " is" : "s are"} yours now — your next
                practice picks up from there.
              </Text>
            </>
          ) : (
            <Text fontSize="14px" color="#7a5f1c">
              Nice — you&apos;re right at your edge already. Let&apos;s keep building from here.
            </Text>
          )}
          <Button colorPalette="teal" onClick={onResolved} alignSelf="flex-start">
            Keep going <ArrowRight />
          </Button>
        </VStack>
      </Box>
    );
  }

  // ── probing: the adaptive probe card + number pad (mirrors Placement) ──
  return (
    <Box w="100%" bg="#fffdfa" border="1px solid #ded8cb" borderRadius="16px" p={5}>
      <VStack gap={4} w="100%">
        <Text fontSize="12px" color="#65706a" alignSelf="flex-start">
          Jumping ahead — a few tougher ones
        </Text>
        <Box
          w="100%"
          bg="#f6f4ef"
          borderRadius="12px"
          p={5}
          minH="96px"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <VStack gap={probe?.promptVisual ? 4 : 0} w="100%">
            <StemText value={superscriptExponents(probe?.stem ?? "…")} fontSize={26} align="center" />
            {probe?.promptVisual ? <PromptVisual spec={probe.promptVisual} /> : null}
          </VStack>
        </Box>
        {probe?.answerType === "multipleChoice" && (probe.choices?.length ?? 0) > 0 ? (
          // Tap an option — commits its index and pulls the next probe.
          <VStack w="100%" gap={2}>
            {probe.choices!.map((choice, i) => (
              <Button
                key={`${i}-${choice}`}
                w="100%"
                h="auto"
                minH="52px"
                py={3}
                whiteSpace="normal"
                textAlign="center"
                fontSize="20px"
                fontWeight="600"
                variant="outline"
                bg="#f3fbfc"
                borderColor="#16707e"
                color="#143"
                onClick={() => commitAnswer(choiceSubmitValue(i))}
              >
                {hasPracticeMath(choice) ? (
                  <FractionText value={choice} inline fontSize={20} color="inherit" align="center" />
                ) : (
                  choice
                )}
              </Button>
            ))}
            <Button variant="ghost" color="#8a8f88" alignSelf="flex-start" onClick={onSkip}>
              Skip
            </Button>
          </VStack>
        ) : usesTemplateEditor && templateState ? (
          <VStack w="100%" gap={3}>
            <Box
              w="100%"
              border="2px solid #16707e"
              borderRadius="12px"
              bg="#f3fbfc"
              px={4}
              py={3}
              color="#143"
              minH="56px"
            >
              <ExpressionEditor state={templateState} onSetCaret={onSetCaret} interactive />
            </Box>
            <ExpressionKeypad
              onInsertFraction={onInsertFraction}
              onInsertPower={onInsertPower}
              onInsertSquareRoot={onInsertSquareRoot}
              onInsertRoot={onInsertRoot}
              showRadicals={probe.answerType === "expression"}
              onDelete={() => onTemplateKey("⌫")}
              onDigit={onTemplateKey}
              locked={!!templateState.structureLocked}
              showDigits
            />
            <HStack w="100%" justify="space-between">
              <Button variant="ghost" color="#8a8f88" onClick={onSkip}>
                Skip
              </Button>
              <Button colorPalette="teal" onClick={onNext} disabled={!probe}>
                Next <ArrowRight />
              </Button>
            </HStack>
          </VStack>
        ) : (
          <>
            <Box
              w="100%"
              border="2px solid #16707e"
              borderRadius="12px"
              bg="#f3fbfc"
              px={4}
              py={3}
              textAlign="center"
              fontSize="26px"
              fontWeight="700"
              color="#143"
              minH="56px"
            >
              {input || <Text as="span" color="#9bbcc2">type your answer</Text>}
            </Box>
            <SimpleGrid columns={3} gap={2} w="100%">
              {["7", "8", "9", "4", "5", "6", "1", "2", "3", "", "0", "⌫"].map((k, i) => (
                <Button
                  key={i}
                  h="52px"
                  fontSize="22px"
                  fontWeight="600"
                  variant="outline"
                  bg="#f1ede4"
                  visibility={k === "" ? "hidden" : "visible"}
                  onClick={() => k && onKey(k)}
                >
                  {k}
                </Button>
              ))}
            </SimpleGrid>
            {/* The unit keys are the card's other accessory row: the whole
                dimension family (cm / cm² / cm³), because choosing length vs.
                area vs. volume IS part of the task. Same component the drill and
                placement use, so the affordance can't drift across surfaces. */}
            {answerUnit && <UnitKeys answerUnit={answerUnit} onPick={onUnitKey} />}
            {unitGateNudge && (
              <Text className="rh-note" fontSize="14px" color="#8a6d16" textAlign="center">
                {UNIT_MISSING_NUDGE}
              </Text>
            )}
            <HStack w="100%" justify="space-between">
              <Button variant="ghost" color="#8a8f88" onClick={onSkip}>
                Skip
              </Button>
              <Button colorPalette="teal" onClick={onNext} disabled={!probe}>
                Next <ArrowRight />
              </Button>
            </HStack>
          </>
        )}
      </VStack>
    </Box>
  );
}
