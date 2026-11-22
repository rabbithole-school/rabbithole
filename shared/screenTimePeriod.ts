// Pure period math for School › Screen time's week and month charts (and the
// Friday Slack roundup's PNGs of the same): each scholar's in-school minutes
// per school day, and the average scholar's minutes by activity day by day,
// across whoever the caller is looking at (a scope on the page, the channel's
// class in Slack).
// No Convex, DOM or React imports (see shared/screenTimePeriod.test.ts).

import {
  STRETCH_KINDS,
  emptyKindMinutes,
  type StretchKind,
} from "./screenTimeStretches";

const inSchoolMinutes = (row: PeriodDayRow) =>
  Math.max(0, row.measuredMinutes - row.outsideSchool.measuredMinutes);

export type PeriodSummary = ReturnType<typeof summarizePeriod>;

/** The fields of a `dailyUsage` row the summary reads. */
export type PeriodDayRow = {
  scholarId: string;
  scholarName: string;
  dayKey: string;
  measuredMinutes: number;
  outsideSchool: { measuredMinutes: number };
  schoolDay: boolean;
};

/**
 * Per-scholar in-school averages, and the average scholar's day, over a
 * period. A school day is a day any row says was an open school day; a
 * scholar's average divides by every school day in the period, so a day they
 * never used Rabbithole counts as zero, and a roster scholar with no rows at
 * all is a zero in the average.
 */
export function summarizePeriod(
  rows: readonly PeriodDayRow[],
  /** Every scholar being summarized: one with no rows counts as zero. */
  roster: readonly { scholarId: string; scholarName: string }[],
  allDays: readonly string[],
) {
  const schoolDays = [...new Set(rows.filter((row) => row.schoolDay).map((row) => row.dayKey))].sort();
  const schoolDaySet = new Set(schoolDays);
  const scholars = new Map<
    string,
    { id: string; name: string; inByDay: Map<string, number>; outByDay: Map<string, number> }
  >();
  for (const scholar of roster) {
    const id = String(scholar.scholarId);
    scholars.set(id, { id, name: scholar.scholarName, inByDay: new Map(), outByDay: new Map() });
  }
  for (const row of rows) {
    const id = String(row.scholarId);
    let entry = scholars.get(id);
    if (!entry) {
      entry = { id, name: row.scholarName, inByDay: new Map(), outByDay: new Map() };
      scholars.set(id, entry);
    }
    if (schoolDaySet.has(row.dayKey)) entry.inByDay.set(row.dayKey, inSchoolMinutes(row));
    entry.outByDay.set(row.dayKey, row.outsideSchool.measuredMinutes);
  }
  const people = [...scholars.values()].map((entry) => {
    const inTotal = [...entry.inByDay.values()].reduce((a, b) => a + b, 0);
    const outTotal = [...entry.outByDay.values()].reduce((a, b) => a + b, 0);
    return {
      ...entry,
      inSchoolAvg: schoolDays.length ? inTotal / schoolDays.length : 0,
      outsideAvg: allDays.length ? outTotal / allDays.length : 0,
      schoolDaysOn: [...entry.inByDay.values()].filter((m) => m >= 1).length,
    };
  });
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const average = { average: mean(people.map((p) => p.inSchoolAvg)) };
  return { people, average, schoolDays, allDays };
}

// ── Minutes by kind, day by day ─────────────────────────────────────────

/** Which side of the bell a bar counts: in school, outside school, or both. */
export type BellSide = "inSchool" | "outside" | "both";

/** One scholar-day's minutes by kind, split at the bell (`deviceActivity.dayKindMinutes`). */
export type DayKindRow = {
  scholarId: string;
  dayKey: string;
  inSchool: Record<StretchKind, number>;
  outside: Record<StretchKind, number>;
};

/**
 * Minutes by kind for each day, for the average of `scholarIds` (a scholar
 * with no row that day counts as zero, as in `summarizePeriod`). Pass one id
 * for one scholar's own days.
 */
export function averageKindsByDay(
  rows: readonly DayKindRow[],
  scholarIds: readonly string[],
  days: readonly string[],
  side: BellSide,
): Record<StretchKind, number>[] {
  const members = new Set(scholarIds.map(String));
  const sums = new Map(days.map((day) => [day, emptyKindMinutes()]));
  for (const row of rows) {
    if (!members.has(String(row.scholarId))) continue;
    const sum = sums.get(row.dayKey);
    if (!sum) continue;
    for (const kind of STRETCH_KINDS) {
      if (side !== "outside") sum[kind] += row.inSchool[kind] ?? 0;
      if (side !== "inSchool") sum[kind] += row.outside[kind] ?? 0;
    }
  }
  const count = Math.max(1, members.size);
  return days.map((day) => {
    const sum = sums.get(day) ?? emptyKindMinutes();
    return Object.fromEntries(
      STRETCH_KINDS.map((kind) => [kind, sum[kind] / count]),
    ) as Record<StretchKind, number>;
  });
}
