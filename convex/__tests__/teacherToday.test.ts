import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { STRUGGLING_MISS_THRESHOLD } from "../lib/practice/scheduler";
import { strugglingSkillCount } from "../teacherToday";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const NOW = Date.parse("2026-07-13T20:00:00.000Z"); // Monday, 10:00 HST
const DAY_MS = 24 * 60 * 60 * 1000;

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedWorld(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const homeInstitutionId = await ctx.db.insert("institutions", {
      name: "Home School",
      slug: "home-school",
      kind: "school",
      isPrimary: true,
    });
    const otherInstitutionId = await ctx.db.insert("institutions", {
      name: "Other School",
      slug: "other-school",
      kind: "school",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Test Teacher",
      username: "today-teacher",
      role: "teacher",
    });
    const homeScholarId = await ctx.db.insert("users", {
      name: "Home Scholar",
      username: "home-scholar",
      role: "scholar",
      institutionId: homeInstitutionId,
    });
    const otherScholarId = await ctx.db.insert("users", {
      name: "Other Scholar",
      username: "other-scholar",
      role: "scholar",
      institutionId: otherInstitutionId,
    });
    const unaffiliatedHomeScholarId = await ctx.db.insert("users", {
      name: "Unaffiliated Home Scholar",
      username: "unaffiliated-home-scholar",
      role: "scholar",
      institutionId: homeInstitutionId,
    });
    await ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId: homeInstitutionId,
    });
    await ctx.db.insert("memberships", {
      userId: homeScholarId,
      role: "scholar",
      institutionId: homeInstitutionId,
    });
    await ctx.db.insert("memberships", {
      userId: otherScholarId,
      role: "scholar",
      institutionId: otherInstitutionId,
    });
    await ctx.db.insert("memberships", {
      userId: unaffiliatedHomeScholarId,
      role: "scholar",
      institutionId: homeInstitutionId,
    });
    await ctx.db.insert("teacherAffinities", {
      teacherId,
      scholarIds: [homeScholarId],
      groupIds: [],
    });

    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Today Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Today Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Today Activity",
      kind: "online",
      systemPrompt: "Explore.",
      order: 0,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      title: "Today Assignment",
      scholarIds: [homeScholarId],
      startedAt: NOW - DAY_MS,
      activitySchedule: [
        {
          activityId,
          mode: "classFocus",
          setAt: NOW - 60 * 60 * 1000,
        },
      ],
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: homeScholarId,
      unitId,
      lessonId,
      activityId,
      assignmentId,
      title: "Today session",
      isArchived: false,
      lastMessageAt: NOW - 30 * 60 * 1000,
    });
    await ctx.db.insert("analyses", {
      sessionId,
      engagementScore: 0.35,
      onTaskScore: 0.4,
      concernFlags: ["Needs a fresh entry point"],
      summary: "The latest session has lost momentum.",
    });
    await ctx.db.insert("seeds", {
      scholarId: homeScholarId,
      origin: "ai",
      status: "pending",
      topic: "Tidal clocks",
      suggestionType: "extension",
      rationale: "A useful next connection.",
    });
    await ctx.db.insert("seeds", {
      scholarId: otherScholarId,
      origin: "ai",
      status: "pending",
      topic: "Outside scope",
      suggestionType: "extension",
      rationale: "Must stay outside this teacher's inbox.",
    });
    await ctx.db.insert("seeds", {
      scholarId: unaffiliatedHomeScholarId,
      origin: "ai",
      status: "pending",
      topic: "Still in institution scope",
      suggestionType: "extension",
      rationale: "Affinity should prioritize, not hide this row.",
    });
    await ctx.db.insert("deliverables", {
      activityId,
      scholarId: homeScholarId,
      sessionId,
      assignmentId,
      submittedAt: NOW - 20 * 60 * 1000,
      textContent: "Submitted work",
    });
    await ctx.db.insert("classDigests", {
      scope: "activity",
      assignmentId,
      activityId,
      status: "ready",
      generatedAt: NOW - 10 * 60 * 1000,
      headline: "The class found two distinct approaches.",
    });

    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Current term",
      startsAt: NOW - 30 * DAY_MS,
      endsAt: NOW + 30 * DAY_MS,
      status: "open",
      institutionId: homeInstitutionId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      name: "Home Pod",
      scholarIds: [homeScholarId],
    });
    const blockId = await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "morning",
      label: "Morning block",
      startLocal: "09:00",
      endLocal: "10:30",
      weekdays: [1],
      order: 0,
      kind: "class",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId,
      groupId,
      weekday: 1,
      blockId,
      subject: "Inquiry",
      teacherId,
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    await ctx.db.insert("practiceAttempts", {
      scholarId: homeScholarId,
      nodeKey: "adding",
      correct: true,
      domain: "whole-number-arithmetic",
      lane: "frontier",
      createdAt: NOW - 5 * 60 * 1000,
    });
    await ctx.db.insert("practiceMastery", {
      scholarId: homeScholarId,
      skillKey: "adding",
      domain: "whole-number-arithmetic",
      repetition: 4,
      halfLifeDays: 2,
      frontier: true,
      source: "practice",
      updatedAt: NOW,
      frontierAdvancedAt: NOW - 4 * 60 * 1000,
    });
    for (let index = 0; index < 3; index += 1) {
      await ctx.db.insert("practiceErrorEvents", {
        scholarId: homeScholarId,
        nodeKey: "regrouping",
        domain: "whole-number-arithmetic",
        pattern: "DROPPED_CARRY",
        itemId: `error-${index}`,
        createdAt: NOW - (3 - index) * 60 * 1000,
      });
    }

    return {
      teacherId,
      homeScholarId,
      otherScholarId,
      unaffiliatedHomeScholarId,
      assignmentId,
      activityId,
    };
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("teacherToday struggling-skill read", () => {
  test("uses the bounded miss-streak index instead of collecting a scholar's mastery rows", async () => {
    const collect = vi.fn().mockResolvedValue([
      { missStreak: STRUGGLING_MISS_THRESHOLD },
      { missStreak: STRUGGLING_MISS_THRESHOLD + 1 },
    ]);
    const gte = vi.fn();
    const eq = vi.fn(() => ({ gte }));
    const withIndex = vi.fn(
      (
        _index: string,
        range: (query: { eq: typeof eq }) => { gte: typeof gte },
      ) => {
        range({ eq });
        return { collect };
      },
    );
    const query = vi.fn(() => ({ withIndex }));
    const ctx = { db: { query } } as unknown as QueryCtx;
    const scholarId = "scholar-id" as Id<"users">;

    await expect(strugglingSkillCount(ctx, scholarId)).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith("practiceMastery");
    expect(withIndex).toHaveBeenCalledWith(
      "by_scholar_miss_streak",
      expect.any(Function),
    );
    expect(eq).toHaveBeenCalledWith("scholarId", scholarId);
    expect(gte).toHaveBeenCalledWith(
      "missStreak",
      STRUGGLING_MISS_THRESHOLD,
    );
    expect(collect).toHaveBeenCalledOnce();
  });
});

describe("teacherToday.todayForTeacher", () => {
  test("returns the four composed lanes on seeded data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const asTeacher = await withUser(t, world.teacherId);

    const result = await asTeacher.query(
      api.teacherToday.todayForTeacher,
      { institutionScope: "home-school" },
    );

    expect(new Set(Object.keys(result))).toEqual(
      new Set([
        "needsALook",
        "waitingOnYou",
        "todaysPlan",
        "overnight",
        "overnightTitle",
        "closure",
        "birthdays",
        "prepGroups",
      ]),
    );
    // A normal seeded day is not a school closure.
    expect(result.closure).toBeNull();
    expect(result.needsALook[0]).toEqual(
      expect.objectContaining({
        scholarId: world.homeScholarId,
        name: "Home Scholar",
        reason: "The latest session has lost momentum.",
      }),
    );
    expect(new Set(result.waitingOnYou.map((row) => row.kind))).toEqual(
      new Set(["seeds", "deliverables", "digest"]),
    );
    expect(result.todaysPlan[0]).toEqual(
      expect.objectContaining({
        assignmentId: world.assignmentId,
        activityId: world.activityId,
        startedCount: 1,
        totalCount: 1,
        verb: "Open",
      }),
    );
    expect(new Set(result.overnight.map((row) => row.kind))).toEqual(
      new Set(["practice", "frontier", "misconceptions"]),
    );
    // NOW is Monday 10:00 HST — mid-day, so the rail is "So far today", not a
    // hardcoded "Overnight", and each row's phrase is derived from its real age
    // (the seeded events are minutes old → "just now"), never asserted. This is
    // the F1 regression guard: no row may claim "since yesterday" / "overnight".
    expect(result.overnightTitle).toBe("So far today");
    const practiceRow = result.overnight.find((row) => row.kind === "practice");
    expect(practiceRow?.label).toContain("just now");
    for (const row of result.overnight) {
      expect(row.label).not.toContain("since yesterday");
      expect(row.label).not.toContain("overnight");
    }
  });

  test("surfaces a struggling scholar in Needs a look", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const asTeacher = await withUser(t, world.teacherId);

    // Baseline: the unaffiliated home scholar is in the institution lens but
    // has nothing flagging them, so they are not in Needs a look.
    const before = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });
    expect(
      before.needsALook.some(
        (row) => row.scholarId === world.unaffiliatedHomeScholarId,
      ),
    ).toBe(false);

    // A non-struggling mastery row does not turn an otherwise quiet scholar
    // into a Needs a look row.
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: world.unaffiliatedHomeScholarId,
        skillKey: "subtraction",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 2,
        frontier: false,
        source: "practice",
        missStreak: STRUGGLING_MISS_THRESHOLD - 1,
        updatedAt: NOW,
      });
    });
    const afterNonStruggling = await asTeacher.query(
      api.teacherToday.todayForTeacher,
      { institutionScope: "home-school" },
    );
    expect(
      afterNonStruggling.needsALook.some(
        (row) => row.scholarId === world.unaffiliatedHomeScholarId,
      ),
    ).toBe(false);

    // Two recent misses on a skill (missStreak >= threshold) → struggling.
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: world.unaffiliatedHomeScholarId,
        skillKey: "regrouping",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 2,
        frontier: false,
        source: "practice",
        missStreak: STRUGGLING_MISS_THRESHOLD,
        updatedAt: NOW,
      });
    });
    const after = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });
    const row = after.needsALook.find(
      (r) => r.scholarId === world.unaffiliatedHomeScholarId,
    );
    expect(row).toBeDefined();
    expect(row?.reason).toBe("Needs review on 1 skill.");

    // A second struggling skill pluralizes the count.
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: world.unaffiliatedHomeScholarId,
        skillKey: "place-value",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 2,
        frontier: false,
        source: "practice",
        missStreak: STRUGGLING_MISS_THRESHOLD + 1,
        updatedAt: NOW,
      });
    });
    const afterTwo = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });
    expect(
      afterTwo.needsALook.find(
        (r) => r.scholarId === world.unaffiliatedHomeScholarId,
      )?.reason,
    ).toBe("Needs review on 2 skills.");
  });

  test("suppresses a stale narrative summary but keeps the live clauses", async () => {
    vi.useFakeTimers();
    // Seed the whole world 10 days in the past so the observer analysis (and
    // its present-tense summary) ages, then query at two later instants.
    vi.setSystemTime(NOW - 10 * DAY_MS);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: world.homeScholarId,
        skillKey: "regrouping",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 2,
        frontier: false,
        source: "practice",
        missStreak: STRUGGLING_MISS_THRESHOLD,
        updatedAt: NOW,
      });
    });
    const asTeacher = await withUser(t, world.teacherId);

    // Two days after the analysis: young enough to narrate as current.
    vi.setSystemTime(NOW - 8 * DAY_MS);
    const whileFresh = await asTeacher.query(
      api.teacherToday.todayForTeacher,
      { institutionScope: "home-school" },
    );
    expect(
      whileFresh.needsALook.find(
        (row) => row.scholarId === world.homeScholarId,
      )?.reason,
    ).toContain("The latest session has lost momentum.");

    // Ten days after: the same summary would render as a false present-tense
    // claim, so the row falls back to the concern tags — while the struggle
    // clause (a genuinely live signal) survives. A fresh analysis whose summary
    // is EMPTY must not launder the old summary as current (the narrative ages
    // by latestSummaryAt, not lastAnalysisAt).
    vi.setSystemTime(NOW);
    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", world.homeScholarId))
        .first();
      if (!session) throw new Error("expected seeded session");
      await ctx.db.insert("analyses", {
        sessionId: session._id,
        engagementScore: 0.35,
        onTaskScore: 0.4,
        concernFlags: [],
        summary: "   ",
      });
    });
    const whileStale = await asTeacher.query(
      api.teacherToday.todayForTeacher,
      { institutionScope: "home-school" },
    );
    const staleRow = whileStale.needsALook.find(
      (row) => row.scholarId === world.homeScholarId,
    );
    expect(staleRow).toBeDefined();
    expect(staleRow?.reason).not.toContain(
      "The latest session has lost momentum.",
    );
    expect(staleRow?.reason).toContain("Needs a fresh entry point");
    expect(staleRow?.reason).toContain("Needs review on 1 skill.");
  });

  test("archived and offline sessions' analyses do not narrate the pulse", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const asTeacher = await withUser(t, world.teacherId);

    // Archive the session behind the seeded analysis; its summary (and its
    // concern flags) should stop feeding the pulse entirely.
    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", world.homeScholarId))
        .first();
      if (!session) throw new Error("expected seeded session");
      await ctx.db.patch(session._id, { isArchived: true });
    });

    const result = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });
    const row = result.needsALook.find(
      (r) => r.scholarId === world.homeScholarId,
    );
    expect(row?.reason ?? "").not.toContain(
      "The latest session has lost momentum.",
    );

    // An offline session's analysis is excluded the same way.
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: world.homeScholarId,
        title: "Offline capture",
        isArchived: false,
        isOffline: true,
        lastMessageAt: NOW - 5 * 60 * 1000,
      });
      await ctx.db.insert("analyses", {
        sessionId,
        engagementScore: 0.3,
        onTaskScore: 0.3,
        concernFlags: ["Offline concern"],
        summary: "Offline session summary.",
      });
    });
    const afterOffline = await asTeacher.query(
      api.teacherToday.todayForTeacher,
      { institutionScope: "home-school" },
    );
    const offlineRow = afterOffline.needsALook.find(
      (r) => r.scholarId === world.homeScholarId,
    );
    expect(offlineRow?.reason ?? "").not.toContain("Offline session summary.");
    expect(offlineRow?.reason ?? "").not.toContain("Offline concern");
  });

  test("appends the struggle clause to an existing Needs a look reason", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const asTeacher = await withUser(t, world.teacherId);

    // The home scholar is already flagged with a stalled-session reason.
    const before = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });
    const baseReason = before.needsALook.find(
      (row) => row.scholarId === world.homeScholarId,
    )?.reason;
    expect(baseReason).toBe("The latest session has lost momentum.");

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: world.homeScholarId,
        skillKey: "regrouping",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 2,
        frontier: false,
        source: "practice",
        missStreak: STRUGGLING_MISS_THRESHOLD,
        updatedAt: NOW,
      });
    });

    const after = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });
    expect(
      after.needsALook.find((row) => row.scholarId === world.homeScholarId)
        ?.reason,
    ).toBe("The latest session has lost momentum. Needs review on 1 skill.");
  });

  test("suppresses a ready digest whose analysis watermark trails current source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    await t.run(async (ctx) => {
      const session = await ctx.db.query("sessions").first();
      // A later observer analysis resolves the earlier concern on the same
      // session — the current scholar state is "resolved", not "cut off".
      await ctx.db.insert("analyses", {
        sessionId: session!._id,
        summary: "Leilani used a drawing to resolve the paradox.",
      });
      // A ready cohort digest generated BEFORE that analysis: its watermark
      // (far in the past) now trails current source, so its "cut off"
      // headline is contradicted and must be suppressed.
      await ctx.db.insert("classDigests", {
        scope: "cohort",
        assignmentId: world.assignmentId,
        status: "ready",
        generatedAt: NOW - 10 * 60 * 1000,
        headline: "Leilani mid-challenge — session cut off before resolution.",
        sourceSnapshot: {
          completedCount: 0,
          startedCount: 1,
          deliverableCount: 0,
          latestAnalysisAt: 1,
          latestMessageAt: 1,
        },
      });
    });

    const asTeacher = await withUser(t, world.teacherId);
    const result = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });

    // needsALook reflects the newest (resolved) observer read…
    expect(result.needsALook[0]?.reason).toBe(
      "Leilani used a drawing to resolve the paradox.",
    );
    // …and Today does NOT surface the contradicted "cut off" digest headline.
    expect(
      result.waitingOnYou.some((row) =>
        row.label.includes("session cut off before resolution"),
      ),
    ).toBe(false);
  });

  test("requires a teacher and stays inside the teacher's institution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const asTeacher = await withUser(t, world.teacherId);
    const asScholar = await withUser(t, world.homeScholarId);

    await expect(
      asScholar.query(api.teacherToday.todayForTeacher, {
        institutionScope: "home-school",
      }),
    ).rejects.toThrow();

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: world.otherScholarId,
        skillKey: "outside-scope",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 2,
        frontier: false,
        source: "practice",
        missStreak: STRUGGLING_MISS_THRESHOLD,
        updatedAt: NOW,
      });
    });

    const result = await asTeacher.query(
      api.teacherToday.todayForTeacher,
      { institutionScope: "other-school" },
    );
    expect(result.needsALook).toHaveLength(1);
    expect(result.needsALook[0].scholarId).toBe(world.homeScholarId);
    expect(
      result.waitingOnYou.some((row) => row.label.includes("Other Scholar")),
    ).toBe(false);
    expect(
      result.waitingOnYou.some((row) =>
        row.label.includes("Unaffiliated Home Scholar"),
      ),
    ).toBe(true);
    expect(
      result.waitingOnYou.some((row) => row.label.includes("Outside scope")),
    ).toBe(false);
    expect(
      result.needsALook.some((row) => row.scholarId === world.otherScholarId),
    ).toBe(false);
  });

  test("morning after the weekend anchors to Friday and recovers the work", async () => {
    // Monday 06:00 HST — before first bell, so the rail looks BACK across the
    // weekend to the last day the class met (Friday). Work that a fixed 20h
    // window would silently drop must resurface, under an honest title.
    const MON_6AM_HST = Date.parse("2026-07-13T16:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(MON_6AM_HST);
    const t = convexTest(schema, modules);
    const teacherId = await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Anchor School",
        slug: "anchor-school",
        kind: "school",
        isPrimary: true,
      });
      const teacher = await ctx.db.insert("users", {
        name: "Anchor Teacher",
        username: "anchor-teacher",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "Anchor Scholar",
        username: "anchor-scholar",
        role: "scholar",
        institutionId,
      });
      await ctx.db.insert("memberships", {
        userId: teacher,
        role: "teacher",
        institutionId,
      });
      await ctx.db.insert("memberships", {
        userId: scholar,
        role: "scholar",
        institutionId,
      });
      // Practice on Saturday ~10:00 HST — 44h before "now", i.e. OUTSIDE a
      // fixed 20h window, but squarely "over the weekend."
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "adding",
        correct: true,
        domain: "whole-number-arithmetic",
        lane: "frontier",
        createdAt: Date.parse("2026-07-11T20:00:00.000Z"),
      });
      return teacher;
    });

    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "anchor-school",
    });

    expect(result.overnightTitle).toBe("Over the weekend");
    const practiceRow = result.overnight.find((row) => row.kind === "practice");
    expect(practiceRow).toBeTruthy();
    expect(practiceRow?.label).toContain("over the weekend");
  });
});

describe("birthday surfacing", () => {
  test("todayForTeacher.birthdays includes a scoped scholar whose birthday is today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW); // 2026-07-13 10:00 HST → institution day 2026-07-13
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(world.homeScholarId, { dateOfBirth: "2015-07-13" });
      // Out-of-scope (Other School) scholar also has a birthday today — must
      // NOT leak into this teacher's home-school scope.
      await ctx.db.patch(world.otherScholarId, { dateOfBirth: "2016-07-13" });
    });
    const asTeacher = await withUser(t, world.teacherId);

    const result = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });

    expect(result.birthdays).toEqual([
      expect.objectContaining({
        scholarId: world.homeScholarId,
        name: "Home Scholar",
        nth: 11,
        nthLabel: "11th Birthday",
      }),
    ]);
  });

  test("todayForTeacher.birthdays is empty when nobody has a birthday today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(world.homeScholarId, { dateOfBirth: "2015-01-02" });
    });
    const asTeacher = await withUser(t, world.teacherId);

    const result = await asTeacher.query(api.teacherToday.todayForTeacher, {
      institutionScope: "home-school",
    });

    expect(result.birthdays).toEqual([]);
  });

  test("birthdaysForWeek keys a birthday to the matching weekday column", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    await t.run(async (ctx) => {
      // Monday-of-week is 2026-07-13; give the scholar a Wednesday (07-15) DOB.
      await ctx.db.patch(world.homeScholarId, { dateOfBirth: "2017-07-15" });
    });
    const asTeacher = await withUser(t, world.teacherId);

    const rows = await asTeacher.query(api.birthdays.birthdaysForWeek, {
      mondayKey: "2026-07-13",
      institutionScope: "home-school",
    });

    expect(rows).toEqual([
      expect.objectContaining({
        weekday: 3, // Wednesday
        scholarId: world.homeScholarId,
        nth: 9,
        nthLabel: "9th Birthday",
      }),
    ]);
  });
});
