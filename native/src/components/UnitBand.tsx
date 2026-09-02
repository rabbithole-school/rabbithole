/**
 * UnitBand — the quiet tinted band along the TOP of a unit/quest card: an emoji
 * + unit title + optional "with {teacher}", and a right slot that is EITHER a
 * progress meter (completed/total + track) OR a path-meta string (a not-yet-
 * started quest) OR nothing. Mirrors the web UnitGroupBand. Extracted from the
 * scholar-home plate (index.tsx) so PlateCard, ChoiceMenuCard, and
 * SuggestedQuests share ONE DRY band. Pass `onPress` to make it open
 * unit-progress (a unit in progress); omit it for inert identity chrome (a
 * suggested quest — no progress yet).
 */

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

export function UnitBand({
  emoji,
  title,
  teacherName,
  subtle,
  muted,
  tint,
  progress,
  meta,
  onPress,
  raisedAction,
  accessibilityLabel,
}: {
  emoji?: string | null;
  title?: string | null;
  teacherName?: string | null;
  /** Section family tint values (e.g. cyan for the Quests lane). */
  subtle: string;
  muted: string;
  tint?: string;
  /** Right slot A — a progress meter. */
  progress?: { completedCount: number | null; activityCount: number | null };
  /** Right slot B — a path meta (e.g. "Guided path · 6 activities"). */
  meta?: string | null;
  /** When set, the band is a button that opens the unit's "where am I". */
  onPress?: () => void;
  /** Optional raised action shown beside the band identity/meta. */
  raisedAction?: React.ReactNode;
  accessibilityLabel?: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const hasProgress = !!progress;
  const progressText =
    progress && progress.completedCount != null && progress.activityCount != null
      ? `${progress.completedCount} of ${progress.activityCount}`
      : hasProgress
        ? "Progress"
        : null;
  const progressPct =
    progress &&
    progress.completedCount != null &&
    progress.activityCount != null &&
    progress.activityCount > 0
      ? Math.min(
          100,
          Math.max(0, (progress.completedCount / progress.activityCount) * 100),
        )
      : 0;

  const content = (
    <>
      <View style={styles.unitBandLeft}>
        <Text style={styles.unitBandEmoji}>{emoji ?? "•"}</Text>
        <View style={styles.unitBandText}>
          <Text style={styles.unitBandTitle} numberOfLines={1}>
            {title ?? "Unit progress"}
          </Text>
          {teacherName ? (
            <Text style={styles.unitBandTeacher} numberOfLines={1}>
              with {teacherName}
            </Text>
          ) : null}
        </View>
      </View>
      {hasProgress ? (
        <View style={styles.unitBandProgress}>
          <Text style={styles.unitBandProgressText}>{progressText}</Text>
          <View style={styles.unitProgressTrack}>
            <View
              style={[
                styles.unitProgressFill,
                {
                  width: `${progressPct}%` as `${number}%`,
                  backgroundColor: tint,
                },
              ]}
            />
          </View>
        </View>
      ) : meta ? (
        <Text style={styles.unitBandMeta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </>
  );

  const main = onPress ? (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.unitBandMain,
        raisedAction ? styles.unitBandMainWithAction : undefined,
        pressed && { backgroundColor: muted },
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {content}
    </Pressable>
  ) : (
    <View
      style={[
        styles.unitBandMain,
        raisedAction ? styles.unitBandMainWithAction : undefined,
      ]}
    >
      {content}
    </View>
  );

  return (
    <View style={[styles.unitBand, { backgroundColor: subtle }]}>
      {main}
      {raisedAction ? (
        <View style={styles.unitBandAction}>{raisedAction}</View>
      ) : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    unitBand: {
      minHeight: 56,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      flexDirection: "row",
      alignItems: "center",
    },
    unitBandMain: {
      minHeight: 56,
      paddingVertical: 11,
      paddingHorizontal: 16,
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 14,
    },
    unitBandMainWithAction: { paddingRight: 8 },
    unitBandLeft: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    unitBandEmoji: {
      width: 24,
      textAlign: "center",
      fontSize: 17,
      lineHeight: 20,
    },
    unitBandText: { flex: 1, minWidth: 0 },
    unitBandTitle: {
      fontSize: 13.5,
      fontFamily: fonts.bold,
      color: c.charcoal,
      letterSpacing: 0.1,
    },
    unitBandTeacher: {
      marginTop: 1,
      fontSize: 12.5,
      fontFamily: fonts.medium,
      color: c.fgMuted,
    },
    unitBandProgress: {
      width: 86,
      flexShrink: 0,
      gap: 5,
      alignItems: "flex-end",
    },
    unitBandProgressText: {
      fontSize: 12.5,
      fontFamily: fonts.semibold,
      color: c.charcoalMuted,
    },
    unitProgressTrack: {
      width: "100%",
      height: 5,
      borderRadius: 999,
      overflow: "hidden",
      backgroundColor: c.gray200,
    },
    unitProgressFill: {
      height: "100%",
      borderRadius: 999,
    },
    unitBandMeta: {
      flexShrink: 0,
      fontSize: 12.5,
      fontFamily: fonts.semibold,
      color: c.charcoalMuted,
      textAlign: "right",
    },
    unitBandAction: { flexShrink: 0, paddingRight: 10 },
  });
}
