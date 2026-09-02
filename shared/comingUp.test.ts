import { describe, expect, test } from "vitest";
import {
  buildComingUpGroups,
  formatComingUpDayHeading,
  formatStartTime,
  type ComingUpHomework,
  type ComingUpPlanned,
} from "./comingUp";

const TZ = "UTC";
const at = (dayKey: string, hour = 12) =>
  Date.parse(`${dayKey}T${String(hour).padStart(2, "0")}:00:00Z`);

function homework(
  overrides: Partial<ComingUpHomework> & { dueAt: number },
): ComingUpHomework {
  return {
    kind: "homework",
    assignmentId: overrides.assignmentId ?? "a1",
    activityId: overrides.activityId ?? "act1",
    activityTitle: overrides.activityTitle ?? "Tide-pool field notes",
    unitTitle: overrides.unitTitle ?? "Tide Pool Ecosystems",
    unitEmoji: overrides.unitEmoji ?? "\uD83D\uDC0B",
    teacherName: overrides.teacherName ?? "Daniel Char",
    dueAt: overrides.dueAt,
  };
}

function planned(
  overrides: Partial<ComingUpPlanned> & { startsAt: number },
): ComingUpPlanned {
  return {
    kind: "planned",
    assignmentId: overrides.assignmentId ?? "a2",
    activityId: overrides.activityId ?? "act2",
    activityTitle: overrides.activityTitle ?? "Map story: why here?",
    unitTitle: overrides.unitTitle ?? "Mapping Our Islands",
    unitEmoji: overrides.unitEmoji ?? "\uD83D\uDDFA",
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
const NEXT_OPEN = "2026-08-25";

describe("buildComingUpGroups", () => {
  test("excludes homework due on the next open school day; includes later", () => {
    const groups = buildComingUpGroups({
      homework: [
        homework({ dueAt: at("2026-08-25"), activityId: "tonight" }), // next open → tonight owns it
        homework({ dueAt: at("2026-08-26"), activityId: "wed" }),
      ],
      planned: [],
      horizonDayKeys: HORIZON,
      nextOpenSchoolDayKey: NEXT_OPEN,
      timeZone: TZ,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe("2026-08-26");
    expect(groups[0].entries.map((e) => e.activityId)).toEqual(["wed"]);
  });

  test("groups multiple entries under one day, homework before planned", () => {
    const groups = buildComingUpGroups({
      homework: [
        homework({ dueAt: at("2026-08-28", 15), activityId: "hw-late" }),
        homework({ dueAt: at("2026-08-28", 9), activityId: "hw-early" }),
      ],
      planned: [planned({ startsAt: at("2026-08-28", 10), activityId: "plan" })],
      horizonDayKeys: HORIZON,
      nextOpenSchoolDayKey: NEXT_OPEN,
      timeZone: TZ,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe("2026-08-28");
    // Homework leads (sorted by dueAt), planned trails.
    expect(groups[0].entries.map((e) => e.activityId)).toEqual([
      "hw-early",
      "hw-late",
      "plan",
    ]);
  });

  test("planned previews show on the next open school day (tonight only covers today)", () => {
    const groups = buildComingUpGroups({
      homework: [],
      planned: [planned({ startsAt: at("2026-08-25"), activityId: "tue-plan" })],
      horizonDayKeys: HORIZON,
      nextOpenSchoolDayKey: NEXT_OPEN,
      timeZone: TZ,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe("2026-08-25");
    expect(groups[0].entries[0].kind).toBe("planned");
  });

  test("drops entries outside the horizon", () => {
    const groups = buildComingUpGroups({
      homework: [homework({ dueAt: at("2026-09-15"), activityId: "far" })],
      planned: [planned({ startsAt: at("2026-09-15"), activityId: "far-plan" })],
      horizonDayKeys: HORIZON,
      nextOpenSchoolDayKey: NEXT_OPEN,
      timeZone: TZ,
    });
    expect(groups).toHaveLength(0);
  });

  test("groups appear in horizon order", () => {
    const groups = buildComingUpGroups({
      homework: [
        homework({ dueAt: at("2026-08-31"), activityId: "mon" }),
        homework({ dueAt: at("2026-08-26"), activityId: "wed" }),
      ],
      planned: [],
      horizonDayKeys: HORIZON,
      nextOpenSchoolDayKey: NEXT_OPEN,
      timeZone: TZ,
    });
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-08-26", "2026-08-31"]);
  });
});

describe("coming-up label copy", () => {
  test("day heading reads weekday · month day", () => {
    expect(formatComingUpDayHeading("2026-08-27")).toBe("Thursday \u00b7 Aug 27");
    expect(formatComingUpDayHeading("2026-08-28")).toBe("Friday \u00b7 Aug 28");
  });

  // The old `formatComingUpDueChip` ("due Thu") was a SECOND deadline lexicon
  // competing with `dueStatus` ("due Thursday"). It is gone: every deadline a
  // scholar sees now renders through DueChip/dueStatus. What is left here is
  // the one thing Coming up still formats itself — a planned row's start time.
  test("planned rows read a wall-clock start in the institution timezone", () => {
    expect(formatStartTime(at("2026-08-27", 10), TZ)).toBe("10:00 AM");
  });
});
