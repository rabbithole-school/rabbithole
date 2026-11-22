import { describe, expect, test } from "vitest";
import {
  formatScreenMinutes,
  sumScholarWeeks,
  type ScreenTimeDay,
} from "./screenTimeWeek";

function day(overrides: Partial<ScreenTimeDay> & Pick<ScreenTimeDay, "scholarId" | "dayKey">): ScreenTimeDay {
  return {
    scholarName: overrides.scholarId === "s2" ? "Ari Test" : "Mika Test",
    measuredMinutes: 0,
    estimatedMinutes: 0,
    apps: [],
    outsideSchool: { measuredMinutes: 0, estimatedMinutes: 0 },
    builder: { onScreenMinutes: 0, activeMinutes: 0 },
    webActivityMinutes: 0,
    otherRabbitholeMinutes: 0,
    ...overrides,
  };
}

describe("sumScholarWeeks", () => {
  test("sums each scholar's days and keeps measured and estimated apart", () => {
    const weeks = sumScholarWeeks([
      day({
        scholarId: "s1",
        dayKey: "2026-11-03",
        measuredMinutes: 120,
        estimatedMinutes: 10,
        outsideSchool: { measuredMinutes: 30, estimatedMinutes: 10 },
        builder: { onScreenMinutes: 60, activeMinutes: 25 },
        webActivityMinutes: 20,
        otherRabbitholeMinutes: 25,
        apps: [{ externalAppId: "a1", appName: "Stop Motion", measuredMinutes: 15, estimatedMinutes: 10 }],
      }),
      day({
        scholarId: "s1",
        dayKey: "2026-11-02",
        measuredMinutes: 45,
        builder: { onScreenMinutes: 40, activeMinutes: 10 },
        otherRabbitholeMinutes: 5,
      }),
    ]);

    expect(weeks).toHaveLength(1);
    const [week] = weeks;
    expect(week.totals).toEqual({
      measuredMinutes: 165,
      estimatedMinutes: 10,
      outsideSchool: { measuredMinutes: 30, estimatedMinutes: 10 },
      builder: { onScreenMinutes: 100, activeMinutes: 35 },
      webActivityMinutes: 20,
      appsMeasuredMinutes: 15,
      appsEstimatedMinutes: 10,
      otherRabbitholeMinutes: 30,
    });
    // Days come back oldest first, whatever order the rows arrived in.
    expect(week.days.map((d) => d.dayKey)).toEqual(["2026-11-02", "2026-11-03"]);
  });

  test("orders scholars by name, never by minutes", () => {
    const weeks = sumScholarWeeks([
      day({ scholarId: "s1", dayKey: "2026-11-02", measuredMinutes: 5 }),
      day({ scholarId: "s2", dayKey: "2026-11-02", measuredMinutes: 500 }),
    ]);
    expect(weeks.map((w) => w.scholarName)).toEqual(["Ari Test", "Mika Test"]);
  });
});

describe("formatScreenMinutes", () => {
  test.each([
    [0, "—"],
    [0.6, "—"],
    [1, "1m"],
    [59.4, "59m"],
    [59.6, "1h"],
    [60, "1h"],
    [310, "5h 10m"],
  ])("%s minutes reads %s", (minutes, text) => {
    expect(formatScreenMinutes(minutes)).toBe(text);
  });
});
