"use client";

import { Box, Button, Flex, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { TrendUp, ChatCircleText } from "@phosphor-icons/react";
import { Sparkline } from "@/components/Sparkline";
import type { MathPortrait } from "@/convex/mathPortrait";
import { gradeLabelFromRank } from "@/shared/gradeRange";
import { formatDayKeyShort } from "@/components/practice/parentMathDisplay";
import { domainDetailLine, gradeWords } from "@/components/practice/masteryGradeLevel";
import {
  gradeEquivalentFromRank,
  gradeRelativeBand,
  levelDelta,
  type GradeRelativeBand,
} from "@/shared/gradeEquivalent";

/**
 * The Math Skills PORTRAIT — the teacher per-scholar subtab's rendering of the
 * portrait (the parent portal renders the same query fields through
 * `ParentMathPortrait`, which shares the loading/empty states and the chat CTA
 * below). Per math domain the
 * scholar has touched: the grade level (how much of each grade's skills in the
 * area the scholar has covered, placement check-in credit included), the
 * legacy "highest" grade shown in daily work beside it, and, where we have
 * real history, the level's month-over-month growth. Pure/props-only so the two mounts
 * feed it from their own guarded query (teacher: mathPortrait.forScholar,
 * parent: parents.childMathPortrait) — one canonical rendering of one signal.
 *
 * Framing is a portrait, not a report card: grade bands are shown as "how far
 * you've come", growth is only ever UP (the frontier is monotonic), and there is
 * no learner↔learner comparison anywhere. The grade band is a teacher/parent-
 * literacy label (consistent with workingLevel.ts) — both mounts are adult.
 */

export interface MathSkillsPortraitProps {
  /** undefined while the query is in flight. */
  portrait: MathPortrait | undefined;
  /** The scholar's display name — used for first-name framing + the chat CTA. */
  scholarName: string;
  /** When provided, renders the "What is <name> working on in math?" CTA and
   *  calls this with the pre-seeded question. Omit to hide the CTA (e.g. a mount
   *  whose surface already has its own chat entry point). */
  onAskAi?: (question: string) => void;
}

/** The skills matrix legend's words, so both teacher screens band a level alike. */
const BAND_LABEL: Record<GradeRelativeBand, string> = {
  behind: "Behind",
  onPace: "On pace",
  ahead: "Ahead",
  farAhead: "Far ahead",
};


/**
 * The overall level across every area of math: the share of each grade's skills
 * the scholar is credited with, kindergarten upward. Each bar splits the credit
 * into what the scholar has shown in daily practice and what came from the
 * placement check-in. Teacher view only (the parent page shows its own two tiles).
 */
function OverallLevel({
  overall,
  asOfMs,
  firstName,
}: {
  overall: NonNullable<MathPortrait["overall"]>;
  asOfMs: number;
  firstName: string;
}) {
  const level = overall.level;
  if (!level) return null;
  const enrolled = overall.enrolledGradeRank;
  // Read against the grade equivalent (enrolled grade + school month), as the
  // skills matrix tint does.
  const gradeEquivalent = gradeEquivalentFromRank(enrolled, new Date(asOfMs));
  const bands = level.bands.filter(
    (b, i) => b.daily + b.placement > 0 || level.bands.slice(i + 1).some((x) => x.daily + x.placement > 0),
  );
  return (
    <Box borderWidth="1px" borderColor="violet.200" borderRadius="lg" bg="white" px={4} py={3}>
      <Flex align="baseline" justify="space-between" gap={3} wrap="wrap">
        <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.700">
          Overall math level
        </Text>
        <Text
          fontFamily="heading"
          fontSize="lg"
          fontWeight="700"
          color="violet.600"
          fontVariantNumeric="tabular-nums"
        >
          {gradeEquivalent !== null
            ? `${BAND_LABEL[gradeRelativeBand(levelDelta(level.value, gradeEquivalent))]} · ${level.value.toFixed(1)}`
            : level.value.toFixed(1)}
        </Text>
      </Flex>
      <Text fontFamily="body" fontSize="xs" color="charcoal.500" mt={1}>
        {enrolled !== null && gradeEquivalent !== null
          ? `Enrolled in ${gradeWords(enrolled)}, grade equivalent ${gradeEquivalent.toFixed(1)} this month. `
          : ""}
        {level.solidThroughRank !== null
          ? `Solid through ${gradeWords(level.solidThroughRank)}. `
          : ""}
        {level.dailySkills} {level.dailySkills === 1 ? "skill" : "skills"} shown in daily work,{" "}
        {level.placementSkills} credited from the placement check-in.
      </Text>
      {overall.pace && overall.pace.learnedSkills + overall.pace.knownSkills > 0 && (
        <Text fontFamily="body" fontSize="xs" color="charcoal.500" mt={1}>
          {overall.pace.periodLabel}
          {overall.pace.windowStartsAt > overall.pace.periodStartsAt
            ? ` (since ${formatDayKeyShort(overall.pace.windowStartsDay)}, when ${firstName} joined)`
            : ""}
          : about {overall.pace.learnedMonths.toFixed(1)} months of new
          learning in {overall.pace.schoolMonths.toFixed(1)} months of school
          {overall.pace.pace !== null
            ? ` (${overall.pace.pace.toFixed(1)} times the standard pace)`
            : ""}
          , from {overall.pace.learnedSkills}{" "}
          {overall.pace.learnedSkills === 1 ? "skill" : "skills"} that{" "}
          {overall.pace.learnedSkills === 1 ? "was" : "were"} new to {firstName} this term. Another{" "}
          {overall.pace.knownSkills} went fluent that {firstName} already knew:{" "}
          {overall.pace.knownMonths.toFixed(1)} months.
        </Text>
      )}
      <VStack align="stretch" gap={1.5} mt={3}>
        {bands.map((b) => (
          <Flex key={b.rank} align="center" gap={3}>
            <Text fontFamily="body" fontSize="xs" color="charcoal.500" w="92px" flexShrink={0}>
              {b.rank <= 0 ? "Kindergarten" : `Grade ${gradeLabelFromRank(b.rank)}`}
            </Text>
            <Flex
              flex="1"
              h="8px"
              borderRadius="full"
              bg="gray.100"
              overflow="hidden"
              role="img"
              aria-label={`${b.daily} shown in daily work and ${b.placement} from placement, of ${b.total} skills`}
            >
              <Box bg="violet.500" w={`${(100 * b.daily) / b.total}%`} />
              <Box bg="violet.200" w={`${(100 * b.placement) / b.total}%`} />
            </Flex>
            <Text
              fontFamily="body"
              fontSize="2xs"
              color="charcoal.400"
              w="64px"
              textAlign="right"
              flexShrink={0}
              fontVariantNumeric="tabular-nums"
            >
              {b.daily + b.placement} of {b.total}
            </Text>
          </Flex>
        ))}
      </VStack>
      <HStack gap={4} mt={2.5} wrap="wrap">
        <HStack gap={1.5}>
          <Box w="10px" h="10px" borderRadius="sm" bg="violet.500" />
          <Text fontFamily="body" fontSize="2xs" color="charcoal.400">
            Shown in daily work
          </Text>
        </HStack>
        <HStack gap={1.5}>
          <Box w="10px" h="10px" borderRadius="sm" bg="violet.200" />
          <Text fontFamily="body" fontSize="2xs" color="charcoal.400">
            Placement check-in
          </Text>
        </HStack>
      </HStack>
      <Text fontFamily="body" fontSize="2xs" color="charcoal.300" mt={2}>
        The level adds up the share of each grade&apos;s skills {firstName} is credited
        with, across every area of math. All of kindergarten through grade 4 reads 5.0.
      </Text>
    </Box>
  );
}

const RANK_MAX = 13; // grade-equivalent span K(0)…12.9 → the sparkline's 0–1 domain.

/** "Kai" from "Kai Nakamura", for first-name framing on both portrait screens. */
export function portraitFirstName(scholarName: string): string {
  return (scholarName || "").trim().split(/\s+/)[0] || "This scholar";
}

/** The loading spinner, or the no-practice-yet state, shared by both portrait
 *  screens. Null once there is a portrait with at least one area to show. */
export function PortraitPending({
  portrait,
  firstName,
}: {
  portrait: MathPortrait | undefined;
  firstName: string;
}) {
  if (portrait === undefined) {
    return (
      <Flex justify="center" py={10}>
        <Spinner size="md" color="violet.400" />
      </Flex>
    );
  }
  if (portrait.domains.length > 0) return null;
  return (
    <VStack gap={2} py={12} textAlign="center" color="charcoal.400" maxW="md" mx="auto">
      <Text fontFamily="heading" fontSize="sm" color="charcoal.500">
        No math practice yet
      </Text>
      <Text fontFamily="body" fontSize="sm">
        Grade levels will appear here as {firstName} starts practicing — a
        picture of how far they&apos;ve come, one domain at a time.
      </Text>
    </VStack>
  );
}

/** "What is <name> working on in math?" — seeds the one chat on the screen. */
export function AskAboutMathButton({
  firstName,
  onAskAi,
}: {
  firstName: string;
  onAskAi: (question: string) => void;
}) {
  return (
    <Box>
      <Button
        size="sm"
        variant="outline"
        colorPalette="violet"
        fontFamily="heading"
        fontWeight="600"
        onClick={() => onAskAi(`What is ${firstName} working on in math?`)}
      >
        <ChatCircleText size={16} />
        What is {firstName} working on in math?
      </Button>
    </Box>
  );
}

export function MathSkillsPortrait({
  portrait,
  scholarName,
  onAskAi,
}: MathSkillsPortraitProps) {
  const firstName = portraitFirstName(scholarName);

  if (portrait === undefined || portrait.domains.length === 0) {
    return <PortraitPending portrait={portrait} firstName={firstName} />;
  }

  return (
    <VStack align="stretch" gap={4} maxW="720px">
      <Text fontFamily="body" fontSize="sm" color="charcoal.500">
        How far {firstName} has come in each area of math — and where they&apos;re
        pulled next.
      </Text>

      {portrait.overall && <OverallLevel overall={portrait.overall} asOfMs={portrait.asOfMs} firstName={firstName} />}

      <VStack align="stretch" gap={2.5}>
        {portrait.domains.map((d) => {
          const values = d.series.map((p) =>
            p.value === null ? NaN : p.value / RANK_MAX,
          );
          const knownPoints = d.series.filter((p) => p.value !== null).length;
          const detail = domainDetailLine(d);
          return (
            <Box
              key={d.domain}
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="lg"
              bg="white"
              px={4}
              py={3}
            >
              <Flex align="baseline" justify="space-between" gap={3}>
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="600"
                  color="charcoal.700"
                >
                  {d.label}
                </Text>
                <Text
                  fontFamily="heading"
                  fontSize="lg"
                  fontWeight="700"
                  color={d.gradeLabel ? "violet.600" : "charcoal.300"}
                  fontVariantNumeric="tabular-nums"
                  flexShrink={0}
                >
                  {d.gradeLabel ?? "In progress"}
                </Text>
              </Flex>

              <Flex align="center" justify="space-between" gap={3} mt={1.5}>
                <HStack gap={2} minH="22px">
                  {d.growth ? (
                    <>
                      <TrendUp size={15} weight="bold" color="var(--chakra-colors-green-600)" />
                      <Text fontFamily="body" fontSize="xs" color="green.700" fontWeight="500">
                        up from {d.growth.fromLabel} to {d.growth.toLabel}
                      </Text>
                    </>
                  ) : d.gradeLabel ? (
                    <Text fontFamily="body" fontSize="xs" color="charcoal.400">
                      Building history — growth shows as {firstName} keeps practicing
                    </Text>
                  ) : (
                    <Text fontFamily="body" fontSize="xs" color="charcoal.400">
                      Just getting started
                    </Text>
                  )}
                </HStack>

                <HStack gap={3} flexShrink={0}>
                  {d.growth && knownPoints > 1 && (
                    <Sparkline
                      values={values}
                      band={null}
                      lineColor="var(--chakra-colors-green-500)"
                      endColor="var(--chakra-colors-green-600)"
                      ariaLabel={`${d.label} grade trend, now ${d.gradeLabel}`}
                    />
                  )}
                </HStack>
              </Flex>
              {detail && (
                <Text fontFamily="body" fontSize="2xs" color="charcoal.400" mt={1}>
                  {detail}
                </Text>
              )}
            </Box>
          );
        })}
      </VStack>

      <Text fontFamily="body" fontSize="2xs" color="charcoal.300">
        Each level adds up how much of each grade&apos;s skills in that area{" "}
        {firstName} has covered. Skills credited by the placement check-in count
        toward it and are shown separately, and &ldquo;highest&rdquo; is the
        hardest grade in which {firstName} has shown a skill in daily work.
      </Text>

      {onAskAi && <AskAboutMathButton firstName={firstName} onAskAi={onAskAi} />}
    </VStack>
  );
}
