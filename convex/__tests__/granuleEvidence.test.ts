import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  buildSystemPrompt,
  type GranuleStatusEntry,
} from "../sessionHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Standard fixtures (copy of rabbithole-testing.md shapes) ─────────

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}${Math.random().toString(36).slice(2, 6)}`,
      role,
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedAssignmentWithGranules(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Granule Unit",
      isActive: true,
      essentialQuestions: [
        { key: "eq:r1", text: "What makes a community thrive?" },
        { key: "eq:r2", text: "Who decides the rules?" },
      ],
      enduringUnderstandings: [
        { key: "eu:r1", text: "Communities balance individual and group needs." },
      ],
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [scholarId],
      startedAt: Date.now(),
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Community project",
      isArchived: false,
      unitId,
      assignmentId,
    });
    return { unitId, assignmentId, sessionId };
  });
}

// ── record + coverage derivation ─────────────────────────────────────

describe("granuleEvidence.coverageForAssignment", () => {
  test("derives green/yellow/gray per scholar from evidence rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Kai" });
    const { unitId, assignmentId, sessionId } =
      await seedAssignmentWithGranules(t, teacherId, scholarId);

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.granuleEvidence.record, {
        scholarId,
        unitId,
        granuleKey: "eq:r1",
        assignmentId,
        sessionId,
        outcome: "demonstrated",
        transcriptExcerpt: "because everyone helps",
        evidenceSummary: "Explained mutual aid in own words",
        bloomLevel: "understand",
        phase: "baseline",
      });
      await ctx.runMutation(internal.granuleEvidence.record, {
        scholarId,
        unitId,
        granuleKey: "eq:r2",
        assignmentId,
        sessionId,
        outcome: "probed",
        transcriptExcerpt: "idk maybe the mayor?",
        evidenceSummary: "Engaged but didn't demonstrate",
      });
    });

    const asTeacher = await withUser(t, teacherId);
    const coverage = await asTeacher.query(
      api.granuleEvidence.coverageForAssignment,
      { assignmentId },
    );
    expect(coverage).not.toBeNull();
    expect(coverage!.granules).toHaveLength(3);
    const kai = coverage!.scholars[0];
    expect(kai.name).toBe("Kai");
    expect(kai.cells["eq:r1"].status).toBe("green");
    expect(kai.cells["eq:r1"].evidence[0].phase).toBe("baseline");
    expect(kai.cells["eq:r2"].status).toBe("yellow");
    expect(kai.cells["eu:r1"].status).toBe("gray");
    expect(kai.cells["eu:r1"].evidence).toHaveLength(0);
  });

  test("another teacher's assignment returns null (ownership gate)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { assignmentId } = await seedAssignmentWithGranules(
      t,
      owner,
      scholarId,
    );
    const asOther = await withUser(t, other);
    const coverage = await asOther.query(
      api.granuleEvidence.coverageForAssignment,
      { assignmentId },
    );
    expect(coverage).toBeNull();
  });

  test("scholars are rejected by the teacherQuery gate", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { assignmentId } = await seedAssignmentWithGranules(
      t,
      teacherId,
      scholarId,
    );
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.granuleEvidence.coverageForAssignment, {
        assignmentId,
      }),
    ).rejects.toThrow();
  });

  test("aideCoverage gates on callerUserId ownership", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { assignmentId } = await seedAssignmentWithGranules(
      t,
      owner,
      scholarId,
    );
    const denied = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleEvidence.aideCoverage, {
        callerUserId: other,
        assignmentId,
      }),
    );
    expect(denied).toBeNull();
    const allowed = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleEvidence.aideCoverage, {
        callerUserId: owner,
        assignmentId,
      }),
    );
    expect(allowed?.unitTitle).toBe("Granule Unit");
    expect(allowed?.scholars[0].statuses).toHaveLength(3);
  });

  test("aideCoverage reports before/after movement from baseline→exit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Kai" });
    const { unitId, assignmentId, sessionId } =
      await seedAssignmentWithGranules(t, teacherId, scholarId);
    await t.run(async (ctx) => {
      // eq:r1 — baseline probed, exit demonstrated → improved (yellow→green)
      await ctx.runMutation(internal.granuleEvidence.record, {
        scholarId, unitId, granuleKey: "eq:r1", assignmentId, sessionId,
        outcome: "probed", transcriptExcerpt: "x",
        evidenceSummary: "start", phase: "baseline",
      });
      await ctx.runMutation(internal.granuleEvidence.record, {
        scholarId, unitId, granuleKey: "eq:r1", assignmentId, sessionId,
        outcome: "demonstrated", transcriptExcerpt: "y",
        evidenceSummary: "end", phase: "exit",
      });
      // eq:r2 — baseline only (no exit) → not a comparable pair
      await ctx.runMutation(internal.granuleEvidence.record, {
        scholarId, unitId, granuleKey: "eq:r2", assignmentId, sessionId,
        outcome: "probed", transcriptExcerpt: "z",
        evidenceSummary: "baseline only", phase: "baseline",
      });
    });
    const data = await t.run(async (ctx) =>
      ctx.runQuery(internal.granuleEvidence.aideCoverage, {
        callerUserId: teacherId,
        assignmentId,
      }),
    );
    const eq1 = data!.scholars[0].statuses.find((s) => s.granule.includes("thrive"));
    expect(eq1?.baselineStatus).toBe("yellow");
    expect(eq1?.exitStatus).toBe("green");
    expect(eq1?.improved).toBe(true);
    // Only eq:r1 has BOTH phases → exactly one comparable pair, one improved.
    expect(data!.movement?.comparablePairs).toBe(1);
    expect(data!.movement?.improved).toBe(1);
  });
});

// ── getSessionContext propagation ────────────────────────────────────

describe("getSessionContext — granule plumbing", () => {
  test("exposes granules, statuses, and recipe to the tutor context", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, assignmentId, sessionId } =
      await seedAssignmentWithGranules(t, teacherId, scholarId);

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.granuleEvidence.record, {
        scholarId,
        unitId,
        granuleKey: "eq:r1",
        assignmentId,
        sessionId,
        outcome: "probed",
        transcriptExcerpt: "hmm",
        evidenceSummary: "Wrestled with it",
        phase: "baseline",
      });
    });

    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(context).not.toBeNull();
    expect(context!.granules).toHaveLength(3);
    expect(context!.unitId).toBe(unitId);
    expect(context!.assignmentId).toBe(assignmentId);
    const eq1 = context!.granuleStatusContext!.find((g) => g.key === "eq:r1");
    expect(eq1?.status).toBe("yellow");
    // Baseline-phase rows surface as exit-ticket quote material.
    expect(context!.baselineEvidenceContext![0].granuleText).toBe(
      "What makes a community thrive?",
    );
    // Legacy string-array unit normalizes to the same keyed shape.
    const unitCtx = context!.unitContext!;
    expect(unitCtx.essentialQuestions![0]).toMatchObject({
      key: "eq:r1",
      text: "What makes a community thrive?",
    });
  });
});

// ── Prompt sections ──────────────────────────────────────────────────

function buildPrompt(opts: {
  granuleStatus?: GranuleStatusEntry[] | null;
  recipe?: "baseline" | "exitTicket" | null;
  baseline?: { granuleText: string; evidenceSummary: string; transcriptExcerpt: string }[] | null;
  unit?: boolean;
}) {
  const unitContext = opts.unit === false ? null : {
    title: "Granule Unit",
    description: null,
    systemPrompt: null,
    rubric: null,
    youtubeUrl: null,
    videoTranscript: null,
    bigIdea: null,
    essentialQuestions: [
      { key: "eq:r1", text: "What makes a community thrive?" },
    ],
    enduringUnderstandings: null,
  };
  return buildSystemPrompt(
    null, // teacherWhisper
    null, // readingLevel
    "Kai", // scholarName
    unitContext,
    null, // personaContext
    null, // perspectiveContext
    null, // processContext
    null, // processStateData
    null, // artifactData
    null, // dossierContent
    null, // seedsData
    null, // masteryContext
    null, // signalContext
    null, // timingContext
    null, // lessonContext
    null, // teacherDirectives
    null, // lessonActivityContext
    null, // priorActivityContext
    null, // activityContext
    null, // standaloneDeliverableContext
    null, // currentVerdictsContext
    false, // isFirstTurn
    false, // isFirstSession
    null, // lastSessionAt
    null, // webPracticeContext
    opts.granuleStatus ?? null,
    opts.recipe ?? null,
    opts.baseline ?? null,
  );
}

describe("buildSystemPrompt — granule sections", () => {
  const statusEntries: GranuleStatusEntry[] = [
    { key: "eq:r1", kind: "eq", text: "What makes a community thrive?", status: "gray" },
    { key: "eq:r2", kind: "eq", text: "Who decides the rules?", status: "yellow" },
    { key: "eu:r1", kind: "eu", text: "Communities balance needs.", status: "green" },
  ];

  test("steering section buckets gray/yellow/green", () => {
    const prompt = buildPrompt({ granuleStatus: statusEntries });
    expect(prompt).toContain("UNIT UNDERSTANDING COVERAGE");
    expect(prompt).toContain("Not yet explored");
    expect(prompt).toContain("EQ: What makes a community thrive?");
    expect(prompt).toContain("Touched but not yet demonstrated");
    expect(prompt).toContain("EQ: Who decides the rules?");
    expect(prompt).toContain("Already demonstrated");
    expect(prompt).toContain("EU: Communities balance needs.");
  });

  test("steering is suppressed on recipe activities", () => {
    const prompt = buildPrompt({
      granuleStatus: statusEntries,
      recipe: "baseline",
    });
    expect(prompt).not.toContain("UNIT UNDERSTANDING COVERAGE");
    expect(prompt).toContain("BASELINE CONVERSATION");
    expect(prompt).toContain("DON'T teach");
  });

  test("exit ticket quotes the scholar's baseline answers", () => {
    const prompt = buildPrompt({
      recipe: "exitTicket",
      baseline: [
        {
          granuleText: "What makes a community thrive?",
          evidenceSummary: "Thought it was just money",
          transcriptExcerpt: "communities need money to work",
        },
      ],
    });
    expect(prompt).toContain("EXIT-TICKET CONVERSATION");
    expect(prompt).toContain("communities need money to work");
    expect(prompt).toContain("what do you think now?");
    expect(prompt).toContain("Preserve ownership of the conclusion");
    expect(prompt).toContain("ask once what they would tell their earlier self");
    expect(prompt).toContain(
      "Once they have named the change and applied it to a concrete example",
    );
    expect(prompt).not.toContain("End on how far they've come, named concretely");
  });

  test("no unit / no granules → no sections", () => {
    const prompt = buildPrompt({ unit: false, recipe: "baseline" });
    expect(prompt).not.toContain("BASELINE CONVERSATION");
    expect(prompt).not.toContain("UNIT UNDERSTANDING COVERAGE");
  });
});
