"use client";

/**
 * The Scholar's Prep tab — two plain questions on one surface style:
 *
 *   1. "Done today?"  — the close-out of today's still-open activities/quests:
 *                       "✓ Done" (`takeHomePlans.resolveSuggestion`, with a
 *                       durable Undo) or "Keep it open"
 *                       (`takeHomePlans.keepSuggestionOpen`, stop asking today).
 *   2. "Keep going · from your Quests" — the top rows of the scholar's ONE
 *                       queue (`questionQueue.forSelf`), rendered by the same
 *                       row component the Quests tab uses, here with its
 *                       corner × (`dismissable`) to dismiss a row for good.
 *
 * Homework is not here. It used to have a "Due" section on this tab; every
 * homework item now lives in the Homework section on the Now tab
 * (shared/homeworkList.ts), its one home.
 *
 * The old "To do tonight" plan list (adding quests / activities / notes to
 * tonight, "Chosen") is RETIRED. Section 1 reads `api.takeHomePlans.forSelf`
 * (its `suggestions` / `resolvedToday`).
 *
 * Native twin: native/src/components/ScholarPrepSections.tsx. Copy:
 * shared/questionQueue.ts.
 */

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Box, Button, Flex, Grid, HStack, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Eyebrow,
  QueueSurface,
  QuestionQueueRowView,
  useQuestionQueue,
} from "@/components/QuestionQueue";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { toaster } from "@/lib/toaster";
import { PREP_KEEP_GOING_COUNT, QUESTION_QUEUE_COPY } from "@/shared/questionQueue";

type Plan = FunctionReturnType<typeof api.takeHomePlans.forSelf>;
type Suggestion = Plan["suggestions"][number];

const MINUTE_MS = 60_000;
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const TOUCH = "48px";
const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "2px",
} as const;

const suggestionArg = (item: Suggestion) =>
  item.kind === "activity"
    ? { kind: "activity" as const, sessionId: item.sessionId }
    : { kind: "quest" as const, unitId: item.unitId };

export function ScholarPrepSections({
  onStartTeacherQuest,
  startingSeedId,
}: {
  onStartTeacherQuest: (seedId: Id<"seeds">) => void;
  startingSeedId: string | null;
}) {
  // Minute-rounded clock as the query's reactive dependency (T11): the plan
  // re-runs across the institution-local midnight.
  const [now, setNow] = useState(() => floorToMinute(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setNow(floorToMinute(Date.now())), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  const plan = useSmoothedQuery(api.takeHomePlans.forSelf, { now });
  const queue = useQuestionQueue();

  const resolveSuggestion = useMutation(api.takeHomePlans.resolveSuggestion);
  const keepSuggestionOpen = useMutation(api.takeHomePlans.keepSuggestionOpen);
  const undoResolveSuggestion = useMutation(api.takeHomePlans.undoResolveSuggestion);
  const [pending, setPending] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>, failure: string) => {
    if (pending) return;
    setPending(key);
    try {
      await action();
    } catch (error) {
      console.error("[scholar-prep]", error);
      toaster.error({ title: failure, description: "Please try again." });
    } finally {
      setPending(null);
    }
  };

  // A non-scholar (teacher preview) gets the empty plan shape back.
  const planReady = plan !== undefined && plan.dayKey !== null;
  const keepGoing = (queue.rows ?? []).slice(0, PREP_KEEP_GOING_COUNT);
  const closeOutRows = planReady
    ? plan.suggestions.length + plan.resolvedToday.length
    : 0;

  return (
    <Stack gap={3}>
      {/* ── 1. Done today? ─────────────────────────────────────────── */}
      {planReady && closeOutRows > 0 && (
        <QueueSurface>
          <Eyebrow>{QUESTION_QUEUE_COPY.prepDoneToday}</Eyebrow>
          {plan.suggestions.length > 0 && (
            <Text px={4} pb={1} fontSize="sm" color="charcoal.500">
              {QUESTION_QUEUE_COPY.prepDoneTodayHint}
            </Text>
          )}
          {plan.suggestions.map((item, index) => (
            <Box
              key={item.id}
              px={4}
              py={3}
              borderTopWidth={index > 0 ? "1px" : 0}
              borderColor="gray.100"
              opacity={pending === `close:${item.id}` ? 0.6 : 1}
            >
              <HStack align="flex-start" gap={3}>
                <Text fontSize="22px" lineHeight="1.2" flexShrink={0} aria-hidden="true">
                  {item.kind === "quest" ? (item.meta ?? "🧭") : "📝"}
                </Text>
                <Stack gap={0.5} flex={1} minW={0}>
                  <Text fontSize="xs" color="charcoal.400" lineHeight="1.4" lineClamp={1}>
                    {item.kind === "quest" ? "Quest" : "From today's class"}
                  </Text>
                  <Text
                    fontFamily="heading"
                    fontWeight="700"
                    fontSize="md"
                    color="charcoal.600"
                    lineHeight="1.35"
                    overflowWrap="anywhere"
                  >
                    {item.label}
                  </Text>
                </Stack>
              </HStack>
              <Grid
                mt={3}
                templateColumns="repeat(2, minmax(0, 1fr))"
                gridAutoRows="1fr"
                gap={2}
              >
                <Button
                  minH={TOUCH}
                  colorPalette="violet"
                  aria-label={`Done with ${item.label}`}
                  disabled={pending !== null}
                  onClick={() =>
                    void run(
                      `close:${item.id}`,
                      () => resolveSuggestion({ suggestion: suggestionArg(item) }),
                      "Couldn't mark that done",
                    )
                  }
                  _focusVisible={FOCUS_RING}
                >
                  {QUESTION_QUEUE_COPY.prepDone}
                </Button>
                <Button
                  minH={TOUCH}
                  variant="outline"
                  colorPalette="gray"
                  aria-label={`Keep ${item.label} open`}
                  disabled={pending !== null}
                  onClick={() =>
                    void run(
                      `close:${item.id}`,
                      () => keepSuggestionOpen({ suggestion: suggestionArg(item) }),
                      "Couldn't update that",
                    )
                  }
                  _focusVisible={FOCUS_RING}
                >
                  {QUESTION_QUEUE_COPY.prepKeepOpen}
                </Button>
              </Grid>
            </Box>
          ))}
          {plan.resolvedToday.map((item, index) => (
            <Flex
              key={item.itemId}
              align="center"
              gap={3}
              px={4}
              py={2}
              minH="52px"
              borderTopWidth={plan.suggestions.length + index > 0 ? "1px" : 0}
              borderColor="gray.100"
            >
              <Text
                fontSize="sm"
                color="charcoal.400"
                flex={1}
                overflowWrap="anywhere"
              >
                {QUESTION_QUEUE_COPY.prepMarkedDone} · {item.label}
              </Text>
              {item.actions.includes("undo") && (
                <Button
                  size="sm"
                  minH={TOUCH}
                  variant="plain"
                  colorPalette="violet"
                  aria-label={`Undo ${item.label}`}
                  disabled={pending !== null}
                  onClick={() =>
                    void run(
                      `undo:${item.itemId}`,
                      () => undoResolveSuggestion({ itemId: item.itemId }),
                      "Couldn't undo that",
                    )
                  }
                  _focusVisible={FOCUS_RING}
                >
                  {QUESTION_QUEUE_COPY.prepUndo}
                </Button>
              )}
            </Flex>
          ))}
        </QueueSurface>
      )}

      {/* ── 2. Keep going · from your Quests ───────────────────────── */}
      {keepGoing.length > 0 && (
        <QueueSurface>
          <Eyebrow>{QUESTION_QUEUE_COPY.prepKeepGoing}</Eyebrow>
          {keepGoing.map((row, index) => (
            <QuestionQueueRowView
              key={row.id}
              row={row}
              queue={queue}
              divided={index > 0}
              dismissable
              onStartTeacherQuest={onStartTeacherQuest}
              startingSeedId={startingSeedId}
            />
          ))}
        </QueueSurface>
      )}
    </Stack>
  );
}
