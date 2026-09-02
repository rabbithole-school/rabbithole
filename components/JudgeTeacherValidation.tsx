"use client";

/**
 * Judge ↔ teacher micro-validation panel (sim-realism adoptable #2) — the
 * human half of Debrief's "how much do we trust the judge?" question. The judge
 * scores real transcripts during grounding; here a teacher makes ~10 blind
 * pairwise picks ("which session went better for this kid?") and we correlate
 * their choices with the judge's fitness ranking, yielding our own agreement
 * rate + r-value (review/sim-realism-lessons.html §5 #2, §4 Finding 4).
 *
 * Blind on purpose: the judge's own preference is hidden until AFTER a pick, so
 * the teacher's read isn't anchored. Web/teacher-only — a curriculum surface,
 * not a scholar one.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { CaretLeft, CaretRight, Check, Scales } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";

type Choice = "A" | "B" | "tie";

export function JudgeTeacherValidation({
  activityId,
}: {
  activityId: Id<"activities">;
}) {
  const data = useQuery(api.judgeValidation.pairsForActivity, { activityId });
  const corr = useQuery(api.judgeValidation.correlation, { activityId });
  const record = useMutation(api.judgeValidation.recordChoice);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const pairs = useMemo(() => data?.pairs ?? [], [data]);
  // Start the teacher on the first un-compared pair once the deck loads.
  const firstPending = useMemo(() => {
    const i = pairs.findIndex((p) => p.alreadyChoice === null);
    return i === -1 ? 0 : i;
  }, [pairs]);
  const [touched, setTouched] = useState(false);
  const activeIndex = touched ? index : firstPending;

  if (data === undefined) {
    return (
      <Box borderTopWidth="1px" borderColor="gray.100" pt={5}>
        <Flex justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      </Box>
    );
  }

  const header = (
    <Flex align="baseline" justify="space-between" mb={1} gap={3}>
      <HStack gap={2} align="center">
        <Scales size={16} weight="duotone" color="var(--chakra-colors-violet-500)" />
        <Text fontFamily="heading" fontWeight="700" color="navy.500">
          Validate the judge
        </Text>
      </HStack>
      {pairs.length > 0 && (
        <Text fontSize="2xs" color="charcoal.400">
          {data.recordedCount} of {pairs.length} compared
        </Text>
      )}
    </Flex>
  );

  if (data.judgedSessions < 2 || pairs.length === 0) {
    return (
      <Box borderTopWidth="1px" borderColor="gray.100" pt={5}>
        {header}
        <Text fontSize="xs" color="charcoal.400" mt={1} lineHeight="1.5" maxW="640px">
          {data.note ??
            "Not enough judged real sessions to compare yet."}
        </Text>
      </Box>
    );
  }

  const pair = pairs[Math.min(activeIndex, pairs.length - 1)];

  const choose = async (choice: Choice) => {
    if (busy) return;
    setBusy(true);
    try {
      await record({
        activityId,
        sessionAId: pair.sessionAId,
        sessionBId: pair.sessionBId,
        teacherChoice: choice,
      });
      // Advance to the next un-compared pair (or the next one).
      const next = pairs.findIndex(
        (p, i) => i > activeIndex && p.alreadyChoice === null,
      );
      setTouched(true);
      setIndex(next === -1 ? Math.min(activeIndex + 1, pairs.length - 1) : next);
    } catch (err) {
      console.error("recordChoice failed:", err);
      toaster.error({ title: "Couldn't record — try again." });
    } finally {
      setBusy(false);
    }
  };

  const goto = (i: number) => {
    setTouched(true);
    setIndex(Math.max(0, Math.min(i, pairs.length - 1)));
  };

  return (
    <Box borderTopWidth="1px" borderColor="gray.100" pt={5}>
      {header}
      <Text fontSize="xs" color="charcoal.400" mt={1} mb={3} lineHeight="1.5" maxW="640px">
        Read two real sessions and pick which went better for the kid. Your
        picks are correlated with the judge&apos;s ranking to tell us how much to
        trust its scorecards — so the judge&apos;s own pick stays hidden until
        after you choose.
      </Text>

      {/* One pair, blind. */}
      <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" p={3}>
        <Flex align="baseline" justify="space-between" mb={2}>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" letterSpacing="0.04em">
            PAIR {Math.min(activeIndex, pairs.length - 1) + 1} OF {pairs.length}
          </Text>
          <HStack gap={1}>
            <Button
              size="2xs"
              variant="ghost"
              color="charcoal.400"
              onClick={() => goto(activeIndex - 1)}
              disabled={activeIndex <= 0}
            >
              <CaretLeft /> Prev
            </Button>
            <Button
              size="2xs"
              variant="ghost"
              color="charcoal.400"
              onClick={() => goto(activeIndex + 1)}
              disabled={activeIndex >= pairs.length - 1}
            >
              Next <CaretRight />
            </Button>
          </HStack>
        </Flex>

        <Flex gap={3} align="stretch" flexWrap="wrap">
          <ExcerptColumn label="Session A" card={pair.a} />
          <ExcerptColumn label="Session B" card={pair.b} />
        </Flex>

        <HStack gap={2} pt={3} flexWrap="wrap">
          <ChoiceButton
            label="A went better"
            active={pair.alreadyChoice === "A"}
            disabled={busy}
            onClick={() => choose("A")}
          />
          <ChoiceButton
            label="About the same"
            active={pair.alreadyChoice === "tie"}
            disabled={busy}
            onClick={() => choose("tie")}
          />
          <ChoiceButton
            label="B went better"
            active={pair.alreadyChoice === "B"}
            disabled={busy}
            onClick={() => choose("B")}
          />
        </HStack>

        {/* Reveal the judge's pick ONLY after the teacher has recorded one. */}
        {pair.alreadyChoice !== null && (
          <JudgeReveal
            teacherChoice={pair.alreadyChoice}
            judgePrefers={pair.judgePrefers}
            judgeMargin={pair.judgeMargin}
          />
        )}
      </Box>

      {/* Running result. */}
      {corr && corr.n > 0 && <CorrelationSummary corr={corr} />}
    </Box>
  );
}

function ExcerptColumn({
  label,
  card,
}: {
  label: string;
  card: {
    profileName: string;
    readingLevel: string;
    goalAttainment: number;
    excerpt: string;
  };
}) {
  return (
    <Box flex="1" minW="240px">
      <HStack justify="space-between" mb={1}>
        <Text fontSize="xs" fontWeight="700" color="navy.500" fontFamily="heading">
          {label}
        </Text>
        <Text fontSize="2xs" color="charcoal.400">
          {card.readingLevel}
        </Text>
      </HStack>
      <Box
        bg="gray.50"
        borderWidth="1px"
        borderColor="gray.100"
        borderRadius="md"
        p={2}
        maxH="260px"
        overflowY="auto"
      >
        <Text
          fontSize="xs"
          color="charcoal.600"
          whiteSpace="pre-wrap"
          lineHeight="1.5"
        >
          {card.excerpt || "(no transcript)"}
        </Text>
      </Box>
    </Box>
  );
}

function ChoiceButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="xs"
      variant={active ? "solid" : "outline"}
      colorPalette={active ? "violet" : undefined}
      borderColor={active ? undefined : "gray.300"}
      color={active ? undefined : "charcoal.600"}
      fontFamily="heading"
      onClick={onClick}
      disabled={disabled}
    >
      {active && <Check style={{ marginRight: 4 }} />}
      {label}
    </Button>
  );
}

function JudgeReveal({
  teacherChoice,
  judgePrefers,
  judgeMargin,
}: {
  teacherChoice: Choice;
  judgePrefers: Choice;
  judgeMargin: number;
}) {
  const judgeText =
    judgePrefers === "tie"
      ? "rated them about equal"
      : `ranked Session ${judgePrefers} higher (Δ fitness ${Math.abs(judgeMargin).toFixed(2)})`;
  // "Agree" only when both picked a side and it's the same side.
  const decisive = teacherChoice !== "tie" && judgePrefers !== "tie";
  const agree = decisive && teacherChoice === judgePrefers;
  const tone = !decisive
    ? { bg: "gray.100", color: "charcoal.600", label: "Tie" }
    : agree
      ? { bg: "green.100", color: "green.700", label: "Agrees with you" }
      : { bg: "amber.100", color: "amber.700", label: "Differs from you" };
  return (
    <HStack gap={2} pt={2} flexWrap="wrap" align="center">
      <Badge bg={tone.bg} color={tone.color} fontFamily="heading" fontSize="2xs">
        {tone.label}
      </Badge>
      <Text fontSize="2xs" color="charcoal.400">
        The judge {judgeText}.
      </Text>
    </HStack>
  );
}

function CorrelationSummary({
  corr,
}: {
  corr: {
    n: number;
    nDecisive: number;
    agreements: number;
    agreement: number | null;
    r: number | null;
  };
}) {
  const agreementPct =
    corr.agreement === null ? null : Math.round(corr.agreement * 100);
  const rText = corr.r === null ? "—" : corr.r.toFixed(2);
  return (
    <Box mt={4}>
      <SectionEyebrow>Judge–teacher agreement</SectionEyebrow>
      <HStack gap={4} mt={1} flexWrap="wrap" align="baseline">
        <Text fontFamily="heading" fontWeight="700" fontSize="lg" color="navy.500">
          r = {rText}
        </Text>
        <Text fontSize="sm" color="charcoal.600">
          {agreementPct === null
            ? "no decisive pairs yet"
            : `${agreementPct}% agreement`}{" "}
          <Text as="span" color="charcoal.400" fontSize="xs">
            ({corr.agreements}/{corr.nDecisive} decisive · n = {corr.n})
          </Text>
        </Text>
      </HStack>
      <Text fontSize="2xs" color="charcoal.400" mt={1} lineHeight="1.5" maxW="640px">
        Higher agreement / r means the judge&apos;s scorecards track your read of
        real sessions — trust them more. Low or negative means treat the sim
        scores as directional only and lean on your own judgment.
      </Text>
    </Box>
  );
}
