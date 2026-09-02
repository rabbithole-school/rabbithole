"use client";

import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Flex,
  Heading,
  Portal,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { CheckCircle, Question, XCircle } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Surface } from "@/components/ui/Surface";
import { RecentMissEntry } from "@/components/practice/RecentMisses";

type RecentAttempt = {
  attemptId: string;
  at: number;
  skillKey: string;
  skillLabel: string;
  stemSnapshot?: string;
  answerText?: string;
  expectedAnswer?: string;
  correct: boolean;
  dontKnow?: boolean;
  retry?: boolean;
  lane?: string;
  errorPattern?: string;
  workImageUrl?: string;
};

const LANE_LABELS: Record<string, string> = {
  review: "Review",
  frontier: "New skill",
  confirmation: "Check-in confirmation",
  placement: "Check-in",
  reprobe: "Check-in recheck",
  tuneup: "Tune-up",
  challenge: "Stretch",
  stretch: "Stretch",
  chat: "Chat practice",
};

/** A typed answer renders as-is; a structured/manipulative answer state is
 *  JSON — show its value only when it's a trivial one-field state, otherwise
 *  omit it rather than print raw JSON at a teacher. */
function displayAnswer(answerText: string | undefined): string | undefined {
  if (answerText === undefined || !answerText.startsWith("{")) return answerText;
  try {
    const parsed: unknown = JSON.parse(answerText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed);
      if (values.length === 1 && ["string", "number"].includes(typeof values[0])) {
        return String(values[0]);
      }
    }
  } catch {
    return answerText;
  }
  return undefined;
}

function formatAttemptTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

/** Same mark language as the scholar-side practice card: filled teal check
 *  for correct, orange (never red) for a miss. */
function AttemptMark({
  correct,
  dontKnow,
}: {
  correct: boolean;
  dontKnow?: boolean;
}) {
  const label = dontKnow ? "Has not learned this yet" : correct ? "Correct" : "Incorrect";
  return (
    <Flex
      as="span"
      align="center"
      flexShrink={0}
      color={dontKnow ? "charcoal.500" : correct ? "teal.600" : "orange.500"}
      aria-label={label}
    >
      {dontKnow ? (
        <Question size={16} weight="bold" />
      ) : correct ? (
        <CheckCircle size={16} weight="fill" />
      ) : (
        <XCircle size={16} weight="fill" />
      )}
    </Flex>
  );
}

/** One slim feed row: mark + skill + time, with a one-line stem preview.
 *  The full Q&A (their answer, the expected one, the error pattern, their
 *  working) lives behind a click — `RecentMissEntry` renders it in a dialog. */
function AttemptRow({ attempt, onOpen }: { attempt: RecentAttempt; onOpen: () => void }) {
  return (
    <Button
      type="button"
      variant="plain"
      display="block"
      w="full"
      h="auto"
      minW={0}
      textAlign="left"
      py={{ base: 2.5, md: 3 }}
      onClick={onOpen}
      cursor="pointer"
      _notLast={{ borderBottomWidth: "1px", borderColor: "gray.100" }}
      _hover={{ bg: "gray.50" }}
    >
      <Flex align="center" gap={2}>
        <AttemptMark correct={attempt.correct} dontKnow={attempt.dontKnow} />
        <Text fontSize="sm" fontWeight="600" color="charcoal.700" flex="1" lineClamp={1}>
          {attempt.skillLabel}
        </Text>
        <Text fontSize="xs" color="charcoal.500" flexShrink={0}>
          {formatAttemptTime(attempt.at)}
        </Text>
      </Flex>
      {attempt.stemSnapshot && (
        <Text fontSize="xs" color="charcoal.500" lineClamp={1} mt={0.5} pl="24px">
          {attempt.stemSnapshot}
        </Text>
      )}
    </Button>
  );
}

export function RecentPracticeFeed({
  scholarId,
  domain,
}: {
  scholarId: string;
  domain: string;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.practiceSkills.recentAttemptsForDomain,
    { scholarId: scholarId as Id<"users">, domain },
    { initialNumItems: 12 },
  );
  const [selected, setSelected] = useState<RecentAttempt | null>(null);
  // Reserve the empty state for exhausted pagination — transient page states
  // (first load, an in-flight loadMore, a server-split page) can momentarily
  // hold zero rows for a scholar who has attempts.
  const stillLoading = results.length === 0 && status !== "Exhausted";

  return (
    <Surface as="section" aria-labelledby="recent-practice-heading" p={0} overflow="hidden" mb={4}>
      <Box px={{ base: 4, md: 5 }} pt={{ base: 4, md: 5 }}>
        <Heading as="h2" id="recent-practice-heading" size="sm" color="charcoal.700">
          Recent practice
        </Heading>
        <Text fontSize="xs" color="charcoal.500" mt={1}>
          Attempts in this domain, newest first. Select one for the full problem and answer.
        </Text>
      </Box>
      {stillLoading ? (
        <Flex align="center" gap={2} px={{ base: 4, md: 5 }} py={6}>
          <Spinner size="sm" color="violet.500" />
          <Text fontSize="sm" color="charcoal.500">Loading recent practice…</Text>
        </Flex>
      ) : results.length === 0 ? (
        <Box px={{ base: 4, md: 5 }}>
          <EmptyState
            title="No practice attempts yet"
            hint="Attempts in this domain will appear here."
          />
        </Box>
      ) : (
        <>
          <Box px={{ base: 4, md: 5 }} pb={1}>
            {results.map((attempt) => (
              <AttemptRow
                key={attempt.attemptId}
                attempt={attempt}
                onOpen={() => setSelected(attempt)}
              />
            ))}
          </Box>
          {status !== "Exhausted" && (
            <Box px={{ base: 4, md: 5 }} pb={{ base: 4, md: 5 }}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => loadMore(12)}
                loading={status === "LoadingMore"}
                loadingText="Loading more"
              >
                Load more
              </Button>
            </Box>
          )}
        </>
      )}
      {/* Stably mounted (never key-remounted while open — the Ark body-lock
          gotcha); reuses the canonical RecentMissEntry Q&A vocabulary. */}
      <Dialog.Root
        open={!!selected}
        onOpenChange={(d) => !d.open && setSelected(null)}
        size="sm"
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content bg="white" rounded="xl" p={4}>
              {selected && (
                <>
                  <Flex align="center" gap={2} mb={2} pr={8}>
                    <AttemptMark correct={selected.correct} dontKnow={selected.dontKnow} />
                    <Dialog.Title asChild>
                      <Text fontSize="sm" fontWeight="700" color="charcoal.700">
                        {selected.skillLabel}
                      </Text>
                    </Dialog.Title>
                  </Flex>
                  <RecentMissEntry
                    miss={{
                      nodeKey: selected.skillKey,
                      at: selected.at,
                      stemSnapshot: selected.stemSnapshot,
                      answerText: displayAnswer(selected.answerText),
                      expectedAnswer: selected.expectedAnswer,
                      workImageUrl: selected.workImageUrl,
                      errorPattern: selected.errorPattern,
                    }}
                  />
                  {(selected.retry || selected.lane) && (
                    <Text fontSize="xs" color="charcoal.500" mt={2}>
                      {selected.retry
                        ? "Retry (not scored)"
                        : LANE_LABELS[selected.lane!] ?? "Practice"}
                    </Text>
                  )}
                  {selected.dontKnow && (
                    <Text fontSize="xs" color="charcoal.500" mt={2}>
                      Hasn&rsquo;t learned this yet
                    </Text>
                  )}
                </>
              )}
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" position="absolute" top={2} insetEnd={2} />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Surface>
  );
}
