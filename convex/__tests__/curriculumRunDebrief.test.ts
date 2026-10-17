import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  makeActivity,
  makeLesson,
  makeSession,
  makeUnit,
  makeWorld,
} from "./factories/world";
import {
  grantStaffCapability,
  seedStaffWithMembership,
} from "./institutionTestHelpers";

/**
 * curriculum:run Debrief — the Key Moments deck for an activity, scoped to the
 * real sessions under assignments the runner OWNS. Another teacher's run of
 * the very same activity never appears. She may triage and log observations
 * about her own assignees; she may not steer the tutor. Teachers unchanged.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

async function asUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function addSignal(
  t: T,
  scholarId: Id<"users">,
  sessionId: Id<"sessions">,
  description: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("sessionSignals", {
      scholarId,
      sessionId,
      signalType: "creative_approach",
      description,
      intensity: "high",
    }),
  );
}

async function seed(t: T) {
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 4,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const [home] = world.schools;
  const runnerId = await seedStaffWithMembership(t, {
    institutionId: home.id,
    role: "staff",
    name: "Pua Designer",
    username: "pua-designer-debrief",
  });
  await grantStaffCapability(t, runnerId, home.id, "curriculum:edit");
  await grantStaffCapability(t, runnerId, home.id, "curriculum:run");

  const unit = await makeUnit(t, runnerId, home, { title: "Tide Pools" });
  const lesson = await makeLesson(t, unit);
  const activity = await makeActivity(t, lesson, { title: "Sketch an anemone" });

  const [a1, a2, b1, b2] = home.scholars;
  const runner = await asUser(t, runnerId);
  const teacher = await asUser(t, home.teacher.id);

  // Her run (a1, a2) and a teacher's run of the SAME activity (b1, b2).
  const mine = await runner.mutation(api.assignments.assignWork, {
    unitId: unit,
    scholarIds: [a1.id, a2.id],
    startsAt: Date.now(),
    target: { kind: "unit" },
  });
  const theirs = await teacher.mutation(api.assignments.assignWork, {
    unitId: unit,
    scholarIds: [b1.id, b2.id],
    startsAt: Date.now(),
    target: { kind: "unit" },
  });
  const mySession = await makeSession(t, a1, {
    assignmentId: mine,
    unitId: unit,
    lessonId: lesson,
    activityId: activity,
  });
  const theirSession = await makeSession(t, b1, {
    assignmentId: theirs,
    unitId: unit,
    lessonId: lesson,
    activityId: activity,
  });
  const mySignal = await addSignal(t, a1.id, mySession, "Built a model of a tentacle");
  await addSignal(t, b1.id, theirSession, "Compared anemones to flowers");

  return {
    home,
    runnerId,
    runner,
    teacher,
    activity,
    mine,
    theirs,
    mySession,
    theirSession,
    mySignal,
    a1,
    a2,
    b1,
  };
}

describe("curriculum:run Debrief", () => {
  test("her deck holds only moments from runs she owns, with no transcript links", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    const deck = (await s.runner.query(api.keyMoments.forActivity, {
      activityId: s.activity,
    }))!;
    expect(deck.sessionCount).toBe(1);
    const all = [...deck.pending, ...deck.kept];
    expect(all.map((m) => m.scholarId)).toEqual([s.a1.id]);
    expect(all.every((m) => m.sessionId === null)).toBe(true);
    expect(all[0].assignmentId).toBe(s.mine);
    expect(all.map((m) => m.excerpt)).not.toContain(
      "Compared anemones to flowers",
    );

    const runs = await s.runner.query(api.keyMoments.runsForActivity, {
      activityId: s.activity,
    });
    expect(runs.map((r) => r.assignmentId)).toEqual([s.mine]);
  });

  test("she can triage and log an observation for her assignee, not anyone else", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);

    await s.runner.mutation(api.keyMoments.triage, {
      activityId: s.activity,
      source: "signal",
      sourceId: String(s.mySignal),
      verdict: "kept",
    });
    const deck = (await s.runner.query(api.keyMoments.forActivity, {
      activityId: s.activity,
    }))!;
    expect(deck.kept).toHaveLength(1);

    const obs = await s.runner.mutation(api.observations.add, {
      scholarId: s.a1.id,
      assignmentId: s.mine,
      note: "Built a model of a tentacle",
      type: "praise",
    });
    expect(obs?.teacherId).toBe(s.runnerId);
    // Her assignee who has no session yet is still her assignee.
    await s.runner.mutation(api.observations.add, {
      scholarId: s.a2.id,
      assignmentId: s.mine,
      note: "Joined late",
      type: "note",
    });

    // A scholar on someone else's run, named through her run or theirs.
    await expect(
      s.runner.mutation(api.observations.add, {
        scholarId: s.b1.id,
        assignmentId: s.mine,
        note: "x",
        type: "note",
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      s.runner.mutation(api.observations.add, {
        scholarId: s.b1.id,
        assignmentId: s.theirs,
        note: "x",
        type: "note",
      }),
    ).rejects.toThrow(/Forbidden/);
    // Without a run to stand on, she's refused (no teacher role).
    await expect(
      s.runner.mutation(api.observations.add, {
        scholarId: s.a1.id,
        note: "x",
        type: "note",
      }),
    ).rejects.toThrow(/Forbidden/);
    // A session id must be that scholar's session on that run.
    await expect(
      s.runner.mutation(api.observations.add, {
        scholarId: s.a1.id,
        assignmentId: s.mine,
        sessionId: s.theirSession,
        note: "x",
        type: "note",
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("she cannot steer the tutor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      s.runner.mutation(api.teacherDirectives.upsertByTeacher, {
        scholarId: s.a1.id,
        label: "Tentacles",
        content: "Revisit tentacles with a concrete example",
      }),
    ).rejects.toThrow(/teacher or admin role required/);
  });

  test("curriculum:edit alone gets no Debrief", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const editorId = await seedStaffWithMembership(t, {
      institutionId: s.home.id,
      role: "staff",
      name: "Kawika Builder",
      username: "kawika-builder-debrief",
    });
    await grantStaffCapability(t, editorId, s.home.id, "curriculum:edit");
    const editor = await asUser(t, editorId);
    // No Debrief access reads as empty, never as an error-boundary throw.
    expect(
      await editor.query(api.keyMoments.forActivity, { activityId: s.activity }),
    ).toBeNull();
    expect(
      await editor.query(api.keyMoments.runsForActivity, {
        activityId: s.activity,
      }),
    ).toEqual([]);
    await expect(
      editor.mutation(api.keyMoments.triage, {
        activityId: s.activity,
        source: "signal",
        sourceId: String(s.mySignal),
        verdict: "kept",
      }),
    ).rejects.toThrow(/teacher or admin role required/);
  });

  test("teachers are unchanged: activity-wide deck with session links", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const deck = (await s.teacher.query(api.keyMoments.forActivity, {
      activityId: s.activity,
    }))!;
    expect(deck.sessionCount).toBe(2);
    const sessions = [...deck.pending, ...deck.kept].map((m) => m.sessionId);
    expect(sessions).toContain(s.mySession);
    expect(sessions).toContain(s.theirSession);
    // A teacher still logs observations by role, no run needed.
    await s.teacher.mutation(api.observations.add, {
      scholarId: s.b1.id,
      note: "Compared anemones to flowers",
      type: "praise",
    });
  });

  test("a scholar dropped from her roster leaves her deck", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const before = await s.runner.query(api.keyMoments.forActivity, {
      activityId: s.activity,
    });
    expect(before?.sessionCount).toBe(1);
    await t.run((ctx) => ctx.db.patch(s.mine, { scholarIds: [s.a2.id] }));
    const after = await s.runner.query(api.keyMoments.forActivity, {
      activityId: s.activity,
    });
    expect(after?.sessionCount).toBe(0);
    expect([...(after?.pending ?? []), ...(after?.kept ?? [])]).toEqual([]);
  });

  test("losing access empties her Debrief instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const grants = await ctx.db
        .query("staffCapabilityGrants")
        .withIndex("by_grantee_capability", (q) =>
          q.eq("granteeUserId", s.runnerId).eq("capability", "curriculum:run"),
        )
        .collect();
      for (const grant of grants) {
        await ctx.db.patch(grant._id, { revokedAt: Date.now(), revokedBy: s.runnerId });
      }
    });
    expect(
      await s.runner.query(api.keyMoments.forActivity, { activityId: s.activity }),
    ).toBeNull();
    expect(
      await s.runner.query(api.keyMoments.runsForActivity, {
        activityId: s.activity,
      }),
    ).toEqual([]);
    expect(
      await s.runner.query(api.keyMoments.reflection, { activityId: s.activity }),
    ).toBeNull();
  });

  test("a teacher's run of the same unit never moves her counts or lamps", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const unitId = (await t.run(async (ctx) => {
      const activity = await ctx.db.get(s.activity);
      const lesson = activity?.lessonId ? await ctx.db.get(activity.lessonId) : null;
      return lesson!.unitId;
    })) as Id<"units">;

    const hers = await s.runner.query(api.activitySessions.getForUnit, { unitId });
    const theirs = await s.teacher.query(api.activitySessions.getForUnit, {
      unitId,
    });
    const activityKey = String(s.activity);
    expect(hers.activities[activityKey].activeCount).toBe(1);
    expect(theirs.activities[activityKey].activeCount).toBe(2);
    expect(hers.unit.activeCount).toBe(1);

    // Another teacher run with a session on a second scholar: hers is unmoved.
    await makeSession(t, s.b1, {
      assignmentId: s.theirs,
      activityId: s.activity,
    });
    const hersAgain = await s.runner.query(api.activitySessions.getForUnit, {
      unitId,
    });
    expect(hersAgain.activities[activityKey].activeCount).toBe(1);

    // Maturity: her "assigned" lamp and active-run count read only her runs.
    await t.run((ctx) => ctx.db.patch(s.mine, { archivedAt: Date.now() }));
    await t.run(async (ctx) => {
      const own = await ctx.db
        .query("sessions")
        .withIndex("by_activity", (q) => q.eq("activityId", s.activity))
        .collect();
      for (const row of own) {
        if (row.assignmentId === s.mine) await ctx.db.delete(row._id);
      }
    });
    const statuses = await s.runner.query(api.unitMaturity.getNodeStatuses, {
      unitId,
    });
    expect(statuses.activitiesAssigned[activityKey]).toBe(false);
    expect(statuses.unitAssigned).toBe(false);
    const teacherStatuses = await s.teacher.query(
      api.unitMaturity.getNodeStatuses,
      { unitId },
    );
    expect(teacherStatuses.activitiesAssigned[activityKey]).toBe(true);
    expect(teacherStatuses.unitAssigned).toBe(true);
  });

  test("grounding and judge validation stay closed to her", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const experimentId = await t.run((ctx) =>
      ctx.db.insert("curriculumExperiments", {
        activityId: s.activity,
        teacherId: s.home.teacher.id,
        mode: "analyze",
        config: { castProfileIds: [], maxTurns: 8, learningGoal: "sketch it" },
        status: "done",
        progress: { sessionsDone: 0, sessionsTotal: 0 },
        startedAt: Date.now(),
        // A large real n: an editor would see this aggregate; a runner never.
        grounding: {
          status: "done",
          realN: 6,
          realAggregate: { n: 6, fitness: 3.1, dims: {} },
          fitnessDelta: 0.3,
          trustworthy: true,
          scholarFeedback: {
            count: 1,
            examples: [
              {
                scholarId: s.b1.id,
                sessionId: s.theirSession,
                reason: "Too fast",
              },
            ],
          },
        },
      } as never),
    );
    const view = await s.runner.query(api.curriculumExperiments.get, {
      experimentId,
    });
    const grounding = view?.experiment.grounding as Record<string, unknown>;
    expect(grounding.realAggregate).toBeUndefined();
    expect(grounding.fitnessDelta).toBeUndefined();
    expect(grounding.trustworthy).toBeUndefined();
    expect(
      (grounding.scholarFeedback as { examples: unknown[] }).examples,
    ).toEqual([]);
    expect(
      await s.runner.query(api.curriculumExperiments.canDebrief, {
        activityId: s.activity,
      }),
    ).toBe(false);
    await expect(
      s.runner.mutation(api.curriculumExperiments.groundExperiment, {
        experimentId,
      }),
    ).rejects.toThrow(/teacher or admin role/);
    await expect(
      s.runner.query(api.judgeValidation.pairsForActivity, {
        activityId: s.activity,
      }),
    ).rejects.toThrow(/teacher or admin role/);
    // Teachers keep the aggregate.
    const teacherView = await s.teacher.query(api.curriculumExperiments.get, {
      experimentId,
    });
    expect(
      (teacherView?.experiment.grounding as Record<string, unknown>).realAggregate,
    ).toBeTruthy();
  });
});
