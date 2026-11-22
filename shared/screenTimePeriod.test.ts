import { describe, expect, test } from "vitest";

import { averageKindsByDay, summarizePeriod, type PeriodDayRow } from "./screenTimePeriod";
import { emptyKindMinutes, type StretchKind } from "./screenTimeStretches";

const row = (
  scholarId: string,
  dayKey: string,
  measured: number,
  outside: number,
  schoolDay = true,
): PeriodDayRow => ({
  scholarId,
  scholarName: scholarId === "a" ? "Avery Stone" : "Hoku Makani",
  dayKey,
  measuredMinutes: measured,
  outsideSchool: { measuredMinutes: outside },
  schoolDay,
});

describe("summarizePeriod", () => {
  const days = ["2026-11-14", "2026-11-16", "2026-11-17"];
  const summary = summarizePeriod(
    [
      row("a", "2026-11-14", 30, 30, false), // a Saturday: all outside
      row("a", "2026-11-16", 100, 20),
      row("a", "2026-11-17", 60, 0),
      row("b", "2026-11-16", 40, 10),
    ],
    [
      { scholarId: "a", scholarName: "Avery Stone" },
      { scholarId: "b", scholarName: "Hoku Makani" },
      // In the scope, never on the BunnyPad this period.
      { scholarId: "c", scholarName: "Lehua Torres" },
    ],
    days,
  );

  test("averages in-school minutes over every school day, missing days as zero", () => {
    expect(summary.schoolDays).toEqual(["2026-11-16", "2026-11-17"]);
    const avery = summary.people.find((p) => p.id === "a")!;
    const hoku = summary.people.find((p) => p.id === "b")!;
    expect(avery.inSchoolAvg).toBe(70); // (80 + 60) / 2
    expect(hoku.inSchoolAvg).toBe(15); // (30 + 0) / 2
    expect(hoku.schoolDaysOn).toBe(1);
    expect(avery.outsideAvg).toBeCloseTo(50 / 3);
  });

  test("the average is the average scholar per day, roster scholars with no time as zero", () => {
    // Avery 70, Hoku 15, Lehua 0.
    expect(summary.average.average).toBeCloseTo(85 / 3);
    expect(summary.people.find((p) => p.id === "c")?.inSchoolAvg).toBe(0);
  });
});

describe("averageKindsByDay", () => {
  const minutes = (partial: Partial<Record<StretchKind, number>> = {}) => ({
    ...emptyKindMinutes(),
    ...partial,
  });
  const rows = [
    { scholarId: "a", dayKey: "2026-11-16", inSchool: minutes({ chat: 30 }), outside: minutes({ web: 10 }) },
    { scholarId: "b", dayKey: "2026-11-16", inSchool: minutes({ chat: 10 }), outside: minutes() },
    { scholarId: "b", dayKey: "2026-11-17", inSchool: minutes(), outside: minutes({ launched_app: 40 }) },
    { scholarId: "z", dayKey: "2026-11-16", inSchool: minutes({ chat: 99 }), outside: minutes() },
  ];
  const days = ["2026-11-16", "2026-11-17"];

  test("averages the scope's scholars per day, a missing day as zero", () => {
    const both = averageKindsByDay(rows, ["a", "b", "c"], days, "both");
    expect(both[0]).toMatchObject({ chat: 40 / 3, web: 10 / 3 });
    expect(both[1]).toMatchObject({ launched_app: 40 / 3, chat: 0 });
  });

  test("each toggle side keeps only its side of the bell", () => {
    expect(averageKindsByDay(rows, ["a"], days, "inSchool")[0]).toMatchObject({ chat: 30, web: 0 });
    expect(averageKindsByDay(rows, ["a"], days, "outside")[0]).toMatchObject({ chat: 0, web: 10 });
  });
});
