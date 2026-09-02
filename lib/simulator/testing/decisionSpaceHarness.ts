// Decision-space harness — the empirical method behind the curriculum-tension
// rebuilds. It drives the REAL ecosystemGrid v2 + matrixGame templates with
// deterministic archetype "decks" (policy functions) across seeds, so a world's
// intended tension can be ASSERTED (a redesign ships only when the measurement
// shows the failure mode dead). Used by the systemsAgents / cooperationConflict
// drift tests; the red-team-CI lane can build on it later.
//
// This is test/verification infrastructure, not shipped runtime code.
import {
  createEcosystemInitialState,
  buildEcosystemObservation,
  ecosystemLegalActions,
  applyEcosystemActions,
  ecosystemMetrics,
  type EcosystemObservation,
  type EcosystemAction,
} from "../templates/ecosystemGrid";
import {
  createMatrixGameInitialState,
  buildMatrixGameObservation,
  applyMatrixGameActions,
  type MatrixGameObservation,
  type MatrixGameAction,
} from "../templates/matrixGame";
import type {
  EcosystemGridConfig,
  LaunchedSpecies,
  MatrixGameConfig,
  MatrixGameActionId,
  SimulatorSpec,
} from "../contract";
import {
  evaluatePolicy,
  type PolicyIR,
} from "../policyIR";
import { getSimulatorTemplate } from "../templates/registry";

// ── Ecosystem driver ──────────────────────────────────────────────────────
export type EcoPolicy = (obs: EcosystemObservation, legal: readonly EcosystemAction[]) => EcosystemAction;
export type EcoPolicyFactory = () => EcoPolicy;

export type PolicyDeckTickTrace = {
  tick: number;
  previousState: unknown;
  observations: ReadonlyMap<string, unknown>;
  decisions: readonly {
    automatonId: string;
    slotId: string;
    ruleId?: string;
    action: unknown;
    trace: string;
  }[];
  state: unknown;
  delta: unknown;
};

export function runEcosystem(input: {
  config: EcosystemGridConfig;
  species: readonly LaunchedSpecies[];
  policyBySlot: Record<string, EcoPolicyFactory>;
  ticks: number;
  seed: string;
}): { longevity: number; traitMean: number; perceptionMean: number } {
  let state = createEcosystemInitialState({ config: input.config, species: input.species, seed: input.seed });
  const policies = new Map<string, EcoPolicy>();
  for (const s of input.species) policies.set(s.slotId, input.policyBySlot[s.slotId]());
  const speciesBySlot = new Map(input.species.map((s) => [s.slotId, s]));
  let last = ecosystemMetrics({ previousState: state, state, tick: 0 });
  let longevity = 0;
  for (let tick = 0; tick < input.ticks; tick += 1) {
    if (state.automata.length === 0) break;
    const actions = new Map<string, EcosystemAction>();
    for (const a of state.automata) {
      const slot = speciesBySlot.get(a.slotId)!;
      const obs = buildEcosystemObservation({ state, automatonId: a.id, senses: slot.senses, tick });
      const legal = ecosystemLegalActions({ state, automatonId: a.id, observation: obs, tick });
      let chosen = policies.get(a.slotId)!(obs, legal);
      if (!legal.some((l) => JSON.stringify(l) === JSON.stringify(chosen))) {
        chosen = legal.find((l) => l.kind === "rest") ?? { kind: "noop" };
      }
      actions.set(a.id, chosen);
    }
    const previousState = state;
    const result = applyEcosystemActions({ state, actions, tick, tickSeed: `${input.seed}:${tick}` });
    state = result.state;
    last = ecosystemMetrics({ previousState, state, tick });
    if (state.automata.length > 0) longevity = tick + 1;
    if (result.terminal) break;
  }
  return { longevity, traitMean: last.traitMean, perceptionMean: last.perceptionMean };
}

export function launched(species: Array<{ slotId: string; label: string; count: number; countMax: number; senses: LaunchedSpecies["senses"] }>): LaunchedSpecies[] {
  return species.map((s) => ({ ...s, prompt: "" }));
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Runs a compiled policy deck through the same policy evaluator and registered
 * template functions used by the production worker. An abstaining policy is a
 * test error because reference and red-team decks must never fall back to a model.
 */
export function runPolicyDeck(input: {
  spec: SimulatorSpec;
  policies: readonly PolicyIR[];
  ticks: number;
  seed: string;
  onTick?: (trace: PolicyDeckTickTrace) => void;
}): Record<string, number> {
  const template = getSimulatorTemplate(input.spec.templateId);
  if (!template) throw new Error(`Unknown World template "${input.spec.templateId}"`);
  template.validateSpec(input.spec);
  const policySlots = input.policies.map((policy) => policy.slotId);
  if (new Set(policySlots).size !== policySlots.length) {
    throw new Error(`Policy deck repeats slots: ${policySlots.join(", ")}`);
  }
  const policyBySlot = new Map(input.policies.map((policy) => [policy.slotId, policy]));
  const expectedSlots = input.spec.speciesSlots.map((slot) => slot.slotId).sort();
  const actualSlots = [...policyBySlot.keys()].sort();
  if (JSON.stringify(actualSlots) !== JSON.stringify(expectedSlots)) {
    throw new Error(
      `Policy deck slots ${actualSlots.join(", ")} do not match World slots ${expectedSlots.join(", ")}`,
    );
  }
  const species: LaunchedSpecies[] = input.spec.speciesSlots.map((slot) => ({
    slotId: slot.slotId,
    label: slot.label,
    count: slot.defaultCount,
    countMax: slot.countMax,
    senses: slot.senses,
    prompt: "",
  }));
  let state = template.initialState({
    config: input.spec.config,
    species,
    seed: input.seed,
  });
  let metrics = template.metrics({ previousState: state, state, tick: 0 });
  for (let tick = 0; tick < input.ticks; tick += 1) {
    const previousState = state;
    const phase = template.tickPhase({ state, tick });
    const actions = new Map<string, unknown>();
    const observations = new Map<string, unknown>();
    const decisions: PolicyDeckTickTrace["decisions"][number][] = [];
    for (const automaton of template.listAutomata(state)) {
      const slot = input.spec.speciesSlots.find(
        (candidate) => candidate.slotId === automaton.slotId,
      );
      const policy = policyBySlot.get(automaton.slotId);
      if (!slot || !policy) {
        throw new Error(`Missing reference policy for slot "${automaton.slotId}"`);
      }
      const observation = template.buildObservation({
        state,
        automatonId: automaton.id,
        senses: automaton.senses,
        tick,
      });
      observations.set(automaton.id, observation);
      const legalActions = template.legalActions({
        state,
        automatonId: automaton.id,
        observation,
        tick,
      });
      const decision = evaluatePolicy(
        policy,
        observation,
        legalActions,
        tick,
        undefined,
        phase,
      );
      if (decision.kind === "abstain") {
        throw new Error(
          `Reference policy "${policy.slotId}" abstained at tick ${tick}: ${decision.trace}`,
        );
      }
      actions.set(automaton.id, decision.action);
      decisions.push({
        automatonId: automaton.id,
        slotId: automaton.slotId,
        ruleId: decision.ruleId,
        action: decision.action,
        trace: decision.trace,
      });
    }
    const applied = template.applyActions({
      state,
      actions,
      tick,
      tickSeed: `${input.seed}:${tick}`,
    });
    state = applied.state;
    metrics = template.metrics({ previousState, state, tick });
    input.onTick?.({
      tick,
      previousState,
      observations,
      decisions,
      state,
      delta: applied.delta,
    });
    if (applied.terminal) break;
  }
  return metrics;
}

/**
 * Runs one editable policy against a fixed opponent. Self-play game specs are
 * expanded only inside this test harness; their shipped one-slot shape remains
 * available to the tournament composer.
 */
export function runPolicyMatchup(input: {
  spec: SimulatorSpec;
  candidatePolicy: PolicyIR;
  opponentPolicy: PolicyIR;
  opponentLabel: string;
  ticks: number;
  seed: string;
}): Record<string, number> {
  if (
    input.spec.templateId !== "prisonersDilemma" &&
    input.spec.templateId !== "matrixGame"
  ) {
    throw new Error(
      `Opposition panels require a two-player game, not "${input.spec.templateId}"`,
    );
  }
  if (
    input.candidatePolicy.templateId !== input.spec.templateId ||
    input.opponentPolicy.templateId !== input.spec.templateId
  ) {
    throw new Error("Opposition panel policies must use the World's template");
  }
  const candidateSlot = input.spec.speciesSlots.find(
    (slot) => slot.slotId === input.candidatePolicy.slotId,
  );
  if (!candidateSlot) {
    throw new Error(
      `Candidate policy slot "${input.candidatePolicy.slotId}" is not in the World`,
    );
  }
  const matchupSpec: SimulatorSpec =
    input.spec.speciesSlots.length === 1
      ? {
          ...input.spec,
          speciesSlots: [
            {
              ...candidateSlot,
              countMin: 1,
              countMax: 1,
              defaultCount: 1,
            },
            {
              ...candidateSlot,
              slotId: input.opponentPolicy.slotId,
              label: input.opponentLabel,
              countMin: 1,
              countMax: 1,
              defaultCount: 1,
              starterHint: "",
            },
          ],
        }
      : input.spec;
  const opponentSlot = matchupSpec.speciesSlots.find(
    (slot) => slot.slotId === input.opponentPolicy.slotId,
  );
  if (!opponentSlot || opponentSlot.slotId === candidateSlot.slotId) {
    throw new Error(
      `Opponent policy slot "${input.opponentPolicy.slotId}" is not the opposing World slot`,
    );
  }
  return runPolicyDeck({
    spec: matchupSpec,
    policies: [input.candidatePolicy, input.opponentPolicy],
    ticks: input.ticks,
    seed: input.seed,
  });
}

// ── Ecosystem archetype policies ──────────────────────────────────────────
function selfCellResource(obs: EcosystemObservation) {
  for (const r of [obs.vision, obs.smell, obs.touch]) {
    for (const res of r?.resources ?? []) if (res.dx === 0 && res.dy === 0 && res.biomass > 0) return res;
  }
  return undefined;
}
function sensedResources(obs: EcosystemObservation) {
  const byKey = new Map<string, { dx: number; dy: number; distance: number; biomass: number }>();
  for (const r of [obs.vision, obs.smell, obs.touch]) for (const res of r?.resources ?? []) byKey.set(`${res.dx},${res.dy}`, res);
  return [...byKey.values()];
}
function nearestOf(obs: EcosystemObservation, slotId: string) {
  return [obs.vision, obs.smell, obs.touch].flatMap((r) => r?.automata ?? []).filter((a) => a.slotId === slotId).sort((a, b) => a.distance - b.distance)[0];
}
function nearestShelter(obs: EcosystemObservation) {
  return [obs.vision, obs.touch].flatMap((r) => r?.terrain ?? []).filter((t) => t.kind === "shelter").sort((a, b) => a.distance - b.distance)[0];
}
function stepToward(obs: EcosystemObservation, legal: readonly EcosystemAction[], dx: number, dy: number): EcosystemAction | undefined {
  const wants: Array<{ x: number; y: number }> = [];
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx !== 0) wants.push({ x: obs.self.x + Math.sign(dx), y: obs.self.y });
    if (dy !== 0) wants.push({ x: obs.self.x, y: obs.self.y + Math.sign(dy) });
  } else {
    if (dy !== 0) wants.push({ x: obs.self.x, y: obs.self.y + Math.sign(dy) });
    if (dx !== 0) wants.push({ x: obs.self.x + Math.sign(dx), y: obs.self.y });
  }
  for (const w of wants) {
    const m = legal.find((l) => l.kind === "move" && l.to.x === w.x && l.to.y === w.y);
    if (m) return m;
  }
  return undefined;
}
const graze = (obs: EcosystemObservation): EcosystemAction => ({ kind: "graze", at: { x: obs.self.x, y: obs.self.y } });

export const restAlways: EcoPolicyFactory = () => () => ({ kind: "rest" });

export function informedSeekFactory(): EcoPolicy {
  let dir = 0;
  return (obs, legal) => {
    if (selfCellResource(obs)) return graze(obs);
    const res = sensedResources(obs).sort((a, b) => b.biomass - a.biomass || a.distance - b.distance)[0];
    if (res) { const s = stepToward(obs, legal, res.dx, res.dy); if (s) return s; }
    const moves = legal.filter((l) => l.kind === "move");
    return moves.length ? moves[dir++ % moves.length] : { kind: "rest" };
  };
}
export function nearOnlyFactory(): EcoPolicy {
  let dir = 0;
  return (obs, legal) => {
    if (selfCellResource(obs)) return graze(obs);
    const res = sensedResources(obs).sort((a, b) => a.distance - b.distance)[0];
    if (res) { const s = stepToward(obs, legal, res.dx, res.dy); if (s) return s; }
    if (obs.self.energy > 7) return { kind: "rest" };
    const moves = legal.filter((l) => l.kind === "move");
    return moves.length ? moves[dir++ % moves.length] : { kind: "rest" };
  };
}
export function farCommitFactory(targetX: number, targetY: number): EcoPolicyFactory {
  return () => (obs, legal) => {
    if (selfCellResource(obs) && obs.self.x >= targetX - 1) return graze(obs);
    if (obs.self.x < targetX) { const s = stepToward(obs, legal, targetX - obs.self.x, targetY - obs.self.y); if (s) return s; }
    if (selfCellResource(obs)) return graze(obs);
    const res = sensedResources(obs).sort((a, b) => a.distance - b.distance)[0];
    if (res) { const s = stepToward(obs, legal, res.dx, res.dy); if (s) return s; }
    return { kind: "rest" };
  };
}
export function greedyGrazerFactory(): EcoPolicy {
  let dir = 0;
  return (obs, legal) => {
    if (selfCellResource(obs)) return graze(obs);
    const res = sensedResources(obs).sort((a, b) => a.distance - b.distance)[0];
    if (res) { const s = stepToward(obs, legal, res.dx, res.dy); if (s) return s; }
    const moves = legal.filter((l) => l.kind === "move");
    return moves.length ? moves[dir++ % moves.length] : { kind: "rest" };
  };
}
export function shelterCyclerFactory(): EcoPolicy {
  let dir = 0;
  return (obs, legal) => {
    const shark = nearestOf(obs, "shark");
    const inShelter = obs.self.terrain?.kind === "shelter";
    if (shark && shark.distance <= 3 && !inShelter) {
      const sh = nearestShelter(obs);
      if (sh) { const s = stepToward(obs, legal, sh.dx, sh.dy); if (s) return s; }
      const away = stepToward(obs, legal, -shark.dx, -shark.dy); if (away) return away;
    }
    if (shark && shark.distance <= 2 && inShelter) return { kind: "rest" };
    const here = selfCellResource(obs);
    if (here && here.biomass >= 4) return graze(obs);
    const res = sensedResources(obs).filter((r) => r.biomass >= 4).sort((a, b) => a.distance - b.distance)[0];
    if (res) { const s = stepToward(obs, legal, res.dx, res.dy); if (s) return s; }
    if (here && obs.self.energy < 6) return graze(obs);
    const moves = legal.filter((l) => l.kind === "move");
    return moves.length ? moves[dir++ % moves.length] : { kind: "rest" };
  };
}
export function openRationerFactory(): EcoPolicy {
  let dir = 0;
  return (obs, legal) => {
    const shark = nearestOf(obs, "shark");
    if (shark && shark.distance <= 2) { const s = stepToward(obs, legal, -shark.dx, -shark.dy); if (s) return s; }
    const here = selfCellResource(obs);
    if (here && here.biomass >= 4) return graze(obs);
    const res = sensedResources(obs).filter((r) => r.biomass >= 4).sort((a, b) => a.distance - b.distance)[0];
    if (res) { const s = stepToward(obs, legal, res.dx, res.dy); if (s) return s; }
    if (here && obs.self.energy < 6) return graze(obs);
    if (obs.self.energy > 9) return { kind: "rest" };
    const moves = legal.filter((l) => l.kind === "move");
    return moves.length ? moves[dir++ % moves.length] : { kind: "rest" };
  };
}
export function fleeBreedGrazerFactory(): EcoPolicy {
  let dir = 0;
  return (obs, legal) => {
    const shark = nearestOf(obs, "shark") ?? nearestOf(obs, "predator");
    if (shark && shark.distance <= 3) { const s = stepToward(obs, legal, -shark.dx, -shark.dy); if (s) return s; }
    if (legal.some((l) => l.kind === "reproduce")) return { kind: "reproduce" };
    if (selfCellResource(obs)) return graze(obs);
    const res = sensedResources(obs).sort((a, b) => a.distance - b.distance)[0];
    if (res) { const s = stepToward(obs, legal, res.dx, res.dy); if (s) return s; }
    const moves = legal.filter((l) => l.kind === "move");
    return moves.length ? moves[dir++ % moves.length] : { kind: "rest" };
  };
}
export function sharkFactory(): EcoPolicy {
  let dir = 0;
  return (obs, legal) => {
    const eat = legal.find((l) => l.kind === "eat");
    if (eat) return eat;
    const prey = [obs.vision, obs.smell, obs.touch].flatMap((r) => r?.automata ?? []).filter((a) => a.slotId !== obs.self.slotId).sort((a, b) => a.distance - b.distance)[0];
    if (prey) { const s = stepToward(obs, legal, prey.dx, prey.dy); if (s) return s; }
    const moves = legal.filter((l) => l.kind === "move");
    return moves.length ? moves[dir++ % moves.length] : { kind: "rest" };
  };
}

// ── Matrix (stag hunt) driver ─────────────────────────────────────────────
export type MGPolicy = (obs: MatrixGameObservation) => MatrixGameActionId;
export const STAG: MatrixGameActionId = "optionA";
export const HARE: MatrixGameActionId = "optionB";

function fnv(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 2 ** 32;
}

// The wavering teacher partner: a per-hunt "mood" (commitment), round-to-round
// wavering around it, and a drift to the safe hare as the hunt ends — and it does
// NOT react to the scholar, so its habit is readable from history.
export function waveringPartner(seed: string): MGPolicy {
  const mood = 0.3 + fnv(`mood:${seed}`) * 0.6;
  return (obs) => {
    if (obs.roundsRemaining <= 2) return HARE;
    return fnv(`${seed}:${obs.round}`) < mood ? STAG : HARE;
  };
}
export const blindStag: MGPolicy = () => STAG;
export const alwaysHare: MGPolicy = () => HARE;
// Read the partner's recent visible habit; commit only when he's been dependable.
export function readPartner(): MGPolicy {
  return (obs) => {
    const recent = obs.history.slice(-3);
    if (recent.length === 0) return STAG;
    const stags = recent.filter((h) => h.opponentAction === STAG).length;
    return stags * 2 >= recent.length ? STAG : HARE;
  };
}

export function runStagHunt(input: {
  config: MatrixGameConfig;
  scholar: MGPolicy;
  partner: (seed: string) => MGPolicy;
  seed: string;
}): number {
  const species = launched([
    { slotId: "hunter_ana", label: "Hunter Ana", count: 1, countMax: 1, senses: [{ senseId: "history" }] },
    { slotId: "hunter_ben", label: "Hunter Ben", count: 1, countMax: 1, senses: [{ senseId: "history" }] },
  ]);
  let state = createMatrixGameInitialState({ config: input.config, species, seed: input.seed });
  const partner = input.partner(input.seed);
  const anaId = state.players.find((p) => p.slotId === "hunter_ana")!.id;
  const benId = state.players.find((p) => p.slotId === "hunter_ben")!.id;
  for (let tick = 0; tick < input.config.rounds; tick += 1) {
    const anaObs = buildMatrixGameObservation({ state, automatonId: anaId, senses: [{ senseId: "history" }], tick });
    const benObs = buildMatrixGameObservation({ state, automatonId: benId, senses: [{ senseId: "history" }], tick });
    const actions = new Map<string, MatrixGameAction>([
      [anaId, { kind: input.scholar(anaObs) }],
      [benId, { kind: partner(benObs) }],
    ]);
    state = applyMatrixGameActions({ state, actions, tick, tickSeed: `${input.seed}:${tick}` }).state;
  }
  return state.players.find((p) => p.slotId === "hunter_ana")!.totalScore;
}

export const DECISION_SPACE_SEEDS = Array.from({ length: 12 }, (_, i) => `seed-${i}`);
