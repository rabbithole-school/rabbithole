import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  SYSTEMS_AGENTS_UNIT_SLUG,
  insertSystemsAgentsUnit,
  simulatorSpecForStorage,
} from "../seed/systemsAgents";
import type { SimulatorSpec } from "../../lib/simulator/contract";

/**
 * Access-control regression tests for the Stage-F teacher World surfaces
 * (review P0: the reads had a role gate but no row-level scope). Design/Preflight
 * reads ride the canonical curriculum gate (requireUnitEditAccess → any
 * curriculum role, incl. curriculum_designer; scholars rejected). Assignment
 * execution reads additionally require the assignment owner.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function setup() {
  const t = convexTest(schema, modules);
  const teacher = await t.run((ctx) =>
    ctx.db.insert("users", { username: "owner-teacher", name: "Owner", role: "teacher" }),
  );
  const otherTeacher = await t.run((ctx) =>
    ctx.db.insert("users", { username: "other-teacher", name: "Other", role: "teacher" }),
  );
  const designer = await t.run((ctx) =>
    ctx.db.insert("users", { username: "designer", name: "Des", role: "curriculum_designer" }),
  );
  const scholar = await t.run((ctx) =>
    ctx.db.insert("users", { username: "kid", name: "Kid", role: "scholar" }),
  );
  await t.run((ctx) => insertSystemsAgentsUnit(ctx, teacher));
  const { unitId, activityId } = await t.run(async (ctx) => {
    const unit = await ctx.db
      .query("units")
      .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
      .unique();
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (query) => query.eq("unitId", unit!._id))
      .collect();
    const activities = (
      await Promise.all(
        lessons.map((lesson) =>
          ctx.db
            .query("activities")
            .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
            .collect(),
        ),
      )
    ).flat();
    const world = activities.find((a) => a.kind === "simulator");
    return { unitId: unit!._id, activityId: world!._id };
  });
  const assignment = await t.run((ctx) =>
    ctx.db.insert("assignments", {
      teacherId: teacher,
      unitId,
      scholarIds: [scholar],
      startedAt: Date.now(),
    }),
  );
  return { t, teacher, otherTeacher, designer, scholar, unitId, activityId, assignment };
}

async function insertCompletedRun(
  t: ReturnType<typeof convexTest>,
  input: {
    sessionId: Id<"sessions">;
    scholarId: Id<"users">;
    activityId: Id<"activities">;
    assignmentId: Id<"assignments">;
    spec: SimulatorSpec;
    slotId: string;
    metricKey: string;
    score: number;
    queuedAt: number;
    hypothesis?: {
      prediction: "better" | "worse" | "about_the_same" | "exploratory";
      note?: string;
    };
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("simulatorRuns", {
      sessionId: input.sessionId,
      scholarId: input.scholarId,
      activityId: input.activityId,
      assignmentId: input.assignmentId,
      runKind: "iteration",
      targetTicks: 1,
      deckSnapshot: [{ slotId: input.slotId, count: 1, prompt: "Test strategy." }],
      deckVersion: 1,
      deckHash: `deck-${input.queuedAt}`,
      simulatorSpecSnapshot: simulatorSpecForStorage(input.spec),
      simulatorSpecHash: `spec-${input.queuedAt}`,
      seed: `seed-${input.queuedAt}`,
      status: "completed",
      nextTick: 1,
      attempt: 1,
      chunkCount: 1,
      latestCommittedTick: 1,
      latestSnapshotJson: "{}",
      latestSceneJson: "{}",
      currentMetrics: [{ key: input.metricKey, value: input.score }],
      summarySeries: [{ tick: 1, values: [{ key: input.metricKey, value: input.score }] }],
      criterionScores: [{ key: input.metricKey, value: input.score }],
      invalidActionCount: 0,
      modelCallCount: 1,
      decisionCacheHitCount: 0,
      attemptLog: [],
      budgetState: "reserved",
      budgetBlockKey: "block",
      budgetWeekKey: "week",
      blockLimitSnapshot: 3,
      weekLimitSnapshot: 12,
      modelId: "test-model",
      hypothesis: input.hypothesis,
      simulatorProtocolVersion: 1,
      promptProtocolVersion: 1,
      decisionHashVersion: 1,
      physicsTemplateVersion: 1,
      rendererProtocolVersion: 1,
      queuedAt: input.queuedAt,
      startedAt: input.queuedAt,
      endedAt: input.queuedAt + 1,
      updatedAt: input.queuedAt + 1,
    }),
  );
}

describe("simulatorTeacher / worlds design access", () => {
  test("a scholar cannot read the World design or debrief", async () => {
    const { t, scholar, activityId } = await setup();
    const asScholar = await asUser(t, scholar);
    await expect(asScholar.query(api.simulator.simulatorDesign, { activityId })).rejects.toThrow();
    await expect(asScholar.query(api.simulatorTeacher.debrief, { activityId })).rejects.toThrow();
    await expect(asScholar.query(api.simulatorTeacher.preflightStatus, { activityId })).rejects.toThrow();
  });

  test("a curriculum designer CAN read and save the World design (regression fix)", async () => {
    const { t, designer, activityId } = await setup();
    const asDesigner = await asUser(t, designer);
    const design = await asDesigner.query(api.simulator.simulatorDesign, { activityId });
    expect(design?.simulatorSpec).toBeTruthy();
    // Round-trips the existing spec back through validateSpec without throwing.
    await expect(
      asDesigner.mutation(api.simulator.saveSimulatorSpec, {
        activityId,
        spec: design!.simulatorSpec,
      }),
    ).resolves.toEqual({ ok: true });
  });

});

describe("simulatorTeacher assignment execution access", () => {
  test("only the assignment owner can read the live readout", async () => {
    const { t, teacher, otherTeacher, assignment } = await setup();
    const asOwner = await asUser(t, teacher);
    const readout = await asOwner.query(api.simulatorTeacher.assignmentReadout, {
      assignmentId: assignment,
    });
    expect(readout?.paused).toBe(false);

    const asOther = await asUser(t, otherTeacher);
    await expect(
      asOther.query(api.simulatorTeacher.assignmentReadout, { assignmentId: assignment }),
    ).rejects.toThrow();
  });

  test("a non-owner teacher cannot read assignment-scoped Debrief", async () => {
    const { t, otherTeacher, activityId, assignment } = await setup();
    const asOther = await asUser(t, otherTeacher);
    await expect(
      asOther.query(api.simulatorTeacher.debrief, { activityId, assignmentId: assignment }),
    ).rejects.toThrow();
  });

  test("Debrief ranks only activity-spec runs and surfaces forked exploration separately", async () => {
    const { t, teacher, scholar, activityId, assignment } = await setup();
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    if (
      !activity?.simulatorSpec ||
      activity.simulatorSpec.templateId !== "ecosystemGrid" ||
      activity.simulatorSpec.criterion.kind !== "measured"
    ) {
      throw new Error("Expected an ecosystem World fixture");
    }
    const activitySpec = activity.simulatorSpec as Extract<
      SimulatorSpec,
      { templateId: "ecosystemGrid" }
    >;
    const activityMetric = activity.simulatorSpec.criterion.metricKey;
    const forkMetric = activityMetric === "totalEnergy" ? "longevity" : "totalEnergy";
    const forkSpec: SimulatorSpec = {
      ...activitySpec,
      criterion: {
        kind: "measured",
        metricKey: forkMetric,
        direction: "maximize",
      },
      speciesSlots: activitySpec.speciesSlots.map((slot, index) => ({
        ...slot,
        slotId: index === 0 ? "fork-only-slot" : slot.slotId,
        label: index === 0 ? "Scholar-designed species" : slot.label,
      })),
    };
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        activityId,
        assignmentId: assignment,
        sessionMode: "workbench",
        title: "Debrief Workbench",
        isArchived: false,
      }),
    );
    const comparableRunId = await insertCompletedRun(t, {
      sessionId,
      scholarId: scholar,
      activityId,
      assignmentId: assignment,
      spec: activitySpec,
      slotId: activitySpec.speciesSlots[0].slotId,
      metricKey: activityMetric,
      score: 4,
      queuedAt: 1,
      hypothesis: {
        prediction: "better",
        note: "The fish should keep finding food.",
      },
    });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "I still think this run will do better.",
        notebookEntry: {
          kind: "hypothesis",
          runId: comparableRunId,
          prediction: {
            prediction: "better",
            note: "I still think this run will do better.",
          },
        },
        flagged: false,
      }),
    );
    await insertCompletedRun(t, {
      sessionId,
      scholarId: scholar,
      activityId,
      assignmentId: assignment,
      spec: forkSpec,
      slotId: "fork-only-slot",
      metricKey: forkMetric,
      score: 9,
      queuedAt: 2,
    });
    const asOwner = await asUser(t, teacher);

    const result = await asOwner.query(api.simulatorTeacher.debrief, {
      activityId,
      assignmentId: assignment,
    });

    expect(result?.totals).toEqual({
      scholarCount: 1,
      runCount: 2,
      comparableRunCount: 1,
      forkedRunCount: 1,
    });
    expect(result?.trails).toHaveLength(1);
    expect(result?.trails[0].runCount).toBe(1);
    expect(result?.trails[0].hypothesesCount).toBe(1);
    expect(result?.flaggedZeroHypothesis).toEqual([]);
    expect(result?.distribution).toEqual([
      expect.objectContaining({ score: 4, forked: false }),
    ]);
    expect(result?.decks[0].excerpts).toContainEqual({
      kind: "hypothesis",
      text: "better — I still think this run will do better.",
    });
    expect(result?.forkedRuns).toEqual([
      expect.objectContaining({
        scholarId: scholar,
        count: 1,
        bestOnOwnCriterion: 9,
        slots: ["Scholar-designed species"],
        forked: true,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("fork-only-slot");
  });
});

describe("simulatorTeacher pause latch", () => {
  test("pause sets the durable latch; resume clears it", async () => {
    const { t, teacher, assignment } = await setup();
    const asOwner = await asUser(t, teacher);
    await asOwner.mutation(api.simulatorRuns.pauseAssignment, { assignmentId: assignment });
    let readout = await asOwner.query(api.simulatorTeacher.assignmentReadout, {
      assignmentId: assignment,
    });
    expect(readout?.paused).toBe(true);
    await asOwner.mutation(api.simulatorRuns.resumeAssignment, { assignmentId: assignment });
    readout = await asOwner.query(api.simulatorTeacher.assignmentReadout, { assignmentId: assignment });
    expect(readout?.paused).toBe(false);
  });
});
