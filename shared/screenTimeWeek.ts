/**
 * Seven days of screen time per scholar, summed from the scholar-day rows
 * `deviceActivity.dailyUsage` returns. One sum for every surface that reports a
 * week (School › Screen time and the teacher's scholar header), so they always
 * agree. Pure: no Convex or DOM imports.
 * Tests: shared/screenTimeWeek.test.ts.
 */

/**
 * The first day screen time is reported. Before 2026-09-19 the iPad counted a
 * frontmost-but-unattended Rabbithole as in use, so the nightly fleet release
 * booked minutes nobody spent. The fix first shipped in canary build 61 at
 * 05:04 on 2026-09-20, so the 21st is the first full day the fleet could have
 * run it all day; every scholar iPad was on a build containing it (93 to 106)
 * when the fleet was checked on 2026-11-08. Earlier rows are kept, not shown.
 */
export const SCREEN_TIME_FIRST_DAY_KEY = "2026-09-21";

/** `appPlaySessions` (the scholar's own app on screen) holds rows from here. */
export const BUILDER_FIRST_DAY_KEY = "2026-11-02";

/** The fields of one `dailyUsage` row a week needs. */
export type ScreenTimeDay = {
  scholarId: string;
  scholarName: string;
  dayKey: string;
  measuredMinutes: number;
  estimatedMinutes: number;
  apps: {
    externalAppId: string;
    appName: string;
    measuredMinutes: number;
    estimatedMinutes: number;
  }[];
  outsideSchool: { measuredMinutes: number; estimatedMinutes: number };
  builder: { onScreenMinutes: number; activeMinutes: number };
  webActivityMinutes: number;
  otherRabbitholeMinutes: number;
};

export type ScreenTimeTotals = {
  measuredMinutes: number;
  estimatedMinutes: number;
  outsideSchool: { measuredMinutes: number; estimatedMinutes: number };
  builder: { onScreenMinutes: number; activeMinutes: number };
  webActivityMinutes: number;
  appsMeasuredMinutes: number;
  appsEstimatedMinutes: number;
  otherRabbitholeMinutes: number;
};

export type ScholarWeek = {
  scholarId: string;
  scholarName: string;
  totals: ScreenTimeTotals;
  /** Oldest first, only days with a row. */
  days: { dayKey: string; apps: ScreenTimeDay["apps"]; totals: ScreenTimeTotals }[];
};

function emptyTotals(): ScreenTimeTotals {
  return {
    measuredMinutes: 0,
    estimatedMinutes: 0,
    outsideSchool: { measuredMinutes: 0, estimatedMinutes: 0 },
    builder: { onScreenMinutes: 0, activeMinutes: 0 },
    webActivityMinutes: 0,
    appsMeasuredMinutes: 0,
    appsEstimatedMinutes: 0,
    otherRabbitholeMinutes: 0,
  };
}

function dayTotals(day: ScreenTimeDay): ScreenTimeTotals {
  return {
    measuredMinutes: day.measuredMinutes,
    estimatedMinutes: day.estimatedMinutes,
    outsideSchool: { ...day.outsideSchool },
    builder: { ...day.builder },
    webActivityMinutes: day.webActivityMinutes,
    appsMeasuredMinutes: day.apps.reduce((sum, app) => sum + app.measuredMinutes, 0),
    appsEstimatedMinutes: day.apps.reduce((sum, app) => sum + app.estimatedMinutes, 0),
    otherRabbitholeMinutes: day.otherRabbitholeMinutes,
  };
}

function addInto(into: ScreenTimeTotals, add: ScreenTimeTotals): void {
  into.measuredMinutes += add.measuredMinutes;
  into.estimatedMinutes += add.estimatedMinutes;
  into.outsideSchool.measuredMinutes += add.outsideSchool.measuredMinutes;
  into.outsideSchool.estimatedMinutes += add.outsideSchool.estimatedMinutes;
  into.builder.onScreenMinutes += add.builder.onScreenMinutes;
  into.builder.activeMinutes += add.builder.activeMinutes;
  into.webActivityMinutes += add.webActivityMinutes;
  into.appsMeasuredMinutes += add.appsMeasuredMinutes;
  into.appsEstimatedMinutes += add.appsEstimatedMinutes;
  into.otherRabbitholeMinutes += add.otherRabbitholeMinutes;
}

/**
 * One entry per scholar, sorted by name. Never sorted by minutes: a column of
 * minutes ranked high to low reads as a leaderboard
 * (.claude/rules/rabbithole-product-taste.md T9).
 */
export function sumScholarWeeks(rows: readonly ScreenTimeDay[]): ScholarWeek[] {
  const byScholar = new Map<string, ScholarWeek>();
  for (const row of rows) {
    let week = byScholar.get(row.scholarId);
    if (!week) {
      week = {
        scholarId: row.scholarId,
        scholarName: row.scholarName,
        totals: emptyTotals(),
        days: [],
      };
      byScholar.set(row.scholarId, week);
    }
    const totals = dayTotals(row);
    addInto(week.totals, totals);
    week.days.push({ dayKey: row.dayKey, apps: row.apps, totals });
  }
  const weeks = [...byScholar.values()];
  for (const week of weeks) week.days.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  return weeks.sort((a, b) => a.scholarName.localeCompare(b.scholarName));
}

/** "—" under a minute, "45m", "1h", "5h 10m". */
export function formatScreenMinutes(minutes: number): string {
  if (minutes < 1) return "—";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
