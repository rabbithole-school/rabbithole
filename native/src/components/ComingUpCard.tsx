/**
 * ComingUpCard (native) — the scholar lookahead of planned CLASS work that
 * hasn't started yet, rendered below Homework on the evening Home and on the
 * Scholar's Prep tab. The native twin of components/ComingUpCard.tsx — same
 * copy, same order, same grammar. Homework is never here: it is in the Homework section.
 *
 * Drawn as a sibling of Homework (HomeworkSectionNative in app/index.tsx): the
 * same HomeSection eyebrow, the same card, and day headings from the same
 * helper ("Starts tomorrow").
 *
 * It is a FORECAST, not a todo (T4): schedule-committed planned previews,
 * grouped by day over the next 5 open school days. NO checkbox, NO launch CTA,
 * NO "N left" count.
 */
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { api } from "@/lib/convex";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { fonts, useColors } from "@/theme";
import {
  formatStartTime,
  type ComingUpDayGroup,
  type ComingUpEntry,
} from "../../vendor/shared/comingUp";
import { formatRelativeDayHeading } from "../../vendor/shared/institutionDay";
import { HomeSection } from "./HomeSection";
import { StatusChip } from "./ui/DueChip";
import { ForecastRow } from "./ui/ForecastRow";

const MINUTE_MS = 60_000;
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

function ComingUpRow({
  entry,
  timeZone,
  styles,
}: {
  entry: ComingUpEntry;
  timeZone: string;
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
          <StatusChip>{formatStartTime(entry.startsAt, timeZone)}</StatusChip>
        }
      />
    </View>
  );
}

function ComingUpDay({
  group,
  timeZone,
  todayKey,
  divided,
  styles,
}: {
  group: ComingUpDayGroup;
  timeZone: string;
  todayKey: string;
  divided: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  // Same subheading style as the Homework section (hwListGroupHeading in app/index.tsx).
  return (
    <View style={divided ? styles.dayDivided : undefined}>
      <Text style={styles.dayHeading}>
        {formatRelativeDayHeading(group.dayKey, todayKey, "starts")}
      </Text>
      {group.entries.map((entry) => (
        <ComingUpRow
          key={`${entry.kind}:${entry.assignmentId}:${entry.activityId}`}
          entry={entry}
          timeZone={timeZone}
          styles={styles}
        />
      ))}
    </View>
  );
}

export function ComingUpCard({
  hideWhenEmpty = false,
}: {
  /** One nothing per screen: vanish when empty instead of a quiet line. */
  hideWhenEmpty?: boolean;
} = {}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // A minute-rounded clock re-arms the reactive query across institution-local
  // midnight (and as the horizon rolls) without inventing a day key.
  const [now, setNow] = useState(() => floorToMinute(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setNow(floorToMinute(Date.now())), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  // Smoothed so each minute's re-subscription keeps the card on screen instead
  // of dropping to `undefined` and vanishing for a round-trip.
  const result = useSmoothedQuery(api.assignments.comingUpForSelf, {
    now,
    includeWebActivities: true,
  });

  if (result === undefined) return null;
  const { groups, timeZone, dayKey } = result;
  const isEmpty = groups.length === 0;
  if (isEmpty && hideWhenEmpty) return null;

  return (
    // The one explanation sits under the heading. An empty card says "Nothing
    // coming up yet" instead, so the two never stack.
    <HomeSection
      label="Coming up"
      detail={isEmpty ? null : "Opens when class starts"}
    >
      <View style={styles.card}>
        {isEmpty ? (
          <Text style={styles.emptyLine}>Nothing coming up yet.</Text>
        ) : (
          groups.map((group, groupIndex) => (
            <ComingUpDay
              key={group.dayKey}
              group={group}
              timeZone={timeZone}
              todayKey={dayKey}
              divided={groupIndex > 0}
              styles={styles}
            />
          ))
        )}
      </View>
    </HomeSection>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    // Matches hwListCard / hwListGroupHeading / hwListRow in app/index.tsx.
    card: {
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.gray200,
      borderRadius: 14,
      overflow: "hidden",
    },
    dayDivided: { borderTopWidth: 1, borderTopColor: c.gray100 },
    dayHeading: {
      fontFamily: fonts.bold,
      fontSize: 13,
      color: c.charcoalMuted,
      paddingHorizontal: 18,
      paddingTop: 12,
      paddingBottom: 2,
    },
    row: { paddingHorizontal: 18, paddingVertical: 12 },
    emptyLine: {
      fontFamily: fonts.regular,
      fontSize: 15,
      color: c.fgMuted,
      paddingHorizontal: 16,
      paddingVertical: 16,
      lineHeight: 22,
    },
  });
}
