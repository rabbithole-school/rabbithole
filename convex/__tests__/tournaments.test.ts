import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  calculateReplicatorGenerations,
  calculateStandings,
  roundRobinPairs,
  type TournamentEntrant,
  type TournamentPairing,
  type TournamentRunFact,
} from "../tournaments";
import { REPLICATOR_GENERATION_COUNT } from "../../lib/simulator/replicator";
import {
  COMPILED_POLICY_INTERPRETER_ID,
  type DeckCard,
  type PrisonersDilemmaSimulatorSpec,
} from "../../lib/simulator/contract";
import {
  POLICY_INTERPRETER_VERSION,
  policyCompileContextHash,
  type PolicyIR,
} from "../../lib/simulator/policyIR";
import { getSimulatorTemplate } from "../../lib/simulator/templates/registry";
import { REDACTED_OBSERVATION_JSON } from "../../lib/simulator/screenText";
import { enqueueSimulatorRun } from "../simulatorRuns";
import { simulatorSpecForStorage } from "../seed/systemsAgents";

const createModel = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createModel };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

const SPEC: PrisonersDilemmaSimulatorSpec = {
  version: 1,
  templateId: "prisonersDilemma",
  templateVersion: 1,
  config: {
    rounds: 1,
    noiseProbability: 0,
    payoffMatrix: {
      mutualCooperation: 3,
      temptation: 5,
      sucker: 0,
      mutualDefection: 1,
    },
    maxAutomata: 2,
  },
  criterion: {
    kind: "adversarial",
    scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
  },
  speciesSlots: [
    {
      slotId: "strategy",
      label: "Strategy",
      countMin: 2,
      countMax: 2,
      defaultCount: 2,
      senses: [{ senseId: "history" }],
    },
  ],
  tickBudget: { iterationTicks: 1, seasonTicks: 1, absoluteMaxTicks: 1 },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: false,
};

const COMPILED_SPEC: PrisonersDilemmaSimulatorSpec = {
  ...SPEC,
  interpreter: {
    kind: "scripted",
    interpreterId: COMPILED_POLICY_INTERPRETER_ID,
  },
};

const COOPERATE_POLICY: PolicyIR = {
  version: 1,
  templateId: "prisonersDilemma",
  slotId: "strategy",
  rules: [
    {
      id: "always-cooperate",
      when: [],
      then: {
        kind: "action",
        actionKind: "cooperate",
        target: { kind: "none" },
      },
    },
  ],
  default: { kind: "abstain" },
};

async function withUser(t: T, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedTournament(
  t: T,
  spec: PrisonersDilemmaSimulatorSpec = SPEC,
) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "Tournament Teacher",
      username: "tournament-teacher",
      role: "teacher",
    });
    const scholarIds = await Promise.all(
      ["one", "two", "three"].map((suffix) =>
        ctx.db.insert("users", {
          name: `Scholar ${suffix}`,
          username: `tournament-${suffix}`,
          role: "scholar",
        }),
      ),
    );
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Strategy Lab",
      slug: "strategy-lab",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Forgiveness",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "The Tournament",
      order: 0,
      kind: "simulator",
      simulatorSpec: {
        ...spec,
        criterion: {
          ...spec.criterion,
          scoreMetricKeys: [...spec.criterion.scoreMetricKeys],
        },
        speciesSlots: spec.speciesSlots.map((slot) => ({
          ...slot,
          senses: [...slot.senses],
        })),
      },
    });
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      startedAt: Date.now(),
      selfPaced: true,
    });
    const sessions: Id<"sessions">[] = [];
    const benches: Id<"simulatorBenches">[] = [];
    for (const [index, scholarId] of scholarIds.entries()) {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        assignmentId,
        activityId,
        sessionMode: "workbench",
        title: "Tournament Workbench",
        isArchived: false,
      });
      sessions.push(sessionId);
      benches.push(
        await ctx.db.insert("simulatorBenches", {
          sessionId,
          scholarId,
          activityId,
          assignmentId,
          deck: [
            {
              slotId: "strategy",
              count: 2,
              prompt: index === 0 ? "Always cooperate." : `Strategy ${index + 1}.`,
            },
          ],
          deckVersion: index + 1,
          deckHash: `deck-${index + 1}`,
          runGrants: [],
          lastBenchActivityAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }

    return { teacherId, scholarIds, assignmentId, activityId, sessions, benches };
  });
}

async function seedCompiledPolicies(
  t: T,
  fixture: Awaited<ReturnType<typeof seedTournament>>,
) {
  const template = getSimulatorTemplate(COMPILED_SPEC.templateId);
  if (!template) throw new Error("Prisoner's Dilemma template is missing");
  const slot = COMPILED_SPEC.speciesSlots[0];
  const compileContextHash = await policyCompileContextHash({
    templateId: COMPILED_SPEC.templateId,
    templateVersion: COMPILED_SPEC.templateVersion,
    slotId: slot.slotId,
    senses: slot.senses,
    actionSchema: template.actionSchema,
  });
  await t.run(async (ctx) => {
    for (const [index] of fixture.benches.entries()) {
      await ctx.db.insert("compiledPolicies", {
        deckHash: `deck-${index + 1}`,
        slotId: "strategy",
        templateId: "prisonersDilemma",
        templateVersion: 1,
        compileContextHash,
        status: "ready",
        policy: COOPERATE_POLICY,
        policyHash: `policy-${index + 1}`,
        interpreterVersion: POLICY_INTERPRETER_VERSION,
        compilerModelId: "claude-sonnet-5",
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
}

function modelReply() {
  return {
    content: [
      {
        type: "tool_use",
        name: "choose_action",
        input: {
          action: { kind: "cooperate" },
          reasoning: "Start with cooperation.",
        },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
  };
}

beforeEach(() => {
  createModel.mockReset();
  createModel.mockImplementation(async () => modelReply());
});

describe("Tournament pairing and standings", () => {
  test("builds every unordered round-robin pair exactly once", () => {
    const pairs = roundRobinPairs(["A", "B", "C", "D"]);
    expect(pairs).toEqual([
      ["A", "B"],
      ["A", "C"],
      ["A", "D"],
      ["B", "C"],
      ["B", "D"],
      ["C", "D"],
    ]);
    expect(new Set(pairs.map(([left, right]) => `${left}:${right}`))).toHaveLength(6);
  });

  test("aggregates wins, scores, cooperation, and forgiveness by deck label", () => {
    const benchA = "bench-a" as Id<"simulatorBenches">;
    const benchB = "bench-b" as Id<"simulatorBenches">;
    const benchC = "bench-c" as Id<"simulatorBenches">;
    const runAB = "run-ab" as Id<"simulatorRuns">;
    const runAC = "run-ac" as Id<"simulatorRuns">;
    const entrants: TournamentEntrant[] = [
      {
        simulatorBenchId: benchA,
        scholarId: "scholar-a" as Id<"users">,
        sessionId: "session-a" as Id<"sessions">,
        deckLabel: "Deck A",
        deckSnapshot: [],
        deckVersion: 1,
        deckHash: "a",
      },
      {
        simulatorBenchId: benchB,
        scholarId: "scholar-b" as Id<"users">,
        sessionId: "session-b" as Id<"sessions">,
        deckLabel: "Deck B",
        deckSnapshot: [],
        deckVersion: 1,
        deckHash: "b",
      },
      {
        simulatorBenchId: benchC,
        scholarId: "scholar-c" as Id<"users">,
        sessionId: "session-c" as Id<"sessions">,
        deckLabel: "Deck C",
        deckSnapshot: [],
        deckVersion: 1,
        deckHash: "c",
      },
    ];
    const pairings: TournamentPairing[] = [
      {
        pairingKey: "ab",
        simulatorEntrantABenchId: benchA,
        simulatorEntrantBBenchId: benchB,
        status: "completed",
        simulatorRunId: runAB,
      },
      {
        pairingKey: "ac",
        simulatorEntrantABenchId: benchA,
        simulatorEntrantBBenchId: benchC,
        status: "completed",
        simulatorRunId: runAC,
      },
    ];
    const fact = (
      leftScore: number,
      rightScore: number,
      leftCooperations: number,
      rightCooperations: number,
      leftForgiveness: number,
    ): TournamentRunFact => ({
      status: "completed",
      currentMetrics: [
        { key: "deckA.totalScore", value: leftScore },
        { key: "deckB.totalScore", value: rightScore },
        { key: "deckA.cooperations", value: leftCooperations },
        { key: "deckB.cooperations", value: rightCooperations },
        { key: "deckA.forgivenessEvents", value: leftForgiveness },
        { key: "deckB.forgivenessEvents", value: 0 },
        { key: "roundsPlayed", value: 10 },
      ],
    });
    const standings = calculateStandings(
      entrants,
      pairings,
      new Map([
        [runAB, fact(30, 20, 8, 4, 2)],
        [runAC, fact(15, 15, 6, 5, 1)],
      ]),
    );
    expect(standings[0]).toMatchObject({
      deckLabel: "Deck A",
      matchesPlayed: 2,
      wins: 1,
      draws: 1,
      losses: 0,
      totalScore: 45,
      cooperationRate: 0.7,
      forgivenessEvents: 3,
    });
    expect(standings.find((row) => row.deckLabel === "Deck B")).toMatchObject({
      matchesPlayed: 1,
      losses: 1,
      totalScore: 20,
      cooperationRate: 0.4,
    });
  });

  test("lets AllD surge against a Nice deck", () => {
    const benchIds = ["all-d", "nice", "retaliator-a", "retaliator-b"].map(
      (id) => id as Id<"simulatorBenches">,
    );
    const entrants: TournamentEntrant[] = benchIds.map((benchId, index) => ({
      simulatorBenchId: benchId,
      scholarId: `scholar-${index}` as Id<"users">,
      sessionId: `session-${index}` as Id<"sessions">,
      deckLabel: ["AllD", "Nice", "Retaliator A", "Retaliator B"][index],
      deckSnapshot: [],
      deckVersion: 1,
      deckHash: `${index}`,
    }));
    const scores = [
      [20, 0],
      [1, 1],
      [1, 1],
      [3, 3],
      [3, 3],
      [3, 3],
    ];
    const pairings: TournamentPairing[] = [];
    const runs = new Map<Id<"simulatorRuns">, TournamentRunFact>();
    for (const [[left, right], [leftScore, rightScore]] of roundRobinPairs(benchIds).map(
      (pair, index) => [pair, scores[index]] as const,
    )) {
      const runId = `run-${pairings.length}` as Id<"simulatorRuns">;
      pairings.push({
        pairingKey: `pair-${pairings.length}`,
        simulatorEntrantABenchId: left,
        simulatorEntrantBBenchId: right,
        status: "completed",
        simulatorRunId: runId,
      });
      runs.set(runId, {
        status: "completed",
        currentMetrics: [
          { key: "deckA.totalScore", value: leftScore },
          { key: "deckB.totalScore", value: rightScore },
        ],
      });
    }

    const generations = calculateReplicatorGenerations(entrants, pairings, runs)!;
    const allDShares = generations.map(
      (generation) =>
        generation.shares.find((entry) => entry.simulatorBenchId === benchIds[0])!.populationShare,
    );
    expect(Math.max(...allDShares)).toBeGreaterThan(allDShares[0]);
    expect(generations).toHaveLength(REPLICATOR_GENERATION_COUNT + 1);
  });

  test("keeps an all-nice ecology in equal coexistence and is deterministic", () => {
    const benchIds = ["a", "b", "c"].map((id) => id as Id<"simulatorBenches">);
    const entrants: TournamentEntrant[] = benchIds.map((benchId, index) => ({
      simulatorBenchId: benchId,
      scholarId: `scholar-${index}` as Id<"users">,
      sessionId: `session-${index}` as Id<"sessions">,
      deckLabel: `Deck ${index}`,
      deckSnapshot: [],
      deckVersion: 1,
      deckHash: `${index}`,
    }));
    const pairings = roundRobinPairs(benchIds).map(([left, right], index) => ({
      pairingKey: `pair-${index}`,
      simulatorEntrantABenchId: left,
      simulatorEntrantBBenchId: right,
      status: "completed" as const,
      simulatorRunId: `run-${index}` as Id<"simulatorRuns">,
    }));
    const runs = new Map(
      pairings.map((pairing) => [
        pairing.simulatorRunId,
        {
          status: "completed" as const,
          currentMetrics: [
            { key: "deckA.totalScore", value: 3 },
            { key: "deckB.totalScore", value: 3 },
          ],
        },
      ]),
    );

    const first = calculateReplicatorGenerations(entrants, pairings, runs);
    const second = calculateReplicatorGenerations(entrants, pairings, runs);
    expect(first).toEqual(second);
    expect(first).toHaveLength(REPLICATOR_GENERATION_COUNT + 1);
    for (const generation of first ?? []) {
      for (const entry of generation.shares) {
        expect(entry.populationShare).toBeCloseTo(1 / 3);
      }
    }
  });

  test("keeps an ecology when a permitted match score is negative", () => {
    const benchA = "negative-a" as Id<"simulatorBenches">;
    const benchB = "negative-b" as Id<"simulatorBenches">;
    const runId = "negative-run" as Id<"simulatorRuns">;
    const entrants: TournamentEntrant[] = [benchA, benchB].map((benchId, index) => ({
      simulatorBenchId: benchId,
      scholarId: `scholar-${index}` as Id<"users">,
      sessionId: `session-${index}` as Id<"sessions">,
      deckLabel: `Deck ${index}`,
      deckSnapshot: [],
      deckVersion: 1,
      deckHash: `${index}`,
    }));
    const pairings: TournamentPairing[] = [
      {
        pairingKey: "negative",
        simulatorEntrantABenchId: benchA,
        simulatorEntrantBBenchId: benchB,
        status: "completed",
        simulatorRunId: runId,
      },
    ];
    const generations = calculateReplicatorGenerations(
      entrants,
      pairings,
      new Map([
        [
          runId,
          {
            status: "completed",
            currentMetrics: [
              { key: "deckA.totalScore", value: -3 },
              { key: "deckB.totalScore", value: 5 },
            ],
          },
        ],
      ]),
    );

    expect(generations).toHaveLength(REPLICATOR_GENERATION_COUNT + 1);
    expect(
      generations?.at(-1)?.shares.reduce((sum, entry) => sum + entry.populationShare, 0),
    ).toBeCloseTo(1);
    const scaledGenerations = calculateReplicatorGenerations(
      entrants,
      pairings,
      new Map([
        [
          runId,
          {
            status: "completed",
            currentMetrics: [
              { key: "deckA.totalScore", value: -30 },
              { key: "deckB.totalScore", value: 50 },
            ],
          },
        ],
      ]),
    );
    expect(scaledGenerations).toEqual(generations);
  });
});

describe("Tournament Convex lifecycle", () => {
  test("freezes submitted decks, runs every match through the World engine, and limits scholar reads", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTournament(t);
    const teacher = await withUser(t, fixture.teacherId);
    const created = await teacher.mutation(api.tournaments.create, {
      assignmentId: fixture.assignmentId,
    });
    expect(created.entrantCount).toBe(3);
    expect(created.reconciledEntrantCount).toBe(0);
    const tournamentBefore = await t.run((ctx) => ctx.db.get(created.tournamentId));
    expect(tournamentBefore).toMatchObject({
      status: "draft",
      entrants: expect.arrayContaining([
        expect.objectContaining({ deckLabel: "Deck A", deckSnapshot: expect.any(Array) }),
      ]),
    });
    expect(tournamentBefore?.pairings).toHaveLength(3);

    const started = await teacher.mutation(api.tournaments.start, {
      tournamentId: created.tournamentId,
    });
    expect(started).toEqual({ status: "running", matchCount: 3 });
    const runs = await t.run((ctx) =>
      ctx.db
        .query("simulatorRuns")
        .withIndex("by_tournament", (query) => query.eq("tournamentId", created.tournamentId))
        .collect(),
    );
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.simulatorSpecSnapshot.templateId === "prisonersDilemma")).toBe(
      true,
    );
    expect(runs.every((run) => run.deckSnapshot.map((card) => card.slotId).join(",") === "deck_a,deck_b")).toBe(
      true,
    );
    expect(
      runs.every(
        (run) =>
          run.simulatorSpecSnapshot.speciesSlots.map((slot) => slot.label).join(",") ===
          "Strategy,Strategy",
      ),
    ).toBe(true);
    expect(
      runs.every(
        (run) =>
          (JSON.parse(run.latestSceneJson) as { entities: Array<{ label?: string }> }).entities
            .map((entity) => entity.label)
            .join(",") === "Strategy,Strategy",
      ),
    ).toBe(true);

    for (const run of runs) {
      const result = await t.action(internal.simulatorEngineNode.runTickChunk, {
        runId: run._id,
        startTick: 0,
        expectedAttempt: 0,
      });
      expect(result.kind).toBe("committed");
    }
    await t.mutation(internal.tournaments.refresh, {
      tournamentId: created.tournamentId,
    });

    expect(
      await teacher.query(api.tournaments.progress, {
        assignmentId: fixture.assignmentId,
      }),
    ).toMatchObject({
      status: "completed",
      entrantCount: 3,
      matchCount: 3,
      completedMatches: 3,
    });
    const standings = await teacher.query(api.tournaments.standings, {
      tournamentId: created.tournamentId,
    });
    expect(standings).toHaveLength(3);
    expect(standings?.every((row) => row.matchesPlayed === 2 && row.totalScore === 6)).toBe(
      true,
    );
    expect(standings?.[0]).toHaveProperty("scholar.name");
    expect(standings?.every((row) => row.populationShare !== undefined)).toBe(true);
    expect(standings?.every((row) => row.populationHistory)).toBe(true);
    const tournamentAfter = await t.run((ctx) => ctx.db.get(created.tournamentId));
    expect(tournamentAfter?.replicatorGenerations).toHaveLength(
      REPLICATOR_GENERATION_COUNT + 1,
    );

    const scholar = await withUser(t, fixture.scholarIds[2]);
    const own = await scholar.query(api.tournaments.forScholar, {
      sessionId: fixture.sessions[2],
    });
    expect(own?.matches).toHaveLength(2);
    expect(own).not.toHaveProperty("standings");
    expect(JSON.stringify(own)).not.toContain("Scholar one");
    const replayable = own?.matches.find((match) => match.runId !== null)?.runId;
    expect(replayable).not.toBeNull();
    expect(await scholar.query(api.simulatorRuns.get, { runId: replayable! })).not.toBeNull();
    expect(own?.lessonStats).toMatchObject({
      cooperationRate: 1,
      forgivenessEvents: 0,
    });
    expect(own?.populationShare).toMatchObject({
      finalShare: expect.any(Number),
      history: expect.any(Array),
      generations: REPLICATOR_GENERATION_COUNT,
    });
    expect(own?.populationShare?.history).toHaveLength(REPLICATOR_GENERATION_COUNT + 1);

    const firstPairing = tournamentBefore!.pairings[0];
    const firstRun = runs.find(
      (run) => run.tournamentPairingKey === firstPairing.pairingKey,
    )!;
    const firstEntrant = tournamentBefore!.entrants.find(
      (entrant) => entrant.simulatorBenchId === firstPairing.simulatorEntrantABenchId,
    )!;
    const secondEntrant = tournamentBefore!.entrants.find(
      (entrant) => entrant.simulatorBenchId === firstPairing.simulatorEntrantBBenchId,
    )!;
    const opponent = await withUser(t, secondEntrant.scholarId);
    const opponentDetail = await opponent.query(api.simulatorRuns.get, {
      runId: firstRun._id,
    });
    expect(opponentDetail?.deckSnapshot).toEqual([
      expect.objectContaining({ slotId: "deck_b" }),
    ]);
    const opponentChunk = await opponent.query(api.simulatorRuns.chunk, {
      runId: firstRun._id,
      startTick: 0,
    });
    expect(
      opponentChunk?.ticks[0].automata.find((record) => record.slotId === "deck_a"),
    ).toMatchObject({
      detailsRedacted: true,
      observationJson: REDACTED_OBSERVATION_JSON,
      reasoning: "Opponent strategy details are private.",
      modelResponseJson: "[]",
    });
    expect(
      opponentChunk?.ticks[0].automata.find((record) => record.slotId === "deck_a"),
    ).not.toHaveProperty("source");
    expect(
      opponentChunk?.ticks[0].automata.find((record) => record.slotId === "deck_a"),
    ).not.toHaveProperty("policyTrace");
    const outsiderId = fixture.scholarIds.find(
      (scholarId) =>
        scholarId !== firstEntrant.scholarId && scholarId !== secondEntrant.scholarId,
    )!;
    const outsider = await withUser(t, outsiderId);
    expect(await outsider.query(api.simulatorRuns.get, { runId: firstRun._id })).toBeNull();
    expect(
      await outsider.query(api.simulatorRuns.chunks, { runId: firstRun._id }),
    ).toEqual({ page: [], nextFromTick: null });
  });

  test("runs compiled entrant policies in competition with zero tick-time model calls", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTournament(t, COMPILED_SPEC);
    await seedCompiledPolicies(t, fixture);
    const teacher = await withUser(t, fixture.teacherId);
    const created = await teacher.mutation(api.tournaments.create, {
      assignmentId: fixture.assignmentId,
    });
    await teacher.mutation(api.tournaments.start, {
      tournamentId: created.tournamentId,
    });
    const runs = await t.run((ctx) =>
      ctx.db
        .query("simulatorRuns")
        .withIndex("by_tournament", (query) =>
          query.eq("tournamentId", created.tournamentId),
        )
        .collect(),
    );

    expect(runs).toHaveLength(3);
    expect(
      runs.every(
        (run) =>
          run.compiledPolicySnapshot?.length === 2 &&
          run.compiledPolicySnapshot.every((slot) => slot.status === "ready"),
      ),
    ).toBe(true);
    expect(
      runs.every(
        (run) =>
          run.compiledPolicySnapshot?.map((slot) => slot.slotId).join(",") ===
          "deck_a,deck_b",
      ),
    ).toBe(true);

    for (const run of runs) {
      expect(
        (
          await t.action(internal.simulatorEngineNode.runTickChunk, {
            runId: run._id,
            startTick: 0,
            expectedAttempt: 0,
          })
        ).kind,
      ).toBe("committed");
    }
    const completed = await t.run((ctx) =>
      Promise.all(runs.map((run) => ctx.db.get(run._id))),
    );
    expect(completed.every((run) => run?.modelCallCount === 0)).toBe(true);
    expect(createModel).not.toHaveBeenCalled();
    const chunks = await t.run((ctx) =>
      Promise.all(
        runs.map((run) =>
          ctx.db
            .query("simulatorRunChunks")
            .withIndex("by_run_startTick", (query) =>
              query.eq("runId", run._id).eq("startTick", 0),
            )
            .unique(),
        ),
      ),
    );
    expect(
      chunks.every((chunk) =>
        chunk?.ticks[0].automata.every((record) => record.source === "compiled"),
      ),
    ).toBe(true);
  });

  test("records live-Haiku fallback when an entrant policy is unavailable", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTournament(t, COMPILED_SPEC);
    const teacher = await withUser(t, fixture.teacherId);
    const created = await teacher.mutation(api.tournaments.create, {
      assignmentId: fixture.assignmentId,
    });
    await teacher.mutation(api.tournaments.start, {
      tournamentId: created.tournamentId,
    });
    const run = await t.run((ctx) =>
      ctx.db
        .query("simulatorRuns")
        .withIndex("by_tournament", (query) =>
          query.eq("tournamentId", created.tournamentId),
        )
        .first(),
    );
    expect(run?.compiledPolicySnapshot).toEqual([
      { slotId: "deck_a", status: "fallback", reason: "missing" },
      { slotId: "deck_b", status: "fallback", reason: "missing" },
    ]);

    await t.action(internal.simulatorEngineNode.runTickChunk, {
      runId: run!._id,
      startTick: 0,
      expectedAttempt: 0,
    });
    const chunk = await t.run((ctx) =>
      ctx.db
        .query("simulatorRunChunks")
        .withIndex("by_run_startTick", (query) =>
          query.eq("runId", run!._id).eq("startTick", 0),
        )
        .unique(),
    );
    expect(
      chunk?.ticks[0].automata.map((record) => ({
        source: record.source,
        trace: record.policyTrace,
      })),
    ).toEqual([
      {
        source: "compiled-fallback",
        trace:
          "The compiled policy was unavailable when this run started, so this tick asks Haiku.",
      },
      {
        source: "compiled-fallback",
        trace:
          "The compiled policy was unavailable when this run started, so this tick asks Haiku.",
      },
    ]);
    expect(createModel).toHaveBeenCalledTimes(2);
  });

  test("rehearsal and competition use the same compiled behavior for the same seed", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTournament(t, COMPILED_SPEC);
    await seedCompiledPolicies(t, fixture);
    const benches = await t.run((ctx) =>
      Promise.all(fixture.benches.slice(0, 2).map((benchId) => ctx.db.get(benchId))),
    );
    const left = benches[0]!;
    const right = benches[1]!;
    const competitionSpec: PrisonersDilemmaSimulatorSpec = {
      ...COMPILED_SPEC,
      speciesSlots: [
        {
          slotId: "deck_a",
          label: "Deck A",
          countMin: 1,
          countMax: 1,
          defaultCount: 1,
          senses: [{ senseId: "history" }],
        },
        {
          slotId: "deck_b",
          label: "Deck B",
          countMin: 1,
          countMax: 1,
          defaultCount: 1,
          senses: [{ senseId: "history" }],
        },
      ],
    };
    const competitionDeck: DeckCard[] = [
      { slotId: "deck_a", count: 1, prompt: left.deck[0].prompt },
      { slotId: "deck_b", count: 1, prompt: right.deck[0].prompt },
    ];
    const seed = "same-rehearsal-competition-seed";
    const [rehearsalRunId, competitionRunId] = await t.run(async (ctx) => [
      await enqueueSimulatorRun(ctx, {
        sessionId: left.sessionId,
        scholarId: left.scholarId,
        activityId: fixture.activityId,
        assignmentId: fixture.assignmentId,
        runKind: "season",
        targetTicks: 1,
        deckSnapshot: left.deck,
        deckVersion: left.deckVersion,
        deckHash: left.deckHash,
        simulatorSpec: COMPILED_SPEC,
        seed,
        budgetBlockKey: "rehearsal",
        budgetWeekKey: "rehearsal",
        blockLimitSnapshot: 10,
        weekLimitSnapshot: 10,
      }),
      await enqueueSimulatorRun(ctx, {
        sessionId: left.sessionId,
        scholarId: left.scholarId,
        activityId: fixture.activityId,
        assignmentId: fixture.assignmentId,
        runKind: "season",
        targetTicks: 1,
        deckSnapshot: competitionDeck,
        deckVersion: 1,
        simulatorSpec: competitionSpec,
        compiledPolicySources: [
          {
            slotId: "deck_a",
            sourceDeckHash: left.deckHash,
            sourceSlotId: left.deck[0].slotId,
          },
          {
            slotId: "deck_b",
            sourceDeckHash: right.deckHash,
            sourceSlotId: right.deck[0].slotId,
          },
        ],
        seed,
        budgetBlockKey: "competition",
        budgetWeekKey: "competition",
        blockLimitSnapshot: 10,
        weekLimitSnapshot: 10,
      }),
    ]);

    for (const runId of [rehearsalRunId, competitionRunId]) {
      expect(
        (
          await t.action(internal.simulatorEngineNode.runTickChunk, {
            runId,
            startTick: 0,
            expectedAttempt: 0,
          })
        ).kind,
      ).toBe("committed");
    }
    const [rehearsalChunk, competitionChunk] = await t.run(async (ctx) =>
      Promise.all(
        [rehearsalRunId, competitionRunId].map((runId) =>
          ctx.db
            .query("simulatorRunChunks")
            .withIndex("by_run_startTick", (query) =>
              query.eq("runId", runId).eq("startTick", 0),
            )
            .unique(),
        ),
      ),
    );
    const rehearsalDecision = rehearsalChunk!.ticks[0].automata.find(
      (record) => record.automatonId === "strategy:1",
    )!;
    const competitionDecision = competitionChunk!.ticks[0].automata.find(
      (record) => record.automatonId === "deck_a:1",
    )!;
    expect(competitionDecision).toMatchObject({
      source: rehearsalDecision.source,
      policyRuleId: rehearsalDecision.policyRuleId,
      acceptedActionJson: rehearsalDecision.acceptedActionJson,
    });
    expect(competitionDecision.acceptedActionJson).toBe(
      '{"kind":"cooperate"}',
    );
    expect(createModel).not.toHaveBeenCalled();
  });

  test("transiently reconciles a forked entrant into the shared activity arena", async () => {
    const t = convexTest(schema, modules);
    const fixture = await seedTournament(t);
    const originalDeck = [
      {
        slotId: "renamed_strategy",
        count: 2,
        prompt: "Alternate cooperation after a defection.",
      },
    ];
    await t.run(async (ctx) =>
      ctx.db.patch(fixture.benches[0], {
        effectiveSpec: simulatorSpecForStorage({
          ...SPEC,
          speciesSlots: [
            {
              ...SPEC.speciesSlots[0],
              slotId: "renamed_strategy",
            },
          ],
        }),
        specVersion: 1,
        deck: originalDeck,
      }),
    );
    const teacher = await withUser(t, fixture.teacherId);

    const created = await teacher.mutation(api.tournaments.create, {
      assignmentId: fixture.assignmentId,
    });

    expect(created).toMatchObject({ entrantCount: 3, reconciledEntrantCount: 1 });
    const tournament = await t.run((ctx) => ctx.db.get(created.tournamentId));
    const entrant = tournament?.entrants.find(
      (candidate) => candidate.simulatorBenchId === fixture.benches[0],
    );
    expect(entrant?.deckSnapshot).toEqual([
      { slotId: "strategy", count: 2, prompt: "" },
    ]);
    expect((await t.run((ctx) => ctx.db.get(fixture.benches[0])))?.deck).toEqual(
      originalDeck,
    );
  });
});

describe("Tournament capstone selection", () => {
  // A PD unit may hold a whole ladder of prisonersDilemma world activities (e.g.
  // "Cooperation & conflict"): early teaching rungs plus a final capstone meant
  // for the class tournament. prisonersDilemmaActivity must bind the LAST such
  // activity in lesson/activity order, not the first — otherwise a tournament
  // would run an early rung's physics (few rounds, no noise) instead of the
  // capstone's. Regression for that selection.
  const EARLY_RUNG_SPEC: PrisonersDilemmaSimulatorSpec = {
    ...SPEC,
    config: { ...SPEC.config, rounds: 20, noiseProbability: 0 },
    tickBudget: { iterationTicks: 20, seasonTicks: 20, absoluteMaxTicks: 20 },
  };
  const CAPSTONE_SPEC: PrisonersDilemmaSimulatorSpec = {
    ...SPEC,
    config: { ...SPEC.config, rounds: 100, noiseProbability: 0.08 },
    tickBudget: { iterationTicks: 100, seasonTicks: 100, absoluteMaxTicks: 100 },
  };

  // The canonical persistence-boundary converter — a hand-rolled clone here
  // widens the literal types (string[] vs the exact metric-key tuple) and
  // fails the activities-table validator type under the root tsc project.
  const storedSpec = (spec: PrisonersDilemmaSimulatorSpec) => simulatorSpecForStorage(spec);

  test("binds the last PD world activity in the ladder, not the first", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Ladder Teacher",
        username: "ladder-teacher",
        role: "teacher",
      });
      const scholarIds = await Promise.all(
        ["one", "two"].map((suffix) =>
          ctx.db.insert("users", {
            name: `Ladder Scholar ${suffix}`,
            username: `ladder-${suffix}`,
            role: "scholar",
          }),
        ),
      );
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Cooperation ladder",
        slug: "cooperation-ladder",
        isActive: true,
      });
      // Lesson 0 holds an early rung; lesson 1 holds the capstone. Both are
      // self-play PD world activities (the shape a tournament source requires).
      const earlyLessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "The mirror match",
        order: 0,
      });
      const earlyActivityId = await ctx.db.insert("activities", {
        lessonId: earlyLessonId,
        title: "Meet your own strategy",
        order: 0,
        kind: "simulator",
        simulatorSpec: storedSpec(EARLY_RUNG_SPEC),
      });
      const capstoneLessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "The grand tournament",
        order: 1,
      });
      const capstoneActivityId = await ctx.db.insert("activities", {
        lessonId: capstoneLessonId,
        title: "Enter the class tournament",
        order: 0,
        kind: "simulator",
        simulatorSpec: storedSpec(CAPSTONE_SPEC),
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds,
        startedAt: Date.now(),
        selfPaced: true,
      });
      // Scholars submit their decks on the capstone activity — the one the
      // tournament must bind.
      for (const [index, scholarId] of scholarIds.entries()) {
        const sessionId = await ctx.db.insert("sessions", {
          userId: scholarId,
          assignmentId,
          activityId: capstoneActivityId,
          sessionMode: "workbench",
          title: "Capstone Workbench",
          isArchived: false,
        });
        await ctx.db.insert("simulatorBenches", {
          sessionId,
          scholarId,
          activityId: capstoneActivityId,
          assignmentId,
          deck: [
            {
              slotId: "strategy",
              count: 2,
              prompt: index === 0 ? "Always cooperate." : `Strategy ${index + 1}.`,
            },
          ],
          deckVersion: index + 1,
          deckHash: `capstone-deck-${index + 1}`,
          runGrants: [],
          lastBenchActivityAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return { teacherId, assignmentId, earlyActivityId, capstoneActivityId };
    });

    const teacher = await withUser(t, fixture.teacherId);
    const created = await teacher.mutation(api.tournaments.create, {
      assignmentId: fixture.assignmentId,
    });
    expect(created.entrantCount).toBe(2);

    const tournament = await t.run((ctx) => ctx.db.get(created.tournamentId));
    // Bound the capstone, not the early rung.
    expect(tournament?.activityId).toBe(fixture.capstoneActivityId);
    expect(tournament?.activityId).not.toBe(fixture.earlyActivityId);
    // The frozen source physics is the capstone's (100 rounds / noise 0.08),
    // proving the last-wins selection rather than the first (20 rounds / no noise).
    expect(tournament?.simulatorSpecSnapshot.templateId).toBe("prisonersDilemma");
    const snapshotConfig = (
      tournament?.simulatorSpecSnapshot as PrisonersDilemmaSimulatorSpec
    ).config;
    expect(snapshotConfig.rounds).toBe(100);
    expect(snapshotConfig.noiseProbability).toBe(0.08);
  });
});
