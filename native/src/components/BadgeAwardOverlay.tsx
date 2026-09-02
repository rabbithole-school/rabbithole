/**
 * BadgeAwardOverlay — full-screen celebratory badge reveal + customization.
 *
 * Appears when useBadgeAward detects a newly-earned badge. The badge art
 * springs in with a scale/glow animation; a ring of radiating particles
 * (pure Reanimated, no extra native modules) provides the "wow" moment. The
 * art is reactive — it swaps in the moment the generative mint lands. Before
 * there is any art, the mint shows as a single big spinner (never the fallback
 * emoji with a spinner on top of it — that read as noise); once art exists, a
 * remix dims it and puts the spinner over it, so the remix visibly does
 * something. Below the reveal, a "Make it yours" strip
 * lets the scholar remix the art with PRESET choices only (a style toggle + a
 * colorway), applied at most MAX_BADGE_REROLLS times — no free-text prompt, so
 * customization stays a delight, never a distraction. Mirrors the web
 * BadgeCelebration + BadgeRemixStrip. On-brand navy/violet palette;
 * anti-parasocial — no AI character involved, just the scholar's achievement.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
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
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useMutation } from "convex/react";

import { colors, fonts, palette } from "@/theme";
import { api } from "@/lib/convex";
import { useBadgeAward, type EarnedBadge } from "@/hooks/useBadgeAward";
import {
  BADGE_STYLES,
  BADGE_COLORWAYS,
  type BadgeStyle,
  type BadgeColorway,
} from "../../vendor/shared/badgeArt";

// The theme has no `amber`/award-gold token, so the celebration accents use
// explicit warm-gold hexes — a real award gold on the dark navy card. Mirrors
// the web BadgeCelebration / BadgeRemixStrip.
const GOLD = "#f4c44c";
const ON_GOLD = "#15203f";

// ─── Particle ────────────────────────────────────────────────────────────────

type ParticleProps = {
  angle: number; // degrees
  delay: number; // ms
  color: string;
  size: number;
};

const PARTICLE_DISTANCE = 130;

function Particle({ angle, delay, color, size }: ParticleProps) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.set(withDelay(
      delay,
      withRepeat(
        withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }),
        -1,
        false,
      ),
    ));
  }, [delay, progress]);

  const rad = (angle * Math.PI) / 180;
  const style = useAnimatedStyle(() => {
    const dist = interpolate(progress.get(), [0, 1], [40, PARTICLE_DISTANCE]);
    const opacity = interpolate(progress.get(), [0, 0.4, 1], [0, 0.9, 0]);
    const scale = interpolate(progress.get(), [0, 0.3, 1], [0.4, 1, 0.5]);
    return {
      transform: [
        { translateX: dist * Math.cos(rad) },
        { translateY: dist * Math.sin(rad) },
        { scale },
      ],
      opacity,
    };
  });

  return (
    <Animated.View
      style={[
        styles.particle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        style,
      ]}
    />
  );
}

// ─── Glow ring ───────────────────────────────────────────────────────────────

function GlowRing() {
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.set(withRepeat(
      withSequence(
        withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    ));
  }, [pulse]);

  const style = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.get(), [0, 1], [0.25, 0.7]),
    transform: [{ scale: interpolate(pulse.get(), [0, 1], [0.9, 1.15]) }],
  }));

  return <Animated.View style={[styles.glowRing, style]} />;
}

// ─── Badge card ──────────────────────────────────────────────────────────────

type BadgeCardProps = {
  imageUrl: string | null;
  icon: string | null;
  title: string;
  generating: boolean;
};

function BadgeCard({ imageUrl, icon, title, generating }: BadgeCardProps) {
  const scale = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    // Short delay so the backdrop fades in first.
    scale.set(withDelay(
      150,
      withSpring(1, { damping: 12, stiffness: 160 }),
    ));
    opacity.set(withDelay(150, withTiming(1, { duration: 200 })));
  }, [opacity, scale]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
    opacity: opacity.get(),
  }));

  const PARTICLE_COLORS = [
    palette.violet[400],
    palette.violet[600],
    palette.navy[500],
    palette.cyan[500],
    palette.yellow[500],
    palette.orange[500],
  ];

  const PARTICLE_COUNT = 12;

  return (
    <Animated.View style={[styles.cardContainer, cardStyle]}>
      {/* Radiating particles */}
      <View style={styles.particleHost} pointerEvents="none">
        {Array.from({ length: PARTICLE_COUNT }).map((_, i) => (
          <Particle
            key={i}
            angle={(360 / PARTICLE_COUNT) * i - 90}
            delay={(i * 80) % 400}
            color={PARTICLE_COLORS[i % PARTICLE_COLORS.length]}
            size={i % 3 === 0 ? 12 : 8}
          />
        ))}
      </View>

      {/* Glow ring behind badge art */}
      <GlowRing />

      {/* Badge art */}
      <View style={styles.artWrapper}>
        {imageUrl ? (
          <>
            <Image
              source={{ uri: imageUrl }}
              style={[styles.artImage, generating && styles.artImageDim]}
              contentFit="contain"
              transition={200}
              alt={`${title} badge`}
            />
            {/* Spinner over the existing art, so a remix visibly "does
                something" even though the previous art is still on screen. */}
            {generating && (
              <View style={styles.artSpinner} pointerEvents="none">
                <ActivityIndicator color={GOLD} size="large" />
              </View>
            )}
          </>
        ) : generating ? (
          // First mint — no art to dim yet, so show one big spinner on its own
          // rather than superimposing it on the fallback emoji.
          <View style={styles.artSpinnerLarge} pointerEvents="none">
            <ActivityIndicator color={GOLD} size="large" />
          </View>
        ) : (
          <Text style={styles.artEmoji}>{icon ?? "🏅"}</Text>
        )}
      </View>

      {/* Label */}
      <Text style={styles.badgeTitle}>{title}</Text>
    </Animated.View>
  );
}

// ─── Remix strip ("Make it yours") ────────────────────────────────────────────

function BadgeRemixStrip({ badge }: { badge: EarnedBadge }) {
  const customize = useMutation(api.badges.customizeBadge);
  const [style, setStyle] = useState<BadgeStyle | null>(null);
  const [colorway, setColorway] = useState<BadgeColorway | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generating = badge.artStatus === "generating";
  const currentStyle = badge.style as BadgeStyle | null | undefined;
  const currentColorway = badge.colorway as BadgeColorway | null | undefined;

  const pickedStyle = style ?? currentStyle ?? "patch";
  const pickedColor = colorway ?? currentColorway ?? "auto";
  const canRemix = badge.rerollsRemaining > 0;
  const changed =
    pickedStyle !== currentStyle || pickedColor !== currentColorway;
  const controlsDisabled = busy || generating || !canRemix;

  const onRemix = useCallback(async () => {
    if (!canRemix || generating || busy || !changed) return;
    setBusy(true);
    setError(null);
    Haptics.selectionAsync().catch(() => {});
    try {
      await customize({
        badgeId: badge._id,
        style: pickedStyle,
        colorway: pickedColor,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remix that");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => {},
      );
    } finally {
      setBusy(false);
    }
  }, [badge._id, busy, canRemix, changed, customize, generating, pickedColor, pickedStyle]);

  const remixLabel = busy || generating
    ? "Designing your badge…"
    : canRemix
      ? `Remix my badge · ${badge.rerollsRemaining} left`
      : "No remixes left";
  const remixDisabled = generating || busy || !canRemix || !changed;

  return (
    <View style={styles.remix}>
      <Text style={styles.remixLabel}>MAKE IT YOURS</Text>

      {/* Style — pills; selected state is a high-contrast gold fill. */}
      <View style={styles.styleRow}>
        {(Object.keys(BADGE_STYLES) as BadgeStyle[]).map((s) => {
          const selected = pickedStyle === s;
          return (
            <Pressable
              key={s}
              disabled={controlsDisabled}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                setStyle(s);
              }}
              style={[
                styles.stylePill,
                selected && styles.stylePillSelected,
                controlsDisabled && !selected && styles.dimmed,
              ]}
            >
              <Text
                style={[
                  styles.stylePillLabel,
                  selected && styles.stylePillLabelSelected,
                ]}
              >
                {BADGE_STYLES[s].label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Colorway — gradient swatches */}
      <View style={styles.swatchRow}>
        {(Object.keys(BADGE_COLORWAYS) as BadgeColorway[]).map((c) => {
          const selected = pickedColor === c;
          const [a, b] = BADGE_COLORWAYS[c].swatch;
          return (
            <Pressable
              key={c}
              disabled={controlsDisabled}
              accessibilityLabel={BADGE_COLORWAYS[c].label}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                setColorway(c);
              }}
              style={[
                styles.swatchWrap,
                selected && styles.swatchWrapSelected,
                controlsDisabled && !selected && styles.dimmed,
              ]}
            >
              <LinearGradient
                colors={[a, b]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.swatch}
              />
            </Pressable>
          );
        })}
      </View>

      {error ? <Text style={styles.remixError}>{error}</Text> : null}

      <Pressable
        onPress={onRemix}
        disabled={remixDisabled}
        style={({ pressed }) => [
          styles.remixButton,
          remixDisabled && styles.remixButtonDisabled,
          pressed && !remixDisabled && styles.remixButtonPressed,
        ]}
      >
        {(busy || generating) && (
          <ActivityIndicator color={ON_GOLD} size="small" style={{ marginRight: 8 }} />
        )}
        <Text style={styles.remixButtonLabel}>{remixLabel}</Text>
      </Pressable>
    </View>
  );
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

/**
 * Mount once at the app root (inside `<ConvexAuthProvider>`). It subscribes to
 * the calling scholar's badges and self-activates when a new one arrives.
 */
export function BadgeAwardOverlay() {
  const { badge, dismiss } = useBadgeAward();
  const hapticFired = useRef(false);

  useEffect(() => {
    if (badge && !hapticFired.current) {
      hapticFired.current = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    if (!badge) {
      hapticFired.current = false;
    }
  }, [badge]);

  const handleDismiss = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dismiss();
  }, [dismiss]);

  if (!badge) return null;

  const generating = badge.artStatus === "generating";

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleDismiss}
    >
      <Animated.View
        entering={FadeIn.duration(250)}
        exiting={FadeOut.duration(200)}
        style={styles.backdrop}
      >
        {/* Tap backdrop to dismiss */}
        <Pressable style={StyleSheet.absoluteFill} onPress={handleDismiss} />

        <ScrollView
          style={styles.panelScroll}
          contentContainerStyle={styles.panel}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.headline}>You earned a badge!</Text>

          <BadgeCard
            imageUrl={badge.imageUrl}
            icon={badge.badge.icon ?? badge.unitEmoji ?? null}
            title={badge.badge.title}
            generating={generating}
          />

          {badge.badge.description ? (
            <Text style={styles.subtitle}>{badge.badge.description}</Text>
          ) : null}
          <Text style={styles.subtitle}>
            {generating
              ? "Designing your badge — this can take a few seconds…"
              : badge.kind === "calculator_license"
                ? "You passed the Calculator License Test. This badge is yours."
                : badge.isQuestUnit
                ? "You finished the whole quest. This badge is yours."
                : "You finished the whole unit. This badge is yours."}
          </Text>
          <Text style={styles.subtitle}>Find it anytime in My Learning.</Text>

          {/* Make-it-yours strip — preset choices only, capped remix budget. */}
          <BadgeRemixStrip badge={badge} />

          <Pressable
            style={({ pressed }) => [
              styles.niceButton,
              pressed && styles.niceButtonPressed,
            ]}
            onPress={handleDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss badge"
          >
            <Text style={styles.niceButtonLabel}>Nice!</Text>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(10, 16, 46, 0.82)", // deep navy with high opacity
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,

  panelScroll: {
    width: "100%",
    maxWidth: 620,
    maxHeight: "100%",
  },

  panel: {
    alignItems: "center",
    gap: 18,
    paddingHorizontal: 40,
    paddingVertical: 40,
  } as ViewStyle,

  headline: {
    fontFamily: fonts.bold,
    fontSize: 28,
    color: colors.white,
    textAlign: "center",
    letterSpacing: -0.3,
  },

  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 24,
    color: "rgba(255,255,255,0.7)",
    textAlign: "center",
    maxWidth: 420,
    marginTop: -4,
  },

  // Particles + glow ring are centered on this container.
  cardContainer: {
    alignItems: "center",
    justifyContent: "center",
    width: 400,
    height: 430,
    gap: 18,
  } as ViewStyle,

  particleHost: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,

  particle: {
    position: "absolute",
  },

  glowRing: {
    position: "absolute",
    width: 360,
    height: 360,
    borderRadius: 180,
    borderWidth: 2,
    borderColor: palette.violet[400],
    backgroundColor: `${palette.violet[500]}22`,
    shadowColor: palette.violet[400],
    shadowOpacity: 0.8,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
  } as ViewStyle,

  artWrapper: {
    width: 280,
    height: 280,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  } as ViewStyle,

  artImage: {
    width: 280,
    height: 280,
    borderRadius: 16,
  },

  artImageDim: {
    opacity: 0.65,
  },

  artSpinner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,

  // ActivityIndicator tops out at ~36pt ("large"), so scale it up to ~30% of
  // the 280pt art slot (matching the web twin's `size * 0.3` spinner) while
  // the first mint is in flight.
  artSpinnerLarge: {
    transform: [{ scale: 2.4 }],
  } as ViewStyle,

  artEmoji: {
    fontSize: 192,
    textAlign: "center",
  },

  badgeTitle: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.white,
    textAlign: "center",
    zIndex: 1,
    maxWidth: 340,
  },

  // ── Remix strip ──
  // `alignSelf: "center"` (not "stretch") — a stretched item with an explicit
  // width ignores the parent's `alignItems: "center"` and pins to the leading
  // edge, which left-shifted the whole strip off the panel's centerline.
  remix: {
    alignSelf: "center",
    alignItems: "center",
    gap: 12,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.18)",
    width: "100%",
    maxWidth: 420,
  } as ViewStyle,

  remixLabel: {
    fontFamily: fonts.bold,
    fontSize: 12,
    letterSpacing: 1.2,
    color: "rgba(255,255,255,0.6)",
  },

  styleRow: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
  } as ViewStyle,

  stylePill: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    backgroundColor: "rgba(255,255,255,0.08)",
  } as ViewStyle,

  stylePillSelected: {
    backgroundColor: GOLD,
    borderColor: GOLD,
  } as ViewStyle,

  stylePillLabel: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: colors.white,
  },

  stylePillLabelSelected: {
    color: ON_GOLD,
  },

  swatchRow: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
  } as ViewStyle,

  swatchWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: 1,
  } as ViewStyle,

  swatchWrapSelected: {
    borderColor: GOLD,
    transform: [{ scale: 1.12 }],
  } as ViewStyle,

  swatch: {
    width: "100%",
    height: "100%",
    borderRadius: 16,
  },

  dimmed: {
    opacity: 0.5,
  },

  remixError: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: palette.orange[300],
    textAlign: "center",
  },

  remixButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    backgroundColor: GOLD,
    paddingVertical: 13,
    borderRadius: 12,
  } as ViewStyle,

  remixButtonDisabled: {
    opacity: 0.55,
  } as ViewStyle,

  remixButtonPressed: {
    opacity: 0.85,
  } as ViewStyle,

  remixButtonLabel: {
    fontFamily: fonts.bold,
    fontSize: 15,
    color: ON_GOLD,
  },

  niceButton: {
    backgroundColor: palette.violet[500],
    paddingHorizontal: 48,
    paddingVertical: 16,
    borderRadius: 50,
    marginTop: 4,
    shadowColor: palette.violet[600],
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  } as ViewStyle,

  niceButtonPressed: {
    backgroundColor: palette.violet[600],
    transform: [{ scale: 0.97 }],
  } as ViewStyle,

  niceButtonLabel: {
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.white,
    letterSpacing: 0.2,
  },
});
