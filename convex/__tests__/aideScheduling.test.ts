import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The teacher Aide's assignment-scheduling tools (convex/lib/aideTools.ts)
 * call these internal fns with a VERIFIED callerUserId. They re-do the
 * owner-only ownership check explicitly (the aide has no ctx.user) and
 * then share the exact scheduling core the teacher-UI mutations use.
 * These tests cover that gate + the core's planned/live/found semantics.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}${Math.random()}`,
      role,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher" || role === "school_admin") await grantInstitutionMembership(t, userId, institutionId, role);
  return userId;
}

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title = "Test Unit",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "...",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  unitId: Id<"units">,
  scholarIds: Id<"users">[],
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      startedAt: Date.now(),
      activitySchedule: [],
    }),
  );
}

const HOUR = 3_600_000;

describe("aide assignment scheduling", () => {
  test("assign_work creates once, then dedupes the same unit + exact roster", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);

    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideAssignWork, {
        callerUserId: teacher,
        unitId,
        scholarIds: [scholar],
        startsAt: Date.now() + 24 * HOUR,
        target: { kind: "unit" },
      }),
    );
    expect(first.created).toBe(true);

    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideAssignWork, {
        callerUserId: teacher,
        unitId,
        scholarIds: [scholar],
        startsAt: Date.now() + 48 * HOUR,
        target: { kind: "unit" },
      }),
    );
    expect(second.assignmentId).toBe(first.assignmentId);
    expect(second.created).toBe(false);

    const a = await t.run(async (ctx) => ctx.db.get(first.assignmentId));
    expect(a?.activitySchedule).toHaveLength(1);
    expect(a?.activitySchedule?.[0].activityId).toBe(activityId);
  });

  test("assign_work is teacher/admin-only when creating a new assignment", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId } = await seedUnitWithActivity(t, teacher);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideAssignWork, {
          callerUserId: scholar,
          unitId,
          scholarIds: [scholar],
          startsAt: Date.now() + HOUR,
          target: { kind: "unit" },
        }),
      ),
    ).rejects.toThrow(/teacher\/admin only/i);
  });

  test("owner can schedule a planned activity; it lands as planned", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);

    const startsAt = Date.now() + 24 * HOUR;
    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideScheduleActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "classFocus",
        startsAt,
      }),
    );
    expect(res.ok).toBe(true);

    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a?.activitySchedule).toHaveLength(1);
    const entry = a!.activitySchedule![0];
    expect(entry.activityId).toBe(activityId);
    expect(entry.startsAt).toBe(startsAt);
    // Planned, not live.
    expect(entry.setAt).toBeUndefined();
  });

  test("a non-owning teacher cannot touch the assignment", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, owner);
    const assignmentId = await seedAssignment(t, owner, unitId, [scholar]);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideScheduleActivity, {
          callerUserId: other,
          assignmentId,
          activityId,
          mode: "homework",
          startsAt: Date.now() + HOUR,
        }),
      ),
    ).rejects.toThrow(/not your assignment/i);
  });

  test("scheduling an activity from a different unit is rejected", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId } = await seedUnitWithActivity(t, teacher, "Unit A");
    // A second unit with its own activity — NOT part of the assignment's unit.
    const other = await seedUnitWithActivity(t, teacher, "Unit B");
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideScheduleActivity, {
          callerUserId: teacher,
          assignmentId,
          activityId: other.activityId,
          mode: "classFocus",
          startsAt: Date.now() + HOUR,
        }),
      ),
    ).rejects.toThrow(/not part of this assignment/i);
  });

  test("reschedule moves a planned entry; no-op (found=false) when absent", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);

    const start = Date.now() + 24 * HOUR;
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideScheduleActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "classFocus",
        startsAt: start,
      }),
    );

    // Push back by one week.
    const moved = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideRescheduleActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        startsAt: start + 7 * 24 * HOUR,
      }),
    );
    expect(moved.found).toBe(true);
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a!.activitySchedule![0].startsAt).toBe(start + 7 * 24 * HOUR);

    // Rescheduling a never-scheduled activity returns found=false.
    const second = await seedUnitWithActivity(t, teacher, "Other");
    const noop = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideRescheduleActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId: second.activityId,
        startsAt: start,
      }),
    );
    expect(noop.found).toBe(false);
  });

  test("clear removes an entry; removed=false when nothing to clear", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideScheduleActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "homework",
        startsAt: Date.now() + HOUR,
      }),
    );
    const cleared = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideClearActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId,
      }),
    );
    expect(cleared.removed).toBe(true);
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a!.activitySchedule).toHaveLength(0);

    const again = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideClearActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId,
      }),
    );
    expect(again.removed).toBe(false);
  });

  test("reads are scoped to the caller's own assignments", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideScheduleActivity, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "classFocus",
        startsAt: Date.now() + 2 * HOUR,
      }),
    );

    // Owner sees it.
    const mine = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideListAssignments, {
        callerUserId: teacher,
      }),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].roster).toHaveLength(1);

    const sched = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideScheduleForTeacher, {
        callerUserId: teacher,
      }),
    );
    expect(sched).toHaveLength(1);
    expect(sched[0].state).toBe("planned");

    // A different teacher sees none of it.
    const theirs = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideListAssignments, {
        callerUserId: other,
      }),
    );
    expect(theirs).toHaveLength(0);

    // get_assignment is owner-only (null for the non-owner).
    const denied = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideGetAssignment, {
        callerUserId: other,
        assignmentId,
      }),
    );
    expect(denied).toBeNull();

    // Owner gets full detail incl. the unit's available activities.
    const got = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideGetAssignment, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    expect(got).not.toBeNull();
    expect(got!.availableActivities.some((x) => x.activityId === activityId)).toBe(true);
    expect(got!.availableActivities.find((x) => x.activityId === activityId)?.alreadyScheduled).toBe(true);
  });
});

describe("aide push-now / roster / archive", () => {
  test("push_activity_now lands LIVE immediately (setAt stamped)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aidePushActivityNow, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "classFocus",
      }),
    );
    expect(res.ok).toBe(true);
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    const entry = a!.activitySchedule![0];
    // Live, not merely planned — this is the difference from scheduleActivity.
    expect(entry.setAt).toBeGreaterThan(0);
    expect(entry.startsAt).toBeGreaterThan(0);
  });

  test("push_activity_now rejects an activity from a different unit", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId } = await seedUnitWithActivity(t, teacher, "Unit A");
    const other = await seedUnitWithActivity(t, teacher, "Unit B");
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aidePushActivityNow, {
          callerUserId: teacher,
          assignmentId,
          activityId: other.activityId,
          mode: "classFocus",
        }),
      ),
    ).rejects.toThrow(/not part of this assignment/i);
  });

  test("set replaces the roster; add unions onto it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const s1 = await seedUser(t, "scholar");
    const s2 = await seedUser(t, "scholar");
    const s3 = await seedUser(t, "scholar");
    const { unitId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [s1]);

    // Replace [s1] with exactly [s2, s3].
    const setRes = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideSetScholars, {
        callerUserId: teacher,
        assignmentId,
        scholarIds: [s2, s3],
      }),
    );
    expect(setRes.rosterSize).toBe(2);
    let a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(new Set(a!.scholarIds.map(String))).toEqual(
      new Set([String(s2), String(s3)]),
    );

    // Add s1 back (and a duplicate s2 — deduped).
    const addRes = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideAddScholars, {
        callerUserId: teacher,
        assignmentId,
        scholarIds: [s1, s2],
      }),
    );
    expect(addRes.rosterSize).toBe(3);
    a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(new Set(a!.scholarIds.map(String))).toEqual(
      new Set([String(s1), String(s2), String(s3)]),
    );
  });

  test("roster ops + push are owner-gated", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, owner);
    const assignmentId = await seedAssignment(t, owner, unitId, [scholar]);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideSetScholars, {
          callerUserId: other,
          assignmentId,
          scholarIds: [scholar],
        }),
      ),
    ).rejects.toThrow(/not your assignment/i);
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aidePushActivityNow, {
          callerUserId: other,
          assignmentId,
          activityId,
          mode: "homework",
        }),
      ),
    ).rejects.toThrow(/not your assignment/i);
  });

  test("archive sets archivedAt + clears schedule; second call is alreadyArchived", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [scholar]);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aidePushActivityNow, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "classFocus",
      }),
    );

    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideArchiveAssignment, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    expect(first.alreadyArchived).toBe(false);
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(a!.archivedAt).toBeGreaterThan(0);
    expect(a!.activitySchedule).toHaveLength(0);

    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideArchiveAssignment, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    expect(second.alreadyArchived).toBe(true);
  });

  test("set/add scholars on an ARCHIVED assignment is rejected", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const s1 = await seedUser(t, "scholar");
    const s2 = await seedUser(t, "scholar");
    const { unitId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [s1]);

    // Archive it (clears the schedule, stamps archivedAt).
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideArchiveAssignment, {
        callerUserId: teacher,
        assignmentId,
      }),
    );

    // Editing the roster of a dead cohort must be refused — same guard as
    // schedule/push-now, so the aide/MCP can't quietly re-roster it.
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideSetScholars, {
          callerUserId: teacher,
          assignmentId,
          scholarIds: [s2],
        }),
      ),
    ).rejects.toThrow(/archived/i);
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideAddScholars, {
          callerUserId: teacher,
          assignmentId,
          scholarIds: [s2],
        }),
      ),
    ).rejects.toThrow(/archived/i);

    // Roster is unchanged — still just [s1].
    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(new Set(a!.scholarIds.map(String))).toEqual(new Set([String(s1)]));
  });
});

describe("aide assignment progress (insight read)", () => {
  test("rolls up started / completions / submissions per scholar + activity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const started = await seedUser(t, "scholar", { name: "Kai Started" });
    const notStarted = await seedUser(t, "scholar", { name: "Lani NotStarted" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [
      started,
      notStarted,
    ]);

    // Make it live so the activity shows even before any work lands.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aidePushActivityNow, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "classFocus",
      }),
    );

    // `started` has a project (started), a completion, and a "full" submission.
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: started,
        assignmentId,
        activityId,
        title: "Kai's project",
        isArchived: false,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "hi",
        flagged: false,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: started,
        activityId,
        assignmentId,
        completedAt: Date.now(),
      });
      await ctx.db.insert("deliverables", {
        activityId,
        scholarId: started,
        sessionId,
        assignmentId,
        submittedAt: Date.now(),
        overall: "full",
      });
    });

    const data = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideAssignmentProgress, {
        callerUserId: teacher,
        assignmentId,
      }),
    );
    expect(data).not.toBeNull();
    expect(data!.rosterSize).toBe(2);
    // Only the scholar with no project is "not started".
    expect(data!.notStartedScholarNames).toEqual(["Lani NotStarted"]);
    const kai = data!.roster.find((r) => r.name === "Kai Started")!;
    expect(kai.started).toBe(true);
    expect(kai.sessionId).toBe(sessionId);
    expect(kai.completedActivityCount).toBe(1);

    const act = data!.activities.find((x) => x.activityId === activityId)!;
    expect(act.state).toBe("live");
    expect(act.completedCount).toBe(1);
    expect(act.completedScholarNames).toEqual(["Kai Started"]);
    expect(act.notCompletedScholarNames).toEqual(["Lani NotStarted"]);
    expect(act.submissionCount).toBe(1);
    expect(act.verdicts).toEqual({ full: 1, half: 0, not: 0 });
  });

  test("progress is owner-only (null for a non-owner)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId } = await seedUnitWithActivity(t, owner);
    const assignmentId = await seedAssignment(t, owner, unitId, [scholar]);
    const denied = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideAssignmentProgress, {
        callerUserId: other,
        assignmentId,
      }),
    );
    expect(denied).toBeNull();
  });

  test("get_schedule carries the completion roll-up (completedCount/scholarCount)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const s1 = await seedUser(t, "scholar");
    const s2 = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);
    const assignmentId = await seedAssignment(t, teacher, unitId, [s1, s2]);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aidePushActivityNow, {
        callerUserId: teacher,
        assignmentId,
        activityId,
        mode: "classFocus",
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: s1,
        activityId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );

    const sched = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideScheduleForTeacher, {
        callerUserId: teacher,
      }),
    );
    expect(sched).toHaveLength(1);
    expect(sched[0].scholarCount).toBe(2);
    expect(sched[0].completedCount).toBe(1);
  });
});
