"use client";

/**
 * QuestionCard — the done-screen "Bonus question" that replaced the no-CTA
 * "Quest unlocked" reveal (StoryMomentCard). One tappable multiple-choice
 * question; on tap the question collapses to a one-line recap, the reveal and
 * its emoji appear, and "Why? →" opens a tutor session right there from the
 * moment's seed.
 *
 * FEEDBACK-ONLY: answering never touches mastery or spaced repetition (the
 * story-surface invariant, .claude/rules/rabbithole-practice-engine.md). The
 * verdict is shown instantly from the question's own `answerIndex`; the server
 * independently records the answer (`recordMomentAnswer`) for the ledger and
 * the tutor's opening.
 *
 * LEDGER: like StoryMomentCard, records the "offered" event on mount (which
 * also keeps the story's souvenir star) and exposes `markTried` for the parent
 * when the scholar starts this story's own linked application. Contract:
 * shared/questionCard.ts. Native twin: native/src/components/practice/
 * QuestionCard.tsx (parity rule: type scale, spacing, copy, behavior).
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { Box, Button, Grid, Image, Text, VStack, chakra } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { makeClientEventId } from "@/shared/practiceLoop";
import {
  QUESTION_CARD_COPY,
  isCorrectChoice,
  questionRecap,
  type CardQuestion,
} from "@/shared/questionCard";
import type { StoryMoment } from "@/shared/storyReveal";
import type { StoryMomentCardHandle } from "@/components/practice/StoryMomentCard";
import {
  VERDICT_MOTION_CSS,
  VerdictStamp,
  verdictRing,
} from "@/components/practice/VerdictStamp";

export type QuestionMoment = StoryMoment<Id<"seeds">> & {
  question: CardQuestion;
};

type OfferResult = { eventId: Id<"momentEvents">; seedId: Id<"seeds"> | null };

/** Equal-width columns: 2 → 2, 4 → 2×2 narrow / 4 across from md, 3 → stacked
 *  narrow / 3 across from md. Never a 3+1 wrap, never text-sized pills. */
function columnsFor(count: number) {
  if (count === 4) return { base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" };
  if (count === 3) return { base: "1fr", md: "repeat(3, 1fr)" };
  return "repeat(2, 1fr)";
}

export function QuestionCard({
  scholarId,
  moment,
  settleRef,
  onAnswered,
}: {
  scholarId: Id<"users">;
  moment: QuestionMoment;
  /** Same imperative handle StoryMomentCard exposes: records terminal "tried"
   *  when the scholar starts this story's own linked application. */
  settleRef?: React.Ref<StoryMomentCardHandle>;
  /** Fires once, when the scholar picks a choice — the card then carries its
   *  own "Done for today", so the parent hides its standalone Done. */
  onAnswered?: () => void;
}) {
  const { question } = moment;
  const router = useRouter();
  const recordOffered = useMutation(api.practiceMoments.recordMomentOffered);
  const recordOutcome = useMutation(api.practiceMoments.recordMomentOutcome);
  const recordAnswer = useMutation(api.practiceMoments.recordMomentAnswer);
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const clientEventId = useMemo(() => makeClientEventId("question-card"), []);
  const offerRef = useRef<Promise<OfferResult | null> | null>(null);
  const [seedId, setSeedId] = useState<Id<"seeds"> | null>(
    moment.kind === "seed" ? moment.seedId : null,
  );
  const [noSeed, setNoSeed] = useState(false);
  const [choice, setChoice] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  const whyRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const momentArgs =
      moment.kind === "seed"
        ? { kind: "seed" as const, seedId: moment.seedId }
        : {
            kind: "story" as const,
            fromKey: moment.fromKey,
            toKey: moment.toKey,
          };
    offerRef.current = recordOffered({ scholarId, clientEventId, ...momentArgs })
      .then((res) => {
        if (res.seedId) setSeedId(res.seedId);
        else setNoSeed(true);
        return res;
      })
      .catch(() => {
        if (moment.kind === "story") setNoSeed(true);
        return null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settledRef = useRef(false);
  useImperativeHandle(
    settleRef,
    () => ({
      markTried: () => {
        if (settledRef.current) return;
        settledRef.current = true;
        void offerRef.current
          ?.then((res) => {
            if (res) return recordOutcome({ eventId: res.eventId, outcome: "tried" });
          })
          .catch(() => {});
      },
    }),
    [recordOutcome],
  );

  const answered = choice !== null;
  const tone = !answered
    ? null
    : isCorrectChoice(question, choice)
      ? ("correct" as const)
      : ("miss" as const);
  const ring = verdictRing(tone);

  const pick = useCallback(
    (index: number) => {
      if (choice !== null) return;
      setChoice(index);
      onAnswered?.();
      // The verdict above is already on screen; the ledger write follows once
      // the offer row exists. Best-effort — never blocks the card.
      void offerRef.current
        ?.then((res) => {
          if (res) return recordAnswer({ eventId: res.eventId, choiceIndex: index });
        })
        .catch(() => {});
    },
    [choice, onAnswered, recordAnswer],
  );

  // After the collapse the choice buttons unmount; land focus on the follow-up.
  useEffect(() => {
    if (answered) whyRef.current?.focus();
  }, [answered]);

  const why = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      let id = seedId;
      if (!id) id = (await offerRef.current)?.seedId ?? null;
      if (!id) {
        setOpening(false);
        return;
      }
      // createSessionFromSeedCore advances the moment to "opened" server-side.
      const res = await createFromSeed({ seedId: id });
      if (res) router.push(`/scholar/${res.id}`);
      else setOpening(false);
    } catch {
      setOpening(false);
    }
  }, [opening, seedId, createFromSeed, router]);

  const artUrl = moment.kind === "story" ? moment.artUrl : undefined;
  const emoji = moment.visualEmoji;

  return (
    <Box position="relative" w="calc(100% - 24px)" maxW="520px" mx="auto">
      <style dangerouslySetInnerHTML={{ __html: VERDICT_MOTION_CSS }} />
      <Box
        bg="white"
        borderWidth="1px"
        borderStyle="solid"
        borderColor={ring.borderColor}
        boxShadow={ring.boxShadow}
        borderRadius="16px"
        p={{ base: 5, md: 6 }}
        transition="border-color 0.3s, box-shadow 0.3s"
        className={tone === "miss" ? "rh-shake" : undefined}
      >
        {!answered ? (
          <VStack gap={4} align="stretch">
            <Text
              alignSelf="center"
              fontSize="12px"
              fontWeight="700"
              color="#5a4a99"
              bg="#f0ecfb"
              borderRadius="full"
              px={3}
              py={1}
            >
              🎲 {QUESTION_CARD_COPY.bonusTag}
            </Text>
            <Text
              as="h2"
              fontFamily="heading"
              fontWeight="800"
              fontSize="22px"
              lineHeight="1.3"
              textAlign="center"
            >
              {question.prompt}
            </Text>
            <Grid
              templateColumns={columnsFor(question.choices.length)}
              gridAutoRows="1fr"
              gap={3}
              role="group"
              aria-label={question.prompt}
            >
              {question.choices.map((text, i) => (
                <chakra.button
                  key={i}
                  type="button"
                  onClick={() => pick(i)}
                  minH="52px"
                  px={3}
                  py={2}
                  borderWidth="2px"
                  borderStyle="solid"
                  borderColor="#ded8cb"
                  borderRadius="12px"
                  bg="white"
                  fontSize="16px"
                  fontWeight="700"
                  textAlign="center"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  cursor="pointer"
                  _hover={{ borderColor: "#14b8a6", bg: "#f3fbf9" }}
                  _focusVisible={{
                    outline: "3px solid",
                    outlineColor: "teal.500",
                    outlineOffset: "2px",
                  }}
                >
                  {text}
                </chakra.button>
              ))}
            </Grid>
          </VStack>
        ) : (
          <VStack gap={4} align="stretch" className="rh-note">
            <Text fontSize="14px" color="#65706a" textAlign="center">
              {questionRecap(question, choice)}
            </Text>
            <VStack gap={2}>
              {artUrl ? (
                <Image src={artUrl} alt="" aria-hidden="true" h="96px" w="96px" objectFit="contain" />
              ) : emoji ? (
                <Text aria-hidden="true" fontSize="64px" lineHeight="1">
                  {emoji}
                </Text>
              ) : null}
              <Text
                fontFamily="heading"
                fontWeight="800"
                fontSize="24px"
                lineHeight="1.25"
                textAlign="center"
              >
                {question.reveal}
              </Text>
            </VStack>
            <VStack gap={3} align="stretch" pt={1}>
              {/* A legacy offer with no minted star has nothing to open, so the
                  follow-up is omitted rather than shown dead. */}
              {!noSeed && (
                <Button
                  ref={whyRef}
                  colorPalette="teal"
                  size="lg"
                  w="100%"
                  loading={opening}
                  onClick={why}
                >
                  {question.whyLabel ?? QUESTION_CARD_COPY.why}
                </Button>
              )}
              <Button asChild variant="outline" size="lg" w="100%">
                <Link href="/scholar">{QUESTION_CARD_COPY.done}</Link>
              </Button>
            </VStack>
          </VStack>
        )}
      </Box>
      {/* The sighted stamp is decorative; the always-mounted status region is
          what a screen reader hears, so the verdict is announced exactly once. */}
      <Box aria-hidden="true">
        <VerdictStamp tone={tone} />
      </Box>
      <chakra.p
        role="status"
        aria-live="polite"
        position="absolute"
        w="1px"
        h="1px"
        overflow="hidden"
        clipPath="inset(50%)"
        whiteSpace="nowrap"
      >
        {tone === "correct"
          ? QUESTION_CARD_COPY.correct
          : tone === "miss"
            ? QUESTION_CARD_COPY.miss
            : ""}
      </chakra.p>
    </Box>
  );
}
