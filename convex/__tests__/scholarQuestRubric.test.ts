// Regression: a scholar's own quest activity (created in-session via the
// planning tutor's `create_activity` tool → activities.aiCreateForIsUnit)
// must be able to EARN rubric stars, just like a teacher-authored activity.
// Before the fix, that path inserted online activities with no deliverable,
// bypassing requireDeliverableForOnline — so a kid's quest could never pay
// stars (week-1 pilot finding). The fix attaches an AUTO-mode text
// deliverable by default, scored on the PR #644 per-scholar-criteria path.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `t${role}_${Math.random().toString(36).slice(2, 8)}`,
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

// A scholar owning an IS unit with one lesson, ready for aiCreateForIsUnit.
async function seedIsUnit(t: ReturnType<typeof convexTest>) {
  const scholarId = await seedUser(t, "scholar");
  const { unitId, lessonId } = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title: "My Quest",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson 1",
      order: 0,
    });
    return { unitId, lessonId };
  });
  return { scholarId, unitId, lessonId };
}

describe("activities.aiCreateForIsUnit — scholar quests earn rubric stars", () => {
  test("online activity gets a default AUTO-mode text deliverable", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedIsUnit(t);

    const activityId = await t.mutation(
      internal.activities.aiCreateForIsUnit,
      {
        lessonId,
        scholarId,
        unitId,
        title: "Design a better paper airplane",
        kind: "online",
        systemPrompt: "Help the scholar iterate on a paper-airplane design.",
      },
    );

    const activity = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(activity?.deliverable).toBeDefined();
    expect(activity?.deliverable?.mode).toBe("auto");
    expect(activity?.deliverable?.kind).toBe("text");
    // Auto mode: criteria are empty at authoring time (generated per-scholar
    // at session start).
    expect(activity?.deliverable?.criteria).toEqual([]);
    // Default notes seed the criteria generator with the learning goal.
    expect(activity?.deliverable?.notes).toContain("paper-airplane");
  });

  test("tutor-supplied deliverable prompt/notes are honored (still auto)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedIsUnit(t);

    const activityId = await t.mutation(
      internal.activities.aiCreateForIsUnit,
      {
        lessonId,
        scholarId,
        unitId,
        title: "Redesign the wings",
        kind: "online",
        systemPrompt: "Wing iteration.",
        deliverable: {
          prompt: "Write up your redesign and why each change helps.",
          notes: "Reward specific aerodynamic reasoning.",
        },
      },
    );

    const activity = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(activity?.deliverable?.mode).toBe("auto");
    expect(activity?.deliverable?.prompt).toBe(
      "Write up your redesign and why each change helps.",
    );
    expect(activity?.deliverable?.notes).toBe(
      "Reward specific aerodynamic reasoning.",
    );
  });

  test("offline activity gets NO deliverable (real-world task, unchanged)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedIsUnit(t);

    const activityId = await t.mutation(
      internal.activities.aiCreateForIsUnit,
      {
        lessonId,
        scholarId,
        unitId,
        title: "Go fly it outside",
        kind: "offline",
        systemPrompt: "Real-world flight test.",
      },
    );

    const activity = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(activity?.deliverable).toBeUndefined();
  });

  test("(a) the activity's session resolves auto criteria and scores stars", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedIsUnit(t);
    const asScholar = await withUser(t, scholarId);

    const activityId = await t.mutation(
      internal.activities.aiCreateForIsUnit,
      {
        lessonId,
        scholarId,
        unitId,
        title: "Design a better paper airplane",
        kind: "online",
        systemPrompt: "Help the scholar iterate on a design.",
      },
    );

    // Scholar starts a session on their own quest activity.
    const { id: sessionId } = await asScholar.mutation(api.sessions.create, {
      activityId,
    });

    // Auto-mode → per-scholar criteria generation is scheduled (pending),
    // and a text canvas is seeded so there's something to score.
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.deliverableCriteriaStatus).toBe("pending");
    const artifacts = await t.run(async (ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(artifacts.length).toBe(1);

    // Simulate the generator landing per-scholar criteria (this is what
    // generateCriteriaForSession persists; we skip the Anthropic call).
    await t.mutation(internal.deliverables.persistGeneratedCriteria, {
      sessionId,
      criteria: [
        { id: "specificity", label: "Specificity", description: "Names concrete changes." },
        { id: "reasoning", label: "Reasoning", description: "Explains why each helps." },
      ],
    });

    // The tutor scores the rubric against the SESSION criteria (PR #644).
    const result = await t.mutation(
      internal.deliverables.applyRubricScoreFromTool,
      {
        sessionId,
        verdicts: [
          { criterionId: "specificity", level: "full" },
          { criterionId: "reasoning", level: "full" },
        ],
      },
    );
    expect(result.total).toBe(2);
    expect(result.earned).toBe(2);
    expect(result.passed).toBe(true);
  });

  test("(b) a rubric pass awards flair without completing the activity", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, lessonId } = await seedIsUnit(t);
    const asScholar = await withUser(t, scholarId);

    const activityId = await t.mutation(
      internal.activities.aiCreateForIsUnit,
      {
        lessonId,
        scholarId,
        unitId,
        title: "Design a better paper airplane",
        kind: "online",
        systemPrompt: "Help the scholar iterate.",
      },
    );
    const { id: sessionId } = await asScholar.mutation(api.sessions.create, {
      activityId,
    });
    await t.mutation(internal.deliverables.persistGeneratedCriteria, {
      sessionId,
      criteria: [
        { id: "specificity", label: "Specificity", description: "Concrete." },
      ],
    });

    const score = await t.mutation(
      internal.deliverables.applyRubricScoreFromTool,
      {
        sessionId,
        verdicts: [{ criterionId: "specificity", level: "full" }],
      },
    );
    expect(score.newlyEarnedFlairLabels).toEqual(["Specificity"]);

    const completions = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(completions).toHaveLength(0);

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeUndefined();
    const bigPicture = await asScholar.query(api.sessions.getBigPicture, {
      sessionId,
    });
    expect(bigPicture?.progress?.activities[0].status).toBe("in-progress");
  });

  test("(c) role gate: cannot create an activity in another scholar's IS unit", async () => {
    const t = convexTest(schema, modules);
    const { unitId, lessonId } = await seedIsUnit(t);
    const intruder = await seedUser(t, "scholar");

    await expect(
      t.mutation(internal.activities.aiCreateForIsUnit, {
        lessonId,
        scholarId: intruder,
        unitId,
        title: "Sneaky activity",
        kind: "online",
        systemPrompt: "nope",
      }),
    ).rejects.toThrow(/Forbidden: not your IS unit/);
  });
});
