// OnboardingFlow — first-run welcome experience for Rabbithole on iPad.
//
// A horizontal paged ScrollView (no Reanimated/PagerView) with 4 intro cards,
// progress dots, a Skip button, and a "Let's go" finish CTA. Landscape-first
// (mirrors the star-map full-bleed style). Shows once via a secure-store flag;
// on finish it deep-links into the scholar's welcome-unit first activity if
// that row is already on their plate, otherwise lands on Home.
//
// Philosophy: anti-parasocial, curiosity-first, on-brand for gifted kids.
// We introduce the app's *shape*, not a mascot. The tutor is a method.

import React, { useCallback, useRef, useState } from "react";
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConvexAuth } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { colors, fonts, palette } from "@/theme";
import { markOnboardingSeen } from "@/lib/onboardingStorage";

// ── Card data ─────────────────────────────────────────────────────────────

type Card = {
  emoji: string;
  headline: string;
  body: string;
  bg: string;
  textColor: string;
  accentColor: string;
};

const CARDS: Card[] = [
  {
    emoji: "✦",
    headline: "Your map",
    body: "Every curiosity you've ever had is a thread worth pulling. Rabbithole is where you follow them — across subjects, across ideas, wherever they lead.",
    bg: colors.navy,
    textColor: colors.white,
    accentColor: palette.violet[200],
  },
  {
    emoji: "💬",
    headline: "Your sessions live here",
    body: "A session is a conversation where you do the thinking. Open a thread, work through it, come back. The work belongs to you.",
    bg: palette.violet[600],
    textColor: colors.white,
    accentColor: palette.violet[200],
  },
  {
    emoji: "❓",
    headline: "The tutor asks, you think",
    body: "Don't expect answers. Expect better questions. The tutor is here to stretch your thinking — not to think for you. That part is yours.",
    bg: palette.orange[500],
    textColor: colors.white,
    accentColor: palette.orange[100],
  },
  {
    emoji: "⭐",
    headline: "A portrait, not a score",
    body: "Your learning record shows how far you've come and where you're pulled next. Stars are earned by wondering, struggling, and going deeper — never handed out.",
    bg: palette.cyan[600],
    textColor: colors.white,
    accentColor: palette.cyan[100],
  },
];

// ── Component ─────────────────────────────────────────────────────────────

type Props = {
  onDone: () => void;
};

export function OnboardingFlow({ onDone }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const { isAuthenticated } = useConvexAuth();

  // Pre-load the plate so we can deep-link into the welcome activity on finish.
  const plate = useQuery(
    api.scholarPlate.activeForMe,
    isAuthenticated ? {} : "skip",
  );

  const { width: screenWidth } = Dimensions.get("window");

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const idx = Math.round(x / screenWidth);
      setPageIndex(Math.max(0, Math.min(CARDS.length - 1, idx)));
    },
    [screenWidth],
  );

  const goToPage = useCallback(
    (idx: number) => {
      scrollRef.current?.scrollTo({ x: idx * screenWidth, animated: true });
      setPageIndex(idx);
    },
    [screenWidth],
  );

  const finish = useCallback(async () => {
    await markOnboardingSeen();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onDone();

    // Best-effort: find the welcome unit row on the plate and jump straight in.
    const plateRows = (plate?.rows ?? []) as Array<{
      sessionId: Id<"sessions"> | null;
      title: string;
      activityId: Id<"activities"> | null;
      unitTitle: string | null;
      notStarted: boolean;
    }>;
    const welcomeRow = plateRows.find(
      (r) =>
        r.unitTitle?.toLowerCase().includes("welcome") ||
        r.title?.toLowerCase().includes("what sparks") ||
        r.title?.toLowerCase().includes("rabbithole"),
    );
    if (welcomeRow?.sessionId) {
      router.push({
        pathname: "/session/[id]",
        params: { id: welcomeRow.sessionId, title: welcomeRow.title },
      });
    }
    // If no welcome row yet (plate still loading or unit not seeded), stay on Home.
  }, [onDone, plate, router]);

  const skip = useCallback(async () => {
    await markOnboardingSeen();
    onDone();
  }, [onDone]);

  const isLast = pageIndex === CARDS.length - 1;
  const card = CARDS[pageIndex];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Paged cards */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        scrollEventThrottle={16}
        style={styles.pager}
        contentContainerStyle={{ width: screenWidth * CARDS.length }}
        bounces={false}
        decelerationRate="fast"
      >
        {CARDS.map((c, i) => (
          <CardSlide key={i} card={c} width={screenWidth} insets={insets} />
        ))}
      </ScrollView>

      {/* Bottom chrome: dots + CTA — pinned over the cards */}
      <View
        style={[
          styles.chrome,
          {
            paddingBottom: Math.max(insets.bottom, 28),
            backgroundColor: card.bg,
          },
        ]}
      >
        {/* Progress dots */}
        <View style={styles.dots}>
          {CARDS.map((_, i) => (
            <Pressable
              key={i}
              onPress={() => goToPage(i)}
              style={[
                styles.dot,
                {
                  backgroundColor:
                    i === pageIndex
                      ? card.accentColor
                      : card.accentColor + "55",
                  width: i === pageIndex ? 22 : 8,
                },
              ]}
              accessibilityLabel={`Go to card ${i + 1}`}
            />
          ))}
        </View>

        {/* CTA row */}
        <View style={styles.ctaRow}>
          {!isLast && (
            <Pressable
              onPress={skip}
              style={({ pressed }) => [styles.skipBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Skip introduction"
            >
              <Text style={[styles.skipText, { color: card.accentColor }]}>
                Skip
              </Text>
            </Pressable>
          )}

          {isLast ? (
            <Pressable
              onPress={finish}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: card.accentColor },
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Start using Rabbithole"
            >
              <Text style={styles.primaryBtnText}>Let&apos;s go →</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => goToPage(pageIndex + 1)}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: card.accentColor },
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Next card"
            >
              <Text style={styles.primaryBtnText}>Next →</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

// ── Single card slide ─────────────────────────────────────────────────────

type SafeInsets = { top: number; bottom: number; left: number; right: number };

function CardSlide({
  card,
  width,
  insets,
}: {
  card: Card;
  width: number;
  insets: SafeInsets;
}) {
  return (
    <View
      style={[
        styles.slide,
        {
          width,
          backgroundColor: card.bg,
          paddingLeft: Math.max(insets.left, 48),
          paddingRight: Math.max(insets.right, 48),
        },
      ]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${card.headline}. ${card.body}`}
    >
      <Text style={styles.cardEmoji}>{card.emoji}</Text>
      <Text style={[styles.cardHeadline, { color: card.textColor }]}>
        {card.headline}
      </Text>
      <Text style={[styles.cardBody, { color: card.accentColor }]}>
        {card.body}
      </Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  pager: {
    flex: 1,
  },
  slide: {
    flex: 1,
    justifyContent: "center",
    paddingTop: 40,
    paddingBottom: 140,
    gap: 20,
  },
  cardEmoji: {
    fontSize: 52,
    lineHeight: 64,
    marginBottom: 8,
  },
  cardHeadline: {
    fontSize: 38,
    fontFamily: fonts.bold,
    lineHeight: 44,
    letterSpacing: -0.5,
  },
  cardBody: {
    fontSize: 20,
    fontFamily: fonts.medium,
    lineHeight: 30,
    maxWidth: 600,
  },
  chrome: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 16,
    paddingHorizontal: 32,
    gap: 14,
  },
  dots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 20,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  ctaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  skipBtn: {
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  skipText: {
    fontSize: 17,
    fontFamily: fonts.medium,
  },
  primaryBtn: {
    paddingVertical: 16,
    paddingHorizontal: 36,
    borderRadius: 999,
    marginLeft: "auto",
  },
  primaryBtnText: {
    color: colors.navy,
    fontSize: 17,
    fontFamily: fonts.bold,
  },
});
