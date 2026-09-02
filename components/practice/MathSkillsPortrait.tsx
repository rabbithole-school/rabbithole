"use client";

import { Box, Button, Flex, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { TrendUp, ChatCircleText } from "@phosphor-icons/react";
import { Sparkline } from "@/components/Sparkline";
import type { MathPortrait } from "@/convex/mathPortrait";

/**
 * The Math Skills PORTRAIT — one shared, presentational surface mounted on both
 * the teacher per-scholar subtab and the parent portal. Per math domain the
 * scholar has touched: the demonstrated-fluent grade level and, where we have
 * real history, its month-over-month growth. Pure/props-only so the two mounts
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

const RANK_MAX = 13; // grade-equivalent span K(0)…12.9 → the sparkline's 0–1 domain.

export function MathSkillsPortrait({
  portrait,
  scholarName,
  onAskAi,
}: MathSkillsPortraitProps) {
  const firstName = (scholarName || "").trim().split(/\s+/)[0] || "This scholar";

  if (portrait === undefined) {
    return (
      <Flex justify="center" py={10}>
        <Spinner size="md" color="violet.400" />
      </Flex>
    );
  }

  if (portrait.domains.length === 0) {
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

  return (
    <VStack align="stretch" gap={4} maxW="720px">
      <Text fontFamily="body" fontSize="sm" color="charcoal.500">
        How far {firstName} has come in each area of math — and where they&apos;re
        pulled next.
      </Text>

      <VStack align="stretch" gap={2.5}>
        {portrait.domains.map((d) => {
          const values = d.series.map((p) =>
            p.value === null ? NaN : p.value / RANK_MAX,
          );
          const knownPoints = d.series.filter((p) => p.value !== null).length;
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
                  {d.fluentSkills > 0 && (
                    <Text
                      fontFamily="body"
                      fontSize="2xs"
                      color="charcoal.400"
                      whiteSpace="nowrap"
                    >
                      {d.fluentSkills} {d.fluentSkills === 1 ? "skill" : "skills"} fluent
                    </Text>
                  )}
                </HStack>
              </Flex>
            </Box>
          );
        })}
      </VStack>

      <Text fontFamily="body" fontSize="2xs" color="charcoal.300">
        Grade levels reflect the skills {firstName} has shown fluently — a picture
        of growth, not a score.
      </Text>

      {onAskAi && (
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
      )}
    </VStack>
  );
}
