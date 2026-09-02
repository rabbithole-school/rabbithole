"use client";

/**
 * SharedNarratives — parent-facing shared Whole Child + course narratives
 * (review/assessment-and-goals-plan.html §11 "Delivery to parents").
 *
 * PROSE ONLY: parents.childSharedNarratives already omits the 1–7 PCM
 * ratings, the Course Performance Rating, the AI's rating suggestion, and
 * the Working Level — a parent sees the teacher's writing and the accepted
 * goals, never a number, and never anything that compares their child to
 * classmates. Only `status: "shared"` narratives come back at all; a
 * narrative still in draft/final-but-unshared simply isn't in the response.
 *
 * Guardian-gated server side (requireGuardianOf) — a parent only ever sees
 * their own linked children, same as every other ParentDashboard surface.
 */
import { useQuery } from "convex/react";
import Link from "next/link";
import { format } from "date-fns";
import {
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Printer } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type NarrativeSection = { key: string; title: string; body: string };
type SharedNarrative = {
  _id: string;
  periodLabel: string;
  sharedAt: number;
  sections: NarrativeSection[];
  goals: string[];
};

export default function SharedNarratives({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const data = useQuery(api.parents.childSharedNarratives, { scholarId });

  if (data === undefined) {
    return (
      <Flex justify="center" py={8}>
        <Spinner size="md" color="violet.400" />
      </Flex>
    );
  }

  const { course, wholeChild } = data;
  const isEmpty = course.length === 0 && wholeChild.length === 0;

  return (
    <VStack align="stretch" gap={5}>
      <Flex align="center" justify="space-between" gap={3} flexWrap="wrap">
        <Stack gap={0.5}>
          <Heading size="sm" fontFamily="heading" color="navy.500">
            Shared narratives
          </Heading>
          <Text fontFamily="body" fontSize="xs" color="charcoal.400">
            Your child&apos;s teacher-written progress notes, shared at the end
            of each reporting period.
          </Text>
        </Stack>
        {!isEmpty && (
          <Link
            href={`/print/narrative/${scholarId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button
              size="sm"
              variant="outline"
              borderColor="gray.200"
              fontFamily="heading"
              fontWeight="600"
              color="charcoal.600"
              _hover={{ borderColor: "violet.300", bg: "violet.50" }}
            >
              <Printer size={14} weight="bold" style={{ marginRight: 6 }} />
              Print / Save PDF
            </Button>
          </Link>
        )}
      </Flex>

      {isEmpty ? (
        <Box
          bg="white"
          borderRadius="xl"
          borderWidth="1px"
          borderColor="gray.200"
          p={6}
        >
          <Text fontFamily="body" fontSize="sm" color="charcoal.300">
            Nothing has been shared yet — your child&apos;s teacher publishes
            these at the end of each reporting period.
          </Text>
        </Box>
      ) : (
        <>
          {wholeChild.map((n) => (
            <NarrativeCard
              key={n._id}
              title="Whole Child"
              narrative={n}
            />
          ))}
          {course.map((n) => (
            <NarrativeCard key={n._id} title={n.subject} narrative={n} />
          ))}
        </>
      )}
    </VStack>
  );
}

function NarrativeCard({
  title,
  narrative,
}: {
  title: string;
  narrative: SharedNarrative;
}) {
  return (
    <Box
      bg="white"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="gray.200"
      p={6}
    >
      <Flex justify="space-between" align="baseline" gap={3} flexWrap="wrap" mb={3}>
        <Heading size="sm" fontFamily="heading" color="navy.500">
          {title}
        </Heading>
        <Text fontFamily="body" fontSize="xs" color="charcoal.300">
          {narrative.periodLabel} · shared{" "}
          {format(new Date(narrative.sharedAt), "MMM d, yyyy")}
        </Text>
      </Flex>

      <Stack gap={4}>
        {narrative.sections.map((s) => (
          <Box key={s.key}>
            <Text
              fontFamily="heading"
              fontWeight="600"
              fontSize="sm"
              color="charcoal.600"
              mb={1}
            >
              {s.title}
            </Text>
            <Text
              fontFamily="body"
              fontSize="sm"
              color="charcoal.500"
              lineHeight="1.6"
              whiteSpace="pre-wrap"
            >
              {s.body}
            </Text>
          </Box>
        ))}

        {narrative.goals.length > 0 && (
          <Box borderTopWidth="1px" borderColor="gray.100" pt={3}>
            <Text
              fontFamily="heading"
              fontWeight="600"
              fontSize="xs"
              textTransform="uppercase"
              letterSpacing="wide"
              color="charcoal.400"
              mb={2}
            >
              Goals for continued growth
            </Text>
            <Stack gap={1.5}>
              {narrative.goals.map((g, i) => (
                <HStack key={i} gap={2} align="flex-start">
                  <Box
                    mt={2}
                    w="4px"
                    h="4px"
                    borderRadius="full"
                    bg="violet.300"
                    flexShrink={0}
                  />
                  <Text fontFamily="body" fontSize="sm" color="charcoal.600">
                    {g}
                  </Text>
                </HStack>
              ))}
            </Stack>
          </Box>
        )}
      </Stack>
    </Box>
  );
}
