"use client";

/**
 * PcmCoverageCard — the unit's Preflight/Review surface (review/assessment-
 * and-goals-plan.html §2/§4). Reads unitReviews.pcmCoverage: a DETERMINISTIC
 * check of whether each PCM dimension (Core / Connections / Practice /
 * Identity) has at least one activity that gives a scholar room to produce
 * assessable evidence. A unit that's all Core-shaped gets flagged here,
 * months before a narrative is due — Carl's "you can't assess a dimension
 * the curriculum never made room for" dependency.
 *
 * Styled to sit beside UnitReviewView's EQ/EU coverage banner (same white-
 * card-with-row-dividers language, same verdict badge palette) so a unit's
 * Preflight surfaces both kinds of gap consistently.
 */
import { useQuery } from "convex/react";
import { Badge, Box, Flex, Spinner, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PCM_META, type PcmDimension } from "@/convex/lib/pcm";

type Verdict = "covered" | "weak" | "uncovered";

const VERDICT_STYLE: Record<Verdict, { label: string; bg: string; color: string }> = {
  covered: { label: "Covered", bg: "green.100", color: "green.700" },
  weak: { label: "Weak", bg: "orange.100", color: "orange.700" },
  uncovered: { label: "Uncovered", bg: "red.100", color: "red.700" },
};

export default function PcmCoverageCard({ unitId }: { unitId: Id<"units"> }) {
  const result = useQuery(api.unitReviews.pcmCoverage, { unitId });

  if (result === undefined) {
    return (
      <Flex align="center" justify="center" py={6}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  const { coverage, untaggedLessons, note } = result;
  const anyGap = coverage.some((c) => c.verdict !== "covered");

  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      overflow="hidden"
    >
      <Stack gap={0.5} px={4} pt={3} pb={2}>
        <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.500">
          PCM Coverage
        </Text>
        <Text fontSize="xs" color="charcoal.400">
          Can a scholar produce evidence in every dimension this unit will be
          assessed on?
        </Text>
      </Stack>

      <Stack gap={0}>
        {coverage.map((row) => {
          const meta = PCM_META[row.dimension as PcmDimension];
          const style = VERDICT_STYLE[row.verdict as Verdict] ?? VERDICT_STYLE.weak;
          return (
            <Flex
              key={row.dimension}
              gap={3}
              px={4}
              py={3}
              borderTopWidth="1px"
              borderColor="gray.100"
              align="flex-start"
            >
              <Badge
                bg={style.bg}
                color={style.color}
                fontFamily="heading"
                fontSize="2xs"
                flexShrink={0}
                mt={0.5}
              >
                {style.label}
              </Badge>
              <Stack gap={0.5} flex={1} minW={0}>
                <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="charcoal.600">
                  {meta?.label ?? row.dimension}
                </Text>
                {meta?.blurb && (
                  <Text fontSize="xs" color="charcoal.400">
                    {meta.blurb}
                  </Text>
                )}
                <Text fontSize="xs" color="charcoal.300" userSelect="none">
                  {row.lessonCount} lesson{row.lessonCount === 1 ? "" : "s"} ·{" "}
                  {row.activityCount} activit
                  {row.activityCount === 1 ? "y" : "ies"}
                </Text>
              </Stack>
            </Flex>
          );
        })}
      </Stack>

      <Box
        px={4}
        py={3}
        borderTopWidth="1px"
        borderColor="gray.100"
        bg={anyGap ? "orange.50" : "green.50"}
      >
        <Text fontSize="xs" color="charcoal.500">
          {note}
        </Text>
        {untaggedLessons > 0 && (
          <Text fontSize="2xs" color="charcoal.300" mt={1}>
            {untaggedLessons} lesson{untaggedLessons === 1 ? "" : "s"} without
            a PCM strand tag.
          </Text>
        )}
      </Box>
    </Box>
  );
}
