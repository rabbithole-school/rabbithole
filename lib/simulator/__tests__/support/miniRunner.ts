import type {
  LaunchedSpecies,
  RuntimeSimulatorTemplate,
  SimulatorSpec,
} from "../../contract";
import { evaluatePolicy, type PolicyIR } from "../../policyIR";

export type MiniTick = {
  tick: number;
  phase: string;
  state: unknown;
  stateJson: string;
  actions: ReadonlyMap<string, unknown>;
  delta: unknown;
  metrics: Record<string, number>;
  terminal: boolean;
};

export type MiniRun = {
  initialState: unknown;
  finalState: unknown;
  ticks: readonly MiniTick[];
};

export function launchedSpecies(
  spec: SimulatorSpec,
  counts: Readonly<Record<string, number>> = {},
): LaunchedSpecies[] {
  return spec.speciesSlots
    .map((slot) => ({
      slotId: slot.slotId,
      label: slot.label,
      count: counts[slot.slotId] ?? slot.defaultCount,
      countMax: slot.countMax,
      senses: slot.senses,
      prompt: slot.starterHint ?? `Follow the ${slot.label} policy.`,
    }))
    .filter((slot) => slot.count > 0);
}

function neutralAction(legalActions: readonly unknown[]): unknown {
  const noop = legalActions.find(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      Reflect.get(action, "kind") === "noop",
  );
  const neutral = noop ?? legalActions[0];
  if (neutral === undefined) {
    throw new Error("World template produced no legal action");
  }
  return neutral;
}

export function runTemplate(input: {
  template: RuntimeSimulatorTemplate;
  spec: SimulatorSpec;
  seed: string;
  policies?: Readonly<Record<string, PolicyIR>>;
  species?: readonly LaunchedSpecies[];
  state?: unknown;
  startTick?: number;
  ticks: number;
  stopOnTerminal?: boolean;
}): MiniRun {
  const {
    template,
    spec,
    seed,
    policies = {},
    startTick = 0,
    stopOnTerminal = true,
  } = input;
  const initialState =
    input.state ??
    template.initialState({
      config: spec.config,
      species: input.species ?? launchedSpecies(spec),
      seed,
    });
  let state = initialState;
  const records: MiniTick[] = [];

  for (let offset = 0; offset < input.ticks; offset += 1) {
    const tick = startTick + offset;
    const previousState = state;
    const phase = template.tickPhase({ state, tick });
    const actions = new Map<string, unknown>();

    for (const automaton of template.listAutomata(state)) {
      const observation = template.buildObservation({
        state,
        automatonId: automaton.id,
        senses: automaton.senses,
        tick,
      });
      const legalActions = template.legalActions({
        state,
        automatonId: automaton.id,
        observation,
        tick,
      });
      const policy = policies[automaton.slotId];
      const evaluation = policy
        ? evaluatePolicy(policy, observation, legalActions, tick, undefined, phase)
        : { kind: "abstain" as const };
      actions.set(
        automaton.id,
        evaluation.kind === "action"
          ? evaluation.action
          : neutralAction(legalActions),
      );
    }

    const applied = template.applyActions({
      state,
      actions,
      tick,
      tickSeed: `${seed}:${tick}`,
    });
    state = applied.state;
    records.push({
      tick,
      phase: applied.phase,
      state,
      stateJson: JSON.stringify(state),
      actions,
      delta: applied.delta,
      metrics: template.metrics({
        previousState,
        state,
        tick,
      }),
      terminal: applied.terminal,
    });
    if (applied.terminal && stopOnTerminal) break;
  }

  return { initialState, finalState: state, ticks: records };
}
