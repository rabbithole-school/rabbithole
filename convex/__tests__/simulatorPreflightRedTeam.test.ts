import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  SYSTEMS_AGENTS_UNIT_SLUG,
  SYSTEMS_AGENTS_LESSONS,
  TWO_HUNTERS_SIMULATOR_SPEC,
  insertSystemsAgentsUnit,
  simulatorSpecForStorage,
} from "../seed/systemsAgents";
import {
  EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
  EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT,
  assembleSimulatorSpec,
  validatedSimulatorSpec,
} from "../lib/simulatorTemplatesCatalog";
import type { SimulatorSpec } from "../../lib/simulator/contract";
import {
  buildDegenerateProbe,
  criterionSeparation,
  degenerateProbePlan,
} from "../lib/simulatorRedTeam";
import { criterionSpread } from "../../lib/simulator/teacherDigest";
import { preflightSpeciesForLaunch } from "../simulatorTeacher";

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

async function asUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function setupWorld(spec: SimulatorSpec) {
  const t = convexTest(schema, modules);
  const teacherId = await t.run((ctx) =>
    ctx.db.insert("users", {
      username: `preflight-teacher-${Math.random()}`,
      name: "Preflight teacher",
      role: "teacher",
    }),
  );
  const scholarId = await t.run((ctx) =>
    ctx.db.insert("users", {
      username: `preflight-scholar-${Math.random()}`,
      name: "Preflight scholar",
      role: "scholar",
    }),
  );
  await t.run((ctx) => insertSystemsAgentsUnit(ctx, teacherId));
  const activityId = await t.run(async (ctx) => {
    const unit = await ctx.db
      .query("units")
      .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
      .unique();
    const lesson = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (query) => query.eq("unitId", unit!._id))
      .first();
    if (!lesson) throw new Error("Systems & Agents test lesson is missing");
    return await ctx.db.insert("activities", {
      lessonId: lesson._id,
      title: `Preflight ${spec.templateId}`,
      kind: "simulator",
      simulatorSpec: simulatorSpecForStorage(spec),
      order: 99,
    });
  });
  return {
    t,
    teacherId,
    scholarId,
    activityId,
    teacher: await asUser(t, teacherId),
    scholar: await asUser(t, scholarId),
  };
}

async function preflightRuns(t: T, activityId: Id<"activities">) {
  return await t.run(
    async (ctx): Promise<Doc<"simulatorRuns">[]> =>
      await ctx.db
      .query("simulatorRuns")
        .filter((query) => query.eq(query.field("activityId"), activityId))
        .collect(),
  );
}

function variantOf(run: Doc<"simulatorRuns">) {
  return run.hypothesis?.note?.split(":").at(-1);
}

async function runCompiledProbe(t: T, runId: Id<"simulatorRuns">) {
  // Each launched probe schedules its own dispatchQueued, whose worker can
  // RESERVE this row (workId stamped, status still "queued", attempt
  // unchanged) before the direct test action gets in; the direct action then
  // returns stale normally until that owner runs. Wait for exactly that
  // tracked scheduled work (no timed sleep), then re-poll.
  let lastProgress: string | undefined;
  const initial = await t.run((ctx) => ctx.db.get(runId));
  if (!initial) throw new Error("Preflight run disappeared");
  // Sound worst case: the byte cutoff in simulatorEngineNode's tick loop can
  // shrink every committed chunk to a single tick, and each chunk can cost
  // one stale direct call + one flush — so budget 2·targetTicks + 1, not a
  // hardcoded constant (30 was under the bound for a 25-tick run).
  const transitionBudget = initial.targetTicks * 2 + 1;
  for (let transition = 0; transition < transitionBudget; transition += 1) {
    const run = await t.run((ctx) => ctx.db.get(runId));
    if (!run) throw new Error("Preflight run disappeared");
    if (run.status === "completed") return run;
    if (run.status === "ticking") {
      await t.finishInProgressScheduledFunctions();
      continue;
    }
    if (run.status !== "queued") {
      throw new Error(`Preflight run entered unexpected status "${run.status}"`);
    }
    // A dispatcher can RESERVE the row (workId set) while status still reads
    // "queued": our direct action then no-ops as stale, and spinning here
    // never lets the real owner commit (the exact shape of the CI-only "did
    // not complete ... status: queued" flake — seen at tick 5/10 on
    // 2026-08-12/13). When a queued iteration makes no observable progress,
    // flush the scheduled owner instead of re-spinning. The flush needs a
    // macrotask yield first: finishInProgressScheduledFunctions only awaits
    // scheduled work whose setTimeout has already FIRED, the dispatcher's
    // runAfter(0) worker may still be a pending timer, and this poll loop
    // never leaves the microtask queue on its own — without the yield the
    // flush is an empty no-op and the loop livelocks (same pattern as
    // drainScheduled in teacherAideWrites.test.ts).
    const progress = `${run.status}:${run.nextTick}:${run.attempt}`;
    if (progress === lastProgress) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await t.finishInProgressScheduledFunctions();
      lastProgress = undefined;
      continue;
    }
    lastProgress = progress;
    await t.action(internal.simulatorEngineNode.runTickChunk, {
      runId,
      startTick: run.nextTick,
      expectedAttempt: run.attempt,
    });
  }
  const run = await t.run((ctx) => ctx.db.get(runId));
  throw new Error(
    `Compiled Preflight probe did not complete after ${transitionBudget} state transitions (status: ${run?.status ?? "missing"}, tick: ${run?.nextTick ?? "unknown"}, attempt: ${run?.attempt ?? "unknown"})`,
  );
}

async function finishStarterCalibration(
  t: T,
  activityId: Id<"activities">,
  metricKeys: string[],
) {
  const runs = await preflightRuns(t, activityId);
  const reasonable = runs.filter((run) => variantOf(run) === "reasonable");
  for (const [index, run] of reasonable.entries()) {
    const values = metricKeys.map((key) => ({ key, value: 20 + index * 2 }));
    await t.run((ctx) =>
      ctx.db.patch(run._id, {
        status: "completed",
        currentMetrics: values,
        criterionScores: values,
        endedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }
}

beforeEach(() => {
  createModel.mockReset().mockResolvedValue({
    content: [
      {
        type: "tool_use",
        name: "choose_action",
        input: {
          action: { kind: "cooperate" },
          reasoning: "Follow the starter strategy.",
        },
      },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
});

describe("World Preflight deterministic red-team", () => {
  const ecosystemCatalogSpec = validatedSimulatorSpec(
    assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT),
  );
  const populationSpec = validatedSimulatorSpec(
    assembleSimulatorSpec({
      ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
      config: {
        ...EXAMPLE_ECOSYSTEM_AUTHOR_INPUT.config,
        width: 15,
        height: 14,
        maxAutomata: 20,
      },
      speciesSlots: [
        {
          slotId: "grazer",
          label: "Grazers",
          countMin: 1,
          countMax: 20,
          defaultCount: 20,
          senses: [
            {
              senseId: "vision",
              range: 2,
              channels: ["automata", "resources", "boundary"],
            },
          ],
          starterHint: "Find food and preserve enough energy to survive.",
        },
      ],
      tickBudget: {
        iterationTicks: 25,
        seasonTicks: 50,
        absoluteMaxTicks: 50,
      },
    }),
  );

  test("launches 20-automaton Preflight only through guaranteed compiled probes", async () => {
    const fixture = await setupWorld(populationSpec);
    const launched = await fixture.teacher.mutation(
      api.simulatorTeacher.startPreflight,
      { activityId: fixture.activityId, ticks: 100 },
    );
    expect(launched.ticks).toBe(25);
    expect(launched.runIds).toHaveLength(3);

    const runs = await preflightRuns(fixture.t, fixture.activityId);
    expect(runs.map(variantOf).sort()).toEqual(["empty", "greedy", "noop"]);
    expect(
      runs.every(
        (run) =>
          run.targetTicks === 25 &&
          run.deckSnapshot.reduce((total, card) => total + card.count, 0) === 20 &&
          run.compiledPolicySnapshot?.length === 1 &&
          run.compiledPolicySnapshot.every(
            (slot) =>
              slot.status === "ready" &&
              slot.policy.rules.every((rule) => rule.then.kind !== "abstain") &&
              slot.policy.rules.some((rule) => rule.when.length === 0),
          ),
      ),
    ).toBe(true);
    for (const run of runs) {
      const completed = await runCompiledProbe(fixture.t, run._id);
      expect(completed).toMatchObject({
        status: "completed",
        modelCallCount: 0,
      });

      expect(completed.nextTick).toBeGreaterThan(0);
      expect(completed.nextTick).toBeLessThanOrEqual(25);
    }
    const status = await fixture.teacher.query(
      api.simulatorTeacher.preflightStatus,
      { activityId: fixture.activityId },
    );
    expect(status?.redTeam).toMatchObject({
      calibrationUnavailable: true,
      noiseBand: null,
      rows: [
        { separation: null },
        { separation: null },
        { separation: null },
      ],
    });
    expect(status?.variants?.reasonable.total).toBe(0);
    expect(
      status?.variants?.probes.every(
        ({ facts }) => facts.completed === 1 && facts.running === 0,
      ),
    ).toBe(true);
  });

  test("runs exact authored reference decks on fixed seeds without model calls", async () => {
    const referenceSpec = SYSTEMS_AGENTS_LESSONS[0]!.activities[0]!.simulatorSpec;
    const fixture = await setupWorld(referenceSpec);
    const launched = await fixture.teacher.mutation(
      api.simulatorTeacher.startPreflight,
      { activityId: fixture.activityId, ticks: 5 },
    );

    const runs = await preflightRuns(fixture.t, fixture.activityId);
    const referenceRuns = runs.filter((run) => variantOf(run) === "reference");
    expect(launched.runIds).toHaveLength(7);
    expect(referenceRuns).toHaveLength(2);
    expect(referenceRuns.map((run) => run.seed)).toEqual(
      referenceRuns.map((_, index) => `reference:${fixture.activityId}:${index}`),
    );
    expect(
      referenceRuns.every(
        (run) =>
          run.simulatorSpecSnapshot.interpreter.kind === "scripted" &&
          run.compiledPolicySnapshot?.every(
            (policy) =>
              policy.status === "ready" &&
              policy.policy?.rules.at(-1)?.when.length === 0 &&
              policy.policy?.rules.at(-1)?.then.kind !== "abstain",
          ),
      ),
    ).toBe(true);

    for (const run of referenceRuns) {
      const completed = await runCompiledProbe(fixture.t, run._id);
      expect(completed.modelCallCount).toBe(0);
    }
    const status = await fixture.teacher.query(
      api.simulatorTeacher.preflightStatus,
      { activityId: fixture.activityId },
    );
    expect(status?.reference).toMatchObject({ available: true });
    expect(status?.variants?.reference).toMatchObject({ total: 2, completed: 2 });
  });

  test("does not use a reference deck after the authored World configuration changes", async () => {
    const referenceSpec = SYSTEMS_AGENTS_LESSONS[0]!.activities[0]!.simulatorSpec;
    const fixture = await setupWorld({
      ...referenceSpec,
      config: {
        ...referenceSpec.config,
        baseMetabolicCost: referenceSpec.config.baseMetabolicCost + 0.1,
      },
    });
    await fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
      activityId: fixture.activityId,
      ticks: 5,
    });

    const runs = await preflightRuns(fixture.t, fixture.activityId);
    expect(runs.some((run) => variantOf(run) === "reference")).toBe(false);
    const status = await fixture.teacher.query(
      api.simulatorTeacher.preflightStatus,
      { activityId: fixture.activityId },
    );
    expect(status?.reference).toEqual({
      available: false,
      summary: null,
      preflightStory: null,
    });
  });

  test("keeps Systems & Agents locked foils authored after a valid World edit", async () => {
    const twoHunters = TWO_HUNTERS_SIMULATOR_SPEC;
    const fixture = await setupWorld({
      ...twoHunters,
      tickBudget: {
        ...twoHunters.tickBudget,
        iterationTicks: 7,
        seasonTicks: 7,
      },
    });

    await expect(
      fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
        activityId: fixture.activityId,
        ticks: 5,
      }),
    ).resolves.toMatchObject({ ticks: 5 });

    const probes = (await preflightRuns(fixture.t, fixture.activityId)).filter(
      (run) => ["empty", "greedy", "noop"].includes(variantOf(run) ?? ""),
    );
    expect(probes).toHaveLength(3);
    for (const probe of probes) {
      const policies = probe.compiledPolicySnapshot ?? [];
      const visualHunter = policies.find((policy) => policy.slotId === "visual_hunter");
      const scentHunter = policies.find((policy) => policy.slotId === "scent_hunter");
      if (visualHunter?.status !== "ready" || scentHunter?.status !== "ready") {
        throw new Error("Locked hunter policies were not compiled");
      }
      expect(visualHunter.policy.rules.some((rule) => rule.id === "follow-visible-grazer")).toBe(true);
      expect(scentHunter.policy.rules.some((rule) => rule.id === "follow-smelled-grazer")).toBe(true);
    }
  });

  test("still refuses a 20-automaton Preflight launch without compiled policies", async () => {
    const deck = populationSpec.speciesSlots.map((slot) => ({
      slotId: slot.slotId,
      count: slot.defaultCount,
      prompt: slot.starterHint ?? "",
    }));
    expect(() =>
      preflightSpeciesForLaunch({ spec: populationSpec, deck }),
    ).toThrow(
      "Simulators this big need every species' rules fully compiled — no 'ask Haiku' gaps.",
    );

    const probe = await buildDegenerateProbe(populationSpec, "noop");
    expect(() =>
      preflightSpeciesForLaunch({
        spec: probe.simulatorSpec,
        deck: probe.deck,
        compiled: probe,
      }),
    ).not.toThrow();
  });

  test.each([
    {
      name: "ecosystemGrid",
      spec: {
        ...ecosystemCatalogSpec,
        interpreter: { kind: "llm", role: "AUTOMATON" },
      } as SimulatorSpec,
      metricKeys: ["longevity"],
      comparison: "starter-hint runs",
      expectedRunCount: 5,
      expectedVariants: ["empty", "greedy", "noop"],
    },
    {
      name: "prisonersDilemma",
      spec: validatedSimulatorSpec(
        assembleSimulatorSpec(EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT),
      ),
      metricKeys: ["deckA.totalScore", "deckB.totalScore"],
      comparison: "starter-hint opponent",
      expectedRunCount: 4,
      expectedVariants: ["empty", "greedy"],
    },
  ])(
    "runs every $name probe and reports calibrated verdict rows",
    async ({
      spec,
      metricKeys,
      comparison,
      expectedRunCount,
      expectedVariants,
    }) => {
      const fixture = await setupWorld(spec);
      const launched = await fixture.teacher.mutation(
        api.simulatorTeacher.startPreflight,
        { activityId: fixture.activityId, ticks: 5 },
      );
      expect(launched.runIds).toHaveLength(expectedRunCount);

      const runs = await preflightRuns(fixture.t, fixture.activityId);
      expect(
        runs
          .map(variantOf)
          .filter((variant) => variant !== "reasonable")
          .sort(),
      ).toEqual(expectedVariants);
      const degenerate = runs.filter((run) => variantOf(run) !== "reasonable");
      expect(
        degenerate.every(
          (run) =>
            run.compiledPolicySnapshot?.length === spec.speciesSlots.length &&
            run.compiledPolicySnapshot.every(
              (slot: NonNullable<Doc<"simulatorRuns">["compiledPolicySnapshot"]>[number]) =>
                slot.status === "fallback" ||
                (slot.policy.rules.length === 1 &&
                  slot.policy.rules[0].when.length === 0 &&
                  slot.policy.rules[0].then.kind !== "abstain"),
            ),
        ),
      ).toBe(true);
      expect(
        degenerate.every(
          (run) => run.simulatorSpecSnapshot.interpreter.kind === "scripted",
        ),
      ).toBe(true);

      for (const run of degenerate) {
        const completed = await runCompiledProbe(fixture.t, run._id);
        const chunks = await fixture.t.run((ctx) =>
          ctx.db
            .query("simulatorRunChunks")
            .withIndex("by_run_startTick", (query) =>
              query.eq("runId", run._id),
            )
            .collect(),
        );
        const decisions = chunks
          .flatMap((chunk) => chunk.ticks)
          .flatMap((tick) => tick.automata);
        if (spec.templateId === "prisonersDilemma") {
          expect(completed.modelCallCount).toBeGreaterThan(0);
          expect(
            decisions
              .filter(
                (decision) =>
                  decision.slotId === spec.speciesSlots[0]?.slotId,
              )
              .every((decision) => decision.source === "compiled"),
          ).toBe(true);
          expect(
            decisions
              .filter(
                (decision) =>
                  decision.slotId === spec.speciesSlots[1]?.slotId,
              )
              .every((decision) => decision.source === "compiled-fallback"),
          ).toBe(true);
        } else {
          expect(completed.modelCallCount).toBe(0);
          expect(
            decisions.every((decision) => decision.source === "compiled"),
          ).toBe(true);
        }
      }
      // Starter calibration runs are intentionally model-driven and their
      // scheduler timing is outside this probe test. The decision-source
      // assertions above are the invariant: every degenerate policy uses its
      // compiled path (or its explicit opponent fallback).

      await finishStarterCalibration(
        fixture.t,
        fixture.activityId,
        metricKeys,
      );
      const status = await fixture.teacher.query(
        api.simulatorTeacher.preflightStatus,
        { activityId: fixture.activityId },
      );
      expect(status?.redTeam?.noiseBand).toBe(2);
      expect(status?.probeVariants).toEqual(
        degenerateProbePlan(spec.templateId).variants,
      );
      expect(status?.redTeam?.rows).toHaveLength(expectedVariants.length);
      expect(
        status?.redTeam?.rows.map((row) => row.variant).sort(),
      ).toEqual(expectedVariants);
      expect(
        status?.redTeam?.rows.every(
          (row) =>
            row.comparison === comparison && row.separation !== null,
        ),
      ).toBe(true);
      expect(status?.reading.state).toBe(
        status?.redTeam?.rows.every(
          (row) => row.separation?.verdict === "separated",
        )
          ? "clear"
          : "attention",
      );
      expect(status?.reading.nextStep).toEqual(
        status?.reading.state === "clear"
          ? expect.stringContaining("No revision suggested")
          : expect.stringContaining("Open the evidence"),
      );
      expect(status?.reading.verdict).toBe(
        status?.reading.state === "clear"
          ? "Ready to assign"
          : "Needs a change before you assign",
      );
      expect(status?.reading.evidence).toMatchObject({
        intendedLabel: "Starter strategy",
        intendedMean: expect.any(Number),
        referenceMean: null,
        shortcutMinMean: expect.any(Number),
        shortcutMaxMean: expect.any(Number),
      });
      if (spec.templateId === "ecosystemGrid") {
        const greedyRun = runs.find(
          (candidate) => variantOf(candidate) === "greedy",
        );
        if (!greedyRun) throw new Error("Missing greedy run");
        const chunks = await fixture.t.run((ctx) =>
          ctx.db
            .query("simulatorRunChunks")
            .withIndex("by_run_startTick", (query) =>
              query.eq("runId", greedyRun._id),
            )
            .collect(),
        );
        const expectedFallbacks = chunks
          .flatMap((chunk) => chunk.ticks)
          .flatMap((tick) => tick.automata)
          .filter((decision) =>
            decision.policyTrace?.includes(
              "but that action was not legal now",
            ),
          ).length;
        expect(
          status?.redTeam?.rows.find((row) => row.variant === "greedy")
            ?.fallbackToNeutralCount,
        ).toBe(expectedFallbacks);
      }
      if (
        spec.templateId === "prisonersDilemma" &&
        spec.criterion.kind === "adversarial"
      ) {
        const starterSpread = status?.variants?.reasonable.spread ?? null;
        const completedRuns = await preflightRuns(
          fixture.t,
          fixture.activityId,
        );
        for (const row of status?.redTeam?.rows ?? []) {
          const run = completedRuns.find(
            (candidate) => variantOf(candidate) === row.variant,
          );
          if (!run) throw new Error(`Missing ${row.variant} run`);
          const degenerateScore =
            run.currentMetrics.find(
              (metric) =>
                metric.key === spec.criterion.scoreMetricKeys[0],
            )?.value ?? null;
          const starterOpponentScore =
            run.currentMetrics.find(
              (metric) =>
                metric.key === spec.criterion.scoreMetricKeys[1],
            )?.value ?? null;
          expect(row.separation).toEqual(
            criterionSeparation({
              starter: starterSpread,
              degenerate:
                degenerateScore === null
                  ? null
                  : criterionSpread([degenerateScore]),
              reference:
                starterOpponentScore === null
                  ? null
                  : criterionSpread([starterOpponentScore]),
              direction: "maximize",
            }),
          );
        }
      }
    },
  );

  test("a trivial invalid-actions criterion is reported as degenerate-wins", async () => {
    const base = validatedSimulatorSpec(
      assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT),
    );
    if (base.templateId !== "ecosystemGrid") {
      throw new Error("Expected ecosystem catalog example");
    }
    const fixture = await setupWorld({
      ...base,
      criterion: {
        kind: "measured",
        metricKey: "invalidActions",
        direction: "minimize",
      },
    });
    await fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
      activityId: fixture.activityId,
      ticks: 5,
    });
    const runs = await preflightRuns(fixture.t, fixture.activityId);
    const degenerate = runs.filter((run) => variantOf(run) !== "reasonable");
    for (const run of degenerate) {
      const completed = await runCompiledProbe(fixture.t, run._id);
      // The batch also schedules starter-hint runs, which deliberately use the
      // model. This direct assertion is the bounded-work guarantee for each
      // compiled degenerate probe.
      expect(completed.modelCallCount).toBe(0);
      expect(
        completed.currentMetrics.find(
          (
            metric: Doc<"simulatorRuns">["currentMetrics"][number],
          ) => metric.key === "invalidActions",
        )?.value,
      ).toBe(0);
    }
    for (const run of runs.filter(
      (candidate) => variantOf(candidate) === "reasonable",
    )) {
      await fixture.t.run((ctx) =>
        ctx.db.patch(run._id, {
          status: "completed",
          currentMetrics: [{ key: "invalidActions", value: 0 }],
          criterionScores: [{ key: "invalidActions", value: 0 }],
          modelCallCount: 1,
          endedAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }
    const status = await fixture.teacher.query(
      api.simulatorTeacher.preflightStatus,
      { activityId: fixture.activityId },
    );
    expect(
      status?.redTeam?.rows.every(
        (row) => row.separation?.verdict === "degenerate-wins",
      ),
    ).toBe(true);
    expect(status?.reading).toMatchObject({
      state: "attention",
      verdict: "Needs a change before you assign",
      title: "A shortcut wins",
      evidence: {
        intendedLabel: "Starter strategy",
        intendedMean: 0,
        referenceMean: null,
        shortcutMinMean: 0,
        shortcutMaxMean: 0,
      },
    });
    expect(status?.reading.nextStep).toContain("ask Curriculum Bot");
  });

  test("never reads as ready when no shortcut was tested", async () => {
    const twoSlot = validatedSimulatorSpec(
      assembleSimulatorSpec(EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT),
    );
    // A single-strategy Prisoner's Dilemma is a valid authored configuration
    // (one deck self-playing both seats), but it produces no head-to-head
    // probes. An empty row set satisfies none of the reading's `some()`
    // checks, so it must not fall through to a pass.
    const [selfPlaySlot] = twoSlot.speciesSlots;
    const oneSlot = validatedSimulatorSpec({
      ...twoSlot,
      speciesSlots: [
        {
          ...selfPlaySlot,
          countMax: Math.max(selfPlaySlot.countMax, 2),
          defaultCount: 2,
        },
      ],
    });
    const fixture = await setupWorld(oneSlot);
    await fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
      activityId: fixture.activityId,
      ticks: 5,
    });
    const runs = await preflightRuns(fixture.t, fixture.activityId);
    for (const run of runs) {
      await fixture.t.run((ctx) =>
        ctx.db.patch(run._id, {
          status: "completed",
          modelCallCount: 1,
          endedAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }
    const status = await fixture.teacher.query(
      api.simulatorTeacher.preflightStatus,
      { activityId: fixture.activityId },
    );
    expect(status?.redTeam?.rows).toEqual([]);
    expect(status?.reading).toMatchObject({
      state: "incomplete",
      verdict: "Can't tell yet",
      title: "No shortcuts were tested",
    });
    expect(status?.reading.verdict).not.toBe("Ready to assign");
  });

  test("preserves curriculum access and the active/rate-limit gates", async () => {
    const fixture = await setupWorld(
      validatedSimulatorSpec(assembleSimulatorSpec(EXAMPLE_ECOSYSTEM_AUTHOR_INPUT)),
    );
    const beforeRun = await fixture.teacher.query(
      api.simulatorTeacher.preflightStatus,
      { activityId: fixture.activityId },
    );
    expect(beforeRun?.reading).toMatchObject({
      state: "not-run",
      verdict: "Not rehearsed yet",
      nextStep: expect.stringContaining("Run Preflight"),
    });
    await expect(
      fixture.scholar.mutation(api.simulatorTeacher.startPreflight, {
        activityId: fixture.activityId,
        ticks: 5,
      }),
    ).rejects.toThrow();

    await fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
      activityId: fixture.activityId,
      ticks: 5,
    });
    const active = await fixture.teacher.query(
      api.simulatorTeacher.preflightStatus,
      { activityId: fixture.activityId },
    );
    expect(active?.reading.state).toBe("running");
    expect(active?.reading.evidence).toBeNull();
    await expect(
      fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
        activityId: fixture.activityId,
        ticks: 5,
      }),
    ).rejects.toThrow(/already running/i);

    for (let batchIndex = 0; batchIndex < 3; batchIndex += 1) {
      const runs = await preflightRuns(fixture.t, fixture.activityId);
      const active = runs.filter(
        (run) => run.status === "queued" || run.status === "ticking",
      );
      for (const run of active) {
        await fixture.t.run((ctx) =>
          ctx.db.patch(run._id, {
            status: "completed",
            hypothesis: {
              prediction: "exploratory",
              note: `pf:${1000 + batchIndex}:${variantOf(run)}`,
            },
            endedAt: Date.now(),
            updatedAt: Date.now(),
          }),
        );
      }
      if (batchIndex < 2) {
        await fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
          activityId: fixture.activityId,
          ticks: 5,
        });
      }
    }

    await expect(
      fixture.teacher.mutation(api.simulatorTeacher.startPreflight, {
        activityId: fixture.activityId,
        ticks: 5,
      }),
    ).rejects.toThrow(/allowance/i);
  });
});
