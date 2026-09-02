/**
 * Judge ↔ teacher micro-validation (convex/judgeValidation.ts) — the gate,
 * the pairwise deck, recording a pick, and the correlation roll-up. The
 * grounding action that POPULATES groundedSessionVerdicts is a node action we
 * don't drive here; we seed judged verdicts directly and exercise the
 * teacher-facing surface. Sim-realism adoptable #2.
 *
 * Fixtures copied verbatim from rabbithole-testing.md (seedUser / withUser /
 * seedUnitWithActivity).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = "scholar" | "teacher" | "platform_admin";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username:
        overrides.username ??
        `test-${role}-${Math.random().toString(36).slice(2, 8)}`,
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

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Halving Shapes",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Halve the rectangle",
      kind: "online",
      systemPrompt: "Guide the scholar to split a shape into two equal parts.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

/** Insert a real session + a persisted judge verdict for it on an activity. */
async function seedJudgedSession(
  t: ReturnType<typeof convexTest>,
  args: {
    activityId: Id<"activities">;
    experimentId: Id<"curriculumExperiments">;
    scholarId: Id<"users">;
    name: string;
    fitness: number;
    goalAttainment?: number;
    excerpt?: string;
  },
): Promise<Id<"sessions">> {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: args.scholarId,
      title: `Session for ${args.name}`,
      isArchived: false,
    });
    await ctx.db.insert("groundedSessionVerdicts", {
      activityId: args.activityId,
      sessionId,
      experimentId: args.experimentId,
      scholarId: args.scholarId,
      profileName: args.name,
      readingLevel: "Grade 3",
      verdict: { goalAttainment: args.goalAttainment ?? 3, summary: "t" },
      fitness: args.fitness,
      goalAttainment: args.goalAttainment ?? 3,
      excerpt: args.excerpt ?? `Tutor: hi ${args.name}\nScholar: hello`,
      judgedAt: Date.now(),
    });
    return sessionId;
  });
}

/** A throwaway experiment id to stamp on grounded verdicts. */
async function seedExperiment(
  t: ReturnType<typeof convexTest>,
  args: { activityId: Id<"activities">; teacherId: Id<"users"> },
): Promise<Id<"curriculumExperiments">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("curriculumExperiments", {
      activityId: args.activityId,
      teacherId: args.teacherId,
      mode: "analyze",
      config: { castProfileIds: [], maxTurns: 10, learningGoal: "halve it" },
      status: "done",
      progress: { sessionsDone: 0, sessionsTotal: 0 },
      startedAt: Date.now(),
    }),
  );
}

describe("judgeValidation gate", () => {
  test("a scholar cannot read the pairs, record, or the correlation", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asScholar = await withUser(t, scholar);

    await expect(
      asScholar.query(api.judgeValidation.pairsForActivity, { activityId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asScholar.query(api.judgeValidation.correlation, { activityId }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("pairsForActivity", () => {
  test("fewer than two judged sessions ⇒ empty deck + note", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const exp = await seedExperiment(t, { activityId, teacherId: teacher });
    await seedJudgedSession(t, {
      activityId,
      experimentId: exp,
      scholarId: teacher,
      name: "Solo",
      fitness: 3,
    });
    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.judgeValidation.pairsForActivity, {
      activityId,
    });
    expect(res.judgedSessions).toBe(1);
    expect(res.pairs).toHaveLength(0);
    expect(res.note).toMatch(/at least two/i);
  });

  test("three judged sessions ⇒ candidate pairs with hidden judge pref", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const s1owner = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const exp = await seedExperiment(t, { activityId, teacherId: teacher });
    await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: s1owner, name: "Hi", fitness: 4.5 });
    await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: s1owner, name: "Mid", fitness: 3.0 });
    await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: s1owner, name: "Lo", fitness: 1.5 });

    const asTeacher = await withUser(t, teacher);
    const res = await asTeacher.query(api.judgeValidation.pairsForActivity, {
      activityId,
    });
    expect(res.judgedSessions).toBe(3);
    expect(res.pairs.length).toBeGreaterThanOrEqual(1);
    for (const p of res.pairs) {
      expect(p.sessionAId).not.toBe(p.sessionBId);
      expect(p.a.excerpt).toBeTruthy();
      expect(p.alreadyChoice).toBeNull(); // nothing recorded yet
      expect(["A", "B", "tie"]).toContain(p.judgePrefers);
    }
  });
});

describe("recordChoice + correlation", () => {
  test("perfect agreement ⇒ agreement 1, n = 2, r defined", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const exp = await seedExperiment(t, { activityId, teacherId: teacher });
    const hi = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Hi", fitness: 4.0 });
    const mid = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Mid", fitness: 3.0 });
    const lo = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Lo", fitness: 2.0 });

    const asTeacher = await withUser(t, teacher);
    // Teacher agrees with the judge both times, but picks different SIDES so
    // both score vectors have variance (Pearson r is otherwise undefined):
    //  (hi vs lo): A=hi, margin +2 → judge prefers A → teacher picks A.
    //  (lo vs mid): A=lo, margin −1 → judge prefers B → teacher picks B.
    await asTeacher.mutation(api.judgeValidation.recordChoice, {
      activityId,
      sessionAId: hi,
      sessionBId: lo,
      teacherChoice: "A",
    });
    await asTeacher.mutation(api.judgeValidation.recordChoice, {
      activityId,
      sessionAId: lo,
      sessionBId: mid,
      teacherChoice: "B",
    });

    const corr = await asTeacher.query(api.judgeValidation.correlation, {
      activityId,
    });
    expect(corr.n).toBe(2);
    expect(corr.nDecisive).toBe(2);
    expect(corr.agreements).toBe(2);
    expect(corr.agreement).toBe(1);
    // Both series vary and align in sign ⇒ positive, defined r.
    expect(corr.r).not.toBeNull();
    expect(corr.r!).toBeGreaterThan(0);
  });

  test("a disagreement drops the agreement rate", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const exp = await seedExperiment(t, { activityId, teacherId: teacher });
    const hi = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Hi", fitness: 4.0 });
    const lo = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Lo", fitness: 2.0 });
    const mid = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Mid", fitness: 3.0 });

    const asTeacher = await withUser(t, teacher);
    // Agree: A=hi (margin +2), pick A.
    await asTeacher.mutation(api.judgeValidation.recordChoice, {
      activityId, sessionAId: hi, sessionBId: lo, teacherChoice: "A",
    });
    // Disagree: A=mid (margin +1, judge prefers A) but teacher picks B.
    await asTeacher.mutation(api.judgeValidation.recordChoice, {
      activityId, sessionAId: mid, sessionBId: lo, teacherChoice: "B",
    });

    const corr = await asTeacher.query(api.judgeValidation.correlation, {
      activityId,
    });
    expect(corr.n).toBe(2);
    expect(corr.nDecisive).toBe(2);
    expect(corr.agreements).toBe(1);
    expect(corr.agreement).toBe(0.5);
  });

  test("recording the same pair again overwrites the earlier pick", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const exp = await seedExperiment(t, { activityId, teacherId: teacher });
    const hi = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Hi", fitness: 4.0 });
    const lo = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Lo", fitness: 2.0 });

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.judgeValidation.recordChoice, {
      activityId, sessionAId: hi, sessionBId: lo, teacherChoice: "A",
    });
    // Re-record the SAME unordered pair (order flipped) with a different pick.
    await asTeacher.mutation(api.judgeValidation.recordChoice, {
      activityId, sessionAId: lo, sessionBId: hi, teacherChoice: "tie",
    });

    const corr = await asTeacher.query(api.judgeValidation.correlation, {
      activityId,
    });
    // One comparison, not two — the upsert overwrote it. Tie ⇒ not decisive.
    expect(corr.n).toBe(1);
    expect(corr.nDecisive).toBe(0);
    expect(corr.agreement).toBeNull();
    expect(corr.ties.teacher).toBe(1);
  });

  test("rejects a session with no judge verdict for this activity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const exp = await seedExperiment(t, { activityId, teacherId: teacher });
    const judged = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Hi", fitness: 4.0 });
    // A bare session with NO grounded verdict.
    const unjudged = await t.run(async (ctx) =>
      ctx.db.insert("sessions", { userId: scholar, title: "unjudged", isArchived: false }),
    );

    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.judgeValidation.recordChoice, {
        activityId, sessionAId: judged, sessionBId: unjudged, teacherChoice: "A",
      }),
    ).rejects.toThrow(/no judge verdict/i);
  });

  test("rejects comparing a session with itself", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const exp = await seedExperiment(t, { activityId, teacherId: teacher });
    const s = await seedJudgedSession(t, { activityId, experimentId: exp, scholarId: scholar, name: "Hi", fitness: 4.0 });
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.judgeValidation.recordChoice, {
        activityId, sessionAId: s, sessionBId: s, teacherChoice: "A",
      }),
    ).rejects.toThrow(/itself/i);
  });
});
