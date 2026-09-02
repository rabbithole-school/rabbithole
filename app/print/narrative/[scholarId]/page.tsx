"use client";

/**
 * `/print/narrative/[scholarId]` — the conference PDF (review/assessment-
 * and-goals-plan.html §11 "Delivery to parents"): a clean, print-optimized
 * rendering of a child's SHARED narratives, meant to be turned into a PDF
 * via the browser's own print dialog (Cmd/Ctrl+P → Save as PDF). PROSE
 * ONLY, same as the portal card — no ratings, no Working Level, nothing
 * that could compare this child to a classmate.
 *
 * Access: reads api.parents.childSharedNarratives, the SAME guardian-gated
 * query the parent-portal card uses (requireGuardianOf — own children
 * only). This route does no additional role-gating of its own: a linked
 * guardian sees the report whether their account's primary role is
 * `parent` or a staffer who is ALSO a guardian of their own child (the
 * guardian check is table-based, not role-based — see convex/lib/auth.ts).
 * Anyone else — including staff with no guardian link to this scholar —
 * gets the query's "Forbidden" error, caught here and rendered as a plain
 * "not available" state so no family's data ever leaks to the wrong
 * viewer.
 */
import { use } from "react";
import { useQuery } from "convex/react";
import { format } from "date-fns";
import {
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Printer } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppLogo } from "@/components/AppLogo";

type NarrativeSection = { key: string; title: string; body: string };
type SharedNarrative = {
  _id: string;
  periodLabel: string;
  sharedAt: number;
  sections: NarrativeSection[];
  goals: string[];
};

export default function PrintNarrativePage({
  params,
}: {
  params: Promise<{ scholarId: string }>;
}) {
  const { scholarId } = use(params);
  const { isLoading, isAuthenticated } = useCurrentUser();

  if (isLoading) {
    return (
      <Flex minH="50vh" align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  if (!isAuthenticated) {
    return (
      <Flex minH="50vh" align="center" justify="center">
        <Text fontFamily="heading" color="charcoal.500">
          Please sign in to view this report.
        </Text>
      </Flex>
    );
  }

  return (
    <ErrorBoundary fallbackMessage="This report isn't available.">
      <PrintNarrativeBody scholarId={scholarId as Id<"users">} />
    </ErrorBoundary>
  );
}

function PrintNarrativeBody({ scholarId }: { scholarId: Id<"users"> }) {
  const summary = useQuery(api.parents.childSummary, { scholarId });
  const data = useQuery(api.parents.childSharedNarratives, { scholarId });

  if (data === undefined || summary === undefined) {
    return (
      <Flex minH="50vh" align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  const { course, wholeChild } = data;
  const isEmpty = course.length === 0 && wholeChild.length === 0;

  return (
    <Box bg="white" minH="100vh">
      {/* @page margins for the browser's print/PDF output — Chakra's style
          props can't reach the @page at-rule, so this stays a plain tag. */}
      <style>{`@page { margin: 0.75in; }`}</style>

      {/* On-screen-only toolbar; hidden entirely when printing. */}
      <Flex
        _print={{ display: "none" }}
        justify="space-between"
        align="center"
        px={6}
        py={4}
        borderBottomWidth="1px"
        borderColor="gray.200"
        bg="gray.50"
        position="sticky"
        top={0}
      >
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          This is a print-ready view. Use your browser&apos;s print dialog to
          save it as a PDF.
        </Text>
        {!isEmpty && (
          <Button
            size="sm"
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            fontWeight="600"
            onClick={() => window.print()}
          >
            <Printer size={14} weight="bold" style={{ marginRight: 6 }} />
            Print / Save PDF
          </Button>
        )}
      </Flex>

      <VStack align="stretch" gap={8} maxW="720px" mx="auto" px={8} py={10}>
        {/* Masthead */}
        <Stack gap={1} borderBottomWidth="2px" borderColor="navy.500" pb={4}>
          <HStack gap={2}>
            <AppLogo size={28} />
            <Text fontFamily="heading" fontWeight="700" color="navy.500">
              Rabbithole
            </Text>
          </HStack>
          <Heading size="lg" fontFamily="heading" color="navy.500">
            {summary?.name ?? "Learning Narrative"}
          </Heading>
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            Learning narrative report
          </Text>
        </Stack>

        {isEmpty ? (
          <Text fontFamily="body" fontSize="sm" color="charcoal.300">
            Nothing has been shared for this scholar yet.
          </Text>
        ) : (
          <>
            {wholeChild.map((n) => (
              <PrintNarrativeSection key={n._id} title="Whole Child" narrative={n} />
            ))}
            {course.map((n) => (
              <PrintNarrativeSection key={n._id} title={n.subject} narrative={n} />
            ))}
          </>
        )}
      </VStack>
    </Box>
  );
}

function PrintNarrativeSection({
  title,
  narrative,
}: {
  title: string;
  narrative: SharedNarrative;
}) {
  return (
    <Box style={{ breakInside: "avoid" }}>
      <Flex justify="space-between" align="baseline" gap={3} flexWrap="wrap" mb={2}>
        <Heading size="md" fontFamily="heading" color="navy.500">
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
