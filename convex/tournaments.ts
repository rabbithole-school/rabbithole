import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authedQuery, teacherMutation, teacherQuery } from "./lib/customFunctions";
import type { DeckCard, PrisonersDilemmaSimulatorSpec } from "../lib/simulator/contract";
import {
  DEFAULT_PRISONERS_DILEMMA_ROUNDS,
  PRISONERS_DILEMMA,
} from "../lib/simulator/templates/prisonersDilemma";
import { canonicalJson, sha256Hex } from "../lib/simulator/prompt";
import { reconcileDeckForSpec } from "./simulatorBenches";
import {
  enqueueSimulatorRun,
  type CompiledPolicySource,
} from "./simulatorRuns";
import { simulatorSpecForStorage } from "./seed/systemsAgents";
import { REPLICATOR_GENERATION_COUNT } from "../lib/simulator/replicator";

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type TournamentEntrant = {
  simulatorBenchId: Id<"simulatorBenches">;
  scholarId: Id<"users">;
  sessionId: Id<"sessions">;
  deckLabel: string;
  deckSnapshot: Doc<"tournaments">["entrants"][number]["deckSnapshot"];
  deckVersion: number;
  deckHash: string;
  compiledPolicySource?: { deckHash: string; slotId: string };
};

export type TournamentPairing = Omit<Doc<"tournaments">["pairings"][number], "simulatorEntrantABenchId" | "simulatorEntrantBBenchId"> & {
  simulatorEntrantABenchId: Id<"simulatorBenches">;
  simulatorEntrantBBenchId: Id<"simulatorBenches">;
};
export type TournamentStanding = Omit<Doc<"tournaments">["standings"][number], "simulatorBenchId"> & {
  simulatorBenchId: Id<"simulatorBenches">;
};
export type TournamentRunFact = Pick<Doc<"simulatorRuns">, "status" | "currentMetrics">;
export type ReplicatorGeneration = {
  generation: number;
  shares: Array<{ simulatorBenchId: Id<"simulatorBenches">; populationShare: number }>;
};

export const REPLICATOR_SHARE_FLOOR = 1e-9;
// Payoffs are normalized by the completed tournament's score range, making eta
// comparable across authored payoff matrices instead of a function of their
// score units. At 24 generations and eta 8, the compact chart makes selection
// pressure legible without presenting a second long-running simulation.
export const REPLICATOR_SELECTION_INTENSITY = 8;

export function roundRobinPairs<T>(entrants: readonly T[]): Array<readonly [T, T]> {
  const pairs: Array<readonly [T, T]> = [];
  for (let left = 0; left < entrants.length; left += 1) {
    for (let right = left + 1; right < entrants.length; right += 1) {
      pairs.push([entrants[left], entrants[right]]);
    }
  }
  return pairs;
}

function metric(run: TournamentRunFact, key: string): number {
  return run.currentMetrics.find((entry) => entry.key === key)?.value ?? 0;
}

function runStatus(run: Doc<"simulatorRuns"> | null): TournamentPairing["status"] {
  if (!run) return "failed";
  if (run.status === "queued") return "queued";
  if (run.status === "ticking") return "ticking";
  if (run.status === "completed") return "completed";
  return "failed";
}

export function calculateStandings(
  entrants: readonly TournamentEntrant[],
  pairings: readonly TournamentPairing[],
  runs: ReadonlyMap<Id<"simulatorRuns">, TournamentRunFact>,
): TournamentStanding[] {
  type MutableStanding = TournamentStanding & { cooperations: number; rounds: number };
  const byBench = new Map<Id<"simulatorBenches">, MutableStanding>(
    entrants.map((entrant) => [
      entrant.simulatorBenchId,
      {
        simulatorBenchId: entrant.simulatorBenchId,
        deckLabel: entrant.deckLabel,
        matchesPlayed: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        totalScore: 0,
        cooperationRate: 0,
        forgivenessEvents: 0,
        cooperations: 0,
        rounds: 0,
      },
    ]),
  );
  for (const pairing of pairings) {
    const run = pairing.simulatorRunId ? runs.get(pairing.simulatorRunId) : undefined;
    if (!run || run.status !== "completed") continue;
    const left = byBench.get(pairing.simulatorEntrantABenchId);
    const right = byBench.get(pairing.simulatorEntrantBBenchId);
    if (!left || !right) continue;
    const leftScore = metric(run, "deckA.totalScore");
    const rightScore = metric(run, "deckB.totalScore");
    const rounds = metric(run, "roundsPlayed");
    left.matchesPlayed += 1;
    right.matchesPlayed += 1;
    left.totalScore += leftScore;
    right.totalScore += rightScore;
    left.cooperations += metric(run, "deckA.cooperations");
    right.cooperations += metric(run, "deckB.cooperations");
    left.rounds += rounds;
    right.rounds += rounds;
    left.forgivenessEvents += metric(run, "deckA.forgivenessEvents");
    right.forgivenessEvents += metric(run, "deckB.forgivenessEvents");
    if (leftScore > rightScore) {
      left.wins += 1;
      right.losses += 1;
    } else if (rightScore > leftScore) {
      right.wins += 1;
      left.losses += 1;
    } else {
      left.draws += 1;
      right.draws += 1;
    }
  }
  return [...byBench.values()]
    .map(({ cooperations, rounds, ...standing }) => ({
      ...standing,
      cooperationRate: rounds === 0 ? 0 : cooperations / rounds,
    }))
    .sort(
      (left, right) =>
        right.totalScore - left.totalScore ||
        right.wins - left.wins ||
        left.deckLabel.localeCompare(right.deckLabel),
    );
}

/**
 * Replays the completed round-robin as a population ecology. Each deck's
 * payoff is its opponent-share-weighted mean score, excluding self encounters;
 * shares then follow the standard exponential (logit) replicator update.
 * Generation 0 records equal shares.
 */
export function calculateReplicatorGenerations(
  entrants: readonly TournamentEntrant[],
  pairings: readonly TournamentPairing[],
  runs: ReadonlyMap<Id<"simulatorRuns">, TournamentRunFact>,
): ReplicatorGeneration[] | null {
  if (
    entrants.length < 2 ||
    pairings.length !== (entrants.length * (entrants.length - 1)) / 2
  ) {
    return null;
  }

  const scoreByBench = new Map<Id<"simulatorBenches">, Map<Id<"simulatorBenches">, number>>(
    entrants.map((entrant) => [entrant.simulatorBenchId, new Map()]),
  );
  for (const pairing of pairings) {
    const run = pairing.simulatorRunId ? runs.get(pairing.simulatorRunId) : undefined;
    if (!run || run.status !== "completed") return null;
    const leftScores = scoreByBench.get(pairing.simulatorEntrantABenchId);
    const rightScores = scoreByBench.get(pairing.simulatorEntrantBBenchId);
    if (!leftScores || !rightScores) return null;
    leftScores.set(pairing.simulatorEntrantBBenchId, metric(run, "deckA.totalScore"));
    rightScores.set(pairing.simulatorEntrantABenchId, metric(run, "deckB.totalScore"));
  }

  const simulatorBenchIds = entrants.map((entrant) => entrant.simulatorBenchId);
  const indexByBench = new Map(simulatorBenchIds.map((simulatorBenchId, index) => [simulatorBenchId, index]));
  const scores = [...scoreByBench.values()].flatMap((byOpponent) => [...byOpponent.values()]);
  const scoreRange = Math.max(...scores) - Math.min(...scores);
  const snapshot = (generation: number, shares: readonly number[]): ReplicatorGeneration => ({
    generation,
    shares: simulatorBenchIds.map((simulatorBenchId, index) => ({
      simulatorBenchId,
      populationShare: shares[index],
    })),
  });
  let shares = simulatorBenchIds.map(() => 1 / simulatorBenchIds.length);
  const generations = [snapshot(0, shares)];

  for (let generation = 1; generation <= REPLICATOR_GENERATION_COUNT; generation += 1) {
    const payoffs = simulatorBenchIds.map((simulatorBenchId, index) => {
      const scores = scoreByBench.get(simulatorBenchId)!;
      let weightedScore = 0;
      let opponentShare = 0;
      for (const [opponentId, score] of scores) {
        const opponentIndex = indexByBench.get(opponentId) ?? -1;
        if (opponentIndex === -1 || opponentIndex === index) return NaN;
        weightedScore += score * shares[opponentIndex];
        opponentShare += shares[opponentIndex];
      }
      return opponentShare === 0 ? 0 : weightedScore / opponentShare;
    });
    if (payoffs.some((payoff) => !Number.isFinite(payoff))) return null;

    const normalizedPayoffs =
      scoreRange === 0 ? payoffs.map(() => 0) : payoffs.map((payoff) => payoff / scoreRange);
    // exp(eta * (payoff + c)) multiplies every weight by the same exp(eta * c),
    // which cancels during normalization. Negative authored scores therefore
    // need no per-generation shift and cannot silently alter selection pressure.
    const floored = normalizedPayoffs.map((payoff, index) =>
      Math.max(
        REPLICATOR_SHARE_FLOOR,
        shares[index] * Math.exp(REPLICATOR_SELECTION_INTENSITY * payoff),
      ),
    );
    const total = floored.reduce((sum, share) => sum + share, 0);
    shares = floored.map((share) => share / total);
    generations.push(snapshot(generation, shares));
  }

  return generations;
}

function standingsWithPopulation(
  standings: readonly TournamentStanding[],
  generations: readonly ReplicatorGeneration[] | undefined,
) {
  const finalGeneration = generations?.at(-1);
  if (!generations || !finalGeneration) return [...standings];
  const finalShares = new Map(
    finalGeneration.shares.map((share) => [share.simulatorBenchId, share.populationShare]),
  );
  return standings
    .map((standing) => ({
      ...standing,
      populationShare: finalShares.get(standing.simulatorBenchId) ?? 0,
    }))
    .sort(
      (left, right) =>
        right.populationShare - left.populationShare ||
        right.totalScore - left.totalScore ||
        left.deckLabel.localeCompare(right.deckLabel),
    );
}

function populationHistory(
  generations: readonly ReplicatorGeneration[] | undefined,
  simulatorBenchId: Id<"simulatorBenches">,
) {
  return (
    generations?.map(
      (generation) =>
        generation.shares.find((share) => share.simulatorBenchId === simulatorBenchId)?.populationShare ?? 0,
    ) ?? []
  );
}

function deckLabel(index: number): string {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `Deck ${suffix}`;
}

function assertAssignmentOwner(
  user: Doc<"users">,
  assignment: Doc<"assignments">,
) {
  if (assignment.teacherId !== user._id && user.role !== "platform_admin") {
    throw new Error("Only the assignment teacher can manage this Tournament");
  }
}

async function prisonersDilemmaActivity(
  ctx: DbCtx,
  assignment: Doc<"assignments">,
): Promise<Doc<"activities"> | null> {
  if (!assignment.unitId) return null;
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (query) => query.eq("unitId", assignment.unitId!))
    .collect();
  // A unit may hold a whole PD ladder (e.g. "Cooperation & conflict") whose
  // capstone activity — the one meant for the class tournament — is authored
  // LAST in lesson/activity order by convention. Iterate in order but keep the
  // final match, so the tournament binds the capstone (100-round noisy match)
  // rather than an early teaching rung (e.g. a 20-round noise-free mirror).
  // Last-wins is identical to first-wins for a single-PD unit.
  let latest: Doc<"activities"> | null = null;
  for (const lesson of lessons.sort((left, right) => left.order - right.order)) {
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
      .collect();
    for (const candidate of activities.sort((left, right) => left.order - right.order)) {
      if (
        ["simulator", "simulator"].includes(candidate.kind) &&
        (candidate.simulatorSpec ?? candidate.simulatorSpec)?.templateId === "prisonersDilemma"
      ) {
        latest = candidate;
      }
    }
  }
  return latest;
}

async function latestTournament(ctx: DbCtx, assignmentId: Id<"assignments">) {
  return await ctx.db
    .query("tournaments")
    .withIndex("by_assignment", (query) => query.eq("assignmentId", assignmentId))
    .order("desc")
    .first();
}

async function resolveSimulatorReferences(
  ctx: DbCtx,
  tournament: Doc<"tournaments">,
): Promise<{ entrants: TournamentEntrant[]; pairings: TournamentPairing[] } | null> {
  void ctx;
  return {
    entrants: tournament.entrants,
    pairings: tournament.pairings,
  };
}

async function tournamentRuns(ctx: DbCtx, tournament: Doc<"tournaments">) {
  const references = await resolveSimulatorReferences(ctx, tournament);
  if (!references) return new Map<Id<"simulatorRuns">, Doc<"simulatorRuns">>();
  const rows = await Promise.all(
    references.pairings.map((pairing) =>
      pairing.simulatorRunId ? ctx.db.get(pairing.simulatorRunId) : Promise.resolve(null),
    ),
  );
  return new Map(
    rows
      .filter((run): run is Doc<"simulatorRuns"> => run !== null)
      .map((run) => [run._id, run]),
  );
}

function lessonStats(standings: readonly TournamentStanding[]) {
  const played = standings.reduce((sum, standing) => sum + standing.matchesPlayed, 0);
  const weightedCooperation = standings.reduce(
    (sum, standing) => sum + standing.cooperationRate * standing.matchesPlayed,
    0,
  );
  const forgiving = standings.filter((standing) => standing.forgivenessEvents > 0);
  const other = standings.filter((standing) => standing.forgivenessEvents === 0);
  const meanScore = (rows: readonly TournamentStanding[]) => {
    const matches = rows.reduce((sum, row) => sum + row.matchesPlayed, 0);
    return matches === 0
      ? null
      : rows.reduce((sum, row) => sum + row.totalScore, 0) / matches;
  };
  return {
    cooperationRate: played === 0 ? 0 : weightedCooperation / played,
    forgivenessEvents: standings.reduce(
      (sum, standing) => sum + standing.forgivenessEvents,
      0,
    ),
    forgivingDeckAverageScore: meanScore(forgiving),
    otherDeckAverageScore: meanScore(other),
  };
}

function compositeSpec(source: PrisonersDilemmaSimulatorSpec): PrisonersDilemmaSimulatorSpec {
  const config = PRISONERS_DILEMMA.validateConfig(source.config);
  const rounds = config.rounds ?? DEFAULT_PRISONERS_DILEMMA_ROUNDS;
  const speciesLabel = source.speciesSlots[0].label;
  return {
    ...source,
    config: {
      ...config,
      payoffMatrix: { ...config.payoffMatrix },
    },
    speciesSlots: [
      {
        slotId: "deck_a",
        label: speciesLabel,
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: [{ senseId: "history" }],
      },
      {
        slotId: "deck_b",
        label: speciesLabel,
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: [{ senseId: "history" }],
      },
    ],
    tickBudget: {
      iterationTicks: Math.min(source.tickBudget.iterationTicks, rounds),
      seasonTicks: rounds,
      absoluteMaxTicks: rounds,
    },
  };
}

function compositeDeck(left: TournamentEntrant, right: TournamentEntrant): DeckCard[] {
  const leftCard = left.deckSnapshot[0];
  const rightCard = right.deckSnapshot[0];
  if (!leftCard || !rightCard) throw new Error("Tournament entrant has no strategy card");
  return [
    { slotId: "deck_a", count: 1, prompt: leftCard.prompt },
    { slotId: "deck_b", count: 1, prompt: rightCard.prompt },
  ];
}

export const create = teacherMutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    assertAssignmentOwner(ctx.user, assignment);
    const activity = await prisonersDilemmaActivity(ctx, assignment);
    const activitySpec = activity?.simulatorSpec ?? activity?.simulatorSpec;
    if (!activity || activitySpec?.templateId !== "prisonersDilemma") {
      throw new Error("Assignment has no prisoner's dilemma World");
    }
    const spec = activitySpec as PrisonersDilemmaSimulatorSpec;
    PRISONERS_DILEMMA.validateSpec(spec);
    if (spec.speciesSlots.length !== 1) {
      throw new Error("Tournament authoring requires one self-play strategy slot");
    }
    const previous = await latestTournament(ctx, assignment._id);
    if (previous && (previous.status === "draft" || previous.status === "running")) {
      return {
        tournamentId: previous._id,
        entrantCount: previous.entrants.length,
        reconciledEntrantCount: 0,
      };
    }

    const submissions: Array<{
      bench: Doc<"simulatorBenches">;
      deck: DeckCard[];
      reconciled: boolean;
    }> = [];
    for (const scholarId of assignment.scholarIds) {
      const rows = await ctx.db
        .query("simulatorBenches")
        .withIndex("by_assignment_scholar", (query) =>
          query.eq("assignmentId", assignment._id).eq("scholarId", scholarId),
        )
        .collect();
      const bench = rows.find((candidate) => candidate.activityId === activity._id);
      if (!bench) continue;
      const deck = reconcileDeckForSpec(spec, bench.deck);
      if (deck.length !== 1) {
        throw new Error("Each submitted Tournament deck must contain one strategy card");
      }
      submissions.push({
        bench,
        deck,
        reconciled: canonicalJson(deck) !== canonicalJson(bench.deck),
      });
    }
    submissions.sort((left, right) =>
      String(left.bench._id).localeCompare(String(right.bench._id)),
    );
    if (submissions.length < 2) throw new Error("At least two submitted decks are required");
    const entrants: TournamentEntrant[] = await Promise.all(
      submissions.map(async ({ bench, deck }, index) => ({
        simulatorBenchId: bench._id,
        scholarId: bench.scholarId,
        sessionId: bench.sessionId,
        deckLabel: deckLabel(index),
        deckSnapshot: deck,
        deckVersion: bench.deckVersion,
        deckHash: await sha256Hex(canonicalJson(deck)),
        compiledPolicySource:
          canonicalJson(deck) === canonicalJson(bench.deck)
            ? {
                deckHash: bench.deckHash,
                slotId: bench.deck[0].slotId,
              }
            : undefined,
      })),
    );
    const pairings: TournamentPairing[] = roundRobinPairs(entrants).map(([left, right], index) => ({
      pairingKey: `match-${index + 1}`,
      simulatorEntrantABenchId: left.simulatorBenchId,
      simulatorEntrantBBenchId: right.simulatorBenchId,
      status: "pending",
    }));
    const now = Date.now();
    const tournamentId = await ctx.db.insert("tournaments", {
      assignmentId: assignment._id,
      activityId: activity._id,
      createdBy: ctx.user._id,
      status: "draft",
      simulatorSpecSnapshot: simulatorSpecForStorage(spec),
      entrants,
      pairings,
      standings: calculateStandings(entrants, pairings, new Map()),
      standingsCollapsed: false,
      createdAt: now,
      updatedAt: now,
    });
    return {
      tournamentId,
      entrantCount: entrants.length,
      reconciledEntrantCount: submissions.filter((submission) => submission.reconciled).length,
    };
  },
});

export const start = teacherMutation({
  args: { tournamentId: v.id("tournaments") },
  handler: async (ctx, args) => {
    const tournament = await ctx.db.get(args.tournamentId);
    if (!tournament) throw new Error("Tournament not found");
    const assignment = await ctx.db.get(tournament.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    assertAssignmentOwner(ctx.user, assignment);
    if (tournament.status !== "draft") return { status: tournament.status };
    const tournamentSpec = tournament.simulatorSpecSnapshot ?? tournament.simulatorSpecSnapshot;
    if (tournamentSpec.templateId !== "prisonersDilemma") {
      throw new Error("Tournament World is not a prisoner's dilemma");
    }
    const source = tournamentSpec as PrisonersDilemmaSimulatorSpec;
    PRISONERS_DILEMMA.validateSpec(source);
    const references = await resolveSimulatorReferences(ctx, tournament);
    if (!references) {
      throw new Error("Tournament migration is incomplete; run backfillSimulatorTables first");
    }
    const entrantByBench = new Map(
      references.entrants.map((entrant) => [
        entrant.simulatorBenchId,
        entrant,
      ]),
    );
    const pairings: TournamentPairing[] = [];
    for (const pairing of references.pairings) {
      const left = entrantByBench.get(pairing.simulatorEntrantABenchId!);
      const right = entrantByBench.get(pairing.simulatorEntrantBBenchId!);
      if (!left || !right) throw new Error("Tournament pairing references a missing deck");
      const spec = compositeSpec(source);
      const deck = compositeDeck(left, right);
      const compiledPolicySources: CompiledPolicySource[] = [
        ...(left.compiledPolicySource
          ? [{
              slotId: "deck_a",
              sourceDeckHash: left.compiledPolicySource.deckHash,
              sourceSlotId: left.compiledPolicySource.slotId,
            }]
          : []),
        ...(right.compiledPolicySource
          ? [{
              slotId: "deck_b",
              sourceDeckHash: right.compiledPolicySource.deckHash,
              sourceSlotId: right.compiledPolicySource.slotId,
            }]
          : []),
      ];
      const runId = await enqueueSimulatorRun(ctx, {
        sessionId: left.sessionId,
        scholarId: left.scholarId,
        activityId: tournament.activityId,
        assignmentId: tournament.assignmentId,
        runKind: "season",
        targetTicks: spec.config.rounds ?? DEFAULT_PRISONERS_DILEMMA_ROUNDS,
        deckSnapshot: deck,
        deckVersion: 1,
        compiledPolicySources,
        simulatorSpec: spec,
        budgetBlockKey: `tournament:${tournament._id}`,
        budgetWeekKey: `tournament:${tournament._id}`,
        blockLimitSnapshot: tournament.pairings.length,
        weekLimitSnapshot: tournament.pairings.length,
        tournamentId: tournament._id,
        tournamentPairingKey: pairing.pairingKey,
      });
      pairings.push({
        ...pairing,
        simulatorEntrantABenchId: pairing.simulatorEntrantABenchId!,
        simulatorEntrantBBenchId: pairing.simulatorEntrantBBenchId!,
        status: "queued",
        simulatorRunId: runId,
      });
    }
    const now = Date.now();
    await ctx.db.patch(tournament._id, {
      status: "running",
      pairings,
      startedAt: now,
      updatedAt: now,
    });
    return { status: "running" as const, matchCount: pairings.length };
  },
});

export const refresh = internalMutation({
  args: { tournamentId: v.id("tournaments") },
  handler: async (ctx, args) => {
    const tournament = await ctx.db.get(args.tournamentId);
    if (!tournament) return { status: "missing" as const };
    const references = await resolveSimulatorReferences(ctx, tournament);
    if (!references) {
      return { status: "migration_pending" as const };
    }
    const runs = await tournamentRuns(ctx, tournament);
    const pairings = references.pairings.map((pairing) => ({
      ...pairing,
      status: pairing.simulatorRunId
        ? runStatus(runs.get(pairing.simulatorRunId) ?? null)
        : pairing.status,
    }));
    const terminal = pairings.every(
      (pairing) => pairing.status === "completed" || pairing.status === "failed",
    );
    const failed = pairings.some((pairing) => pairing.status === "failed");
    const generations =
      terminal && !failed
        ? calculateReplicatorGenerations(
            references.entrants,
            pairings as TournamentPairing[],
            runs,
          )
        : undefined;
    const storedGenerations = generations ?? undefined;
    const standings = standingsWithPopulation(
      calculateStandings(
        references.entrants,
        pairings as TournamentPairing[],
        runs,
      ),
      storedGenerations,
    );
    const status = terminal ? (failed ? "failed" : "completed") : tournament.status;
    const now = Date.now();
    await ctx.db.patch(tournament._id, {
      pairings,
      standings,
      replicatorGenerations: storedGenerations,
      status,
      completedAt: terminal ? tournament.completedAt ?? now : undefined,
      updatedAt: now,
    });
    return { status, completed: pairings.filter((pairing) => pairing.status === "completed").length };
  },
});

export const progress = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) return null;
    assertAssignmentOwner(ctx.user, assignment);
    const activity = await prisonersDilemmaActivity(ctx, assignment);
    if (!activity) return null;
    const tournament = await latestTournament(ctx, assignment._id);
    if (!tournament) {
      let submittedDecks = 0;
      for (const scholarId of assignment.scholarIds) {
        const benches = await ctx.db
          .query("simulatorBenches")
          .withIndex("by_assignment_scholar", (query) =>
            query.eq("assignmentId", assignment._id).eq("scholarId", scholarId),
          )
          .collect();
        if (benches.some((bench) => bench.activityId === activity._id)) submittedDecks += 1;
      }
      return {
        tournamentId: null,
        status: "not_created" as const,
        entrantCount: submittedDecks,
        matchCount: 0,
        completedMatches: 0,
        failedMatches: 0,
        standingsCollapsed: false,
      };
    }
    const runs = await tournamentRuns(ctx, tournament);
    const statuses = tournament.pairings.map((pairing) =>
      pairing.simulatorRunId ? runStatus(runs.get(pairing.simulatorRunId) ?? null) : pairing.status,
    );
    return {
      tournamentId: tournament._id,
      status: tournament.status,
      entrantCount: tournament.entrants.length,
      matchCount: tournament.pairings.length,
      completedMatches: statuses.filter((status) => status === "completed").length,
      failedMatches: statuses.filter((status) => status === "failed").length,
      standingsCollapsed: tournament.standingsCollapsed,
    };
  },
});

export const standings = teacherQuery({
  args: { tournamentId: v.id("tournaments") },
  handler: async (ctx, args) => {
    const tournament = await ctx.db.get(args.tournamentId);
    if (!tournament) return null;
    const assignment = await ctx.db.get(tournament.assignmentId);
    if (!assignment) return null;
    assertAssignmentOwner(ctx.user, assignment);
    const runs = await tournamentRuns(ctx, tournament);
    const rows = standingsWithPopulation(
      calculateStandings(
        tournament.entrants as TournamentEntrant[],
        tournament.pairings as TournamentPairing[],
        runs,
      ),
      tournament.replicatorGenerations as ReplicatorGeneration[] | undefined,
    );
    const entrantByBench = new Map(
      tournament.entrants.map((entrant) => [entrant.simulatorBenchId, entrant]),
    );
    return await Promise.all(
      rows.map(async (row) => {
        const entrant = entrantByBench.get(row.simulatorBenchId)!;
        const scholar = await ctx.db.get(entrant.scholarId);
        return {
          ...row,
          populationHistory: populationHistory(
            tournament.replicatorGenerations as ReplicatorGeneration[] | undefined,
            row.simulatorBenchId,
          ),
          scholar: {
            scholarId: entrant.scholarId,
            name: scholar?.name ?? scholar?.username ?? "Scholar",
          },
        };
      }),
    );
  },
});

export const setStandingsCollapsed = teacherMutation({
  args: { tournamentId: v.id("tournaments"), collapsed: v.boolean() },
  handler: async (ctx, args) => {
    const tournament = await ctx.db.get(args.tournamentId);
    if (!tournament) throw new Error("Tournament not found");
    const assignment = await ctx.db.get(tournament.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    assertAssignmentOwner(ctx.user, assignment);
    await ctx.db.patch(tournament._id, {
      standingsCollapsed: args.collapsed,
      updatedAt: Date.now(),
    });
    return { collapsed: args.collapsed };
  },
});

export const forScholar = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== ctx.user._id || !session.assignmentId) return null;
    const tournament = await latestTournament(ctx, session.assignmentId);
    if (!tournament) return null;
    const own = tournament.entrants.find((entrant) => entrant.sessionId === session._id);
    if (!own) return null;
    const runs = await tournamentRuns(ctx, tournament);
    const entrantByBench = new Map(
      tournament.entrants.map((entrant) => [entrant.simulatorBenchId, entrant]),
    );
    const matches = tournament.pairings
      .filter(
        (pairing) =>
          pairing.simulatorEntrantABenchId === own.simulatorBenchId ||
          pairing.simulatorEntrantBBenchId === own.simulatorBenchId,
      )
      .map((pairing) => {
        const ownIsA = pairing.simulatorEntrantABenchId === own.simulatorBenchId;
        const opponent = entrantByBench.get(
          ownIsA ? pairing.simulatorEntrantBBenchId : pairing.simulatorEntrantABenchId,
        )!;
        const run = pairing.simulatorRunId ? runs.get(pairing.simulatorRunId) : undefined;
        return {
          pairingKey: pairing.pairingKey,
          runId: pairing.simulatorRunId ?? null,
          status: run ? runStatus(run) : pairing.status,
          ownDeckLabel: own.deckLabel,
          opponentDeckLabel: opponent.deckLabel,
          ownScore:
            run?.status === "completed"
              ? metric(run, ownIsA ? "deckA.totalScore" : "deckB.totalScore")
              : null,
          opponentScore:
            run?.status === "completed"
              ? metric(run, ownIsA ? "deckB.totalScore" : "deckA.totalScore")
              : null,
          cooperationRate:
            run?.status === "completed"
              ? metric(run, ownIsA ? "deckA.cooperationRate" : "deckB.cooperationRate")
              : null,
          forgivenessEvents:
            run?.status === "completed"
              ? metric(
                  run,
                  ownIsA ? "deckA.forgivenessEvents" : "deckB.forgivenessEvents",
                )
              : null,
        };
      });
    const standings = calculateStandings(
      tournament.entrants as TournamentEntrant[],
      tournament.pairings as TournamentPairing[],
      runs,
    );
    const generations = tournament.replicatorGenerations as ReplicatorGeneration[] | undefined;
    const ownPopulationHistory =
      generations?.map(
        (generation) =>
          generation.shares.find((share) => share.simulatorBenchId === own.simulatorBenchId)?.populationShare ?? 0,
      ) ?? null;
    return {
      tournamentId: tournament._id,
      status: tournament.status,
      ownDeckLabel: own.deckLabel,
      matches,
      lessonStats: lessonStats(standings),
      populationShare:
        ownPopulationHistory === null
          ? null
          : {
              finalShare: ownPopulationHistory.at(-1) ?? 0,
              history: ownPopulationHistory,
              generations: REPLICATOR_GENERATION_COUNT,
            },
    };
  },
});
