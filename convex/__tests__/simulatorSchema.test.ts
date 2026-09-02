import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const simulatorSpec = {
  version: 1 as const,
  templateId: "ecosystemGrid" as const,
  templateVersion: 2,
  config: {
    width: 4,
    height: 4,
    boundary: "bounded" as const,
    initialResourceDensity: 0.5,
    resourceRegrowthPerTick: 0.25,
    corpseDecayTicks: 3,
    baseMetabolicCost: 1,
    reproductionEnergyThreshold: 12,
    maxAutomata: 4,
    environmentalNoise: { enabled: false, amplitude: 0 },
  },
  criterion: {
    kind: "measured" as const,
    metricKey: "longevity",
    direction: "maximize" as const,
  },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Grazers",
      countMin: 1,
      countMax: 4,
      defaultCount: 2,
      senses: [{ senseId: "vision", range: 2, channels: ["resources"] }],
    },
  ],
  tickBudget: { iterationTicks: 5, seasonTicks: 20, absoluteMaxTicks: 40 },
  interpreter: { kind: "llm" as const, role: "AUTOMATON" as const },
  microWorld: false,
};

describe("world schema", () => {
  test("accepts optional ecosystem terrain and dual-trait heredity config", async () => {
    const t = convexTest(schema, modules);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        title: "Inherited Reef",
        kind: "simulator",
        simulatorSpec: {
          ...simulatorSpec,
          config: {
            ...simulatorSpec.config,
            terrain: {
              shelter: [{ x: 1, y: 1 }],
              current: [{ x: 2, y: 1, direction: "east" as const }],
              shallows: [{ x: 3, y: 1 }],
              predatorSlotIds: [],
            },
            heredity: { enabled: true, mutationStd: 0.1 },
          },
        },
        order: 0,
      }),
    );
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.simulatorSpec?.config).toHaveProperty("heredity", {
      enabled: true,
      mutationStd: 0.1,
    });
    expect(activity?.simulatorSpec?.config).toHaveProperty("terrain", {
      shelter: [{ x: 1, y: 1 }],
      current: [{ x: 2, y: 1, direction: "east" }],
      shallows: [{ x: 3, y: 1 }],
      predatorSlotIds: [],
    });
  });

  test("stores a Workbench aggregate, reactive manifest, and immutable chunk shape", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        name: "Schema Scholar",
        username: "schema-scholar",
        role: "scholar",
      });
      const activityId = await ctx.db.insert("activities", {
        title: "The Reef",
        kind: "simulator",
        simulatorSpec,
        order: 0,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        sessionMode: "workbench",
        title: "Reef Workbench",
        isArchived: false,
      });
      const deck = [{ slotId: "grazer", count: 2, prompt: "Find algae and conserve energy." }];
      const benchId = await ctx.db.insert("simulatorBenches", {
        sessionId,
        scholarId,
        activityId,
        deck,
        deckVersion: 1,
        deckHash: "deck-hash",
        runGrants: [],
        lastBenchActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const runId = await ctx.db.insert("simulatorRuns", {
        sessionId,
        scholarId,
        activityId,
        runKind: "iteration",
        targetTicks: 5,
        deckSnapshot: deck,
        deckVersion: 1,
        deckHash: "deck-hash",
        simulatorSpecSnapshot: simulatorSpec,
        simulatorSpecHash: "spec-hash",
        seed: "00112233445566778899aabbccddeeff",
        status: "completed",
        haltReason: "terminal_physics",
        nextTick: 1,
        attempt: 1,
        chunkCount: 1,
        latestCommittedTick: 1,
        latestChunkStartTick: 0,
        latestCheckpointTick: 1,
        latestSnapshotJson: "{}",
        latestSceneJson: "{}",
        currentMetrics: [{ key: "longevity", value: 1 }],
        summarySeries: [{ tick: 1, values: [{ key: "longevity", value: 1 }] }],
        criterionScores: [{ key: "longevity", value: 1 }],
        invalidActionCount: 0,
        modelCallCount: 1,
        decisionCacheHitCount: 0,
        attemptLog: [],
        budgetState: "reserved",
        budgetBlockKey: "block",
        budgetWeekKey: "week",
        blockLimitSnapshot: 3,
        weekLimitSnapshot: 10,
        modelId: "claude-haiku-4-5-20251001",
        simulatorProtocolVersion: 1,
        promptProtocolVersion: 1,
        decisionHashVersion: 1,
        physicsTemplateVersion: 1,
        rendererProtocolVersion: 1,
        queuedAt: 1,
        startedAt: 2,
        lastCommittedAt: 3,
        endedAt: 3,
        updatedAt: 3,
      });
      const chunkId = await ctx.db.insert("simulatorRunChunks", {
        runId,
        scholarId,
        startTick: 0,
        endTick: 1,
        attempt: 1,
        ticks: [
          {
            tick: 0,
            phase: "day",
            automata: [],
            deltaJson: "{}",
            metrics: [{ key: "longevity", value: 1 }],
            invalidActionCount: 0,
          },
        ],
        checkpoint: {
          tick: 1,
          stateJson: "{}",
          sceneJson: "{}",
          stateHash: "state-hash",
        },
        chunkHash: "chunk-hash",
        createdAt: 3,
      });
      await ctx.db.patch(benchId, { lastRunId: runId });
      return { benchId, runId, chunkId, sessionId };
    });

    const stored = await t.run(async (ctx) => ({
      bench: await ctx.db
        .query("simulatorBenches")
        .withIndex("by_session", (q) => q.eq("sessionId", ids.sessionId))
        .unique(),
      run: await ctx.db.get(ids.runId),
      chunks: await ctx.db
        .query("simulatorRunChunks")
        .withIndex("by_run_startTick", (q) => q.eq("runId", ids.runId))
        .collect(),
    }));

    expect(stored.bench?._id).toBe(ids.benchId);
    expect(stored.run?.simulatorSpecSnapshot.templateId).toBe("ecosystemGrid");
    expect(stored.chunks.map((chunk) => chunk._id)).toEqual([ids.chunkId]);
  });
});
