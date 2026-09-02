import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  COOPERATION_CONFLICT_LESSONS,
  COOPERATION_CONFLICT_UNIT_SLUG,
  insertCooperationConflictUnit,
} from "../seed/cooperationConflict";
import { simulatorSpecForStorage } from "../seed/systemsAgents";
import { getSimulatorTemplate } from "../../lib/simulator/templates/registry";
import { validateDeckForSpec } from "../simulatorBenches";
import type { MatrixGameConfig } from "../../lib/simulator/contract";
import {
  DECISION_SPACE_SEEDS,
  runStagHunt,
  waveringPartner,
  blindStag,
  alwaysHare,
  readPartner,
  mean,
} from "../../lib/simulator/testing/decisionSpaceHarness";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedTeacher(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return t.run((ctx) =>
    ctx.db.insert("users", {
      username: "coop-world-teacher",
      name: "Coop World Teacher",
      role: "teacher",
    }),
  );
}

describe("Cooperation & conflict specs", () => {
  test("every authored SimulatorSpec passes its own real template validator", () => {
    for (const lesson of COOPERATION_CONFLICT_LESSONS) {
      const spec = lesson.activity.simulatorSpec;
      const template = getSimulatorTemplate(spec.templateId);
      expect(template, `template ${spec.templateId} registered`).not.toBeNull();
      // Validate both the authored spec and its round-tripped storage form.
      expect(() => template!.validateSpec(spec)).not.toThrow();
      expect(() => template!.validateSpec(simulatorSpecForStorage(spec))).not.toThrow();
    }
  });

  test("the ladder adds a public-goods well to the settled templates and physics", () => {
    expect(COOPERATION_CONFLICT_LESSONS.map((lesson) => lesson.title)).toEqual([
      "The mirror match",
      "A long memory",
      "Static on the line",
      "Raise the stakes",
      "When trust is the whole game",
      "The grand tournament",
      "The village well",
    ]);
    // Orders stay contiguous, including the dedicated public-goods proof activity.
    expect(COOPERATION_CONFLICT_LESSONS.map((lesson) => lesson.order)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(COOPERATION_CONFLICT_LESSONS.map((lesson) => lesson.activity.simulatorSpec.templateId)).toEqual([
      "prisonersDilemma",
      "prisonersDilemma",
      "prisonersDilemma",
      "prisonersDilemma",
      "matrixGame",
      "prisonersDilemma",
      "publicGoods",
    ]);

    const byTitle = new Map(
      COOPERATION_CONFLICT_LESSONS.map((lesson) => [lesson.title, lesson.activity.simulatorSpec]),
    );

    const mirror = byTitle.get("The mirror match")!;
    if (mirror.templateId !== "prisonersDilemma") throw new Error("mirror template");
    expect(mirror.speciesSlots).toHaveLength(1);
    expect(mirror.speciesSlots[0].defaultCount).toBe(2);
    expect(mirror.config.noiseProbability).toBe(0);
    expect(mirror.config.rounds).toBe(20);

    // "A long memory": Ben is a grim trigger — a legible fixed foil the scholar
    // must reckon with over a long relationship, noise-free so the cost is clean.
    const longMemory = byTitle.get("A long memory")!;
    if (longMemory.templateId !== "prisonersDilemma") throw new Error("bargain template");
    expect(longMemory.speciesSlots).toHaveLength(2);
    expect(longMemory.config.noiseProbability).toBe(0);
    expect(longMemory.config.rounds).toBe(50);
    expect(longMemory.speciesSlots[1].starterHint).toBe(
      "Cooperate until the other trader defects even once; then defect forever.",
    );

    const noisy = byTitle.get("Static on the line")!;
    if (noisy.templateId !== "prisonersDilemma") throw new Error("noisy template");
    expect(noisy.config.noiseProbability).toBeGreaterThanOrEqual(0.05);
    expect(noisy.config.noiseProbability).toBeLessThanOrEqual(0.1);
    expect(noisy.config.rounds).toBe(100);

    const stakes = byTitle.get("Raise the stakes")!;
    if (stakes.templateId !== "prisonersDilemma") throw new Error("stakes template");
    expect(stakes.config.payoffMatrix).toEqual({
      mutualCooperation: 4,
      temptation: 7,
      sucker: 0,
      mutualDefection: 1,
    });
    expect(stakes.config.noiseProbability).toBe(noisy.config.noiseProbability);

    // The capstone shares "Static on the line"'s physics.
    const tournament = byTitle.get("The grand tournament")!;
    if (tournament.templateId !== "prisonersDilemma") throw new Error("tournament template");
    expect(tournament.config.rounds).toBe(noisy.config.rounds);
    expect(tournament.config.noiseProbability).toBe(noisy.config.noiseProbability);
    expect(tournament.config.payoffMatrix).toEqual(noisy.config.payoffMatrix);
    // The capstone MUST be a self-play (single-slot) spec: a class tournament
    // composes deckA vs deckB from two scholars' single decks, so its source
    // activity must expose exactly one strategy slot or `tournaments.create`
    // rejects it. See convex/tournaments.ts.
    expect(tournament.speciesSlots).toHaveLength(1);
    expect(tournament.speciesSlots[0].defaultCount).toBe(2);
  });

  test("the stag hunt is a coordination game, not a dilemma (no profit from betrayal)", () => {
    const stag = COOPERATION_CONFLICT_LESSONS.find(
      (lesson) => lesson.title === "When trust is the whole game",
    )!.activity.simulatorSpec;
    if (stag.templateId !== "matrixGame") throw new Error("stag hunt template");
    expect(stag.config.actions.map((action) => action.label)).toEqual([
      "Hunt stag",
      "Hunt hare",
    ]);
    expect(stag.criterion).toEqual({
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    });
    const p = stag.config.payoffs;
    // Mutual stag is strictly the highest outcome for a player.
    expect(p.optionA.optionA.a).toBeGreaterThan(p.optionB.optionB.a); // stag,stag > hare,hare
    expect(p.optionA.optionA.a).toBeGreaterThan(p.optionB.optionA.a); // stag,stag > hare vs stag
    // The lone stag-hunter is the worst outcome.
    expect(p.optionA.optionB.a).toBeLessThan(p.optionB.optionB.a); // stag-alone < hare,hare
    expect(p.optionA.optionB.a).toBeLessThan(p.optionA.optionA.a);
    // Hare is safe regardless of the partner — never the worst payoff.
    expect(p.optionB.optionA.a).toBeGreaterThan(p.optionA.optionB.a); // hare (vs stag) beats lone stag
    expect(p.optionB.optionB.a).toBeGreaterThan(p.optionA.optionB.a); // hare (vs hare) beats lone stag
    // No cell rewards a betrayer above mutual stag — the enemy is fear, not greed:
    // there is no (defect-while-they-cooperate) payoff that beats mutual stag.
    for (const row of ["optionA", "optionB"] as const) {
      for (const col of ["optionA", "optionB"] as const) {
        expect(p[row][col].a).toBeLessThanOrEqual(p.optionA.optionA.a);
      }
    }
  });

  test("the stag hunt rewards reading the wavering partner over blind commitment", () => {
    // Empirical decision-space check against the REAL matrixGame engine: with a
    // wavering teacher partner + noise, blind always-stag is NOT risk-free (its own
    // score swings seed to seed), and a deck that reads Ben's recent habit and
    // commits only when he is dependable beats blind commitment — and a
    // blanket-safe hare — in expectation. Ana is scored on her own take, which is
    // why the criterion is adversarial (not jointScore, which blind stag maximizes
    // for free). See lib/simulator/testing/decisionSpaceHarness.ts.
    const stag = COOPERATION_CONFLICT_LESSONS.find(
      (lesson) => lesson.title === "When trust is the whole game",
    )!.activity.simulatorSpec;
    if (stag.templateId !== "matrixGame") throw new Error("stag hunt template");
    const config = stag.config as MatrixGameConfig;
    const blind = DECISION_SPACE_SEEDS.map((s) => runStagHunt({ config, scholar: blindStag, partner: waveringPartner, seed: s }));
    const read = DECISION_SPACE_SEEDS.map((s) => runStagHunt({ config, scholar: readPartner(), partner: waveringPartner, seed: s }));
    const hare = DECISION_SPACE_SEEDS.map((s) => runStagHunt({ config, scholar: alwaysHare, partner: waveringPartner, seed: s }));
    expect(mean(read)).toBeGreaterThan(mean(blind)); // reading beats blind commitment
    expect(mean(read)).toBeGreaterThan(mean(hare)); // ...and beats a blanket-safe hare
    expect(Math.max(...blind) - Math.min(...blind)).toBeGreaterThan(20); // blind is NOT risk-free
    expect(DECISION_SPACE_SEEDS.filter((_, i) => read[i] > blind[i]).length).toBeGreaterThan(DECISION_SPACE_SEEDS.length / 2);
  });

  test("fixed foils are teacher-locked; scholar-authored partners stay editable", () => {
    const byTitle = new Map<string, (typeof COOPERATION_CONFLICT_LESSONS)[number]["activity"]["simulatorSpec"]>(
      COOPERATION_CONFLICT_LESSONS.map((l) => [l.title, l.activity.simulatorSpec]),
    );
    const lockedOf = (title: string, slotId: string) =>
      byTitle.get(title)!.speciesSlots.find((s) => s.slotId === slotId)?.locked ?? false;

    // Fixed foils the design depends on → locked (read-only, server-enforced).
    expect(lockedOf("A long memory", "trader_ben")).toBe(true); // grim trigger
    expect(lockedOf("When trust is the whole game", "hunter_ben")).toBe(true); // wavering partner
    // The scholar's own deck is never locked.
    expect(lockedOf("A long memory", "trader_ana")).toBe(false);
    expect(lockedOf("When trust is the whole game", "hunter_ana")).toBe(false);
    // Lessons where the scholar authors BOTH sides keep Ben editable.
    expect(lockedOf("Static on the line", "trader_ben")).toBe(false);
    expect(lockedOf("Raise the stakes", "trader_ben")).toBe(false);

    // Server enforcement on a locked foil: rewriting Ben's grim-trigger prompt is
    // rejected; editing the scholar's own deck is allowed.
    const spec = byTitle.get("A long memory")!;
    const base = spec.speciesSlots.map((s) => ({ slotId: s.slotId, count: s.defaultCount, prompt: s.starterHint ?? "" }));
    expect(() => validateDeckForSpec(spec, base)).not.toThrow();
    expect(() =>
      validateDeckForSpec(spec, base.map((c) => (c.slotId === "trader_ben" ? { ...c, prompt: "Always cooperate." } : c))),
    ).toThrow(/locked/i);
    expect(() =>
      validateDeckForSpec(spec, base.map((c) => (c.slotId === "trader_ana" ? { ...c, prompt: "Cooperate, then mirror." } : c))),
    ).not.toThrow();
  });

  test("no scholar-facing text hands over a complete solution, and the theory is never named", () => {
    // A complete strategy is fine on a FOIL slot (Ben's grim trigger, Ben's
    // always-cooperate) — that legibility is the point. It must never be handed
    // to the scholar, so the solution ban targets the scholar's own slot (0) and
    // the activity description; the theory ban applies to every string.
    const solutionBans = [
      /copy (?:their|your opponent'?s|the other) last move/i,
      /\balways defect\b/i,
      /tit[- ]?for[- ]?tat/i,
    ];
    const theoryBans =
      /nash|kant|rawls|categorical imperative|veil of ignorance|social contract|maximin|natural selection/i;
    for (const lesson of COOPERATION_CONFLICT_LESSONS) {
      const scholarText = [
        lesson.activity.description,
        lesson.activity.simulatorSpec.speciesSlots[0].starterHint ?? "",
      ];
      for (const text of scholarText) {
        for (const pattern of solutionBans) {
          expect(text).not.toMatch(pattern);
        }
      }
      const allText = [
        lesson.activity.description,
        ...lesson.activity.simulatorSpec.speciesSlots.map((slot) => slot.starterHint ?? ""),
      ];
      for (const text of allText) {
        expect(text).not.toMatch(theoryBans);
      }
    }
  });
});

describe("Cooperation & conflict seed", () => {
  test("reconciles the unit and seven activities idempotently", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);

    const first = await t.run((ctx) => insertCooperationConflictUnit(ctx, teacherId));
    expect(first).toEqual({ unitCreated: true, lessonsCreated: 7, activitiesCreated: 7 });
    const second = await t.run((ctx) => insertCooperationConflictUnit(ctx, teacherId));
    expect(second).toEqual({ unitCreated: false, lessonsCreated: 0, activitiesCreated: 0 });

    const seeded = await t.run(async (ctx) => {
      const unit = await ctx.db
        .query("units")
        .withIndex("by_slug", (query) => query.eq("slug", COOPERATION_CONFLICT_UNIT_SLUG))
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
      return { unit, activities };
    });

    expect(seeded.unit?.title).toBe("Cooperation & conflict");
    expect(seeded.unit?.slug).toBe(COOPERATION_CONFLICT_UNIT_SLUG);
    expect(seeded.activities).toHaveLength(7);
    expect(seeded.activities.every((activity) => activity.kind === "simulator")).toBe(true);
    expect(
      new Set(seeded.activities.map((activity) => activity.simulatorSpec?.templateId)),
    ).toEqual(new Set(["prisonersDilemma", "matrixGame", "publicGoods"]));
  });

  test("ships dark: seeding surfaces nothing until a teacher assigns", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    await t.run((ctx) => insertCooperationConflictUnit(ctx, teacherId));

    const assignments = await t.run((ctx) => ctx.db.query("assignments").collect());
    const sessions = await t.run((ctx) => ctx.db.query("sessions").collect());
    const benches = await t.run((ctx) => ctx.db.query("simulatorBenches").collect());
    expect(assignments).toHaveLength(0);
    expect(sessions).toHaveLength(0);
    expect(benches).toHaveLength(0);
  });
});

describe("Cooperation & conflict resync", () => {
  test("patches edited copy onto an already-seeded activity without clearing benches", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "coop-resync-teacher",
        name: "Coop Resync Teacher",
        role: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        username: "coop-resync-scholar",
        name: "Coop Resync Scholar",
        role: "scholar",
      });
      await insertCooperationConflictUnit(ctx, teacherId);
      const unit = await ctx.db
        .query("units")
        .withIndex("by_slug", (query) => query.eq("slug", COOPERATION_CONFLICT_UNIT_SLUG))
        .unique();
      const lesson = (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (query) => query.eq("unitId", unit!._id))
          .collect()
      ).find((row) => row.title === "The mirror match")!;
      const activity = (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
          .collect()
      ).find((row) => row.order === 0)!;
      // Simulate a stale seed: mangle the stored copy so resync must repair it.
      await ctx.db.patch(activity._id, { description: "STALE", title: "Old title" });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId: activity._id,
        sessionMode: "workbench",
        title: "Coop Workbench",
        isArchived: false,
      });
      const deck = [{ slotId: "trader_ana", count: 2, prompt: "Old materialized prompt" }];
      const benchId = await ctx.db.insert("simulatorBenches", {
        sessionId,
        scholarId,
        activityId: activity._id,
        effectiveSpec: simulatorSpecForStorage(
          COOPERATION_CONFLICT_LESSONS[0].activity.simulatorSpec,
        ),
        specVersion: 1,
        specForkedAt: 1,
        deck,
        deckVersion: 1,
        deckHash: "old-deck",
        runGrants: [],
        lastBenchActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return { activityId: activity._id, benchId };
    });

    const patched = await t.mutation(internal.simulator.backfillCooperationConflictContent, {});
    expect(patched).toEqual({ activitiesPatched: 7, benchesCleared: 0 });

    const after = await t.run(async (ctx) => ({
      activity: await ctx.db.get(fixture.activityId),
      bench: await ctx.db.get(fixture.benchId),
    }));
    expect(after.activity?.title).toBe(COOPERATION_CONFLICT_LESSONS[0].activity.title);
    expect(after.activity?.description).toBe(
      COOPERATION_CONFLICT_LESSONS[0].activity.description,
    );
    // Non-destructive: the scholar's bench survives.
    expect(after.bench).not.toBeNull();
  });

  test("dev resync clears patched benches while their World Runs persist", async () => {
    const t = convexTest(schema, modules);
    const fixture = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        username: "coop-devresync-teacher",
        name: "Coop Dev Resync Teacher",
        role: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        username: "coop-devresync-scholar",
        name: "Coop Dev Resync Scholar",
        role: "scholar",
      });
      await insertCooperationConflictUnit(ctx, teacherId);
      const unit = await ctx.db
        .query("units")
        .withIndex("by_slug", (query) => query.eq("slug", COOPERATION_CONFLICT_UNIT_SLUG))
        .unique();
      const lesson = (
        await ctx.db
          .query("lessons")
          .withIndex("by_unit", (query) => query.eq("unitId", unit!._id))
          .collect()
      ).find((row) => row.title === "A long memory")!;
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
        title: "Coop Workbench",
        isArchived: false,
      });
      const deck = [{ slotId: "trader_ana", count: 1, prompt: "Old" }];
      const benchId = await ctx.db.insert("simulatorBenches", {
        sessionId,
        scholarId,
        activityId: activity._id,
        effectiveSpec: simulatorSpecForStorage(
          COOPERATION_CONFLICT_LESSONS[1].activity.simulatorSpec,
        ),
        specVersion: 1,
        specForkedAt: 1,
        deck,
        deckVersion: 1,
        deckHash: "old-deck",
        runGrants: [],
        lastBenchActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const runId = await ctx.db.insert("simulatorRuns", {
        sessionId,
        scholarId,
        activityId: activity._id,
        runKind: "season",
        targetTicks: 50,
        deckSnapshot: deck,
        deckVersion: 1,
        deckHash: "old-deck",
        simulatorSpecSnapshot: simulatorSpecForStorage(
          COOPERATION_CONFLICT_LESSONS[1].activity.simulatorSpec,
        ),
        simulatorSpecHash: "old-spec",
        seed: "00112233445566778899aabbccddeeff",
        status: "completed",
        haltReason: "terminal_physics",
        nextTick: 50,
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
      return { benchId, runId };
    });

    const result = await t.mutation(internal.simulator.resyncCooperationConflict, {});
    expect(result).toMatchObject({ benchesCleared: 1 });

    const after = await t.run(async (ctx) => ({
      bench: await ctx.db.get(fixture.benchId),
      run: await ctx.db.get(fixture.runId),
    }));
    expect(after.bench).toBeNull();
    expect(after.run?._id).toBe(fixture.runId);
  });
});
