import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { orderedOnlineActivitiesForUnit } from "../lib/scholarReads";

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
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
    }),
  );
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

/** Unit + one lesson + one online activity, owned by `teacherId`. */
async function seedUnit(
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

describe("activity delete — execution guard", () => {
  test("blocks delete when a real scholar session exists", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asTeacher = await withUser(t, teacher);
    const { unitId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        title: "Real work",
        isArchived: false,
        unitId,
        activityId,
      }),
    );

    await expect(
      asTeacher.mutation(api.activities.remove, { id: activityId }),
    ).rejects.toThrow(/scholars have worked on this activity/i);

    // Nothing was deleted.
    const still = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(still).not.toBeNull();
  });

  test("blocks delete when a completion exists", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asTeacher = await withUser(t, teacher);
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId,
        lessonId,
        unitId,
        completedAt: Date.now(),
      }),
    );

    await expect(
      asTeacher.mutation(api.activities.remove, { id: activityId }),
    ).rejects.toThrow(/scholars have worked on this activity/i);
  });

  test("test-drive-only sessions do NOT block delete", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, activityId } = await seedUnit(t, teacher);

    // The teacher's own throwaway rehearsal — not real scholar work.
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: teacher,
        title: "Rehearsal",
        isArchived: false,
        unitId,
        activityId,
        isTestDrive: true,
      }),
    );

    await asTeacher.mutation(api.activities.remove, { id: activityId });
    const gone = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(gone).toBeNull();
  });

  test("units.remove is unchanged by the guard (skipWorkGuard)", async () => {
    // A completion on an activity would trip the per-activity guard, but the
    // unit-level cascade skips it (units.remove owns its own semantics — its
    // Guard 2 only blocks on real sessions, not completions).
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asTeacher = await withUser(t, teacher);
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId,
        lessonId,
        unitId,
        completedAt: Date.now(),
      }),
    );

    await asTeacher.mutation(api.units.remove, { id: unitId });

    const after = await t.run(async (ctx) => ({
      unit: await ctx.db.get(unitId),
      lesson: await ctx.db.get(lessonId),
      activity: await ctx.db.get(activityId),
    }));
    expect(after.unit).toBeNull();
    expect(after.lesson).toBeNull();
    expect(after.activity).toBeNull();
  });

  test("lessons.remove is blocked when a child activity has scholar work", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asTeacher = await withUser(t, teacher);
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        title: "Real work",
        isArchived: false,
        unitId,
        activityId,
      }),
    );

    await expect(
      asTeacher.mutation(api.lessons.remove, { id: lessonId }),
    ).rejects.toThrow(/scholars have worked on "Test Activity"/i);

    // Nothing was deleted — the mutation rolled back atomically.
    const after = await t.run(async (ctx) => ({
      lesson: await ctx.db.get(lessonId),
      activity: await ctx.db.get(activityId),
    }));
    expect(after.lesson).not.toBeNull();
    expect(after.activity).not.toBeNull();
  });

  test("the bot's deleteLessonInternal is blocked the same way", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId,
        lessonId,
        unitId,
        completedAt: Date.now(),
      }),
    );

    await expect(
      t.mutation(internal.curriculumAssistant.deleteLessonInternal, {
        lessonId,
      }),
    ).rejects.toThrow(/scholars have worked on "Test Activity"/i);

    const still = await t.run(async (ctx) => ctx.db.get(lessonId));
    expect(still).not.toBeNull();
  });

  test("a deliverable blocks delete even when its session row is gone", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asTeacher = await withUser(t, teacher);
    const { unitId, activityId } = await seedUnit(t, teacher);

    // Deliverable whose session no longer resolves — the guard can't prove it
    // was a test drive, so it must conservatively count as scholar work. This
    // also pins the deliverable branch in isolation (no session, no completion).
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        title: "Real work",
        isArchived: false,
        unitId,
        activityId,
      });
      await ctx.db.insert("deliverables", {
        activityId,
        scholarId: scholar,
        sessionId,
        submittedAt: Date.now(),
      });
      await ctx.db.delete(sessionId);
    });

    await expect(
      asTeacher.mutation(api.activities.remove, { id: activityId }),
    ).rejects.toThrow(/scholars have worked on this activity/i);
  });

  test("a test-drive-only deliverable does NOT block delete", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: teacher,
        title: "Rehearsal",
        isArchived: false,
        unitId,
        activityId,
        isTestDrive: true,
      });
      // A deliverable submitted inside the teacher's own rehearsal.
      await ctx.db.insert("deliverables", {
        activityId,
        scholarId: teacher,
        sessionId,
        submittedAt: Date.now(),
      });
    });

    await asTeacher.mutation(api.activities.remove, { id: activityId });
    const gone = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(gone).toBeNull();
  });

  test("lessons.remove with only test-drive work still deletes", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: teacher,
        title: "Rehearsal",
        isArchived: false,
        unitId,
        activityId,
        isTestDrive: true,
      }),
    );

    await asTeacher.mutation(api.lessons.remove, { id: lessonId });
    const after = await t.run(async (ctx) => ({
      lesson: await ctx.db.get(lessonId),
      activity: await ctx.db.get(activityId),
    }));
    expect(after.lesson).toBeNull();
    expect(after.activity).toBeNull();
  });
});

describe("activity archive", () => {
  test("setArchived round-trips", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { activityId } = await seedUnit(t, teacher);

    await asTeacher.mutation(api.activities.setArchived, {
      id: activityId,
      archived: true,
    });
    let doc = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(doc?.archivedAt).toBeTypeOf("number");

    await asTeacher.mutation(api.activities.setArchived, {
      id: activityId,
      archived: false,
    });
    doc = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(doc?.archivedAt).toBeUndefined();
  });

  test("archived activity is hidden from scholar reads but still resolves for an existing session", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);
    const asScholar = await withUser(t, await seedUser(t, "scholar", { username: "s1" }));

    await asTeacher.mutation(api.activities.setArchived, {
      id: activityId,
      archived: true,
    });

    // Scholar-facing lesson read: archived activity is gone.
    const lessonList = await asScholar.query(
      api.activities.listByLessonPublic,
      { lessonId },
    );
    expect(lessonList.map((a) => String(a._id))).not.toContain(
      String(activityId),
    );

    // orderedOnlineActivitiesForUnit (the scholar ordering/gating choke point):
    // archived activity is excluded.
    const ordered = await t.run(async (ctx) =>
      orderedOnlineActivitiesForUnit(ctx, unitId),
    );
    expect(ordered.map((o) => String(o.activity._id))).not.toContain(
      String(activityId),
    );

    // But an existing session's activity still resolves by id (getPublic).
    const resolved = await asScholar.query(api.activities.getPublic, {
      id: activityId,
    });
    expect(resolved).not.toBeNull();
    expect(String(resolved?._id)).toBe(String(activityId));
  });

  test("archived activity is not offered by the unit picker query (listByUnitPublic)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, activityId } = await seedUnit(t, teacher);

    await asTeacher.mutation(api.activities.setArchived, {
      id: activityId,
      archived: true,
    });

    // Default (picker / scholar surfaces): archived excluded.
    const picker = await asTeacher.query(api.activities.listByUnitPublic, {
      unitId,
    });
    expect(picker.map((a) => String(a._id))).not.toContain(String(activityId));

    // Design outline (includeArchived): archived present, with archivedAt.
    const outline = await asTeacher.query(api.activities.listByUnitPublic, {
      unitId,
      includeArchived: true,
    });
    const row = outline.find((a) => String(a._id) === String(activityId));
    expect(row).toBeDefined();
    expect(row?.archivedAt).toBeTypeOf("number");
  });

  test("structure counts exclude archived activities", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, activityId } = await seedUnit(t, teacher);

    await asTeacher.mutation(api.activities.setArchived, {
      id: activityId,
      archived: true,
    });

    const counts = await asTeacher.query(api.units.structureCounts, {
      id: unitId,
    });
    expect(counts).toMatchObject({ lessonCount: 1, activityCount: 0 });
  });

  test("lesson and unit maturity rollups ignore archived rehearsal evidence", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);

    await t.run(async (ctx) => {
      await ctx.db.insert("curriculumVariants", {
        activityId,
        generation: 0,
        origin: "baseline",
        aggregateScores: { fitness: 4.2 },
        status: "candidate",
      });
      await ctx.db.patch(activityId, { archivedAt: Date.now() });
    });

    const statuses = await asTeacher.query(
      api.unitMaturity.getNodeStatuses,
      { unitId },
    );
    const lessonRehearsal = statuses.readiness.lessons[
      String(lessonId)
    ].steps.find((step) => step.id === "scholarBotRehearsal");
    const unitRehearsal = statuses.readiness.unit.steps.find(
      (step) => step.id === "scholarBotRehearsal",
    );

    // The archived node retains its own harmless status, but contributes to
    // neither the lesson dot nor the lesson/unit rehearsal denominators.
    expect(statuses.activities[String(activityId)]).toBe("inProgress");
    expect(statuses.lessons[String(lessonId)]).toBe("built");
    expect(lessonRehearsal).toMatchObject({
      state: "na",
      detail: "No online activities",
    });
    expect(unitRehearsal).toMatchObject({
      state: "na",
      detail: "No online activities",
    });
  });
});
