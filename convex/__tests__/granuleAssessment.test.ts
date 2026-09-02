import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string; readingLevel?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username:
        overrides.username ??
        `test${role}${Math.random().toString(36).slice(2, 6)}`,
      role,
      readingLevel: overrides.readingLevel,
    }),
  );
}

/**
 * An OFFLINE baseline/exit-ticket activity with a materialized deliverable:
 * unit (with granules) → lesson → activity(recipe, offline) → offline session
 * → deliverable. Mirrors what portfolioMaterialize builds.
 */
async function seedOfflineRecipeDeliverable(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
  recipe: "baseline" | "exitTicket",
  deliverableText: string | null,
  kind: "online" | "offline" = "offline",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Autorotation",
      isActive: true,
      essentialQuestions: [
        { key: "eq:a1", text: "How does a spinning rotor store energy?" },
        { key: "eq:a2", text: "What does a pilot do when the engine quits?" },
      ],
      enduringUnderstandings: [
        { key: "eu:a1", text: "Rotating systems store angular momentum." },
      ],
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "The Problem",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Engine Out (written)",
      kind,
      order: 0,
      recipe,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Offline artifact",
      isArchived: true,
      isOffline: kind === "offline",
      unitId,
      activityId,
      assignmentId,
    });
    const deliverableId = await ctx.db.insert("deliverables", {
      activityId,
      scholarId,
      sessionId,
      assignmentId,
      textContent: deliverableText ?? undefined,
      submittedAt: Date.now(),
    });
    return { unitId, activityId, assignmentId, sessionId, deliverableId };
  });
}

describe("granuleAssessment.getArtifactAssessContext (gating)", () => {
  test("returns a bundle for an offline recipe activity with text", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { readingLevel: "grade 7" });
    const { deliverableId } = await seedOfflineRecipeDeliverable(
      t,
      teacherId,
      scholarId,
      "baseline",
      "I think the rotor keeps spinning because of momentum.",
    );
    const bundle = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleAssessment.getArtifactAssessContext, {
        deliverableId,
      }),
    );
    expect(bundle).not.toBeNull();
    expect(bundle?.recipe).toBe("baseline");
    expect(bundle?.granules.map((g) => g.key)).toEqual([
      "eq:a1",
      "eq:a2",
      "eu:a1",
    ]);
    expect(bundle?.assessableText).toContain("momentum");
    expect(bundle?.readingLevel).toBe("grade 7");
  });

  test("returns null when the activity has no recipe", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId, activityId } = await seedOfflineRecipeDeliverable(
      t,
      teacherId,
      scholarId,
      "baseline",
      "some work",
    );
    await t.run(async (ctx) => ctx.db.patch(activityId, { recipe: undefined }));
    const bundle = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleAssessment.getArtifactAssessContext, {
        deliverableId,
      }),
    );
    expect(bundle).toBeNull();
  });

  test("returns null when there is no assessable text yet", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId } = await seedOfflineRecipeDeliverable(
      t,
      teacherId,
      scholarId,
      "exitTicket",
      null,
    );
    const bundle = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleAssessment.getArtifactAssessContext, {
        deliverableId,
      }),
    );
    expect(bundle).toBeNull();
  });

  test("returns null for an ONLINE recipe activity (observer's job, not ours)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId } = await seedOfflineRecipeDeliverable(
      t,
      teacherId,
      scholarId,
      "baseline",
      "I think the rotor keeps spinning.",
      "online",
    );
    const bundle = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleAssessment.getArtifactAssessContext, {
        deliverableId,
      }),
    );
    expect(bundle).toBeNull();
  });

  test("falls back to the portfolio item's extractedText", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId } = await seedOfflineRecipeDeliverable(
      t,
      teacherId,
      scholarId,
      "baseline",
      null,
    );
    await t.run(async (ctx) => {
      const itemId = await ctx.db.insert("portfolioItems", {
        scholarId,
        title: "Engine Out worksheet",
        source: "manual",
        matchStatus: "confirmed",
        processingStatus: "ready",
        extractedText: "The descent powers the rotor — that's the trick.",
      });
      const d = await ctx.db.get(deliverableId);
      await ctx.db.patch(deliverableId, { portfolioItemId: itemId });
      return d;
    });
    const bundle = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleAssessment.getArtifactAssessContext, {
        deliverableId,
      }),
    );
    expect(bundle?.assessableText).toContain("descent powers the rotor");
  });
});

describe("granuleAssessment.applyArtifactAssessment (write path)", () => {
  test("writes phase-stamped evidence and drops unknown keys", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId, sessionId, assignmentId } =
      await seedOfflineRecipeDeliverable(
        t,
        teacherId,
        scholarId,
        "baseline",
        "work",
      );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.granuleAssessment.applyArtifactAssessment, {
        deliverableId,
        attributions: [
          {
            granuleKey: "eq:a1",
            outcome: "demonstrated",
            evidenceSummary: "Explained energy storage.",
            transcriptExcerpt: "the rotor banks angular momentum",
            bloomLevel: "apply",
          },
          {
            granuleKey: "eq:bogus",
            outcome: "probed",
            evidenceSummary: "should be dropped",
            transcriptExcerpt: "x",
          },
        ],
      }),
    );
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("granuleEvidence")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].granuleKey).toBe("eq:a1");
    expect(rows[0].phase).toBe("baseline");
    expect(rows[0].outcome).toBe("demonstrated");
    expect(rows[0].assignmentId).toBe(assignmentId);
  });

  test("does NOT touch an ONLINE session's evidence (no observer-data wipe)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId, sessionId, unitId, assignmentId } =
      await seedOfflineRecipeDeliverable(
        t,
        teacherId,
        scholarId,
        "baseline",
        "typed work",
        "online",
      );
    // Simulate the conversation observer having already written evidence
    // to this online session.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.granuleEvidence.record, {
        scholarId,
        unitId,
        granuleKey: "eq:a1",
        assignmentId,
        sessionId,
        outcome: "demonstrated",
        transcriptExcerpt: "observer-written conversation evidence",
        evidenceSummary: "from the tutor chat",
        phase: "baseline",
      }),
    );
    // The artifact assessor must be a no-op for online activities.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.granuleAssessment.applyArtifactAssessment, {
        deliverableId,
        attributions: [
          {
            granuleKey: "eq:a2",
            outcome: "probed",
            evidenceSummary: "artifact",
            transcriptExcerpt: "x",
          },
        ],
      }),
    );
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("granuleEvidence")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    // The observer's row survives; no artifact row was written.
    expect(rows).toHaveLength(1);
    expect(rows[0].transcriptExcerpt).toBe(
      "observer-written conversation evidence",
    );
  });

  test("exit-ticket recipe stamps phase 'exit'", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId, sessionId } = await seedOfflineRecipeDeliverable(
      t,
      teacherId,
      scholarId,
      "exitTicket",
      "work",
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.granuleAssessment.applyArtifactAssessment, {
        deliverableId,
        attributions: [
          {
            granuleKey: "eu:a1",
            outcome: "demonstrated",
            evidenceSummary: "Transferred the idea.",
            transcriptExcerpt: "like a figure skater",
          },
        ],
      }),
    );
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("granuleEvidence")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("exit");
  });

  test("is idempotent — re-running replaces this project's rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { deliverableId, sessionId } = await seedOfflineRecipeDeliverable(
      t,
      teacherId,
      scholarId,
      "baseline",
      "work",
    );
    const run = (key: string) =>
      t.run(async (ctx) =>
        ctx.runMutation(internal.granuleAssessment.applyArtifactAssessment, {
          deliverableId,
          attributions: [
            {
              granuleKey: key,
              outcome: "probed",
              evidenceSummary: "s",
              transcriptExcerpt: "x",
            },
          ],
        }),
      );
    await run("eq:a1");
    await run("eq:a2");
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("granuleEvidence")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].granuleKey).toBe("eq:a2");
  });
});
