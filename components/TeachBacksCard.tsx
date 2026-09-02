"use client";

import { Box, Text, HStack, VStack, Button } from "@chakra-ui/react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Teach-backs card — the TEACHER-ONLY surface for a session's teach-backs
 * (scholar-as-teacher vivas). Shows the concept, date, the four 0–3 rubric
 * dimensions (a teacher-only score of the scholar's EXPLANATION — never shown
 * to the kid), the teacher summary, and a "reviewed" toggle.
 *
 * `listForSession` / `setReviewed` are teacher-gated (teacherQuery/Mutation), so
 * this must only be rendered/queried in a teacher context — mounted from
 * SessionInterface's REMOTE (teacher-viewing-as-scholar) mode, where the query
 * is `enabled`. A scholar viewing their own session passes `enabled={false}`,
 * skipping the query entirely (belt-and-suspenders with the server-side gate).
 * Renders nothing when there are no teach-backs for the session.
 */

type TeachBackRubricShape = {
  completeness: number;
  causalChain: number;
  example: number;
  handledProbes: number;
  summary: string;
};

interface TeachBackItem {
  id: string;
  conceptLabel: string;
  status: "active" | "graded";
  rubric: TeachBackRubricShape | null;
  teacherReviewed: boolean;
  createdAt: number;
  gradedAt: number | null;
}

const RUBRIC_DIMENSIONS: { key: keyof TeachBackRubricShape & string; label: string }[] = [
  { key: "completeness", label: "Completeness" },
  { key: "causalChain", label: "Causal chain" },
  { key: "example", label: "Example use" },
  { key: "handledProbes", label: "Handled probes" },
];

function RubricBar({ label, score }: { label: string; score: number }) {
  return (
    <HStack gap={2} align="center">
      <Text
        fontSize="2xs"
        color="charcoal.500"
        fontFamily="heading"
        w="88px"
        flexShrink={0}
      >
        {label}
      </Text>
      <HStack gap="3px" flex={1}>
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            h="6px"
            flex={1}
            borderRadius="full"
            bg={i < score ? "teal.500" : "teal.100"}
          />
        ))}
      </HStack>
      <Text fontSize="2xs" color="teal.700" fontWeight="700" w="24px" textAlign="right">
        {score}/3
      </Text>
    </HStack>
  );
}

function TeachBackRow({
  teachBack,
  onToggleReviewed,
}: {
  teachBack: TeachBackItem;
  onToggleReviewed: (reviewed: boolean) => void;
}) {
  const date = new Date(teachBack.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return (
    <Box>
      <HStack justify="space-between" align="start" mb={1}>
        <Text fontSize="sm" fontWeight="600" color="navy.600">
          {teachBack.conceptLabel}
        </Text>
        <Text fontSize="2xs" color="charcoal.400" flexShrink={0} pt="2px">
          {date}
        </Text>
      </HStack>
      {teachBack.rubric ? (
        <>
          <VStack gap={1} align="stretch" mb={2}>
            {RUBRIC_DIMENSIONS.map((d) => (
              <RubricBar
                key={d.key}
                label={d.label}
                score={teachBack.rubric![d.key] as number}
              />
            ))}
          </VStack>
          <Text fontSize="xs" color="charcoal.600" fontFamily="body" mb={2}>
            {teachBack.rubric.summary}
          </Text>
          <HStack justify="flex-end">
            <Button
              size="2xs"
              variant={teachBack.teacherReviewed ? "solid" : "outline"}
              colorPalette="teal"
              fontFamily="heading"
              onClick={() => onToggleReviewed(!teachBack.teacherReviewed)}
            >
              {teachBack.teacherReviewed ? "✓ Reviewed" : "Mark reviewed"}
            </Button>
          </HStack>
        </>
      ) : (
        <Text fontSize="xs" color="charcoal.400" fontStyle="italic">
          Explanation recorded — grading in progress…
        </Text>
      )}
    </Box>
  );
}

export function TeachBacksCard({
  sessionId,
  enabled = true,
}: {
  sessionId: Id<"sessions">;
  enabled?: boolean;
}) {
  const teachBacks = useQuery(
    api.teachBacks.listForSession,
    enabled ? { sessionId } : "skip",
  );
  const setReviewed = useMutation(api.teachBacks.setReviewed);

  if (!teachBacks || teachBacks.length === 0) return null;

  return (
    <Box
      p={3}
      bg="teal.50"
      borderRadius="lg"
      borderWidth="1px"
      borderColor="teal.200"
    >
      <Text
        fontSize="xs"
        fontWeight="700"
        fontFamily="heading"
        color="teal.700"
        textTransform="uppercase"
        letterSpacing="0.04em"
        mb={2}
      >
        Teach-backs
      </Text>
      <VStack gap={3} align="stretch">
        {teachBacks.map((tb) => (
          <TeachBackRow
            key={tb.id}
            teachBack={tb}
            onToggleReviewed={(reviewed) =>
              setReviewed({ id: tb.id as Id<"teachBacks">, reviewed })
            }
          />
        ))}
      </VStack>
    </Box>
  );
}
