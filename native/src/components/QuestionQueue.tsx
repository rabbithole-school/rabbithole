/**
 * The scholar's ONE list of open items (`api.questionQueue.forSelf`) — the RN
 * twin of components/QuestionQueue.tsx. The Quests tab renders the whole list;
 * the Scholar's Prep "Keep going" section renders its top rows with the SAME
 * row component (T1: one rendering). It replaced the native Suggested quests
 * and story-invitation cards.
 *
 * Row anatomy: emoji · small meta line · bold question, then EITHER the
 * equal-size answer grid OR — once answered — a one-line reveal over an equal
 * pair "Why? →" / "Later". The verdict is the shared PracticeVerdictStamp (row
 * placement). Teacher-suggested quests keep "Start" / "Not now".
 *
 * Answering: `recordMomentAnswer` on the row's ledger row; an item never
 * carded first mints its row through `recordMomentOffered` (surface
 * "quests"). FEEDBACK-ONLY — never touches mastery. "Why? →" opens the tutor
 * session straight from the seed (`sessions.createFromSeed`). "Later" /
 * "Not now" set the row aside for this visit only — nothing is dismissed.
 *
 * A row answered on THIS visit stays where it was (the reactive queue would
 * otherwise move a miss to the top and drop a correct answer instantly) until
 * the scholar taps Later or leaves. Copy: shared/questionQueue.ts (vendored).
 */

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, type ReactMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { HOME_SECTION_GAP } from "@/lib/homeRhythm";
import { makePracticeShellStyles } from "@/lib/practiceShell";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useExploreSeed, type ExploreSeedOptions } from "@/hooks/useExploreSeed";
import { PracticeVerdictStamp } from "@/components/practice/PracticeVerdictStamp";
import {
  CHOICE_CELL_BORDER,
  CHOICE_CELL_PADDING_V,
  commonCellHeight,
} from "@/components/practice/questionCardState";
import { fonts, useColors, type Colors } from "@/theme";
import { makeClientEventId } from "../../vendor/shared/practiceLoop";
import { QUESTION_CARD_COPY, isCorrectChoice } from "../../vendor/shared/questionCard";
import {
  QUESTION_QUEUE_COPY,
  answerGridColumns,
  answerGridRows,
} from "../../vendor/shared/questionQueue";

export type QueueRow = FunctionReturnType<typeof api.questionQueue.forSelf>[number];
type QuestionRow = Extract<QueueRow, { kind: "question" }>;
type TeacherRow = Extract<QueueRow, { kind: "teacherQuest" }>;
/** Stable empty queue for the contained-error case. */
const EMPTY_QUEUE: QueueRow[] = [];

/** Touch target for every row control (pt) — web's 48px. */
const TOUCH = 48;
/** Width at which the answer grid switches to its wide column count (web md). */
const WIDE_MIN_WIDTH = 768;

export type StartTeacherQuest = (
  seedId: Id<"seeds">,
  opts?: ExploreSeedOptions,
) => void;

type QueueApi = Pick<
  ReturnType<typeof useQuestionQueue>,
  "pin" | "unpin" | "setAside" | "scholarId"
>;

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
  // The signed-in scholar — `recordMomentOffered` takes the subject id.
  const me = useQuery(api.users.currentUser, {});
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

  return { rows: visible, pin, unpin, setAside, scholarId: me?._id ?? null };
}

/** Quests tab: the whole queue on one white surface, two eyebrows. Owns its
 *  LEADING gap (it self-gates to nothing — see homeRhythm). */
export function QuestionQueueList() {
  const queue = useQuestionQueue();
  const { exploreSeed, exploringSeedId, exploreSeedDialog } = useExploreSeed();
  if (queue.rows === undefined || queue.rows.length === 0) return null;
  const questions = queue.rows.filter((row) => row.kind === "question");
  const teacher = queue.rows.filter((row) => row.kind === "teacherQuest");
  return (
    <View style={{ paddingTop: HOME_SECTION_GAP }}>
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
                onStartTeacherQuest={exploreSeed}
                startingSeedId={exploringSeedId}
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
                onStartTeacherQuest={exploreSeed}
                startingSeedId={exploringSeedId}
              />
            ))}
          </>
        )}
      </QueueSurface>
      {exploreSeedDialog}
    </View>
  );
}

/** The white list surface every queue / Prep section shares. */
export function QueueSurface({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return <View style={styles.surface}>{children}</View>;
}

/** Section eyebrow inside a queue surface. */
export function Eyebrow({
  children,
  divided = false,
}: {
  children: React.ReactNode;
  divided?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Text
      accessibilityRole="header"
      style={[styles.eyebrow, divided && styles.divided]}
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
  queue: QueueApi;
  onStartTeacherQuest: StartTeacherQuest;
  startingSeedId: string | null;
}) {
  if (row.kind === "teacherQuest") {
    return (
      <TeacherQuestRow
        row={row}
        divided={divided}
        starting={startingSeedId === String(row.seedId)}
        onStart={() =>
          onStartTeacherQuest(row.seedId, { skipMenu: true, title: row.title })
        }
        onNotNow={() => {
          Haptics.selectionAsync().catch(() => {});
          queue.setAside(row.id);
        }}
      />
    );
  }
  return <QuestionRowView row={row} queue={queue} divided={divided} />;
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
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.head, reserveStamp && styles.headReserve]}>
      <Text style={styles.headEmoji} accessible={false}>
        {emoji}
      </Text>
      <View style={styles.headBody}>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
        <Text style={styles.title}>{title}</Text>
      </View>
    </View>
  );
}

function QuestionRowView({
  row,
  queue,
  divided,
}: {
  row: QuestionRow;
  divided: boolean;
  queue: QueueApi;
}) {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const shell = useMemo(() => makePracticeShellStyles(colors), [colors]);
  const recordOffered = useMutation(api.practiceMoments.recordMomentOffered);
  const recordAnswer = useMutation(api.practiceMoments.recordMomentAnswer);
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const [opening, setOpening] = useState(false);
  const { width } = useWindowDimensions();
  const { question, answer } = row;
  const tone = answer ? (answer.correct ? "correct" : "miss") : null;
  const { scholarId } = queue;

  // Promise chains, not try/catch: the React Compiler bails out on a try
  // statement in a component (native's compiler baseline is checked).
  const pick = (choiceIndex: number) => {
    if (answer || !scholarId) return;
    Haptics.selectionAsync().catch(() => {});
    // The verdict shows instantly (pinned locally); the ledger write follows.
    queue.pin(row, choiceIndex);
    recordRowAnswer({ row, scholarId, choiceIndex, recordOffered, recordAnswer }).catch(
      (error: unknown) => {
        console.warn("[question-queue] answer not recorded", error);
        queue.unpin(row.id);
      },
    );
  };

  const why = () => {
    if (opening) return;
    setOpening(true);
    Haptics.selectionAsync().catch(() => {});
    createFromSeed({ seedId: row.seedId }).then(
      (res) => {
        if (res) {
          router.push({
            pathname: "/session/[id]",
            params: { id: res.id, title: row.title },
          });
        } else {
          setOpening(false);
        }
      },
      (error: unknown) => {
        console.warn("[question-queue] could not open", error);
        setOpening(false);
      },
    );
  };

  const { narrow, wide } = answerGridColumns(question.choices.length);
  const columns = width >= WIDE_MIN_WIDTH ? wide : narrow;

  return (
    <View style={[styles.row, divided && styles.divided]}>
      <RowHead
        emoji={row.emoji}
        meta={row.meta}
        title={question.prompt}
        reserveStamp={!!tone}
      />
      {!answer ? (
        // Keyed on the column count so a rotation re-measures from scratch.
        <AnswerGrid
          key={columns}
          choices={question.choices}
          columns={columns}
          prompt={question.prompt}
          disabled={!scholarId}
          onPick={pick}
        />
      ) : (
        <View style={styles.answered}>
          <Text style={styles.reveal}>{question.reveal}</Text>
          <View style={styles.pair}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: opening }}
              disabled={opening}
              onPress={why}
              style={({ pressed }) => [
                styles.button,
                styles.buttonPrimary,
                (pressed || opening) && styles.pressed,
              ]}
            >
              {opening ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.buttonPrimaryText}>
                  {question.whyLabel ?? QUESTION_CARD_COPY.why}
                </Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={opening}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                queue.setAside(row.id);
              }}
              style={({ pressed }) => [
                styles.button,
                styles.buttonSecondary,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.buttonSecondaryText}>{QUESTION_QUEUE_COPY.later}</Text>
            </Pressable>
          </View>
        </View>
      )}
      <PracticeVerdictStamp feedback={tone} shell={shell} placement="row" />
    </View>
  );
}

/** The ledger write behind a pick: answer the row's ledger row, minting it
 *  first (surface "quests") when the item was never carded. */
async function recordRowAnswer({
  row,
  scholarId,
  choiceIndex,
  recordOffered,
  recordAnswer,
}: {
  row: QuestionRow;
  scholarId: Id<"users">;
  choiceIndex: number;
  recordOffered: ReactMutation<typeof api.practiceMoments.recordMomentOffered>;
  recordAnswer: ReactMutation<typeof api.practiceMoments.recordMomentAnswer>;
}) {
  let eventId = row.eventId;
  if (!eventId) {
    const minted = await recordOffered({
      scholarId,
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
}

/**
 * Equal-size answer cells: rows of flex:1 cells that stretch to the row's
 * height, plus one shared minHeight from each cell's natural content height
 * across rows (commonCellHeight —
 * the done-screen card's rule), so every cell in the grid is the same size.
 * Never a 3+1 wrap: answerGridColumns never yields a ragged row for 2–4.
 */
function AnswerGrid({
  choices,
  columns,
  prompt,
  disabled,
  onPick,
}: {
  choices: readonly string[];
  columns: number;
  prompt: string;
  disabled: boolean;
  onPick: (index: number) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const rows = useMemo(
    () => answerGridRows(choices.map((_, index) => index), columns),
    [choices, columns],
  );
  const [heights, setHeights] = useState<Array<number | undefined>>([]);
  const cellHeight = commonCellHeight(heights, TOUCH);
  const onCellLayout = useCallback((index: number, e: LayoutChangeEvent) => {
    const h = Math.ceil(e.nativeEvent.layout.height);
    setHeights((prev) =>
      prev[index] === h ? prev : Object.assign([...prev], { [index]: h }),
    );
  }, []);

  return (
    <View style={styles.grid} accessibilityLabel={prompt}>
      {rows.map((cells, r) => (
        <View key={r} style={styles.gridRow}>
          {cells.map((index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onPick(index)}
              style={({ pressed }) => [
                styles.cell,
                { minHeight: cellHeight },
                pressed && styles.cellPressed,
              ]}
            >
              {/* Measure the content's NATURAL height (no minHeight here),
                  so the shared height can shrink again. */}
              <View onLayout={(e) => onCellLayout(index, e)}>
                <Text style={styles.cellText}>{choices[index]}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
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
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.row, divided && styles.divided]}>
      <RowHead emoji={row.emoji} meta={row.meta} title={row.title} />
      {row.body ? (
        <Text style={styles.body} numberOfLines={2}>
          {row.body}
        </Text>
      ) : null}
      <View style={[styles.pair, styles.pairSpaced]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${QUESTION_QUEUE_COPY.start} ${row.title}`}
          accessibilityState={{ busy: starting }}
          disabled={starting}
          onPress={onStart}
          style={({ pressed }) => [
            styles.button,
            styles.buttonStart,
            (pressed || starting) && styles.pressed,
          ]}
        >
          {starting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.buttonPrimaryText}>{QUESTION_QUEUE_COPY.start}</Text>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={starting}
          onPress={onNotNow}
          style={({ pressed }) => [
            styles.button,
            styles.buttonSecondary,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.buttonSecondaryText}>{QUESTION_QUEUE_COPY.notNow}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Indent that lines body text up under the title (emoji column + gap). */
const TEXT_INDENT = 34;

function makeStyles(c: Colors) {
  return StyleSheet.create({
    surface: {
      width: "100%",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      overflow: "hidden",
    },
    eyebrow: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      color: c.charcoalSubtle,
    },
    divided: { borderTopWidth: 1, borderTopColor: c.gray100 },
    row: { position: "relative", paddingHorizontal: 16, paddingVertical: 12 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    headReserve: { paddingRight: 92 },
    headEmoji: { fontSize: 22, lineHeight: 26, flexShrink: 0 },
    headBody: { flex: 1, minWidth: 0, gap: 2 },
    meta: {
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 17,
      color: c.charcoalSubtle,
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 16,
      lineHeight: 22,
      color: c.charcoal,
    },
    body: {
      marginTop: 4,
      paddingLeft: TEXT_INDENT,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoalMuted,
    },
    grid: { marginTop: 12, gap: 8 },
    gridRow: { flexDirection: "row", gap: 8, alignItems: "stretch" },
    cell: {
      flex: 1,
      minHeight: TOUCH,
      paddingHorizontal: 12,
      paddingVertical: CHOICE_CELL_PADDING_V,
      borderWidth: CHOICE_CELL_BORDER,
      borderColor: c.gray200,
      borderRadius: 10,
      backgroundColor: c.bg,
      alignItems: "center",
      justifyContent: "center",
    },
    cellPressed: { borderColor: c.teal, backgroundColor: c.cyanSubtle },
    cellText: {
      fontFamily: fonts.bold,
      fontSize: 14,
      lineHeight: 19,
      color: c.charcoal,
      textAlign: "center",
    },
    answered: { marginTop: 8, gap: 12 },
    reveal: {
      paddingLeft: TEXT_INDENT,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoal,
    },
    pair: { flexDirection: "row", gap: 8, alignItems: "stretch" },
    pairSpaced: { marginTop: 12 },
    button: {
      flex: 1,
      minHeight: TOUCH,
      borderRadius: 10,
      paddingHorizontal: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonPrimary: { backgroundColor: c.teal },
    buttonStart: { backgroundColor: c.violetSolid },
    buttonPrimaryText: {
      fontFamily: fonts.bold,
      fontSize: 15,
      color: c.white,
      textAlign: "center",
    },
    buttonSecondary: {
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bg,
    },
    buttonSecondaryText: {
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: c.charcoal,
      textAlign: "center",
    },
    pressed: { opacity: 0.8 },
  });
}
