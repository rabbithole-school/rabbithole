// StarDrawer — a Reanimated bottom sheet that opens when the scholar taps a star
// on the sky map. Shows the concept name, domain, mastery evidence (visit count +
// last-visited date), the blurb, and a "Begin / Return to quest" CTA.
//
// Animation contract:
//   • When `star` becomes non-null  → spring-open from off-screen
//   • When `star` becomes null      → quick ease-in close, then clears displayStar
//
// The backdrop captures taps to dismiss and fades in/out alongside the sheet.

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import type { PositionedStar } from "@/lib/skyLayout";
import { colorForDomain, palette } from "@/theme";
import { SpeakableLabel } from "@/components/SpeakableLabel";

const DRAWER_OFFSCREEN = 560; // px below screen; enough for any content height

function reachLabel(reach: number | null | undefined): string {
  const r = reach ?? 1;
  if (r <= 0.2) return "Next step";
  if (r < 1.5) return "Nearby";
  return "Frontier";
}

function visitLabel(count: number): string {
  if (count === 0) return "First visit";
  if (count === 1) return "Visited once";
  if (count === 2) return "Visited twice";
  return `Visited ${count}×`;
}

function completionLabel(ts: number | null | undefined): string {
  const rel = relativeTime(ts);
  return rel ? `Completed ${rel}` : "Completed";
}

function relativeTime(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

type Props = {
  star: PositionedStar | null;
  onDismiss: () => void;
  onBeginQuest: () => void;
  starting: boolean;
};

export function StarDrawer({ star, onDismiss, onBeginQuest, starting }: Props) {
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(DRAWER_OFFSCREEN);
  const backdropOpacity = useSharedValue(0);

  // Keep content alive through the close animation so the sheet doesn't blank out
  // mid-slide. Updated to the new star immediately on open; cleared after close.
  const [displayStar, setDisplayStar] = useState<PositionedStar | null>(null);
  const prevStar = useRef<PositionedStar | null>(null);

  useEffect(() => {
    if (star === prevStar.current) return;
    prevStar.current = star;

    if (star) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Retain the incoming star before opening so the exit animation has stable content.
      setDisplayStar(star);
      backdropOpacity.set(withTiming(1, { duration: 220 }));
      translateY.set(withSpring(0, { damping: 32, stiffness: 380, mass: 0.85 }));
    } else {
      backdropOpacity.set(withTiming(0, { duration: 190 }));
      translateY.set(withTiming(
        DRAWER_OFFSCREEN,
        { duration: 190, easing: Easing.in(Easing.cubic) },
        (done) => {
          if (done) runOnJS(setDisplayStar)(null);
        },
      ));
    }
  }, [star, translateY, backdropOpacity]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.get(),
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.get() }],
  }));

  // Nothing to render when fully closed and no content
  if (!displayStar && !star) return null;

  const ds = displayStar;
  const color = colorForDomain(ds?.domain ?? null);

  return (
    <>
      {/* Semi-transparent backdrop — tap to dismiss */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      </Animated.View>

      {/* Sheet */}
      <Animated.View
        style={[styles.sheet, { paddingBottom: insets.bottom + 24 }, sheetStyle]}
      >
        {/* Inner Pressable stops taps from falling through to the backdrop */}
        <Pressable onPress={() => {}}>
          <View style={styles.grabber} />

          {ds && (
            <>
              {/* ── Eyebrow: domain + badges ─────────────────────────────── */}
              <View style={styles.eyebrowRow}>
                <View
                  style={[
                    styles.accentDot,
                    { backgroundColor: color, shadowColor: color },
                  ]}
                />
                <Text style={[styles.eyebrow, { color }]}>
                  {(ds.domain ?? "General").toUpperCase()}
                  {ds.role === "mastery" ? "  ·  YOU BUILT THIS" : ""}
                  {ds.role === "standard" ? "  ·  REACHED" : ""}
                  {ds.role === "starter" ? "  ·  A STAR TO GROW INTO" : ""}
                  {ds.role === "territory" ? "  ·  WIDER FIELD" : ""}
                  {ds.suggestionType === "leap" ? "  ·  LEAP" : ""}
                  {ds.structured ? "  ·  GUIDED PATH" : ""}
                  {ds.completed ? "  ·  YOU'VE BEEN HERE" : ""}
                </Text>
              </View>

              {/* ── Title ────────────────────────────────────────────────── */}
              {/* Tap-to-hear the seed hook (young-learners plan §6/§11): a
                  pre-reader taps the star, then taps the speaker to hear the
                  topic + blurb read aloud through the existing TTS path. */}
              <View style={styles.titleRow}>
                <SpeakableLabel
                  text={[ds.topic, ds.blurb].filter(Boolean).join(". ")}
                  iconSize={20}
                  color={color}
                  accessibilityLabel={`Hear about ${ds.topic}`}
                >
                  <Text style={[styles.topicTitle, styles.topicTitleFlex]}>
                    {ds.topic}
                  </Text>
                </SpeakableLabel>
              </View>

              {/* ── Lateral connection ───────────────────────────────────── */}
              {ds.connectionTo ? (
                <Text style={styles.connection}>connects to {ds.connectionTo}</Text>
              ) : null}

              {/* ── Blurb ────────────────────────────────────────────────── */}
              {ds.blurb ? <Text style={styles.blurb}>{ds.blurb}</Text> : null}

              {/* ── Mastery / meta chips ─────────────────────────────────── */}
              {/* Suppressed for the night-museum's mastery/starter roles — visit
                  count and reach don't apply to a "you built this"/"grow into"
                  star, and the blurb above already carries the full message. */}
              {ds.role !== "mastery" && ds.role !== "starter" && (
                <View style={styles.metaRow}>
                  <View style={styles.chip}>
                    <Text style={styles.chipLabel}>VISITS</Text>
                    <Text style={styles.chipValue}>
                      {ds.completed
                        ? completionLabel(ds.completedAt)
                        : visitLabel(ds.visitCount ?? 0)}
                    </Text>
                  </View>
                  <View style={styles.chip}>
                    <Text style={styles.chipLabel}>REACH</Text>
                    <Text style={styles.chipValue}>{reachLabel(ds.reach)}</Text>
                  </View>
                  {ds.lastVisitedAt ? (
                    <View style={styles.chip}>
                      <Text style={styles.chipLabel}>LAST</Text>
                      <Text style={styles.chipValue}>
                        {relativeTime(ds.lastVisitedAt)}
                      </Text>
                    </View>
                  ) : null}
                  {ds.role === "territory" ? (
                    <View style={styles.chip}>
                      <Text style={styles.chipLabel}>FIELD</Text>
                      <Text style={styles.chipValue}>
                        {ds.hopTier === 0 ? "Touched" : ds.hopTier && ds.hopTier <= 2 ? "Nearby" : "Deep"}
                      </Text>
                    </View>
                  ) : null}
                </View>
              )}

              {/* ── CTA ──────────────────────────────────────────────────── */}
              {ds.seedId ? (
                <Pressable
                  onPress={onBeginQuest}
                  disabled={starting || ds.completed}
                  style={({ pressed }) => [
                    styles.cta,
                    pressed && { opacity: 0.82 },
                    (starting || ds.completed) && { opacity: 0.6 },
                  ]}
                >
                  <Text style={styles.ctaText}>
                    {ds.completed
                      ? "Completed ✓"
                      : ds.visited
                        ? "Resume quest 🚀"
                        : "Begin quest 🚀"}
                  </Text>
                </Pressable>
              ) : ds.role === "mastery" || ds.role === "starter" ? (
                // A lit constellation star or a cold-start "someday" star — no
                // CTA, nothing to launch. The blurb above already carries the
                // full message ("Practice keeps it bright." / the specific
                // "next step"/registry hook), so nothing more to add here.
                null
              ) : (
                <Text style={styles.fieldNote}>
                  This idea is part of your wider map. Zoom in and follow the linked stars to see what unlocks it.
                </Text>
              )}
            </>
          )}
        </Pressable>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.38)",
  },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: palette.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 28,
    paddingTop: 14,
    // iPad-friendly max width, centered
    maxWidth: 720,
    alignSelf: "center",
    width: "100%",
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.gray[300],
    marginBottom: 20,
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  accentDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    shadowOpacity: 0.8,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  eyebrow: {
    fontSize: 12,
    fontFamily: "HankenGrotesk_700Bold",
    letterSpacing: 1.1,
  },
  topicTitle: {
    fontSize: 27,
    color: palette.navy[500],
    fontFamily: "HankenGrotesk_700Bold",
    marginBottom: 6,
    lineHeight: 33,
  },
  topicTitleFlex: {
    flexShrink: 1,
    marginBottom: 0,
  },
  titleRow: {
    marginBottom: 6,
  },
  connection: {
    fontSize: 15,
    color: palette.charcoal[400],
    fontFamily: "HankenGrotesk_500Medium",
    fontStyle: "italic",
    marginBottom: 12,
  },
  blurb: {
    fontSize: 17,
    lineHeight: 26,
    color: palette.charcoal[500],
    fontFamily: "HankenGrotesk_400Regular",
    marginBottom: 20,
  },
  metaRow: {
    flexDirection: "row",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 22,
  },
  chip: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 5,
    backgroundColor: palette.gray[50],
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipLabel: {
    fontSize: 10,
    fontFamily: "HankenGrotesk_700Bold",
    color: palette.charcoal[300],
    letterSpacing: 0.8,
  },
  chipValue: {
    fontSize: 13,
    fontFamily: "HankenGrotesk_600SemiBold",
    color: palette.charcoal[500],
  },
  cta: {
    backgroundColor: palette.violet[500],
    borderRadius: 16,
    paddingVertical: 17,
    alignItems: "center",
  },
  ctaText: {
    color: palette.white,
    fontSize: 18,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  fieldNote: {
    color: palette.charcoal[400],
    fontSize: 15,
    lineHeight: 22,
    fontFamily: "HankenGrotesk_500Medium",
    marginBottom: 4,
  },
});
