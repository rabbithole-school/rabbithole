/**
 * The WORLD TEMPLATE REGISTRY -- every physics engine the platform can run.
 *
 * WHY CODE, NOT ROWS. A SimulatorSpec parameterizes a known mechanic; it never
 * invents physics. Keeping the registry beside the pure templates makes the
 * authoring validator, server worker, and both renderers agree about versions,
 * Senses, actions, metrics, and renderer protocol support.
 */

import {
  SUPPORTED_RENDERER_PROTOCOL_VERSIONS,
  type RuntimeSimulatorTemplate,
  type SimulatorTemplate,
} from "../contract";
import { ECOSYSTEM_GRID } from "./ecosystemGrid";
import { MATRIX_GAME } from "./matrixGame";
import { PRISONERS_DILEMMA } from "./prisonersDilemma";
import { PUBLIC_GOODS } from "./publicGoods";

export const SIMULATOR_TEMPLATE_IDS = [
  "ecosystemGrid",
  "prisonersDilemma",
  "matrixGame",
  "publicGoods",
] as const;
export type SimulatorTemplateId = (typeof SIMULATOR_TEMPLATE_IDS)[number];
export type SimulatorTemplateAny = RuntimeSimulatorTemplate;

/**
 * The renderer family is an internal Workbench contract. Templates own the
 * physics and scene protocol; this registry-owned mapping tells each client
 * which bounded presentation can consume the shared scene evidence.
 */
export const WORKBENCH_RENDERER_FAMILIES = ["field", "match", "commons"] as const;
export type WorkbenchRendererFamily = (typeof WORKBENCH_RENDERER_FAMILIES)[number];

export const WORKBENCH_RENDERER_FAMILY_BY_TEMPLATE: Readonly<
  Record<SimulatorTemplateId, WorkbenchRendererFamily>
> = {
  ecosystemGrid: "field",
  prisonersDilemma: "match",
  matrixGame: "match",
  publicGoods: "commons",
};

function runtimeTemplate<C, S, O, A, D, M extends Record<string, number>>(
  template: SimulatorTemplate<C, S, O, A, D, M>,
): RuntimeSimulatorTemplate {
  return {
    id: template.id,
    version: template.version,
    rendererProtocolVersion: template.rendererProtocolVersion,
    cacheablePrefixMeasuredTokens: template.cacheablePrefixMeasuredTokens,
    senseIds: template.senseIds,
    actionKinds: template.actionKinds,
    actionSchema: template.actionSchema,
    metricKeys: template.metricKeys,
    summaryMetricKeys: template.summaryMetricKeys,
    validateConfig: template.validateConfig,
    validateState: template.validateState,
    validateAction: template.validateAction,
    validateDelta: template.validateDelta,
    validateSpec: template.validateSpec,
    initialState: ({ config, species, seed }) =>
      template.initialState({
        config: template.validateConfig(config),
        species,
        seed,
      }),
    buildObservation: ({ state, automatonId, senses, tick }) =>
      template.buildObservation({
        state: template.validateState(state),
        automatonId,
        senses,
        tick,
      }),
    legalActions: ({ state, automatonId, observation, tick }) =>
      template.legalActions({
        state: template.validateState(state),
        automatonId,
        observation: observation as O,
        tick,
      }),
    listAutomata: (state) => template.listAutomata(template.validateState(state)),
    tickPhase: ({ state, tick }) =>
      template.tickPhase({ state: template.validateState(state), tick }),
    applyActions: ({ state, actions, tick, tickSeed }) =>
      template.applyActions({
        state: template.validateState(state),
        actions: new Map(
          [...actions].map(([automatonId, action]) => [
            automatonId,
            template.validateAction(action),
          ]),
        ),
        tick,
        tickSeed,
      }),
    metrics: ({ previousState, state, tick }) =>
      template.metrics({
        previousState: template.validateState(previousState),
        state: template.validateState(state),
        tick,
      }),
    withInvalidActions: ({ state, count }) =>
      template.withInvalidActions({ state: template.validateState(state), count }),
    withInvalidActionDelta: ({ delta, automatonIds }) =>
      template.withInvalidActionDelta({
        delta: template.validateDelta(delta),
        automatonIds,
      }),
    renderScene: ({ state, tick }) =>
      template.renderScene({ state: template.validateState(state), tick }),
  };
}

export function isSimulatorTemplateId(value: string): value is SimulatorTemplateId {
  return (SIMULATOR_TEMPLATE_IDS as readonly string[]).includes(value);
}

export const SIMULATOR_TEMPLATES: Readonly<Record<SimulatorTemplateId, SimulatorTemplateAny>> = {
  ecosystemGrid: runtimeTemplate(ECOSYSTEM_GRID),
  prisonersDilemma: runtimeTemplate(PRISONERS_DILEMMA),
  matrixGame: runtimeTemplate(MATRIX_GAME),
  publicGoods: runtimeTemplate(PUBLIC_GOODS),
};

export function getSimulatorTemplate(id: string): SimulatorTemplateAny | null {
  return isSimulatorTemplateId(id) ? SIMULATOR_TEMPLATES[id] : null;
}

export function getWorkbenchRendererFamily(id: string): WorkbenchRendererFamily | null {
  return isSimulatorTemplateId(id) ? WORKBENCH_RENDERER_FAMILY_BY_TEMPLATE[id] : null;
}

export function workbenchTimeNoun(id: string): "day" | "round" {
  const family = getWorkbenchRendererFamily(id);
  return family === "match" || family === "commons" ? "round" : "day";
}

export function simulatorTemplateErrors(template: SimulatorTemplateAny): string[] {
  const errors: string[] = [];
  if (!template.id) errors.push("missing template id");
  if (!Number.isInteger(template.version) || template.version < 1) {
    errors.push(`${template.id}: version must be a positive integer`);
  }
  if (
    !(SUPPORTED_RENDERER_PROTOCOL_VERSIONS as readonly number[]).includes(
      template.rendererProtocolVersion,
    )
  ) {
    errors.push(`${template.id}: unsupported renderer protocol`);
  }
  if (
    template.cacheablePrefixMeasuredTokens !== 0 &&
    template.cacheablePrefixMeasuredTokens < 4_096
  ) {
    errors.push(`${template.id}: measured cacheable prefix does not clear 4,096 tokens`);
  }
  for (const [label, values] of [
    ["sense id", template.senseIds],
    ["action kind", template.actionKinds],
    ["metric key", template.metricKeys],
    ["summary metric key", template.summaryMetricKeys],
  ] as const) {
    if (new Set(values).size !== values.length) errors.push(`${template.id}: duplicate ${label}`);
  }
  const metricKeys = new Set<string>(template.metricKeys);
  const schemaKinds = template.actionSchema.variants.map((variant) => variant.kind);
  if (
    [...schemaKinds].sort().join("\0") !==
    [...template.actionKinds].sort().join("\0")
  ) {
    errors.push(`${template.id}: action schema and action kinds disagree`);
  }
  for (const summaryKey of template.summaryMetricKeys) {
    if (!metricKeys.has(summaryKey)) {
      errors.push(`${template.id}: summary metric "${summaryKey}" is not exported`);
    }
  }
  return errors;
}
