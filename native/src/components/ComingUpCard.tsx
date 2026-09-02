/**
 * ComingUpCard (native) — the scholar lookahead, rendered below the "To do
 * tonight" card on the Scholar's Prep tab and the evening Home. Move 3 of the
 * homework-flow plan (review/homework-flow-plan.html §Move 3). The native twin
 * of components/ComingUpCard.tsx — same copy, same order, same grammar.
 *
 * It is a FORECAST, not a todo (T4): dated rows for homework due after tonight
 * and schedule-committed planned previews, grouped by day over the next 5 open
 * school days. NO checkbox, NO launch CTA, NO "N left" count. An empty horizon
 * renders a quiet line, never null.
 */
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { SymbolView } from "expo-symbols";

import { api } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import {
  formatComingUpDayHeading,
  formatStartTime,
  type ComingUpDayGroup,
  type ComingUpEntry,
} from "../../vendor/shared/comingUp";
import { DueChip, StatusChip } from "./ui/DueChip";
import { ForecastRow } from "./ui/ForecastRow";

const MINUTE_MS = 60_000;
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

function ComingUpRow({
  entry,
  timeZone,
  nowMs,
  styles,
}: {
  entry: ComingUpEntry;
  timeZone: string;
  nowMs: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.row}>
      <ForecastRow
        glyph={entry.unitEmoji}
        title={entry.activityTitle}
        meta={[
          entry.unitTitle,
          entry.teacherName ? `with ${entry.teacherName}` : null,
        ]
          .filter(Boolean)
          .join(" \u00b7 ")}
        status={
          entry.kind === "homework" ? (
            <DueChip dueAt={entry.dueAt} nowMs={nowMs} timeZone={timeZone} />
          ) : (
            <StatusChip>starts {formatStartTime(entry.startsAt, timeZone)}</StatusChip>
          )
        }
      />
    </View>
  );
}

function ComingUpDay({
  group,
  timeZone,
  nowMs,
  styles,
}: {
  group: ComingUpDayGroup;
  timeZone: string;
  nowMs: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View>
      <Text style={styles.dayHeading}>{formatComingUpDayHeading(group.dayKey)}</Text>
      {group.entries.map((entry) => (
        <ComingUpRow
          key={`${entry.kind}:${entry.assignmentId}:${entry.activityId}`}
          entry={entry}
          timeZone={timeZone}
          nowMs={nowMs}
          styles={styles}
        />
      ))}
    </View>
  );
}

export function ComingUpCard() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // A minute-rounded clock re-arms the reactive query across institution-local
  // midnight (and as the horizon rolls) without inventing a day key.
  const [now, setNow] = useState(() => floorToMinute(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setNow(floorToMinute(Date.now())), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  const result = useQuery(api.assignments.comingUpForSelf, {
    now,
    includeWebActivities: true,
  });

  if (result === undefined) return null;
  const { groups, timeZone } = result;
  const isEmpty = groups.length === 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <SymbolView
          name="chart.line.uptrend.xyaxis"
          size={18}
          tintColor={colors.violet}
        />
        <Text style={styles.headerTitle}>Coming up</Text>
        <View style={styles.headerSpacer} />
        <Text style={styles.headerSub}>the next 5 open school days</Text>
      </View>

      {isEmpty ? (
        <Text style={styles.emptyLine}>Nothing coming up yet.</Text>
      ) : (
        <>
          {groups.map((group) => (
            <ComingUpDay
              key={group.dayKey}
              group={group}
              timeZone={timeZone}
              nowMs={now}
              styles={styles}
            />
          ))}
          <Text style={styles.foot}>
            Just a heads-up — these aren’t due tonight. Nothing to open here.
          </Text>
        </>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.gray100,
    },
    headerTitle: {
      fontFamily: fonts.bold,
      fontSize: 16,
      color: c.charcoal,
    },
    headerSpacer: { flex: 1 },
    headerSub: {
      fontFamily: fonts.medium,
      fontSize: 13,
      color: c.charcoalMuted,
    },
    dayHeading: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      color: c.fgMuted,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    row: { paddingHorizontal: 16, paddingVertical: 10 },
    emptyLine: {
      fontFamily: fonts.regular,
      fontSize: 15,
      color: c.fgMuted,
      paddingHorizontal: 16,
      paddingVertical: 16,
      lineHeight: 22,
    },
    foot: {
      fontFamily: fonts.medium,
      fontSize: 12,
      color: c.charcoalMuted,
      paddingHorizontal: 16,
      paddingVertical: 12,
      lineHeight: 18,
      borderTopWidth: 1,
      borderTopColor: c.gray100,
    },
  });
}
