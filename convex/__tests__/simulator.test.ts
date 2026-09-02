import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  BUILT_TO_LAST_SIMULATOR_SPEC,
  LEAVE_ENOUGH_SIMULATOR_SPEC,
  REEF_SIMULATOR_SPEC,
  SHARED_SHOAL_SIMULATOR_SPEC,
  SYSTEMS_AGENTS_LESSONS,
  SYSTEMS_AGENTS_UNIT_SLUG,
  SIMULATOR_FLIPS_SIMULATOR_SPEC,
  TWO_HUNTERS_SIMULATOR_SPEC,
  insertSystemsAgentsUnit,
  simulatorSpecForStorage,
} from "../seed/systemsAgents";
import { getSimulatorTemplate } from "../../lib/simulator/templates/registry";
import { validateDeckForSpec, reconcileDeckForSpec } from "../simulatorBenches";
import type { EcosystemGridSimulatorSpec, LaunchedSpecies } from "../../lib/simulator/contract";
import {
  DECISION_SPACE_SEEDS,
  runEcosystem,
  mean,
  restAlways,
  informedSeekFactory,
  nearOnlyFactory,
  farCommitFactory,
  greedyGrazerFactory,
  shelterCyclerFactory,
  openRationerFactory,
  fleeBreedGrazerFactory,
  sharkFactory,
  type EcoPolicyFactory,
} from "../../lib/simulator/testing/decisionSpaceHarness";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("Systems & Agents seed", () => {
  test("reconciles the full arc (micro-worlds, reef, commons, generations) idempotently", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await t.run((ctx) =>
      ctx.db.insert("users", {
        username: "world-teacher",
        name: "World Teacher",
        role: "teacher",
      }),
    );

    await t.run((ctx) => insertSystemsAgentsUnit(ctx, teacherId));
    const second = await t.run((ctx) => insertSystemsAgentsUnit(ctx, teacherId));
    expect(second).toEqual({ unitCreated: false, lessonsCreated: 0, activitiesCreated: 0 });

    const seeded = await t.run(async (ctx) => {
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
      return { unit, lessons, activities };
    });

    expect(seeded.unit?.title).toBe("Systems & Agents");
    expect(seeded.lessons.map((lesson) => lesson.title).sort()).toEqual([
      "First Automaton",
      "Generations",
      "The Reef",
    ]);
    expect(seeded.activities.map((activity) => activity.title).sort()).toEqual([
      "Built to last",
      "Leave enough behind",
      "The Reef",
      "The ebbing tide",
      "The far feast",
      "The shared shoal",
      "Two hunters",
      "When the world flips",
    ]);
    expect(seeded.activities.filter((activity) => activity.simulatorSpec?.microWorld)).toHaveLength(4);
    expect(REEF_SIMULATOR_SPEC.tickBudget).toEqual({
      iterationTicks: 60,
      seasonTicks: 200,
      absoluteMaxTicks: 200,
    });
    expect(REEF_SIMULATOR_SPEC.speciesSlots.map((slot) => slot.slotId)).toEqual([
      "grazer",
      "predator",
      "cleaner",
      "open_niche",
    ]);
  });
});

describe("Systems & Agents world specs", () => {
  test("every authored spec passes the real ecosystemGrid validator (authored + stored)", () => {
    const template = getSimulatorTemplate("ecosystemGrid");
    expect(template).not.toBeNull();
    const specs = SYSTEMS_AGENTS_LESSONS.flatMap((lesson) =>
      lesson.activities.map((activity) => activity.simulatorSpec),
    );
    expect(specs.length).toBe(8);
    for (const spec of specs) {
      expect(() => template!.validateSpec(spec)).not.toThrow();
      expect(() => template!.validateSpec(simulatorSpecForStorage(spec))).not.toThrow();
    }
  });

  test("the on-ramp micro-worlds each pose a real choice under honest physics", () => {
    const firstAutomaton = SYSTEMS_AGENTS_LESSONS.find(
      (lesson) => lesson.title === "First Automaton",
    )!;
    const byTitle = new Map(
      firstAutomaton.activities.map((activity) => [activity.title, activity.simulatorSpec]),
    );
    expect([...byTitle.keys()]).toEqual([
      "The ebbing tide",
      "Leave enough behind",
      "The far feast",
      "Two hunters",
    ]);

    // No on-ramp world rewards stripping the reef: the old minimize-resourceBiomass
    // criterion (which literally rewarded ecological vandalism) is gone for good.
    for (const [title, spec] of byTitle) {
      if (title === "Two hunters") continue;
      expect(spec.microWorld).toBe(true);
      expect(spec.criterion).toEqual(
        title === "Leave enough behind"
          ? {
              kind: "measured",
              metricKey: "scoringSlotSurvivors",
              direction: "maximize",
            }
          : {
              kind: "measured",
              metricKey: "longevity",
              direction: "maximize",
            },
      );
    }
    const hunters = byTitle.get("Two hunters")!;
    expect(hunters.criterion).toEqual({
      kind: "measured",
      metricKey: "scoringSlotSurvivors",
      direction: "maximize",
    });
    expect(hunters.config.scoringSlotId).toBe("grazer");
    expect(byTitle.get("Leave enough behind")!.config.scoringSlotId).toBe("fish");
    expect(hunters.config.initialPositions).toEqual({
      grazer: [{ x: 3, y: 3 }],
      visual_hunter: [{ x: 0, y: 2 }],
      scent_hunter: [{ x: 0, y: 0 }],
    });

    // "The ebbing tide": a fixed, depleting larder (zero regrowth) under a hard
    // clock — camping the first patch cannot outlast migrating.
    const tide = byTitle.get("The ebbing tide")!;
    expect(tide.config.resourceRegrowthPerTick).toBe(0);
    expect(tide.config.baseMetabolicCost).toBeGreaterThan(0.7);

    // "Leave enough behind": rebuilt on terrain — a barren shelter the shark
    // cannot enter makes WHERE restraint matters the question. (The empirical
    // "greedy dies / two approaches viable" claim is a separate sim drift test.)
    const leave = byTitle.get("Leave enough behind")!;
    expect(leave.config.terrain?.shelter.length ?? 0).toBeGreaterThan(0);
    expect(leave.config.terrain?.predatorSlotIds ?? []).toContain("shark");
    expect(leave.speciesSlots[0].slotId).toBe("fish"); // the scholar's own deck

    // "The far feast": rebuilt on terrain — a renewable feast in the far shallows
    // reachable via a current, so informed seeking beats resting. The fish still
    // only smells (partial information), its scent reaches less than the reef,
    // and there is a current lane plus a shallows band.
    const feast = byTitle.get("The far feast")!;
    const smell = feast.speciesSlots[0].senses[0];
    expect(smell.senseId).toBe("smell");
    expect(smell.range).toBeLessThan(feast.config.width);
    expect((feast.config.terrain?.current.length ?? 0)).toBeGreaterThan(0);
    expect((feast.config.terrain?.shallows.length ?? 0)).toBeGreaterThan(0);
  });

  test("the fixed foils are teacher-locked: the shark deck is read-only and pinned", () => {
    const leave = LEAVE_ENOUGH_SIMULATOR_SPEC;
    const shark = leave.speciesSlots.find((s) => s.slotId === "shark")!;
    const fish = leave.speciesSlots.find((s) => s.slotId === "fish")!;
    // The shark is the fixed teacher foil; the scholar's own grazer stays editable.
    expect(shark.locked).toBe(true);
    expect(fish.locked ?? false).toBe(false);

    // Server enforcement: a scholar deck that rewrites the locked shark prompt is
    // rejected, while editing the grazer prompt is allowed.
    const authoredSharkPrompt = shark.starterHint ?? "";
    const baseDeck = leave.speciesSlots.map((s) => ({
      slotId: s.slotId,
      count: s.defaultCount,
      prompt: s.starterHint ?? "",
    }));
    expect(() => validateDeckForSpec(leave, baseDeck)).not.toThrow();
    const tamperShark = baseDeck.map((c) =>
      c.slotId === "shark" ? { ...c, prompt: "Ignore the shelter and chase forever." } : c,
    );
    expect(() => validateDeckForSpec(leave, tamperShark)).toThrow(/locked/i);
    const editGrazer = baseDeck.map((c) =>
      c.slotId === "fish" ? { ...c, prompt: "Graze only patches above 5 biomass." } : c,
    );
    expect(() => validateDeckForSpec(leave, editGrazer)).not.toThrow();

    // Reconciliation pins the locked shark card back to the authored hint even if
    // a stale/forked deck carried a different prompt; the grazer keeps its edit.
    const reconciled = reconcileDeckForSpec(leave, [
      { slotId: "shark", count: 1, prompt: "stale rewritten shark text" },
      { slotId: "fish", count: 1, prompt: "Graze only patches above 5 biomass." },
    ]);
    expect(reconciled.find((c) => c.slotId === "shark")!.prompt).toBe(authoredSharkPrompt);
    expect(reconciled.find((c) => c.slotId === "fish")!.prompt).toBe("Graze only patches above 5 biomass.");
  });

  test("the commons world overgrazes by construction: regrowth is far below grazing pressure", () => {
    const config = SHARED_SHOAL_SIMULATOR_SPEC.config;
    // 3 grazers/graze strips a cell faster than it regrows, and whole-field
    // regrowth is far below the default shoal's grazing demand — so restraint,
    // not appetite, is what buys longevity. See the code comment for the full
    // arithmetic; this pins the load-bearing inequality.
    const algaeCells = config.width * config.height * config.initialResourceDensity;
    const fieldRegrowthPerTick = algaeCells * config.resourceRegrowthPerTick;
    const grazers = SHARED_SHOAL_SIMULATOR_SPEC.speciesSlots.reduce(
      (sum, slot) => sum + slot.defaultCount,
      0,
    );
    const grazingDemandPerTick = grazers * 3; // GRAZE_AMOUNT
    expect(grazingDemandPerTick).toBeGreaterThan(fieldRegrowthPerTick * 3);
    expect(SHARED_SHOAL_SIMULATOR_SPEC.criterion).toEqual({
      kind: "measured",
      metricKey: "longevity",
      direction: "maximize",
    });
  });

  test("the generations worlds gate on heredity: trait criteria require heredity enabled", () => {
    const template = getSimulatorTemplate("ecosystemGrid")!;
    // Built to last selects the metabolic build (traitMean down); When the world
    // flips selects perception (perceptionMean up). Both are heredity metrics.
    expect(BUILT_TO_LAST_SIMULATOR_SPEC.criterion).toMatchObject({ metricKey: "traitMean", direction: "minimize" });
    expect(SIMULATOR_FLIPS_SIMULATOR_SPEC.criterion).toMatchObject({ metricKey: "perceptionMean", direction: "maximize" });
    for (const spec of [BUILT_TO_LAST_SIMULATOR_SPEC, SIMULATOR_FLIPS_SIMULATOR_SPEC]) {
      expect(spec.config.heredity?.enabled).toBe(true);
      // The real validator enforces the gate: a trait/perception criterion without
      // heredity must throw, proving these specs depend on the merged physics.
      const withoutHeredity = {
        ...spec,
        config: { ...spec.config, heredity: undefined },
      };
      expect(() => template.validateSpec(withoutHeredity)).toThrow(/heredity/i);
    }
  });

  test("scholar-facing generations copy never names the concept", () => {
    const banned = /natural selection|evolution|evolv|survival of the fittest|mutation|mutate|gene\b|genetic/i;
    const generations = SYSTEMS_AGENTS_LESSONS.find((lesson) => lesson.title === "Generations")!;
    for (const activity of generations.activities) {
      expect(activity.description).not.toMatch(banned);
      for (const slot of activity.simulatorSpec.speciesSlots) {
        expect(slot.starterHint ?? "").not.toMatch(banned);
      }
    }
  });
});

// Empirical decision-space drift tests: drive each rebuilt world through the REAL
// engine with archetype decks and assert the intended tension actually holds — the
// same measurements that guided the rebuild, ported (at reduced seeds) so a future
// config edit that quietly kills the tension fails CI. See
// lib/simulator/testing/decisionSpaceHarness.ts.
describe("Systems & Agents decision-space (empirical)", () => {
  function launchFromSpec(spec: EcosystemGridSimulatorSpec): LaunchedSpecies[] {
    return spec.speciesSlots.map((s) => ({
      slotId: s.slotId,
      label: s.label,
      count: s.defaultCount,
      countMax: s.countMax,
      senses: s.senses,
      prompt: "",
    }));
  }
  function farFeastSpec(): EcosystemGridSimulatorSpec {
    const first = SYSTEMS_AGENTS_LESSONS.find((l) => l.title === "First Automaton")!;
    return first.activities.find((a) => a.title === "The far feast")!.simulatorSpec as EcosystemGridSimulatorSpec;
  }
  function ebbingTideSpec(): EcosystemGridSimulatorSpec {
    const first = SYSTEMS_AGENTS_LESSONS.find((l) => l.title === "First Automaton")!;
    return first.activities.find((a) => a.title === "The ebbing tide")!.simulatorSpec as EcosystemGridSimulatorSpec;
  }

  // This foil searches until it finds food, consumes only that first patch, then
  // rests on bare rock. It models the authored "camp or migrate" causal question.
  const campFirstPatchFactory: EcoPolicyFactory = () => {
    const seek = informedSeekFactory();
    let grazedFirstPatch = false;
    return (observation, legalActions) => {
      const action = seek(observation, legalActions);
      if (grazedFirstPatch && action.kind !== "graze") return { kind: "rest" };
      if (action.kind === "graze") grazedFirstPatch = true;
      return action;
    };
  };

  test("The ebbing tide: migrating after the first patch beats camping, without one forced route", () => {
    const spec = ebbingTideSpec();
    const species = launchFromSpec(spec);
    const ticks = spec.tickBudget.seasonTicks;
    const run = (policy: EcoPolicyFactory, seed: string) =>
      runEcosystem({ config: spec.config, species, policyBySlot: { fish: policy }, ticks, seed }).longevity;
    const camp = DECISION_SPACE_SEEDS.map((seed) => run(campFirstPatchFactory, seed));
    const informed = DECISION_SPACE_SEEDS.map((seed) => run(informedSeekFactory, seed));
    const near = DECISION_SPACE_SEEDS.map((seed) => run(nearOnlyFactory, seed));

    // Measured over DECISION_SPACE_SEEDS: camp averages 18.6 ticks and never
    // finishes; two distinct migration policies average 26.3+ ticks, finish on
    // several seeds, and each wins on seeds where the other does not.
    expect(mean(camp)).toBeLessThan(20);
    expect(camp.filter((longevity) => longevity === ticks)).toHaveLength(0);
    expect(mean(informed)).toBeGreaterThan(mean(camp) + 6);
    expect(mean(near)).toBeGreaterThan(mean(camp) + 6);
    expect(informed.filter((longevity) => longevity === ticks).length).toBeGreaterThanOrEqual(4);
    expect(near.filter((longevity) => longevity === ticks).length).toBeGreaterThanOrEqual(4);
    expect(informed.filter((longevity, index) => longevity > near[index]).length).toBeGreaterThan(0);
    expect(near.filter((longevity, index) => longevity > informed[index]).length).toBeGreaterThan(0);
  });

  test("The far feast: informed seeking beats resting, and near vs far is a real bet", () => {
    const spec = farFeastSpec();
    const species = launchFromSpec(spec);
    const ticks = spec.tickBudget.seasonTicks;
    const run = (p: EcoPolicyFactory, seed: string) =>
      runEcosystem({ config: spec.config, species, policyBySlot: { fish: p }, ticks, seed }).longevity;
    const rest = DECISION_SPACE_SEEDS.map((s) => run(restAlways, s));
    const near = DECISION_SPACE_SEEDS.map((s) => run(nearOnlyFactory, s));
    const far = DECISION_SPACE_SEEDS.map((s) => run(farCommitFactory(6, 3), s));
    const seek = DECISION_SPACE_SEEDS.map((s) => run(informedSeekFactory, s));
    const bestInformed = DECISION_SPACE_SEEDS.map((_, i) => Math.max(near[i], far[i], seek[i]));
    expect(mean(bestInformed)).toBeGreaterThan(mean(rest)); // resting must LOSE to informed seeking
    expect(DECISION_SPACE_SEEDS.filter((_, i) => near[i] > far[i]).length).toBeGreaterThan(0);
    expect(DECISION_SPACE_SEEDS.filter((_, i) => far[i] > near[i]).length).toBeGreaterThan(0);
  });

  test("Leave enough behind: greedy dies; shelter-cycling and open-rationing both viable", () => {
    const spec = LEAVE_ENOUGH_SIMULATOR_SPEC;
    const species = launchFromSpec(spec);
    const ticks = spec.tickBudget.seasonTicks;
    const run = (grazer: EcoPolicyFactory, seed: string) =>
      runEcosystem({ config: spec.config, species, policyBySlot: { fish: grazer, shark: sharkFactory }, ticks, seed }).longevity;
    const greedy = DECISION_SPACE_SEEDS.map((s) => run(greedyGrazerFactory, s));
    const cyc = DECISION_SPACE_SEEDS.map((s) => run(shelterCyclerFactory, s));
    const open = DECISION_SPACE_SEEDS.map((s) => run(openRationerFactory, s));
    expect(mean(cyc)).toBeGreaterThan(mean(greedy) + 4);
    expect(mean(open)).toBeGreaterThan(mean(greedy) + 4);
    expect(DECISION_SPACE_SEEDS.filter((_, i) => cyc[i] > open[i]).length).toBeGreaterThan(0);
    expect(DECISION_SPACE_SEEDS.filter((_, i) => open[i] > cyc[i]).length).toBeGreaterThan(0);
  });

  test("Built to last: ordinary decks survive and the metabolic build drifts down", () => {
    const spec = BUILT_TO_LAST_SIMULATOR_SPEC;
    const species = launchFromSpec(spec);
    const ticks = spec.tickBudget.seasonTicks;
    const runs = DECISION_SPACE_SEEDS.map((s) =>
      runEcosystem({ config: spec.config, species, policyBySlot: { grazer: () => fleeBreedGrazerFactory() }, ticks, seed: s }));
    const survived = runs.filter((r) => r.longevity >= ticks - 1).length;
    expect(survived).toBeGreaterThanOrEqual(DECISION_SPACE_SEEDS.length - 3);
    expect(mean(runs.map((r) => r.traitMean))).toBeLessThan(0.95);
  });

  test("When the world flips: perception drifts DOWN in scarcity, UP with shark+abundance", () => {
    const scar = BUILT_TO_LAST_SIMULATOR_SPEC; // the scarcity world (metabolic + perception both cheapen)
    const scarSpecies = launchFromSpec(scar);
    const scarRuns = DECISION_SPACE_SEEDS.map((s) =>
      runEcosystem({ config: scar.config, species: scarSpecies, policyBySlot: { grazer: () => fleeBreedGrazerFactory() }, ticks: scar.tickBudget.seasonTicks, seed: s }));
    const flip = SIMULATOR_FLIPS_SIMULATOR_SPEC;
    const flipSpecies = launchFromSpec(flip);
    const flipRuns = DECISION_SPACE_SEEDS.map((s) =>
      runEcosystem({ config: flip.config, species: flipSpecies, policyBySlot: { grazer: () => fleeBreedGrazerFactory(), predator: sharkFactory }, ticks: flip.tickBudget.seasonTicks, seed: s }));
    const scarP = mean(scarRuns.map((r) => r.perceptionMean));
    const flipP = mean(flipRuns.map((r) => r.perceptionMean));
    expect(scarRuns.filter((r) => r.longevity >= scar.tickBudget.seasonTicks - 1).length).toBeGreaterThanOrEqual(DECISION_SPACE_SEEDS.length - 3);
    expect(flipRuns.filter((r) => r.longevity >= flip.tickBudget.seasonTicks - 1).length).toBeGreaterThanOrEqual(DECISION_SPACE_SEEDS.length - 3);
    expect(scarP).toBeLessThan(1.0); // dim eyes in scarcity
    expect(flipP).toBeGreaterThan(1.03); // sharp eyes with the shark
    expect(flipP - scarP).toBeGreaterThan(0.1);
  });
});

describe("Systems & Agents resync", () => {
  test("fails loudly when the stable unit slug is duplicated", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "duplicate-systems-teacher",
        name: "Duplicate Systems Teacher",
        role: "teacher",
      });
      for (const title of ["Systems & Agents", "Duplicate Systems & Agents"]) {
        await ctx.db.insert("units", {
          teacherId,
          title,
          slug: SYSTEMS_AGENTS_UNIT_SLUG,
          isActive: true,
        });
      }
    });

    await expect(
      t.mutation(internal.simulator.backfillSystemsAgentsContent, {}),
    ).rejects.toThrow(/unique/i);
  });

  test("clears patched benches and grants without deleting their World Runs", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "resync-world-teacher",
        name: "Resync World Teacher",
        role: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        username: "resync-world-scholar",
        name: "Resync World Scholar",
        role: "scholar",
      });
      await insertSystemsAgentsUnit(ctx, teacherId);
      const unit = await ctx.db
        .query("units")
        .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
        .unique();
      const lesson = (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (query) => query.eq("unitId", unit!._id))
          .collect()
      ).find((row) => row.title === "First Automaton")!;
      const activity = (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
          .collect()
      ).find((row) => row.order === 0)!;
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId: activity._id,
        sessionMode: "workbench",
        title: "Resync Workbench",
        isArchived: false,
      });
      const deck = [{ slotId: "fish", count: 1, prompt: "Old materialized prompt" }];
      const benchId = await ctx.db.insert("simulatorBenches", {
        sessionId,
        scholarId,
        activityId: activity._id,
        effectiveSpec: simulatorSpecForStorage(REEF_SIMULATOR_SPEC),
        specVersion: 1,
        specForkedAt: 1,
        deck,
        deckVersion: 1,
        deckHash: "old-deck",
        runGrants: [
          {
            scope: "block",
            windowKey: "old-block",
            count: 1,
            grantedBy: teacherId,
            grantedAt: 1,
          },
        ],
        lastBenchActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const runId = await ctx.db.insert("simulatorRuns", {
        sessionId,
        scholarId,
        activityId: activity._id,
        runKind: "iteration",
        targetTicks: 1,
        deckSnapshot: deck,
        deckVersion: 1,
        deckHash: "old-deck",
        simulatorSpecSnapshot: simulatorSpecForStorage(REEF_SIMULATOR_SPEC),
        simulatorSpecHash: "old-spec",
        seed: "00112233445566778899aabbccddeeff",
        status: "completed",
        haltReason: "terminal_physics",
        nextTick: 1,
        attempt: 1,
        chunkCount: 0,
        latestCommittedTick: 0,
        latestSnapshotJson: "{}",
        latestSceneJson: "{}",
        currentMetrics: [],
        summarySeries: [],
        criterionScores: [],
        invalidActionCount: 0,
        modelCallCount: 0,
        decisionCacheHitCount: 0,
        attemptLog: [],
        budgetState: "reserved",
        budgetBlockKey: "block",
        budgetWeekKey: "week",
        blockLimitSnapshot: 3,
        weekLimitSnapshot: 10,
        modelId: "test-model",
        simulatorProtocolVersion: 1,
        promptProtocolVersion: 1,
        decisionHashVersion: 1,
        physicsTemplateVersion: 1,
        rendererProtocolVersion: 1,
        queuedAt: 1,
        startedAt: 1,
        endedAt: 1,
        updatedAt: 1,
      });
      await ctx.db.patch(benchId, { lastRunId: runId });
      return { sessionId, runId };
    });

    await expect(t.mutation(internal.simulator.resyncSystemsAgents, {})).resolves.toMatchObject({
      benchesCleared: 1,
    });

    const persisted = await t.run(async (ctx) => ({
      bench: await ctx.db
        .query("simulatorBenches")
        .withIndex("by_session", (query) => query.eq("sessionId", fixture.sessionId))
        .unique(),
      run: await ctx.db.get(fixture.runId),
    }));
    expect(persisted.bench).toBeNull();
    expect(persisted.run?._id).toBe(fixture.runId);
  });

  test("inserts a missing authored activity without changing existing scholar benches", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "missing-activity-teacher",
        name: "Missing Activity Teacher",
        role: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        username: "missing-activity-scholar",
        name: "Missing Activity Scholar",
        role: "scholar",
      });
      await insertSystemsAgentsUnit(ctx, teacherId);
      const unit = await ctx.db
        .query("units")
        .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
        .unique();
      const lesson = (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (query) => query.eq("unitId", unit!._id))
          .collect()
      ).find((row) => row.title === "First Automaton")!;
      const activities = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
        .collect();
      const missing = activities.find((activity) => activity.title === "Two hunters")!;
      const existing = activities.find((activity) => activity.title === "The ebbing tide")!;
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId: existing._id,
        sessionMode: "workbench",
        title: "Unchanged Workbench",
        isArchived: false,
      });
      const deck = [{ slotId: "fish", count: 1, prompt: "Keep my authored deck." }];
      const benchId = await ctx.db.insert("simulatorBenches", {
        sessionId,
        scholarId,
        activityId: existing._id,
        effectiveSpec: simulatorSpecForStorage(existing.simulatorSpec!),
        specVersion: 1,
        specForkedAt: 1,
        deck,
        deckVersion: 1,
        deckHash: "unchanged-deck",
        runGrants: [],
        lastBenchActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.delete(missing._id);
      return { lessonId: lesson._id, benchId, deck };
    });

    await expect(
      t.mutation(internal.simulator.backfillSystemsAgentsContent, {}),
    ).resolves.toMatchObject({
      activitiesCreated: 1,
      benchesCleared: 0,
    });

    const restored = await t.run(async (ctx) => ({
      activities: await ctx.db
        .query("activities")
        .withIndex("by_lesson", (query) => query.eq("lessonId", fixture.lessonId))
        .collect(),
      bench: await ctx.db.get(fixture.benchId),
    }));
    const twoHunters = restored.activities.find((activity) => activity.title === "Two hunters");
    expect(twoHunters).toMatchObject({
      order: 3,
      simulatorSpec: simulatorSpecForStorage(TWO_HUNTERS_SIMULATOR_SPEC),
    });
    expect(restored.bench?._id).toBe(fixture.benchId);
    expect(restored.bench?.deck).toEqual(fixture.deck);

    await expect(
      t.mutation(internal.simulator.backfillSystemsAgentsContent, {}),
    ).resolves.toMatchObject({
      activitiesCreated: 0,
      benchesCleared: 0,
    });
  });
});

describe("World authoring mutations", () => {
  test("rejects an empty activity title", async () => {
    const t = convexTest(schema, modules);
    const lessonId = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "world-author",
        name: "World Author",
        role: "teacher",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Worlds",
        slug: "worlds",
        isActive: true,
      });
      return await ctx.db.insert("lessons", {
        unitId,
        title: "Simulations",
        order: 0,
      });
    });

    await expect(
      t.mutation(internal.simulator.createSimulatorActivityInternal, {
        lessonId,
        title: "   ",
        spec: REEF_SIMULATOR_SPEC,
      }),
    ).rejects.toThrow("title must not be empty");
  });
});

describe("World design reads", () => {
  test("lists only the teacher's validated Worlds and resolves scholar-owned sessions", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "world-teacher",
        name: "World Teacher",
        role: "teacher",
      });
      const otherTeacherId = await ctx.db.insert("users", {
        username: "other-world-teacher",
        name: "Other World Teacher",
        role: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        username: "world-scholar",
        name: "World Scholar",
        role: "scholar",
      });
      await insertSystemsAgentsUnit(ctx, teacherId);
      const otherUnitId = await ctx.db.insert("units", {
        teacherId: otherTeacherId,
        title: "Other Worlds",
        slug: "other-worlds",
        isActive: true,
      });
      const otherLessonId = await ctx.db.insert("lessons", {
        unitId: otherUnitId,
        title: "Other",
        order: 0,
      });
      const otherActivityId = await ctx.db.insert("activities", {
        lessonId: otherLessonId,
        title: "Other Reef",
        order: 0,
        kind: "simulator",
        simulatorSpec: simulatorSpecForStorage(REEF_SIMULATOR_SPEC),
      });
      const unit = await ctx.db
        .query("units")
        .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
        .unique();
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (query) => query.eq("unitId", unit!._id))
        .collect();
      const reefLesson = lessons.find((lesson) => lesson.title === "The Reef")!;
      const reef = (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (query) => query.eq("lessonId", reefLesson._id))
          .collect()
      ).find((activity) => activity.title === "The Reef")!;
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId: reef._id,
        sessionMode: "workbench",
        title: "Reef Workbench",
        isArchived: false,
      });
      return { teacherId, scholarId, reefActivityId: reef._id, otherActivityId, sessionId };
    });

    const asTeacher = await withUser(t, fixture.teacherId);
    const simulators = await asTeacher.query(api.simulator.listSimulatorActivities, {});
    expect(simulators).toHaveLength(8);
    expect(simulators.every((simulator) => simulator.unitTitle === "Systems & Agents")).toBe(true);

    const asScholar = await withUser(t, fixture.scholarId);
    const bySession = await asScholar.query(api.simulator.getSimulatorSpec, {
      sessionId: fixture.sessionId,
    });
    expect(bySession?.activityId).toBe(fixture.reefActivityId);
    expect(bySession?.simulatorSpec).toEqual(REEF_SIMULATOR_SPEC);
    expect(bySession?.template.metricKeys).toContain("longevity");
    expect(
      await asScholar.query(api.simulator.getSimulatorSpec, {
        activityId: fixture.otherActivityId,
      }),
    ).toBeNull();
  });
});
