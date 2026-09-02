import { describe, expect, test } from "vitest";
import {
  buildNowDigest,
  deriveHomeTabs,
  filterHomeworkForNow,
  filterRowsForTab,
  groupHomeRowsByUnit,
  isWithinScheduleWindow,
  matchRowsToFocusOrder,
  pickCurrentBlock,
  shouldShowHomeworkInNow,
  type ScholarHomeRow,
} from "./scholarHomeNow";

const assigned = (
  origin: "classFocus" | "homework",
  subject: string | null,
): ScholarHomeRow => ({ origin, subject });

describe("deriveHomeTabs", () => {
  test("shows subject tabs only when assigned lanes span at least two subjects", () => {
    expect(
      deriveHomeTabs({
        subjectTabs: ["Math Workshop", "Science"],
        rows: [assigned("classFocus", "math workshop")],
      }).tabs.map((tab) => tab.label),
    ).toEqual(["Now", "All", "Math", "Scholar’s Prep", "Quests"]);

    expect(
      deriveHomeTabs({
        subjectTabs: ["Math Workshop", "Science"],
        rows: [
          assigned("classFocus", "math workshop"),
          assigned("homework", "SCIENCE"),
        ],
      }).tabs,
    ).toEqual([
      { key: "now", label: "Now" },
      { key: "all", label: "All" },
      { key: "subject:math", label: "Math" },
      { key: "subject:science", label: "Science" },
      { key: "prep", label: "Scholar’s Prep" },
      { key: "quests", label: "Quests" },
    ]);
  });

  test("quests stay in their own final tab and never contribute subjects or Other", () => {
    const result = deriveHomeTabs({
      subjectTabs: ["Math Workshop", "Science"],
      rows: [
        { origin: "is", subject: "Math Workshop" },
        { origin: "is", subject: null },
      ],
    });
    expect(result.tabs.map((tab) => tab.label)).toEqual([
      "Now",
      "All",
      "Math",
      "Scholar’s Prep",
      "Quests",
    ]);
    expect(result.hasOther).toBe(false);
  });

  test("Other requires ≥2 named subjects — lone null-subject work collapses to Now · All", () => {
    // Only 1 named subject: Other not offered even though hasOther is true
    const oneSubject = deriveHomeTabs({
      subjectTabs: ["Math Workshop"],
      rows: [
        assigned("homework", "Math Workshop"),
        assigned("classFocus", null),
      ],
    });
    expect(oneSubject.hasOther).toBe(true);
    expect(oneSubject.tabs.map((tab) => tab.label)).toEqual([
      "Now",
      "All",
      "Math",
      "Scholar’s Prep",
      "Quests",
    ]);

    // ≥2 named subjects: Other IS offered alongside them
    const twoSubjects = deriveHomeTabs({
      subjectTabs: ["Math Workshop", "Science"],
      rows: [
        assigned("homework", "Math Workshop"),
        assigned("classFocus", "Science"),
        assigned("classFocus", null),
      ],
    });
    expect(twoSubjects.hasOther).toBe(true);
    expect(twoSubjects.tabs.map((tab) => tab.label)).toEqual([
      "Now",
      "All",
      "Math",
      "Science",
      "Other",
      "Scholar’s Prep",
      "Quests",
    ]);

    expect(deriveHomeTabs({ subjectTabs: [], rows: [] }).tabs).toEqual([
      { key: "now", label: "Now" },
      { key: "all", label: "All" },
      { key: "subject:math", label: "Math" },
      { key: "prep", label: "Scholar’s Prep" },
      { key: "quests", label: "Quests" },
    ]);
  });

  test("Apps tab appears left of Quests only when hasApps is set", () => {
    expect(
      deriveHomeTabs({ subjectTabs: [], rows: [] }).tabs.map((tab) => tab.key),
    ).not.toContain("apps");

    expect(
      deriveHomeTabs({ subjectTabs: [], rows: [], hasApps: true }).tabs,
    ).toEqual([
      { key: "now", label: "Now" },
      { key: "all", label: "All" },
      { key: "subject:math", label: "Math" },
      { key: "prep", label: "Scholar’s Prep" },
      { key: "apps", label: "Apps" },
      { key: "quests", label: "Quests" },
    ]);
  });
});

describe("filterRowsForTab", () => {
  const rows = [
    { id: "math", ...assigned("classFocus", "Math Workshop") },
    { id: "science", ...assigned("homework", "Science") },
    { id: "other", ...assigned("homework", null) },
    { id: "quest", origin: "is" as const, subject: "Science" },
  ];

  test("matches subject tabs case-insensitively, groups Math Workshop, and excludes quests", () => {
    expect(
      filterRowsForTab(rows, "subject:science").map((row) => row.id),
    ).toEqual(["science"]);
    expect(filterRowsForTab(rows, "subject:math").map((row) => row.id)).toEqual(
      ["math"],
    );
  });

  test("keeps homework in All and in its matching subject tab", () => {
    expect(filterRowsForTab(rows, "all").map((row) => row.id)).toContain(
      "science",
    );
    expect(
      filterRowsForTab(rows, "subject:science").map((row) => row.id),
    ).toContain("science");
  });

  test("keeps assigned work in All and quest work in Quests", () => {
    expect(filterRowsForTab(rows, "other").map((row) => row.id)).toEqual([
      "other",
    ]);
    expect(filterRowsForTab(rows, "all").map((row) => row.id)).toEqual([
      "math",
      "science",
      "other",
    ]);
    expect(filterRowsForTab(rows, "quests").map((row) => row.id)).toEqual([
      "quest",
    ]);
  });

  test("prep and apps tabs never surface plate rows", () => {
    expect(filterRowsForTab(rows, "prep")).toEqual([]);
    expect(filterRowsForTab(rows, "apps")).toEqual([]);
  });
});

describe("groupHomeRowsByUnit", () => {
  test("puts same-unit activities from one assignment under one band", () => {
    const rows = [
      { id: "play", unitId: "games", assignmentId: "demo" },
      { id: "reflect", unitId: "games", assignmentId: "demo" },
    ];

    expect(groupHomeRowsByUnit(rows)).toEqual([
      {
        key: "unit:games:assignment:demo",
        unitId: "games",
        assignmentId: "demo",
        rows,
      },
    ]);
  });

  test("keeps different assignments and anchorless work separate", () => {
    const rows = [
      { id: "a", unitId: "games", assignmentId: "first" },
      { id: "free-1", unitId: null, assignmentId: null },
      { id: "b", unitId: "games", assignmentId: "second" },
      { id: "free-2", unitId: null, assignmentId: null },
    ];

    expect(groupHomeRowsByUnit(rows).map((group) => group.rows.map((row) => row.id))).toEqual([
      ["a"],
      ["free-1"],
      ["b"],
      ["free-2"],
    ]);
  });

  test("keeps first-unit appearance and activity order stable", () => {
    const rows = [
      { id: "a1", unitId: "a", assignmentId: null },
      { id: "b1", unitId: "b", assignmentId: null },
      { id: "a2", unitId: "a", assignmentId: null },
    ];

    expect(groupHomeRowsByUnit(rows).map((group) => group.rows.map((row) => row.id))).toEqual([
      ["a1", "a2"],
      ["b1"],
    ]);
  });
});

describe("buildNowDigest", () => {
  test("returns the calibrated ladder order", () => {
    const nowMs = 10_000;
    const result = buildNowDigest({
      focusEntries: [{ id: "focus", setAt: 9_000, endsAt: 11_000 }],
      plannedToday: [{ id: "planned", startsAt: 12_000 }],
      playlist: { id: "practice" },
      homework: [{ id: "homework", completedByMe: false }],
      nowMs,
    });
    expect(result.sections.map((section) => section.key)).toEqual([
      "focus",
      "planned",
      "practice",
      "homework",
    ]);
    expect(result.isQuiet).toBe(false);
  });

  test("a planned focus (setAt null) is not live and does not defeat quiet", () => {
    const result = buildNowDigest({
      focusEntries: [{ id: "planned-focus", setAt: null, endsAt: 20_000 }],
      plannedToday: [],
      playlist: null,
      homework: [],
      nowMs: 10_000,
    });
    expect(result.sections).toEqual([]);
    expect(result.isQuiet).toBe(true);
  });

  test("practice does not prevent the quiet fallback", () => {
    const result = buildNowDigest({
      focusEntries: [],
      plannedToday: [{ startsAt: 9_999 }],
      playlist: { id: "practice" },
      homework: [{ completedByMe: true }],
      nowMs: 10_000,
    });
    expect(result.sections.map((section) => section.key)).toEqual(["practice"]);
    expect(result.isQuiet).toBe(true);
  });

  test("a focus that has run past its window is still the day's focus", () => {
    // The teacher's own surface calls this "running long" and offers Extend /
    // Wrap — the focus isn't over until a human ends it. When the ladder
    // filtered it out on `endsAt`, it called the day quiet and rendered its
    // "Open work" fallback directly above a plate still printing "Class
    // focus" for the same row. The wall is dropped separately, upstream, by
    // clearing the entry's `soloStartableByMe` once the window closes.
    const result = buildNowDigest({
      focusEntries: [{ id: "overrun", setAt: 8_000, endsAt: 9_000 }],
      plannedToday: [],
      playlist: null,
      homework: [],
      nowMs: 10_000,
    });
    expect(result.sections.map((section) => section.key)).toEqual(["focus"]);
    expect(result.isQuiet).toBe(false);
  });

  test("a focus the scholar finished drops out however its window sits", () => {
    // Completion is the scholar's own answer and still ends the entry for
    // them — "running long" is about the clock, not about work already done.
    const result = buildNowDigest({
      focusEntries: [
        { id: "done", setAt: 8_000, endsAt: 9_000, completedByMe: true },
      ],
      plannedToday: [],
      playlist: null,
      homework: [],
      nowMs: 10_000,
    });
    expect(result.sections).toEqual([]);
    expect(result.isQuiet).toBe(true);
  });
});

describe("matchRowsToFocusOrder", () => {
  test("uses focus order and matches both assignment and activity", () => {
    const focusItems = [
      { assignmentId: "assignment-a", activityId: "shared-activity" },
      { assignmentId: "assignment-b", activityId: "shared-activity" },
      { assignmentId: "assignment-a", activityId: "later-activity" },
    ];
    const recencySortedRows = [
      {
        id: "touched-most-recently",
        assignmentId: "assignment-a",
        activityId: "later-activity",
      },
      {
        id: "same-activity-other-assignment",
        assignmentId: "assignment-b",
        activityId: "shared-activity",
      },
      {
        id: "first-focus-item",
        assignmentId: "assignment-a",
        activityId: "shared-activity",
      },
    ];

    expect(
      matchRowsToFocusOrder(focusItems, recencySortedRows).map((row) => row.id),
    ).toEqual([
      "first-focus-item",
      "same-activity-other-assignment",
      "touched-most-recently",
    ]);
  });

  test("falls back to activity identity without stealing an exact match", () => {
    const focusItems = [
      { assignmentId: null, activityId: "shared-activity" },
      { assignmentId: "assignment-b", activityId: "shared-activity" },
    ];
    const rows = [
      {
        id: "exact-match",
        assignmentId: "assignment-b",
        activityId: "shared-activity",
      },
      {
        id: "fallback-match",
        assignmentId: null,
        activityId: "shared-activity",
      },
    ];

    expect(matchRowsToFocusOrder(focusItems, rows).map((row) => row.id)).toEqual([
      "fallback-match",
      "exact-match",
    ]);
  });

  test("appends unmatched rows so missing ids never drop live work", () => {
    const rows = [
      { id: "ordered", assignmentId: "assignment-a", activityId: "activity-a" },
      { id: "missing-assignment", assignmentId: null, activityId: null },
      { id: "missing-activity", assignmentId: "assignment-b", activityId: null },
    ];

    const result = matchRowsToFocusOrder(
      [{ assignmentId: "assignment-a", activityId: "activity-a" }],
      rows,
    );

    expect(result.map((row) => row.id)).toEqual([
      "ordered",
      "missing-assignment",
      "missing-activity",
    ]);
    expect(result).toHaveLength(rows.length);
  });
});

describe("shouldShowHomeworkInNow", () => {
  test("shows homework only during Scholar’s Prep or outside school hours", () => {
    expect(
      shouldShowHomeworkInNow({
        currentBlockKind: "class",
        isWithinSchoolHours: true,
        isPrepTime: false,
      }),
    ).toBe(false);
    expect(
      shouldShowHomeworkInNow({
        currentBlockKind: "recess",
        isWithinSchoolHours: true,
        isPrepTime: false,
      }),
    ).toBe(false);
    expect(
      shouldShowHomeworkInNow({
        currentBlockKind: "class",
        isWithinSchoolHours: true,
        isPrepTime: true,
      }),
    ).toBe(true);
    expect(
      shouldShowHomeworkInNow({
        currentBlockKind: null,
        isWithinSchoolHours: false,
        isPrepTime: false,
      }),
    ).toBe(true);
  });
});

describe("filterHomeworkForNow", () => {
  const timeZone = "Pacific/Honolulu";
  const fridayNow = Date.parse("2026-08-21T20:00:00.000Z");

  test("keeps undated, due, overdue, and Friday-to-Monday homework", () => {
    const homework = [
      { id: "undated", dueAt: null },
      { id: "overdue", dueAt: Date.parse("2026-08-20T22:00:00.000Z") },
      { id: "today", dueAt: Date.parse("2026-08-21T22:00:00.000Z") },
      { id: "monday", dueAt: Date.parse("2026-08-24T22:00:00.000Z") },
      { id: "later", dueAt: Date.parse("2026-08-25T22:00:00.000Z") },
      { id: "done", dueAt: null, completedByMe: true },
    ];

    expect(
      filterHomeworkForNow(homework, {
        nowMs: fridayNow,
        timeZone,
        nextOpenSchoolDayKey: "2026-08-24",
      }).map((entry) => entry.id),
    ).toEqual(["undated", "overdue", "today", "monday"]);
  });

  test("uses the supplied next open day so closure skips do not admit later work", () => {
    const homework = [
      { id: "next-open", dueAt: Date.parse("2026-08-26T22:00:00.000Z") },
      { id: "later", dueAt: Date.parse("2026-08-27T22:00:00.000Z") },
    ];

    expect(
      filterHomeworkForNow(homework, {
        nowMs: fridayNow,
        timeZone,
        nextOpenSchoolDayKey: "2026-08-26",
      }).map((entry) => entry.id),
    ).toEqual(["next-open"]);
  });
});

describe("pickCurrentBlock", () => {
  const blocks = [
    { key: "a", startLocal: "08:30", endLocal: "09:40" },
    { key: "b", startLocal: "09:40", endLocal: "10:30" },
  ];

  test("uses the institution timezone rather than UTC", () => {
    const honoluluNine = Date.parse("2026-07-20T19:00:00Z");
    expect(
      pickCurrentBlock(blocks, honoluluNine, "Pacific/Honolulu")?.key,
    ).toBe("a");
    expect(pickCurrentBlock(blocks, honoluluNine, "UTC")).toBeNull();
  });

  describe("isWithinScheduleWindow", () => {
    const blocks = [
      { startLocal: "08:00", endLocal: "08:30" },
      { startLocal: "08:30", endLocal: "09:40" },
      { startLocal: "15:05", endLocal: "16:30" },
    ];

    test("treats gaps between first bell and dismissal as school hours", () => {
      expect(
        isWithinScheduleWindow(
          blocks,
          Date.parse("2026-07-20T23:00:00Z"),
          "Pacific/Honolulu",
        ),
      ).toBe(true);
    });

    test("returns false before the first bell and at dismissal", () => {
      expect(
        isWithinScheduleWindow(
          blocks,
          Date.parse("2026-07-20T17:59:00Z"),
          "Pacific/Honolulu",
        ),
      ).toBe(false);
      expect(
        isWithinScheduleWindow(
          blocks,
          Date.parse("2026-07-21T02:30:00Z"),
          "Pacific/Honolulu",
        ),
      ).toBe(false);
    });
  });

  test("uses inclusive starts and exclusive ends at boundary minutes", () => {
    expect(
      pickCurrentBlock(
        blocks,
        Date.parse("2026-07-20T19:39:00Z"),
        "Pacific/Honolulu",
      )?.key,
    ).toBe("a");
    expect(
      pickCurrentBlock(
        blocks,
        Date.parse("2026-07-20T19:40:00Z"),
        "Pacific/Honolulu",
      )?.key,
    ).toBe("b");
    expect(
      pickCurrentBlock(
        blocks,
        Date.parse("2026-07-20T20:30:00Z"),
        "Pacific/Honolulu",
      ),
    ).toBeNull();
  });
});
