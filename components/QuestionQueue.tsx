"use client";

/**
 * The scholar's ONE list of open items (`api.questionQueue.forSelf`) — the
 * Quests tab renders the whole list; the Scholar's Prep "Keep going" section
 * renders its top rows with the SAME row component (T1: one rendering).
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
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Box, Button, Grid, HStack, Stack, Text, chakra } from "@chakra-ui/react";
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
import type { ExploreSeedOptions } from "@/lib/bakePaths";

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
    const ordered = [...pinned.values()]
      .filter((entry) => !hidden.has(entry.row.id))
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

  return { rows: visible, pin, unpin, setAside };
}

/** Quests tab: the whole queue on one white surface, two eyebrows. */
export function QuestionQueueList({
  onStartTeacherQuest,
  startingSeedId,
}: {
  onStartTeacherQuest: (seedId: Id<"seeds">, opts?: ExploreSeedOptions) => void;
  startingSeedId: string | null;
}) {
  const queue = useQuestionQueue();
  if (queue.rows === undefined || queue.rows.length === 0) return null;
  const questions = queue.rows.filter((row) => row.kind === "question");
  const teacher = queue.rows.filter((row) => row.kind === "teacherQuest");
  return (
    <QueueSurface>
      {questions.length > 0 && (
        <>
          <Eyebrow>{QUESTION_QUEUE_COPY.openQuestions}</Eyebrow>
          {questions.map((row, index) => (
            <QuestionQueueRowView
              key={row.id}
              row={row}
              divided={index > 0}
              queue={queue}
              onStartTeacherQuest={onStartTeacherQuest}
              startingSeedId={startingSeedId}
            />
          ))}
        </>
      )}
      {teacher.length > 0 && (
        <>
          <Eyebrow divided={questions.length > 0}>
            {QUESTION_QUEUE_COPY.fromTeacher}
          </Eyebrow>
          {teacher.map((row, index) => (
            <QuestionQueueRowView
              key={row.id}
              row={row}
              divided={index > 0}
              queue={queue}
              onStartTeacherQuest={onStartTeacherQuest}
              startingSeedId={startingSeedId}
            />
          ))}
        </>
      )}
    </QueueSurface>
  );
}

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
}: {
  row: QueueRow;
  /** Hairline above the row (every row but the first under an eyebrow). */
  divided?: boolean;
  queue: Pick<ReturnType<typeof useQuestionQueue>, "pin" | "unpin" | "setAside">;
  onStartTeacherQuest: (seedId: Id<"seeds">, opts?: ExploreSeedOptions) => void;
  startingSeedId: string | null;
}) {
  if (row.kind === "teacherQuest") {
    return (
      <TeacherQuestRow
        row={row}
        divided={divided}
        starting={startingSeedId === String(row.seedId)}
        onStart={() => onStartTeacherQuest(row.seedId, { skipMenu: true })}
        onNotNow={() => queue.setAside(row.id)}
      />
    );
  }
  return <QuestionRowView row={row} queue={queue} divided={divided} />;
}

function RowShell({
  divided,
  children,
}: {
  divided: boolean;
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
    </Box>
  );
}

function RowHead({
  emoji,
  meta,
  title,
  reserveStamp,
}: {
  emoji: string;
  meta: string;
  title: string;
  reserveStamp?: boolean;
}) {
  return (
    <HStack align="flex-start" gap={3} pr={reserveStamp ? "92px" : 0}>
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
}: {
  row: QuestionRow;
  divided: boolean;
  queue: Pick<ReturnType<typeof useQuestionQueue>, "pin" | "unpin" | "setAside">;
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
    <RowShell divided={divided}>
      <RowHead
        emoji={row.emoji}
        meta={row.meta}
        title={question.prompt}
        reserveStamp={!!tone}
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
      <VerdictStamp tone={tone} placement="row" />
    </RowShell>
  );
}

function TeacherQuestRow({
  row,
  divided,
  starting,
  onStart,
  onNotNow,
}: {
  row: TeacherRow;
  divided: boolean;
  starting: boolean;
  onStart: () => void;
  onNotNow: () => void;
}) {
  return (
    <RowShell divided={divided}>
      <RowHead emoji={row.emoji} meta={row.meta} title={row.title} />
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
