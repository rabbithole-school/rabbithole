/**
 * The FROZEN, framework-free contract for a WORLD.
 *
 * A World is authored data over a code-owned physics template. The row may tune
 * declared parameters; it can never upload rules. Automata receive only the
 * observation built through their species' Senses, choose from a closed action
 * vocabulary, and never reach the network or a mastery writer.
 *
 * WORLD RUNS ARE NOT GAME EVIDENCE. `lib/games/contract.ts` captures what a
 * scholar did inside a client-run interactive. This contract records what
 * server-run automata did after the scholar authored a prompt deck. The two
 * stores deliberately share discipline -- frozen launch inputs, server seeds,
 * append-only truth, deterministic summaries -- without creating a second
 * vocabulary that attributes machine behavior to a scholar.
 */

export const SIMULATOR_PROTOCOL_VERSION = 1 as const;
export const PROMPT_PROTOCOL_VERSION = 1 as const;
export const DECISION_HASH_VERSION = 1 as const;
export const RENDERER_PROTOCOL_VERSION = 1 as const;
export const COMPILED_POLICY_INTERPRETER_ID = "compiled-policy-v1" as const;

export const SUPPORTED_SIMULATOR_PROTOCOL_VERSIONS = [SIMULATOR_PROTOCOL_VERSION] as const;
export const SUPPORTED_RENDERER_PROTOCOL_VERSIONS = [RENDERER_PROTOCOL_VERSION] as const;

export const TICKS_PER_CHUNK = 5;
/** Zero-fallback compiled policies can advance a 200-tick season in two chunks. */
export const COMPILED_TICKS_PER_CHUNK = 100;
export const CHECKPOINT_EVERY_TICKS = 20;
/** One mutation-owned recovery window for a scheduled action that never claims. */
export const SIMULATOR_QUEUE_WATCHDOG_MS = 105_000;

/** Default roster ceiling for fixed and public-goods Simulator templates. */
export const MAX_SPECIES_SLOTS = 5;
/** Ecosystem grids can represent a richer food web without changing other templates' rosters. */
export const MAX_ECOSYSTEM_SPECIES_SLOTS = 12;
export const MAX_AUTOMATA_PER_RUN = 12;
/**
 * Dense ecosystem benchmark, 2026-08-11: N=64 retained 2.03x worst-tick
 * headroom over 1,000 seeds; N=65 fell to 1.99x.
 * ecosystemGrid alone opts into this ceiling; game templates keep their own
 * validator-owned population caps.
 */
export const MAX_AUTOMATA_COMPILED_RUN = 64;
export const MIN_GRID_CELLS_PER_COMPILED_AUTOMATON = 10;
export const MAX_GRID_CELLS_PER_COMPILED_RUN = 1_200;
export const MAX_PROMPT_CHARS = 4_000;
export const MAX_SCRATCH_CHARS = 500;
export const MAX_REASONING_CHARS = 500;
export const MAX_NOTEBOOK_ENTRY_CHARS = 4_000;
export const MAX_RUN_GRANTS_PER_BENCH = 64;

export const MAX_CHUNK_JSON_BYTES = 600 * 1024;
export const MAX_SNAPSHOT_JSON_BYTES = 192 * 1024;
export const MAX_SCENE_JSON_BYTES = 192 * 1024;

export interface SimulatorSense {
  /** Registry-owned vocabulary key. Unknown senses are rejected at authoring. */
  senseId: string;
  /** Template-specific distance. Omission means the template's minimum range. */
  range?: number;
  /** A closed subset of channels exported by this sense. */
  channels?: readonly string[];
}

/** The world-given perception package for one Species slot. */
export type SensePackage = readonly SimulatorSense[];

export interface SpeciesSlot {
  /** Stable and unique within one SimulatorSpec. */
  slotId: string;
  label: string;
  countMin: number;
  countMax: number;
  defaultCount: number;
  senses: SensePackage;
  starterHint?: string;
  /**
   * A LOCKED slot's deck is teacher-authored: VISIBLE to the scholar, but not
   * editable — the deck always reads `starterHint` verbatim, and a scholar
   * deck save that changes its prompt is rejected server-side. Deliberately
   * weaker than a hidden deck (no concealed information); locking a slot
   * locks the PROMPT, never the population (countMin/countMax still govern
   * how many run, unless the author also pins countMin === countMax).
   * Omitted/false means editable, the existing behavior.
   */
  locked?: boolean;
}

export interface EcosystemGridConfig {
  width: number;
  height: number;
  boundary: "bounded" | "toroidal";
  initialResourceDensity: number;
  resourceRegrowthPerTick: number;
  corpseDecayTicks: number;
  baseMetabolicCost: number;
  reproductionEnergyThreshold: number;
  maxAutomata: number;
  environmentalNoise: {
    enabled: boolean;
    amplitude: number;
  };
  /**
   * Optional, authored spawn cells for a fixed-population World. This keeps a
   * designed opening state reproducible without exposing placement as an action.
   */
  initialPositions?: Record<string, { x: number; y: number }[]>;
  /** Slot whose surviving population is the World’s measured learner outcome. */
  scoringSlotId?: string;
  /**
   * A code-owned terrain presentation catalog id. Omission is the legacy reef
   * rendering, so existing specs and snapshots retain their current appearance.
   * This does not alter ecosystem physics; passability and species habitat
   * constraints need an explicit future terrain rule.
   */
  biome?: EcosystemBiomeId;
  /**
   * Optional, presentation-only procedural surface regions for the existing
   * ecosystem terrain renderer. Every field is frozen in a run's SimulatorSpec
   * snapshot; generated bands never alter movement, resources, Senses, or habitat.
   */
  landscape?: EcosystemLandscapeConfig;
  terrain?: {
    shelter: { x: number; y: number }[];
    current: {
      x: number;
      y: number;
      direction: "north" | "east" | "south" | "west";
    }[];
    shallows: { x: number; y: number }[];
    /** Species slots whose hunters cannot enter shelter cells. */
    predatorSlotIds: string[];
  };
  heredity?: {
    enabled: boolean;
    mutationStd: number;
  };
}

/** Stable terrain-presentation ids accepted by ecosystemGrid specs. */
export type EcosystemBiomeId = "reef" | "meadow";

export interface EcosystemLandscapeConfig {
  version: 1;
  seed: string;
  /** Number of broad, spatially coherent regions. */
  regionCount: number;
  /** Blend from broad regions (0) toward local relief variation (1). */
  roughness: number;
  /** Target fraction for the two lower surface bands. */
  lowlandCoverage: number;
  /** Target fraction for the two upper surface bands. */
  highlandCoverage: number;
}

export interface PrisonersDilemmaPayoffMatrix {
  mutualCooperation: number;
  temptation: number;
  sucker: number;
  mutualDefection: number;
}

export interface PrisonersDilemmaConfig {
  /** Omission is the authored default: one 50-round match. */
  rounds?: number;
  noiseProbability: number;
  payoffMatrix: PrisonersDilemmaPayoffMatrix;
  maxAutomata: 2;
}

export type MatrixGameActionId = "optionA" | "optionB";

export interface MatrixGameConfig {
  rounds: number;
  noiseProbability: number;
  actions: readonly { actionId: MatrixGameActionId; label: string }[];
  payoffs: Record<
    MatrixGameActionId,
    Record<MatrixGameActionId, { a: number; b: number }>
  >;
  maxAutomata: 2;
}

export interface PublicGoodsConfig {
  rounds: number;
  endowmentPerRound: number;
  multiplier: number;
  noiseProbability: number;
  maxAutomata: number;
}

export type MeasuredCriterion = {
  kind: "measured";
  metricKey: string;
  direction: "maximize" | "minimize" | "target";
  target?: number;
};

export type GalleryCriterion = {
  kind: "gallery";
  frameKey: string;
  curatorNote?: string;
};

export type AdversarialCriterion = {
  kind: "adversarial";
  scoreMetricKeys: readonly string[];
};

export type WorldCriterion = MeasuredCriterion | GalleryCriterion | AdversarialCriterion;

interface SimulatorSpecBase {
  version: typeof SIMULATOR_PROTOCOL_VERSION;
  templateVersion: number;
  speciesSlots: readonly SpeciesSlot[];
  tickBudget: {
    iterationTicks: number;
    seasonTicks: number;
    absoluteMaxTicks: number;
  };
  interpreter:
    | { kind: "llm"; role: "AUTOMATON" }
    | { kind: "scripted"; interpreterId: string };
  microWorld: boolean;
}

export interface EcosystemGridSimulatorSpec extends SimulatorSpecBase {
  templateId: "ecosystemGrid";
  config: EcosystemGridConfig;
  criterion: MeasuredCriterion | GalleryCriterion;
}

export interface PrisonersDilemmaSimulatorSpec extends SimulatorSpecBase {
  templateId: "prisonersDilemma";
  config: PrisonersDilemmaConfig;
  criterion: AdversarialCriterion;
}

export interface MatrixGameSimulatorSpec extends SimulatorSpecBase {
  templateId: "matrixGame";
  config: MatrixGameConfig;
  criterion: AdversarialCriterion | MeasuredCriterion;
}

export interface PublicGoodsSimulatorSpec extends SimulatorSpecBase {
  templateId: "publicGoods";
  config: PublicGoodsConfig;
  criterion: MeasuredCriterion;
}

export type SimulatorSpec =
  | EcosystemGridSimulatorSpec
  | PrisonersDilemmaSimulatorSpec
  | MatrixGameSimulatorSpec
  | PublicGoodsSimulatorSpec;

export interface DeckCard {
  slotId: string;
  count: number;
  prompt: string;
}

/** A frozen deck card joined to its authored Species slot at run launch. */
export interface LaunchedSpecies {
  slotId: string;
  label: string;
  count: number;
  countMax: number;
  senses: SensePackage;
  prompt: string;
}

export type Hypothesis = {
  prediction: "better" | "worse" | "about_the_same" | "exploratory";
  note?: string;
};

export interface MetricValue {
  key: string;
  value: number;
}

export interface MetricSample {
  tick: number;
  values: readonly MetricValue[];
}

export interface ModelUsage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

// ── Decisions and immutable tick truth ───────────────────────────────────────

/**
 * The forced-tool payload an Automaton may return. `action` remains generic so
 * each template owns one closed schema. Reasoning is display-only and scratch
 * is bounded private memory; neither is physics truth.
 */
export interface AutomatonDecision<A> {
  action: A;
  reasoning: string;
  scratch?: string;
}

/**
 * Framework-neutral action schema. Prompt assembly translates this declaration
 * into the provider's static forced-tool schema; physics uses the same variant
 * keys for runtime validation. No dynamic legal enum belongs here -- the legal
 * subset changes per Automaton and travels in its prompt suffix.
 */
export interface WorldActionFieldSchema {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "point";
  required: boolean;
  description: string;
}

export interface WorldActionVariantSchema {
  kind: string;
  description: string;
  fields: readonly WorldActionFieldSchema[];
}

export interface WorldActionSchema {
  variants: readonly WorldActionVariantSchema[];
}

export type DecisionSource =
  | "model"
  | "decision_cache"
  | "compiled"
  | "compiled-fallback";

export interface DecisionCacheOrigin {
  runId: string;
  startTick: number;
  tick: number;
  automatonId: string;
}

export interface AutomatonTickRecord<O = unknown, A = unknown> {
  automatonId: string;
  slotId: string;
  /** Exactly what Senses admitted -- never the authoritative state. */
  observation: O;
  scratchBefore?: string;
  tickPhase: string;
  legalActions: readonly A[];
  decisionHash: string;
  source: DecisionSource;
  cacheOrigin?: DecisionCacheOrigin;
  /** Exact provider content array, preserved for replay and inspection. */
  modelResponse: unknown;
  reasoning: string;
  policyRuleId?: string;
  policyTrace?: string;
  requestedAction: unknown;
  /** A validated action or the template's canonical no-op. */
  acceptedAction: A;
  accepted: boolean;
  invalidCode?: string;
  scratchAfter?: string;
  /** Absent on decision-cache hits. */
  usage?: ModelUsage;
}

export interface TickRecord<O = unknown, A = unknown, D = unknown> {
  tick: number;
  phase: string;
  /** Exact deterministic seed used by physics; model decision hashes exclude it. */
  physicsSeed?: string;
  automata: readonly AutomatonTickRecord<O, A>[];
  delta: D;
  metrics: readonly MetricValue[];
  invalidActionCount: number;
}

export interface WorldCheckpoint<S> {
  tick: number;
  state: S;
  scene: SimulatorSceneV1;
  stateHash: string;
}

export interface SimulatorRunChunk<S = unknown, O = unknown, A = unknown, D = unknown> {
  startTick: number;
  endTick: number;
  attempt: number;
  ticks: readonly TickRecord<O, A, D>[];
  /**
   * The first chunk carries the tick-zero state. Periodic checkpoints alone
   * cannot replay ticks 0-19 without reaching back into the private manifest.
   */
  initialCheckpoint?: WorldCheckpoint<S>;
  checkpoint?: WorldCheckpoint<S>;
  chunkHash: string;
}

// ── Renderer protocol ────────────────────────────────────────────────────────

/**
 * Renderers consume this protocol, never template state. Physics remains on the
 * server; web and native are two views of the same bounded scene record.
 */
export interface SimulatorSceneEntityV1 {
  id: string;
  kind: string;
  /** Species slot identity for living ecosystem Automata. */
  slotId?: string;
  /**
   * The living Automaton that produced a derived scene entity, when one exists.
   * A corpse keeps this link so the existing Inspector can show its final
   * recorded decision without guessing from a display identifier.
   */
  automatonId?: string;
  x: number;
  y: number;
  layer: number;
  label?: string;
  color?: string;
  size?: number;
  /**
   * Radians, standard math convention: 0 faces +x ("east"), increasing
   * counter-clockwise -- i.e. `Math.atan2(dy, dx)` for "facing toward
   * (dx, dy)". Optional and purely decorative; a renderer that ignores it
   * still receives a fully valid scene. See the "round aliveness
   * conventions" block above `SimulatorSceneCellV1` for how the game templates
   * (prisonersDilemma, matrixGame, publicGoods) set it.
   */
  heading?: number;
  hidden?: boolean;
  energy?: number;
  /** Effective inherited metabolic-cost multiplier for selection evidence. */
  trait?: number;
  /** Effective inherited multiplier used by ecosystem senses. */
  perceptionTrait?: number;
}

/**
 * ── Round aliveness conventions (additive, optional; contract-only coupling
 * with the renderer) ─────────────────────────────────────────────────────────
 *
 * The repeated-game templates (prisonersDilemma, matrixGame, publicGoods)
 * encode a round's outcome using two optional, purely additive scene fields,
 * so a renderer can draw more without any template depending on renderer
 * code, and without any renderer depending on template internals:
 *
 * 1. TOKEN ENTITIES -- the ONE chosen mechanism for showing "what did each
 *    Automaton just choose" (the alternative considered and rejected was a
 *    `kind` suffix on the Automaton entity itself; token entities were
 *    preferred because they let a renderer draw the Automaton's own kind
 *    exactly as before while layering an independent, poppable indicator on
 *    top). One extra SimulatorSceneEntityV1 per Automaton per rendered tick,
 *    keyed `id: "token:<automatonId>"` (stable across ticks, so a renderer
 *    can animate it in place) with `kind: "token:<actionId>"`, where
 *    `<actionId>` is the template's own closed action-kind vocabulary
 *    ("cooperate"/"defect" for prisonersDilemma; "optionA"/"optionB" for
 *    matrixGame; "contribute"/"withhold" for publicGoods). The entity is
 *    simply absent before the first round resolves -- there is no "no
 *    choice yet" token kind. Placed a small, template-chosen offset from its
 *    Automaton's own entity (matrixGame/prisonersDilemma: toward the
 *    opponent; publicGoods: outward past the Automaton, away from the
 *    pool), one `layer` above that Automaton, `size` smaller than an
 *    Automaton's. `label`, when present, is the template's author-facing
 *    action label (matrixGame's actions are authored text, e.g. "Hunt
 *    stag" -- never just the actionId).
 * 2. HEADING -- see `SimulatorSceneEntityV1.heading` above. prisonersDilemma and
 *    matrixGame face their two Automata at each other every round
 *    (structural: it never depends on the round's outcome). publicGoods
 *    faces a villager toward the pool's center while contributing this
 *    round and away from it while withholding (action-dependent, derived
 *    fresh each round; a villager who has not yet acted this run faces the
 *    pool by default).
 *
 * Both fields are additive: a renderer that ignores `heading` or an
 * unrecognized `token:` entity kind still receives a fully valid,
 * already-correct scene -- exactly like an unrecognized `SimulatorSceneCellV1`
 * kind below.
 */

export interface SimulatorSceneCellV1 {
  x: number;
  y: number;
  kind: string;
  intensity: number;
}

export interface SimulatorSceneV1 {
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  templateId: string;
  tick: number;
  viewport: {
    width: number;
    height: number;
    boundary: "bounded" | "toroidal";
  };
  entities: readonly SimulatorSceneEntityV1[];
  cells: readonly SimulatorSceneCellV1[];
}

/**
 * A delta is relative to the preceding scene tick. Checkpoints always carry a
 * complete SimulatorSceneV1, so a scrubber applies at most one checkpoint interval
 * of deltas and never needs hidden physics state.
 */
export interface SimulatorSceneDeltaV1 {
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  templateId: string;
  fromTick: number;
  toTick: number;
  upsertEntities: readonly SimulatorSceneEntityV1[];
  removeEntityIds: readonly string[];
  upsertCells: readonly SimulatorSceneCellV1[];
  removeCells: readonly { x: number; y: number }[];
}

export type WorldRendererMessage =
  | { kind: "checkpoint"; scene: SimulatorSceneV1 }
  | { kind: "delta"; delta: SimulatorSceneDeltaV1 };

// ── Physics-template interface ───────────────────────────────────────────────

export interface SimulatorTemplate<
  C,
  S,
  O,
  A,
  D,
  M extends Record<string, number>,
> {
  readonly id: string;
  readonly version: number;
  readonly rendererProtocolVersion: number;
  /**
   * Zero means prompt caching is disabled. A positive value is a checked,
   * provider-measured token count and must clear the provider's 4,096-token
   * floor; character-count guesses are not measurements.
   */
  readonly cacheablePrefixMeasuredTokens: number;

  /** Closed vocabularies used by authoring, prompt assembly, and conformance. */
  readonly senseIds: readonly string[];
  readonly actionKinds: readonly string[];
  readonly actionSchema: WorldActionSchema;
  readonly metricKeys: readonly (keyof M & string)[];
  readonly summaryMetricKeys: readonly (keyof M & string)[];

  validateConfig(value: unknown): C;
  validateState(value: unknown): S;
  validateAction(value: unknown): A;
  validateDelta(value: unknown): D;
  validateSpec(spec: SimulatorSpec): void;

  initialState(input: {
    config: C;
    species: readonly LaunchedSpecies[];
    seed: string;
  }): S;

  /**
   * The sole Senses enforcement point. Prompt assembly receives this result and
   * has no raw-state parameter, so a later caller cannot forget to filter.
   */
  buildObservation(input: {
    state: Readonly<S>;
    automatonId: string;
    senses: SensePackage;
    tick: number;
  }): O;

  legalActions(input: {
    state: Readonly<S>;
    automatonId: string;
    observation: Readonly<O>;
    tick: number;
  }): readonly A[];

  /** Stable actor enumeration keeps the worker independent of template state shape. */
  listAutomata(state: Readonly<S>): readonly {
    id: string;
    slotId: string;
    senses: SensePackage;
  }[];

  /** The model-visible phase label for a tick. */
  tickPhase(input: { state: Readonly<S>; tick: number }): string;

  applyActions(input: {
    state: Readonly<S>;
    actions: ReadonlyMap<string, A>;
    tick: number;
    tickSeed: string;
  }): {
    state: S;
    delta: D;
    terminal: boolean;
    phase: string;
  };

  metrics(input: {
    previousState: Readonly<S>;
    state: Readonly<S>;
    tick: number;
  }): M;

  /** Preserve model-invalid telemetry without exposing template state to the worker. */
  withInvalidActions(input: { state: Readonly<S>; count: number }): S;

  /** Add model-invalid actor ids to the template's forensic delta shape. */
  withInvalidActionDelta(input: {
    delta: Readonly<D>;
    automatonIds: readonly string[];
  }): D;

  renderScene(input: {
    state: Readonly<S>;
    tick: number;
  }): SimulatorSceneV1;
}

/**
 * Type-erased registry view used by the generic server worker. Templates remain
 * strongly typed at definition; the registry adapter validates every unknown
 * state/action before it crosses back into a concrete template.
 */
export interface RuntimeSimulatorTemplate {
  readonly id: string;
  readonly version: number;
  readonly rendererProtocolVersion: number;
  readonly cacheablePrefixMeasuredTokens: number;
  readonly senseIds: readonly string[];
  readonly actionKinds: readonly string[];
  readonly actionSchema: WorldActionSchema;
  readonly metricKeys: readonly string[];
  readonly summaryMetricKeys: readonly string[];
  validateConfig(value: unknown): unknown;
  validateState(value: unknown): unknown;
  validateAction(value: unknown): unknown;
  validateDelta(value: unknown): unknown;
  validateSpec(spec: SimulatorSpec): void;
  initialState(input: {
    config: unknown;
    species: readonly LaunchedSpecies[];
    seed: string;
  }): unknown;
  buildObservation(input: {
    state: unknown;
    automatonId: string;
    senses: SensePackage;
    tick: number;
  }): unknown;
  legalActions(input: {
    state: unknown;
    automatonId: string;
    observation: unknown;
    tick: number;
  }): readonly unknown[];
  listAutomata(state: unknown): readonly {
    id: string;
    slotId: string;
    senses: SensePackage;
  }[];
  tickPhase(input: { state: unknown; tick: number }): string;
  applyActions(input: {
    state: unknown;
    actions: ReadonlyMap<string, unknown>;
    tick: number;
    tickSeed: string;
  }): {
    state: unknown;
    delta: unknown;
    terminal: boolean;
    phase: string;
  };
  metrics(input: {
    previousState: unknown;
    state: unknown;
    tick: number;
  }): Record<string, number>;
  withInvalidActions(input: { state: unknown; count: number }): unknown;
  withInvalidActionDelta(input: {
    delta: unknown;
    automatonIds: readonly string[];
  }): unknown;
  renderScene(input: { state: unknown; tick: number }): SimulatorSceneV1;
}
