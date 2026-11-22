/**
 * The wonder lists on the BunnyPad Home (TRA-677), the RN twins of web
 * components/WonderLists.tsx. Each row is the one row (ui/ListRow), worded by
 * shared/wonderRows.ts, so a wonder or a starter reads the same on both apps:
 *
 *   - TodaysWonders: Scholar's Prep's first section, and the one home of the
 *     "I wonder…" box. The box, then the day's wonders, newest first
 *     (`wonders.todayForSelf`), then "Earlier": the kid's few older wonders
 *     (`wonders.recentForSelf` less today's, `earlierWonders`). Each row has
 *     "Open", which reopens the same chat, and a × that dismisses the wonder
 *     from Prep (`seeds.dismissForSelf`; the chat stays, teachers still see
 *     it).
 *   - WonderStarters: "Things to wonder about" at the end of the Quests tab.
 *     The question queue's cards, answered in place as before, then every
 *     other starter (`questionQueue.startersForSelf`) with "Ask", which opens
 *     a chat from that seed through the existing seed start (useExploreSeed,
 *     no path menu), as the queue's rows do.
 */

import { forwardRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Alert, StyleSheet, View } from "react-native";

import { HomeSectionHead } from "@/components/HomeSection";
import {
  Eyebrow,
  QueueSurface,
  QuestionQueueRowView,
  useQuestionQueue,
} from "@/components/QuestionQueue";
import { ListRow } from "@/components/ui/ListRow";
import { WonderBox, type WonderBoxHandle } from "@/components/WonderBox";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useExploreSeed } from "@/hooks/useExploreSeed";
import { useInstitutionDay } from "@/hooks/useInstitutionDay";
import { useNow } from "@/hooks/useNow";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { api, type Id } from "@/lib/convex";
import { HOME_LABEL_GAP, HOME_SECTION_GAP } from "@/lib/homeRhythm";
import {
  WONDER_COPY,
  earlierWonders,
  starterListRow,
  wonderListRow,
} from "../../vendor/shared/wonderRows";

/**
 * Scholar's Prep: "Today's wonders", headed by the "I wonder…" box (`ref`
 * reaches it, for the Custom Quest buttons), then today's wonders, then
 * "Earlier". The day is the school's day for the key `useInstitutionDay`
 * reads off this device's clock, and today's query is smoothed, so crossing
 * midnight swaps the list without a blank frame (T11); the same ticking clock
 * moves a wonder into Earlier once its day has passed. The meta line's time
 * words ("10:12", "Monday") tick with `useNow`. Earlier's read is contained:
 * an error leaves it out, never Home's error state.
 */
export const TodaysWonders = forwardRef<WonderBoxHandle>(function TodaysWonders(
  _props,
  ref,
) {
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const serverDay = useQuery(
    api.institutions.currentDayForScholar,
    isAuthenticated ? {} : "skip",
  );
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
      console.warn("[wonders] dismiss not recorded", error);
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      Alert.alert("Couldn't dismiss that", "Please try again.");
    });
  };
  const shown = (wonder: { seedId: Id<"seeds"> }) => !dismissed.has(String(wonder.seedId));
  const todays = today && day ? today.wonders.filter(shown) : [];
  const earlier =
    day && recent && !recentError
      ? earlierWonders(recent.filter(shown), nowMs, day.timeZone)
      : [];

  const open = (sessionId: Id<"sessions">, question: string) => {
    Haptics.selectionAsync().catch(() => {});
    router.push({
      pathname: "/session/[id]",
      params: { id: sessionId, title: question },
    });
  };

  const openReply = (threadId: string) => {
    Haptics.selectionAsync().catch(() => {});
    router.push({ pathname: "/messages", params: { thread: threadId } });
  };

  return (
    <QueueSurface>
      <Eyebrow>{WONDER_COPY.todaysWonders}</Eyebrow>
      <View style={styles.boxPadUnderEyebrow}>
        <WonderBox ref={ref} />
      </View>
      {day
        ? todays.map((wonder) => {
            const row = wonderListRow(wonder, nowMs, day.timeZone);
            return (
              <ListRow
                key={row.key}
                row={row}
                divided
                onPress={() => open(wonder.sessionId, wonder.question)}
                onReplyPress={openReply}
                onDismiss={() => dismiss(wonder.seedId)}
              />
            );
          })
        : null}
      {day && earlier.length > 0 ? (
        <>
          <Eyebrow divided>{WONDER_COPY.earlierWonders}</Eyebrow>
          {earlier.map((wonder, index) => {
            const row = wonderListRow(wonder, nowMs, day.timeZone);
            return (
              <ListRow
                key={row.key}
                row={row}
                divided={index > 0}
                onPress={() => open(wonder.sessionId, wonder.question)}
                onReplyPress={openReply}
                onDismiss={() => dismiss(wonder.seedId)}
              />
            );
          })}
        </>
      ) : null}
    </QueueSurface>
  );
});

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
 * this visit. Hidden when there is nothing, and it owns its LEADING gap
 * (homeRhythm). Contained: an error renders nothing, never Home's error
 * state. Web twin: components/WonderLists.tsx.
 */
export function WonderStarters() {
  const queue = useQuestionQueue();
  // The same subscription useQuestionQueue holds: every question row the
  // queue returned, before this visit's Later hides any.
  const { data: queueRows } = useContainedQuery(api.questionQueue.forSelf, {});
  const { data, error } = useContainedQuery(api.questionQueue.startersForSelf, {});
  const { exploreSeed, exploringSeedId } = useExploreSeed();
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
    <View style={styles.section}>
      <HomeSectionHead label={WONDER_COPY.thingsToWonderAbout} />
      <QueueSurface>
        {cards.map((row, index) => (
          <QuestionQueueRowView
            key={row.id}
            row={row}
            divided={index > 0}
            queue={queue}
            onStartTeacherQuest={exploreSeed}
            startingSeedId={exploringSeedId}
          />
        ))}
        {others.map((starter, index) => {
          const row = starterListRow(starter);
          return (
            <ListRow
              key={row.key}
              row={row}
              divided={cards.length > 0 || index > 0}
              busy={exploringSeedId === String(starter.seedId)}
              disabled={exploringSeedId !== null}
              // The menu-free seed start the queue's rows already use: one
              // chat from the seed (a teacher's Quest offer opens its unit).
              onPress={() =>
                void exploreSeed(starter.seedId, { title: starter.line })
              }
            />
          );
        })}
      </QueueSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  boxPadUnderEyebrow: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  section: { paddingTop: HOME_SECTION_GAP, gap: HOME_LABEL_GAP },
});
