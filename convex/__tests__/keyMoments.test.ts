/**
 * Debrief → Key Moments: the activity-scoped roll-up of real-scholar
 * moments, triage, and the curriculum reflection.
 *
 * Fixtures copied from rabbithole-testing.md (seedUser / withUser).
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
  name?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: name ?? `Test ${role}`,
      username: `test-${role}-${Math.random().toString(36).slice(2, 8)}`,
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
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedActivity(t: ReturnType<typeof convexTest>, teacherId: Id<"users">) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", { teacherId, title: "U", isActive: true });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId, title: "A", kind: "online", systemPrompt: "guide", order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  isTestDrive = false,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      activityId,
      title: "S",
      isArchived: false,
      ...(isTestDrive ? { isTestDrive: true } : {}),
    }),
  );
}

async function seedMastery(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  sessionId: Id<"sessions">,
  evidenceType: string,
  masteryLevel = 1,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel: "Gravity",
      domain: "Physics",
      observedAt: Date.now(),
      sessionId,
      transcriptExcerpt: "heavy falls faster",
      masteryLevel,
      confidenceScore: 0.9,
      evidenceSummary: "Confident wrong belief about gravity.",
      evidenceType,
      attemptContext: "conversation",
      studentInitiated: false,
      isSuperseded: false,
    }),
  );
}

describe("keyMoments.forActivity", () => {
  test("rolls up real-session moments, excludes test-drive sessions, sorts by score", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", "Kai");
    const { activityId } = await seedActivity(t, teacher);

    const realSession = await seedSession(t, kai, activityId);
    const driveSession = await seedSession(t, teacher, activityId, true);

    // Real session: a misconception (high score) + a breakthrough.
    await seedMastery(t, kai, realSession, "misconception_signal", 1);
    await seedMastery(t, kai, realSession, "direct_demonstration", 5);
    // Test-drive session: should NOT surface.
    await seedMastery(t, teacher, driveSession, "misconception_signal", 1);

    const asTeacher = await withUser(t, teacher);
    const deck = await asTeacher.query(api.keyMoments.forActivity, { activityId });

    expect(deck.sessionCount).toBe(1); // test-drive excluded
    expect(deck.pending.length).toBe(2); // the two real moments
    expect(deck.pending[0].kind).toBe("misconception"); // highest score first
    expect(deck.pending.every((m) => m.scholarName === "Kai")).toBe(true);
  });

  test("triage keep moves a moment to kept; dismiss hides it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", "Kai");
    const { activityId } = await seedActivity(t, teacher);
    const s = await seedSession(t, kai, activityId);
    const m1 = await seedMastery(t, kai, s, "misconception_signal", 1);
    const m2 = await seedMastery(t, kai, s, "direct_demonstration", 5);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.keyMoments.triage, {
      activityId, source: "mastery", sourceId: m1, verdict: "kept",
    });
    await asTeacher.mutation(api.keyMoments.triage, {
      activityId, source: "mastery", sourceId: m2, verdict: "dismissed",
    });

    const deck = await asTeacher.query(api.keyMoments.forActivity, { activityId });
    expect(deck.pending.length).toBe(0); // both triaged
    expect(deck.kept.length).toBe(1); // only the kept one
    expect(deck.kept[0].sourceId).toBe(m1);
  });

  test("re-triage is idempotent (one row, latest verdict wins)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar");
    const { activityId } = await seedActivity(t, teacher);
    const s = await seedSession(t, kai, activityId);
    const m = await seedMastery(t, kai, s, "misconception_signal");
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.keyMoments.triage, { activityId, source: "mastery", sourceId: m, verdict: "dismissed" });
    await asTeacher.mutation(api.keyMoments.triage, { activityId, source: "mastery", sourceId: m, verdict: "kept" });

    const rows = await t.run((ctx) => ctx.db.query("momentTriage").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].verdict).toBe("kept");
  });

  test("a scholar cannot read the deck (teacher gate)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedActivity(t, teacher);
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.query(api.keyMoments.forActivity, { activityId }),
    ).rejects.toThrow();
  });
});

describe("keyMoments.runsForActivity", () => {
  test("groups real sessions by assignment, counts scholars + completions, excludes test drives", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", "Kai");
    const lani = await seedUser(t, "scholar", "Lani");
    const { unitId, activityId } = await seedActivity(t, teacher);

    const runA = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [kai, lani],
        title: "Honu pod",
        startedAt: Date.now() - 1000,
      }),
    );
    const runB = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [kai],
        title: "ʻIwa pod",
        startedAt: Date.now(),
      }),
    );

    // Run A: two scholars worked it; one completed. Run B: one scholar.
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId: kai, activityId, title: "S", isArchived: false, assignmentId: runA,
      });
      await ctx.db.insert("sessions", {
        userId: lani, activityId, title: "S", isArchived: false, assignmentId: runA,
      });
      await ctx.db.insert("sessions", {
        userId: kai, activityId, title: "S", isArchived: false, assignmentId: runB,
      });
      // A teacher rehearsal stamped to run A must NOT count.
      await ctx.db.insert("sessions", {
        userId: teacher, activityId, title: "S", isArchived: false,
        assignmentId: runA, isTestDrive: true,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: kai, activityId, assignmentId: runA, completedAt: Date.now(),
      });
    });

    const asTeacher = await withUser(t, teacher);
    const runs = await asTeacher.query(api.keyMoments.runsForActivity, { activityId });

    expect(runs.length).toBe(2);
    // Sorted most-recent first → run B (ʻIwa) leads.
    expect(runs[0].title).toBe("ʻIwa pod");
    const honu = runs.find((r) => r.title === "Honu pod")!;
    expect(honu.scholarCount).toBe(2); // test drive excluded
    expect(honu.doneCount).toBe(1);
  });

  test("a scholar cannot read the runs (teacher gate)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { activityId } = await seedActivity(t, teacher);
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.query(api.keyMoments.runsForActivity, { activityId }),
    ).rejects.toThrow();
  });
});

describe("keyMoments reflection", () => {
  test("recordReflection upserts the teacher's curriculum reflection", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.keyMoments.recordReflection, {
      activityId, content: "The hook landed; the deliverable was too open-ended.",
    });
    await asTeacher.mutation(api.keyMoments.recordReflection, {
      activityId, content: "Revised: tighter deliverable.",
    });

    const r = await asTeacher.query(api.keyMoments.reflection, { activityId });
    expect(r?.content).toBe("Revised: tighter deliverable.");
    const rows = await t.run((ctx) => ctx.db.query("activityReflections").collect());
    expect(rows.length).toBe(1); // upsert, not append
  });
});
