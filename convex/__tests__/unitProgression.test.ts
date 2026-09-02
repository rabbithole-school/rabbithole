import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedTwoActivityUnit(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const teacher = await ctx.db.insert("users", {
      name: "T",
      username: "t",
      role: "teacher",
    });
    const scholar = await ctx.db.insert("users", {
      name: "S",
      username: "s",
      role: "scholar",
    });
    const unit = await ctx.db.insert("units", {
      teacherId: teacher,
      title: "Flight Lab",
      isActive: true,
      authorScholarId: scholar,
    });
    const lesson = await ctx.db.insert("lessons", {
      unitId: unit,
      title: "L1",
      order: 0,
    });
    const first = await ctx.db.insert("activities", {
      lessonId: lesson,
      title: "Launch question",
      order: 0,
      kind: "online",
    });
    const second = await ctx.db.insert("activities", {
      lessonId: lesson,
      title: "Design test",
      order: 1,
      kind: "online",
    });
    return { teacher, scholar, unit, lesson, first, second };
  });
}

describe("multi-activity unit progression", () => {
  test("startUnit lands on the first incomplete online activity", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, lesson, first, second } = await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const { id } = await asScholar.mutation(api.sessions.startUnit, { unitId: unit });
    const session = await t.run(async (ctx) => ctx.db.get(id));

    expect(String(session?.activityId)).toBe(String(second));
    expect(String(session?.lessonId)).toBe(String(lesson));
  });

  test("startUnit initializes an auto-rubric canvas and criteria generation", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, first } = await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(first, {
        deliverable: {
          kind: "text",
          prompt: "Write your prediction.",
          mode: "auto",
          criteria: [],
        },
      });
    });

    const scholarClient = await asUser(t, scholar);
    const { id } = await scholarClient.mutation(api.sessions.startUnit, {
      unitId: unit,
    });
    const session = await t.run(async (ctx) => ctx.db.get(id));
    const artifacts = await t.run(async (ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", id))
        .collect(),
    );
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );

    expect(session?.deliverableCriteriaStatus).toBe("pending");
    expect(session?.sessionMode).toBeUndefined();
    expect(artifacts).toHaveLength(1);
    expect(
      scheduled.some((job) =>
        job.name.includes("deliverables:generateCriteriaForSession"),
      ),
    ).toBe(true);
  });

  test("unit-only session creation initializes the unit process", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit } = await seedTwoActivityUnit(t);
    const processId = await t.run(async (ctx) => {
      const processId = await ctx.db.insert("processes", {
        teacherId: teacher,
        title: "Notice and wonder",
        systemPrompt: "Observe before explaining.",
        steps: [{ key: "notice", title: "Notice" }],
        isActive: true,
      });
      await ctx.db.patch(unit, { processId });
      return processId;
    });

    const scholarClient = await asUser(t, scholar);
    const { id: sessionId } = await scholarClient.mutation(api.sessions.create, {
      unitId: unit,
    });
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );

    expect(
      scheduled.some(
        (job) =>
          job.name.includes("processState:initialize") &&
          String(job.args[0]?.sessionId) === String(sessionId) &&
          String(job.args[0]?.processId) === String(processId),
      ),
    ).toBe(true);
  });

  test("startUnit initializes the unit process when every activity is complete", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    const processId = await t.run(async (ctx) => {
      const processId = await ctx.db.insert("processes", {
        teacherId: teacher,
        title: "Notice and wonder",
        systemPrompt: "Observe before explaining.",
        steps: [{ key: "notice", title: "Notice" }],
        isActive: true,
      });
      await ctx.db.patch(unit, { processId });
      for (const activityId of [first, second]) {
        await ctx.db.insert("activityCompletions", {
          scholarId: scholar,
          activityId,
          lessonId: lesson,
          unitId: unit,
          completedAt: Date.now(),
        });
      }
      return processId;
    });

    const scholarClient = await asUser(t, scholar);
    const { id: sessionId } = await scholarClient.mutation(
      api.sessions.startUnit,
      { unitId: unit },
    );
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );

    expect(
      scheduled.some(
        (job) =>
          job.name.includes("processState:initialize") &&
          String(job.args[0]?.sessionId) === String(sessionId) &&
          String(job.args[0]?.processId) === String(processId),
      ),
    ).toBe(true);
  });

  test("submitting a deliberate no-rubric deliverable completes the activity", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, first } = await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(first, {
        deliverable: {
          kind: "text",
          prompt: "Send your note.",
          mode: "none",
          criteria: [],
        },
      });
    });
    const scholarClient = await asUser(t, scholar);
    const { id: sessionId } = await scholarClient.mutation(
      api.sessions.startUnit,
      { unitId: unit },
    );
    const artifact = await t.run(async (ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .first(),
    );
    expect(artifact).not.toBeNull();

    await expect(
      scholarClient.mutation(api.deliverables.submit, {
        activityId: first,
        sessionId,
        artifactId: artifact!._id,
      }),
    ).rejects.toThrow("Add something to your work before sending it");

    await t.run(async (ctx) => {
      await ctx.db.patch(artifact!._id, { content: "My finished note." });
    });
    await scholarClient.mutation(api.deliverables.submit, {
      activityId: first,
      sessionId,
      artifactId: artifact!._id,
    });

    const completion = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholar).eq("activityId", first),
        )
        .first(),
    );
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(completion?.sessionId).toBe(sessionId);
    expect(session?.activityCompletedAt).toBeDefined();
  });

  test("unassigned starts ignore assignment-scoped and legacy assignment completions", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "classFocus", setAt: Date.now() - 120_000 },
          { activityId: second, mode: "homework", setAt: Date.now() - 60_000 },
        ],
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        assignmentId: assignment,
        completedAt: Date.now(),
      });
      const assignedSession = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        sessionId: assignedSession,
        completedAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const { id } = await asScholar.mutation(api.sessions.startUnit, { unitId: unit });
    const unassignedCompletions = await asScholar.query(
      api.activityCompletions.listForScholarInUnit,
      { unitId: unit },
    );
    const session = await t.run(async (ctx) => ctx.db.get(id));

    expect(unassignedCompletions).toHaveLength(0);
    expect(String(session?.activityId)).toBe(String(first));
  });

  test("home plate continues a completed session to the next incomplete activity", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, lesson, first, second } = await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now() - 60_000,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
        sessionId,
      });
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => String(r.unitId) === String(unit));

    expect(row?.title).toBe("Design test");
    expect(String(row?.activityId)).toBe(String(second));
    expect(row?.sessionId).toBeNull();
    expect(row?.isContinuation).toBe(true);
  });

  test("home plate emits one continuation when multiple completed sessions share the same next activity", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, lesson, first, second } = await seedTwoActivityUnit(t);
    const third = await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        lessonId: lesson,
        title: "Reflect",
        order: 2,
        kind: "online",
      }),
    );
    await t.run(async (ctx) => {
      const firstSession = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now() - 120_000,
      });
      const secondSession = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: second,
        title: "Design test",
        isArchived: false,
        lastMessageAt: Date.now() - 60_000,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
        sessionId: firstSession,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: second,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
        sessionId: secondSession,
      });
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const unitRows = rows.filter((r) => String(r.unitId) === String(unit));

    expect(unitRows).toHaveLength(1);
    expect(unitRows[0]?.title).toBe("Reflect");
    expect(String(unitRows[0]?.activityId)).toBe(String(third));
    expect(unitRows[0]?.isContinuation).toBe(true);
  });

  test("home plate reuses an active next-activity session instead of also emitting a continuation", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, lesson, first, second } = await seedTwoActivityUnit(t);
    const secondSession = await t.run(async (ctx) => {
      const firstSession = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now() - 60_000,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
        sessionId: firstSession,
      });
      return await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: second,
        title: "Design test",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const unitRows = rows.filter((r) => String(r.unitId) === String(unit));
    const result = await asScholar.mutation(api.sessions.create, {
      unitId: unit,
      lessonId: lesson,
      activityId: second,
    });
    const sessionCount = await t.run(async (ctx) => {
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholar))
        .collect();
      return sessions.length;
    });

    expect(unitRows).toHaveLength(1);
    expect(String(unitRows[0]?.sessionId)).toBe(String(secondSession));
    expect(unitRows[0]?.isContinuation).toBe(false);
    expect(String(result.id)).toBe(String(secondSession));
    expect(sessionCount).toBe(2);
  });

  test("independent-study unit cards are suppressed when the plate has a continuation", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, lesson, first } = await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
        sessionId,
      });
    });

    const asScholar = await asUser(t, scholar);
    const units = await asScholar.query(api.units.myIndependentStudyUnits, {});
    const card = units.find((u) => String(u.unitId) === String(unit));

    expect(card?.hasStartedSession).toBe(true);
  });

  test("assignment sessions can inherit pre-branch bare completions when an assigned session exists", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    const sessionId = await t.run(async (ctx) => {
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now() - 60_000,
      });
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "classFocus", setAt: Date.now() - 120_000 },
          { activityId: second, mode: "homework", setAt: Date.now() - 60_000 },
        ],
      });
      return await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => String(r.unitId) === String(unit));

    expect(String(sessionId)).toBeTruthy();
    expect(row?.title).toBe("Design test");
    expect(String(row?.activityId)).toBe(String(second));
    expect(row?.isContinuation).toBe(true);
  });

  test("unmarkComplete can undo a legacy bare completion from a session", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, lesson, first } = await seedTwoActivityUnit(t);
    const { sessionId, completionId } = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        title: "Launch question",
        isArchived: false,
        activityCompletedAt: Date.now(),
      });
      const completionId = await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
      });
      return { sessionId, completionId };
    });

    const asScholar = await asUser(t, scholar);
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId: first,
      sessionId,
    });
    const migrated = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(migrated).toHaveLength(1);
    expect(String(migrated[0].sessionId)).toBe(String(sessionId));
    expect(migrated[0].assignmentId).toBeUndefined();

    await asScholar.mutation(api.activityCompletions.unmarkComplete, {
      activityId: first,
      sessionId,
    });
    const { session, completion } = await t.run(async (ctx) => ({
      session: await ctx.db.get(sessionId),
      completion: await ctx.db.get(completionId),
    }));

    expect(completion).toBeNull();
    expect(session?.activityCompletedAt).toBeUndefined();
  });

  test("markComplete rejects a session owned by a different scholar", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, lesson, first } = await seedTwoActivityUnit(t);
    const otherSession = await t.run(async (ctx) => {
      const otherScholar = await ctx.db.insert("users", {
        name: "Other",
        username: "other",
        role: "scholar",
      });
      return await ctx.db.insert("sessions", {
        userId: otherScholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        title: "Launch question",
        isArchived: false,
      });
    });

    const asScholar = await asUser(t, scholar);
    await expect(
      asScholar.mutation(api.activityCompletions.markComplete, {
        activityId: first,
        sessionId: otherSession,
      }),
    ).rejects.toThrow("Session does not belong to scholar");
  });

  test("session creation rejects forged assignment scope", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, first } = await seedTwoActivityUnit(t);
    const outsiderAssignment = await t.run(async (ctx) => {
      const outsider = await ctx.db.insert("users", {
        name: "Other",
        username: "other",
        role: "scholar",
      });
      return await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [outsider],
        startedAt: Date.now(),
        activitySchedule: [{ activityId: first, mode: "homework", setAt: Date.now() }],
      });
    });

    const asScholar = await asUser(t, scholar);
    await expect(
      asScholar.mutation(api.sessions.create, {
        unitId: unit,
        activityId: first,
        assignmentId: outsiderAssignment,
      }),
    ).rejects.toThrow("Assignment does not include scholar");
  });

  test("assignment continuations ignore completions from other runs of the same unit", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      const priorAssignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now() - 86_400_000,
      });
      const activeAssignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "classFocus", setAt: Date.now() - 120_000 },
          { activityId: second, mode: "homework", setAt: Date.now() - 60_000 },
        ],
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        assignmentId: priorAssignment,
        completedAt: Date.now() - 60_000,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: activeAssignment,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        assignmentId: activeAssignment,
        completedAt: Date.now(),
        sessionId,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: second,
        lessonId: lesson,
        unitId: unit,
        assignmentId: priorAssignment,
        completedAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = rows.find((r) => String(r.unitId) === String(unit));

    expect(row?.title).toBe("Design test");
    expect(String(row?.activityId)).toBe(String(second));
    expect(row?.unitCompletedCount).toBe(1);
    expect(row?.unitActivityCount).toBe(2);
  });

  test("assignment continuation rows use the next activity's live mode", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "classFocus", setAt: Date.now() - 120_000 },
          { activityId: second, mode: "homework", setAt: Date.now() - 60_000 },
        ],
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        assignmentId: assignment,
        sessionId,
        completedAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const unitRows = rows.filter((r) => String(r.unitId) === String(unit));

    expect(unitRows).toHaveLength(1);
    expect(String(unitRows[0]?.activityId)).toBe(String(second));
    expect(unitRows[0]?.origin).toBe("homework");
    expect(unitRows[0]?.isContinuation).toBe(true);
  });

  test("assignment continuations wait for the next activity to be live", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    const assignment = await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "classFocus", setAt: Date.now() - 60_000 },
          { activityId: second, mode: "homework", startsAt: Date.now() + 60_000 },
        ],
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        assignmentId: assignment,
        sessionId,
        completedAt: Date.now(),
      });
      return assignment;
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const visibleActivities = await asScholar.query(api.activities.listByUnitPublic, {
      unitId: unit,
      assignmentId: assignment,
    });

    expect(rows.filter((r) => String(r.unitId) === String(unit))).toHaveLength(0);
    expect(visibleActivities.map((a) => String(a._id))).not.toContain(
      String(second),
    );
    await expect(
      asScholar.mutation(api.sessions.create, {
        unitId: unit,
        activityId: second,
        assignmentId: assignment,
      }),
    ).rejects.toThrow("Assignment activity is not live");
  });

  test("assignment scoped reads and starts require a live scheduled activity", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, first } = await seedTwoActivityUnit(t);
    const assignment = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [],
      }),
    );

    const asScholar = await asUser(t, scholar);
    const visibleActivities = await asScholar.query(api.activities.listByUnitPublic, {
      unitId: unit,
      assignmentId: assignment,
    });

    expect(visibleActivities).toHaveLength(0);
    await expect(
      asScholar.mutation(api.sessions.create, {
        unitId: unit,
        activityId: first,
        assignmentId: assignment,
      }),
    ).rejects.toThrow("Assignment activity is not live");
  });

  test("session creation validates assignment scope before reusing an existing session", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first } = await seedTwoActivityUnit(t);
    const assignment = await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "homework", setAt: Date.now() - 60_000 },
        ],
      });
      await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
      });
      await ctx.db.patch(assignment, { activitySchedule: [] });
      return assignment;
    });

    const asScholar = await asUser(t, scholar);
    await expect(
      asScholar.mutation(api.sessions.create, {
        unitId: unit,
        activityId: first,
        assignmentId: assignment,
      }),
    ).rejects.toThrow("Assignment activity is not live");
  });

  test("assignment scoped reads and starts reject archived assignments", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, first } = await seedTwoActivityUnit(t);
    const assignment = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        archivedAt: Date.now(),
        activitySchedule: [],
      }),
    );

    const asScholar = await asUser(t, scholar);
    const visibleActivities = await asScholar.query(api.activities.listByUnitPublic, {
      unitId: unit,
      assignmentId: assignment,
    });

    expect(visibleActivities).toHaveLength(0);
    await expect(
      asScholar.mutation(api.sessions.create, {
        unitId: unit,
        activityId: first,
        assignmentId: assignment,
      }),
    ).rejects.toThrow("Assignment is archived");
  });

  test("home plate suppresses stale assigned sessions instead of showing them as independent work", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first } = await seedTwoActivityUnit(t);
    await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        archivedAt: Date.now(),
        activitySchedule: [],
      });
      await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});

    expect(rows.filter((r) => String(r.unitId) === String(unit))).toHaveLength(0);
  });

  test("assignment continuations count legacy session-scoped completions", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    const assignment = await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "classFocus", setAt: Date.now() - 120_000 },
          { activityId: second, mode: "homework", setAt: Date.now() - 60_000 },
        ],
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        sessionId,
        completedAt: Date.now(),
      });
      return assignment;
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const completions = await asScholar.query(
      api.activityCompletions.listForScholarInUnit,
      { unitId: unit, assignmentId: assignment },
    );
    const row = rows.find((r) => String(r.unitId) === String(unit));

    expect(completions.map((c) => String(c.activityId))).toContain(String(first));
    expect(row?.title).toBe("Design test");
    expect(String(row?.activityId)).toBe(String(second));
    expect(row?.unitCompletedCount).toBe(1);
  });

  test("assignment continuations count pre-branch bare rubric completions when an assigned session exists", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first, second } =
      await seedTwoActivityUnit(t);
    const assignment = await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [
          { activityId: first, mode: "classFocus", setAt: Date.now() - 120_000 },
          { activityId: second, mode: "homework", setAt: Date.now() - 60_000 },
        ],
      });
      await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
        lastMessageAt: Date.now(),
        activityCompletedAt: Date.now(),
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
      });
      return assignment;
    });

    const asScholar = await asUser(t, scholar);
    const { rows } = await asScholar.query(api.scholarPlate.activeForMe, {});
    const scopedCompletions = await asScholar.query(
      api.activityCompletions.listForScholarInUnit,
      { unitId: unit, assignmentId: assignment },
    );
    const unassignedCompletions = await asScholar.query(
      api.activityCompletions.listForScholarInUnit,
      { unitId: unit },
    );
    const row = rows.find((r) => String(r.unitId) === String(unit));

    expect(scopedCompletions.map((c) => String(c.activityId))).toContain(
      String(first),
    );
    expect(unassignedCompletions).toHaveLength(0);
    expect(row?.title).toBe("Design test");
    expect(String(row?.activityId)).toBe(String(second));
    expect(row?.unitCompletedCount).toBe(1);
  });

  test("unmarkComplete can undo inferred bare assignment completions", async () => {
    const t = convexTest(schema, modules);
    const { teacher, scholar, unit, lesson, first } = await seedTwoActivityUnit(t);
    const { sessionId, completionId } = await t.run(async (ctx) => {
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholar],
        startedAt: Date.now(),
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        unitId: unit,
        lessonId: lesson,
        activityId: first,
        assignmentId: assignment,
        title: "Launch question",
        isArchived: false,
        activityCompletedAt: Date.now(),
      });
      const completionId = await ctx.db.insert("activityCompletions", {
        scholarId: scholar,
        activityId: first,
        lessonId: lesson,
        unitId: unit,
        completedAt: Date.now(),
      });
      return { sessionId, completionId };
    });

    const asScholar = await asUser(t, scholar);
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId: first,
      sessionId,
    });
    const migrated = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(migrated).toHaveLength(1);
    expect(String(migrated[0].sessionId)).toBe(String(sessionId));
    expect(migrated[0].assignmentId).toBeDefined();

    await asScholar.mutation(api.activityCompletions.unmarkComplete, {
      activityId: first,
      sessionId,
    });
    const result = await t.run(async (ctx) => ({
      session: await ctx.db.get(sessionId),
      completion: await ctx.db.get(completionId),
    }));

    expect(result.completion).toBeNull();
    expect(result.session?.activityCompletedAt).toBeUndefined();
  });
});
