import { describe, expect, test } from "vitest";
import {
  buildRoundupCharts,
  type RoundupChartInput,
} from "../screenTimeRoundupCharts";
import { instantForLocalMinutes } from "../../../shared/institutionDay";

const HST = "Pacific/Honolulu";
const at = (dayKey: string, minute: number) =>
  instantForLocalMinutes(dayKey, minute, HST);
const ALL_DAYS = [
  "2026-10-31",
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
];

function row(
  scholarId: string,
  scholarName: string,
  dayKey: string,
  minutes: number,
  schoolDay = true,
): RoundupChartInput["rows"][number] {
  return {
    scholarId,
    scholarName,
    dayKey,
    measuredMinutes: minutes,
    outsideSchool: { measuredMinutes: 0 },
    schoolDay,
    timeline: {
      stretches: minutes
        ? [{ kind: "building" as const, start: at(dayKey, 9 * 60), end: at(dayKey, 9 * 60 + minutes) }]
        : [],
      leftOpen: [],
      totalMinutes: minutes,
      schoolHours: schoolDay ? [{ start: at(dayKey, 8 * 60), end: at(dayKey, 15 * 60) }] : [],
    },
  };
}

const classes = [
  { scholarId: "a", scholarName: "Ava Fictional", className: "Fireflies" },
  { scholarId: "b", scholarName: "Ben Fictional", className: "Fireflies" },
];

describe("the roundup's charts", () => {
  test("draw the school days minute by minute, the averages, and the week by activity", () => {
    const charts = buildRoundupCharts({
      timeZone: HST,
      allDays: ALL_DAYS,
      classes,
      rows: [
        row("a", "Ava Fictional", "2026-11-02", 40),
        row("b", "Ben Fictional", "2026-11-02", 0),
        row("a", "Ava Fictional", "2026-11-03", 90),
        // A weekend row is not a school-day panel.
        row("a", "Ava Fictional", "2026-11-01", 30, false),
      ],
    });
    expect(charts.map((chart) => chart.name)).toEqual([
      "minute-by-minute",
      "averages",
      "activity",
    ]);
    const [strip, averages] = charts;
    expect(strip.svg).toContain("Mon, Nov 2");
    expect(strip.svg).toContain("Tue, Nov 3");
    expect(strip.svg).not.toContain("Sun, Nov 1");
    // Every scholar gets a row, even one with no time that day.
    expect(strip.svg).toContain("Ben Fictional");
    // The colour key is drawn above the strip.
    expect(strip.svg).toContain("App building");
    expect(strip.svg.match(/<svg/g)).toHaveLength(2);
    expect(averages.svg).toContain("Ava Fictional");
    // One dashed line for the class's average, named after the class.
    expect(averages.svg).toContain("Fireflies average");
    // The week's activity bars, with the strip's colour key above them.
    expect(charts[2].svg).toContain("Class average minutes by activity");
    expect(charts[2].svg).toContain("App building");
    for (const chart of charts) {
      expect(chart.svg.startsWith("<svg")).toBe(true);
      // 960 of drawing plus a 16px margin each side.
      expect(chart.width).toBe(992);
    }
  });

  test("nothing to draw without a school day or any BunnyPad time", () => {
    expect(
      buildRoundupCharts({
        timeZone: HST,
        allDays: ALL_DAYS,
        classes,
        rows: [row("a", "Ava Fictional", "2026-11-01", 30, false)],
      }),
    ).toEqual([]);
    expect(
      buildRoundupCharts({
        timeZone: HST,
        allDays: ALL_DAYS,
        classes,
        rows: [row("a", "Ava Fictional", "2026-11-02", 0)],
      }),
    ).toEqual([]);
  });
});
