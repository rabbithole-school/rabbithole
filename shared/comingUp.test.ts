import { describe, expect, test } from "vitest";
import {
  buildComingUpGroups,
  formatStartTime,
  type ComingUpPlanned,
} from "./comingUp";

const TZ = "UTC";
const at = (dayKey: string, hour = 12) =>
  Date.parse(`${dayKey}T${String(hour).padStart(2, "0")}:00:00Z`);

function planned(
  overrides: Partial<ComingUpPlanned> & { startsAt: number },
): ComingUpPlanned {
  return {
    kind: "planned",
    assignmentId: overrides.assignmentId ?? "a2",
    activityId: overrides.activityId ?? "act2",
    activityTitle: overrides.activityTitle ?? "Map story: why here?",
    unitTitle: overrides.unitTitle ?? "Mapping Our Islands",
    unitEmoji: overrides.unitEmoji ?? "🗺",
    teacherName: overrides.teacherName ?? "Daniel Char",
    startsAt: overrides.startsAt,
  };
}

// A Monday-anchored horizon: next open school day is Tue, window rolls across
// the weekend into the following Monday.
const HORIZON = [
  "2026-08-25", // Tue (next open school day)
  "2026-08-26", // Wed
  "2026-08-27", // Thu
  "2026-08-28", // Fri
  "2026-08-31", // Mon (weekend skipped)
];

describe("buildComingUpGroups", () => {
  test("groups multiple planned entries under one day by start time", () => {
    const groups = buildComingUpGroups({
      planned: [
        planned({ startsAt: at("2026-08-28", 13), activityId: "late" }),
        planned({ startsAt: at("2026-08-28", 9), activityId: "early" }),
      ],
      horizonDayKeys: HORIZON,
      timeZone: TZ,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe("2026-08-28");
    expect(groups[0].entries.map((e) => e.activityId)).toEqual(["early", "late"]);
  });

  test("planned previews show on the next open school day", () => {
    const groups = buildComingUpGroups({
      planned: [planned({ startsAt: at("2026-08-25"), activityId: "tue-plan" })],
      horizonDayKeys: HORIZON,
      timeZone: TZ,
    });
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-08-25"]);
  });

  test("drops entries outside the horizon", () => {
    const groups = buildComingUpGroups({
      planned: [planned({ startsAt: at("2026-09-15"), activityId: "far-plan" })],
      horizonDayKeys: HORIZON,
      timeZone: TZ,
    });
    expect(groups).toHaveLength(0);
  });

  test("groups appear in horizon order", () => {
    const groups = buildComingUpGroups({
      planned: [
        planned({ startsAt: at("2026-08-31"), activityId: "mon" }),
        planned({ startsAt: at("2026-08-26"), activityId: "wed" }),
      ],
      horizonDayKeys: HORIZON,
      timeZone: TZ,
    });
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-08-26", "2026-08-31"]);
  });
});

describe("coming-up label copy", () => {
  test("planned rows read a wall-clock start in the institution timezone", () => {
    expect(formatStartTime(at("2026-08-27", 10), TZ)).toBe("10:00 AM");
  });
});
