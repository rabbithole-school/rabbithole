/**
 * QuestionCard (native) — the done-screen "Bonus question", the RN twin of web
 * components/practice/QuestionCard.tsx. One real, answerable question in place
 * of a paragraph to read. Parity of EXPERIENCE with web: same copy (the shared
 * QUESTION_CARD_COPY), same layout, same verdict language.
 *
 * BEFORE answering: a "Bonus question" pill, the prompt in big bold type, then
 * the choices as an EQUAL-SIZE grid (2 -> 1x2, 3 -> three equal columns,
 * 4 -> 2x2). Every cell is flex:1 inside a fixed-column row (equal width), and
 * every cell shares ONE height (the tallest measured cell, min 52pt) — so never
 * text-sized pills, never a 3+1 wrap. See questionCardState.ts.
 *
 * AFTER answering: the prompt and choices collapse. A small recap line, the big
 * emoji / art, the reveal in large bold type, then one full-width
 * "Done for today" button.
 *
 * NO FOLLOW-UP BUTTON (TRA-472, 2026-11-17): the card used to end in "Why? ->",
 * which opened a tutor session on the moment's seed. In prod, 20 of the 24 taps
 * led to a chat where the scholar never typed a word, and 3 of 76 cards led to
 * a real conversation. A wrong answer goes to the top of the Quests list
 * ("missed"), and a skipped card stays on it below the misses ("offered",
 * convex/lib/questionQueue.ts); both rows keep their own follow-up. A right
 * answer closes the question, and its story star stays in the Sky.
 *
 * VERDICT: reuses the existing PracticeVerdictStamp + the shared stamp / ring
 * styles in practiceShell ("Correct" green, "Not quite" amber; a miss is never
 * red). The verdict comes from isCorrectChoice immediately — it never waits on
 * the server — and honours reduced motion exactly as the stamp already does.
 *
 * LEDGER: on mount it records the "offered" event (recordMomentOffered, which
 * also mints the souvenir star). The
 * answer is recorded with recordMomentAnswer (first answer wins, idempotent).
 * Feedback-only: nothing here touches mastery or spaced repetition.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { makePracticeShellStyles } from "@/lib/practiceShell";
import { fonts, useColors, type Colors } from "@/theme";
import { PracticeVerdictStamp } from "@/components/practice/PracticeVerdictStamp";
import { makeClientEventId } from "../../../vendor/shared/practiceLoop";
import {
  QUESTION_CARD_COPY,
  type CardQuestion,
} from "../../../vendor/shared/questionCard";
import type { StoryMoment } from "../../../vendor/shared/storyReveal";
import {
  CHOICE_CELL_BORDER,
  CHOICE_CELL_MIN_HEIGHT,
  CHOICE_CELL_PADDING_V,
  choiceGridRows,
  commonCellHeight,
  questionCardView,
} from "./questionCardState";

type Offer = { eventId: Id<"momentEvents"> };

export function QuestionCard({
  scholarId,
  moment,
  question,
  onDone,
  onAnswered,
}: {
  scholarId: Id<"users">;
  moment: StoryMoment<Id<"seeds">>;
  question: CardQuestion;
  /** The existing page-level done/close action ("Done for today"). */
  onDone: () => void;
  /** Fired once when a choice is made, so the parent can retire its own quiet
   *  Done (the card carries "Done for today" itself once answered). */
  onAnswered?: () => void;
}) {
  const colors = useColors();
  const shell = useMemo(() => makePracticeShellStyles(colors), [colors]);
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const recordOffered = useMutation(api.practiceMoments.recordMomentOffered);
  const recordAnswer = useMutation(api.practiceMoments.recordMomentAnswer);

  const clientEventId = useMemo(() => makeClientEventId("story-moment"), []);
  const [initialOffer] = useState(() => ({ clientEventId, moment, recordOffered, scholarId }));
  const offerRef = useRef<Promise<Offer | null> | null>(null);

  // Fire-and-forget on mount. No "only once" ref guard: StrictMode double-invokes
  // effects and a guard would orphan the live invocation's promise; the
  // mutation's own idempotency (the stable clientEventId) covers the repeat.
  useEffect(() => {
    const m = initialOffer.moment;
    const momentArgs =
      m.kind === "seed"
        ? { kind: "seed" as const, seedId: m.seedId }
        : { kind: "story" as const, fromKey: m.fromKey, toKey: m.toKey };
    offerRef.current = initialOffer
      .recordOffered({
        scholarId: initialOffer.scholarId,
        clientEventId: initialOffer.clientEventId,
        ...momentArgs,
      })
      .then((res) => ({ eventId: res.eventId }))
      .catch(() => null);
  }, [initialOffer]);

  const [picked, setPicked] = useState<number | null>(null);
  const view = questionCardView(question, picked);

  const choose = useCallback(
    (index: number) => {
      if (picked !== null) return;
      setPicked(index);
      Haptics.selectionAsync().catch(() => {});
      onAnswered?.();
      // The verdict is already on screen; the ledger write trails it.
      void offerRef.current
        ?.then((offer) => {
          if (offer) return recordAnswer({ eventId: offer.eventId, choiceIndex: index });
        })
        .catch(() => {});
    },
    [onAnswered, picked, recordAnswer],
  );

  // One shared height for every choice cell, from each cell's natural content
  // height (see commonCellHeight).
  const [heights, setHeights] = useState<Array<number | undefined>>([]);
  const cellHeight = commonCellHeight(heights);
  const onCellLayout = useCallback((index: number, e: LayoutChangeEvent) => {
    const h = Math.ceil(e.nativeEvent.layout.height);
    setHeights((prev) => (prev[index] === h ? prev : Object.assign([...prev], { [index]: h })));
  }, []);

  const rows = useMemo(() => choiceGridRows(question.choices.length), [question.choices.length]);

  const artUrl = moment.kind === "story" ? moment.artUrl : undefined;
  const emoji = moment.visualEmoji;
  const feedback = view.answered ? view.feedback : null;

  return (
    <View
      style={[
        styles.card,
        feedback === "correct" && shell.stemBoxCorrect,
        feedback === "miss" && shell.stemBoxMiss,
      ]}
    >
      {!view.answered ? (
        <>
          <View style={styles.pill}>
            <Text style={styles.pillText}>{`🎲 ${QUESTION_CARD_COPY.bonusTag}`}</Text>
          </View>
          <Text style={styles.prompt} accessibilityRole="header">
            {question.prompt}
          </Text>
          <View style={styles.grid}>
            {rows.map((row, r) => (
              <View key={r} style={styles.row}>
                {row.map((i) => (
                  <Pressable
                    key={i}
                    onPress={() => choose(i)}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.cell,
                      { minHeight: cellHeight },
                      pressed && styles.cellPressed,
                    ]}
                  >
                    {/* Measure the content's NATURAL height (no minHeight
                        here), so the shared height can shrink again. */}
                    <View onLayout={(e) => onCellLayout(i, e)}>
                      <Text style={styles.cellText}>{question.choices[i]}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        </>
      ) : (
        <>
          <Text style={styles.recap}>{view.recap}</Text>
          {artUrl ? (
            <Image
              source={{ uri: artUrl }}
              alt=""
              style={styles.art}
              contentFit="contain"
              accessible={false}
            />
          ) : emoji ? (
            <Text accessible={false} style={styles.emoji}>
              {emoji}
            </Text>
          ) : null}
          <Text style={styles.reveal}>{question.reveal}</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={onDone}
              accessibilityRole="button"
              style={({ pressed }) => [styles.action, styles.primary, pressed && styles.cellPressed]}
            >
              <Text style={styles.primaryText}>{QUESTION_CARD_COPY.done}</Text>
            </Pressable>
          </View>
        </>
      )}
      <PracticeVerdictStamp feedback={feedback} shell={shell} />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      maxWidth: 520,
      alignSelf: "center",
      backgroundColor: c.bg,
      borderRadius: 22,
      borderWidth: 2,
      borderColor: c.border,
      paddingVertical: 24,
      paddingHorizontal: 20,
      alignItems: "center",
      gap: 16,
    },
    pill: {
      backgroundColor: c.violetSubtle,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    pillText: { fontFamily: fonts.bold, fontSize: 13, color: c.violetSolid },
    prompt: {
      fontFamily: fonts.bold,
      fontSize: 22,
      lineHeight: 28,
      color: c.fg,
      textAlign: "center",
    },
    grid: { width: "100%", gap: 10 },
    row: { flexDirection: "row", gap: 10, alignItems: "stretch" },
    cell: {
      flex: 1,
      minHeight: CHOICE_CELL_MIN_HEIGHT,
      borderWidth: CHOICE_CELL_BORDER,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.bgSubtle,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 10,
      paddingVertical: CHOICE_CELL_PADDING_V,
    },
    cellPressed: { opacity: 0.8 },
    cellText: { fontFamily: fonts.bold, fontSize: 16, color: c.fg, textAlign: "center" },
    recap: { fontFamily: fonts.medium, fontSize: 14, color: c.fgMuted, textAlign: "center" },
    art: { width: 150, height: 150 },
    emoji: { fontSize: 72, lineHeight: 80, textAlign: "center" },
    reveal: {
      fontFamily: fonts.bold,
      fontSize: 24,
      lineHeight: 31,
      color: c.fg,
      textAlign: "center",
    },
    actions: { width: "100%", gap: 10, marginTop: 4 },
    action: {
      width: "100%",
      minHeight: 52,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    primary: { backgroundColor: c.navy },
    primaryText: { fontFamily: fonts.bold, fontSize: 16, color: c.white },
  });
}
