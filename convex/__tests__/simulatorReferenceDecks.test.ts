import { describe, expect, test } from "vitest";

import {
  COOPERATION_CONFLICT_LESSONS,
  COOPERATION_CONFLICT_REFERENCE_DECKS,
} from "../seed/cooperationConflict";
import {
  SYSTEMS_AGENTS_LESSONS,
  SYSTEMS_AGENTS_REFERENCE_DECKS,
  referenceDeckForSystemsAgentsSpec,
} from "../seed/systemsAgents";
import {
  buildReferenceProbe,
  buildDegenerateProbe,
  criterionSeparation,
  degenerateProbePlan,
} from "../lib/simulatorRedTeam";
import type { SimulatorSpec } from "../../lib/simulator/contract";
import type {
  PolicyIR,
  ReferencePolicyDeck,
} from "../../lib/simulator/policyIR";
import type {
  EcosystemObservation,
  EcosystemState,
} from "../../lib/simulator/templates/ecosystemGrid";
import {
  DECISION_SPACE_SEEDS,
  type PolicyDeckTickTrace,
  runPolicyDeck,
  runPolicyMatchup,
} from "../../lib/simulator/testing/decisionSpaceHarness";
import { criterionSpread } from "../../lib/simulator/teacherDigest";

type WorldCase = {
  title: string;
  spec: SimulatorSpec;
  reference: ReferencePolicyDeck;
};

const SYSTEMS_CASES: WorldCase[] = SYSTEMS_AGENTS_LESSONS.flatMap((lesson) =>
  lesson.activities.map((activity) => ({
    title: activity.title,
    spec: activity.simulatorSpec,
    reference: SYSTEMS_AGENTS_REFERENCE_DECKS[activity.title],
  })),
);

const COOPERATION_CASES: WorldCase[] = COOPERATION_CONFLICT_LESSONS.map(
  (lesson) => ({
    title: lesson.title,
    spec: lesson.activity.simulatorSpec,
    reference: COOPERATION_CONFLICT_REFERENCE_DECKS[lesson.title],
  }),
);

const SIMULATOR_CASES = [...SYSTEMS_CASES, ...COOPERATION_CASES];
const MIXED_FIELD_WORLDS = [
  "The mirror match",
  "When trust is the whole game",
  "The grand tournament",
].sort();
function criterionFor(spec: SimulatorSpec): {
  metricKey: string;
  direction: "maximize" | "minimize" | "target";
  target?: number;
} {
  if (spec.criterion.kind === "measured") {
    return {
      metricKey: spec.criterion.metricKey,
      direction: spec.criterion.direction,
      target: spec.criterion.target,
    };
  }
  if (spec.criterion.kind === "adversarial") {
    const metricKey = spec.criterion.scoreMetricKeys[0];
    if (!metricKey) throw new Error("Adversarial criterion has no score metric");
    return { metricKey, direction: "maximize" };
  }
  throw new Error(`Reference separation is not defined for gallery World "${spec.templateId}"`);
}

async function baselinePolicies(
  spec: SimulatorSpec,
  reference: ReferencePolicyDeck,
  variant: "empty" | "noop" | "greedy",
): Promise<PolicyIR[]> {
  const probe = await buildDegenerateProbe(spec, variant, {
    lockedPolicies: reference.policies,
  });
  const referenceBySlot = new Map(
    reference.policies.map((policy) => [policy.slotId, policy]),
  );
  return probe.compiledPolicySnapshot.map((snapshot) => {
    if (snapshot.status === "ready") return snapshot.policy;
    const foil = referenceBySlot.get(snapshot.slotId);
    if (!foil) {
      throw new Error(`Reference deck has no foil policy for "${snapshot.slotId}"`);
    }
    return foil;
  });
}

function readyProbePolicy(
  snapshots: Awaited<ReturnType<typeof buildDegenerateProbe>>["compiledPolicySnapshot"],
  slotId: string,
): PolicyIR {
  const snapshot = snapshots.find((candidate) => candidate.slotId === slotId);
  if (!snapshot || snapshot.status !== "ready") {
    throw new Error(`Degenerate probe has no compiled policy for "${slotId}"`);
  }
  return snapshot.policy;
}

describe("seeded World reference decks", () => {
  test("only exposes a reference deck for its exact authored configuration", async () => {
    for (const lesson of SYSTEMS_AGENTS_LESSONS) {
      for (const activity of lesson.activities) {
        const reference = referenceDeckForSystemsAgentsSpec(activity.simulatorSpec);
        expect(reference, activity.title).toBeDefined();
        const probe = await buildReferenceProbe(activity.simulatorSpec, reference!);
        expect(probe.compiledPolicySnapshot).toHaveLength(
          activity.simulatorSpec.speciesSlots.length,
        );
        expect(
          probe.compiledPolicySnapshot.every(
            (slot) =>
              slot.status === "ready" &&
              slot.policy?.rules.at(-1)?.when.length === 0 &&
              slot.policy.rules.at(-1)?.then.kind !== "abstain",
          ),
        ).toBe(true);
      }
    }

    const changed = {
      ...SYSTEMS_AGENTS_LESSONS[0]!.activities[0]!.simulatorSpec,
      tickBudget: {
        ...SYSTEMS_AGENTS_LESSONS[0]!.activities[0]!.simulatorSpec.tickBudget,
        seasonTicks: 29,
      },
    };
    expect(referenceDeckForSystemsAgentsSpec(changed)).toBeNull();
    expect(
      SYSTEMS_AGENTS_REFERENCE_DECKS["The ebbing tide"].preflightStory,
    ).toMatchObject({
      setup: expect.stringContaining("fish"),
      clearTemplate: expect.stringContaining("{referenceMean}"),
    });
  });

  test("rejects opposition-panel decks until Preflight can run their fixed opponents", async () => {
    const opposition = COOPERATION_CASES.find(
      ({ reference }) => reference.criterion?.kind === "opposition-panel",
    );
    if (!opposition) throw new Error("Expected an authored opposition-panel deck");
    await expect(
      buildReferenceProbe(opposition.spec, opposition.reference),
    ).rejects.toThrow("fixed-opponent Preflight run");
  });

  test("covers every seeded World activity exactly once", () => {
    expect(Object.keys(SYSTEMS_AGENTS_REFERENCE_DECKS).sort()).toEqual(
      SYSTEMS_CASES.map((world) => world.title).sort(),
    );
    expect(Object.keys(COOPERATION_CONFLICT_REFERENCE_DECKS).sort()).toEqual(
      COOPERATION_CASES.map((world) => world.title).sort(),
    );
    expect(
      COOPERATION_CASES.filter(
        ({ reference }) => reference.criterion?.kind === "opposition-panel",
      )
        .map(({ title }) => title)
        .sort(),
    ).toEqual(MIXED_FIELD_WORLDS);
  });

  test("Two hunters keeps its locked hunter decks fixed while checking the grazer's sensory escape", async () => {
    const world = SYSTEMS_CASES.find(({ title }) => title === "Two hunters");
    if (!world) throw new Error("Expected Two hunters to be a seeded World");
    const grazerPolicy = world.reference.policies.find((policy) => policy.slotId === "grazer");
    if (!grazerPolicy) throw new Error("Expected Two hunters to include a grazer policy");
    expect(grazerPolicy.rules.slice(0, 2).map((rule) => rule.id)).toEqual([
      "flee-scent",
      "hide-from-sight",
    ]);
    for (const seed of DECISION_SPACE_SEEDS) {
      const trace: PolicyDeckTickTrace[] = [];
      runPolicyDeck({
        spec: world.spec,
        policies: world.reference.policies,
        ticks: world.spec.tickBudget.seasonTicks,
        seed,
        onTick: (tick) => trace.push(tick),
      });
      const first = trace[0]!;
      const hiddenState = trace[1]!.previousState as EcosystemState;
      const sightObservation = trace[1]!.observations.get(
        "visual_hunter:1",
      ) as EcosystemObservation;
      const scentObservation = trace[1]!.observations.get(
        "scent_hunter:1",
      ) as EcosystemObservation;
      const scentDecision = trace[1]!.decisions.find(
        (decision) => decision.automatonId === "scent_hunter:1",
      );
      expect(first.decisions).toContainEqual(
        expect.objectContaining({
          automatonId: "grazer:1",
          ruleId: "hide-from-sight",
          action: { kind: "hide" },
        }),
      );
      expect(hiddenState.automata.find((automaton) => automaton.id === "grazer:1")?.hidden).toBe(true);
      expect(
        sightObservation.vision?.automata?.some((automaton) => automaton.id === "grazer:1"),
      ).toBe(false);
      expect(
        scentObservation.smell?.automata?.some((automaton) => automaton.id === "grazer:1"),
      ).toBe(true);
      expect(scentDecision).toMatchObject({
        ruleId: "follow-smelled-grazer",
        action: { kind: "move" },
      });
    }

    const referenceScores = DECISION_SPACE_SEEDS.map(
      (seed) =>
        runPolicyDeck({
          spec: world.spec,
          policies: world.reference.policies,
          ticks: world.spec.tickBudget.seasonTicks,
          seed,
        }).scoringSlotSurvivors,
    );
    const hideRule = grazerPolicy.rules.find((rule) => rule.id === "hide-from-sight");
    if (!hideRule) throw new Error("Expected Two hunters to include a hiding rule");
    const alwaysHide = { ...grazerPolicy, rules: [{ ...hideRule, when: [] }] };
    const fleeWithoutHiding = {
      ...grazerPolicy,
      rules: grazerPolicy.rules.filter((rule) => rule.id !== "hide-from-sight"),
    };
    const foils = new Map<string, PolicyIR[]>([
      [
        "always-hide",
        world.reference.policies.map((policy) =>
          policy.slotId === "grazer" ? alwaysHide : policy,
        ),
      ],
      [
        "always-flee-without-hiding",
        world.reference.policies.map((policy) =>
          policy.slotId === "grazer" ? fleeWithoutHiding : policy,
        ),
      ],
    ]);
    for (const variant of degenerateProbePlan(world.spec.templateId).variants) {
      foils.set(variant, await baselinePolicies(world.spec, world.reference, variant));
    }
    for (const [label, policies] of foils) {
      const scores = DECISION_SPACE_SEEDS.map(
        (seed) =>
          runPolicyDeck({
            spec: world.spec,
            policies,
            ticks: world.spec.tickBudget.seasonTicks,
            seed,
          }).scoringSlotSurvivors,
      );
      expect(
        referenceScores.reduce((total, score) => total + score, 0) >
          scores.reduce((total, score) => total + score, 0),
        `${label} unexpectedly matched the reference: ${JSON.stringify(scores)}`,
      ).toBe(true);
    }
  });

  test("Leave enough behind scores the scholar's fish survival, not the locked shark's lifespan", async () => {
    const world = SYSTEMS_CASES.find(({ title }) => title === "Leave enough behind");
    if (!world) throw new Error("Expected Leave enough behind to be a seeded World");
    expect(world.spec.criterion).toEqual({
      kind: "measured",
      metricKey: "scoringSlotSurvivors",
      direction: "maximize",
    });
    expect(world.spec.templateId).toBe("ecosystemGrid");
    if (world.spec.templateId !== "ecosystemGrid") {
      throw new Error("Leave enough behind must use ecosystemGrid");
    }
    expect(world.spec.config.scoringSlotId).toBe("fish");

    const referenceScores = DECISION_SPACE_SEEDS.map(
      (seed) =>
        runPolicyDeck({
          spec: world.spec,
          policies: world.reference.policies,
          ticks: world.spec.tickBudget.seasonTicks,
          seed,
        }).scoringSlotSurvivors,
    );
    for (const variant of ["noop", "greedy"] as const) {
      const policies = await baselinePolicies(world.spec, world.reference, variant);
      const scores = DECISION_SPACE_SEEDS.map(
        (seed) =>
          runPolicyDeck({
            spec: world.spec,
            policies,
            ticks: world.spec.tickBudget.seasonTicks,
            seed,
          }).scoringSlotSurvivors,
      );
      expect(
        referenceScores.reduce((total, score) => total + score, 0) >
          scores.reduce((total, score) => total + score, 0),
        `${variant} unexpectedly matched the reference: ${JSON.stringify(scores)}`,
      ).toBe(true);
    }
  });

  test.each(SIMULATOR_CASES)(
    "$title: reference deck runs through the real interpreter and records criterion separation",
    async ({ title, spec, reference }) => {
      expect(reference, `${title} has a reference deck`).toBeDefined();
      const expectedSlots = spec.speciesSlots.map((slot) => slot.slotId).sort();
      expect(reference.policies.map((policy) => policy.slotId).sort()).toEqual(
        expectedSlots,
      );

      if (reference.criterion?.kind === "opposition-panel") {
        const candidate = reference.policies.find(
          (policy) => policy.slotId === reference.criterion!.candidateSlotId,
        );
        if (!candidate) {
          throw new Error(
            `${title} has no reference policy for criterion slot "${reference.criterion.candidateSlotId}"`,
          );
        }
        const referenceLegs = reference.criterion.opponents.map((opponent) => {
          const scores = DECISION_SPACE_SEEDS.map((seed) => {
            const metrics = runPolicyMatchup({
              spec,
              candidatePolicy: candidate,
              opponentPolicy: opponent.policy,
              opponentLabel: opponent.label,
              ticks: spec.tickBudget.seasonTicks,
              seed,
            });
            return metrics[reference.criterion!.scoreMetricKey];
          });
          return {
            label: opponent.label,
            mean: criterionSpread(scores)?.mean ?? Number.NaN,
            floor: opponent.minimumMeanScore,
          };
        });
        expect(
          referenceLegs,
          `${title} reference: ${JSON.stringify(referenceLegs)}`,
        ).toSatisfy(
          (legs: typeof referenceLegs) =>
            legs.every((leg) => leg.mean >= leg.floor),
        );

        for (const variant of degenerateProbePlan(spec.templateId).variants) {
          const probe = await buildDegenerateProbe(spec, variant, {
            lockedPolicies: reference.policies,
          });
          const degenerate = readyProbePolicy(
            probe.compiledPolicySnapshot,
            reference.criterion.candidateSlotId,
          );
          const degenerateLegs = reference.criterion.opponents.map((opponent) => {
            const scores = DECISION_SPACE_SEEDS.map((seed) => {
              const metrics = runPolicyMatchup({
                spec,
                candidatePolicy: degenerate,
                opponentPolicy: opponent.policy,
                opponentLabel: opponent.label,
                ticks: spec.tickBudget.seasonTicks,
                seed,
              });
              return metrics[reference.criterion!.scoreMetricKey];
            });
            return {
              label: opponent.label,
              mean: criterionSpread(scores)?.mean ?? Number.NaN,
              floor: opponent.minimumMeanScore,
            };
          });
          expect(
            degenerateLegs.some((leg) => leg.mean < leg.floor),
            `${title} ${variant} unexpectedly passed: ${JSON.stringify(degenerateLegs)}`,
          ).toBe(true);
          if (variant === "empty") {
            const hostileLeg = degenerateLegs.find(
              (leg) =>
                leg.label === reference.criterion!.emptyPolicyFailureLeg,
            );
            expect(
              hostileLeg,
              `${title} is missing its empty-policy failure leg`,
            ).toBeDefined();
            expect(
              hostileLeg!.mean,
              `${title} empty policy must fail ${hostileLeg!.label}`,
            ).toBeLessThan(hostileLeg!.floor);
          }
        }
        return;
      }

      const criterion = criterionFor(spec);
      const referenceScores = DECISION_SPACE_SEEDS.map((seed) => {
        const metrics = runPolicyDeck({
          spec,
          policies: reference.policies,
          ticks: spec.tickBudget.seasonTicks,
          seed,
        });
        return metrics[criterion.metricKey];
      });
      expect(referenceScores.every(Number.isFinite)).toBe(true);
      const referenceSpread = criterionSpread(referenceScores);
      const deterministicCalibration = criterionSpread([
        referenceScores[0],
        referenceScores[0],
      ]);

      const verdicts = new Map<
        string,
        { verdict: string; referenceMean: number; baselineMean: number }
      >();
      for (const variant of degenerateProbePlan(spec.templateId).variants) {
        const policies = await baselinePolicies(spec, reference, variant);
        const baselineScores = DECISION_SPACE_SEEDS.map((seed) => {
          const metrics = runPolicyDeck({
            spec,
            policies,
            ticks: spec.tickBudget.seasonTicks,
            seed,
          });
          return metrics[criterion.metricKey];
        });
        const separation = criterionSeparation({
          starter: deterministicCalibration,
          reference: referenceSpread,
          degenerate: criterionSpread(baselineScores),
          direction: criterion.direction,
          target: criterion.target,
        });
        verdicts.set(variant, {
          verdict: separation?.verdict ?? "unavailable",
          referenceMean: referenceSpread?.mean ?? Number.NaN,
          baselineMean: criterionSpread(baselineScores)?.mean ?? Number.NaN,
        });
      }

      expect(
        [...verdicts.entries()],
        `${title}: ${JSON.stringify(Object.fromEntries(verdicts))}`,
      ).toSatisfy(
        (
          entries: [
            string,
            { verdict: string; referenceMean: number; baselineMean: number },
          ][],
        ) => entries.every(([, result]) => result.verdict === "separated"),
      );
    },
  );
});
