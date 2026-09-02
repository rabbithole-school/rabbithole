import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

export function PracticeProgressHeader({
  title,
  subtitle,
  subtitleTone = "muted",
  progressLabel,
  progressAccessibilityLabel = progressLabel,
  progressPercent,
  segmentBoundaries,
  topInset,
  onBack,
}: {
  title: string;
  subtitle?: string;
  subtitleTone?: "muted" | "challenge" | "stretch" | "mapping";
  progressLabel: string;
  progressAccessibilityLabel?: string;
  progressPercent: number;
  /** Playlist segments v1 (raise-the-ceiling §11 / C-4): fractional (0–1)
   *  offsets into the track where a new segment begins, rendered as thin
   *  divider ticks — real data (where one beat ends and the next begins),
   *  never decorative. Omit for a plain continuous bar (the default, and the
   *  only behavior any OTHER caller — e.g. Placement — sees). */
  segmentBoundaries?: number[];
  topInset: number;
  onBack: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const percent = Math.max(0, Math.min(100, progressPercent));

  return (
    <View style={[styles.header, { paddingTop: topInset }]}>
      <View style={styles.row}>
        <View style={styles.side}>
          <Pressable
            onPress={onBack}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.back}
          >
            <Text style={styles.backChevron}>‹</Text>
          </Pressable>
        </View>

        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={
                subtitleTone === "challenge"
                  ? styles.subtitleChallenge
                  : subtitleTone === "stretch"
                    ? styles.subtitleStretch
                    : subtitleTone === "mapping"
                      ? styles.subtitleMapping
                      : styles.subtitleMuted
              }
            >
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={[styles.side, styles.progress]}>
          <View
            style={styles.progressTrack}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={progressAccessibilityLabel}
            accessibilityValue={{
              min: 0,
              max: 100,
              now: percent,
              text: progressAccessibilityLabel,
            }}
          >
            <View
              style={[
                styles.progressFill,
                { width: `${percent}%` as `${number}%` },
              ]}
            />
            {segmentBoundaries?.map((offset) => (
              <View
                key={offset}
                style={[
                  styles.progressSegmentDivider,
                  { left: `${offset * 100}%` as `${number}%` },
                ]}
              />
            ))}
          </View>
          <Text style={styles.progressLabel} numberOfLines={1}>
            {progressLabel}
          </Text>
        </View>
      </View>
    </View>
  );
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(c: ColorSet) {
  return StyleSheet.create({
    header: {
      backgroundColor: c.white,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 48,
      paddingHorizontal: 8,
    },
    side: { width: 256 },
    back: { paddingHorizontal: 6, paddingVertical: 4, alignSelf: "flex-start" },
    backChevron: {
      fontFamily: fonts.regular,
      fontSize: 30,
      lineHeight: 34,
      color: c.violet,
    },
    progress: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 8,
      paddingRight: 8,
    },
    titleWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
    title: {
      fontFamily: fonts.semibold,
      fontSize: 16,
      color: c.navy,
      lineHeight: 19,
      textAlign: "center",
    },
    subtitleMuted: {
      fontFamily: fonts.semibold,
      fontSize: 11,
      color: c.fgMuted,
      lineHeight: 14,
      marginTop: 1,
      letterSpacing: 0.6,
    },
    subtitleChallenge: {
      fontFamily: fonts.bold,
      fontSize: 11,
      color: c.orange,
      lineHeight: 14,
      marginTop: 1,
      letterSpacing: 0.6,
    },
    subtitleStretch: {
      fontFamily: fonts.bold,
      fontSize: 11,
      color: c.indigo,
      lineHeight: 14,
      marginTop: 1,
      letterSpacing: 0.6,
    },
    subtitleMapping: {
      fontFamily: fonts.bold,
      fontSize: 11,
      color: c.fgMuted,
      lineHeight: 14,
      marginTop: 1,
      letterSpacing: 0.6,
    },
    progressLabel: { fontFamily: fonts.semibold, fontSize: 13, color: c.fgMuted },
    progressTrack: {
      width: 96,
      height: 6,
      borderRadius: 999,
      backgroundColor: c.gray200,
      overflow: "hidden",
    },
    progressFill: {
      height: "100%",
      borderRadius: 999,
      backgroundColor: c.green,
    },
    // Playlist segments v1 (raise-the-ceiling §11 / C-4): a thin divider tick
    // at a segment boundary — real data (where one beat ends and the next
    // begins), never decorative.
    progressSegmentDivider: {
      position: "absolute",
      top: 0,
      bottom: 0,
      width: 2,
      backgroundColor: c.white,
    },
  });
}
