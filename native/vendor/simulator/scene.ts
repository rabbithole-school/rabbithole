import {
  CHECKPOINT_EVERY_TICKS,
  MAX_SCRATCH_CHARS,
  SIMULATOR_PROTOCOL_VERSION,
  TICKS_PER_CHUNK,
  type DecisionSource,
  type MetricValue,
  type SimulatorSceneCellV1,
  type SimulatorSceneV1,
  type SimulatorSpec,
} from "./contract";
import {
  getSimulatorTemplate,
  getWorkbenchRendererFamily,
  type WorkbenchRendererFamily,
} from "./templates/registry";
import { screenWorldText } from "./screenText";
import {
  validateMatrixGameDelta,
  type MatrixGameDelta,
} from "./templates/matrixGame";
import {
  validatePrisonersDilemmaDelta,
  type PrisonersDilemmaDelta,
} from "./templates/prisonersDilemma";
import {
  validatePublicGoodsDelta,
  type PublicGoodsDelta,
} from "./templates/publicGoods";
import {
  projectEcosystemSenseCoverage,
  type EcosystemInspectableSenseId,
} from "./ecosystemPerception";

export type StoredAutomatonTick = {
  automatonId: string;
  slotId?: string;
  detailsRedacted?: boolean;
  observationJson: string;
  reasoning: string;
  source?: DecisionSource;
  policyRuleId?: string;
  policyTrace?: string;
  acceptedActionJson: string;
  accepted: boolean;
  invalidCode?: string;
  /**
   * Bounded private memory the Automaton chose to carry forward, or absent
   * when it wrote none. Already redacted at the query seam for an
   * unauthorized viewer of a tournament run (`convex/simulatorRuns.ts`'s
   * `projectChunkForHumans`, keyed on `visibleSlotId`) before this record
   * ever reaches `frameAtTick` -- so surfacing it here is always the caller's
   * own, already-screened memory, never an opponent's during a tournament.
   */
  scratchAfter?: string;
};

export type StoredTick = {
  tick: number;
  phase: string;
  physicsSeed?: string;
  automata: readonly StoredAutomatonTick[];
  deltaJson?: string;
  metrics: readonly MetricValue[];
};

export type StoredCheckpoint = {
  tick: number;
  stateJson: string;
  sceneJson: string;
  stateHash: string;
};

export type StoredSimulatorRunChunk = {
  startTick: number;
  endTick: number;
  ticks: readonly StoredTick[];
  initialCheckpoint?: StoredCheckpoint;
  checkpoint?: StoredCheckpoint;
};

export type WorkbenchRoundActorEvidence = {
  id: string;
  slotId?: string;
  label: string;
  actionId: string;
  actionLabel: string;
  roundPayoff: number;
  cumulativeTotal: number;
  detailsRedacted?: boolean;
  decisionSource?: DecisionSource;
  policyRuleId?: string;
  policyTrace?: string;
};

export type WorkbenchMatchRoundActorEvidence = WorkbenchRoundActorEvidence & {
  perception: {
    sawOpponentActionId: string;
    sawOpponentActionLabel: string;
    actualOpponentActionId: string;
    actualOpponentActionLabel: string;
    misperceived: boolean;
  };
};

export type WorkbenchCommonsRoundActorEvidence = WorkbenchRoundActorEvidence & {
  perception: {
    perceivedContributorCount: number;
    actualContributorCount: number;
    misperceived: boolean;
  };
};

export type WorkbenchMatchRoundEvidence = {
  kind: "match";
  round: number;
  actors: readonly WorkbenchMatchRoundActorEvidence[];
};

export type WorkbenchCommonsRoundEvidence = {
  kind: "commons";
  round: number;
  contributorCount: number;
  pool: number;
  sharePerPlayer: number;
  actors: readonly WorkbenchCommonsRoundActorEvidence[];
};

export type WorkbenchRoundEvidence =
  | WorkbenchMatchRoundEvidence
  | WorkbenchCommonsRoundEvidence;

export type EcosystemSenseConfirmation = {
  actorId: string;
  senseId: EcosystemInspectableSenseId;
  tick: number;
  cells: readonly { x: number; y: number }[];
};

export type EcosystemSenseEvidenceRequest = {
  actorId: string;
  senseId: EcosystemInspectableSenseId;
};

// 0.32 × 0.5^5 = 0.01: older confirmations are visually inert.
export const ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS = 5;

export type PopulationTraitEvidence = {
  metricKey: "traitMean" | "perceptionMean";
  label: string;
  samples: readonly {
    tick: number;
    values: readonly number[];
  }[];
};

export function hasPopulationTraitEvidence(spec: SimulatorSpec | undefined): boolean {
  return Boolean(
    spec?.templateId === "ecosystemGrid" &&
      spec.config?.heredity?.enabled &&
      spec.criterion?.kind === "measured" &&
      (spec.criterion?.metricKey === "traitMean" ||
        spec.criterion?.metricKey === "perceptionMean"),
  );
}

export interface SceneFrame {
  tick: number;
  automata: Array<{
    id: string;
    slotId?: string;
    speciesLabel: string;
    x: number;
    y: number;
    alive: true;
    energy?: number;
    lastAction: string;
    invalid?: boolean;
    saw?: string;
    senseAudit?: string;
    thought?: string;
    decisionSource?: DecisionSource;
    policyRuleId?: string;
    policyTrace?: string;
    did?: string;
    /**
     * A screened one-line rendering of the Automaton's carried-forward
     * scratch after this tick's decision, or absent when it wrote none or
     * (during a tournament run) the viewer may not see this Automaton's
     * memory. See `StoredAutomatonTick.scratchAfter`.
     */
    remembers?: string;
  }>;
  /**
   * The latest persisted decision for an Automaton no longer in this frame.
   * This stays separate from `automata` so renderers never draw a dead
   * Automaton as living, while the existing Inspector can still inspect it.
   */
  terminalAutomata: Array<{
    id: string;
    slotId?: string;
    speciesLabel: string;
    x: number;
    y: number;
    alive: false;
    energy?: number;
    lastAction: string;
    invalid?: boolean;
    saw?: string;
    senseAudit?: string;
    thought?: string;
    decisionSource?: DecisionSource;
    policyRuleId?: string;
    policyTrace?: string;
    did?: string;
    remembers?: string;
    lastDecisionTick: number;
  }>;
  terrain: readonly SimulatorSceneCellV1[];
  metrics: Record<string, number>;
  scene: SimulatorSceneV1;
  /**
   * A derived, display-safe ledger for the non-field Workbench renderers. It is
   * never persisted: every entry is projected from the already-redacted tick
   * records supplied for this frame.
   */
  workbenchRoundEvidence?: readonly WorkbenchRoundEvidence[];
  /**
   * Exact cells an actor's authored sense could confirm at each committed
   * decision tick. The viewport turns this history into a fading certainty
   * field; it never guesses from the current world.
   */
  ecosystemSenseConfirmations?: readonly EcosystemSenseConfirmation[];
  /** Individual inherited traits from committed checkpoint scenes. */
  populationTraitEvidence?: PopulationTraitEvidence;
}

export function mergeSelectedRoundFrame(
  selectedFrame: SceneFrame,
  completeFrame: SceneFrame,
): SceneFrame {
  return {
    ...selectedFrame,
    workbenchRoundEvidence: completeFrame.workbenchRoundEvidence,
  };
}

/**
 * The pre-run Workbench view is a terrain inspection, not a simulated state.
 * Ecosystem resources are deterministic authored world inputs, so they may be
 * shown; zero-count slots deliberately prevent previewing automata, metrics, or
 * any future run outcome. Other templates retain their established empty state.
 */
export function initialTerrainPreviewScene(spec: SimulatorSpec): SimulatorSceneV1 | null {
  if (spec.templateId !== "ecosystemGrid") return null;

  const template = getSimulatorTemplate(spec.templateId);
  if (
    !template ||
    spec.version !== SIMULATOR_PROTOCOL_VERSION ||
    spec.templateVersion !== template.version
  ) {
    return null;
  }

  try {
    // A completely bare authored world is allowed before its first Species card
    // exists. Validate every other authored field against the real template.
    const specForValidation =
      spec.speciesSlots.length === 0
        ? {
            ...spec,
            speciesSlots: [
              {
                slotId: "terrain-preview",
                label: "terrain preview",
                countMin: 0,
                countMax: 0,
                defaultCount: 0,
                senses: [],
              },
            ],
          }
        : spec;
    template.validateSpec(specForValidation);
    const previewSpecies = spec.speciesSlots.map((slot) => ({
      slotId: slot.slotId,
      label: slot.label,
      count: 0,
      countMax: slot.countMax,
      senses: slot.senses,
      prompt: "",
    }));
    // Authoring can present a bare world before the first Species card exists.
    // This zero-count placeholder only satisfies the physics initializer's
    // structural minimum; it is never emitted in the scene.
    if (previewSpecies.length === 0) {
      previewSpecies.push({
        slotId: "terrain-preview",
        label: "terrain preview",
        count: 0,
        countMax: 0,
        senses: [],
        prompt: "",
      });
    }
    const state = template.initialState({
      config: spec.config,
      species: previewSpecies,
      // This seed belongs only to the activity's authored preview. A launched
      // run still creates and freezes its own random seed and checkpoint.
      seed: `terrain-preview:${JSON.stringify(spec.config)}`,
    });
    return {
      ...template.renderScene({ state, tick: 0 }),
      entities: [],
    };
  } catch {
    // A legacy or malformed stored ecosystem spec must retain the old blank
    // viewport rather than making the Workbench fail to open.
    return null;
  }
}

function parseJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
}

function observationSelf(json: string): { x?: number; y?: number; energy?: number } | undefined {
  try {
    return (JSON.parse(json) as { self?: { x?: number; y?: number; energy?: number } }).self;
  } catch {
    // The query seam may replace oversized model-visible JSON with a safe
    // display placeholder. A terminal record still has its corpse position;
    // never let that placeholder make the entire replay unavailable.
    return undefined;
  }
}

function checkpointAtOrBefore(chunks: readonly StoredSimulatorRunChunk[], tick: number) {
  const checkpoints = chunks.flatMap((chunk) =>
    [chunk.initialCheckpoint, chunk.checkpoint].filter(
      (candidate): candidate is StoredCheckpoint => candidate !== undefined && candidate.tick <= tick,
    ),
  );
  return checkpoints.sort((left, right) => right.tick - left.tick)[0];
}

function allTicks(chunks: readonly StoredSimulatorRunChunk[]) {
  return chunks
    .flatMap((chunk) => [...chunk.ticks])
    .sort((left, right) => left.tick - right.tick);
}

function displayWorkbenchText(value: string): string {
  return screenWorldText(value, { maxChars: 500 }) ?? "Automaton";
}

function actorLabel(
  spec: SimulatorSpec,
  record: StoredAutomatonTick,
): string {
  const slot = spec.speciesSlots.find((candidate) => candidate.slotId === record.slotId);
  return displayWorkbenchText(slot?.label ?? record.slotId ?? record.automatonId);
}

function roundActorBase(input: {
  spec: SimulatorSpec;
  record: StoredAutomatonTick;
  actionId: string;
  actionLabel: string;
  roundPayoff: number;
  cumulativeTotal: number;
}): WorkbenchRoundActorEvidence {
  return {
    id: input.record.automatonId,
    slotId: input.record.slotId,
    label: actorLabel(input.spec, input.record),
    actionId: input.actionId,
    actionLabel: displayWorkbenchText(input.actionLabel),
    roundPayoff: input.roundPayoff,
    cumulativeTotal: input.cumulativeTotal,
    ...(input.record.detailsRedacted
      ? { detailsRedacted: true }
      : {
          decisionSource: input.record.source,
          policyRuleId: input.record.policyRuleId,
          policyTrace: screenWorldText(input.record.policyTrace, {
            maxChars: 500,
          }),
        }),
  };
}

function requireRoundDeltaJson(tick: StoredTick): string {
  if (!tick.deltaJson) {
    throw new Error(`Missing round delta JSON for replay tick ${tick.tick}`);
  }
  return tick.deltaJson;
}

function decisionRecords(tick: StoredTick): Map<string, StoredAutomatonTick> {
  return new Map(tick.automata.map((record) => [record.automatonId, record]));
}

function decisionRecord(
  records: ReadonlyMap<string, StoredAutomatonTick>,
  automatonId: string,
  tick: number,
): StoredAutomatonTick {
  const record = records.get(automatonId);
  if (!record) {
    throw new Error(`Missing decision record for "${automatonId}" at replay tick ${tick}`);
  }
  return record;
}

function prisonersDilemmaActionLabel(actionId: "cooperate" | "defect"): string {
  return actionId === "cooperate" ? "Cooperate" : "Defect";
}

function publicGoodsActionLabel(actionId: "contribute" | "withhold"): string {
  return actionId === "contribute" ? "Contribute" : "Withhold";
}

function matrixGameActionLabel(
  spec: Extract<SimulatorSpec, { templateId: "matrixGame" }>,
  actionId: "optionA" | "optionB",
): string {
  const action = spec.config.actions.find((candidate) => candidate.actionId === actionId);
  if (!action) {
    throw new Error(`Missing authored label for matrix action "${actionId}"`);
  }
  return action.label;
}

function validatedRoundDelta(
  templateId: "prisonersDilemma",
  template: ReturnType<typeof getSimulatorTemplate>,
  tick: StoredTick,
): PrisonersDilemmaDelta;
function validatedRoundDelta(
  templateId: "matrixGame",
  template: ReturnType<typeof getSimulatorTemplate>,
  tick: StoredTick,
): MatrixGameDelta;
function validatedRoundDelta(
  templateId: "publicGoods",
  template: ReturnType<typeof getSimulatorTemplate>,
  tick: StoredTick,
): PublicGoodsDelta;
function validatedRoundDelta(
  templateId: Exclude<SimulatorSpec["templateId"], "ecosystemGrid">,
  template: ReturnType<typeof getSimulatorTemplate>,
  tick: StoredTick,
): PrisonersDilemmaDelta | MatrixGameDelta | PublicGoodsDelta {
  if (!template) throw new Error(`Unknown World template "${templateId}"`);
  const validated = template.validateDelta(
    parseJson<unknown>(requireRoundDeltaJson(tick), "round delta"),
  );
  switch (templateId) {
    case "prisonersDilemma":
      return validatePrisonersDilemmaDelta(validated);
    case "matrixGame":
      return validateMatrixGameDelta(validated);
    case "publicGoods":
      return validatePublicGoodsDelta(validated);
  }
}

function workbenchRoundEvidence(input: {
  family: Exclude<WorkbenchRendererFamily, "field">;
  spec: SimulatorSpec;
  template: NonNullable<ReturnType<typeof getSimulatorTemplate>>;
  ticks: readonly StoredTick[];
  targetTick: number;
}): readonly WorkbenchRoundEvidence[] {
  const totals = new Map<string, number>();
  const ledger: WorkbenchRoundEvidence[] = [];
  const { spec } = input;
  for (const tick of input.ticks) {
    if (tick.tick >= input.targetTick) continue;
    const records = decisionRecords(tick);
    switch (spec.templateId) {
      case "prisonersDilemma": {
        if (input.family !== "match") throw new Error("Renderer family does not match template");
        const delta = validatedRoundDelta(spec.templateId, input.template, tick);
        const actors = delta.moves.map((move) => {
          const record = decisionRecord(records, move.automatonId, tick.tick);
          const payoff = delta.payoffs.find((entry) => entry.automatonId === move.automatonId);
          const reading = delta.readings.find((entry) => entry.automatonId === move.automatonId);
          if (!payoff || !reading) {
            throw new Error(`Incomplete prisoner's dilemma delta at replay tick ${tick.tick}`);
          }
          const cumulativeTotal = (totals.get(move.automatonId) ?? 0) + payoff.value;
          totals.set(move.automatonId, cumulativeTotal);
          return {
            ...roundActorBase({
              spec,
              record,
              actionId: move.move,
              actionLabel: prisonersDilemmaActionLabel(move.move),
              roundPayoff: payoff.value,
              cumulativeTotal,
            }),
            perception: {
              sawOpponentActionId: reading.sawOpponentMove,
              sawOpponentActionLabel: prisonersDilemmaActionLabel(reading.sawOpponentMove),
              actualOpponentActionId: reading.actualOpponentMove,
              actualOpponentActionLabel: prisonersDilemmaActionLabel(reading.actualOpponentMove),
              misperceived: reading.misperceived,
            },
          };
        });
        ledger.push({ kind: "match", round: delta.round, actors });
        break;
      }
      case "matrixGame": {
        if (input.family !== "match") throw new Error("Renderer family does not match template");
        const delta = validatedRoundDelta(spec.templateId, input.template, tick);
        const actors = delta.actions.map((action) => {
          const record = decisionRecord(records, action.automatonId, tick.tick);
          const payoff = delta.payoffs.find((entry) => entry.automatonId === action.automatonId);
          const reading = delta.readings.find((entry) => entry.automatonId === action.automatonId);
          if (!payoff || !reading) {
            throw new Error(`Incomplete matrix-game delta at replay tick ${tick.tick}`);
          }
          const cumulativeTotal = (totals.get(action.automatonId) ?? 0) + payoff.value;
          totals.set(action.automatonId, cumulativeTotal);
          return {
            ...roundActorBase({
              spec,
              record,
              actionId: action.actionId,
              actionLabel: matrixGameActionLabel(spec, action.actionId),
              roundPayoff: payoff.value,
              cumulativeTotal,
            }),
            perception: {
              sawOpponentActionId: reading.sawOpponentAction,
              sawOpponentActionLabel: matrixGameActionLabel(
                spec,
                reading.sawOpponentAction,
              ),
              actualOpponentActionId: reading.actualOpponentAction,
              actualOpponentActionLabel: matrixGameActionLabel(
                spec,
                reading.actualOpponentAction,
              ),
              misperceived: reading.misperceived,
            },
          };
        });
        ledger.push({ kind: "match", round: delta.round, actors });
        break;
      }
      case "publicGoods": {
        if (input.family !== "commons") throw new Error("Renderer family does not match template");
        const delta = validatedRoundDelta(spec.templateId, input.template, tick);
        const actors = delta.actions.map((action) => {
          const record = decisionRecord(records, action.automatonId, tick.tick);
          const payoff = delta.payoffs.find((entry) => entry.automatonId === action.automatonId);
          const reading = delta.readings.find((entry) => entry.automatonId === action.automatonId);
          if (!payoff || !reading) {
            throw new Error(`Incomplete public-goods delta at replay tick ${tick.tick}`);
          }
          const cumulativeTotal = (totals.get(action.automatonId) ?? 0) + payoff.value;
          totals.set(action.automatonId, cumulativeTotal);
          return {
            ...roundActorBase({
              spec,
              record,
              actionId: action.action,
              actionLabel: publicGoodsActionLabel(action.action),
              roundPayoff: payoff.value,
              cumulativeTotal,
            }),
            perception: {
              perceivedContributorCount: reading.perceivedContributorCount,
              actualContributorCount: reading.actualContributorCount,
              misperceived: reading.misperceived,
            },
          };
        });
        ledger.push({
          kind: "commons",
          round: delta.round,
          contributorCount: delta.contributorCount,
          pool: delta.pool,
          sharePerPlayer: delta.sharePerPlayer,
          actors,
        });
        break;
      }
      case "ecosystemGrid":
        throw new Error("Field templates do not have Workbench round evidence");
    }
  }
  return ledger;
}

function ecosystemSenseConfirmations(input: {
  chunks: readonly StoredSimulatorRunChunk[];
  ticks: readonly StoredTick[];
  targetTick: number;
  spec: Extract<SimulatorSpec, { templateId: "ecosystemGrid" }>;
  template: NonNullable<ReturnType<typeof getSimulatorTemplate>>;
  request: EcosystemSenseEvidenceRequest;
}): readonly EcosystemSenseConfirmation[] {
  const latestDecisionTick = Math.max(0, input.targetTick - 1);
  const confirmationStartTick = Math.max(
    0,
    latestDecisionTick - ECOSYSTEM_SENSE_CONFIRMATION_HORIZON_TICKS,
  );
  // Rebuild from the nearest available checkpoint before the visible horizon:
  // replay must remain contiguous to preserve the committed pre-action scene,
  // but there is no reason to retain confirmations too faint to render.
  const checkpoint = checkpointAtOrBefore(input.chunks, confirmationStartTick);
  if (!checkpoint) return [];
  const replayTicks = input.ticks.filter(
    (tick) => tick.tick >= checkpoint.tick && tick.tick < input.targetTick,
  );
  let expectedTick = checkpoint.tick;
  for (const tick of replayTicks) {
    if (tick.tick !== expectedTick) return [];
    expectedTick += 1;
  }
  if (expectedTick !== input.targetTick) return [];

  let state = input.template.validateState(parseJson(checkpoint.stateJson, "initial checkpoint state"));
  const confirmations: EcosystemSenseConfirmation[] = [];
  for (const tick of replayTicks) {
    const scene = input.template.renderScene({ state, tick: tick.tick });
    const coverage = projectEcosystemSenseCoverage({
      spec: input.spec,
      scene,
      actorId: input.request.actorId,
      senseId: input.request.senseId,
    });
    if (coverage && tick.tick >= confirmationStartTick) {
      confirmations.push({
        actorId: coverage.actorId,
        senseId: coverage.senseId,
        tick: tick.tick,
        cells: coverage.cells,
      });
    }
    const actions = new Map<string, unknown>();
    for (const record of tick.automata) {
      actions.set(
        record.automatonId,
        input.template.validateAction(parseJson(record.acceptedActionJson, "accepted action")),
      );
    }
    state = input.template.applyActions({
      state,
      actions,
      tick: tick.tick,
      tickSeed: tick.physicsSeed ?? `replay:${tick.tick}`,
    }).state;
  }
  return confirmations;
}

function populationTraitEvidence(input: {
  chunks: readonly StoredSimulatorRunChunk[];
  targetTick: number;
  spec: Extract<SimulatorSpec, { templateId: "ecosystemGrid" }>;
  scene: SimulatorSceneV1;
}): PopulationTraitEvidence | undefined {
  if (!input.spec.config.heredity?.enabled || input.spec.criterion.kind !== "measured") {
    return undefined;
  }
  const metricKey =
    input.spec.criterion.metricKey === "traitMean" ||
    input.spec.criterion.metricKey === "perceptionMean"
      ? input.spec.criterion.metricKey
      : undefined;
  if (!metricKey) return undefined;

  const valueFor = (scene: SimulatorSceneV1) =>
    scene.entities
      .filter((entity) => entity.kind === "automaton")
      .map((entity) => metricKey === "traitMean" ? entity.trait : entity.perceptionTrait)
      .filter((value): value is number => Number.isFinite(value));
  const samples = input.chunks
    .flatMap((chunk) => [chunk.initialCheckpoint, chunk.checkpoint])
    .filter((checkpoint): checkpoint is StoredCheckpoint => Boolean(checkpoint))
    .filter((checkpoint) => checkpoint.tick <= input.targetTick)
    .sort((left, right) => left.tick - right.tick)
    .filter((checkpoint, index, all) => index === 0 || checkpoint.tick !== all[index - 1].tick)
    .map((checkpoint) => ({
      tick: checkpoint.tick,
      values: valueFor(parseJson<SimulatorSceneV1>(checkpoint.sceneJson, "checkpoint scene")),
    }))
    .filter((sample) => sample.values.length > 0);
  if (!samples.some((sample) => sample.tick === input.targetTick)) {
    const values = valueFor(input.scene);
    if (values.length > 0) samples.push({ tick: input.targetTick, values });
  }
  return samples.length > 0
    ? {
        metricKey,
        label: metricKey === "traitMean" ? "Body trait" : "Sight trait",
        samples,
      }
    : undefined;
}

export function frameAtTick(
  chunks: readonly StoredSimulatorRunChunk[],
  targetTick: number,
  spec: SimulatorSpec,
  options: { ecosystemSenseEvidenceRequest?: EcosystemSenseEvidenceRequest } = {},
): SceneFrame {
  if (!Number.isInteger(targetTick) || targetTick < 0) throw new Error("Replay tick must be non-negative");
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
  template.validateSpec(spec);
  const rendererFamily = getWorkbenchRendererFamily(spec.templateId);
  if (!rendererFamily) throw new Error(`Unknown Workbench renderer for "${spec.templateId}"`);
  const checkpoint = checkpointAtOrBefore(chunks, targetTick);
  if (!checkpoint) throw new Error(`No checkpoint is available at or before tick ${targetTick}`);
  let state = template.validateState(parseJson(checkpoint.stateJson, "checkpoint state"));
  let scene = parseJson<SimulatorSceneV1>(checkpoint.sceneJson, "checkpoint scene");
  const ticks = allTicks(chunks);
  let metrics: readonly MetricValue[] =
    [...ticks].reverse().find((tick) => tick.tick + 1 === checkpoint.tick)?.metrics ?? [];
  for (const tick of ticks) {
    if (tick.tick < checkpoint.tick || tick.tick >= targetTick) continue;
    const actions = new Map<string, unknown>();
    for (const record of tick.automata) {
      actions.set(
        record.automatonId,
        template.validateAction(parseJson(record.acceptedActionJson, "accepted action")),
      );
    }
    const result = template.applyActions({
      state,
      actions,
      tick: tick.tick,
      tickSeed: tick.physicsSeed ?? `replay:${tick.tick}`,
    });
    state = result.state;
    scene = template.renderScene({ state, tick: tick.tick + 1 });
    metrics = tick.metrics;
  }
  if (scene.tick !== targetTick) {
    scene = template.renderScene({ state, tick: targetTick });
  }
  const mindTick = [...ticks].reverse().find((tick) => tick.tick < targetTick);
  const mindById = new Map(mindTick?.automata.map((record) => [record.automatonId, record]) ?? []);
  const derivedWorkbenchRoundEvidence =
    rendererFamily === "field"
      ? undefined
      : workbenchRoundEvidence({
          family: rendererFamily,
          spec,
          template,
          ticks,
          targetTick,
        });
  const derivedEcosystemSenseConfirmations =
    spec.templateId === "ecosystemGrid" && options.ecosystemSenseEvidenceRequest
      ? ecosystemSenseConfirmations({
          chunks,
          ticks,
          targetTick,
          spec,
          template,
          request: options.ecosystemSenseEvidenceRequest,
        })
      : undefined;
  const derivedPopulationTraitEvidence =
    spec.templateId === "ecosystemGrid"
      ? populationTraitEvidence({ chunks, targetTick, spec, scene })
      : undefined;
  const perceptionReadings =
    spec.templateId === "prisonersDilemma" && mindTick?.deltaJson
      ? validatePrisonersDilemmaDelta(
          template.validateDelta(parseJson<unknown>(mindTick.deltaJson, "prisoner's dilemma delta")),
        ).readings
      : [];
  const livingIds = new Set(
    scene.entities
      .filter((entity) => entity.kind === "automaton")
      .map((entity) => entity.id),
  );
  const latestMindByTerminalId = new Map<
    string,
    { record: StoredAutomatonTick; tick: number }
  >();
  for (const tick of ticks) {
    if (tick.tick >= targetTick) continue;
    for (const record of tick.automata) {
      latestMindByTerminalId.set(record.automatonId, { record, tick: tick.tick });
    }
  }
  const terminalAutomata = [...latestMindByTerminalId.values()]
    .filter(({ record }) => !livingIds.has(record.automatonId))
    .map(({ record, tick }) => {
      const self = observationSelf(record.observationJson);
      const corpse = scene.entities.find((entity) => entity.automatonId === record.automatonId);
      const action = parseJson<{ kind?: string }>(record.acceptedActionJson, "accepted action");
      const slot = spec.speciesSlots.find((candidate) => candidate.slotId === record.slotId);
      return {
        id: record.automatonId,
        slotId: record.slotId,
        speciesLabel: slot?.label ?? "automaton",
        x: corpse?.x ?? self?.x ?? 0,
        y: corpse?.y ?? self?.y ?? 0,
        alive: false as const,
        energy: self?.energy,
        lastAction: action.kind ?? "none",
        invalid: Boolean(record.invalidCode),
        saw: screenWorldText(record.observationJson, { maxChars: 32_000 }),
        thought: screenWorldText(record.reasoning, { maxChars: 500 }),
        decisionSource: record.source,
        policyRuleId: record.policyRuleId,
        policyTrace: screenWorldText(record.policyTrace, { maxChars: 500 }),
        did: record.acceptedActionJson,
        remembers: screenWorldText(record.scratchAfter, { maxChars: MAX_SCRATCH_CHARS })
          ?.replace(/\s+/g, " ")
          .trim(),
        lastDecisionTick: tick,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    tick: targetTick,
    automata: scene.entities
      .filter((entity) => entity.kind === "automaton")
      .map((entity) => {
        const mind = mindById.get(entity.id);
        const action = mind ? parseJson<{ kind?: string }>(mind.acceptedActionJson, "accepted action") : {};
        return {
          id: entity.id,
          slotId: mind?.slotId,
          speciesLabel: entity.label ?? entity.kind,
          x: entity.x,
          y: entity.y,
          alive: true as const,
          energy: entity.energy,
          lastAction: action.kind ?? "none",
          invalid: Boolean(mind?.invalidCode),
          saw: screenWorldText(mind?.observationJson, { maxChars: 32_000 }),
          senseAudit: (() => {
            const reading = perceptionReadings.find(
              (candidate) => candidate.automatonId === entity.id,
            );
            if (!reading) return undefined;
            return reading.misperceived
              ? `saw ${reading.sawOpponentMove} (actually ${reading.actualOpponentMove})`
              : `saw ${reading.sawOpponentMove}`;
          })(),
          thought: screenWorldText(mind?.reasoning, { maxChars: 500 }),
          decisionSource: mind?.source,
          policyRuleId: mind?.policyRuleId,
          policyTrace: screenWorldText(mind?.policyTrace, { maxChars: 500 }),
          did: mind?.acceptedActionJson,
          // Collapse whitespace runs (screenWorldText preserves newlines) so the
          // surfaced memory is genuinely one line, as the inspector renders it.
          remembers: screenWorldText(mind?.scratchAfter, { maxChars: MAX_SCRATCH_CHARS })
            ?.replace(/\s+/g, " ")
            .trim(),
        };
      }),
    terminalAutomata,
    terrain: scene.cells,
    metrics: Object.fromEntries(metrics.map((metric) => [metric.key, metric.value])),
    scene,
    ...(derivedWorkbenchRoundEvidence
      ? { workbenchRoundEvidence: derivedWorkbenchRoundEvidence }
      : {}),
    ...(derivedEcosystemSenseConfirmations
      ? { ecosystemSenseConfirmations: derivedEcosystemSenseConfirmations }
      : {}),
    ...(derivedPopulationTraitEvidence
      ? { populationTraitEvidence: derivedPopulationTraitEvidence }
      : {}),
  };
}

export function replayCursor(
  runId: string,
  options: {
    pageSize?: number;
    loadChunks: (input: {
      runId: string;
      fromTick: number;
      limit: number;
    }) => Promise<readonly StoredSimulatorRunChunk[]>;
  },
) {
  const pageSize = options.pageSize ?? 6;
  const cached = new Map<number, StoredSimulatorRunChunk>();
  const load = async (fromTick: number) => {
    const chunks = await options.loadChunks({ runId, fromTick, limit: pageSize });
    for (const chunk of chunks) cached.set(chunk.startTick, chunk);
  };
  return {
    async frameAtTick(tick: number, spec: SimulatorSpec) {
      await load(Math.max(0, tick - CHECKPOINT_EVERY_TICKS - TICKS_PER_CHUNK));
      if (![...cached.values()].some((chunk) => chunk.initialCheckpoint?.tick === 0)) await load(0);
      return frameAtTick([...cached.values()], tick, spec);
    },
    async prefetchAround(tick: number) {
      await Promise.all([
        load(Math.max(0, tick - CHECKPOINT_EVERY_TICKS - TICKS_PER_CHUNK)),
        load(tick),
      ]);
    },
  };
}
