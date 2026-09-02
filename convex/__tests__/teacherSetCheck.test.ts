import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  username = `u-${role}`,
) {
  const institutionId = await seedTestInstitution(t);
  return role === "scholar"
    ? seedScholarInInstitution(t, { institutionId, name: `Test ${role}`, username })
    : seedStaffWithMembership(t, { institutionId, name: `Test ${role}`, username });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3600_000,
    }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** Seed a unit → lesson → offline activity → assignment → project → deliverable. */
async function seedDeliverable(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "U",
      isActive: true,
    } as Doc<"units">);
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Worksheet",
      kind: "offline",
      order: 0,
    } as Doc<"activities">);
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      activityId,
      unitId,
      lessonId,
      assignmentId,
      title: "Worksheet",
      isArchived: false,
      isOffline: true,
    } as Doc<"sessions">);
    const deliverableId = await ctx.db.insert("deliverables", {
      activityId,
      scholarId,
      sessionId,
      assignmentId,
      submittedAt: Date.now(),
    });
    return { activityId, assignmentId, deliverableId };
  });
}

describe("teacherSetCheck — manual three-state grading", () => {
  test("without feedback preserves existing rubric feedback and verdicts", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { deliverableId } = await seedDeliverable(t, teacherId, scholarId);
    const verdicts = [
      { criterionId: "explanation", level: "half" as const, note: "Add evidence." },
    ];
    await t.run((ctx) =>
      ctx.db.patch(deliverableId, {
        rubricFeedback: "Explain why the evidence supports your claim.",
        rubricCheckedBy: "ai",
        verdicts,
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deliverables.teacherSetCheck, {
      deliverableId,
      overall: "half",
    });

    const d = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(d?.rubricFeedback).toBe(
      "Explain why the evidence supports your claim.",
    );
    expect(d?.verdicts).toEqual(verdicts);
  });

  test("with feedback replaces rubric feedback and clears verdicts", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { deliverableId } = await seedDeliverable(t, teacherId, scholarId);
    await t.run((ctx) =>
      ctx.db.patch(deliverableId, {
        rubricFeedback: "Previous AI note.",
        rubricCheckedBy: "ai",
        verdicts: [{ criterionId: "explanation", level: "half" }],
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deliverables.teacherSetCheck, {
      deliverableId,
      overall: "not",
      feedback: "Name the standard, then revise the opening claim.",
    });

    const d = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(d?.rubricFeedback).toBe(
      "Name the standard, then revise the opening claim.",
    );
    expect(d?.verdicts).toBeUndefined();
  });

  test("with empty-string feedback explicitly clears note and verdicts", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { deliverableId } = await seedDeliverable(t, teacherId, scholarId);
    await t.run((ctx) =>
      ctx.db.patch(deliverableId, {
        rubricFeedback: "Stale note the teacher wants gone.",
        rubricCheckedBy: "ai",
        verdicts: [{ criterionId: "explanation", level: "half" }],
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deliverables.teacherSetCheck, {
      deliverableId,
      overall: "half",
      feedback: "",
    });

    const d = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(d?.rubricFeedback).toBeUndefined();
    expect(d?.verdicts).toBeUndefined();
  });

  test("sets the verdict and stamps rubricCheckedBy=teacher", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { deliverableId } = await seedDeliverable(t, teacherId, scholarId);

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deliverables.teacherSetCheck, {
      deliverableId,
      overall: "half",
      feedback: "Close — recheck the third one.",
    });

    const d = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(d?.overall).toBe("half");
    expect(d?.rubricPassed).toBe(false);
    expect(d?.rubricCheckedBy).toBe("teacher");
    expect(d?.rubricFeedback).toContain("recheck");
  });

  test("'full' stamps rubricPassed and an activity completion", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId, deliverableId } = await seedDeliverable(
      t,
      teacherId,
      scholarId,
    );

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deliverables.teacherSetCheck, {
      deliverableId,
      overall: "full",
    });

    const d = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(d?.rubricPassed).toBe(true);
    expect(d?.overall).toBe("full");

    const completions = await t.run((ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(completions.length).toBeGreaterThanOrEqual(1);
  });

  test("'not' does NOT remove a pre-existing completion (verdict ⊥ completion)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId, assignmentId, deliverableId } = await seedDeliverable(
      t,
      teacherId,
      scholarId,
    );
    // Simulate the materialize-time completion (scanned work = turned in).
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        assignmentId,
        completedAt: Date.now(),
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deliverables.teacherSetCheck, {
      deliverableId,
      overall: "not",
    });

    const d = await t.run((ctx) => ctx.db.get(deliverableId));
    expect(d?.overall).toBe("not");
    expect(d?.rubricPassed).toBe(false);
    // Completion survives — grading quality doesn't un-submit the work.
    const completions = await t.run((ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(1);
  });

  test("non-teacher cannot grade", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { deliverableId } = await seedDeliverable(t, teacherId, scholarId);

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.deliverables.teacherSetCheck, {
        deliverableId,
        overall: "full",
      }),
    ).rejects.toThrow();
  });
});

describe("applyCheckResult — scan evidence excerpt", () => {
  test("a scanned deliverable's mastery excerpt comes from the portfolio item, not '(non-text deliverable)'", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId, deliverableId } = await seedDeliverable(
      t,
      teacherId,
      scholarId,
    );
    // Attach a portfolio item (the scan) with caption + transcription, and
    // point the deliverable at it — i.e. make it a materialized scan.
    await t.run(async (ctx) => {
      const itemId = await ctx.db.insert("portfolioItems", {
        scholarId,
        title: "worksheet.pdf",
        source: "google_drive",
        matchStatus: "confirmed",
        activityId,
        processingStatus: "ready",
        aiCaption: "Equivalent fractions worksheet, four problems.",
        extractedText: "1/2 + 1/4 = 3/4",
      } as Doc<"portfolioItems">);
      await ctx.db.patch(deliverableId, { portfolioItemId: itemId });
    });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyCheckResult, {
        deliverableId,
        verdicts: [],
        overall: "full",
        feedback: "Solid work.",
        conceptLabel: "Adding fractions with unlike denominators",
        domain: "Mathematics",
        masteryLevel: 3,
        confidence: 0.9,
      }),
    );

    const obs = await t.run((ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].transcriptExcerpt).toContain("Equivalent fractions");
    expect(obs[0].transcriptExcerpt).toContain("1/2 + 1/4");
    expect(obs[0].transcriptExcerpt).not.toBe("(non-text deliverable)");
  });
});
