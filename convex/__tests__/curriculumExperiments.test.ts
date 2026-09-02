/**
 * Self-improving curricula — experiment lifecycle gates + data flow.
 *
 * Covers the parts that DON'T need a live model (the Anthropic loop is in
 * the scheduled node action, which we deliberately don't drive here):
 *   - the role gate (only curriculum staff may start/read/cancel),
 *   - input validation (online-only; caller must own supplied profiles),
 *   - the cardinality of a kickoff (baseline variant + default cast + a
 *     running experiment, and the action gets scheduled),
 *   - the internal record/finalize helpers + the cancel-wins invariant.
 *
 * Fixtures copied verbatim from rabbithole-testing.md (seedUser / withUser /
 * seedUnitWithActivity) so a future "extract shared fixtures" pass touches
 * one shape.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  fallbackPreflightResult,
  preflightCoverage,
} from "../lib/curriculumPreflightResult";
import type { ActivityKind } from "../../lib/activityKinds";
import { describeMisconception } from "../lib/curriculumSimShared";

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
      username: overrides.username ?? `test-${role}-${Math.random().toString(36).slice(2, 8)}`,
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
  kind: ActivityKind = "online",
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
      kind,
      systemPrompt: "Guide the scholar to split a shape into two equal parts.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

describe("curriculumExperiments.start — gate + kickoff", () => {
  test("a teacher kicks off: baseline variant + default cast + running experiment + scheduled action", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );

    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.status).toBe("running");
    expect(exp?.mode).toBe("analyze");
    expect(exp?.teacherId).toBe(teacher);
    expect(exp?.baselineVariantId).toBeTruthy();
    expect(exp?.config.castProfileIds.length).toBe(5); // DEFAULT_CAST
    expect(exp?.progress).toEqual({ sessionsDone: 0, sessionsTotal: 5 });

    // Baseline variant snapshots the activity prompt.
    const baseline = await t.run((ctx) => ctx.db.get(exp!.baselineVariantId!));
    expect(baseline?.origin).toBe("baseline");
    expect(baseline?.experimentId).toBe(experimentId);
    expect(baseline?.systemPrompt).toContain("split a shape");

    const runInput = await t.query(
      internal.curriculumExperiments.getRunInput,
      { experimentId },
    );
    expect(runInput.activity.unitDesign).toContain("Unit: Halving Shapes");
    expect(runInput.activity.unitDesign).toContain("Test Lesson");
    expect(runInput.activity.unitDesign).toContain(
      "Guide the scholar to split a shape into two equal parts.",
    );

    // Default cast profiles were created, owned by the teacher.
    const profiles = await t.run((ctx) =>
      ctx.db
        .query("syntheticScholarProfiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", teacher))
        .collect(),
    );
    expect(profiles.length).toBe(5);

    // The node orchestrator was scheduled (not run here — it needs a key).
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.length).toBe(1);
    expect(scheduled[0].name).toContain("curriculumSim");
  });

  test("re-running reuses the owner's default cast (no duplicate profiles)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.curriculumExperiments.start, { activityId });
    await asTeacher.mutation(api.curriculumExperiments.start, { activityId });

    const profiles = await t.run((ctx) =>
      ctx.db
        .query("syntheticScholarProfiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", teacher))
        .collect(),
    );
    expect(profiles.length).toBe(5); // not 10
  });

  test("reports configured and resolved cast counts when a profile disappears", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    await t.run((ctx) => ctx.db.delete(exp!.config.castProfileIds[0]));

    const assembled = await t.query(
      internal.curriculumExperiments.assemblePromptsForVariant,
      { experimentId, systemPrompt: null },
    );

    expect(assembled.expectedCastCount).toBe(5);
    expect(assembled.resolvedCastCount).toBe(4);
    expect(assembled.cast).toHaveLength(4);
  });

  test("a scholar cannot start an experiment (role gate fires)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);

    await expect(
      asScholar.mutation(api.curriculumExperiments.start, { activityId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("rejects a non-online activity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher, "offline");
    const asTeacher = await withUser(t, teacher);

    await expect(
      asTeacher.mutation(api.curriculumExperiments.start, { activityId }),
    ).rejects.toThrow(/online/);
  });

  test("directs Vibecode rehearsal to the manual workshop", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher, "vibecode");
    const asTeacher = await withUser(t, teacher);

    await expect(
      asTeacher.mutation(api.curriculumExperiments.start, { activityId }),
    ).rejects.toThrow(/don't build apps yet.*manually/i);
  });

  test("rejects a supplied profile the caller doesn't own", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const other = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const foreignProfile = await t.run((ctx) =>
      ctx.db.insert("syntheticScholarProfiles", {
        ownerId: other,
        name: "NotYours",
        readingLevel: "Grade 3",
        dossier: "x",
        traits: [],
      }),
    );
    const asTeacher = await withUser(t, teacher);

    await expect(
      asTeacher.mutation(api.curriculumExperiments.start, {
        activityId,
        castProfileIds: [foreignProfile],
      }),
    ).rejects.toThrow(/not owned/);
  });
});

describe("curriculumExperiments.start — propose + loop modes", () => {
  test("propose mode: 2 variants' worth of sessions estimated, config stored", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId, mode: "propose" },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.mode).toBe("propose");
    // baseline + 1 candidate → 2 × 5-kid cast.
    expect(exp?.progress.sessionsTotal).toBe(10);
  });

  test("loop mode: clamps + estimates sessions from generations × variantsPerGen", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId, mode: "loop", generations: 3, variantsPerGen: 2 },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.mode).toBe("loop");
    expect(exp?.config.generations).toBe(3);
    expect(exp?.config.variantsPerGen).toBe(2);
    // (1 baseline + 3*2 candidates) × 5 kids = 35.
    expect(exp?.progress.sessionsTotal).toBe(35);
  });

  test("loop mode clamps absurd budgets to the cost cap", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId, mode: "loop", generations: 999, variantsPerGen: 999 },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.config.generations).toBe(5); // clamped
    expect(exp?.config.variantsPerGen).toBe(3); // clamped
  });
});

describe("curriculumExperiments.promoteVariant", () => {
  async function seedExperimentWithCandidate(
    t: ReturnType<typeof convexTest>,
    teacher: Id<"users">,
  ) {
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId, mode: "propose" },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    const baselineVariantId = exp!.baselineVariantId!;
    // Simulate the node action having inserted a candidate.
    const candidateId = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.createVariant, {
        experimentId,
        activityId,
        parentVariantId: baselineVariantId,
        generation: 1,
        systemPrompt: "Revised: accept a drawing, not just a number.",
        rationale: "kids who drew the answer stalled",
      }),
    );
    return { activityId, experimentId, baselineVariantId, candidateId };
  }

  test("promoting writes the systemPrompt to the activity + marks variants", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId, baselineVariantId, candidateId } =
      await seedExperimentWithCandidate(t, teacher);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.curriculumExperiments.promoteVariant, {
      variantId: candidateId,
    });

    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.systemPrompt).toBe(
      "Revised: accept a drawing, not just a number.",
    );
    const candidate = await t.run((ctx) => ctx.db.get(candidateId));
    expect(candidate?.status).toBe("promoted");
    // The baseline sibling is retired for the audit trail.
    const baseline = (await t.run((ctx) =>
      ctx.db.get(baselineVariantId),
    )) as Doc<"curriculumVariants"> | null;
    expect(baseline?.status).toBe("rejected");
  });

  test("a scholar cannot promote (gate fires)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { candidateId } = await seedExperimentWithCandidate(t, teacher);
    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);

    await expect(
      asScholar.mutation(api.curriculumExperiments.promoteVariant, {
        variantId: candidateId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("curriculumExperiments.cancel", () => {
  test("owner cancels a running experiment", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    await asTeacher.mutation(api.curriculumExperiments.cancel, { experimentId });

    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.status).toBe("cancelled");
  });

  test("a scholar cannot cancel", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );

    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.curriculumExperiments.cancel, { experimentId }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("curriculumExperiments.groundExperiment", () => {
  // Bring an experiment to a terminal state so it's eligible for grounding.
  async function seedFinishedExperiment(
    t: ReturnType<typeof convexTest>,
    teacher: Id<"users">,
  ) {
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId,
        variantId: exp!.baselineVariantId!,
        status: "done" as const,
      }),
    );
    return { activityId, experimentId };
  }

  test("a scholar cannot ground (gate fires)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { experimentId } = await seedFinishedExperiment(t, teacher);
    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);

    await expect(
      asScholar.mutation(api.curriculumExperiments.groundExperiment, {
        experimentId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("rejects a second call while a grounding run is in flight", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { experimentId } = await seedFinishedExperiment(t, teacher);
    const asTeacher = await withUser(t, teacher);

    // First call marks grounding "running" and schedules the action.
    await asTeacher.mutation(api.curriculumExperiments.groundExperiment, {
      experimentId,
    });
    const after = await t.run((ctx) => ctx.db.get(experimentId));
    expect(after?.grounding?.status).toBe("running");

    // Second click while the first is still in flight is rejected.
    await expect(
      asTeacher.mutation(api.curriculumExperiments.groundExperiment, {
        experimentId,
      }),
    ).rejects.toThrow(/already running/);
  });
});

describe("internal record/finalize helpers", () => {
  test("recordSession persists a transcript; finalize writes aggregate + best variant", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    const variantId = exp!.baselineVariantId!;
    const profileId = exp!.config.castProfileIds[0];

    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.recordSession, {
        experimentId,
        variantId,
        profileId,
        transcript: [
          { role: "tutor" as const, content: "hi" },
          { role: "scholar" as const, content: "ok i get it" },
        ],
        stopReason: "goal" as const,
        verdict: { goalAttainment: 5 },
        goalReached: true,
      }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId,
        variantId,
        aggregateScores: { fitness: 4.2, goalAttainmentRate: 1, n: 1 },
        status: "done" as const,
        message: "Done",
      }),
    );

    const after = await t.run((ctx) => ctx.db.get(experimentId));
    expect(after?.status).toBe("done");
    expect(after?.bestVariantId).toBe(variantId);
    const variant = await t.run((ctx) => ctx.db.get(variantId));
    expect(variant?.aggregateScores?.fitness).toBe(4.2);
    const sessions = await t.run((ctx) =>
      ctx.db
        .query("simulatedSessions")
        .withIndex("by_experiment", (q) => q.eq("experimentId", experimentId))
        .collect(),
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0].goalReached).toBe(true);
  });

  test("recordProgress with message omitted preserves the prior message", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );

    // First progress write sets a message.
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.recordProgress, {
        experimentId,
        sessionsDone: 1,
        message: "Simulating Kai…",
      }),
    );
    // Second write omits message — it must NOT clobber the prior one.
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.recordProgress, {
        experimentId,
        sessionsDone: 2,
      }),
    );

    const after = await t.run((ctx) => ctx.db.get(experimentId));
    expect(after?.progress.sessionsDone).toBe(2);
    expect(after?.progress.message).toBe("Simulating Kai…");
  });

  test("recordLiveTurn streams the in-flight conversation; finalize clears it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));

    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.recordLiveTurn, {
        experimentId,
        scholarName: "Pip",
        scholarReadingLevel: "Grade 2",
        transcript: [{ role: "tutor" as const, content: "hello" }],
      }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.recordLiveTurn, {
        experimentId,
        scholarName: "Pip",
        scholarReadingLevel: "Grade 2",
        transcript: [
          { role: "tutor" as const, content: "hello" },
          { role: "scholar" as const, content: "hi!" },
        ],
      }),
    );

    let after = await t.run((ctx) => ctx.db.get(experimentId));
    expect(after?.progress.liveScholarName).toBe("Pip");
    expect(after?.progress.liveTranscript?.length).toBe(2);

    // Terminal finalize wipes the live feed so results show no stale convo.
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId,
        variantId: exp!.baselineVariantId!,
        status: "done" as const,
      }),
    );
    after = await t.run((ctx) => ctx.db.get(experimentId));
    expect(after?.progress.liveScholarName).toBeUndefined();
    expect(after?.progress.liveTranscript).toBeUndefined();
  });

  test("recordLiveTurn no-ops after cancel (won't stream into a closed run)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    await asTeacher.mutation(api.curriculumExperiments.cancel, { experimentId });

    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.recordLiveTurn, {
        experimentId,
        scholarName: "Pip",
        scholarReadingLevel: "Grade 2",
        transcript: [{ role: "tutor" as const, content: "hello" }],
      }),
    );
    const after = await t.run((ctx) => ctx.db.get(experimentId));
    expect(after?.progress.liveScholarName).toBeUndefined(); // never wrote
  });

  test("finalize persists preflightResult and preserves it when a later call omits it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    const variantId = exp!.baselineVariantId!;
    const preflightResult = fallbackPreflightResult(
      preflightCoverage(1, ["goal"], {
        unit: "included",
        lesson: "included",
        resources: "withheld",
        deliverableScoring: "included",
        completion: "withheld",
      }),
    );

    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId,
        variantId,
        status: "done" as const,
        preflightResult,
        message: "Done",
      }),
    );
    const afterFirst = await t.run((ctx) => ctx.db.get(experimentId));
    expect(afterFirst?.preflightResult).toEqual(preflightResult);

    // A later finalize call (e.g. a failure path) that omits preflightResult
    // must NOT wipe the one already recorded.
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId,
        variantId,
        status: "failed" as const,
        error: "boom",
        message: "Experiment failed: boom",
      }),
    );
    const afterSecond = await t.run((ctx) => ctx.db.get(experimentId));
    expect(afterSecond?.preflightResult).toEqual(preflightResult);
  });

  test("finalize does NOT override a cancel that landed mid-run", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);
    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    await asTeacher.mutation(api.curriculumExperiments.cancel, { experimentId });

    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId,
        variantId: exp!.baselineVariantId!,
        status: "done" as const,
      }),
    );

    const after = await t.run((ctx) => ctx.db.get(experimentId));
    expect(after?.status).toBe("cancelled"); // not flipped to done
  });
});

describe("curriculumExperiments.listRunning — global header indicator", () => {
  // Insert an experiment row directly so we can control status / startedAt /
  // standalone activities the start() kickoff path won't produce on its own.
  async function insertExperiment(
    t: ReturnType<typeof convexTest>,
    opts: {
      teacherId: Id<"users">;
      activityId: Id<"activities">;
      status: "running" | "done" | "failed" | "cancelled";
      startedAt: number;
      mode?: "analyze" | "propose" | "loop";
      sessionsDone?: number;
      sessionsTotal?: number;
      message?: string;
    },
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("curriculumExperiments", {
        activityId: opts.activityId,
        teacherId: opts.teacherId,
        mode: opts.mode ?? "analyze",
        config: { castProfileIds: [], maxTurns: 8, learningGoal: "g" },
        status: opts.status,
        progress: {
          sessionsDone: opts.sessionsDone ?? 0,
          sessionsTotal: opts.sessionsTotal ?? 4,
          ...(opts.message ? { message: opts.message } : {}),
        },
        startedAt: opts.startedAt,
      }),
    );
  }

  test("returns only the caller's RUNNING experiments, enriched + newest first", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);

    // Two running (older loop, newer propose) + one done + one cancelled.
    await insertExperiment(t, {
      teacherId: teacher,
      activityId,
      status: "running",
      startedAt: 1000,
      mode: "loop",
      sessionsDone: 3,
      sessionsTotal: 8,
      message: "Improve loop running…",
    });
    await insertExperiment(t, {
      teacherId: teacher,
      activityId,
      status: "running",
      startedAt: 2000,
      mode: "propose",
      sessionsDone: 1,
      sessionsTotal: 2,
    });
    await insertExperiment(t, {
      teacherId: teacher,
      activityId,
      status: "done",
      startedAt: 1500,
    });
    await insertExperiment(t, {
      teacherId: teacher,
      activityId,
      status: "cancelled",
      startedAt: 1800,
    });

    const asTeacher = await withUser(t, teacher);
    const running = await asTeacher.query(
      api.curriculumExperiments.listRunning,
      {},
    );

    // Only the two running rows — done/cancelled excluded.
    expect(running.length).toBe(2);
    // Newest first (startedAt desc): propose (2000) then loop (1000).
    expect(running[0].mode).toBe("propose");
    expect(running[1].mode).toBe("loop");
    // Enrichment: title + owning unit resolved for the deep link.
    expect(running[1].activityTitle).toBe("Halve the rectangle");
    expect(running[1].unitId).toBe(unitId);
    expect(running[1].sessionsDone).toBe(3);
    expect(running[1].sessionsTotal).toBe(8);
    expect(running[1].message).toBe("Improve loop running…");
    // No progress message → null (not undefined), so the UI falls back cleanly.
    expect(running[0].message).toBeNull();
  });

  test("excludes other teachers' running experiments", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher");
    const teacherB = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacherA);
    await insertExperiment(t, {
      teacherId: teacherA,
      activityId,
      status: "running",
      startedAt: 1000,
    });

    const asB = await withUser(t, teacherB);
    const running = await asB.query(api.curriculumExperiments.listRunning, {});
    expect(running.length).toBe(0); // A's run is not B's business
  });

  test("a standalone activity (no lesson) still lists, with unitId null", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const standaloneActivityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        title: "Solo activity",
        kind: "online",
        systemPrompt: "x",
        order: 0,
      }),
    );
    await insertExperiment(t, {
      teacherId: teacher,
      activityId: standaloneActivityId,
      status: "running",
      startedAt: 1000,
    });

    const asTeacher = await withUser(t, teacher);
    const running = await asTeacher.query(
      api.curriculumExperiments.listRunning,
      {},
    );
    expect(running.length).toBe(1);
    expect(running[0].activityTitle).toBe("Solo activity");
    expect(running[0].unitId).toBeNull(); // no lesson → no unit to link to
  });
});

// The Curriculum-Bot tools (in-app Chat + Slack + MCP) call these internal
// mutations with a VERIFIED callerUserId resolved at the action boundary;
// role gating lives in lib/aideTools. They resolve the activity by title
// within a named unit, then delegate to the same coreStart/coreGround the
// public start/groundExperiment use.
describe("curriculumExperiments — aide rehearse/debrief tools", () => {
  test("aideStartRehearsal resolves by partial title and kicks off as the caller", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId } = await seedUnitWithActivity(t, teacher); // "Halve the rectangle", online

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "halve", // case-insensitive partial
        callerUserId: teacher,
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.ok && res.activityDetails).toMatchObject({
      title: "Halve the rectangle",
      kind: "online",
      systemPrompt: "Guide the scholar to split a shape into two equal parts.",
      deliverable: null,
    });

    // One running experiment, owned by the caller, with the action scheduled.
    const exps = await t.run((ctx) =>
      ctx.db.query("curriculumExperiments").collect(),
    );
    expect(exps.length).toBe(1);
    expect(exps[0].teacherId).toBe(teacher);
    expect(exps[0].mode).toBe("analyze");
    expect(exps[0].status).toBe("running");
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled[0].name).toContain("curriculumSim");
  });

  test("aideStartRehearsal with revise runs in propose mode", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId } = await seedUnitWithActivity(t, teacher);

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
        revise: true,
      }),
    );
    expect(res.ok).toBe(true);
    const exp = await t.run((ctx) =>
      ctx.db.query("curriculumExperiments").first(),
    );
    expect(exp?.mode).toBe("propose");
  });

  test("aideStartRehearsal returns ok:false (no throw) for an unknown title", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId } = await seedUnitWithActivity(t, teacher);

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "nonexistent zzz",
        callerUserId: teacher,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/No activity matching/);
    const exps = await t.run((ctx) =>
      ctx.db.query("curriculumExperiments").collect(),
    );
    expect(exps.length).toBe(0); // nothing started
  });

  test("aideStartRehearsal refuses an offline activity (ok:false)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId } = await seedUnitWithActivity(t, teacher, "offline");

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/offline|online/);
  });

  test("aideStartRehearsal explains that Vibecode must be rehearsed manually", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId } = await seedUnitWithActivity(t, teacher, "vibecode");

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/don't build apps yet.*manually/i);
  });

  test("aideGroundLatest returns ok:false when there's no rehearsal yet", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId } = await seedUnitWithActivity(t, teacher);

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideGroundLatest, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/run a Rehearse first/i);
  });

  test("aideGroundLatest grounds the most recent finished rehearsal", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);

    // Start one, then mark it finished (the sim run is a node action we
    // don't drive here).
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );
    const exp = await t.run((ctx) =>
      ctx.db
        .query("curriculumExperiments")
        .withIndex("by_activity", (q) => q.eq("activityId", activityId))
        .first(),
    );
    await t.run((ctx) =>
      ctx.db.patch(exp!._id, { status: "done", finishedAt: Date.now() }),
    );

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideGroundLatest, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );
    expect(res.ok).toBe(true);

    const grounded = await t.run((ctx) => ctx.db.get(exp!._id));
    expect(grounded?.grounding?.status).toBe("running");
    const scheduled = await t.run((ctx) =>
      ctx.db.system
        .query("_scheduled_functions")
        .collect()
        .then((s) => s.filter((f) => f.name.includes("runGrounding"))),
    );
    expect(scheduled.length).toBe(1);
  });

  test("findActivityInUnit prefers an ONLINE match over an offline title-collision", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    // Same lesson: an offline "… (worksheet)" created FIRST (would win a
    // naive first-match), then the online activity the teacher means.
    const { unitId, onlineId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Halving Shapes",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L",
        order: 0,
      });
      await ctx.db.insert("activities", {
        lessonId,
        title: "Halve the rectangle (worksheet)",
        kind: "offline",
        order: 0,
      });
      const onlineId = await ctx.db.insert("activities", {
        lessonId,
        title: "Halve the rectangle",
        kind: "online",
        systemPrompt: "guide",
        order: 1,
      });
      return { unitId, onlineId };
    });

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );
    expect(res.ok).toBe(true); // not refused as "runs offline"
    const exp = await t.run((ctx) =>
      ctx.db.query("curriculumExperiments").first(),
    );
    expect(exp?.activityId).toBe(onlineId); // the online one, not the worksheet
  });

  test("aideGroundLatest debriefs the latest DONE run, skipping a more-recent cancelled one", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);

    // A finished (done) run, then a MORE RECENT cancelled run.
    await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideStartRehearsal, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );
    const first = await t.run((ctx) =>
      ctx.db
        .query("curriculumExperiments")
        .withIndex("by_activity", (q) => q.eq("activityId", activityId))
        .first(),
    );
    await t.run((ctx) =>
      ctx.db.patch(first!._id, { status: "done", finishedAt: Date.now() }),
    );
    const cancelled = await t.run((ctx) =>
      ctx.db.insert("curriculumExperiments", {
        activityId,
        teacherId: teacher,
        mode: "analyze",
        config: { castProfileIds: [], maxTurns: 8, learningGoal: "x" },
        status: "cancelled",
        progress: { sessionsDone: 0, sessionsTotal: 0 },
        startedAt: Date.now() + 1000, // more recent
        finishedAt: Date.now() + 1000,
      }),
    );

    const res = await t.run((ctx) =>
      ctx.runMutation(internal.curriculumExperiments.aideGroundLatest, {
        unitId,
        activityTitle: "Halve the rectangle",
        callerUserId: teacher,
      }),
    );
    expect(res.ok).toBe(true);
    // The DONE run got grounded, not the cancelled one.
    const groundedDone = await t.run((ctx) => ctx.db.get(first!._id));
    const groundedCancelled = await t.run((ctx) => ctx.db.get(cancelled));
    expect(groundedDone?.grounding?.status).toBe("running");
    expect(groundedCancelled?.grounding).toBeUndefined();
  });
});

describe("curriculumExperiments.start — duration-grounded turn budget", () => {
  test("maxTurns auto-populates from the activity's Duration", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "U",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "A",
        kind: "online",
        systemPrompt: "guide",
        order: 0,
        durationMinutes: 30, // → turnsForMinutes(30) = 12
      });
      return { activityId };
    });
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    // 30 min / 2.5 min-per-turn = 12 turns — NOT the old flat 8.
    expect(exp?.config.maxTurns).toBe(12);
  });

  test("no Duration → the default budget (> the old flat 8)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher); // no durationMinutes
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.config.maxTurns).toBe(10); // default 25 min / 2.5
    expect(exp!.config.maxTurns).toBeGreaterThan(8);
  });

  test("an explicit maxTurns still overrides (clamped)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId, maxTurns: 16 },
    );
    const exp = await t.run((ctx) => ctx.db.get(experimentId));
    expect(exp?.config.maxTurns).toBe(16);
  });
});

describe("getGroundInput — scholar feedback feeds the debrief", () => {
  test("flagged tutor turns are carried onto messages + summarized", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { lessonId, activityId } = await seedUnitWithActivity(t, teacher);

    const experimentId = await t.run((ctx) =>
      ctx.db.insert("curriculumExperiments", {
        activityId,
        teacherId: teacher,
        mode: "analyze",
        config: { castProfileIds: [], maxTurns: 8, learningGoal: "g" },
        status: "done",
        progress: { sessionsDone: 0, sessionsTotal: 0 },
        startedAt: 1000,
      }),
    );

    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        title: "Real run",
        isArchived: false,
        lessonId,
        activityId,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "is 2 + 2 = 5?",
        flagged: false,
      });
      const assistantMsg = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Yes, 2 + 2 = 5.",
        flagged: false,
      });
      await ctx.db.insert("messageFlags", {
        sessionId,
        messageId: assistantMsg,
        scholarId: scholar,
        reason: "it's 4",
      });
    });

    const input = await t.query(
      internal.curriculumExperiments.getGroundInput,
      { experimentId },
    );

    expect(input.scholarFeedback.count).toBe(1);
    expect(input.scholarFeedback.examples[0].reason).toBe("it's 4");
    expect(input.scholarFeedback.examples[0].snippet).toContain("2 + 2 = 5");

    const real = input.realSessions[0];
    const flaggedMsg = real.messages.find((m) => m.scholarFlaggedWrong);
    expect(flaggedMsg?.content).toContain("Yes, 2 + 2 = 5.");
    expect(flaggedMsg?.scholarFlagReason).toBe("it's 4");
    // The scholar's own turn carries no flag marker.
    const scholarTurn = real.messages.find((m) => m.role === "user");
    expect(scholarTurn?.scholarFlaggedWrong).toBeUndefined();
  });
});

describe("misconception-scripted cast (adoptable #5)", () => {
  test("Rehearse resolves full activity context without promising unavailable tools", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    await t.run(async (ctx) => {
      const lessonProcessId = await ctx.db.insert("processes", {
        teacherId: teacher,
        title: "Notice and wonder",
        emoji: "🔎",
        steps: [],
        isActive: true,
      });
      const activityProcessId = await ctx.db.insert("processes", {
        teacherId: teacher,
        title: "Fold, compare, explain",
        emoji: "📐",
        steps: [],
        isActive: true,
      });
      const storageId = await ctx.storage.store(
        new Blob(["A rectangle has two equal halves when both parts cover the same area."]),
      );
      await ctx.db.patch(unitId, {
        bigIdea: "Equal parts depend on area, not just appearance.",
        systemPrompt: "Keep the unit centered on equivalence.",
      });
      await ctx.db.patch(lessonId, {
        systemPrompt: "Use folding as the lesson's background model.",
        processId: lessonProcessId,
      });
      await ctx.db.patch(activityId, {
        description: "Investigate several ways to halve one rectangle.",
        processId: activityProcessId,
        deliverable: {
          kind: "text",
          prompt: "Explain how you know both regions are equal.",
          mode: "manual",
          criteria: [
            {
              id: "area-evidence",
              label: "Uses area evidence",
              description: "Compares the amount of space in each region.",
            },
          ],
        },
      });
      await ctx.db.insert("activityResources", {
        activityId,
        title: "Equal-area field note",
        source: {
          kind: "file",
          fileStorageId: storageId,
          fileName: "equal-area.txt",
          mimeType: "text/plain",
          sizeBytes: 72,
        },
        order: 0,
        uploadedBy: teacher,
        extractionStatus: "ready",
        extractedText:
          "A rectangle has two equal halves when both parts cover the same area.",
      });
    });

    const scholar = await seedUser(t, "scholar", {
      name: "Ari Example",
      username: "ari-example",
    });
    const liveSessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        lessonId,
        activityId,
        title: "Live halving session",
        isArchived: false,
      }),
    );
    const liveContext = await t.query(
      internal.sessionHelpers.getSessionContext,
      { sessionId: liveSessionId },
    );
    expect(liveContext?.lessonActivityContext).toMatchObject({
      title: "Halve the rectangle",
      description: "Investigate several ways to halve one rectangle.",
      systemPrompt: "Guide the scholar to split a shape into two equal parts.",
      processTitle: "Fold, compare, explain",
    });
    expect(liveContext?.activityResourceContext?.[0]).toMatchObject({
      title: "Equal-area field note",
      extractedText:
        "A rectangle has two equal halves when both parts cover the same area.",
    });
    expect(liveContext?.standaloneDeliverableContext).toMatchObject({
      prompt: "Explain how you know both regions are equal.",
      rubric: expect.stringContaining("Uses area evidence"),
      isComplete: false,
    });

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );
    const candidatePrompt =
      "Ask the scholar to compare two different folds before explaining.";
    const deliverableRun = await t.query(
      internal.curriculumExperiments.assemblePromptsForVariant,
      { experimentId, systemPrompt: candidatePrompt },
    );
    const deliverablePrompt = deliverableRun.cast[0].firstTurnPrompt;

    expect(deliverablePrompt).toContain('UNIT: "Halving Shapes"');
    expect(deliverablePrompt).toContain(
      "Equal parts depend on area, not just appearance.",
    );
    expect(deliverablePrompt).toContain('LESSON: "Test Lesson"');
    expect(deliverablePrompt).toContain("Use folding as the lesson's background model.");
    expect(deliverablePrompt).toContain("Notice and wonder");
    expect(deliverablePrompt).toContain(
      "Investigate several ways to halve one rectangle.",
    );
    expect(deliverablePrompt).toContain("Fold, compare, explain");
    expect(deliverablePrompt).toContain(candidatePrompt);
    expect(deliverablePrompt).toContain("Equal-area field note");
    expect(deliverablePrompt).toContain(
      "A rectangle has two equal halves when both parts cover the same area.",
    );
    expect(deliverablePrompt).toContain(
      '## Deliverable for "Halve the rectangle"',
    );
    expect(deliverablePrompt).toContain(
      "Explain how you know both regions are equal.",
    );
    expect(deliverablePrompt).toContain("Uses area evidence");
    expect(deliverablePrompt).not.toContain("share_resource");
    expect(deliverablePrompt).not.toContain("update_rubric_score");

    await t.run((ctx) =>
      ctx.db.patch(activityId, {
        deliverable: undefined,
        advanceRubric: {
          criteria: [
            {
              id: "justify-halves",
              label: "Justifies equal halves",
              description: "Explains why the areas match.",
            },
          ],
        },
      }),
    );
    const rubricRun = await t.query(
      internal.curriculumExperiments.assemblePromptsForVariant,
      { experimentId, systemPrompt: candidatePrompt },
    );
    expect(rubricRun.cast[0].laterPrompt).toContain(
      '## Ready-to-advance rubric for "Halve the rectangle"',
    );
    expect(rubricRun.cast[0].laterPrompt).toContain("Justifies equal halves");
    expect(rubricRun.cast[0].laterPrompt).not.toContain("update_rubric_score");

    await t.run((ctx) =>
      ctx.db.patch(activityId, { advanceRubric: undefined }),
    );
    const conversationRun = await t.query(
      internal.curriculumExperiments.assemblePromptsForVariant,
      { experimentId, systemPrompt: candidatePrompt },
    );
    expect(conversationRun.cast[0].laterPrompt).toContain(
      '## Wrapping up "Halve the rectangle"',
    );
    expect(conversationRun.cast[0].laterPrompt).toContain(
      "cannot record completion",
    );
    expect(conversationRun.cast[0].laterPrompt).not.toContain(
      "mark_activity_complete",
    );
  });

  test("a default cast member carries a documented misconception through kickoff", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.curriculumExperiments.start, { activityId });

    const profiles = await t.run((ctx) =>
      ctx.db
        .query("syntheticScholarProfiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", teacher))
        .collect(),
    );
    const scripted = profiles.filter((p) => p.misconception);
    // At least one default cast member is misconception-scripted, and the
    // validated-union field round-tripped through the schema intact.
    expect(scripted.length).toBeGreaterThanOrEqual(1);
    expect(scripted[0].misconception!.pattern).toBe("DROPPED_CARRY");
    // The others stay ordinary.
    expect(profiles.some((p) => !p.misconception)).toBe(true);
  });

  test("assemblePromptsForVariant carries the misconception to the KID but not the TUTOR", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithActivity(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { experimentId } = await asTeacher.mutation(
      api.curriculumExperiments.start,
      { activityId },
    );

    const candidatePrompt =
      "Candidate prompt: derive equal parts from a folded-paper investigation.";
    const { activity, cast } = await t.query(
      internal.curriculumExperiments.assemblePromptsForVariant,
      { experimentId, systemPrompt: candidatePrompt },
    );

    expect(activity.systemPrompt).toBe(candidatePrompt);
    expect(activity.unitDesign).toContain(candidatePrompt);
    expect(activity.unitDesign).not.toContain(
      "Guide the scholar to split a shape into two equal parts.",
    );

    const scripted = cast.find((c) => c.misconception);
    expect(scripted).toBeTruthy();
    expect(scripted!.misconception!.pattern).toBe("DROPPED_CARRY");

    // The buggy-algorithm text is the KID simulator's secret — it must never
    // leak into the TUTOR prompt (else the tutor knows the answer up front).
    const buggyText = describeMisconception("DROPPED_CARRY");
    expect(scripted!.firstTurnPrompt).not.toContain(buggyText);
    expect(scripted!.laterPrompt).not.toContain(buggyText);
  });
});
