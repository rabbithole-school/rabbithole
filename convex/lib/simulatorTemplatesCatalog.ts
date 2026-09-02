// World-authoring catalog for the STAFF Curriculum Bot.
//
// The unit designer can now author a `kind:"simulator"` activity end-to-end (a
// Simulator Workbench simulation), not just scaffold an empty slot. This module
// is the shared, framework-free core behind that:
//
//  - makeListSimulatorTemplatesTool(emit) — a read tool that teaches the bot what
//    a "simulator" actually is (a systems-simulation terrarium, NOT a map and NOT
//    a build-your-own place/civilization canvas), lists the registered physics
//    templates with their exact senses / actions / metrics / config ranges,
//    and hands back a copy-pasteable example spec per template.
//  - assembleSimulatorSpec(input) — turns the bot's author-choices (templateId +
//    config + speciesSlots + criterion + tickBudget + microWorld) into a
//    canonical SimulatorSpec by injecting the invariants the bot should never have
//    to hand-set (version, templateVersion from the registry, the compiled
//    interpreter, microWorld default). Removes the most common error classes.
//  - simulatorAuthoringArgProperties() — the JSON-schema fragment shared by the
//    create_simulator_activity + update_simulator_spec tools.
//
// The machine-checkable bits (sense ids, action kinds, metric keys, template
// version) are pulled from the registry so this catalog can never drift from
// the real physics; the human guidance + examples are hand-authored and
// covered by a test that runs them through the real validateSpec.
//
// Runtime note: like the sibling aide tool factories, makeListSimulatorTemplatesTool
// dynamically imports betaTool and does NO static @anthropic-ai/sdk import
// (keeps node:* out of the edge bundle).

import type { AideEmit } from "./aideStream";
import {
  MAX_AUTOMATA_COMPILED_RUN,
  MAX_AUTOMATA_PER_RUN,
  MAX_ECOSYSTEM_SPECIES_SLOTS,
  MAX_GRID_CELLS_PER_COMPILED_RUN,
  MAX_PROMPT_CHARS,
  MAX_SPECIES_SLOTS,
  MIN_GRID_CELLS_PER_COMPILED_AUTOMATON,
  SIMULATOR_PROTOCOL_VERSION,
  COMPILED_POLICY_INTERPRETER_ID,
  type SimulatorSpec,
} from "../../lib/simulator/contract";
import {
  SIMULATOR_TEMPLATE_IDS,
  SIMULATOR_TEMPLATES,
  getSimulatorTemplate,
  isSimulatorTemplateId,
  type SimulatorTemplateId,
} from "../../lib/simulator/templates/registry";

/**
 * The author's choices for a simulator, exactly as the bot passes them to
 * create_simulator_activity / update_simulator_spec. The invariants (version,
 * templateVersion, interpreter, microWorld default) are injected by
 * assembleSimulatorSpec, so the bot never sets them.
 */
export type SimulatorAuthorInput = {
  templateId: string;
  config: Record<string, unknown>;
  speciesSlots: ReadonlyArray<Record<string, unknown>>;
  criterion: Record<string, unknown>;
  tickBudget?: {
    iterationTicks?: number;
    seasonTicks?: number;
    absoluteMaxTicks?: number;
  };
  microWorld?: boolean;
};

/**
 * Inject the SimulatorSpec invariants the bot should never hand-author:
 *  - version — the frozen protocol version.
 *  - templateVersion — read from the registry (a top error class removed:
 *    the bot cannot guess the wrong template version).
 *  - interpreter — newly authored strategy Simulators default to the compiled
 *    policy interpreter. Existing stored activities are not migrated.
 *  - microWorld — defaults to false (a full simulator) unless the bot opts in.
 *
 * Everything else (config, speciesSlots, criterion, tickBudget) is passed
 * through verbatim and enforced by the template's own validateSpec, so the
 * bot gets the exact human-readable error when a field is out of range.
 */
export function assembleSimulatorSpec(input: SimulatorAuthorInput): Record<string, unknown> {
  const template = getSimulatorTemplate(input.templateId);
  const templateVersion = template ? template.version : undefined;
  return {
    version: SIMULATOR_PROTOCOL_VERSION,
    templateId: input.templateId,
    // If the templateId is unknown, leave templateVersion undefined so
    // validateSpec surfaces the "Unknown World template" error cleanly rather
    // than a confusing version mismatch.
    ...(templateVersion !== undefined ? { templateVersion } : {}),
    config: input.config,
    criterion: input.criterion,
    speciesSlots: input.speciesSlots,
    tickBudget: input.tickBudget,
    interpreter: {
      kind: "scripted",
      interpreterId: COMPILED_POLICY_INTERPRETER_ID,
    },
    microWorld: input.microWorld ?? false,
  };
}

export function validatedSimulatorSpec(value: unknown): SimulatorSpec {
  if (typeof value !== "object" || value === null) {
    throw new Error("Simulator spec must be an object");
  }
  const templateId = Reflect.get(value, "templateId");
  if (typeof templateId !== "string") {
    throw new Error("Simulator spec must name a template");
  }
  const template = getSimulatorTemplate(templateId);
  if (!template) throw new Error(`Unknown Simulator template "${templateId}"`);
  template.validateSpec(value as SimulatorSpec);
  return value as SimulatorSpec;
}

// ── Compact, VALID example specs (author-choice shape) ────────────────────
// These are what the bot passes as the create_simulator_activity args (NO
// version/templateVersion/interpreter — those are injected). The catalog test
// runs each through assembleSimulatorSpec + the real validateSpec, so they are
// guaranteed to stay valid as the templates evolve.

export const EXAMPLE_ECOSYSTEM_AUTHOR_INPUT: SimulatorAuthorInput = {
  templateId: "ecosystemGrid",
  config: {
    width: 12,
    height: 8,
    boundary: "bounded",
    initialResourceDensity: 0.42,
    resourceRegrowthPerTick: 0.35,
    corpseDecayTicks: 4,
    baseMetabolicCost: 0.7,
    reproductionEnergyThreshold: 14,
    maxAutomata: 12,
    environmentalNoise: { enabled: true, amplitude: 0.08 },
  },
  criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
  speciesSlots: [
    {
      slotId: "grazer",
      label: "Grazers",
      countMin: 1,
      countMax: 5,
      defaultCount: 4,
      senses: [
        { senseId: "vision", range: 4, channels: ["automata", "resources", "boundary"] },
        { senseId: "smell", range: 4, channels: ["resources"] },
      ],
      starterHint: "Find algae, graze when you reach it, and keep enough energy to survive.",
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
  ],
  tickBudget: { iterationTicks: 60, seasonTicks: 200, absoluteMaxTicks: 200 },
  microWorld: false,
};

export const EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT: SimulatorAuthorInput = {
  templateId: "prisonersDilemma",
  config: {
    rounds: 50,
    noiseProbability: 0.05,
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
      slotId: "deck_a",
      label: "Deck A",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "history" }],
      starterHint: "Cooperate first; forgive one apparent defection before retaliating.",
    },
    {
      slotId: "deck_b",
      label: "Deck B",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "history" }],
      starterHint: "Always cooperate.",
    },
  ],
  tickBudget: { iterationTicks: 1, seasonTicks: 50, absoluteMaxTicks: 50 },
  microWorld: false,
};

export const EXAMPLE_MATRIX_GAME_AUTHOR_INPUT: SimulatorAuthorInput = {
  templateId: "matrixGame",
  config: {
    rounds: 40,
    noiseProbability: 0.05,
    actions: [
      { actionId: "optionA", label: "Hunt stag" },
      { actionId: "optionB", label: "Hunt hare" },
    ],
    payoffs: {
      optionA: {
        optionA: { a: 4, b: 4 },
        optionB: { a: 0, b: 3 },
      },
      optionB: {
        optionA: { a: 3, b: 0 },
        optionB: { a: 2, b: 2 },
      },
    },
    maxAutomata: 2,
  },
  criterion: {
    kind: "measured",
    metricKey: "jointScore",
    direction: "maximize",
  },
  speciesSlots: [
    {
      slotId: "deck_a",
      label: "Deck A",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "history" }],
      starterHint: "Hunt stag when you expect the other hunter to coordinate.",
    },
    {
      slotId: "deck_b",
      label: "Deck B",
      countMin: 1,
      countMax: 1,
      defaultCount: 1,
      senses: [{ senseId: "history" }],
      starterHint: "Use the round history to decide whether the stag hunt is safe.",
    },
  ],
  tickBudget: { iterationTicks: 5, seasonTicks: 40, absoluteMaxTicks: 40 },
  microWorld: false,
};

export const EXAMPLE_PUBLIC_GOODS_AUTHOR_INPUT: SimulatorAuthorInput = {
  templateId: "publicGoods",
  config: {
    rounds: 30,
    endowmentPerRound: 10,
    multiplier: 2.4,
    noiseProbability: 0.05,
    maxAutomata: 6,
  },
  criterion: {
    kind: "measured",
    metricKey: "minScore",
    direction: "maximize",
  },
  speciesSlots: [
    {
      slotId: "villager",
      label: "Villagers",
      countMin: 3,
      countMax: 6,
      defaultCount: 6,
      senses: [{ senseId: "history" }],
      starterHint:
        "Write one contribution law that should work when every villager follows the same law.",
    },
  ],
  tickBudget: { iterationTicks: 5, seasonTicks: 30, absoluteMaxTicks: 30 },
  microWorld: false,
};

// ── Hand-authored guidance per template ───────────────────────────────────

type TemplateGuidance = {
  teaches: string;
  senses: string;
  actions: string;
  criterion: string;
  config: Record<string, string>;
  speciesSlots: string;
  tickBudget: string;
  example: SimulatorAuthorInput;
};

const GUIDANCE: Record<SimulatorTemplateId, TemplateGuidance> = {
  ecosystemGrid: {
    teaches:
      "Emergence, adaptation, and trade-offs in a resource-limited ecosystem. Scholars write the behavior prompt for each species (a 'deck'), launch the terrarium, and watch whether the population survives — then revise. Good for food webs, predator/prey, carrying capacity, niches, natural selection framed as an engineering loop.",
    senses:
      "vision (channels: automata, resources, corpses, terrain, boundary), smell (automata, resources, corpses), touch (automata, resources, corpses, terrain, boundary). Each sense on a slot may set an integer `range` 0-100 and a subset of its channels. With heredity enabled, each fish's perception trait scales every range (rounded); vision and smell lose 2 range while the fish is in shallows. A slot lists the senses that species can use. Population-scale simulators above 12 automata also apply a measured byte envelope across population, range, duplicated senses, terrain, and selected channels; keep ranges local and request only channels the activity needs.",
    actions: "move, eat, graze, hide, rest, reproduce, noop (fixed physics — you don't author actions).",
    criterion:
      "Either { kind:'measured', metricKey, direction:'maximize'|'minimize'|'target', target? } where metricKey is one of longevity, livingAutomata, livingSpecies, resourceBiomass, totalEnergy, births, deaths, invalidActions, traitMean, traitSpread, perceptionMean, perceptionSpread (trait metrics require heredity); OR { kind:'gallery', frameKey, curatorNote? } for an open-ended 'make something interesting' goal.",
    config: {
      width: "integer 2-100 (grid columns)",
      height: "integer 2-100 (grid rows)",
      boundary: "'bounded' (walls) or 'toroidal' (wraps around)",
      initialResourceDensity: "number 0-1 (fraction of cells that start with food)",
      resourceRegrowthPerTick: "number 0-10 (food regrown per cell per tick)",
      corpseDecayTicks: "integer >= 1 (ticks a corpse lingers)",
      baseMetabolicCost: "number >= 0 (energy each automaton burns per tick)",
      reproductionEnergyThreshold: "number > 0 (energy needed to reproduce)",
      maxAutomata: `integer 1-${MAX_AUTOMATA_COMPILED_RUN}. Runs of 1-${MAX_AUTOMATA_PER_RUN} may use live Haiku fallback; ${MAX_AUTOMATA_PER_RUN + 1}-${MAX_AUTOMATA_COMPILED_RUN} require every species policy to be fully compiled with no "ask Haiku" gaps. Above ${MAX_AUTOMATA_PER_RUN}, width*height must be at least ${MIN_GRID_CELLS_PER_COMPILED_AUTOMATON} cells per automaton and at most ${MAX_GRID_CELLS_PER_COMPILED_RUN} cells total.`,
      environmentalNoise: "{ enabled: boolean, amplitude: number 0-10 }",
      biome:
        "optional 'reef' or 'meadow' presentation catalog id. Omit for the legacy reef rendering. This changes art and resource vocabulary only, never physics.",
      landscape:
        "optional presentation-only surface regions { version:1, seed:non-empty string, regionCount:integer 2-12, roughness:number 0-1, lowlandCoverage:number 0-1, highlandCoverage:number 0-1 }. The two coverage values must sum to <= 0.8, reserving a plain transition buffer. The frozen seed/config deterministically color the existing terrain faces and add boundary transitions; they do not change movement, resources, Senses, passability, or habitat. Use terrain, not landscape, for authored shelter/current/shallows rules.",
      terrain:
        "optional closed map { shelter:[{x,y}], current:[{x,y,direction:'north'|'east'|'south'|'west'}], shallows:[{x,y}], predatorSlotIds:[slotId] }. Cells must be in-grid and cannot overlap. Shelter admits prey but no named predator slot and never grows algae; eating into shelter is impossible. Current cells push occupants one cell after actions. Shallows double algae regrowth but reduce vision/smell range by 2. Valid example: { shelter:[{x:2,y:2}], current:[{x:4,y:1,direction:'east'}], shallows:[{x:6,y:3}], predatorSlotIds:['shark'] }.",
      heredity:
        "optional { enabled: boolean, mutationStd: number 0-0.5 } — when enabled, offspring inherit independently mutated metabolic and perception traits, both clamped 0.5-2.0. Lower metabolic values burn less energy; higher perception sees farther but adds an energy surcharge. Founders start at 1.0 for both. Example: { enabled:true, mutationStd:0.1 }.",
    },
    speciesSlots:     `1-${MAX_ECOSYSTEM_SPECIES_SLOTS} slots. Each: { slotId (unique), label, countMin >= 0, countMax >= countMin, defaultCount (between min and max), senses[], starterHint?, locked? }. \`label\` MUST be a concrete creature/species name — "Fish", "Grazers", "Shark", "Cleaner shrimp" — NEVER a generic word like "Automaton", "Agent", "Bot", or "Creature": in a Simulator, "automaton" is the generic term for ONE individual of ANY species, so it is not a species name. The sum of every slot's defaultCount must be <= config.maxAutomata and <= ${MAX_AUTOMATA_COMPILED_RUN}. A slot with countMin 0 is an optional species the scholar can add.`,
    tickBudget:
      "{ iterationTicks, seasonTicks, absoluteMaxTicks } — positive integers, ordered iterationTicks <= seasonTicks <= absoluteMaxTicks. Think of iteration = one revise loop, season = a full run, absolute = the hard cap.",
    example: EXAMPLE_ECOSYSTEM_AUTHOR_INPUT,
  },
  prisonersDilemma: {
    teaches:
      "Game theory, cooperation vs. defection, reciprocity, and how noise/forgiveness change a repeated game. Scholars write two strategy 'decks' (or one for self-play) and watch them play an iterated Prisoner's Dilemma. Good for cooperation, trust, tit-for-tat, tragedy-of-the-commons framing.",
    senses:
      "Exactly the `history` sense, with NO range and NO channels — each player only sees the record of past rounds. Every slot's senses must be exactly [{ senseId: 'history' }].",
    actions: "cooperate, defect (fixed).",
    criterion:
      "Must be { kind:'adversarial', scoreMetricKeys: ['deckA.totalScore','deckB.totalScore'] } exactly. Other metric keys available for prompts/analysis: deckA/B.cooperationRate, deckA/B.cooperations, deckA/B.forgivenessEvents, roundsPlayed.",
    config: {
      rounds: "integer 1-500 (default 50) — how many rounds the two decks play",
      noiseProbability: "number 0-1 — chance a move is misperceived (models miscommunication)",
      payoffMatrix:
        "{ mutualCooperation, temptation, sucker, mutualDefection } — must satisfy temptation > mutualCooperation > mutualDefection > sucker AND 2*mutualCooperation > temptation + sucker (the classic PD constraints). Canonical: 3 / 5 / 0 / 1.",
      maxAutomata: "must be exactly 2",
    },
    speciesSlots:
      "1 slot (self-play, defaultCount 2) or 2 slots (defaultCount 1 each). Each: { slotId, label, countMin >= 1, countMax, defaultCount, senses:[{senseId:'history'}], starterHint?, locked? }. The sum of defaultCount must equal exactly 2.",
    tickBudget:
      "{ iterationTicks, seasonTicks, absoluteMaxTicks } — positive, ordered, and absoluteMaxTicks must be <= config.rounds. Typically iterationTicks 1, season/absolute = rounds.",
    example: EXAMPLE_PRISONERS_DILEMMA_AUTHOR_INPUT,
  },
  matrixGame: {
    teaches:
      "Strategic coordination and conflict across arbitrary repeated two-action games. Authors name optionA and optionB for the scenario and provide every row/column payoff, including asymmetric rewards. Useful for stag hunt, hawk-dove, chicken, and battle-of-the-sexes structures without pretending they are Prisoner's Dilemma.",
    senses:
      "Exactly the `history` sense, with NO range and NO channels. History includes each player's own action, the perceived opponent action, authored labels, own payoff, and cumulative score. Noise can flip the perceived opponent action between optionA and optionB.",
    actions:
      "optionA, optionB (fixed action ids). Give them scenario-specific display labels in config.actions; automata see both ids and labels.",
    criterion:
      "Either { kind:'adversarial', scoreMetricKeys:['deckA.totalScore','deckB.totalScore'] } exactly; OR { kind:'measured', metricKey:'jointScore', direction:'maximize'|'minimize'|'target', target? }. Other exported metrics: deckA/B.optionARate and roundsPlayed.",
    config: {
      rounds: "integer 1-500",
      noiseProbability:
        "number 0-1 — chance each player misperceives the opponent's previous option",
      actions:
        "exactly [{actionId:'optionA',label}, {actionId:'optionB',label}] in either order, with each id exactly once",
      payoffs:
        "{ optionA:{optionA:{a,b},optionB:{a,b}}, optionB:{optionA:{a,b},optionB:{a,b}} }; indexed [row action][column action], each finite a/b from -1000 to 1000; asymmetric values are allowed",
      maxAutomata: "must be exactly 2",
    },
    speciesSlots:
      "1 slot (self-play, defaultCount 2) or 2 slots (defaultCount 1 each). Every slot uses exactly [{senseId:'history'}], and total defaultCount must equal 2. Each slot may also set starterHint and locked (see list_simulator_templates' ecosystemGrid entry for the general slot shape).",
    tickBudget:
      "{ iterationTicks, seasonTicks, absoluteMaxTicks } — positive, ordered, and absoluteMaxTicks must be <= config.rounds.",
    example: EXAMPLE_MATRIX_GAME_AUTHOR_INPUT,
  },
  publicGoods: {
    teaches:
      "Collective-action incentives, free-riding, welfare, and maximin reasoning. Every round each player contributes its whole endowment or withholds it; the multiplied pool is shared equally by all. One clone slot lets a scholar write one law that every villager follows, while multiple slots model heterogeneous populations.",
    senses:
      "Exactly the `history` sense, with NO range and NO channels. Each player sees past perceived contributor counts, its own action and payoff, and its cumulative score. Noise changes the perceived contributor count by one, bounded to the population.",
    actions: "withhold, contribute (binary and fixed).",
    criterion:
      "Must be measured over a group objective: metricKey 'groupWelfare', 'minScore', or 'contributionRate', with direction 'maximize'|'minimize'|'target' and optional target. Other exported diagnostics: maxScore, poolLastRound, roundsPlayed, invalidActions.",
    config: {
      rounds: "integer 1-200",
      endowmentPerRound: "number 1-100 — each player's fresh endowment every round",
      multiplier:
        "finite number greater than 1 and less than the default/launched player count",
      noiseProbability:
        "number 0-1 — chance a player perceives last round's contributor count one too high or low",
      maxAutomata: `integer 3-${MAX_AUTOMATA_PER_RUN}; selected player count may be lower but must remain at least 3 and greater than multiplier`,
    },
    speciesSlots:
      `1-${MAX_SPECIES_SLOTS} slots. Counts may include optional zero-minimum populations, but default counts must total 3 through config.maxAutomata. A one-slot clone village with defaultCount N runs one shared prompt for all N players. Every slot uses exactly [{senseId:'history'}], and may set starterHint and locked.`,
    tickBudget:
      "{ iterationTicks, seasonTicks, absoluteMaxTicks } — positive, ordered, and absoluteMaxTicks must be <= config.rounds.",
    example: EXAMPLE_PUBLIC_GOODS_AUTHOR_INPUT,
  },
};

/**
 * Build the catalog payload the read tool returns. Machine bits come from the
 * registry (never drift); guidance + examples are hand-authored.
 */
export function buildSimulatorTemplateCatalog() {
  const templates = SIMULATOR_TEMPLATE_IDS.map((id) => {
    const runtime = SIMULATOR_TEMPLATES[id];
    const g = GUIDANCE[id];
    return {
      templateId: id,
      templateVersion: runtime.version,
      teaches: g.teaches,
      senses: g.senses,
      senseIds: runtime.senseIds,
      actions: g.actions,
      actionKinds: runtime.actionKinds,
      metricKeys: runtime.metricKeys,
      criterion: g.criterion,
      config: g.config,
      speciesSlots: g.speciesSlots,
      tickBudget: g.tickBudget,
      exampleAuthorInput: g.example,
    };
  });

  return {
    whatWorldsAre:
      "A Simulator activity (stored as the `simulator` kind) is a fixed-physics 'terrarium' the scholar tunes by writing behavior prompts for the automata/species, then runs and revises against a goal. It is a systems-thinking / agent-design tool.",
    whatWorldsAreNOT:
      "A Simulator is NOT a geographic map (that's an ONLINE activity whose tutor calls show_map — see list_geomap_assets), NOT a build-your-own-place / civilization / culture canvas, and NOT a generic 'explore a topic' space. If a teacher asks for a simulator activity, use one of the registered physics simulations. If they actually want map exploration or an open build/creation task, that is an online (or vibecode) activity, not a Simulator.",
    templates,
    limits: {
      maxSpeciesSlots: MAX_SPECIES_SLOTS,
      maxEcosystemSpeciesSlots: MAX_ECOSYSTEM_SPECIES_SLOTS,
      maxAutomataPerRun: MAX_AUTOMATA_PER_RUN,
      maxAutomataCompiledRun: MAX_AUTOMATA_COMPILED_RUN,
      compiledRunGridCells: {
        minimumPerAutomaton: MIN_GRID_CELLS_PER_COMPILED_AUTOMATON,
        maximum: MAX_GRID_CELLS_PER_COMPILED_RUN,
      },
      maxPromptChars: MAX_PROMPT_CHARS,
      simulatorProtocolVersion: SIMULATOR_PROTOCOL_VERSION,
    },
    howToAuthor:
      "1) Pick a templateId. 2) Call create_simulator_activity with lessonTitle, title, and the author choices (config, speciesSlots, criterion, tickBudget, microWorld?) — copy the matching exampleAuthorInput and adapt it. You do NOT set version, templateVersion, or interpreter; those are filled in for you. 3) If the spec is invalid the tool returns the exact error — fix that field and retry. Use update_simulator_spec to reconfigure an existing Simulator activity.",
  };
}

/**
 * The JSON-schema properties shared by create_simulator_activity and
 * update_simulator_spec. config/speciesSlots/criterion are intentionally loose
 * objects/arrays (the templates differ); the template's validateSpec is
 * the real gate and returns human-readable errors. Call list_simulator_templates
 * first to learn the exact fields.
 */
export function simulatorAuthoringArgProperties() {
  return {
    templateId: {
      type: "string" as const,
      enum: [...SIMULATOR_TEMPLATE_IDS] as string[],
      description:
        "Which physics engine. ecosystemGrid = resource/predator terrarium; prisonersDilemma = iterated cooperation game; matrixGame = authored repeated 2x2 game; publicGoods = repeated N-player contribution pool. Call list_simulator_templates for the full shape of each.",
    },
    config: {
      type: "object" as const,
      additionalProperties: true,
      description:
        "Template-specific physics config. ecosystemGrid uses grid/resource fields; prisonersDilemma uses rounds/noise/payoffMatrix; matrixGame uses rounds/noise/actions/full 2x2 payoffs; publicGoods uses rounds/endowment/multiplier/noise. See list_simulator_templates for exact shapes and ranges.",
    },
    speciesSlots: {
      type: "array" as const,
      description:
        "The species/strategy 'decks'. Each: { slotId (unique), label, countMin, countMax, defaultCount, senses:[{senseId, range?, channels?}], starterHint?, locked? }. See list_simulator_templates for per-template rules (sense ids, count constraints, how defaultCounts must sum). Set locked:true to make a slot teacher-authored and read-only for the scholar — its deck always shows starterHint verbatim and cannot be edited (e.g. a fixed grim-trigger partner whose rules the scholar can read but never rewrite); population (countMin/countMax) still applies unless you also pin countMin === countMax.",
      items: { type: "object" as const, additionalProperties: true },
    },
    criterion: {
      type: "object" as const,
      additionalProperties: true,
      description:
        "The goal. ecosystemGrid: measured or gallery; prisonersDilemma: adversarial deck scores; matrixGame: adversarial deck scores or measured jointScore; publicGoods: measured groupWelfare, minScore, or contributionRate. See list_simulator_templates for exact shapes.",
    },
    tickBudget: {
      type: "object" as const,
      description:
        "Run length: { iterationTicks, seasonTicks, absoluteMaxTicks } — positive integers ordered iteration <= season <= absolute (all round-based game templates also require absolute <= config.rounds).",
      properties: {
        iterationTicks: { type: "integer" as const, minimum: 1 },
        seasonTicks: { type: "integer" as const, minimum: 1 },
        absoluteMaxTicks: { type: "integer" as const, minimum: 1 },
      },
      required: ["iterationTicks", "seasonTicks", "absoluteMaxTicks"] as const,
    },
    microWorld: {
      type: "boolean" as const,
      description:
        "Optional. true for a tiny single-automaton demo Simulator; defaults to false (a full Simulator). Leave unset for normal activities.",
    },
  };
}

/**
 * Build the `list_simulator_templates` read tool. Assembled onto the Curriculum
 * Bot surface (never a scholar surface); reads only checked-in template
 * metadata, no ctx and no scholar data.
 */
export async function makeListSimulatorTemplatesTool(emit: AideEmit) {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  return betaTool({
    name: "list_simulator_templates",
    description:
      "List the Simulator templates a Simulator activity can use. Call this BEFORE authoring a Simulator activity. Returns: what a Simulator is (a fixed-physics systems-simulation terrarium the scholar tunes) and is NOT (not a map, not a civilization/culture builder), every registered physics template with its exact senses / actions / metric keys / config field ranges / speciesSlots rules / criterion shapes, the global limits, and a copy-pasteable example author-input per template.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as const,
    },
    run: async () => {
      const catalog = buildSimulatorTemplateCatalog();
      emit({
        toolComplete: {
          name: "list_simulator_templates",
          result: `${catalog.templates.length} Simulator templates`,
        },
      });
      return JSON.stringify(catalog, null, 2);
    },
  });
}

export { isSimulatorTemplateId, SIMULATOR_TEMPLATE_IDS };
