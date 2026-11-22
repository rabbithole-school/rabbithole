"use client";

/**
 * The wonder lists on web (TRA-676), each drawn with the one row
 * (components/ui/ListRow, words from shared/wonderRows.ts):
 *
 *   - TodaysWonders: Scholar's Prep's first section. The box, then the day's
 *     wonders, newest first (`wonders.todayForSelf`), then "Earlier": a few
 *     older ones (`wonders.recentForSelf` minus today's), each with "Open",
 *     which reopens the same chat, and a × that dismisses the wonder from
 *     Prep (`seeds.dismissForSelf`; the chat stays, teachers still see it).
 *   - WonderStarters: "Things to wonder about" at the end of the Quests tab.
 *     The question queue's cards, answered in place as before, then every
 *     other starter (`questionQueue.startersForSelf`) with "Ask", which opens
 *     a chat from that seed through the page's seed start (useExploreSeed).
 *
 * Native twin: the BunnyPad's Quests tab and Prep (TRA-676's twin PR).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Box, Stack } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Eyebrow,
  QueueSurface,
  QuestionQueueRowView,
  useQuestionQueue,
} from "@/components/QuestionQueue";
import { WonderBox } from "@/components/WonderBox";
import { ListRow } from "@/components/ui/ListRow";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { Surface } from "@/components/ui/Surface";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useInstitutionDay } from "@/hooks/useInstitutionDay";
import { useNow } from "@/hooks/useNow";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { toaster } from "@/lib/toaster";
import {
  WONDER_COPY,
  earlierWonders,
  starterListRow,
  wonderListRow,
} from "@/shared/wonderRows";

/**
 * Today's wonders, under the box, then "Earlier". The day is the school's day
 * for the key `useInstitutionDay` reads off this device's clock, and the
 * query is smoothed, so crossing midnight swaps the list without a blank
 * frame (T11). Earlier comes from `recentForSelf`, which reads no clock; which
 * of those are older than today, and the meta line's time words ("10:12",
 * "Monday"), tick with `useNow`. Earlier is contained: an error leaves it out.
 */
export function TodaysWonders() {
  const router = useRouter();
  const serverDay = useQuery(api.institutions.currentDayForScholar, {});
  const day = useInstitutionDay(serverDay);
  const nowMs = useNow(60_000);
  const today = useSmoothedQuery(
    api.wonders.todayForSelf,
    day ? { dayKey: day.dayKey } : "skip",
  );
  const { data: recent, error: recentError } = useContainedQuery(
    api.wonders.recentForSelf,
    {},
  );
  // Dismissed this visit: hidden at once, before the reads catch up (and
  // shown again if the write fails).
  const dismissSeed = useMutation(api.seeds.dismissForSelf);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dismiss = (seedId: Id<"seeds">) => {
    const key = String(seedId);
    setDismissed((prev) => new Set(prev).add(key));
    dismissSeed({ seedId }).catch((error: unknown) => {
      console.error("[wonders] dismiss not recorded", error);
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      toaster.error({ title: "Couldn't dismiss that", description: "Please try again." });
    });
  };
  const shown = (wonder: { seedId: Id<"seeds"> }) => !dismissed.has(String(wonder.seedId));
  const toRow = (
    wonder: { seedId: Id<"seeds">; sessionId: Id<"sessions"> } & Parameters<
      typeof wonderListRow
    >[0],
  ) => ({
    seedId: wonder.seedId,
    sessionId: wonder.sessionId,
    row: wonderListRow(wonder, nowMs, day!.timeZone),
  });
  const openReply = (threadId: string) =>
    router.push(`/scholar/messages?thread=${threadId}`);
  const rows = today && day ? today.wonders.filter(shown).map(toRow) : [];
  const earlier =
    day && recent && !recentError
      ? earlierWonders(recent.filter(shown), nowMs, day.timeZone).map(toRow)
      : [];

  return (
    <Surface p={0} overflow="hidden">
      <Eyebrow>{WONDER_COPY.todaysWonders}</Eyebrow>
      <Box px={4} pt={1} pb={3}>
        <WonderBox />
      </Box>
      {rows.map(({ seedId, sessionId, row }) => (
        <ListRow
          key={row.key}
          row={row}
          divided
          onPress={() => router.push(`/scholar/${sessionId}`)}
          onReplyPress={openReply}
          onDismiss={() => dismiss(seedId)}
        />
      ))}
      {earlier.length > 0 && (
        <>
          <Eyebrow divided>{WONDER_COPY.earlierWonders}</Eyebrow>
          {earlier.map(({ seedId, sessionId, row }, index) => (
            <ListRow
              key={row.key}
              row={row}
              divided={index > 0}
              onPress={() => router.push(`/scholar/${sessionId}`)}
              onReplyPress={openReply}
              onDismiss={() => dismiss(seedId)}
            />
          ))}
        </>
      )}
    </Surface>
  );
}

/**
 * "Things to wonder about": the question queue we have, with more sources
 * feeding it (review/quests-rebuilt-proposal.html, "Starters"). In the
 * queue's own order:
 *   1. its question cards (`questionQueue.forSelf` rows of kind "question":
 *      practice question cards and Stories' questions), answered in place
 *      exactly as before (QuestionQueueRowView, with this visit's Later and
 *      answered-in-place state from useQuestionQueue);
 *   2. every other starter (`questionQueue.startersForSelf`: a teacher's
 *      pick, and Rabbithole's ideas once they are live) as the one row with
 *      "Ask".
 * A starter whose seed is one of the queue's question cards is the same item,
 * so it is drawn only as its card: the two are told apart by `seedId` against
 * every question row the queue returned, including one set aside with Later
 * this visit. Hidden when there is nothing. Contained: an error renders
 * nothing, never the page's error screen.
 */
export function WonderStarters({
  onAsk,
  askingSeedId,
}: {
  onAsk: (seedId: Id<"seeds">) => void;
  askingSeedId: string | null;
}) {
  const queue = useQuestionQueue();
  // The same subscription useQuestionQueue holds: every question row the
  // queue returned, before this visit's Later hides any.
  const { data: queueRows } = useContainedQuery(api.questionQueue.forSelf, {});
  const { data, error } = useContainedQuery(api.questionQueue.startersForSelf, {});
  const questionSeedIds = new Set(
    (queueRows ?? [])
      .filter((row) => row.kind === "question")
      .map((row) => String(row.seedId)),
  );
  const cards = (queue.rows ?? []).filter((row) => row.kind === "question");
  const others = (error ? [] : (data ?? [])).filter(
    (starter) => !questionSeedIds.has(String(starter.seedId)),
  );
  if (cards.length === 0 && others.length === 0) return null;
  return (
    <Stack gap={3}>
      <ScholarHomeSectionHeader>{WONDER_COPY.thingsToWonderAbout}</ScholarHomeSectionHeader>
      <QueueSurface>
        {cards.map((row, index) => (
          <QuestionQueueRowView
            key={row.id}
            row={row}
            divided={index > 0}
            queue={queue}
            onStartTeacherQuest={onAsk}
            startingSeedId={askingSeedId}
          />
        ))}
        {others.map((starter, index) => {
          const row = starterListRow(starter);
          return (
            <ListRow
              key={row.key}
              row={row}
              divided={cards.length > 0 || index > 0}
              busy={askingSeedId === String(starter.seedId)}
              disabled={askingSeedId !== null}
              // The menu-free seed start the queue's rows already use: one
              // chat from the seed (a teacher's Quest offer opens its unit).
              onPress={() => onAsk(starter.seedId)}
            />
          );
        })}
      </QueueSurface>
    </Stack>
  );
}
