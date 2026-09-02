/**
 * InvitationCard (native) — the RN twin of components/ui/InvitationCard.tsx.
 * The ONE card for the scholar-home "invitation" family: a teacher-suggested
 * quest, an unlocked story thread, or the Sky-ready milestone. Extracted from
 * the SuggestedQuests card grammar (a quiet identity band, a two-line body, a
 * right-side CTA) so every invitation reads as the same object.
 *
 * Anatomy (all slots optional): a full-width `band` strip, then either the
 * banded-invitation layout ([body][meta] on the left, [primary]/[secondary]
 * actions on the right) or — for the night Sky card — a centered hero
 * (`emoji` + `title` + `body` + `accessHint`). `onPress` makes the WHOLE card
 * the primary tap target; a `secondaryAction` nested inside stays its own tap
 * target (RN's responder system grants the touch to the inner Pressable).
 * `surface="night"` swaps the paper card for the dark milestone surface.
 */

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";

import { fonts, palette, useColors } from "@/theme";

export type InvitationSurface = "paper" | "night";

export function InvitationCard({
  surface = "paper",
  align = "start",
  band,
  emoji,
  title,
  body,
  meta,
  primaryAction,
  secondaryAction,
  accessHint,
  nestedContent,
  onPress,
  loading = false,
  accessibilityLabel,
}: {
  surface?: InvitationSurface;
  align?: "start" | "center";
  /** Full-width top identity strip (e.g. <UnitBand/> or <InvitationBand/>). */
  band?: React.ReactNode;
  /** A centered hero glyph shown above the title (the night Sky card). */
  emoji?: string | null;
  /** A bold hero line inside the content area (the night Sky card). */
  title?: string | null;
  /** Two-line body / clue. */
  body?: string | null;
  /** Quiet meta line (e.g. "Unlocked by fractions"). */
  meta?: React.ReactNode;
  /** Non-interactive CTA affordance (part of the whole-card press). */
  primaryAction?: React.ReactNode;
  /** A raised quiet secondary control (its own tap target). */
  secondaryAction?: React.ReactNode;
  /** A non-button access affordance (the gesture hint on a gesture map). */
  accessHint?: React.ReactNode;
  /** Content nested UNDER the hero, inside the same surface (e.g. the night
   *  reveal's launch CTA + its day's-movement rows). Kept a slot so the night
   *  surface has exactly one definition rather than being hand-rolled to nest. */
  nestedContent?: React.ReactNode;
  /** Whole-card press = the primary action. */
  onPress?: () => void;
  /** Disables the whole-card press and dims the card. */
  loading?: boolean;
  accessibilityLabel?: string;
}) {
  const colors = useColors();
  const night = surface === "night";
  const centered = align === "center";
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const hasActions = primaryAction != null || secondaryAction != null;

  const content = (pressed: boolean) => (
    <View
      style={[
        styles.content,
        centered && styles.contentCentered,
        pressed && !loading && !night && styles.contentPressed,
        loading && styles.contentLoading,
      ]}
    >
      {emoji ? <Text style={styles.heroEmoji}>{emoji}</Text> : null}
      {title ? (
        <Text style={[styles.title, night && styles.titleNight]}>{title}</Text>
      ) : null}
      {body || meta || hasActions ? (
        centered ? (
          <>
            {body ? (
              <Text style={[styles.body, night && styles.bodyNight, styles.bodyCentered]}>
                {body}
              </Text>
            ) : null}
            {meta}
          </>
        ) : (
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              {body ? (
                <Text style={[styles.body, night && styles.bodyNight]} numberOfLines={2}>
                  {body}
                </Text>
              ) : null}
              {meta ? <View style={styles.metaWrap}>{meta}</View> : null}
            </View>
            {hasActions ? (
              <View style={styles.actions}>
                {primaryAction}
                {secondaryAction}
              </View>
            ) : null}
          </View>
        )
      ) : null}
      {accessHint ? <View style={styles.accessHint}>{accessHint}</View> : null}
      {nestedContent ? nestedContent : null}
    </View>
  );

  const inner = (pressed: boolean) => (
    <View style={night ? styles.nightSurface : styles.cardSurface}>
      {band}
      {content(pressed)}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={night ? styles.nightCard : styles.card}
      >
        {({ pressed }) => inner(pressed)}
      </Pressable>
    );
  }
  return <View style={night ? styles.nightCard : styles.card}>{inner(false)}</View>;
}

/**
 * A quiet identity band for invitations that don't carry a full UnitBand (a
 * story's art/emoji + hook). Mirrors the web InvitationBand.
 */
export function InvitationBand({
  emoji,
  imageUrl,
  title,
  surface = "paper",
  titleLines = 1,
}: {
  emoji?: string | null;
  imageUrl?: string | null;
  title: string;
  surface?: InvitationSurface;
  titleLines?: 1 | 2;
}) {
  const colors = useColors();
  const night = surface === "night";
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.band, night && styles.bandNight]}>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          alt=""
          style={styles.bandImage}
          contentFit="contain"
          accessible={false}
        />
      ) : (
        <Text style={styles.bandEmoji}>{emoji ?? "•"}</Text>
      )}
      <Text
        style={[styles.bandTitle, night && styles.bandTitleNight]}
        numberOfLines={titleLines}
      >
        {title}
      </Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    // ── paper ───────────────────────────────────────────────────────────────
    card: {
      borderRadius: 18,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 3 },
    },
    cardSurface: {
      backgroundColor: c.bg,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
    },
    // ── night ───────────────────────────────────────────────────────────────
    nightCard: {
      borderRadius: 22,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.18,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
    },
    nightSurface: {
      backgroundColor: palette.navy[900],
      borderRadius: 22,
      borderWidth: 1,
      borderColor: palette.violet[400],
      overflow: "hidden",
    },
    // ── content ─────────────────────────────────────────────────────────────
    content: {
      paddingVertical: 16,
      paddingHorizontal: 18,
      gap: 10,
    },
    contentCentered: {
      alignItems: "center",
      paddingVertical: 22,
      paddingHorizontal: 22,
    },
    contentPressed: { backgroundColor: c.gray50 },
    contentLoading: { opacity: 0.6 },
    heroEmoji: { fontSize: 40, lineHeight: 44 },
    title: {
      fontFamily: fonts.bold,
      fontSize: 18,
      lineHeight: 24,
      color: c.navy,
    },
    titleNight: { color: c.white, textAlign: "center" },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    rowLeft: { flex: 1, minWidth: 0, gap: 5 },
    body: {
      fontSize: 14.5,
      lineHeight: 20,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
    },
    bodyNight: { color: palette.navy[100] },
    bodyCentered: { textAlign: "center" },
    metaWrap: { marginTop: 1 },
    actions: { alignItems: "flex-end", gap: 6, flexShrink: 0 },
    accessHint: { alignSelf: "stretch", alignItems: "center" },
    // ── band ────────────────────────────────────────────────────────────────
    band: {
      minHeight: 48,
      paddingVertical: 11,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
    },
    bandNight: { borderBottomColor: palette.navy[700] },
    bandEmoji: { width: 22, textAlign: "center", fontSize: 16, lineHeight: 20 },
    bandImage: { width: 32, height: 32, marginTop: -3 },
    bandTitle: {
      flex: 1,
      minWidth: 0,
      fontSize: 14,
      lineHeight: 19,
      fontFamily: fonts.bold,
      color: c.charcoal,
      letterSpacing: 0.1,
    },
    bandTitleNight: { color: c.white },
  });
}
