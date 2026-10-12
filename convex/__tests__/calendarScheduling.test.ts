import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import { liveActivityAt } from "../assignments";
import { plannedReleaseArgs } from "../../shared/plannedRelease";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" | "curriculum_designer" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    // defaultMode "classFocus" so create() does NOT auto-add it to the
    // schedule — we want a clean slate to schedule it ourselves.
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "...",
      order: 0,
      defaultMode: "classFocus",
    });
    return { unitId, lessonId, activityId };
  });
}

const HOUR = 3_600_000;

describe("calendar scheduling (planned vs live)", () => {
  test("a future scheduleActivity is PLANNED — teacher sees it, scholars don't", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt: Date.now() + HOUR,
    });

    // Teacher's agenda shows it, marked planned, not yet live (setAt null).
    const agenda = await asTeacher.query(api.assignments.scheduleForTeacher, {});
    expect(agenda).toHaveLength(1);
    expect(agenda[0].state).toBe("planned");
    expect(agenda[0].setAt).toBeNull();
    expect(agenda[0].startsAt).not.toBeNull();

    // Scholar does NOT see a planned entry as class focus.
    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(0);
  });

  test("SAFETY: a past startsAt does NOT auto-push to scholars", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    // Fat-finger: schedule for YESTERDAY.
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt: Date.now() - 24 * HOUR,
    });

    // Still planned, still invisible to the scholar.
    const agenda = await asTeacher.query(api.assignments.scheduleForTeacher, {});
    expect(agenda[0].state).toBe("planned");
    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(0);
  });

  test("pushActivity (Start now) goes live — scholar sees it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    const agenda = await asTeacher.query(api.assignments.scheduleForTeacher, {});
    expect(agenda[0].state).toBe("live");
    expect(agenda[0].setAt).not.toBeNull();

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(1);
    expect(String(focus[0].activityId)).toBe(String(activityId));
  });

  test("targeted class focus only locks the selected rostered scholar", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const excludedScholarId = await seedUser(t, "scholar", {
      username: "excluded",
    });
    const targetedScholarId = await seedUser(t, "scholar", {
      username: "targeted",
    });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asExcludedScholar = await withUser(t, excludedScholarId);
    const asTargetedScholar = await withUser(t, targetedScholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [excludedScholarId, targetedScholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      scholarIds: [targetedScholarId],
    });

    expect(
      await asExcludedScholar.query(
        api.assignments.currentClassFocusForMe,
        {},
      ),
    ).toHaveLength(0);
    expect(
      await asTargetedScholar.query(
        api.assignments.currentClassFocusForMe,
        {},
      ),
    ).toHaveLength(1);
  });

  test("activateScheduledActivity flips a planned entry live", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    // Plan for the near past so activation's re-validation (startsAt <= now)
    // passes when we invoke it directly.
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt: Date.now() + HOUR,
    });
    // Move startsAt into the past, then fire activation directly.
    await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      const schedule = (a!.activitySchedule ?? []).map((e) => ({
        ...e,
        startsAt: Date.now() - 1000,
      }));
      await ctx.db.patch(assignmentId, { activitySchedule: schedule });
    });
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.activateScheduledActivity, {
        assignmentId,
        activityId,
      }),
    );

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(1);
  });

  test("activateScheduledActivity expires a planned focus whose end already passed", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt: Date.now() + HOUR,
      endsAt: Date.now() + 2 * HOUR,
    });
    await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      const schedule = (a!.activitySchedule ?? []).map((entry) => ({
        ...entry,
        startsAt: Date.now() - 2_000,
        endsAt: Date.now() - 1_000,
      }));
      await ctx.db.patch(assignmentId, { activitySchedule: schedule });
    });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.activateScheduledActivity, {
        assignmentId,
        activityId,
      }),
    );

    const assignment = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(assignment?.activitySchedule).toEqual([]);
    const mirror = await t.run(async (ctx) =>
      ctx.db
        .query("pushes")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
        .first(),
    );
    expect(mirror?.clearedReason).toBe("expired");
    expect(mirror?.clearedAt).toBeTypeOf("number");
  });

  test("pushActivity refuses a class focus whose end time is already past", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const pastEnd = Date.now() - HOUR;

    await expect(
      asTeacher.mutation(api.assignments.pushActivity, {
        assignmentId,
        activityId,
        mode: "classFocus",
        endsAt: pastEnd,
      }),
    ).rejects.toThrow(new Date(pastEnd).toISOString());

    const assignment = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(assignment?.activitySchedule).toEqual([]);
  });

  test("clearActivity removes a planned entry", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt: Date.now() + HOUR,
    });
    await asTeacher.mutation(api.assignments.clearActivity, {
      assignmentId,
      activityId,
    });

    const agenda = await asTeacher.query(api.assignments.scheduleForTeacher, {});
    expect(agenda).toHaveLength(0);
  });

  test("completion roll-up marks a live entry done", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });
    // The sole scholar completes the activity under this assignment.
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        lessonId,
        unitId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );

    const agenda = await asTeacher.query(api.assignments.scheduleForTeacher, {});
    expect(agenda[0].completedCount).toBe(1);
    expect(agenda[0].scholarCount).toBe(1);
    expect(agenda[0].state).toBe("done");
  });

  test("liveActivityAt: the activity whose live window contains the timestamp", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const targetedScholarId = await seedUser(t, "scholar", {
      username: "targeted",
    });
    const outsiderId = await seedUser(t, "scholar", { username: "outsider" });
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    // A second activity in the same unit.
    const activity2 = await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Activity 2",
        kind: "online",
        systemPrompt: "...",
        order: 1,
        defaultMode: "classFocus",
      }),
    );
    const asTeacher = await withUser(t, teacherId);
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId, targetedScholarId],
    });

    const base = Date.now();
    // Activity 1 live [base, base+HOUR); Activity 2 live [base+2h, open).
    await t.run(async (ctx) => {
      await ctx.db.patch(assignmentId, {
        activitySchedule: [
          {
            activityId,
            mode: "classFocus" as const,
            setAt: base,
            startsAt: base,
            endsAt: base + HOUR,
          },
          {
            activityId: activity2,
            mode: "homework" as const,
            setAt: base + 2 * HOUR,
            startsAt: base + 2 * HOUR,
            scholarIds: [targetedScholarId],
          },
        ],
      });
    });

    const at = (ts: number, sid = scholarId) =>
      t.run(async (ctx) =>
        liveActivityAt(ctx, assignmentId, sid, ts),
      );

    // Inside activity 1's window.
    expect(String(await at(base + 30 * 60_000))).toBe(String(activityId));
    // After activity 1 ended, before activity 2 started — gap, no match.
    expect(await at(base + 90 * 60_000)).toBeNull();
    // Activity 2 targets only the other rostered scholar.
    expect(await at(base + 3 * HOUR)).toBeNull();
    expect(String(await at(base + 3 * HOUR, targetedScholarId))).toBe(
      String(activity2),
    );
    // Before anything went live.
    expect(await at(base - 1000)).toBeNull();
    // A scholar not on the roster never matches.
    expect(await at(base + 30 * 60_000, outsiderId)).toBeNull();
  });

  test("scheduleForTeacher 'View as' filter — by assignment roster intersection", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", { username: "kai" });
    const lani = await seedUser(t, "scholar", { username: "lani" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    // Assignment targets only Kai.
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [kai],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    const all = await asTeacher.query(api.assignments.scheduleForTeacher, {});
    expect(all).toHaveLength(1);

    // View as Kai → included; view as Lani → excluded.
    const asKai = await asTeacher.query(api.assignments.scheduleForTeacher, {
      scholarIds: [kai],
    });
    expect(asKai).toHaveLength(1);
    const asLani = await asTeacher.query(api.assignments.scheduleForTeacher, {
      scholarIds: [lani],
    });
    expect(asLani).toHaveLength(0);
  });

  test("scheduleActivity + scheduleForTeacher are teacher-gated", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await expect(
      asScholar.mutation(api.assignments.scheduleActivity, {
        assignmentId,
        activityId,
        mode: "classFocus",
        startsAt: Date.now() + HOUR,
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.query(api.assignments.scheduleForTeacher, {}),
    ).rejects.toThrow();
  });
});

describe("re-scheduling an already-live entry (postpone semantics)", () => {
  test("rescheduling a planned class focus preserves its window duration", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const startsAt = Date.now() + 2 * HOUR;
    const endsAt = startsAt + HOUR;
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt,
      endsAt,
    });

    const movedStart = startsAt + 3 * HOUR;
    await asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId,
      activityId,
      startsAt: movedStart,
    });

    const assignment = await t.run(async (ctx) => ctx.db.get(assignmentId));
    const entry = assignment!.activitySchedule![0];
    expect(entry.startsAt).toBe(movedStart);
    expect(entry.endsAt).toBe(movedStart + HOUR);
  });

  test("scheduleActivity on a LIVE entry re-times it but keeps it live, subset intact", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarA = await seedUser(t, "scholar", { username: "kidA" });
    const scholarB = await seedUser(t, "scholar", { username: "kidB" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarA, scholarB],
    });
    // Push live to a one-scholar subset.
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      scholarIds: [scholarA],
      endsAt: Date.now() + HOUR,
    });
    const live = await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      return a!.activitySchedule!.find((e) => e.activityId === activityId)!;
    });
    expect(live.setAt).toBeDefined();
    expect(live.scholarIds).toEqual([scholarA]);
    expect(live.endsAt).toBeDefined();

    // "Postpone to tomorrow" — must NOT hide it from scholars (same
    // semantics as applyRescheduleActivity), and must not widen targeting.
    const newStart = Date.now() + 24 * HOUR;
    await asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId,
      activityId,
      startsAt: newStart,
    });
    const after = await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      return a!.activitySchedule!.find((e) => e.activityId === activityId)!;
    });
    expect(after.setAt).toBe(live.setAt);
    expect(after.startsAt).toBe(newStart);
    expect(after.scholarIds).toEqual([scholarA]);
    expect(after.endsAt).toBe(live.endsAt);
    // Still live → no activation job was scheduled for it.
    expect(after.scheduledFnId).toBeUndefined();
  });
});

test("assigning a unit does not invent a class-focus lifetime", async () => {
  const t = convexTest(schema, modules);
  const teacherId = await seedUser(t, "teacher");
  const scholarId = await seedUser(t, "scholar");
  const { unitId } = await seedUnitWithActivity(t, teacherId);
  const asTeacher = await withUser(t, teacherId);

  const assignmentId = await asTeacher.mutation(api.assignments.assignWork, {
    unitId,
    scholarIds: [scholarId],
    startsAt: Date.now() + HOUR,
    target: { kind: "unit" },
  });

  const assignment = await t.run(async (ctx) => ctx.db.get(assignmentId));
  expect(assignment?.activitySchedule?.[0].endsAt).toBeUndefined();
});

describe("the Run page's planned-vs-sent read", () => {
  async function seedUnitWithHomeworkActivity(
    t: ReturnType<typeof convexTest>,
    teacherId: Id<"users">,
  ) {
    return await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Homework Unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Homework Lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Tonight's reading",
        kind: "online",
        systemPrompt: "...",
        order: 0,
        defaultMode: "homework",
      });
      return { unitId, lessonId, activityId };
    });
  }

  test("assigning a unit lands homework PLANNED, and the header counts say so", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithHomeworkActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholarId],
      startsAt: Date.now() + 24 * HOUR,
      target: { kind: "unit" },
    });

    // The header eyebrow's inputs: nothing is live, one thing is planned.
    const run = await asTeacher.query(api.assignments.get, { assignmentId });
    expect(run!.homeworkCount).toBe(0);
    expect(run!.classFocusCount).toBe(0);
    expect(run!.plannedCount).toBe(1);
    expect(run!.sentCount).toBe(0);

    // The row's badge predicate comes from the same server call.
    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId,
    });
    const row = progress!.lessons[0].activities.find(
      (a) => String(a.activityId) === String(activityId),
    )!;
    expect(row.schedule).not.toBeNull();
    expect(row.schedule!.planned).toBe(true);
    expect(row.schedule!.dueAt).not.toBeNull();

    // And the scholar genuinely has no homework yet — the state the old Run
    // page hid behind an identical orange "homework" badge.
    expect(await asScholar.query(api.assignments.homeworkForMe, {})).toEqual([]);
  });

  test("Start now on a planned unit homework row sends it, keeping the due date", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithHomeworkActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholarId],
      startsAt: Date.now() + 24 * HOUR,
      target: { kind: "unit" },
    });
    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId,
    });
    const planned = progress!.lessons[0].activities[0].schedule!;

    // Exactly what the row's "Start now" sends (see shared/plannedRelease).
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      ...plannedReleaseArgs(planned, Date.now()),
    });

    const run = await asTeacher.query(api.assignments.get, { assignmentId });
    expect(run!.plannedCount).toBe(0);
    expect(run!.sentCount).toBe(1);
    expect(run!.homeworkCount).toBe(1);

    const homework = await asScholar.query(api.assignments.homeworkForMe, {});
    expect(homework).toHaveLength(1);
    const entry = await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      return a!.activitySchedule!.find((e) => e.activityId === activityId)!;
    });
    expect(entry.setAt).toBeDefined();
    expect(entry.dueAt).toBe(planned.dueAt);
  });

  test("releasing a planned entry keeps its targeting instead of widening it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const targetedScholarId = await seedUser(t, "scholar");
    const otherScholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithHomeworkActivity(
      t,
      teacherId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asOtherScholar = await withUser(t, otherScholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [targetedScholarId, otherScholarId],
      startsAt: Date.now() + 24 * HOUR,
      target: {
        kind: "activity",
        activityId,
        mode: "homework",
        scholarIds: [targetedScholarId],
      },
    });
    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId,
    });
    const planned = progress!.lessons[0].activities[0].schedule!;
    expect(planned.planned).toBe(true);
    expect(planned.scholarIds).toEqual([targetedScholarId]);

    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      ...plannedReleaseArgs(planned, Date.now()),
    });

    const entry = await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      return a!.activitySchedule!.find((e) => e.activityId === activityId)!;
    });
    expect(entry.scholarIds).toEqual([targetedScholarId]);
    expect(
      await asOtherScholar.query(api.assignments.homeworkForMe, {}),
    ).toEqual([]);
  });

  test("Start now drops a stale planned end and releases an unspecified focus", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const startsAt = Date.now() - 24 * HOUR;
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt,
      endsAt: startsAt + HOUR,
    });
    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId,
    });
    const planned = progress!.lessons[0].activities[0].schedule!;
    expect(planned.endsAt).toBeLessThan(Date.now());

    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      ...plannedReleaseArgs(planned, Date.now()),
    });

    expect(
      await asScholar.query(api.assignments.currentClassFocusForMe, {}),
    ).toHaveLength(1);
    const released = await t.run(async (ctx) => {
      const assignment = await ctx.db.get(assignmentId);
      return assignment!.activitySchedule!.find(
        (entry) => entry.activityId === activityId,
      )!;
    });
    expect(released.setAt).toBeDefined();
    expect(released.endsAt).toBeUndefined();
  });

  test("a same-day overrun focus stays live and reads as sent, not planned", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholarId],
      startsAt: Date.now(),
      target: { kind: "unit" },
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      endsAt: Date.now() + HOUR,
    });

    // The class ran over and `autoClearActivity` hasn't fired. The same-day
    // focus remains visible even though its blocking window closed.
    await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      await ctx.db.patch(assignmentId, {
        activitySchedule: a!.activitySchedule!.map((e) =>
          e.activityId === activityId ? { ...e, endsAt: Date.now() - 1 } : e,
        ),
      });
    });

    const run = await asTeacher.query(api.assignments.get, { assignmentId });
    // Teacher and scholar surfaces share the same showing predicate.
    expect(run!.classFocusCount).toBe(1);
    expect(run!.sentCount).toBe(1);
    expect(run!.plannedCount).toBe(0);
    expect(run!.sentCount + run!.plannedCount).toBe(
      run!.activitySchedule.length,
    );

    // And the row agrees: not planned, so it keeps the sent badge and its
    // Extend / Wrap controls rather than being restyled as never-sent.
    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId,
    });
    const row = progress!.lessons[0].activities.find(
      (a) => String(a.activityId) === String(activityId),
    )!;
    expect(row.schedule!.planned).toBe(false);
    expect(row.schedule!.setAt).not.toBeNull();

    const agenda = await asTeacher.query(
      api.assignments.scheduleForTeacher,
      {},
    );
    expect(agenda[0].state).toBe("live");
  });
});

describe("re-timing a live class focus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function pushThenRetime(endsAfterRetime: number) {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const start = Date.now();
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      endsAt: start + HOUR,
    });
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt: start,
      endsAt: start + endsAfterRetime,
    });
    const entry = async () =>
      t.run(async (ctx) =>
        (await ctx.db.get(assignmentId))!.activitySchedule!.find(
          (e) => e.activityId === activityId,
        ) ?? null,
      );
    return { t, start, entry };
  }

  test("moved later: the push's clear job follows the new end instead of dropping it", async () => {
    vi.useFakeTimers();
    const { t, start, entry } = await pushThenRetime(2 * HOUR);
    expect((await entry())!.setAt).toBeDefined();

    // The original job fires at the OLD end. The focus is still inside its
    // new window, so it must survive…
    vi.advanceTimersByTime(HOUR + 1);
    await t.finishInProgressScheduledFunctions();
    expect(Date.now()).toBeLessThan(start + 2 * HOUR);
    expect(await entry()).not.toBeNull();

    // …and still be cleared once the new end passes.
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(HOUR));
    expect(await entry()).toBeNull();
  });

  test("re-applying an unchanged live focus schedules no extra clear job", async () => {
    // The recurring re-materialization re-applies scheduleActivity to live
    // entries every tick; it must stay idempotent.
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const start = Date.now();
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      endsAt: start + HOUR,
    });
    const pendingJobs = () =>
      t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter(
          (job) => job.state.kind === "pending",
        ).length,
      );
    const before = await pendingJobs();
    for (let i = 0; i < 3; i++) {
      await asTeacher.mutation(api.assignments.scheduleActivity, {
        assignmentId,
        activityId,
        mode: "classFocus",
        startsAt: start,
        endsAt: start + HOUR,
      });
    }
    expect(await pendingJobs()).toBe(before);
  });

  test("moved earlier: the focus clears at the new end, not the old one", async () => {
    vi.useFakeTimers();
    const { t, start, entry } = await pushThenRetime(HOUR / 2);

    vi.advanceTimersByTime(HOUR / 2 + 1);
    await t.finishInProgressScheduledFunctions();
    expect(Date.now()).toBeLessThan(start + HOUR);
    expect(await entry()).toBeNull();
  });
});
