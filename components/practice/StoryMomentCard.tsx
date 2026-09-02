"use client";

/**
 * StoryMomentCard — the "🚀 Quest unlocked" reveal shown on the practice done
 * screen when a skill just turned fluent with a verified world-connection story
 * (`practiceMoments.storyMomentForScholar`). Design B (night-sky reveal) from
 * scratch-specs/story-card-redesign-proposal.md, with Andy's tweaks.
 *
 * THE REVEAL. On mount, a field of small stars twinkles onto the night surface,
 * ONE brightens where the art will land, the story's baked art (or authored
 * `visualEmoji` fallback) springs in there, then the eyebrow + hook + teaser
 * fade up — ~0.5s, once, no loop — settling to a calm night card. This is a
 * DECLARED charm layer on a kid-facing celebratory surface
 * (visual-design.md's charm exception); the visual is the story's real referent,
 * so the cicada test holds. The
 * night surface + timings are shared with the native twin (parity rule).
 * Reduced motion (`prefers-reduced-motion`) collapses straight to the settled
 * end state. The night tokens are reused from components/ui/InvitationCard.tsx —
 * NOT a second night palette.
 *
 * NO CTA, NO NAVIGATION (Andy's tweak 3). The card no longer has a "Follow the
 * thread" button and no longer calls `createFromSeed`; the unified eyebrow
 * "🚀 Quest unlocked" carries the WHERE (🚀 is the app-wide quest glyph), and
 * the Quests-tab standing invitation (components/StoryInvitations.tsx) owns
 * opening/dismissing from here on. Tapping the card just reveals a transient
 * hint ("Find this in your Quests tab") and points there. Page-level Done (quiet
 * — PracticeSession.tsx) is the only navigation.
 *
 * LEDGER (no server change). On first render it records ONLY the "offered" event
 * — with a per-mount `clientEventId`, idempotent under re-render/reconnect — via
 * `recordMomentOffered` (unchanged; it also mints the souvenir star). The moment
 * simply STAYS `offered` at the close; the standing invitation's outcomes
 * (opened/dismissed) are already correct and own the rest. The only outcome this
 * card still records is terminal "tried", via the parent-held `markTried()` ref,
 * when the scholar starts THIS story's own linked application (honest
 * provenance). Rendered ONLY when the daily playlist is complete (see
 * PracticeSession.tsx `playlistComplete`). Kept in lockstep with the native twin
 * `native/src/components/practice/StoryMomentCard.tsx` (2026-07-04 parity rule:
 * type scale, spacing, motion, copy, and behavior).
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation } from "convex/react";
import { Box, Image, Text, VStack, chakra } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { makeClientEventId } from "@/shared/practiceLoop";
import {
  STORY_CARD_COPY,
  STORY_FIELD_SETTLED_OPACITY,
  STORY_HINT_MS,
  STORY_REVEAL_MS,
} from "@/shared/storyReveal";

export type StoryMoment = {
  fromKey: string;
  toKey: string;
  skillLabel: string;
  hook: string;
  // Short card teaser (hook + surprise). The card shows THIS in place of the
  // full narrative so the moment reads as a teaser, not a wall of text; the
  // full narrative still feeds the "Find out more" tutor thread (storyOpen).
  // Optional: falls back to narrative until stories are re-seeded with teasers.
  teaser?: string;
  /** Optional authored curiosity cue; legacy stories stay text-only. */
  visualEmoji?: string;
  /** Pre-baked far-end-node art. visualEmoji remains the fallback. */
  artUrl?: string;
  narrative: string;
  probe?: string;
  kindLabel: string;
  hasApplication: boolean;
};

type CardPhase = "offer" | "dismissed";

export type StoryMomentCardHandle = {
  markTried: () => void;
};

// The night-sky reveal, as CSS keyframes (no JS animation timers — only a mount
// class toggle). Base styles are the SETTLED end state, so `animation: none`
// under reduced motion lands each element straight there. Timings come from the
// shared module so the native Reanimated twin reads as the same motion.
const R = STORY_REVEAL_MS;
const REVEAL_CSS = `
@keyframes rh-story-field {
  0% { opacity: 0; }
  ${Math.round((R.fieldIn / R.total) * 100)}% { opacity: 1; }
  ${Math.round((R.settleStart / R.total) * 100)}% { opacity: 1; }
  100% { opacity: ${STORY_FIELD_SETTLED_OPACITY}; }
}
@keyframes rh-story-twinkle {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
@keyframes rh-story-shine {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.4); }
  20% { opacity: 1; transform: translate(-50%, -50%) scale(1.15); }
  55% { opacity: 0.55; transform: translate(-50%, -50%) scale(1.25); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1.45); }
}
@keyframes rh-story-emoji {
  0% { opacity: 0; transform: scale(0.3); }
  70% { opacity: 1; transform: scale(1.12); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes rh-story-rise {
  0% { opacity: 0; transform: translateY(6px); }
  100% { opacity: 1; transform: none; }
}
@keyframes rh-story-hint {
  0% { opacity: 0; transform: translateY(4px); }
  12% { opacity: 1; transform: none; }
  80% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: translateY(-2px); }
}
.rh-story-field { animation: rh-story-field ${R.total}ms ease both; }
.rh-story-star { animation: rh-story-twinkle ${R.total}ms ease-in-out; }
.rh-story-shine { animation: rh-story-shine ${R.total - R.shineStart}ms ease-out ${R.shineStart}ms both; }
.rh-story-emoji { animation: rh-story-emoji ${R.emojiDur}ms cubic-bezier(0.34, 1.56, 0.64, 1) ${R.emojiStart}ms both; }
.rh-story-rise { animation: rh-story-rise ${R.textDur}ms cubic-bezier(0.22, 1, 0.36, 1) ${R.textStart}ms both; }
.rh-story-hint { animation: rh-story-hint ${STORY_HINT_MS}ms ease both; }
@media (prefers-reduced-motion: reduce) {
  .rh-story-field,
  .rh-story-star,
  .rh-story-shine,
  .rh-story-emoji,
  .rh-story-rise,
  .rh-story-hint { animation: none; }
}
`;

// A fixed field of small stars (percent positions, px sizes, base opacity,
// stagger). Varied so it reads as a real sky rather than a grid. The hero shine
// is a separate element that lands ON the emoji, so it isn't in this list.
const STARS: {
  top: string;
  left: string;
  size: number;
  opacity: number;
  delay: number;
}[] = [
  { top: "18%", left: "12%", size: 3, opacity: 0.8, delay: 0 },
  { top: "30%", left: "82%", size: 2, opacity: 0.6, delay: 90 },
  { top: "62%", left: "8%", size: 2, opacity: 0.5, delay: 160 },
  { top: "74%", left: "70%", size: 3, opacity: 0.75, delay: 60 },
  { top: "14%", left: "60%", size: 2, opacity: 0.55, delay: 220 },
  { top: "48%", left: "92%", size: 2, opacity: 0.5, delay: 130 },
  { top: "82%", left: "34%", size: 2, opacity: 0.6, delay: 200 },
  { top: "40%", left: "24%", size: 2, opacity: 0.5, delay: 280 },
];

/** The scholar's Story reveal presentation, reusable without its ledger lifecycle. */
export function StoryMomentReveal({ moment }: { moment: StoryMoment }) {
  // Transient tap hint. Tapping reveals it for ~2s then it fades out; repeat
  // taps re-show it (a fresh key restarts the CSS animation). Never a toast.
  const [hintShown, setHintShown] = useState(false);
  const [hintKey, setHintKey] = useState(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showHint = useCallback(() => {
    setHintShown(true);
    setHintKey((k) => k + 1);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHintShown(false), STORY_HINT_MS);
  }, []);
  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  return (
    <Box
      position="relative"
      w="100%"
      maxW="520px"
      mx="auto"
      overflow="hidden"
      borderRadius="2xl"
      borderWidth="1px"
      borderColor="violet.400"
      color="white"
      bg="#101736"
      shadow="lg"
      css={{
        background:
          "linear-gradient(160deg, #241b52 0%, #141a3c 55%, #0b1026 100%)",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: REVEAL_CSS }} />

      {/* Star field — a declared charm layer, behind the content and inert to
          taps so the whole-card overlay still gets them. */}
      <Box
        className="rh-story-field"
        aria-hidden="true"
        position="absolute"
        inset={0}
        pointerEvents="none"
        opacity={STORY_FIELD_SETTLED_OPACITY}
      >
        {STARS.map((s, i) => (
          <Box
            key={i}
            className="rh-story-star"
            position="absolute"
            top={s.top}
            left={s.left}
            w={`${s.size}px`}
            h={`${s.size}px`}
            borderRadius="full"
            bg="white"
            opacity={s.opacity}
            style={{ animationDelay: `${s.delay}ms` }}
          />
        ))}
      </Box>

      <VStack
        position="relative"
        zIndex={1}
        align="center"
        textAlign="center"
        gap={2.5}
        px={7}
        pt={8}
        // Extra bottom air reserves the transient tap-hint pill's landing zone
        // (absolute, bottom≈8px) so it never covers the hook's last line.
        pb={12}
      >
        <Text
          className="rh-story-rise"
          fontSize="12px"
          fontWeight="700"
          color="#FFEC8A"
          textTransform="uppercase"
          letterSpacing="0.08em"
        >
          {STORY_CARD_COPY.eyebrow}
        </Text>

        {/* Hero cell — the shine lands behind the art/emoji, so it reads as
            "this star became the story." */}
        <Box
          position="relative"
          h={moment.artUrl ? { base: "132px", md: "150px" } : "84px"}
          w={moment.artUrl ? { base: "132px", md: "150px" } : "84px"}
          mt={1}
        >
          <Box
            className="rh-story-shine"
            aria-hidden="true"
            position="absolute"
            top="50%"
            left="50%"
            w="40px"
            h="40px"
            borderRadius="full"
            pointerEvents="none"
            opacity={0}
            css={{
              background:
                "radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(214,199,255,0.55) 45%, rgba(214,199,255,0) 72%)",
            }}
          />
          {moment.artUrl ? (
            <Image
              className="rh-story-emoji"
              src={moment.artUrl}
              alt=""
              aria-hidden="true"
              position="absolute"
              inset={0}
              w="100%"
              h="100%"
              objectFit="contain"
            />
          ) : moment.visualEmoji ? (
            <Text
              className="rh-story-emoji"
              aria-hidden="true"
              position="absolute"
              inset={0}
              display="flex"
              alignItems="center"
              justifyContent="center"
              fontSize="76px"
              lineHeight="1"
            >
              {moment.visualEmoji}
            </Text>
          ) : null}
        </Box>

        <Text
          className="rh-story-rise"
          fontFamily="heading"
          fontWeight="800"
          fontSize="26px"
          lineHeight="1.2"
          color="white"
        >
          {moment.hook}
        </Text>
        <Text
          className="rh-story-rise"
          fontSize="16px"
          lineHeight="1.6"
          color="whiteAlpha.800"
          maxW="46ch"
        >
          {moment.teaser ?? moment.narrative}
        </Text>
      </VStack>

      {/* Whole-card tap → the transient hint. The button carries the hint copy
          as its accessible label so a screen-reader user gets the "where" on
          focus, and the visible hint (aria-live polite) announces on tap. */}
      <chakra.button
        type="button"
        position="absolute"
        inset={0}
        zIndex={2}
        cursor="pointer"
        aria-label={STORY_CARD_COPY.hint}
        onClick={showHint}
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "violet.200",
          outlineOffset: "-2px",
        }}
      />

      {hintShown && (
        <Box
          key={hintKey}
          className="rh-story-hint"
          position="absolute"
          left={0}
          right={0}
          bottom={2}
          zIndex={3}
          pointerEvents="none"
          textAlign="center"
        >
          <Text
            display="inline-block"
            fontSize="13px"
            fontWeight="600"
            color="white"
            bg="whiteAlpha.200"
            borderRadius="full"
            px={3}
            py={1}
            aria-live="polite"
          >
            {STORY_CARD_COPY.hint}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function StoryMomentCard({
  scholarId,
  moment,
  settleRef,
}: {
  scholarId: Id<"users">;
  moment: StoryMoment;
  /** Lets the parent record terminal "tried" when the scholar starts THIS
   *  story's own linked application (so the ledger stays honest). A ref (not a
   *  prop) because it's an imperative, at-most-once external event, not part of
   *  normal render data flow. No-ops once the card is already settled. Walking
   *  away records nothing (the moment stays `offered`); the story waits in the
   *  Quests tab's "New stories" section. */
  settleRef?: React.Ref<StoryMomentCardHandle>;
}) {
  const recordOffered = useMutation(api.practiceMoments.recordMomentOffered);
  const recordOutcome = useMutation(api.practiceMoments.recordMomentOutcome);
  const clientEventId = useMemo(() => makeClientEventId("story-moment"), []);
  const [phase, setPhase] = useState<CardPhase>("offer");
  const offerRef = useRef<Promise<Id<"momentEvents"> | null> | null>(null);

  useEffect(() => {
    offerRef.current = recordOffered({
      scholarId,
      fromKey: moment.fromKey,
      toKey: moment.toKey,
      clientEventId,
    })
      .then((res) => res.eventId)
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recordWhenOffered = useCallback(
    (outcome: "opened" | "probed" | "tried" | "dismissed") => {
      void offerRef.current
        ?.then((id) => {
          if (id) return recordOutcome({ eventId: id, outcome });
        })
        .catch(() => {});
    },
    [recordOutcome],
  );
  const settledRef = useRef(false);
  const settleWith = useCallback(
    (outcome: "tried") => {
      if (settledRef.current) return;
      settledRef.current = true;
      recordWhenOffered(outcome);
      setPhase("dismissed");
    },
    [recordWhenOffered],
  );

  useImperativeHandle(settleRef, () => ({ markTried: () => settleWith("tried") }), [
    settleWith,
  ]);

  if (phase === "dismissed") return null;
  return <StoryMomentReveal moment={moment} />;
}
