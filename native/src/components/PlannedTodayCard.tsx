/**
 * PlannedTodayCard — ghost (dashed border, no CTA) card for a planned today
 * entry (setAt=null, startsAt today). Native RN version.
 *
 * Invariant 1: planned entries are NEVER startable. No launch CTA rendered.
 *
 * The card owns the ghost treatment; the row inside it is the shared
 * `ForecastRow`, identical to every row in Coming up
 * (review/scholar-activity-row-rationalization.html §P3).
 */
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { type Colors, useColors } from "@/theme";
import { formatStartTime } from "../../vendor/shared/comingUp";
import { ForecastRow } from "./ui/ForecastRow";
import { StatusChip } from "./ui/DueChip";

export type NativePlannedEntry = {
  activityTitle: string;
  unitTitle: string | null;
  unitEmoji: string | null;
  subject: string | null;
  startsAt: number;
};

export function PlannedTodayCard({
  entry,
  timeZone,
}: {
  entry: NativePlannedEntry;
  timeZone: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const timeLabel = formatStartTime(entry.startsAt, timeZone);

  return (
    <View style={styles.card}>
      <ForecastRow
        glyph={entry.unitEmoji}
        title={entry.activityTitle}
        meta={entry.unitTitle ?? entry.subject}
        status={timeLabel ? <StatusChip>starts {timeLabel}</StatusChip> : null}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: c.border,
      borderRadius: 16,
      padding: 16,
      backgroundColor: c.bgSubtle,
    },
  });
}
