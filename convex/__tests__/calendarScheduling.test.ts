import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import { liveActivityAt } from "../assignments";
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
    });
    const live = await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      return a!.activitySchedule!.find((e) => e.activityId === activityId)!;
    });
    expect(live.setAt).toBeDefined();
    expect(live.scholarIds).toEqual([scholarA]);

    // "Postpone to tomorrow" — must NOT hide it from scholars (same
    // semantics as applyRescheduleActivity), and must not widen targeting.
    const newStart = Date.now() + 24 * HOUR;
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      startsAt: newStart,
    });
    const after = await t.run(async (ctx) => {
      const a = await ctx.db.get(assignmentId);
      return a!.activitySchedule!.find((e) => e.activityId === activityId)!;
    });
    expect(after.setAt).toBe(live.setAt);
    expect(after.startsAt).toBe(newStart);
    expect(after.scholarIds).toEqual([scholarA]);
    // Still live → no activation job was scheduled for it.
    expect(after.scheduledFnId).toBeUndefined();
  });
});
