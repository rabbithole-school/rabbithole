import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EcosystemGridSimulatorSpec, SimulatorSpec } from "../../lib/simulator/contract";
import { ECOSYSTEM_GRID_TEMPLATE_VERSION } from "../../lib/simulator/templates/ecosystemGrid";
import { getSimulatorTemplate } from "../../lib/simulator/templates/registry";
import {
  parsePolicyIR,
  type PolicyIR,
  type PolicyRule,
  type ReferencePolicyDeck,
} from "../../lib/simulator/policyIR";
import { canonicalJson } from "../../lib/simulator/prompt";

export const SYSTEMS_AGENTS_UNIT_SLUG = "systems-and-agents";

export function simulatorSpecForStorage(
  spec: SimulatorSpec,
): NonNullable<Doc<"activities">["simulatorSpec"]> {
  const speciesSlots = spec.speciesSlots.map((slot) => ({
    ...slot,
    senses: slot.senses.map((sense) => ({
      ...sense,
      channels: sense.channels ? [...sense.channels] : undefined,
    })),
  }));
  if (spec.templateId === "ecosystemGrid") {
    return {
      ...spec,
      config: {
        ...spec.config,
        environmentalNoise: { ...spec.config.environmentalNoise },
        ...(spec.config.landscape
          ? { landscape: { ...spec.config.landscape } }
          : {}),
      },
      criterion: { ...spec.criterion },
      speciesSlots,
      tickBudget: { ...spec.tickBudget },
      interpreter: { ...spec.interpreter },
    };
  }
  if (spec.templateId === "prisonersDilemma") {
    return {
      ...spec,
      config: {
        ...spec.config,
        payoffMatrix: { ...spec.config.payoffMatrix },
      },
      criterion: {
        ...spec.criterion,
        scoreMetricKeys: [...spec.criterion.scoreMetricKeys],
      },
      speciesSlots,
      tickBudget: { ...spec.tickBudget },
      interpreter: { ...spec.interpreter },
    };
  }
  if (spec.templateId === "matrixGame") {
    return {
      ...spec,
      config: {
        ...spec.config,
        actions: [{ ...spec.config.actions[0] }, { ...spec.config.actions[1] }],
        payoffs: {
          optionA: {
            optionA: { ...spec.config.payoffs.optionA.optionA },
            optionB: { ...spec.config.payoffs.optionA.optionB },
          },
          optionB: {
            optionA: { ...spec.config.payoffs.optionB.optionA },
            optionB: { ...spec.config.payoffs.optionB.optionB },
          },
        },
      },
      criterion:
        spec.criterion.kind === "adversarial"
          ? {
              ...spec.criterion,
              scoreMetricKeys: [...spec.criterion.scoreMetricKeys],
            }
          : { ...spec.criterion },
      speciesSlots,
      tickBudget: { ...spec.tickBudget },
      interpreter: { ...spec.interpreter },
    };
  }
  return {
    ...spec,
    config: { ...spec.config },
    criterion: { ...spec.criterion },
    speciesSlots,
    tickBudget: { ...spec.tickBudget },
    interpreter: { ...spec.interpreter },
  };
}

const ecosystemConfig = {
  boundary: "bounded" as const,
  initialResourceDensity: 0.42,
  resourceRegrowthPerTick: 0.35,
  corpseDecayTicks: 4,
  baseMetabolicCost: 0.7,
  reproductionEnergyThreshold: 14,
  environmentalNoise: { enabled: false, amplitude: 0 },
};

// Shared defaults for the tutorial micro-worlds: a 5×5 reef with one fish. Each
// on-ramp activity overrides the config knobs it needs (density, regrowth,
// metabolic cost, grid size, sight range, tick budget) to author a REAL first
// choice out of the honest physics. Note what the physics can and cannot author:
// regrowth is a single global scalar applied to EVERY cell, and initial algae is
// placed at random cells with uniform biomass 4–8 — so edge-biased regrowth,
// threshold regrowth, and specifically-placed "rich vs poor" patches are NOT
// authorable (they are the Wave-2 terrain features deferred in
// review/simulator-depth-proposal.html §1). The on-ramp tension below is built
// only from levers the engine actually exposes.
const MICRO_BASE_CONFIG = {
  ...ecosystemConfig,
  width: 5,
  height: 5,
  maxAutomata: 1,
} as const;

function microSimulatorSpec(input: {
  senses: SimulatorSpec["speciesSlots"][number]["senses"];
  criterion: EcosystemGridSimulatorSpec["criterion"];
  starterHint: string;
  config?: Partial<EcosystemGridSimulatorSpec["config"]>;
  tickBudget?: EcosystemGridSimulatorSpec["tickBudget"];
}): EcosystemGridSimulatorSpec {
  return {
    version: 1,
    templateId: "ecosystemGrid",
    templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
    config: { ...MICRO_BASE_CONFIG, ...input.config },
    criterion: input.criterion,
    speciesSlots: [
      {
        // The species is a concrete creature ("Fish"), never "Automaton" —
        // "automaton" is the generic word for ONE individual of ANY species
        // (the intro lesson teaches that concept; the creature is still a fish).
        slotId: "fish",
        label: "Fish",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: input.senses,
        starterHint: input.starterHint,
      },
    ],
    tickBudget: input.tickBudget ?? {
      iterationTicks: 30,
      seasonTicks: 30,
      absoluteMaxTicks: 30,
    },
    interpreter: { kind: "llm", role: "AUTOMATON" },
    microWorld: true,
  };
}

export const REEF_SIMULATOR_SPEC: SimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  config: {
    ...ecosystemConfig,
    width: 12,
    height: 8,
    maxAutomata: 12,
    environmentalNoise: { enabled: true, amplitude: 0.08 },
  },
  criterion: {
    kind: "measured",
    metricKey: "longevity",
    direction: "maximize",
  },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Grazer fish",
      countMin: 1,
      countMax: 5,
      defaultCount: 4,
      senses: [
        { senseId: "vision", range: 4, channels: ["automata", "resources", "boundary"] },
        { senseId: "smell", range: 4, channels: ["resources"] },
      ],
      starterHint: "Find algae, graze when you reach it, and preserve enough energy to survive.",
    },
    {
      slotId: "predator",
      label: "Shark",
      countMin: 0,
      countMax: 2,
      defaultCount: 0,
      senses: [{ senseId: "smell", range: 6, channels: ["automata", "corpses"] }],
      starterHint: "Hunt by smell. You are blind, so never assume you can see the reef.",
    },
    {
      slotId: "cleaner",
      label: "Cleaner shrimp",
      countMin: 0,
      countMax: 3,
      defaultCount: 0,
      senses: [
        {
          senseId: "touch",
          range: 1,
          channels: ["automata", "resources", "corpses", "boundary"],
        },
      ],
      starterHint: "You perceive only what you can touch. Stay useful without guessing at distance.",
    },
    {
      slotId: "open_niche",
      label: "Open niche",
      countMin: 0,
      countMax: 2,
      defaultCount: 0,
      senses: [
        { senseId: "vision", range: 2, channels: ["automata", "resources", "boundary"] },
        { senseId: "smell", range: 3, channels: ["automata", "resources", "corpses"] },
      ],
      starterHint: "Invent a niche that helps the whole reef last longer.",
    },
  ],
  tickBudget: {
    iterationTicks: 60,
    seasonTicks: 200,
    absoluteMaxTicks: 200,
  },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: false,
};

// ── Commons: "The shared shoal" (tragedy of the commons) ──────────────────
// A full ecosystem world built ONLY from existing mechanics, tuned so the
// DEFAULT outcome is overgrazing. The dilemma is pure arithmetic:
//
//   • Each graze strips GRAZE_AMOUNT = 3 biomass from the grazer's cell.
//   • A cell caps at RESOURCE_CAPACITY = 10 and regrows +0.2 biomass/tick.
//   • So one grazer parked on a cell removes 3/tick while it regrows only
//     0.2/tick: the cell is stripped in ~2 grazes and then needs 3 / 0.2 = 15
//     ticks to grow back even one more graze's worth (3 biomass).
//   • The field is an 8×6 grid seeded at density 0.5 → ~24 algae cells, each
//     4–8 biomass at start (~144 standing biomass). Whole-field regrowth is
//     ~24 × 0.2 = 4.8 biomass/tick; the 10 default grazers demand up to
//     10 × 3 = 30 biomass/tick. Demand outstrips regrowth ~6:1, so unrestrained
//     grazing strips the shoal bare within a handful of ticks and the grazers
//     starve (baseMetabolicCost 0.7/tick, no food → death in ~12–16 ticks).
//
// A grazer that grazes every tick dooms the shoal; one that grazes ~once every
// four ticks nets +3 − 4 × 0.7 ≈ +0.2 energy and can persist. Resting halves
// upkeep to 0.35/tick. So longevity is bought with RESTRAINT — graze sparingly,
// rest, move on before a patch is bare, leave biomass to regrow — which is what
// the scholar has to write. The criterion measures how long the whole system
// lasts, not any one fish's score.
export const SHARED_SHOAL_SIMULATOR_SPEC: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  config: {
    ...ecosystemConfig,
    width: 8,
    height: 6,
    maxAutomata: 12,
    initialResourceDensity: 0.5,
    resourceRegrowthPerTick: 0.2,
  },
  criterion: {
    kind: "measured",
    metricKey: "longevity",
    direction: "maximize",
  },
  speciesSlots: [
    {
      slotId: "parrotfish",
      label: "Parrotfish",
      countMin: 1,
      countMax: 5,
      defaultCount: 4,
      senses: [
        { senseId: "vision", range: 4, channels: ["resources", "boundary", "automata"] },
      ],
      starterHint:
        "You share one algae field with the whole shoal. When you reach algae, will you graze it down to nothing? Watch what happens to the field when every fish does that. See if you can change your rule so there's still algae growing many ticks from now.",
    },
    {
      slotId: "surgeonfish",
      label: "Surgeonfish",
      countMin: 1,
      countMax: 4,
      defaultCount: 3,
      senses: [
        { senseId: "vision", range: 4, channels: ["resources", "boundary", "automata"] },
      ],
      starterHint:
        "You graze the same field as every other fish here. If you and your neighbours all crowd one patch, how long can it last? Try spreading out or waiting, and see whether the shoal survives longer.",
    },
    {
      slotId: "rabbitfish",
      label: "Rabbitfish",
      countMin: 1,
      countMax: 4,
      defaultCount: 3,
      senses: [
        { senseId: "vision", range: 4, channels: ["resources", "boundary", "automata"] },
      ],
      starterHint:
        "The algae grows back slowly — much slower than a hungry shoal can eat it. What's the least you can graze and still keep your energy up? Find a rhythm that feeds you without emptying the field.",
    },
  ],
  tickBudget: {
    iterationTicks: 60,
    seasonTicks: 150,
    absoluteMaxTicks: 150,
  },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: false,
};

// ── Generations: heredity worlds (selection you have to DISCOVER) ──────────
// These use the merged heredity physics: with config.heredity.enabled, every
// offspring inherits its parent's metabolic-cost multiplier (`trait`, clamped
// 0.5–2) plus a small Gaussian mutation (mutationStd). A lower trait means a
// cheaper body. `traitMean` is the population's average trait; a criterion on
// traitMean REQUIRES heredity enabled (validated).
//
// "Built to last": scarcity that ordinary decks SURVIVE (empirically ~22/24
// seeded runs reach the full 240-tick season) while metabolic selection is
// visible — a costly body (high metabolic trait) burns out under scarcity before
// it can breed, so the survivors' offspring are cheaper and the population's
// average build drifts DOWN (measured traitMean ≈ 0.70 from a founder mean of
// 1.0). Tuned against the real v2 physics with a scratch measurement harness: the
// old 0.8-cost / 0.35-density config drove every deck extinct and hid selection;
// density 0.6 + regrowth 0.6 + base 0.6 keeps a breeding population turning over
// enough generations for the drift to show. The criterion minimizes traitMean, so
// the scholar's job is to keep the shoal breeding long enough for it to appear.
// The scholar never hears the words for it; the drift is the discovery.
export const BUILT_TO_LAST_SIMULATOR_SPEC: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  config: {
    boundary: "bounded",
    initialResourceDensity: 0.6,
    resourceRegrowthPerTick: 0.6,
    corpseDecayTicks: 2,
    baseMetabolicCost: 0.6,
    reproductionEnergyThreshold: 10,
    environmentalNoise: { enabled: false, amplitude: 0 },
    heredity: { enabled: true, mutationStd: 0.25 },
    width: 10,
    height: 8,
    maxAutomata: 12,
  },
  criterion: {
    kind: "measured",
    metricKey: "traitMean",
    direction: "minimize",
  },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Reef grazers",
      countMin: 1,
      countMax: 12,
      defaultCount: 8,
      senses: [
        { senseId: "vision", range: 3, channels: ["resources", "automata"] },
      ],
      starterHint:
        "Food is thin here, so every fish that survives long enough will breed, and its young start life a little like their parent — but not exactly. Before you run it: what kind of body do you think the shoal will end up with after many generations, and why? Write a rule that keeps your grazers fed and breeding, then watch the young that follow.",
    },
  ],
  tickBudget: {
    iterationTicks: 80,
    seasonTicks: 240,
    absoluteMaxTicks: 240,
  },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: false,
};

// "When the world flips": the SAME grazers, but the world is turned over — food
// everywhere (abundance) and a shark hunting the shoal, the whole reef in
// shallows so a fish must SEE well to react in time. Now a cheap dim body is no
// longer what keeps you alive; a sharp-eyed fish spots the shark sooner and lives
// to breed, so the SAME heredity that drove the build cheaper under scarcity now
// drives perception UP (measured perceptionMean ≈ 1.11 with predation+abundance
// vs ≈ 0.91 in the "Built to last" scarcity world — a real divergence in both
// directions, both worlds surviving ~22-24/24 seeded runs). The criterion
// maximizes perceptionMean; the scholar predicts the direction and checks it.
export const SIMULATOR_FLIPS_SIMULATOR_SPEC: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  config: {
    boundary: "bounded",
    initialResourceDensity: 1,
    resourceRegrowthPerTick: 1,
    corpseDecayTicks: 2,
    baseMetabolicCost: 0.6,
    reproductionEnergyThreshold: 10,
    environmentalNoise: { enabled: false, amplitude: 0 },
    heredity: { enabled: true, mutationStd: 0.25 },
    width: 10,
    height: 8,
    maxAutomata: 12,
    terrain: {
      shelter: [],
      current: [],
      shallows: Array.from({ length: 8 }, (_, y) =>
        Array.from({ length: 10 }, (_, x) => ({ x, y })),
      ).flat(),
      predatorSlotIds: ["predator"],
    },
  },
  criterion: {
    kind: "measured",
    metricKey: "perceptionMean",
    direction: "maximize",
  },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Reef grazers",
      countMin: 1,
      countMax: 12,
      defaultCount: 8,
      senses: [
        { senseId: "vision", range: 3, channels: ["automata"] },
        { senseId: "touch", range: 0, channels: ["resources"] },
      ],
      starterHint:
        "Now there's algae everywhere and a shark on the prowl. In the last world a cheaper body was what kept a fish alive to breed — is that still true here? Predict what happens to the shoal's build this time, then run it and see if the young turn out the way you expected.",
    },
    {
      slotId: "predator",
      label: "Shark",
      countMin: 0,
      countMax: 2,
      defaultCount: 2,
      senses: [{ senseId: "smell", range: 6, channels: ["automata"] }],
      starterHint: "Hunt by smell. You are blind, so never assume you can see the reef.",
    },
  ],
  tickBudget: {
    iterationTicks: 60,
    seasonTicks: 60,
    absoluteMaxTicks: 60,
  },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: false,
};

// "Leave enough behind" world (see the activity comment for the full design).
// One scholar-authored grazer + one fixed teacher shark; a barren shelter cluster
// the shark cannot enter. Kept a microWorld (quick on-ramp iterations) even though
// it now runs two slots — the scholar still writes a single restraint deck.
export const LEAVE_ENOUGH_SIMULATOR_SPEC: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  config: {
    boundary: "bounded",
    initialResourceDensity: 0.22,
    resourceRegrowthPerTick: 0.4,
    corpseDecayTicks: 3,
    baseMetabolicCost: 0.7,
    reproductionEnergyThreshold: 14,
    environmentalNoise: { enabled: false, amplitude: 0 },
    width: 6,
    height: 6,
    maxAutomata: 4,
    scoringSlotId: "fish",
    terrain: {
      shelter: [
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 },
      ],
      current: [],
      shallows: [],
      predatorSlotIds: ["shark"],
    },
  },
  criterion: {
    kind: "measured",
    metricKey: "scoringSlotSurvivors",
    direction: "maximize",
  },
  speciesSlots: [
    {
      slotId: "fish",
      label: "Reef grazer",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [
        { senseId: "vision", range: 3, channels: ["resources", "terrain", "automata", "boundary"] },
      ],
      starterHint:
        "Each bite removes more algae than one day of regrowth replaces, and a shark shares this reef. The coral shelter keeps you safe but grows no food. When should your fish feed in the open, and when should it duck into the barren shelter? Try a rule, run it, and see whether your fish is still alive on the last day — then change one thing and run it again.",
    },
    {
      slotId: "shark",
      label: "Reef shark",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "smell", range: 4, channels: ["automata", "corpses"] }],
      starterHint: "Hunt the grazer by smell. You cannot enter the coral shelter, so wait near its edges.",
      // The shark is a FIXED teacher foil: its rules are locked (visible,
      // read-only) so the scholar solves the reef around a predator whose
      // behavior they can read but not rewrite. The scholar authors only the
      // grazer deck.
      locked: true,
    },
  ],
  tickBudget: {
    iterationTicks: 50,
    seasonTicks: 50,
    absoluteMaxTicks: 50,
  },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: true,
};

// "Two hunters" is a bounded probe of sensory access, not a relationship model:
// hiding removes the grazer from vision only. The two locked hunters make that
// difference inspectable without attributing intent, kinship, or shared memory.
export const TWO_HUNTERS_SIMULATOR_SPEC: EcosystemGridSimulatorSpec = {
  version: 1,
  templateId: "ecosystemGrid",
  templateVersion: ECOSYSTEM_GRID_TEMPLATE_VERSION,
  config: {
    boundary: "toroidal",
    initialResourceDensity: 0,
    resourceRegrowthPerTick: 0,
    corpseDecayTicks: 3,
    baseMetabolicCost: 0,
    reproductionEnergyThreshold: 20,
    environmentalNoise: { enabled: false, amplitude: 0 },
    width: 5,
    height: 5,
    maxAutomata: 3,
    initialPositions: {
      grazer: [{ x: 3, y: 3 }],
      visual_hunter: [{ x: 0, y: 2 }],
      scent_hunter: [{ x: 0, y: 0 }],
    },
    scoringSlotId: "grazer",
  },
  criterion: {
    kind: "measured",
    metricKey: "scoringSlotSurvivors",
    direction: "maximize",
  },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Reef grazer",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "vision", range: 3, channels: ["automata"] }],
      starterHint:
        "What changes when you hide from each hunter? Read their locked decks, make a prediction, and inspect one run day by day.",
    },
    {
      slotId: "visual_hunter",
      label: "Sight hunter",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "vision", range: 3, channels: ["automata"] }],
      starterHint: "Follow a visible grazer. If none is visible, wait.",
      locked: true,
    },
    {
      slotId: "scent_hunter",
      label: "Scent hunter",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "smell", range: 4, channels: ["automata"] }],
      starterHint: "Follow a grazer when its scent reaches you. Otherwise, wait.",
      locked: true,
    },
  ],
  tickBudget: {
    iterationTicks: 8,
    seasonTicks: 8,
    absoluteMaxTicks: 8,
  },
  interpreter: { kind: "llm", role: "AUTOMATON" },
  microWorld: true,
};

function ecosystemPolicy(slotId: string, rules: PolicyRule[]): PolicyIR {
  const template = getSimulatorTemplate("ecosystemGrid");
  if (!template) throw new Error("ecosystemGrid template is not registered");
  return parsePolicyIR(
    {
      version: 1,
      templateId: "ecosystemGrid",
      slotId,
      rules,
      default: { kind: "abstain" },
    },
    {
      templateId: "ecosystemGrid",
      slotId,
      actionKinds: template.actionKinds,
    },
  );
}

const none = { kind: "none" } as const;
const towardResource = { kind: "nearest_resource", direction: "toward" } as const;
const forageRules = (): PolicyRule[] => [
  {
    id: "graze-here",
    when: [{ kind: "nearest_resource_distance", op: "eq", value: 0 }],
    then: { kind: "action", actionKind: "graze", target: towardResource },
  },
  {
    id: "seek-food",
    when: [{ kind: "nearest_resource_distance", op: "gte", value: 0 }],
    then: { kind: "action", actionKind: "move", target: towardResource },
  },
];
const searchSweepRules = (): PolicyRule[] => [
  {
    id: "search-east-1",
    when: [{ kind: "tick", op: "lt", value: 10 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "east" } },
  },
  {
    id: "search-south-1",
    when: [{ kind: "tick", op: "lt", value: 20 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "south" } },
  },
  {
    id: "search-west-1",
    when: [{ kind: "tick", op: "lt", value: 30 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "west" } },
  },
  {
    id: "search-south-2",
    when: [{ kind: "tick", op: "lt", value: 40 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "south" } },
  },
  {
    id: "search-east-2",
    when: [{ kind: "tick", op: "lt", value: 50 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "east" } },
  },
  {
    id: "search-north-1",
    when: [{ kind: "tick", op: "lt", value: 60 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "north" } },
  },
  {
    id: "search-west-2",
    when: [{ kind: "tick", op: "lt", value: 70 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "west" } },
  },
  {
    id: "search-north-2",
    when: [{ kind: "tick", op: "lt", value: 80 }],
    then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "north" } },
  },
];

export const SYSTEMS_AGENTS_REFERENCE_DECKS: Readonly<
  Record<string, ReferencePolicyDeck>
> = {
  "The ebbing tide": {
    summary: "Graze reachable algae, seek any sensed patch, and sweep the bounded reef eastward.",
    preflightStory: {
      setup:
        "A fish must decide whether to leave its first algae patch and search the reef before the tide runs out.",
      clearTemplate:
        "A fish that searched the reef for algae stayed alive {referenceMean} ticks, and the starter hints reached {starterMean}. Fish that only wandered, rested, or grabbed the nearest patch lasted {shortcutRange} ticks, so a scholar still has to work out the search.",
    },
    policies: [
      ecosystemPolicy("fish", [
        ...forageRules(),
        {
          id: "turn-south",
          when: [{ kind: "boundary", direction: "east", present: true }],
          then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "south" } },
        },
        {
          id: "turn-west",
          when: [{ kind: "boundary", direction: "south", present: true }],
          then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "west" } },
        },
        {
          id: "turn-north",
          when: [{ kind: "boundary", direction: "west", present: true }],
          then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "north" } },
        },
        {
          id: "sweep-east",
          when: [],
          then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "east" } },
        },
      ]),
    ],
  },
  "Leave enough behind": {
    summary: "Feed when energy is low, retreat from a nearby shark, and conserve energy in shelter.",
    policies: [
      ecosystemPolicy("fish", [
        {
          id: "rest-safe",
          when: [
            { kind: "terrain_here", terrainKind: "shelter" },
            { kind: "self_energy", op: "gte", value: 6 },
          ],
          then: { kind: "action", actionKind: "rest", target: none },
        },
        {
          id: "flee-to-shelter",
          when: [{ kind: "nearest_automaton_distance", slotId: "shark", op: "lte", value: 3 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_terrain", terrainKind: "shelter", direction: "toward" },
          },
        },
        {
          id: "graze-when-hungry",
          when: [
            { kind: "self_energy", op: "lte", value: 8 },
            { kind: "nearest_resource_distance", op: "eq", value: 0 },
          ],
          then: { kind: "action", actionKind: "graze", target: towardResource },
        },
        ...forageRules().slice(1),
        {
          id: "conserve",
          when: [],
          then: { kind: "action", actionKind: "rest", target: none },
        },
      ]),
      ecosystemPolicy("shark", [
        {
          id: "eat-fish",
          when: [{ kind: "nearest_automaton_distance", slotId: "fish", op: "lte", value: 1 }],
          then: {
            kind: "action",
            actionKind: "eat",
            target: { kind: "nearest_automaton", slotId: "fish", direction: "toward" },
          },
        },
        {
          id: "hunt-fish",
          when: [{ kind: "nearest_automaton_distance", slotId: "fish", op: "gte", value: 0 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_automaton", slotId: "fish", direction: "toward" },
          },
        },
        {
          id: "wait",
          when: [],
          then: { kind: "action", actionKind: "rest", target: none },
        },
      ]),
    ],
  },
  "Two hunters": {
    summary:
      "The grazer moves away from a scent hunter and hides from a sight hunter; the two locked hunters follow only what their own senses reveal.",
    policies: [
      ecosystemPolicy("grazer", [
        {
          id: "flee-scent",
          when: [{ kind: "nearest_automaton_distance", slotId: "scent_hunter", op: "lte", value: 3 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_automaton", slotId: "scent_hunter", direction: "away" },
          },
        },
        {
          id: "hide-from-sight",
          when: [{ kind: "nearest_automaton_distance", slotId: "visual_hunter", op: "lte", value: 3 }],
          then: { kind: "action", actionKind: "hide", target: none },
        },
        { id: "wait", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
      ecosystemPolicy("visual_hunter", [
        {
          id: "eat-visible-grazer",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "lte", value: 1 }],
          then: {
            kind: "action",
            actionKind: "eat",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        {
          id: "follow-visible-grazer",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "gte", value: 0 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        { id: "wait", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
      ecosystemPolicy("scent_hunter", [
        {
          id: "eat-smelled-grazer",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "lte", value: 1 }],
          then: {
            kind: "action",
            actionKind: "eat",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        {
          id: "follow-smelled-grazer",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "gte", value: 0 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        { id: "wait", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
    ],
  },
  "The far feast": {
    summary: "Follow nearby scent, graze on arrival, and otherwise commit east toward the far shallows.",
    policies: [
      ecosystemPolicy("fish", [
        ...forageRules(),
        {
          id: "commit-east",
          when: [],
          then: { kind: "action", actionKind: "move", target: { kind: "direction", direction: "east" } },
        },
      ]),
    ],
  },
  "The Reef": {
    summary: "A restrained grazer deck seeks algae, breeds when able, and rests when well fed.",
    policies: [
      ecosystemPolicy("grazer", [
        ...forageRules().slice(0, 1),
        {
          id: "breed",
          when: [{ kind: "self_energy", op: "gte", value: 14 }],
          then: { kind: "action", actionKind: "reproduce", target: none },
        },
        ...forageRules().slice(1),
        {
          id: "rest",
          when: [],
          then: { kind: "action", actionKind: "rest", target: none },
        },
      ]),
      ecosystemPolicy("predator", [
        {
          id: "eat-grazer",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "lte", value: 1 }],
          then: {
            kind: "action",
            actionKind: "eat",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        {
          id: "hunt-grazer",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "gte", value: 0 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        { id: "wait", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
      ecosystemPolicy("cleaner", [
        ...forageRules(),
        { id: "wait", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
      ecosystemPolicy("open_niche", [
        ...forageRules(),
        { id: "wait", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
    ],
  },
  "The shared shoal": {
    summary: "Each grazer waits while fed and seeks or grazes only after its energy falls.",
    policies: ["parrotfish", "surgeonfish", "rabbitfish"].map((slotId) =>
      ecosystemPolicy(slotId, [
        {
          id: "graze-when-hungry",
          when: [
            { kind: "self_energy", op: "lte", value: 6 },
            { kind: "nearest_resource_distance", op: "eq", value: 0 },
          ],
          then: { kind: "action", actionKind: "graze", target: towardResource },
        },
        {
          id: "seek-when-hungry",
          when: [
            { kind: "self_energy", op: "lte", value: 6 },
            { kind: "nearest_resource_distance", op: "gte", value: 0 },
          ],
          then: { kind: "action", actionKind: "move", target: towardResource },
        },
        { id: "ration", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
    ),
  },
  "Built to last": {
    summary: "Keep the population feeding and reproducing so many inherited builds face scarcity.",
    policies: [
      ecosystemPolicy("grazer", [
        {
          id: "breed",
          when: [{ kind: "self_energy", op: "gte", value: 10 }],
          then: { kind: "action", actionKind: "reproduce", target: none },
        },
        ...forageRules(),
        ...searchSweepRules(),
        { id: "rest", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
    ],
  },
  "When the world flips": {
    summary: "Grazers flee a sensed shark, feed and breed; the shark follows its sensed prey.",
    policies: [
      ecosystemPolicy("grazer", [
        {
          id: "flee",
          when: [{ kind: "nearest_automaton_distance", slotId: "predator", op: "lte", value: 3 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_automaton", slotId: "predator", direction: "away" },
          },
        },
        {
          id: "breed",
          when: [{ kind: "self_energy", op: "gte", value: 10 }],
          then: { kind: "action", actionKind: "reproduce", target: none },
        },
        ...forageRules().slice(0, 1),
        ...searchSweepRules(),
        { id: "rest", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
      ecosystemPolicy("predator", [
        {
          id: "eat",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "lte", value: 1 }],
          then: {
            kind: "action",
            actionKind: "eat",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        {
          id: "hunt",
          when: [{ kind: "nearest_automaton_distance", slotId: "grazer", op: "gte", value: 0 }],
          then: {
            kind: "action",
            actionKind: "move",
            target: { kind: "nearest_automaton", slotId: "grazer", direction: "toward" },
          },
        },
        { id: "wait", when: [], then: { kind: "action", actionKind: "rest", target: none } },
      ]),
    ],
  },
};

export const SYSTEMS_AGENTS_LESSONS = [
  {
    title: "First Automaton",
    order: 0,
    activities: [
      {
        // "The ebbing tide" (repurposes "Find the algae"). The audit's verdict:
        // "find food and eat it" had one obvious answer. Here the first prompt is
        // a policy, not a command — camp or migrate.
        //
        // Honest arithmetic (grid 5×5, no regrowth, metabolic 1.4/tick moving,
        // 0.7 resting; a graze adds min(3, patch)):
        //  - resourceRegrowthPerTick 0 → the ~6 starting algae cells
        //    (25 × 0.24) of 4–8 biomass are the ENTIRE food supply for the tide;
        //    it only ebbs, never refills. (Edge-biased "the sea recedes to the
        //    reef rim" is Wave-2 terrain; a zero global-regrowth stock is the
        //    honest stand-in — a fixed, depleting larder under a hard clock.)
        //  - Start energy = reproductionEnergyThreshold 14 × (0.6–0.8) ≈ 8.4–11.2.
        //    With no food a fish lasts ~6–8 moving ticks; to reach the 30-tick
        //    tide it must graze across several separate patches.
        //  - Camp the first patch (say 6 biomass → 2 bites, +6 energy) and, with
        //    nothing regrowing, the fish starves around tick ~18 on bare rock.
        //    Searching for the other patches can reach tick 30.
        //  A real first choice, and longevity (capped at the 30-tick budget)
        //  rewards the fish that is still alive when the tide ends.
        title: "The ebbing tide",
        description:
          "Write one deck for a single fish, and open the inspector to see what it perceives. The tide is going out — the algae scattered across the reef now is all there will be; none of it grows back. Your fish can see only a couple of cells around it, and starts with barely enough energy to go looking. When it reaches the first patch, is that enough to last the whole tide, or does staying put leave it starving on bare rock while other food sits just out of sight?",
        scholarDescription:
          "Write rules for a fish as the tide goes out. Help it explore the reef and find enough food to last.",
        simulatorSpec: microSimulatorSpec({
          senses: [{ senseId: "vision", range: 2, channels: ["resources", "boundary"] }],
          criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
          starterHint:
            "The algae you can see now won't grow back, and you can only see a couple of cells around you. Eat the first patch you find — then what? Is that enough to last, or is it worth spending energy to search for more before it runs out? And what should your fish do on the ticks when there's no algae in sight at all?",
          config: {
            width: 5,
            height: 5,
            maxAutomata: 1,
            initialResourceDensity: 0.24,
            resourceRegrowthPerTick: 0,
            baseMetabolicCost: 1.4,
          },
          tickBudget: { iterationTicks: 30, seasonTicks: 30, absoluteMaxTicks: 30 },
        }),
      },
      {
        // "Leave enough behind" (repurposes "Graze every patch"), rebuilt on
        // ecosystemGrid v2 terrain. Phase 1 killed the old minimize-biomass
        // criterion (which rewarded stripping the reef bare) and restored
        // longevity; this pass adds the SHELTER tradeoff so the question becomes
        // WHERE restraint matters, not only how much — the founder's
        // systems-thinking priority (three interacting feedback loops at once).
        // The scholar still authors exactly ONE deck (the grazer); a lone reef
        // shark is a fixed teacher foil (like Trader Ben in the sister unit), so
        // the "write one restraint prompt, change one condition" scaffold holds.
        //
        // Why a foil at all: v2 regrowth is a flat per-cell scalar, so for a lone
        // grazer a barren shelter zone is meaningless — shelter only earns its
        // place as a predator refuge (a shark cannot enter shelter cells, and no
        // algae grows there). Now three tensions collide: graze vs field regrowth
        // (over-graze and the field collapses — greedy starves), forage vs
        // predation (the open field feeds you but exposes you), and shelter vs
        // starvation (safe but barren). Measured over 24 seeds: a greedy
        // strip-everything deck dies early (~25 ticks) while shelter-cycling
        // (~43) and open-field rationing (~33) are BOTH distinctly viable — each
        // wins on different seeds — so there is a real WHERE decision, not one
        // answer. Verified with a scratch harness; assertions ported to the tests.
        title: "Leave enough behind",
        description:
          "One reef, one hungry fish, and a shark whose rules are set — you can read how it hunts, but you write only your own fish. Each bite removes more algae than one day of regrowth replaces, so eating everything at once can leave your fish with too little later. There's a patch of coral your fish can hide in where the shark can't follow, but no algae grows there — safe and empty. So restraint isn't only about how big a bite to take; it's about where. When do you feed in the open, and when do you duck into the barren shelter? Keep your fish alive through the last day.",
        scholarDescription:
          "Guide a fish through a reef with food, shelter, and a shark. Try different rules to help it make it through the day.",
        simulatorSpec: LEAVE_ENOUGH_SIMULATOR_SPEC,
      },
      {
        // "The far feast" (repurposes "Survive on smell alone"), rebuilt on
        // ecosystemGrid v2 terrain. The phase-1 version had a fatal flaw the
        // decision-space audit found: always-REST beat every seeking deck (a
        // resting fish halves its burn and outlives one that wanders blindly and
        // starves). Terrain fixes it with a REAL renewable feast worth the risk:
        //  - A SHALLOWS band on the east edge regrows algae at 2× the base rate
        //    (0.28 → 0.56/cell/tick) — a renewable larder a committed fish can
        //    live off, unlike the sparse ambient food (density 0.14). Shallows
        //    also SHORTEN smell by 2, so the fish reaches the feast partly blind.
        //  - A CURRENT lane (row y=3, pushing east) carries a committed fish
        //    toward the feast — but a current sweeps whoever is on it, so crossing
        //    costs control (you can be carried past what you were reaching for).
        //  - Sparse ambient food + low start energy (threshold 10 → start ≈ 7)
        //    make resting LOSE: measured over 24 seeds, rest ≈ 17 ticks while the
        //    best informed seeking ≈ 24 and reaches the full 45-tick season when
        //    it settles on the feast. Near-small vs far-rich is a real per-seed
        //    bet — near wins some seeds, the far feast wins more — so the first
        //    prompt is a genuine wager on incomplete information, not a one-liner.
        // Verified with a scratch measurement harness against the real v2
        // validateSpec + engine (assertions ported to the drift tests).
        title: "The far feast",
        description:
          "This fish is nearly blind — it can only smell algae in the cells closest to it, and there is a rich feast growing in the warm shallows across the reef, too far to smell from here. A current runs that way and could carry your fish toward it, though a current sweeps you along whether you like it or not. The food nearby is thin and won't last. Does your fish gamble on the long crossing to a feast it can't yet smell, or work the sparse patches close by? Writing for a fish that only smells means betting on what you can't yet know.",
        scholarDescription:
          "Your fish can smell only nearby algae, but a far-off feast may be waiting. Choose a plan and see where the current takes it.",
        simulatorSpec: microSimulatorSpec({
          senses: [{ senseId: "smell", range: 4, channels: ["resources"] }],
          criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
          starterHint:
            "Your fish only smells algae right around it — not the feast in the far shallows, and not the walls. Resting saves energy but never finds food. When a scent is close, is it worth the bite, or should your fish ride the current toward the richer water it can't smell yet? Try committing to the crossing, then try working the near patches, and see which keeps your fish alive longer.",
          config: {
            width: 7,
            height: 7,
            maxAutomata: 1,
            initialResourceDensity: 0.14,
            resourceRegrowthPerTick: 0.28,
            baseMetabolicCost: 0.8,
            reproductionEnergyThreshold: 10,
            terrain: {
              shelter: [],
              current: [
                { x: 2, y: 3, direction: "east" },
                { x: 3, y: 3, direction: "east" },
                { x: 4, y: 3, direction: "east" },
              ],
              shallows: [
                { x: 6, y: 2 }, { x: 6, y: 3 }, { x: 6, y: 4 },
                { x: 5, y: 2 }, { x: 5, y: 3 }, { x: 5, y: 4 },
              ],
              predatorSlotIds: [],
            },
          },
          tickBudget: { iterationTicks: 45, seasonTicks: 45, absoluteMaxTicks: 45 },
        }),
      },
      {
        title: "Two hunters",
        description:
          "Two hunters search for the same reef grazer. You can change only the grazer's deck. What changes when the grazer hides? Read the locked decks, make a prediction, then tap each hunter and use Mind to inspect the same day from both points of view.",
        scholarDescription:
          "Change the grazer’s rules and watch two hunters search the reef. Explore what each creature notices as the day unfolds.",
        simulatorSpec: TWO_HUNTERS_SIMULATOR_SPEC,
      },
    ],
  },
  {
    title: "The Reef",
    order: 1,
    activities: [
      {
        title: "The Reef",
        description:
          "Begin with grazers and algae, then build toward a predator, cleaners, and an open niche. Compare every deck against your own best longevity rather than a distant ceiling.",
        scholarDescription:
          "Build a reef world with fish, algae, and new roles to try. Run your ideas and see how the whole system changes.",
        simulatorSpec: REEF_SIMULATOR_SPEC,
      },
      {
        title: "The shared shoal",
        description:
          "One algae field, one whole shoal of grazers, and algae that grows back far slower than a hungry shoal can eat it. If every fish grazes whenever it can, the field is stripped bare in a few ticks and the shoal starves. Your job is the opposite of eating as fast as you can: write behavior that leaves enough algae growing so the whole system lasts. How long can you keep the shoal alive?",
        scholarDescription:
          "Guide a whole shoal sharing one algae field. Can you write rules that keep food growing long enough for everyone?",
        simulatorSpec: SHARED_SHOAL_SIMULATOR_SPEC,
      },
    ],
  },
  {
    title: "Generations",
    order: 2,
    activities: [
      {
        title: "Built to last",
        description:
          "Food is scarce here, and fish that survive long enough will have young — and each young fish starts life almost like its parent, but not quite. Run your shoal for many generations and watch the young that follow. Before you press run, write down a prediction: what kind of body will the shoal end up with, and why should the survivors' offspring be any different from the shoal you started with?",
        scholarDescription:
          "Design a shoal that can survive and have young over many generations. Run the world and watch what changes over time.",
        simulatorSpec: BUILT_TO_LAST_SIMULATOR_SPEC,
      },
      {
        title: "When the world flips",
        description:
          "Same fish, same way of passing traits to their young — but now the world has changed: algae is everywhere, and a shark hunts the shoal. In the last world, one kind of body lasted longer than the others. Does the same thing happen here, or does a different world grow a different shoal? Predict first, then run it and compare.",
        scholarDescription:
          "The reef has changed: food is plentiful, but a shark is hunting. Try new rules and see how your shoal adapts.",
        simulatorSpec: SIMULATOR_FLIPS_SIMULATOR_SPEC,
      },
    ],
  },
] as const;

/**
 * Reference decks are evidence for the exact seeded configuration they were
 * authored against. A teacher-edited World must not inherit a stale ceiling.
 */
export function referenceDeckForSystemsAgentsSpec(
  spec: SimulatorSpec,
): ReferencePolicyDeck | null {
  const serialized = canonicalJson(spec);
  for (const lesson of SYSTEMS_AGENTS_LESSONS) {
    for (const activity of lesson.activities) {
      if (canonicalJson(activity.simulatorSpec) !== serialized) continue;
      return SYSTEMS_AGENTS_REFERENCE_DECKS[activity.title] ?? null;
    }
  }
  return null;
}

/**
 * Locked policies remain authored foils when a teacher edits a known Systems &
 * Agents World. They are not a reference ceiling: callers must still use the
 * exact-match helper above before showing or running a reference comparison.
 */
export function lockedPoliciesForSystemsAgentsSpec(
  spec: SimulatorSpec,
): ReferencePolicyDeck["policies"] | null {
  const lockedSlotIds = spec.speciesSlots
    .filter((slot) => slot.locked)
    .map((slot) => slot.slotId)
    .sort();
  if (lockedSlotIds.length === 0) return [];

  for (const lesson of SYSTEMS_AGENTS_LESSONS) {
    for (const activity of lesson.activities) {
      const authoredSpec = activity.simulatorSpec;
      if (authoredSpec.templateId !== spec.templateId) continue;
      const authoredLockedSlotIds = authoredSpec.speciesSlots
        .filter((slot) => slot.locked)
        .map((slot) => slot.slotId)
        .sort();
      if (
        authoredLockedSlotIds.length !== lockedSlotIds.length ||
        authoredLockedSlotIds.some((slotId, index) => slotId !== lockedSlotIds[index])
      ) {
        continue;
      }
      const policies = SYSTEMS_AGENTS_REFERENCE_DECKS[activity.title]?.policies.filter(
        (policy) => lockedSlotIds.includes(policy.slotId),
      );
      if (policies?.length === lockedSlotIds.length) return policies;
    }
  }
  return null;
}

export async function insertSystemsAgentsUnit(
  ctx: MutationCtx,
  teacherId: Id<"users">,
): Promise<{ unitCreated: boolean; lessonsCreated: number; activitiesCreated: number }> {
  const template = getSimulatorTemplate("ecosystemGrid");
  if (!template) throw new Error("ecosystemGrid template is not registered");
  for (const lesson of SYSTEMS_AGENTS_LESSONS) {
    for (const activity of lesson.activities) template.validateSpec(activity.simulatorSpec);
  }

  const existingUnit = await ctx.db
    .query("units")
    .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
    .first();
  const unitId =
    existingUnit?._id ??
    (await ctx.db.insert("units", {
      teacherId,
      title: "Systems & Agents",
      slug: SYSTEMS_AGENTS_UNIT_SLUG,
      emoji: "🪸",
      subject: "Science",
      gradeLevel: "3-8",
      targetBloomLevel: "create",
      bigIdea:
        "Simple local instructions can create surprising system behavior, and careful experiments reveal which words matter.",
      description:
        "A Workbench unit for writing instructions to limited agents, inspecting what they perceived, and improving a system through measured runs.",
      scholarDescription:
        "Write the rules your Automata follow, run the world, inspect what happened, and revise one idea at a time.",
      isActive: true,
    }));

  const existingLessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (query) => query.eq("unitId", unitId))
    .collect();
  let lessonsCreated = 0;
  let activitiesCreated = 0;

  for (const lesson of SYSTEMS_AGENTS_LESSONS) {
    const existingLesson = existingLessons.find((row) => row.title === lesson.title);
    const lessonId =
      existingLesson?._id ??
      (await ctx.db.insert("lessons", {
        unitId,
        title: lesson.title,
        order: lesson.order,
        strand: "core",
        durationMinutes: lesson.title === "First Automaton" ? 45 : 120,
      }));
    if (!existingLesson) lessonsCreated += 1;

    const existingActivities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (query) => query.eq("lessonId", lessonId))
      .collect();
    for (const [order, activity] of lesson.activities.entries()) {
      if (existingActivities.some((row) => row.title === activity.title)) continue;
      await ctx.db.insert("activities", {
        lessonId,
        title: activity.title,
        order,
        kind: "simulator",
        description: activity.description,
        scholarDescription: activity.scholarDescription,
        durationMinutes: activity.simulatorSpec.microWorld ? 10 : 120,
        simulatorSpec: simulatorSpecForStorage(activity.simulatorSpec),
      });
      activitiesCreated += 1;
    }
  }

  return {
    unitCreated: existingUnit === null,
    lessonsCreated,
    activitiesCreated,
  };
}

/**
 * Re-apply the current SYSTEMS_AGENTS_LESSONS copy/specs to activities that were
 * seeded from an older version — `insertSystemsAgentsUnit` is create-only
 * (idempotent by title), so edits to titles/descriptions/starterHints never
 * reach rows that already exist. Patches each existing activity in place (matched
 * by lesson title + order, so it survives a title change). Idempotent.
 *
 * `clearBenches` (default **false**): when true, also DELETES every bench pointing
 * at a patched activity, so the next Workbench open re-materializes the deck from
 * the corrected starterHint. That is destructive — it throws away a scholar's
 * materialized deck, effective-spec state, and run grants; simulatorRuns persist — so
 * it's for DEV only (see simulator.ts `resyncSystemsAgents`).
 * On PROD leave it false: patch the curriculum text but never touch a real
 * scholar's bench (an existing bench keeps its own deck; only NEW benches pick up
 * the corrected starterHint). See simulator.ts `backfillSystemsAgentsContent`.
 */
export async function resyncSystemsAgentsContent(
  ctx: MutationCtx,
  opts: { clearBenches?: boolean } = {},
): Promise<{
  activitiesPatched: number;
  activitiesCreated: number;
  benchesCleared: number;
}> {
  const unit = await ctx.db
    .query("units")
    .withIndex("by_slug", (query) => query.eq("slug", SYSTEMS_AGENTS_UNIT_SLUG))
    .unique();
  if (!unit) return { activitiesPatched: 0, activitiesCreated: 0, benchesCleared: 0 };

  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (query) => query.eq("unitId", unit._id))
    .collect();

  const patchedActivityIds = new Set<Id<"activities">>();
  let activitiesPatched = 0;
  let activitiesCreated = 0;
  for (const lessonSrc of SYSTEMS_AGENTS_LESSONS) {
    const lesson = lessons.find((row) => row.title === lessonSrc.title);
    if (!lesson) continue;
    const rows = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
      .collect();
    for (const [order, activity] of lessonSrc.activities.entries()) {
      const row = rows.find((candidate) => candidate.order === order);
      if (!row) {
        // A title match at another ordinal belongs to a future reorder migration;
        // never duplicate it or disturb its benches/decks in a content resync.
        if (rows.some((candidate) => candidate.title === activity.title)) continue;
        await ctx.db.insert("activities", {
          lessonId: lesson._id,
          title: activity.title,
          order,
          kind: "simulator",
          description: activity.description,
          scholarDescription: activity.scholarDescription,
          durationMinutes: activity.simulatorSpec.microWorld ? 10 : 120,
          simulatorSpec: simulatorSpecForStorage(activity.simulatorSpec),
        });
        activitiesCreated += 1;
        continue;
      }
      await ctx.db.patch(row._id, {
        title: activity.title,
        description: activity.description,
        scholarDescription: activity.scholarDescription,
        durationMinutes: activity.simulatorSpec.microWorld ? 10 : 120,
        simulatorSpec: simulatorSpecForStorage(activity.simulatorSpec),
      });
      patchedActivityIds.add(row._id);
      activitiesPatched += 1;
    }
  }

  // DEV-only: stale benches snapshot the old deck (and maybe a forked spec); drop
  // them so `ensureBench` rebuilds from the patched activity + new starterHint.
  // Never on prod (opts.clearBenches stays false there) — deleting a bench throws
  // away a real scholar's deck, effective-spec state, and run grants; simulatorRuns persist.
  let benchesCleared = 0;
  if (opts.clearBenches) {
    const benches = await ctx.db.query("simulatorBenches").collect();
    for (const bench of benches) {
      if (patchedActivityIds.has(bench.activityId)) {
        await ctx.db.delete(bench._id);
        benchesCleared += 1;
      }
    }
  }

  return { activitiesPatched, activitiesCreated, benchesCleared };
}
