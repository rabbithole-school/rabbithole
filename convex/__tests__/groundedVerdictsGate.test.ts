/**
 * Grounding (Debrief) reads REAL scholar transcripts and persists each
 * scholar's name, reading level and a transcript excerpt into
 * `groundedSessionVerdicts`. A `curriculum:edit` staff grant may edit the unit
 * but "intentionally grants no teacher or scholar-data access"
 * (lib/curriculumAccess.ts), so it must be refused at every entry point —
 * starting a grounding run, the aide's debrief tool, and every reader of the
 * persisted verdicts — while a teacher keeps working, narrowed to scholars in
 * their own school.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  makeActivity,
  makeLesson,
  makeUnit,
  makeWorld,
  type WorldSchool,
} from "./factories/world";
import {
  grantInstitutionMembership,
  grantStaffCapability,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function identityFor(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** A base staff member whose ONLY capability is curriculum:edit. */
async function makeCurriculumEditor(t: T, school: WorldSchool) {
  const id = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Kai Designer",
      username: `kai-designer-${Math.random().toString(36).slice(2, 8)}`,
      role: "staff",
    }),
  );
  await grantInstitutionMembership(t, id, school.id, "staff");
  await grantStaffCapability(t, id, school.id, "curriculum:edit");
  return id;
}

/** A finished rehearsal on an activity in `school`, with judged real sessions. */
async function seedGroundedActivity(t: T, school: WorldSchool, foreign: WorldSchool) {
  const unitId = await makeUnit(t, school.teacher, school, { title: "Halves" });
  const lessonId = await makeLesson(t, unitId);
  const activityId = await makeActivity(t, lessonId, { title: "Halve it" });
  const experimentId = await t.run((ctx) =>
    ctx.db.insert("curriculumExperiments", {
      activityId,
      teacherId: school.teacher.id,
      mode: "analyze",
      config: { castProfileIds: [], maxTurns: 8, learningGoal: "halve it" },
      status: "done",
      progress: { sessionsDone: 0, sessionsTotal: 0 },
      startedAt: Date.now(),
    }),
  );

  // Two judged sessions from this school's scholars, one from a scholar at
  // another school (a shared activity). Names are the fictional world cast.
  const judged = [
    { scholar: school.scholars[0], fitness: 4 },
    { scholar: school.scholars[1], fitness: 2 },
    { scholar: foreign.scholars[0], fitness: 3 },
  ];
  const sessionIds: Id<"sessions">[] = [];
  for (const { scholar, fitness } of judged) {
    sessionIds.push(
      await t.run(async (ctx) => {
        const sessionId = await ctx.db.insert("sessions", {
          userId: scholar.id,
          title: "Real run",
          isArchived: false,
          lessonId,
          activityId,
        });
        await ctx.db.insert("messages", {
          sessionId,
          role: "user",
          content: "I cut it down the middle",
          flagged: false,
        });
        await ctx.db.insert("messages", {
          sessionId,
          role: "assistant",
          content: "How do you know the halves match?",
          flagged: false,
        });
        await ctx.db.insert("groundedSessionVerdicts", {
          activityId,
          sessionId,
          experimentId,
          scholarId: scholar.id,
          profileName: scholar.name,
          readingLevel: "Grade 3",
          verdict: { goalAttainment: 3 },
          fitness,
          goalAttainment: 3,
          excerpt: `Scholar: I cut it down the middle (${scholar.name})`,
          judgedAt: Date.now(),
        });
        return sessionId;
      }),
    );
  }
  return { unitId, activityId, experimentId, sessionIds };
}

describe("grounded verdicts are teacher-only", () => {
  test("a curriculum:edit staff member can edit the unit but cannot ground or read verdicts", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [school, foreign] = world.schools;
    const editorId = await makeCurriculumEditor(t, school);
    const { unitId, activityId, experimentId, sessionIds } =
      await seedGroundedActivity(t, school, foreign);
    const asEditor = await identityFor(t, editorId);

    // Positive control: the grant really does open the unit to this editor.
    await expect(
      asEditor.query(api.curriculumExperiments.listByActivity, { activityId }),
    ).resolves.toHaveLength(1);

    await expect(
      asEditor.mutation(api.curriculumExperiments.groundExperiment, {
        experimentId,
      }),
    ).rejects.toThrow(/teacher or admin role/);
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.grounding).toBeUndefined(); // nothing scheduled

    await expect(
      asEditor.query(api.judgeValidation.pairsForActivity, { activityId }),
    ).rejects.toThrow(/teacher or admin role/);
    await expect(
      asEditor.query(api.judgeValidation.correlation, { activityId }),
    ).rejects.toThrow(/teacher or admin role/);
    await expect(
      asEditor.mutation(api.judgeValidation.recordChoice, {
        activityId,
        sessionAId: sessionIds[0],
        sessionBId: sessionIds[1],
        teacherChoice: "A",
      }),
    ).rejects.toThrow(/teacher or admin role/);

    // The Curriculum Bot's debrief tool takes the same gate.
    const aide = await t.mutation(internal.curriculumExperiments.aideGroundLatest, {
      unitId,
      activityTitle: "Halve it",
      callerUserId: editorId,
    });
    expect(aide.ok).toBe(false);
    expect(aide.message).toMatch(/limited to teachers/);
    expect((await t.run((ctx) => ctx.db.get(experimentId)))?.grounding).toBeUndefined();
  });

  test("a teacher at one school holding only a curriculum:edit grant at another is refused there", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [school, foreign] = world.schools;
    // The foreign school's teacher is also a curriculum editor at `school`.
    await grantInstitutionMembership(t, foreign.teacher.id, school.id, "staff");
    await grantStaffCapability(t, foreign.teacher.id, school.id, "curriculum:edit");
    const { activityId, experimentId } = await seedGroundedActivity(t, school, foreign);
    await t.run((ctx) =>
      ctx.db.patch(experimentId, {
        grounding: {
          status: "done",
          scholarFeedback: {
            count: 1,
            examples: [{ snippet: "Yes, 2 + 2 = 5.", reason: "it's 4" }],
          },
        },
      }),
    );
    const asForeignTeacher = await world.as.staffOf(foreign);

    // Positive control: the grant opens the unit to them.
    const [listed] = await asForeignTeacher.query(
      api.curriculumExperiments.listByActivity,
      { activityId },
    );
    expect(listed.grounding.scholarFeedback.examples).toEqual([]);
    await expect(
      asForeignTeacher.mutation(api.curriculumExperiments.groundExperiment, {
        experimentId,
      }),
    ).rejects.toThrow(/teacher or admin role/);
    // The finished debrief is not overwritten.
    expect((await t.run((ctx) => ctx.db.get(experimentId)))?.grounding?.status).toBe(
      "done",
    );
    await expect(
      asForeignTeacher.query(api.judgeValidation.pairsForActivity, { activityId }),
    ).rejects.toThrow(/teacher or admin role/);
  });

  test("stored feedback examples are filtered per scholar at read time", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
    });
    const [school, foreign] = world.schools;
    const editorId = await makeCurriculumEditor(t, school);
    const { activityId, experimentId, sessionIds } = await seedGroundedActivity(
      t,
      school,
      foreign,
    );
    // As if a platform admin grounded it: one example from this school's
    // scholar, one from the other school's, and one legacy unstamped example.
    await t.run((ctx) =>
      ctx.db.patch(experimentId, {
        grounding: {
          status: "done",
          realN: 3,
          scholarFeedback: {
            count: 3,
            examples: [
              {
                snippet: "Own school snippet",
                reason: "own reason",
                scholarId: school.scholars[0].id,
                sessionId: sessionIds[0],
              },
              {
                snippet: "Foreign snippet",
                reason: "foreign reason",
                scholarId: foreign.scholars[0].id,
                sessionId: sessionIds[2],
              },
              { snippet: "Legacy snippet", reason: "legacy reason" },
            ],
          },
        },
      }),
    );
    // `grounding` is v.any() in the schema.
    const reasons = (exp: { grounding?: unknown } | undefined) =>
      (
        exp?.grounding as
          | { scholarFeedback: { examples: { reason: string }[] } }
          | undefined
      )?.scholarFeedback.examples.map((e) => e.reason);

    const asEditor = await identityFor(t, editorId);
    const [listed] = await asEditor.query(api.curriculumExperiments.listByActivity, {
      activityId,
    });
    expect(listed.grounding.scholarFeedback).toEqual({ count: 3, examples: [] });

    const asTeacher = await world.as.staffOf(school);
    const teacherDetail = await asTeacher.query(api.curriculumExperiments.get, {
      experimentId,
    });
    expect(reasons(teacherDetail?.experiment)).toEqual(["own reason"]);
    const [teacherListed] = await asTeacher.query(
      api.curriculumExperiments.listByActivity,
      { activityId },
    );
    expect(reasons(teacherListed)).toEqual(["own reason"]);

    const asAdmin = await world.as.platformAdmin();
    const adminDetail = await asAdmin.query(api.curriculumExperiments.get, {
      experimentId,
    });
    expect(reasons(adminDetail?.experiment)).toEqual([
      "own reason",
      "foreign reason",
      "legacy reason",
    ]);

    // Losing the teacher membership hides the example on the very next read.
    await t.run(async (ctx) => {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", school.teacher.id))
        .collect();
      for (const m of memberships) await ctx.db.delete(m._id);
      await ctx.db.insert("memberships", {
        userId: school.teacher.id,
        role: "staff",
        institutionId: school.id,
      });
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: school.teacher.id,
        institutionId: school.id,
        capability: "curriculum:edit",
        grantedBy: school.admin.id,
        grantedAt: Date.now(),
      });
    });
    const revoked = await asTeacher.query(api.curriculumExperiments.get, {
      experimentId,
    });
    expect(reasons(revoked?.experiment)).toEqual([]);
  });

  test("grounding stamps each feedback example with its scholar and session", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [school, foreign] = world.schools;
    const { experimentId, sessionIds } = await seedGroundedActivity(t, school, foreign);
    await t.run(async (ctx) => {
      const tutorTurn = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionIds[0]))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .first();
      await ctx.db.insert("messageFlags", {
        sessionId: sessionIds[0],
        messageId: tutorTurn!._id,
        scholarId: school.scholars[0].id,
        reason: "that's not half",
      });
    });
    const input = await t.query(internal.curriculumExperiments.getGroundInput, {
      experimentId,
      groundedBy: school.teacher.id,
    });
    expect(input.scholarFeedback.examples).toEqual([
      expect.objectContaining({
        reason: "that's not half",
        scholarId: school.scholars[0].id,
        sessionId: sessionIds[0],
      }),
    ]);
  });

  test("a teacher grounds and validates, seeing only their own school's scholars", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [school, foreign] = world.schools;
    const { activityId, experimentId, sessionIds } = await seedGroundedActivity(
      t,
      school,
      foreign,
    );
    const asTeacher = await world.as.staffOf(school);

    await asTeacher.mutation(api.curriculumExperiments.groundExperiment, {
      experimentId,
    });
    expect((await t.run((ctx) => ctx.db.get(experimentId)))?.grounding?.status).toBe(
      "running",
    );

    // The scheduled run is stamped with the grounding teacher, and the input
    // it judges excludes the other school's scholar.
    const input = await t.query(internal.curriculumExperiments.getGroundInput, {
      experimentId,
      groundedBy: school.teacher.id,
    });
    expect(input.realSessions.map((s) => s.scholarId).sort()).toEqual(
      [school.scholars[0].id, school.scholars[1].id].sort(),
    );
    // Without a grounding teacher (a run scheduled before this arg existed),
    // no real session is read at all.
    const unstamped = await t.query(internal.curriculumExperiments.getGroundInput, {
      experimentId,
    });
    expect(unstamped.realSessions).toEqual([]);

    const pairs = await asTeacher.query(api.judgeValidation.pairsForActivity, {
      activityId,
    });
    expect(pairs.judgedSessions).toBe(2);
    const shownNames = pairs.pairs.flatMap((p) => [p.a.profileName, p.b.profileName]);
    expect(shownNames).toContain(school.scholars[0].name);
    expect(shownNames).not.toContain(foreign.scholars[0].name);

    await asTeacher.mutation(api.judgeValidation.recordChoice, {
      activityId,
      sessionAId: sessionIds[0],
      sessionBId: sessionIds[1],
      teacherChoice: "A",
    });
    // The other school's session can't be compared.
    await expect(
      asTeacher.mutation(api.judgeValidation.recordChoice, {
        activityId,
        sessionAId: sessionIds[0],
        sessionBId: sessionIds[2],
        teacherChoice: "A",
      }),
    ).rejects.toThrow(/no judge verdict/);
    const corr = await asTeacher.query(api.judgeValidation.correlation, {
      activityId,
    });
    expect(corr.judgedSessions).toBe(2);
    expect(corr.n).toBe(1);
  });

  test("canDebrief matches the server gate and never throws", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
    });
    const [school, foreign] = world.schools;
    const editorId = await makeCurriculumEditor(t, school);
    // A teacher at the other school who can also edit this school's units.
    await grantInstitutionMembership(t, foreign.teacher.id, school.id, "staff");
    await grantStaffCapability(t, foreign.teacher.id, school.id, "curriculum:edit");
    const { activityId } = await seedGroundedActivity(t, school, foreign);

    const ask = async (identity: Awaited<ReturnType<typeof identityFor>>) =>
      identity.query(api.curriculumExperiments.canDebrief, { activityId });
    expect(await ask(await world.as.staffOf(school))).toBe(true);
    expect(await ask(await world.as.platformAdmin())).toBe(true);
    expect(await ask(await identityFor(t, editorId))).toBe(false);
    expect(await ask(await world.as.staffOf(foreign))).toBe(false);
    expect(await ask(await world.as.scholar(school.scholars[0]))).toBe(false);
  });

  test("a suspended school fails closed, platform admin included", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
    });
    const [school, foreign] = world.schools;
    const { activityId, experimentId } = await seedGroundedActivity(t, school, foreign);
    await t.run((ctx) => ctx.db.patch(school.id, { disabledAt: Date.now() }));

    const asAdmin = await world.as.platformAdmin();
    expect(
      await asAdmin.query(api.curriculumExperiments.canDebrief, { activityId }),
    ).toBe(false);
    await expect(
      asAdmin.mutation(api.curriculumExperiments.groundExperiment, { experimentId }),
    ).rejects.toThrow(/teacher or admin role/);
    await expect(
      asAdmin.query(api.judgeValidation.pairsForActivity, { activityId }),
    ).rejects.toThrow(/teacher or admin role/);
    // The job re-checks at run time: nothing is read for a suspended school.
    const input = await t.query(internal.curriculumExperiments.getGroundInput, {
      experimentId,
      groundedBy: world.platformAdmin!.id,
    });
    expect(input.realSessions).toEqual([]);
  });

  test("editors without grounding rights get no aggregate backed by fewer than 3 sessions", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [school, foreign] = world.schools;
    const editorId = await makeCurriculumEditor(t, school);
    const { unitId, activityId, experimentId, sessionIds } =
      await seedGroundedActivity(t, school, foreign);
    const realAggregate = { n: 2, fitness: 3.4, dims: {} };
    await t.run((ctx) =>
      ctx.db.patch(experimentId, {
        grounding: {
          status: "done",
          realN: 2,
          realAggregate,
          fitnessDelta: 0.2,
          trustworthy: true,
          note: "Simulator within 0.75 of reality",
        },
      }),
    );
    const asEditor = await identityFor(t, editorId);
    const asTeacher = await world.as.staffOf(school);

    const editorView = await asEditor.query(api.curriculumExperiments.get, {
      experimentId,
    });
    expect(editorView?.experiment.grounding.realAggregate).toBeUndefined();
    expect(editorView?.experiment.grounding.fitnessDelta).toBeUndefined();
    expect(editorView?.experiment.grounding.trustworthy).toBeUndefined();
    expect(editorView?.experiment.grounding.note).toMatch(/Fewer than 3/);
    const teacherView = await asTeacher.query(api.curriculumExperiments.get, {
      experimentId,
    });
    expect(teacherView?.experiment.grounding.realAggregate).toEqual(realAggregate);

    // At 3 sessions the editor sees the aggregate.
    await t.run((ctx) =>
      ctx.db.patch(experimentId, {
        grounding: { status: "done", realN: 3, realAggregate: { ...realAggregate, n: 3 } },
      }),
    );
    const editorAt3 = await asEditor.query(api.curriculumExperiments.get, {
      experimentId,
    });
    expect(editorAt3?.experiment.grounding.realAggregate.n).toBe(3);

    // The field-record mean: 3 judged sessions show; 2 do not, for the editor.
    const signalFor = async (identity: Awaited<ReturnType<typeof identityFor>>) =>
      (await identity.query(api.activitySessions.getForUnit, { unitId })).activities[
        String(activityId)
      ];
    expect((await signalFor(asEditor)).fitnessN).toBe(3);
    await t.run(async (ctx) => {
      const verdict = await ctx.db
        .query("groundedSessionVerdicts")
        .withIndex("by_activity_session", (q) =>
          q.eq("activityId", activityId).eq("sessionId", sessionIds[2]),
        )
        .unique();
      await ctx.db.delete(verdict!._id);
    });
    const editorSignal = await signalFor(asEditor);
    expect(editorSignal.meanFitness).toBeNull();
    expect(editorSignal.fitnesses).toEqual([]);
    const teacherSignal = await signalFor(asTeacher);
    expect(teacherSignal.fitnessN).toBe(2);
    expect(teacherSignal.meanFitness).toBe(3);
  });
});
