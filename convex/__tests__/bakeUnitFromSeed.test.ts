/**
 * Unit tests for the seed→unit "bake" orchestration wiring
 * (convex/bakeUnitFromSeed.ts) + its launch hooks. The LLM design loop itself
 * is NOT exercised here (it needs a live model + is judged by the eval harness,
 * evals/curriculum-sim); these pin the deterministic pieces:
 *   - createFromSeed schedules a bake for TOPIC seeds, not structured ones
 *   - the seed-stamp + session-link mutations (idempotency / ownership / races)
 *   - firstOnlineActivityInUnit ordering
 *   - createScholarQuest bake provenance
 *   - the upgrade-in-place prompt flip (seedOrigin.hasStructure)
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { buildTutorSystemPrompt } from "../sessionStreamHelpers";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withScholar(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${scholarId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

function makeScholar(t: ReturnType<typeof convexTest>, readingLevel?: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Kai",
      username: `kai-${Math.random().toString(36).slice(2)}`,
      role: "scholar",
      ...(readingLevel ? { readingLevel } : {}),
    }),
  );
}

function makeTopicSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  extra?: Partial<Doc<"seeds">>,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "active",
      topic: "Why do octopuses have three hearts?",
      domain: "Biology",
      suggestionType: "frontier",
      rationale: "He keeps circling back to weird sea creatures.",
      connectionTo: "His tide-pool obsession",
      ...extra,
    }),
  );
}

describe("bake: launch hooks (createFromSeed)", () => {
  test("a TOPIC seed launch schedules a background bake on the new session", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const seedId = await makeTopicSeed(t, scholarId);
    const asScholar = await withScholar(t, scholarId);

    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );

    // The session lands anchorless (the warm ad-lib open) ...
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.activityId).toBeUndefined();
    expect(session?.seedId).toBe(seedId);

    // ... and a bake was scheduled to upgrade it in place.
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.length).toBe(1);
    expect(scheduled[0].name).toContain("bakeUnitFromSeed");
  });

  test("the chosen bake path threads into the scheduled bake", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const seedId = await makeTopicSeed(t, scholarId);
    const asScholar = await withScholar(t, scholarId);

    await asScholar.mutation(api.sessions.createFromSeed, {
      seedId,
      bakePath: { title: "Be a sound detective", blurb: "Hunt for the pattern by ear." },
    });

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.length).toBe(1);
    // The scheduled bake carries the scholar's chosen way in.
    const args = scheduled[0].args[0] as { path?: { title: string } };
    expect(args.path?.title).toBe("Be a sound detective");
  });

  test("a structured seed initializes its unit process without a remaining activity", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const { seedId, processId } = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Teacher",
        username: "structured-seed-teacher",
        role: "teacher",
      });
      const processId = await ctx.db.insert("processes", {
        teacherId,
        title: "Notice and wonder",
        steps: [{ key: "notice", title: "Notice" }],
        isActive: true,
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        authorScholarId: scholarId,
        title: "Finished unit",
        isActive: true,
        processId,
      });
      const seedId = await ctx.db.insert("seeds", {
        scholarId,
        origin: "teacher",
        status: "active",
        topic: "Finished unit",
        domain: "Science",
        suggestionType: "frontier",
        rationale: "Continue the thread.",
        connectionTo: "Prior work",
        unitId,
      });
      return { seedId, processId };
    });
    const asScholar = await withScholar(t, scholarId);

    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );
    const scheduled = await t.run((ctx) =>
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
    expect(
      scheduled.some((job) => job.name.includes("bakeUnitFromSeed")),
    ).toBe(false);
  });

  test("getBakeLaunchInfo flags a topic seed (bake) vs a structured seed (no bake)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const asScholar = await withScholar(t, scholarId);

    const topicSeed = await makeTopicSeed(t, scholarId);
    const topicInfo = await asScholar.query(api.seeds.getBakeLaunchInfo, {
      seedId: topicSeed,
    });
    expect(topicInfo?.isTopicSeed).toBe(true);

    const unitId = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: scholarId,
        title: "Offered",
        isActive: true,
        authorScholarId: scholarId,
      }),
    );
    const structuredSeed = await makeTopicSeed(t, scholarId, { unitId });
    const structuredInfo = await asScholar.query(api.seeds.getBakeLaunchInfo, {
      seedId: structuredSeed,
    });
    expect(structuredInfo?.isTopicSeed).toBe(false);
  });

  test("a STRUCTURED seed launch starts the unit's activity and schedules NO bake", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);

    const { unitId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: scholarId,
        title: "Tide Pools",
        isActive: true,
        authorScholarId: scholarId,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Lesson 1",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Explore",
        kind: "online",
        order: 0,
      });
      return { unitId, activityId };
    });
    const seedId = await makeTopicSeed(t, scholarId, { unitId });
    const asScholar = await withScholar(t, scholarId);

    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );

    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.unitId).toBe(unitId);
    expect(session?.activityId).toBe(activityId);

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.some((job) => job.name.includes("bakeUnitFromSeed")),
    ).toBe(false);
  });
});

describe("bake: stampSeedUnit", () => {
  test("stamps a topic seed with the baked unit", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const seedId = await makeTopicSeed(t, scholarId);
    const unitId = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: scholarId,
        title: "U",
        isActive: true,
        authorScholarId: scholarId,
      }),
    );

    await t.mutation(internal.bakeUnitFromSeed.stampSeedUnit, { seedId, unitId });
    const seed = await t.run((ctx) => ctx.db.get(seedId));
    expect(seed?.unitId).toBe(unitId);
  });

  test("does not clobber a seed that already points at a unit", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const [unitA, unitB] = await t.run(async (ctx) => [
      await ctx.db.insert("units", {
        teacherId: scholarId,
        title: "A",
        isActive: true,
        authorScholarId: scholarId,
      }),
      await ctx.db.insert("units", {
        teacherId: scholarId,
        title: "B",
        isActive: true,
        authorScholarId: scholarId,
      }),
    ]);
    const seedId = await makeTopicSeed(t, scholarId, { unitId: unitA });

    await t.mutation(internal.bakeUnitFromSeed.stampSeedUnit, {
      seedId,
      unitId: unitB,
    });
    const seed = await t.run((ctx) => ctx.db.get(seedId));
    expect(seed?.unitId).toBe(unitA); // unchanged
  });
});

describe("bake: firstOnlineActivityInUnit", () => {
  test("returns the first ONLINE activity in lesson→activity order, skipping offline", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const { unitId, onlineId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: scholarId,
        title: "U",
        isActive: true,
        authorScholarId: scholarId,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L1",
        order: 0,
      });
      // An offline activity first (order 0), then the online one (order 1).
      await ctx.db.insert("activities", {
        lessonId,
        title: "Lab demo",
        kind: "offline",
        order: 0,
      });
      const onlineId = await ctx.db.insert("activities", {
        lessonId,
        title: "Rabbithole exploration",
        kind: "online",
        order: 1,
      });
      return { unitId, onlineId };
    });

    const first = await t.query(
      internal.bakeUnitFromSeed.firstOnlineActivityInUnit,
      { unitId },
    );
    expect(first?.activityId).toBe(onlineId);
  });

  test("returns null for a unit with no online activity", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const unitId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: scholarId,
        title: "U",
        isActive: true,
        authorScholarId: scholarId,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L1",
        order: 0,
      });
      await ctx.db.insert("activities", {
        lessonId,
        title: "Lab demo",
        kind: "offline",
        order: 0,
      });
      return unitId;
    });

    const first = await t.query(
      internal.bakeUnitFromSeed.firstOnlineActivityInUnit,
      { unitId },
    );
    expect(first).toBeNull();
  });
});

describe("bake: linkBakedUnitToSession (upgrade in place)", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const seedId = await makeTopicSeed(t, scholarId);
    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );
    const { unitId, lessonId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: scholarId,
        title: "Baked",
        isActive: true,
        authorScholarId: scholarId,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L1",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "A1",
        kind: "online",
        order: 0,
        deliverable: {
          kind: "text",
          prompt: "Write your bet.",
          mode: "auto",
          criteria: [],
        },
      });
      return { unitId, lessonId, activityId };
    });
    return { t, scholarId, sessionId, unitId, lessonId, activityId };
  }

  test("links the activity onto an anchorless session", async () => {
    const { t, scholarId, sessionId, unitId, lessonId, activityId } =
      await setup();
    const res = await t.mutation(
      internal.bakeUnitFromSeed.linkBakedUnitToSession,
      { sessionId, scholarId, unitId, lessonId, activityId },
    );
    expect(res.linked).toBe(true);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.unitId).toBe(unitId);
    expect(session?.lessonId).toBe(lessonId);
    expect(session?.activityId).toBe(activityId);
    expect(session?.deliverableCriteriaStatus).toBe("pending");
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(artifacts).toHaveLength(1);
  });

  test("refuses to reattach when the session already has an activity (race-safe)", async () => {
    const { t, scholarId, sessionId, unitId, lessonId, activityId } =
      await setup();
    // Simulate a prior bake / a started activity.
    await t.run((ctx) =>
      ctx.db.patch(sessionId, { activityId, lessonId, unitId }),
    );
    const res = await t.mutation(
      internal.bakeUnitFromSeed.linkBakedUnitToSession,
      { sessionId, scholarId, unitId, lessonId, activityId },
    );
    expect(res.linked).toBe(false);
  });

  test("refuses when the caller-scholar doesn't own the session", async () => {
    const { t, sessionId, unitId, lessonId, activityId } = await setup();
    const otherScholar = await makeScholar(t);
    const res = await t.mutation(
      internal.bakeUnitFromSeed.linkBakedUnitToSession,
      { sessionId, scholarId: otherScholar, unitId, lessonId, activityId },
    );
    expect(res.linked).toBe(false);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.activityId).toBeUndefined();
  });
});

describe("bake: provenance + context loaders", () => {
  test("createScholarQuest stamps bakedFromSeedId provenance", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const seedId = await makeTopicSeed(t, scholarId);
    const { unitId } = await t.mutation(
      internal.teacherAide.createScholarQuest,
      {
        scholarId,
        authorId: scholarId,
        title: "Octopus Hearts",
        bakedFromSeedId: seedId,
      },
    );
    const unit = await t.run((ctx) => ctx.db.get(unitId));
    expect(unit?.bakedFromSeedId).toBe(seedId);
    expect(unit?.authorScholarId).toBe(scholarId);
  });

  test("loadBakeContextFromSeed exposes topic, reading level, and structured flag", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t, "Grade 4");
    const seedId = await makeTopicSeed(t, scholarId);

    const cx = await t.query(
      internal.bakeUnitFromSeed.loadBakeContextFromSeed,
      { seedId },
    );
    expect(cx?.topic).toBe("Why do octopuses have three hearts?");
    expect(cx?.readingLevel).toBe("Grade 4");
    expect(cx?.alreadyStructuredUnitId).toBeNull();
  });
});

describe("bake: upgrade-in-place prompt flip", () => {
  test("once an activity is linked, the seed-origin section flips from ad-lib to the self-chosen note", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    const seedId = await makeTopicSeed(t, scholarId);
    const asScholar = await withScholar(t, scholarId);
    const { id: sessionId } = await asScholar.mutation(
      api.sessions.createFromSeed,
      { seedId },
    );

    // Before the bake lands: anchorless → ad-lib SESSION FOCUS framing.
    const before = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(before?.seedOriginContext?.hasStructure).toBe(false);
    expect(buildTutorSystemPrompt(before!)).toContain(
      "SESSION FOCUS — SELF-DIRECTED EXPLORATION",
    );

    // Link a baked activity (what the bake does on success).
    const { unitId, lessonId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: scholarId,
        title: "Baked",
        isActive: true,
        authorScholarId: scholarId,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L1",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "A1",
        kind: "online",
        order: 0,
        systemPrompt: "Explore octopus hearts.",
      });
      return { unitId, lessonId, activityId };
    });
    await t.mutation(internal.bakeUnitFromSeed.linkBakedUnitToSession, {
      sessionId,
      scholarId,
      unitId,
      lessonId,
      activityId,
    });

    // After: structured → the prompt drops the "no assigned activity" opener
    // and keeps only the self-chosen provenance note.
    const after = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(after?.seedOriginContext?.hasStructure).toBe(true);
    const prompt = buildTutorSystemPrompt(after!);
    expect(prompt).toContain("ORIGIN — SELF-CHOSEN");
    expect(prompt).not.toContain("SESSION FOCUS — SELF-DIRECTED EXPLORATION");
  });
});
