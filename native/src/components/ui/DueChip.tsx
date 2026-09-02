/**
 * DueChip (native) — the API-matched twin of `components/ui/DueChip.tsx`.
 *
 * Native is not the drift source here and must not become one: every rule the
 * web chip encodes holds identically on iPad. One signal, one canonical
 * rendering, on both frontends (T1).
 *
 * The shape never varies: a pill in the row's status slot carrying the FULL
 * phrase from `dueStatus()`. Urgency changes TONE only.
 *   loud  — overdue or due today.
 *   quiet — due later.
 * `floor` lets a surface raise the minimum emphasis, never change the form.
 */

import { type ReactNode, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { dueStatus } from "../../../vendor/shared/institutionDay";
import { type Colors, fonts, useColors } from "@/theme";

export type DueTone = "quiet" | "loud";

export function StatusChip({
  children,
  tone = "quiet",
}: {
  children: ReactNode;
  tone?: DueTone;
}) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={[styles.chip, tone === "loud" ? styles.chipLoud : styles.chipQuiet]}>
      <Text style={[styles.text, tone === "loud" ? styles.textLoud : styles.textQuiet]}>
        {children}
      </Text>
    </View>
  );
}

export function DueChip({
  dueAt,
  nowMs,
  timeZone,
  floor,
}: {
  dueAt: number | null | undefined;
  nowMs: number;
  timeZone: string | null;
  floor?: DueTone;
}) {
  if (!timeZone) return null;
  const due = dueStatus(dueAt, nowMs, timeZone);
  // No deadline is no chip, never an empty one.
  if (!due) return null;
  const urgent = due.status === "overdue" || due.status === "dueToday";
  const tone: DueTone = urgent || floor === "loud" ? "loud" : "quiet";
  return <StatusChip tone={tone}>{due.phrase}</StatusChip>;
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    chip: {
      flexShrink: 0,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    chipQuiet: { backgroundColor: c.gray100 },
    chipLoud: { backgroundColor: c.orangeSubtle },
    text: { fontFamily: fonts.semibold, fontSize: 12 },
    textQuiet: { color: c.charcoalMuted },
    textLoud: { color: c.orange },
  });
}
