import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  resolveContextIdentity,
  resolveReadingLevel,
  friendlyScholarName,
  resolveSessionHistory,
  buildMasteryContext,
  buildSignalContext,
  mergeSeeds,
  resolveTimingContext,
  enrichPriorActivities,
  type ActivityLite,
} from "../sessionContextHelpers";

const user = (s: string) => s as Id<"users">;
const proj = (s: string) => s as Id<"sessions">;
const act = (s: string) => s as Id<"activities">;
const les = (s: string) => s as Id<"lessons">;

describe("resolveContextIdentity", () => {
  test("non-test-drive → owner, not synthetic", () => {
    expect(resolveContextIdentity({ userId: user("owner") })).toEqual({
      isSyntheticView: false,
      contextUserId: user("owner"),
    });
  });

  test("test-drive as real scholar → that scholar, not synthetic", () => {
    expect(
      resolveContextIdentity({
        userId: user("teacher"),
        isTestDrive: true,
        testDriveAsScholarId: user("kai"),
      }),
    ).toEqual({ isSyntheticView: false, contextUserId: user("kai") });
  });

  test("test-drive with a synthetic field → synthetic view, owner id", () => {
    expect(
      resolveContextIdentity({
        userId: user("teacher"),
        isTestDrive: true,
        testDriveSyntheticName: "Synthetic Sam",
      }),
    ).toEqual({ isSyntheticView: true, contextUserId: user("teacher") });
  });

  test("an empty-string synthetic field still counts (defined !== undefined)", () => {
    const { isSyntheticView } = resolveContextIdentity({
      userId: user("teacher"),
      isTestDrive: true,
      testDriveSyntheticDossier: "",
    });
    expect(isSyntheticView).toBe(true);
  });

  test("real-scholar override beats synthetic fields", () => {
    expect(
      resolveContextIdentity({
        userId: user("teacher"),
        isTestDrive: true,
        testDriveAsScholarId: user("lani"),
        testDriveSyntheticName: "ignored",
      }),
    ).toEqual({ isSyntheticView: false, contextUserId: user("lani") });
  });

  test("test-drive with no view-as fields → owner, not synthetic", () => {
    expect(
      resolveContextIdentity({ userId: user("teacher"), isTestDrive: true }),
    ).toEqual({ isSyntheticView: false, contextUserId: user("teacher") });
  });
});

describe("resolveReadingLevel", () => {
  test("override wins regardless of mode", () => {
    expect(
      resolveReadingLevel({
        isSyntheticView: false,
        readingLevelOverride: "3",
        syntheticReadingLevel: "5",
        scholarReadingLevel: "8",
      }),
    ).toBe("3");
    expect(
      resolveReadingLevel({
        isSyntheticView: true,
        readingLevelOverride: "3",
        syntheticReadingLevel: "5",
        scholarReadingLevel: "8",
      }),
    ).toBe("3");
  });

  test("synthetic mode uses the synthetic level when no override", () => {
    expect(
      resolveReadingLevel({
        isSyntheticView: true,
        readingLevelOverride: undefined,
        syntheticReadingLevel: "5",
        scholarReadingLevel: "8",
      }),
    ).toBe("5");
  });

  test("real mode uses the scholar's stored level when no override", () => {
    expect(
      resolveReadingLevel({
        isSyntheticView: false,
        readingLevelOverride: undefined,
        syntheticReadingLevel: "5",
        scholarReadingLevel: "8",
      }),
    ).toBe("8");
  });

  test("falls back to null", () => {
    expect(
      resolveReadingLevel({
        isSyntheticView: false,
        readingLevelOverride: undefined,
        syntheticReadingLevel: undefined,
        scholarReadingLevel: null,
      }),
    ).toBeNull();
    expect(
      resolveReadingLevel({
        isSyntheticView: true,
        readingLevelOverride: undefined,
        syntheticReadingLevel: undefined,
        scholarReadingLevel: "8",
      }),
    ).toBeNull();
  });
});

describe("friendlyScholarName", () => {
  test("null/undefined name → null", () => {
    expect(friendlyScholarName(null, "kai")).toBeNull();
    expect(friendlyScholarName(undefined, "kai")).toBeNull();
  });
  test("name identical to username → null", () => {
    expect(friendlyScholarName("test-scholar-001", "test-scholar-001")).toBeNull();
  });
  test("names with digits or underscores → null", () => {
    expect(friendlyScholarName("scholar_1", "u")).toBeNull();
    expect(friendlyScholarName("Kai2", "u")).toBeNull();
  });
  test("a clean first name passes through", () => {
    expect(friendlyScholarName("Kai", "test-scholar-001")).toBe("Kai");
  });
});

describe("resolveSessionHistory", () => {
  test("no prior real sessions → first session, no timestamp", () => {
    expect(
      resolveSessionHistory(
        [{ _id: proj("current"), _creationTime: 100 }],
        proj("current"),
      ),
    ).toEqual({ isFirstSession: true, lastSessionAt: null });
  });

  test("excludes current, test-drive, and offline projects", () => {
    const result = resolveSessionHistory(
      [
        { _id: proj("current"), _creationTime: 100 },
        { _id: proj("td"), _creationTime: 200, isTestDrive: true },
        { _id: proj("off"), _creationTime: 300, isOffline: true },
      ],
      proj("current"),
    );
    expect(result).toEqual({ isFirstSession: true, lastSessionAt: null });
  });

  test("picks the max of lastMessageAt ?? _creationTime across prior sessions", () => {
    const result = resolveSessionHistory(
      [
        { _id: proj("current"), _creationTime: 999 },
        { _id: proj("a"), _creationTime: 100, lastMessageAt: 500 },
        { _id: proj("b"), _creationTime: 700 }, // no lastMessageAt → uses 700
        { _id: proj("c"), _creationTime: 100, lastMessageAt: 600 },
      ],
      proj("current"),
    );
    expect(result).toEqual({ isFirstSession: false, lastSessionAt: 700 });
  });
});

describe("buildMasteryContext", () => {
  test("empty → null", () => {
    expect(buildMasteryContext([])).toBeNull();
  });
  test("maps DB rows to prompt entries", () => {
    expect(
      buildMasteryContext([
        {
          conceptLabel: "tension",
          domain: "physics",
          masteryLevel: 3.5,
          confidenceScore: 0.9,
          evidenceSummary: "explained load paths",
          studentInitiated: true,
        },
      ]),
    ).toEqual([
      {
        concept: "tension",
        domain: "physics",
        level: 3.5,
        confidence: 0.9,
        evidence: "explained load paths",
        studentInitiated: true,
      },
    ]);
  });
});

describe("buildSignalContext", () => {
  test("empty → null", () => {
    expect(buildSignalContext([])).toBeNull();
  });
  test("aggregates per-type count and highCount", () => {
    expect(
      buildSignalContext([
        { signalType: "metacognition", intensity: "high" },
        { signalType: "metacognition", intensity: "low" },
        { signalType: "metacognition", intensity: "high" },
        { signalType: "self_direction", intensity: "moderate" },
      ]),
    ).toEqual({
      metacognition: { count: 3, highCount: 2 },
      self_direction: { count: 1, highCount: 0 },
    });
  });
});

describe("mergeSeeds", () => {
  test("empty inputs → empty array", () => {
    expect(mergeSeeds([], [])).toEqual([]);
  });
  test("approved seeds first, then pending; nulls defaulted; flags set", () => {
    expect(
      mergeSeeds(
        [{ topic: "arches", domain: "engineering", suggestionType: "frontier" }],
        [{ topic: "tides", suggestionType: "depth_probe" }],
      ),
    ).toEqual([
      {
        topic: "arches",
        domain: "engineering",
        approachHint: null,
        suggestionType: "frontier",
        approved: true,
      },
      {
        topic: "tides",
        domain: null,
        approachHint: null,
        suggestionType: "depth_probe",
        approved: false,
      },
    ]);
  });
});

describe("resolveTimingContext", () => {
  const NOW = 1_000_000;
  test("no schedule, no duration → null", () => {
    expect(
      resolveTimingContext({
        activitySchedule: undefined,
        sessionActivityId: undefined,
        sessionStartedAt: 0,
        unitDurationMinutes: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  test("no active focus but a unit duration → soft-pacing window", () => {
    expect(
      resolveTimingContext({
        activitySchedule: undefined,
        sessionActivityId: undefined,
        sessionStartedAt: 42,
        unitDurationMinutes: 30,
        now: NOW,
      }),
    ).toEqual({ unitEndsAt: null, sessionStartedAt: 42, unitDurationMinutes: 30 });
  });

  test("picks soonest-ending active classFocus targeting this activity", () => {
    const result = resolveTimingContext({
      activitySchedule: [
        { mode: "classFocus", endsAt: NOW + 5000, activityId: act("a1") },
        { mode: "classFocus", endsAt: NOW + 2000, activityId: act("a1") },
        { mode: "homework", endsAt: NOW + 1000, activityId: act("a1") },
      ],
      sessionActivityId: act("a1"),
      sessionStartedAt: 0,
      unitDurationMinutes: 60,
      now: NOW,
    });
    expect(result).toEqual({
      unitEndsAt: NOW + 2000,
      sessionStartedAt: 0,
      unitDurationMinutes: 60,
    });
  });

  test("ignores expired pushes, non-classFocus modes, and other activities", () => {
    const result = resolveTimingContext({
      activitySchedule: [
        { mode: "classFocus", endsAt: NOW - 1, activityId: act("a1") }, // expired
        { mode: "homework", endsAt: NOW + 9000, activityId: act("a1") }, // wrong mode
        { mode: "classFocus", endsAt: NOW + 9000, activityId: act("other") }, // wrong activity
      ],
      sessionActivityId: act("a1"),
      sessionStartedAt: 0,
      unitDurationMinutes: 30,
      now: NOW,
    });
    // No qualifying focus → falls back to the unit duration.
    expect(result).toEqual({
      unitEndsAt: null,
      sessionStartedAt: 0,
      unitDurationMinutes: 30,
    });
  });

  test("non-activity-specific project accepts any active classFocus", () => {
    const result = resolveTimingContext({
      activitySchedule: [
        { mode: "classFocus", endsAt: NOW + 3000, activityId: act("whatever") },
      ],
      sessionActivityId: undefined,
      sessionStartedAt: 7,
      unitDurationMinutes: null,
      now: NOW,
    });
    expect(result).toEqual({
      unitEndsAt: NOW + 3000,
      sessionStartedAt: 7,
      unitDurationMinutes: null,
    });
  });
});

describe("enrichPriorActivities", () => {
  const a1: ActivityLite = { title: "Build a bridge", kind: "online", description: "d1" };
  const a2: ActivityLite = { title: "Field trip", kind: "offline" };

  test("empty → null", () => {
    expect(
      enrichPriorActivities({
        completions: [],
        activityById: new Map(),
        lessonById: new Map(),
      }),
    ).toBeNull();
  });

  test("sorts oldest-first, resolves lesson titles, defaults nulls", () => {
    const result = enrichPriorActivities({
      completions: [
        { activityId: act("a2"), lessonId: les("l1"), completedAt: 300, note: "great" },
        { activityId: act("a1"), completedAt: 100 }, // no lesson → scholar task
      ],
      activityById: new Map([
        [act("a1"), a1],
        [act("a2"), a2],
      ]),
      lessonById: new Map([[les("l1"), { title: "Lesson One" }]]),
    });
    expect(result).toEqual([
      {
        title: "Build a bridge",
        kind: "online",
        description: "d1",
        lessonTitle: "(scholar task)",
        completedAt: 100,
        note: null,
      },
      {
        title: "Field trip",
        kind: "offline",
        description: null,
        lessonTitle: "Lesson One",
        completedAt: 300,
        note: "great",
      },
    ]);
  });

  test("drops completions whose activity can't be resolved", () => {
    const result = enrichPriorActivities({
      completions: [
        { activityId: act("missing"), completedAt: 50 },
        { activityId: act("a1"), completedAt: 60 },
      ],
      activityById: new Map([[act("a1"), a1]]),
      lessonById: new Map(),
    });
    expect(result).toHaveLength(1);
    expect(result?.[0].title).toBe("Build a bridge");
  });
});
