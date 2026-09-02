/**
 * StoryMomentCard (native) — the "🚀 Quest unlocked" reveal, the RN twin of web
 * components/practice/StoryMomentCard.tsx. Design B (night-sky reveal) from
 * scratch-specs/story-card-redesign-proposal.md, with Andy's tweaks. Kept in
 * lockstep with the web twin (2026-07-04 parity rule: type scale, spacing,
 * motion, copy, and behavior), sharing the reveal timings + locked copy from
 * the vendored shared/storyReveal.
 *
 * THE REVEAL (Reanimated). On mount, a field of small stars twinkles onto the
 * night surface, ONE brightens where the art will land, the story's baked art
 * (or authored `visualEmoji` fallback) springs in there, then the eyebrow + hook
 * + teaser fade up — ~0.5s, once, no loop — settling to a calm night card. A
 * DECLARED charm layer on a kid-facing celebratory surface
 * (visual-design.md's charm exception); the visual is the story's real referent
 * from the registry (cicada test holds).
 * ⚠️ No `runOnJS` inside any withTiming/withSequence completion callback (it
 * SIGABRTs with the React Compiler on) — the reveal is fire-and-forget shared
 * values, sequenced by withDelay/withSequence, never a completion callback.
 * Reduce Motion (`AccessibilityInfo.isReduceMotionEnabled`) collapses straight
 * to the settled end state. The night surface reuses the native InvitationCard's
 * night tokens (navy[900] ground, violet[400] border) — NOT a second palette.
 *
 * NO CTA, NO NAVIGATION (Andy's tweak 3). No "Follow the thread" button, no
 * `createFromSeed`; the unified eyebrow "🚀 Quest unlocked" carries the WHERE
 * (🚀 is the app-wide quest glyph), and the Quests-tab standing invitation
 * (native/src/components/StoryInvitations) owns opening/dismissing. Tapping the
 * card reveals a transient hint ("Find this in your Quests tab") and points
 * there. Page-level Done (quiet — practice.tsx) is the only navigation.
 *
 * LEDGER (no server change). On mount it records ONLY the "offered" event (via
 * `recordMomentOffered`, unchanged — it also mints the souvenir star), with a
 * per-mount `clientEventId`, idempotent under re-render/reconnect. The moment
 * STAYS `offered` at the close; the standing invitation's outcomes are already
 * correct. The one outcome this card still records is terminal "tried", via the
 * parent-held `markTried()` ref, when the scholar starts THIS story's own linked
 * application. Rendered ONLY when the daily playlist is complete (practice.tsx
 * `playlistComplete`).
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from "react-native";
import type { DimensionValue } from "react-native";
import { Image } from "expo-image";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { makeClientEventId } from "../../../vendor/shared/practiceLoop";
import {
  STORY_CARD_COPY,
  STORY_FIELD_SETTLED_OPACITY,
  STORY_HINT_MS,
  STORY_REVEAL_MS,
} from "../../../vendor/shared/storyReveal";
import { fonts, palette } from "@/theme";

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

const R = STORY_REVEAL_MS;

// The star field, mirrored from the web twin (percent positions, px sizes, base
// opacity). Twinkle is folded into the field container (a gentle shimmer) rather
// than per-star, so the whole field is one bounded, non-looping animation.
const STARS: { top: DimensionValue; left: DimensionValue; size: number; opacity: number }[] = [
  { top: "18%", left: "12%", size: 3, opacity: 0.8 },
  { top: "30%", left: "82%", size: 2, opacity: 0.6 },
  { top: "62%", left: "8%", size: 2, opacity: 0.5 },
  { top: "74%", left: "70%", size: 3, opacity: 0.75 },
  { top: "14%", left: "60%", size: 2, opacity: 0.55 },
  { top: "48%", left: "92%", size: 2, opacity: 0.5 },
  { top: "82%", left: "34%", size: 2, opacity: 0.6 },
  { top: "40%", left: "24%", size: 2, opacity: 0.5 },
];

export function StoryMomentCard({
  scholarId,
  moment,
  settleRef,
}: {
  scholarId: Id<"users">;
  moment: StoryMoment;
  /** Lets the parent record terminal "tried" when the scholar starts THIS
   *  story's own linked application. Mirrors the web card. No dismissed-settle:
   *  walking away records nothing (the moment stays `offered`), and the story
   *  waits in the Quests tab's "New stories" section. No-ops once settled. */
  settleRef?: React.Ref<StoryMomentCardHandle>;
}) {
  const recordOffered = useMutation(api.practiceMoments.recordMomentOffered);
  const recordOutcome = useMutation(api.practiceMoments.recordMomentOutcome);

  const clientEventId = useMemo(() => makeClientEventId("story-moment"), []);
  const [phase, setPhase] = useState<CardPhase>("offer");
  const [initialOffer] = useState(() => ({
    clientEventId,
    fromKey: moment.fromKey,
    recordOffered,
    scholarId,
    toKey: moment.toKey,
  }));

  // Holds the in-flight offer so an outcome recorded BEFORE it resolves (a fast
  // markTried) still lands on the right row instead of being dropped. Mirrors
  // the web card exactly.
  const offerRef = useRef<Promise<Id<"momentEvents"> | null> | null>(null);

  // Fire-and-forget on mount. Deliberately NO "only call once" ref guard —
  // React 19 StrictMode dev double-invokes this effect, and an early-return
  // guard would orphan the second (live) invocation's offer promise. Relying
  // instead on the mutation's OWN idempotency (the stable `clientEventId`).
  useEffect(() => {
    offerRef.current = initialOffer
      .recordOffered({
        scholarId: initialOffer.scholarId,
        fromKey: initialOffer.fromKey,
        toKey: initialOffer.toKey,
        clientEventId: initialOffer.clientEventId,
      })
      .then((res) => res.eventId)
      .catch(() => {
        // Offered-recently / edge-not-eligible races are expected. The card
        // still reads fine; the moment stays as its original row and the
        // standing invitation owns the rest.
        return null;
      });
  }, [initialOffer]);

  // Record against the offer whenever it resolves — before OR after.
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

  // Settle the card exactly once, recording the terminal outcome.
  //
  // ⚠️ The record must happen OUTSIDE a setState updater. The parent settles
  // this card and starts the bonus round in the same batch, so the card
  // unmounts before a queued updater ever runs — a side effect inside
  // `setPhase` is silently dropped and the ledger keeps reading "offered".
  // `settledRef` is the at-most-once guard.
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

  // Imperative external "tried" mark — mirrors the web card. Harmless to the
  // story: the star was already minted server-side when the card was offered.
  useImperativeHandle(settleRef, () => ({ markTried: () => settleWith("tried") }), [
    settleWith,
  ]);

  // ── The reveal (Reanimated) ────────────────────────────────────────────────
  // Base values = the hidden START; the effect drives each to its settled END.
  const field = useSharedValue(0);
  const twinkle = useSharedValue(1);
  const shine = useSharedValue(0);
  const emoji = useSharedValue(0);
  const text = useSharedValue(0);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Read Reduce Motion first; then EITHER snap to the settled end state OR run
    // the sequence. No completion callbacks — so no runOnJS-in-callback crash.
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (cancelled || started.current) return;
        started.current = true;
        if (reduce) {
          field.set(STORY_FIELD_SETTLED_OPACITY);
          twinkle.set(1);
          shine.set(1); // shine's END is "gone" (interpolates to opacity 0)
          emoji.set(1);
          text.set(1);
          return;
        }
        field.set(
          withSequence(
            withTiming(1, { duration: R.fieldIn, easing: Easing.out(Easing.quad) }),
            withDelay(
              R.settleStart - R.fieldIn,
              withTiming(STORY_FIELD_SETTLED_OPACITY, {
                duration: R.settleDur,
                easing: Easing.inOut(Easing.quad),
              }),
            ),
          ),
        );
        // Gentle shimmer during the reveal, settling back to 1 (even reps).
        twinkle.set(withRepeat(withTiming(0.7, { duration: 200 }), 4, true));
        shine.set(
          withDelay(
            R.shineStart,
            withTiming(1, {
              duration: R.total - R.shineStart,
              easing: Easing.inOut(Easing.quad),
            }),
          ),
        );
        emoji.set(
          withDelay(
            R.emojiStart,
            withTiming(1, { duration: R.emojiDur, easing: Easing.out(Easing.cubic) }),
          ),
        );
        text.set(
          withDelay(
            R.textStart,
            withTiming(1, { duration: R.textDur, easing: Easing.out(Easing.cubic) }),
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [emoji, field, shine, text, twinkle]);

  const fieldStyle = useAnimatedStyle(() => ({ opacity: field.get() * twinkle.get() }));
  const shineStyle = useAnimatedStyle(() => {
    const p = shine.get();
    return {
      opacity: interpolate(p, [0, 0.2, 0.55, 1], [0, 1, 0.55, 0]),
      transform: [{ scale: interpolate(p, [0, 0.2, 0.55, 1], [0.4, 1.15, 1.25, 1.45]) }],
    };
  });
  const emojiStyle = useAnimatedStyle(() => {
    const p = emoji.get();
    return {
      opacity: interpolate(p, [0, 0.7, 1], [0, 1, 1]),
      transform: [{ scale: interpolate(p, [0, 0.7, 1], [0.3, 1.12, 1]) }],
    };
  });
  const textStyle = useAnimatedStyle(() => ({
    opacity: text.get(),
    transform: [{ translateY: interpolate(text.get(), [0, 1], [6, 0]) }],
  }));

  // ── Transient tap hint ─────────────────────────────────────────────────────
  const [hintShown, setHintShown] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showHint = useCallback(() => {
    setHintShown(true);
    AccessibilityInfo.announceForAccessibility(STORY_CARD_COPY.hint);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHintShown(false), STORY_HINT_MS);
  }, []);
  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  if (phase === "dismissed") return null;

  return (
    <Pressable
      onPress={showHint}
      accessibilityRole="button"
      accessibilityLabel={STORY_CARD_COPY.hint}
      style={styles.card}
    >
      {/* Star field — a declared charm layer, behind the content. */}
      <Animated.View
        style={[styles.field, fieldStyle]}
        pointerEvents="none"
        accessible={false}
      >
        {STARS.map((s, i) => (
          <View
            key={i}
            style={{
              position: "absolute",
              top: s.top,
              left: s.left,
              width: s.size,
              height: s.size,
              borderRadius: s.size / 2,
              backgroundColor: palette.white,
              opacity: s.opacity,
            }}
          />
        ))}
      </Animated.View>

      <Animated.Text style={[styles.eyebrow, textStyle]}>
        {STORY_CARD_COPY.eyebrow}
      </Animated.Text>

      {/* Hero cell — the shine blooms here, behind the art/emoji. */}
      <View style={[styles.emojiCell, moment.artUrl && styles.artCell]}>
        <Animated.View style={[styles.shine, shineStyle]} pointerEvents="none" />
        {moment.artUrl ? (
          <Animated.View style={[styles.artHero, emojiStyle]}>
            <Image
              source={{ uri: moment.artUrl }}
              alt=""
              style={styles.artImage}
              contentFit="contain"
              accessible={false}
            />
          </Animated.View>
        ) : moment.visualEmoji ? (
          <Animated.Text accessible={false} style={[styles.visualEmoji, emojiStyle]}>
            {moment.visualEmoji}
          </Animated.Text>
        ) : null}
      </View>

      <Animated.Text style={[styles.hook, textStyle]}>{moment.hook}</Animated.Text>
      <Animated.Text style={[styles.teaser, textStyle]}>
        {moment.teaser ?? moment.narrative}
      </Animated.Text>

      {hintShown ? (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(400)}
          style={styles.hintWrap}
          pointerEvents="none"
        >
          <Text style={styles.hintText} accessibilityLiveRegion="polite">
            {STORY_CARD_COPY.hint}
          </Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Night surface — reuse the native InvitationCard night tokens (navy[900]
  // ground, violet[400] border), not a second palette. The card is ALWAYS dark
  // ground, in both light and dark mode, so its ink is fixed (not scheme-aware).
  card: {
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    backgroundColor: palette.navy[900],
    borderRadius: 22,
    borderWidth: 1,
    borderColor: palette.violet[400],
    overflow: "hidden",
    paddingTop: 28,
    // Extra bottom air reserves the transient tap-hint pill's landing zone
    // (absolute, bottom:10) so it never covers the hook's last line.
    paddingBottom: 46,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 10,
  },
  field: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: STORY_FIELD_SETTLED_OPACITY,
  },
  eyebrow: {
    fontFamily: fonts.bold,
    fontSize: 12,
    letterSpacing: 0.72,
    color: palette.yellow[400],
    textTransform: "uppercase",
    textAlign: "center",
  },
  emojiCell: {
    width: 84,
    height: 84,
    marginTop: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  artCell: {
    width: 150,
    height: 150,
  },
  artHero: {
    width: 150,
    height: 150,
  },
  artImage: {
    width: "100%",
    height: "100%",
  },
  shine: {
    position: "absolute",
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: palette.white,
    shadowColor: "#d6c7ff",
    shadowOpacity: 0.9,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  visualEmoji: { fontSize: 72, lineHeight: 78, textAlign: "center" },
  hook: {
    fontFamily: fonts.bold,
    fontSize: 26,
    lineHeight: 31,
    color: palette.white,
    textAlign: "center",
  },
  teaser: {
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 25.6,
    color: palette.navy[100],
    textAlign: "center",
    maxWidth: 360,
  },
  hintWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 10,
    alignItems: "center",
  },
  hintText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: palette.white,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    overflow: "hidden",
  },
});
