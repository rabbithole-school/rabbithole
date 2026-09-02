import { describe, expect, it } from "vitest";

import type {
  EcosystemGridConfig,
  EcosystemGridSimulatorSpec,
  LaunchedSpecies,
  PrisonersDilemmaConfig,
  PrisonersDilemmaSimulatorSpec,
} from "../contract";
import type { PolicyIR, PolicyTarget } from "../policyIR";
import type { EcosystemState } from "../templates/ecosystemGrid";
import type { PrisonersDilemmaState } from "../templates/prisonersDilemma";
import { SIMULATOR_TEMPLATES } from "../templates/registry";
import { runTemplate } from "./support/miniRunner";

const SEEDS = ["dawn", "reef", "moss", "rain", "tide"];
const PAYOFFS = {
  mutualCooperation: 3,
  temptation: 5,
  sucker: 0,
  mutualDefection: 1,
} as const;

function action(
  actionKind: string,
  target: PolicyTarget = { kind: "none" },
) {
  return { kind: "action" as const, actionKind, target };
}

const GRAZER_POLICY: PolicyIR = {
  version: 1,
  templateId: "ecosystemGrid",
  slotId: "grazer",
  rules: [
    {
      id: "reproduce-when-able",
      when: [{ kind: "self_energy", op: "gte", value: 13 }],
      then: action("reproduce"),
    },
    {
      id: "graze-here",
      when: [{ kind: "nearest_resource_distance", op: "eq", value: 0 }],
      then: action("graze", { kind: "nearest_resource", direction: "toward" }),
    },
    {
      id: "seek-food",
      when: [{ kind: "nearest_resource_distance", op: "gte", value: 0 }],
      then: action("move", { kind: "nearest_resource", direction: "toward" }),
    },
    { id: "rest", when: [], then: action("rest") },
  ],
  default: { kind: "abstain" },
};

const PREDATOR_POLICY: PolicyIR = {
  version: 1,
  templateId: "ecosystemGrid",
  slotId: "predator",
  rules: [
    {
      id: "eat-nearby-grazer",
      when: [
        {
          kind: "nearest_automaton_distance",
          slotId: "grazer",
          op: "lte",
          value: 1,
        },
      ],
      then: action("eat", {
        kind: "nearest_automaton",
        slotId: "grazer",
        direction: "toward",
      }),
    },
    {
      id: "hunt-grazer",
      when: [
        {
          kind: "nearest_automaton_distance",
          slotId: "grazer",
          op: "gte",
          value: 0,
        },
      ],
      then: action("move", {
        kind: "nearest_automaton",
        slotId: "grazer",
        direction: "toward",
      }),
    },
    { id: "rest", when: [], then: action("rest") },
  ],
  default: { kind: "abstain" },
};

function ecosystemSpec(
  config: EcosystemGridConfig,
  includePredator = false,
): EcosystemGridSimulatorSpec {
  return {
    version: 1,
    templateId: "ecosystemGrid",
    templateVersion: 1,
    config,
    criterion: {
      kind: "measured",
      metricKey: "livingAutomata",
      direction: "maximize",
    },
    speciesSlots: [
      {
        slotId: "grazer",
        label: "Grazers",
        countMin: 1,
        countMax: config.maxAutomata,
        defaultCount: 2,
        senses: [
          {
            senseId: "vision",
            range: 100,
            channels: ["automata", "resources", "boundary"],
          },
        ],
      },
      ...(includePredator
        ? [{
            slotId: "predator",
            label: "Predators",
            countMin: 1,
            countMax: 2,
            defaultCount: 1,
            senses: [{
              senseId: "vision",
              range: 100,
              channels: ["automata", "boundary"],
            }],
          }]
        : []),
    ],
    tickBudget: {
      iterationTicks: 100,
      seasonTicks: 200,
      absoluteMaxTicks: 300,
    },
    interpreter: { kind: "scripted", interpreterId: "compiled-policy-v1" },
    microWorld: false,
  };
}

function ecosystemSpecies(
  spec: EcosystemGridSimulatorSpec,
): LaunchedSpecies[] {
  return spec.speciesSlots.map((slot) => ({
    slotId: slot.slotId,
    label: slot.label,
    count: slot.defaultCount,
    countMax: slot.countMax,
    senses: slot.senses,
    prompt: `Follow the ${slot.label} policy.`,
  }));
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  const average = mean(values);
  return mean(values.map((value) => (value - average) ** 2));
}

function pdPolicy(
  slotId: string,
  rules: PolicyIR["rules"],
): PolicyIR {
  return {
    version: 1,
    templateId: "prisonersDilemma",
    slotId,
    rules,
    default: { kind: "abstain" },
  };
}

const always = (move: "cooperate" | "defect", slotId: string) =>
  pdPolicy(slotId, [{
    id: `always-${move}`,
    when: [],
    then: action(move),
  }]);

const titForTat = (slotId: string) =>
  pdPolicy(slotId, [
    {
      id: "answer-defection",
      when: [{ kind: "last_move", actor: "opponent", move: "defect" }],
      then: action("defect"),
    },
    { id: "cooperate", when: [], then: action("cooperate") },
  ]);

const generousTitForTat = (slotId: string) =>
  pdPolicy(slotId, [
    {
      id: "forgive-mutual-defection",
      when: [
        { kind: "last_move", actor: "self", move: "defect" },
        { kind: "last_move", actor: "opponent", move: "defect" },
      ],
      then: action("cooperate"),
    },
    {
      id: "answer-one-defection",
      when: [{ kind: "last_move", actor: "opponent", move: "defect" }],
      then: action("defect"),
    },
    { id: "cooperate", when: [], then: action("cooperate") },
  ]);

function pdSpec(noiseProbability: number, rounds = 100): PrisonersDilemmaSimulatorSpec {
  return {
    version: 1,
    templateId: "prisonersDilemma",
    templateVersion: 1,
    config: {
      rounds,
      noiseProbability,
      payoffMatrix: PAYOFFS,
      maxAutomata: 2,
    },
    criterion: {
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    },
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
    tickBudget: {
      iterationTicks: 1,
      seasonTicks: rounds,
      absoluteMaxTicks: rounds,
    },
    interpreter: { kind: "scripted", interpreterId: "compiled-policy-v1" },
    microWorld: false,
  };
}

function runPd(
  seed: string,
  config: PrisonersDilemmaConfig,
  deckA: PolicyIR,
  deckB: PolicyIR,
) {
  const spec = pdSpec(config.noiseProbability, config.rounds);
  return runTemplate({
    template: SIMULATOR_TEMPLATES.prisonersDilemma,
    spec,
    seed,
    policies: { deck_a: deckA, deck_b: deckB },
    ticks: config.rounds ?? 50,
  }).finalState as PrisonersDilemmaState;
}

describe("ecosystemGrid canonical dynamics", () => {
  it("settles below the automata cap at a resource-set carrying capacity", () => {
    const config: EcosystemGridConfig = {
      width: 10,
      height: 10,
      boundary: "toroidal",
      initialResourceDensity: 0.35,
      resourceRegrowthPerTick: 0.8,
      corpseDecayTicks: 3,
      baseMetabolicCost: 0.8,
      reproductionEnergyThreshold: 12,
      maxAutomata: 12,
      environmentalNoise: { enabled: false, amplitude: 0 },
    };
    const spec = ecosystemSpec(config);
    const runs = SEEDS.map((seed) =>
      runTemplate({
        template: SIMULATOR_TEMPLATES.ecosystemGrid,
        spec,
        species: ecosystemSpecies(spec),
        seed,
        policies: { grazer: GRAZER_POLICY },
        ticks: 240,
        stopOnTerminal: false,
      }),
    );
    const initialMean = mean(runs.map((run) => run.ticks[0].metrics.livingAutomata));
    const finalQuarterMeans = runs.map((run) =>
      mean(run.ticks.slice(180).map((tick) => tick.metrics.livingAutomata)),
    );
    const finalQuarterVariances = runs.map((run) =>
      variance(run.ticks.slice(180).map((tick) => tick.metrics.livingAutomata)),
    );

    expect(mean(finalQuarterMeans)).toBeGreaterThan(initialMean);
    expect(mean(finalQuarterMeans)).toBeLessThan(config.maxAutomata - 1);
    expect(mean(finalQuarterVariances)).toBeLessThan(2);
    expect(
      finalQuarterMeans.filter((population) => population < config.maxAutomata).length,
    ).toBeGreaterThan(SEEDS.length / 2);
  });

  it("reduces grazer population and longevity under active predation", () => {
    const config: EcosystemGridConfig = {
      width: 8,
      height: 8,
      boundary: "toroidal",
      initialResourceDensity: 0.45,
      resourceRegrowthPerTick: 0.08,
      corpseDecayTicks: 3,
      baseMetabolicCost: 0.75,
      reproductionEnergyThreshold: 12,
      maxAutomata: 12,
      environmentalNoise: { enabled: false, amplitude: 0 },
    };
    const withoutPredator = ecosystemSpec(config);
    const withPredator = ecosystemSpec(config, true);
    const summarize = (spec: EcosystemGridSimulatorSpec, predator: boolean) =>
      SEEDS.map((seed) => {
        const run = runTemplate({
          template: SIMULATOR_TEMPLATES.ecosystemGrid,
          spec,
          species: ecosystemSpecies(spec),
          seed,
          policies: {
            grazer: GRAZER_POLICY,
            ...(predator ? { predator: PREDATOR_POLICY } : {}),
          },
          ticks: 200,
          stopOnTerminal: false,
        });
        const grazerCounts = run.ticks.map((tick) =>
          (tick.state as EcosystemState).automata.filter(
            (automaton) => automaton.slotId === "grazer",
          ).length,
        );
        return {
          meanPopulation: mean(grazerCounts),
          longevity: grazerCounts.findIndex((count) => count === 0) + 1 || run.ticks.length,
        };
      });
    const peaceful = summarize(withoutPredator, false);
    const pressured = summarize(withPredator, true);

    expect(mean(pressured.map((run) => run.meanPopulation))).toBeLessThan(
      mean(peaceful.map((run) => run.meanPopulation)),
    );
    expect(mean(pressured.map((run) => run.longevity))).toBeLessThan(
      mean(peaceful.map((run) => run.longevity)),
    );
  });

  it("goes extinct in bounded time without regrowth", () => {
    const config: EcosystemGridConfig = {
      width: 8,
      height: 8,
      boundary: "bounded",
      initialResourceDensity: 0.03,
      resourceRegrowthPerTick: 0,
      corpseDecayTicks: 3,
      baseMetabolicCost: 1,
      reproductionEnergyThreshold: 10,
      maxAutomata: 12,
      environmentalNoise: { enabled: false, amplitude: 0 },
    };
    const spec = ecosystemSpec(config);
    const extinctionTicks = SEEDS.map((seed) => {
      const run = runTemplate({
        template: SIMULATOR_TEMPLATES.ecosystemGrid,
        spec,
        species: ecosystemSpecies(spec),
        seed,
        policies: { grazer: GRAZER_POLICY },
        ticks: 60,
      });
      expect((run.finalState as EcosystemState).automata).toHaveLength(0);
      return run.ticks.length;
    });
    expect(Math.max(...extinctionTicks)).toBeLessThanOrEqual(45);
  });
});

describe("prisonersDilemma canonical dynamics", () => {
  it("reproduces the classic noise-free matchups", () => {
    const rounds = 50;
    const config: PrisonersDilemmaConfig = {
      rounds,
      noiseProbability: 0,
      payoffMatrix: PAYOFFS,
      maxAutomata: 2,
    };
    for (const seed of SEEDS) {
      const exploitation = runPd(
        seed,
        config,
        always("cooperate", "deck_a"),
        always("defect", "deck_b"),
      );
      expect(exploitation.players[1].totalScore).toBe(PAYOFFS.temptation * rounds);

      const retaliation = runPd(
        seed,
        config,
        titForTat("deck_a"),
        always("defect", "deck_b"),
      );
      expect(retaliation.players[1].totalScore - retaliation.players[0].totalScore)
        .toBeLessThanOrEqual(PAYOFFS.temptation - PAYOFFS.sucker);

      const reciprocity = runPd(
        seed,
        config,
        titForTat("deck_a"),
        titForTat("deck_b"),
      );
      expect(reciprocity.players.every((player) => player.cooperations === rounds)).toBe(true);
    }
  });

  it("preserves more mutual cooperation with one-defection forgiveness under noise", () => {
    const rounds = 200;
    const config: PrisonersDilemmaConfig = {
      rounds,
      noiseProbability: 0.1,
      payoffMatrix: PAYOFFS,
      maxAutomata: 2,
    };
    const mutualCooperations = (state: PrisonersDilemmaState) =>
      state.rounds.filter(
        (round) => round.moves.every((move) => move.move === "cooperate"),
      ).length;
    const tft = SEEDS.map((seed) =>
      mutualCooperations(
        runPd(seed, config, titForTat("deck_a"), titForTat("deck_b")),
      ),
    );
    const generous = SEEDS.map((seed) =>
      mutualCooperations(
        runPd(
          seed,
          config,
          generousTitForTat("deck_a"),
          generousTitForTat("deck_b"),
        ),
      ),
    );

    expect(mean(tft)).toBeLessThan(rounds * 0.8);
    expect(mean(generous)).toBeGreaterThan(mean(tft) + rounds * 0.1);
    expect(
      generous.filter((value, index) => value > tft[index]).length,
    ).toBeGreaterThan(SEEDS.length / 2);
  });
});
