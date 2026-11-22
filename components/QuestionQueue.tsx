"use client";

/**
 * The scholar's ONE list of open items (`api.questionQueue.forSelf`): the
 * Scholar's Prep "Keep going" section renders its top rows, and the Quests
 * tab's "Things to wonder about" (components/WonderLists, TRA-676) renders its
 * question cards, with the SAME row component (T1: one rendering).
 *
 * Row anatomy: emoji · small meta line · bold question, then EITHER the
 * equal-size answer grid OR — once answered — a one-line reveal over an equal
 * pair "Why? →" / "Later". The verdict uses the shared VerdictStamp (row
 * placement). Teacher-suggested quests keep "Start" / "Not now".
 *
 * Answering: `recordMomentAnswer` on the row's ledger row; an item never
 * carded first mints its row through `recordMomentOffered` (surface
 * "quests"). FEEDBACK-ONLY — never touches mastery. "Why? →" opens the tutor
 * session straight from the seed (`sessions.createFromSeed`), which opens from
 * the scholar's answer. "Later" / "Not now" set the row aside for this visit
 * only — nothing is dismissed; it is still open next time.
 *
 * A row answered on THIS visit stays where it was (the reactive queue would
 * otherwise move a miss to the top and drop a correct answer instantly) until
 * the scholar taps Later or leaves. Native twin: native/src/components/
 * QuestionQueue.tsx. Copy: shared/questionQueue.ts.
 *
 * Dismiss (Scholar's Prep only, `dismissable`): a corner × that ends the row
 * for good. A question row records the terminal "dismissed" outcome on its
 * ledger row (minting one first if it was never carded), which the queue
 * already drops; a teacher quest goes through `seeds.dismissForSelf`. The row
 * hides at once and comes back, with an error toast, if the write fails.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Box, Button, Grid, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { DismissButton } from "@/components/ui/DismissButton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { VerdictStamp, VERDICT_MOTION_CSS } from "@/components/practice/VerdictStamp";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { makeClientEventId } from "@/shared/practiceLoop";
import { QUESTION_CARD_COPY, isCorrectChoice } from "@/shared/questionCard";
import { QUESTION_QUEUE_COPY, answerGridColumns } from "@/shared/questionQueue";
import { toaster } from "@/lib/toaster";

export type QueueRow = FunctionReturnType<typeof api.questionQueue.forSelf>[number];
type QuestionRow = Extract<QueueRow, { kind: "question" }>;
type TeacherRow = Extract<QueueRow, { kind: "teacherQuest" }>;
/** Stable empty queue for the contained-error case. */
const EMPTY_QUEUE: QueueRow[] = [];

const TOUCH = "48px";
const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "2px",
} as const;

/**
 * The queue plus this visit's local state: rows answered here (pinned in place
 * with the scholar's pick) and rows set aside with Later / Not now.
 */
export function useQuestionQueue() {
  // Contained, not `useQuery`: an older backend (deploy skew) has no
  // `questionQueue.forSelf`, and a thrown "Could not find public function"
  // would take the whole page down. An error renders as an empty queue.
  const { data, error } = useContainedQuery(api.questionQueue.forSelf, {});
  const rows = error ? EMPTY_QUEUE : data;
  const [pinned, setPinned] = useState<
    ReadonlyMap<string, { row: QuestionRow; index: number; choiceIndex: number }>
  >(() => new Map());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  const visible = useMemo(() => {
    if (rows === undefined) return undefined;
    const base: QueueRow[] = rows.filter(
      (row) => !hidden.has(row.id) && !pinned.has(row.id),
    );
    // A missed pick stays on the server's queue, so one the server no longer
    // returns was dismissed or followed elsewhere (another tab's queue, the
    // other app): drop it. A correct pick is expected to leave the server's
    // queue and stays pinned until Later or the visit ends.
    const live = new Set(rows.map((row) => row.id));
    const ordered = [...pinned.values()]
      .filter((entry) => !hidden.has(entry.row.id))
      .filter(
        (entry) =>
          live.has(entry.row.id) ||
          isCorrectChoice(entry.row.question, entry.choiceIndex),
      )
      .sort((a, b) => a.index - b.index);
    for (const entry of ordered) {
      const answeredRow: QuestionRow = {
        ...entry.row,
        answer: {
          choiceIndex: entry.choiceIndex,
          correct: isCorrectChoice(entry.row.question, entry.choiceIndex),
          answeredAt: 0,
        },
      };
      base.splice(Math.min(entry.index, base.length), 0, answeredRow);
    }
    return base;
  }, [rows, pinned, hidden]);

  const pin = useCallback(
    (row: QuestionRow, choiceIndex: number) => {
      setPinned((prev) => {
        if (prev.has(row.id)) return prev;
        const index = visible?.findIndex((r) => r.id === row.id) ?? 0;
        const next = new Map(prev);
        next.set(row.id, { row, index: Math.max(0, index), choiceIndex });
        return next;
      });
    },
    [visible],
  );
  // A pick whose ledger write failed is un-pinned: the row goes back to the
  // server's state (unanswered) rather than showing a verdict that was never
  // recorded. Quietly — the scholar can just answer again.
  const unpin = useCallback((id: string) => {
    setPinned((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const setAside = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
  }, []);
  const unhide = useCallback((id: string) => {
    setHidden((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Dismiss for good: hide now, then write. The ledger row comes from the
  // server's copy of the row (a row answered this visit is pinned from its
  // older, pre-answer copy, which has no eventId yet).
  const { user } = useCurrentUser();
  const recordOffered = useMutation(api.practiceMoments.recordMomentOffered);
  const recordOutcome = useMutation(api.practiceMoments.recordMomentOutcome);
  const dismissSeed = useMutation(api.seeds.dismissForSelf);
  const dismiss = useCallback(
    async (row: QueueRow) => {
      setAside(row.id);
      // A question answered correctly closed itself once the server has the
      // answer (it has left the server's queue): nothing to write. Until then
      // the dismiss is written like any other, so a failed answer write can't
      // bring the row back.
      if (
        row.kind === "question" &&
        row.answer?.correct &&
        !rows?.some((r) => r.id === row.id)
      ) {
        return;
      }
      try {
        if (row.kind === "teacherQuest") {
          await dismissSeed({ seedId: row.seedId });
          return;
        }
        if (!user) throw new Error("Not signed in");
        const live = rows?.find((r) => r.id === row.id);
        let eventId = (live?.kind === "question" ? live.eventId : null) ?? row.eventId;
        if (!eventId) {
          const minted = await recordOffered({
            scholarId: user._id,
            clientEventId: makeClientEventId("prep-dismiss"),
            surface: "quests",
            ...(row.moment.kind === "seed"
              ? { kind: "seed" as const, seedId: row.moment.seedId }
              : {
                  kind: "story" as const,
                  fromKey: row.moment.fromKey,
                  toKey: row.moment.toKey,
                }),
          });
          eventId = minted.eventId;
        }
        await recordOutcome({ eventId, outcome: "dismissed" });
      } catch (error) {
        console.error("[question-queue] dismiss not recorded", error);
        unhide(row.id);
        toaster.error({ title: "Couldn't dismiss that", description: "Please try again." });
      }
    },
    [rows, user, recordOffered, recordOutcome, dismissSeed, setAside, unhide],
  );

  return { rows: visible, pin, unpin, setAside, dismiss };
}

type QueueActions = Pick<
  ReturnType<typeof useQuestionQueue>,
  "pin" | "unpin" | "setAside" | "dismiss"
>;

/** The white list surface every queue/Prep section shares. */
export function QueueSurface({ children }: { children: React.ReactNode }) {
  return (
    <Surface p={0} overflow="hidden">
      <style dangerouslySetInnerHTML={{ __html: VERDICT_MOTION_CSS }} />
      {children}
    </Surface>
  );
}

/** Section eyebrow inside a queue surface. */
export function Eyebrow({
  children,
  divided = false,
}: {
  children: React.ReactNode;
  divided?: boolean;
}) {
  return (
    <Text
      px={4}
      pt={3}
      pb={1}
      borderTopWidth={divided ? "1px" : 0}
      borderColor="gray.100"
      fontFamily="heading"
      fontWeight="700"
      fontSize="xs"
      color="charcoal.400"
      textTransform="uppercase"
      letterSpacing="0.05em"
    >
      {children}
    </Text>
  );
}

export function QuestionQueueRowView({
  row,
  queue,
  onStartTeacherQuest,
  startingSeedId,
  divided = false,
  dismissable = false,
}: {
  row: QueueRow;
  /** Hairline above the row (every row but the first under an eyebrow). */
  divided?: boolean;
  /** A corner × that dismisses the row for good (Scholar's Prep only). */
  dismissable?: boolean;
  queue: QueueActions;
  onStartTeacherQuest: (seedId: Id<"seeds">) => void;
  startingSeedId: string | null;
}) {
  if (row.kind === "teacherQuest") {
    const starting = startingSeedId === String(row.seedId);
    return (
      <TeacherQuestRow
        row={row}
        divided={divided}
        starting={starting}
        onStart={() => onStartTeacherQuest(row.seedId)}
        onNotNow={() => queue.setAside(row.id)}
        dismiss={
          dismissable ? (
            <DismissButton
              label={row.title}
              disabled={starting}
              onPress={() => void queue.dismiss(row)}
            />
          ) : null
        }
      />
    );
  }
  return (
    <QuestionRowView row={row} queue={queue} divided={divided} dismissable={dismissable} />
  );
}

function RowShell({
  divided,
  dismiss,
  children,
}: {
  divided: boolean;
  /** The corner × (DismissButton), when the row is dismissable. */
  dismiss?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Box
      position="relative"
      px={4}
      py={3}
      borderTopWidth={divided ? "1px" : 0}
      borderColor="gray.100"
    >
      {children}
      {dismiss && (
        <Box position="absolute" top="6px" right="6px">
          {dismiss}
        </Box>
      )}
    </Box>
  );
}

/** Room the corner × takes at the head's right. */
const DISMISS_RESERVE = 36;
/** Room the verdict stamp takes at the head's right. */
const STAMP_RESERVE = 92;

function RowHead({
  emoji,
  meta,
  title,
  reserveStamp,
  reserveDismiss,
}: {
  emoji: string;
  meta: string;
  title: string;
  reserveStamp?: boolean;
  reserveDismiss?: boolean;
}) {
  const reserve =
    (reserveStamp ? STAMP_RESERVE : 0) + (reserveDismiss ? DISMISS_RESERVE : 0);
  return (
    <HStack align="flex-start" gap={3} pr={`${reserve}px`}>
      <Text fontSize="22px" lineHeight="1.2" flexShrink={0} aria-hidden="true">
        {emoji}
      </Text>
      <Stack gap={0.5} flex={1} minW={0}>
        <Text fontSize="xs" color="charcoal.400" lineHeight="1.4" lineClamp={1}>
          {meta}
        </Text>
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="md"
          color="charcoal.600"
          lineHeight="1.35"
          overflowWrap="anywhere"
        >
          {title}
        </Text>
      </Stack>
    </HStack>
  );
}

function QuestionRowView({
  row,
  queue,
  divided,
  dismissable,
}: {
  row: QuestionRow;
  divided: boolean;
  dismissable: boolean;
  queue: QueueActions;
}) {
  const router = useRouter();
  const { user } = useCurrentUser();
  const recordOffered = useMutation(api.practiceMoments.recordMomentOffered);
  const recordAnswer = useMutation(api.practiceMoments.recordMomentAnswer);
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const [opening, setOpening] = useState(false);
  const { question, answer } = row;
  const tone = answer ? (answer.correct ? "correct" : "miss") : null;

  const pick = async (choiceIndex: number) => {
    if (answer || !user) return;
    // The verdict shows instantly (pinned locally); the ledger write follows.
    queue.pin(row, choiceIndex);
    try {
      let eventId = row.eventId;
      if (!eventId) {
        const minted = await recordOffered({
          scholarId: user._id,
          clientEventId: makeClientEventId("quests-row"),
          surface: "quests",
          ...(row.moment.kind === "seed"
            ? { kind: "seed" as const, seedId: row.moment.seedId }
            : {
                kind: "story" as const,
                fromKey: row.moment.fromKey,
                toKey: row.moment.toKey,
              }),
        });
        eventId = minted.eventId;
      }
      await recordAnswer({ eventId, choiceIndex });
    } catch (error) {
      console.error("[question-queue] answer not recorded", error);
      queue.unpin(row.id);
    }
  };

  const why = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const res = await createFromSeed({ seedId: row.seedId });
      if (res) router.push(`/scholar/${res.id}`);
      else setOpening(false);
    } catch (error) {
      console.error("[question-queue] could not open", error);
      toaster.error({ title: "Couldn't open that", description: "Please try again." });
      setOpening(false);
    }
  };

  const { narrow, wide } = answerGridColumns(question.choices.length);

  return (
    <RowShell
      divided={divided}
      dismiss={
        dismissable ? (
          <DismissButton
            label={question.prompt}
            disabled={opening}
            onPress={() => void queue.dismiss(row)}
          />
        ) : null
      }
    >
      <RowHead
        emoji={row.emoji}
        meta={row.meta}
        title={question.prompt}
        reserveStamp={!!tone}
        reserveDismiss={dismissable}
      />
      {!answer ? (
        <Grid
          mt={3}
          templateColumns={{
            base: `repeat(${narrow}, minmax(0, 1fr))`,
            md: `repeat(${wide}, minmax(0, 1fr))`,
          }}
          gridAutoRows="1fr"
          gap={2}
          role="group"
          aria-label={question.prompt}
        >
          {question.choices.map((choice, index) => (
            <chakra.button
              key={index}
              type="button"
              onClick={() => void pick(index)}
              disabled={!user}
              minH={TOUCH}
              px={3}
              py={2}
              borderWidth="2px"
              borderColor="gray.200"
              borderRadius="10px"
              bg="white"
              fontFamily="heading"
              fontSize="sm"
              fontWeight="700"
              color="charcoal.600"
              textAlign="center"
              display="flex"
              alignItems="center"
              justifyContent="center"
              cursor="pointer"
              _hover={{ borderColor: "teal.400", bg: "teal.50" }}
              _focusVisible={FOCUS_RING}
            >
              {choice}
            </chakra.button>
          ))}
        </Grid>
      ) : (
        <Stack gap={3} mt={2} className="rh-note">
          <Text fontSize="sm" color="charcoal.600" lineHeight="1.45" pl="34px">
            {question.reveal}
          </Text>
          <Grid templateColumns="repeat(2, minmax(0, 1fr))" gridAutoRows="1fr" gap={2}>
            <Button
              minH={TOUCH}
              colorPalette="teal"
              loading={opening}
              onClick={() => void why()}
              _focusVisible={FOCUS_RING}
            >
              {question.whyLabel ?? QUESTION_CARD_COPY.why}
            </Button>
            <Button
              minH={TOUCH}
              variant="outline"
              colorPalette="gray"
              disabled={opening}
              onClick={() => queue.setAside(row.id)}
              _focusVisible={FOCUS_RING}
            >
              {QUESTION_QUEUE_COPY.later}
            </Button>
          </Grid>
        </Stack>
      )}
      {dismissable ? (
        // Beside the corner ×, not under it.
        <Box
          position="absolute"
          top={0}
          bottom={0}
          left={0}
          right={`${DISMISS_RESERVE}px`}
          pointerEvents="none"
        >
          <VerdictStamp tone={tone} placement="row" />
        </Box>
      ) : (
        <VerdictStamp tone={tone} placement="row" />
      )}
    </RowShell>
  );
}

function TeacherQuestRow({
  row,
  divided,
  starting,
  onStart,
  onNotNow,
  dismiss,
}: {
  row: TeacherRow;
  divided: boolean;
  starting: boolean;
  onStart: () => void;
  onNotNow: () => void;
  dismiss: React.ReactNode;
}) {
  return (
    <RowShell divided={divided} dismiss={dismiss}>
      <RowHead
        emoji={row.emoji}
        meta={row.meta}
        title={row.title}
        reserveDismiss={dismiss !== null}
      />
      {row.body && (
        <Text
          mt={1}
          pl="34px"
          fontSize="sm"
          color="charcoal.500"
          lineHeight="1.45"
          lineClamp={2}
        >
          {row.body}
        </Text>
      )}
      <Grid
        mt={3}
        templateColumns="repeat(2, minmax(0, 1fr))"
        gridAutoRows="1fr"
        gap={2}
      >
        <Button
          minH={TOUCH}
          colorPalette="violet"
          loading={starting}
          aria-label={`${QUESTION_QUEUE_COPY.start} ${row.title}`}
          onClick={onStart}
          _focusVisible={FOCUS_RING}
        >
          {QUESTION_QUEUE_COPY.start}
        </Button>
        <Button
          minH={TOUCH}
          variant="outline"
          colorPalette="gray"
          disabled={starting}
          onClick={onNotNow}
          _focusVisible={FOCUS_RING}
        >
          {QUESTION_QUEUE_COPY.notNow}
        </Button>
      </Grid>
    </RowShell>
  );
}
