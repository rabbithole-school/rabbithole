"use client";

/**
 * The Scholar's Prep tab — three plain questions on one surface style:
 *
 *   1. "Due"          — assigned homework with its due phrase (teacher-owned,
 *                       always dated). Derived; no checkbox, no remove.
 *   2. "Done today?"  — the close-out of today's still-open activities/quests:
 *                       "✓ Done" (`takeHomePlans.resolveSuggestion`, with a
 *                       durable Undo) or "Keep it open"
 *                       (`takeHomePlans.keepSuggestionOpen`, stop asking today).
 *   3. "Keep going · from your Quests" — the top rows of the scholar's ONE
 *                       queue (`questionQueue.forSelf`), rendered by the same
 *                       row component the Quests tab uses.
 *
 * The old "To do tonight" plan list (adding quests / activities / notes to
 * tonight, "Chosen") is RETIRED: nothing is on a list unless it is homework, a
 * Quests backlog item, or a close-out. Sections 1–2 read
 * `api.takeHomePlans.forSelf` (its `assigned` / `suggestions` /
 * `resolvedToday`); its `selected` plan rows are no longer rendered.
 *
 * Native twin: native/src/components/ScholarPrepSections.tsx. Copy:
 * shared/questionQueue.ts.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Box, Button, Flex, Grid, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DueChip } from "@/components/ui/DueChip";
import { GameCapabilityNotice } from "@/components/GameCapabilityNotice";
import { WebAssignmentDoneDialog } from "@/components/WebAssignmentDoneDialog";
import {
  Eyebrow,
  QueueSurface,
  QuestionQueueRowView,
  useQuestionQueue,
} from "@/components/QuestionQueue";
import { useGameActivity } from "@/hooks/useGameActivity";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { useWebAssignment } from "@/hooks/useWebAssignment";
import { toaster } from "@/lib/toaster";
import type { ExploreSeedOptions } from "@/lib/bakePaths";
import { PREP_KEEP_GOING_COUNT, QUESTION_QUEUE_COPY } from "@/shared/questionQueue";

type Plan = FunctionReturnType<typeof api.takeHomePlans.forSelf>;
type AssignedItem = Plan["assigned"][number];
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
  onStartTeacherQuest: (seedId: Id<"seeds">, opts?: ExploreSeedOptions) => void;
  startingSeedId: string | null;
}) {
  const router = useRouter();
  // Minute-rounded clock as the query's reactive dependency (T11): the plan
  // re-runs across the institution-local midnight and as homework falls due.
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
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const webAssignment = useWebAssignment();
  const gameActivity = useGameActivity();
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

  const openAssigned = (item: AssignedItem) =>
    void run(
      `assigned:${item.id}`,
      async () => {
        if (item.activityKind === "offline") {
          const result = await openOfflineHomework({
            activityId: item.activityId,
            assignmentId: item.assignmentId,
          });
          router.push(`/scholar/${result.id}`);
          return;
        }
        if (item.activityKind === "web") {
          await webAssignment.launch({
            activityId: item.activityId,
            assignmentId: item.assignmentId,
            title: item.label,
            webUrl: item.webUrl,
            webAllowedHosts: item.webAllowedHosts,
          });
          return;
        }
        if (item.activityKind === "game") {
          await gameActivity.launch({
            activityId: item.activityId,
            title: item.label,
            gameId: item.gameId,
          });
          return;
        }
        if (item.activityKind === "problem_set" && item.practiceSkillKey) {
          router.push(
            `/scholar/practice?skill=${encodeURIComponent(item.practiceSkillKey)}`,
          );
          return;
        }
        const result = await createSession({
          activityId: item.activityId,
          assignmentId: item.assignmentId,
        });
        if (result) router.push(`/scholar/${result.id}`);
      },
      "Couldn't open that activity",
    );

  // A non-scholar (teacher preview) gets the empty plan shape back.
  const planReady = plan !== undefined && plan.dayKey !== null;
  const keepGoing = (queue.rows ?? []).slice(0, PREP_KEEP_GOING_COUNT);
  const closeOutRows = planReady
    ? plan.suggestions.length + plan.resolvedToday.length
    : 0;

  return (
    <Stack gap={3}>
      {/* ── 1. Due ─────────────────────────────────────────────────── */}
      {planReady && (
        <QueueSurface>
          <Eyebrow>{QUESTION_QUEUE_COPY.prepDue}</Eyebrow>
          {plan.assigned.length === 0 ? (
            <Text px={4} pb={3} fontSize="sm" color="charcoal.500">
              {QUESTION_QUEUE_COPY.prepDueEmpty}
            </Text>
          ) : (
            plan.assigned.map((item, index) => (
              <AssignedRow
                key={item.id}
                item={item}
                divided={index > 0}
                disabled={pending !== null}
                nowMs={now}
                timeZone={plan.timeZone}
                onOpen={() => openAssigned(item)}
              />
            ))
          )}
        </QueueSurface>
      )}

      {/* ── 2. Done today? ─────────────────────────────────────────── */}
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

      {/* ── 3. Keep going · from your Quests ───────────────────────── */}
      {keepGoing.length > 0 && (
        <QueueSurface>
          <Eyebrow>{QUESTION_QUEUE_COPY.prepKeepGoing}</Eyebrow>
          {keepGoing.map((row, index) => (
            <QuestionQueueRowView
              key={row.id}
              row={row}
              queue={queue}
              divided={index > 0}
              onStartTeacherQuest={onStartTeacherQuest}
              startingSeedId={startingSeedId}
            />
          ))}
        </QueueSurface>
      )}

      <WebAssignmentDoneDialog
        prompt={webAssignment.donePrompt}
        onResolve={webAssignment.resolveDonePrompt}
      />
      <GameCapabilityNotice
        prompt={gameActivity.prompt}
        onDismiss={gameActivity.dismiss}
      />
    </Stack>
  );
}

/**
 * Assigned homework is DERIVED, never something the scholar edits — no
 * checkbox, no remove. Glyph · (title + attribution) · due status · Open.
 */
function AssignedRow({
  item,
  divided,
  disabled,
  nowMs,
  timeZone,
  onOpen,
}: {
  item: AssignedItem;
  divided: boolean;
  disabled: boolean;
  nowMs: number;
  timeZone: string | null;
  onOpen: () => void;
}) {
  const meta = [item.meta, item.teacherName ? `with ${item.teacherName}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <chakra.button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${item.label}`}
      disabled={disabled}
      display="flex"
      w="full"
      textAlign="left"
      alignItems="center"
      gap={3}
      px={4}
      py={2}
      minH="56px"
      borderTopWidth={divided ? "1px" : 0}
      borderColor="gray.100"
      cursor="pointer"
      _hover={{ bg: "gray.50" }}
      _disabled={{ cursor: "not-allowed" }}
      _focusVisible={FOCUS_RING}
    >
      <Text fontSize="22px" lineHeight="1.2" flexShrink={0} aria-hidden="true">
        {item.unitEmoji ?? "📘"}
      </Text>
      <Box flex={1} minW={0}>
        {meta && (
          <Text fontSize="xs" color="charcoal.400" lineHeight="1.4" lineClamp={1}>
            {meta}
          </Text>
        )}
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
      </Box>
      {timeZone && <DueChip dueAt={item.dueAt} nowMs={nowMs} timeZone={timeZone} />}
      <HStack gap={0.5} flexShrink={0} color="violet.600" aria-hidden>
        <Text fontFamily="heading" fontWeight="600" fontSize="xs">
          Open
        </Text>
        <CaretRight size={14} weight="bold" />
      </HStack>
    </chakra.button>
  );
}
