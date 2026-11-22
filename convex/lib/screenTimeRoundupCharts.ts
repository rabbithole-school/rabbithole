// The Friday screen-time roundup's charts, as SVG: the week's school days
// minute by minute, each scholar's in-school average, and the class's average
// scholar's minutes by activity on each day of the week (in and outside school
// together). Pure: the action in convex/eodScreenTimeCharts.ts reads the data
// and rasterizes these strings. The drawing itself is the School › Screen time
// page's (shared/screenTimeCharts.ts), so the post and the page match.

import {
  estimateTextWidth,
  LIGHT_CHART_THEME,
  renderDayStripSvg,
  renderInSchoolAveragesSvg,
  renderStackedDaysSvg,
  stripLegend,
  type ChartTheme,
  type StripPanel,
} from "../../shared/screenTimeCharts";
import {
  averageKindsByDay,
  summarizePeriod,
  type PeriodDayRow,
} from "../../shared/screenTimePeriod";
import type { Interval } from "../../shared/screenTime";
import {
  kindMinutesAtBell,
  type Stretch,
} from "../../shared/screenTimeStretches";

/** The drawing's width; each image adds a margin on both sides. */
export const ROUNDUP_CHART_WIDTH = 960;

export type RoundupChartDayRow = PeriodDayRow & {
  timeline: {
    stretches: Stretch[];
    leftOpen: Interval[];
    totalMinutes: number;
    schoolHours: Interval[];
  } | null;
};

export type RoundupChartInput = {
  timeZone: string;
  /** Saturday through Friday. */
  allDays: string[];
  /** Every scholar in the class, test accounts already left out. */
  classes: { scholarId: string; scholarName: string; className: string }[];
  rows: RoundupChartDayRow[];
};

export type RoundupChart = {
  /** Slack's image title, and the PNG's file name stem. */
  title: string;
  name: string;
  svg: string;
  width: number;
};

/** "2026-11-02" → "Mon Nov 2". A day key names a calendar day, so read it in UTC. */
function dayTitle(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MARGIN = 16;
const LEGEND_HEIGHT = 28;

/**
 * A chart framed for Slack: a margin all round (the page pads in CSS), and
 * for the strip its colour key above it (the page shows that in HTML).
 */
function framed(
  inner: { svg: string; width: number; height: number },
  theme: ChartTheme,
  withLegend = false,
): { svg: string; width: number } {
  let x = MARGIN;
  const keys = withLegend
    ? stripLegend(theme).map(({ label, color }) => {
        const key = `<rect x="${x}" y="${MARGIN + 8}" width="12" height="12" rx="2" fill="${color}"/><text x="${x + 17}" y="${MARGIN + 18}" font-family="${theme.fontFamily}" font-size="12" fill="${theme.textMuted}">${escapeXml(label)}</text>`;
        x += 17 + estimateTextWidth(label, 12) + 18;
        return key;
      })
    : [];
  const top = MARGIN + (withLegend ? LEGEND_HEIGHT : 0);
  const width = inner.width + MARGIN * 2;
  const height = top + inner.height + MARGIN;
  // The chart's own <svg> nests as is: resvg honours a nested viewport.
  const nested = inner.svg.replace(/^<svg /, `<svg x="${MARGIN}" y="${top}" `);
  return {
    width,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${theme.surface}"/>${keys.join("")}${nested}</svg>`,
  };
}

/**
 * The roundup's charts, in posting order. Empty when the week had no school
 * days or nobody in the class used a BunnyPad.
 */
export function buildRoundupCharts(input: RoundupChartInput): RoundupChart[] {
  const theme = LIGHT_CHART_THEME;
  const summary = summarizePeriod(input.rows, input.classes, input.allDays);
  // The channel's class by name; a channel spanning several says "Class".
  const classNames = [...new Set(input.classes.map((c) => c.className))];
  const averageLabel = classNames.length === 1 ? classNames[0] : "Class";
  const anyTime = input.rows.some((row) => row.measuredMinutes >= 1);
  if (summary.schoolDays.length === 0 || !anyTime) return [];
  const width = ROUNDUP_CHART_WIDTH;
  const scholars = [...input.classes].sort((a, b) =>
    a.scholarName.localeCompare(b.scholarName),
  );

  const panels: StripPanel[] = summary.schoolDays.map((dayKey) => {
    const dayRows = input.rows.filter((row) => row.dayKey === dayKey);
    const byScholar = new Map(dayRows.map((row) => [String(row.scholarId), row]));
    return {
      dayKey,
      title: dayTitle(dayKey),
      schoolHours:
        dayRows.find((row) => row.timeline?.schoolHours.length)?.timeline
          ?.schoolHours ?? [],
      rows: scholars.map((scholar) => {
        const timeline = byScholar.get(scholar.scholarId)?.timeline;
        return {
          id: scholar.scholarId,
          label: scholar.scholarName,
          totalMinutes: timeline?.totalMinutes ?? 0,
          stretches: timeline?.stretches ?? [],
          leftOpen: timeline?.leftOpen ?? [],
        };
      }),
    };
  });
  const strip = framed(
    renderDayStripSvg({ width, timeZone: input.timeZone, panels, theme }),
    theme,
    true,
  );

  const averages = framed(renderInSchoolAveragesSvg({
    width,
    theme,
    rows: summary.people.map((person) => ({
      id: person.id,
      label: person.name,
      value: person.inSchoolAvg,
    })),
    average: { label: averageLabel, value: summary.average.average },
  }), theme);

  // The page's activity bars with its toggle on Both: the strip's kinds,
  // summed across the bell, for the class's average scholar on every day.
  const kindRows = input.rows.map((row) => ({
    scholarId: String(row.scholarId),
    dayKey: row.dayKey,
    ...kindMinutesAtBell(row.timeline?.stretches ?? [], row.timeline?.schoolHours ?? []),
  }));
  const activity = framed(
    renderStackedDaysSvg({
      width,
      days: input.allDays,
      values: averageKindsByDay(
        kindRows,
        summary.people.map((person) => person.id),
        input.allDays,
        "both",
      ),
      theme,
      ariaLabel: "Class average minutes by activity, every day of the week",
    }),
    theme,
    true,
  );

  return [
    { title: "Minute by minute on school days", name: "minute-by-minute", ...strip },
    {
      title: "Minutes at school per school day, with the class average",
      name: "averages",
      ...averages,
    },
    {
      title:
        "Class average minutes by activity, every day, in and outside school (outside includes Extended Ed)",
      name: "activity",
      ...activity,
    },
  ];
}
