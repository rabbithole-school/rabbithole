import {
  MAX_AUTOMATA_PER_RUN,
  MAX_PROMPT_CHARS,
  MAX_SPECIES_SLOTS,
  RENDERER_PROTOCOL_VERSION,
  SIMULATOR_PROTOCOL_VERSION,
  type LaunchedSpecies,
  type PublicGoodsConfig,
  type SensePackage,
  type WorldActionSchema,
  type SimulatorSceneEntityV1,
  type SimulatorSceneV1,
  type SimulatorSpec,
  type SimulatorTemplate,
} from "../contract";

export const PUBLIC_GOODS_TEMPLATE_VERSION = 1 as const;
export const PUBLIC_GOODS_SENSE_IDS = ["history"] as const;
export const PUBLIC_GOODS_ACTION_KINDS = ["withhold", "contribute"] as const;

export type PublicGoodsActionKind = (typeof PUBLIC_GOODS_ACTION_KINDS)[number];
export type PublicGoodsAction = { kind: PublicGoodsActionKind };

export const PUBLIC_GOODS_ACTION_SCHEMA: WorldActionSchema = {
  variants: [
    {
      kind: "withhold",
      description: "Keep this round's endowment out of the public pool.",
      fields: [],
    },
    {
      kind: "contribute",
      description: "Contribute this round's entire endowment to the public pool.",
      fields: [],
    },
  ],
};

export interface PublicGoodsPlayer {
  id: string;
  slotId: string;
  label: string;
  senses: SensePackage;
  totalScore: number;
  contributions: number;
}

export interface PublicGoodsReading {
  automatonId: string;
  perceivedContributorCount: number;
  actualContributorCount: number;
  misperceived: boolean;
}

export interface PublicGoodsRound {
  round: number;
  actions: readonly {
    automatonId: string;
    action: PublicGoodsActionKind;
  }[];
  contributorCount: number;
  pool: number;
  sharePerPlayer: number;
  payoffs: readonly {
    automatonId: string;
    value: number;
  }[];
  readings: readonly PublicGoodsReading[];
}

export interface PublicGoodsState {
  config: PublicGoodsConfig;
  seed: string;
  players: readonly PublicGoodsPlayer[];
  rounds: readonly PublicGoodsRound[];
  totalInvalidActions: number;
}

export interface PublicGoodsObservation {
  self: {
    id: string;
    slotId: string;
    label: string;
    totalScore: number;
  };
  round: number;
  roundsRemaining: number;
  players: number;
  endowmentPerRound: number;
  multiplier: number;
  history: readonly {
    round: number;
    contributorCount: number;
    myAction: PublicGoodsActionKind;
    myPayoff: number;
    cumulativeScore: number;
  }[];
}

export interface PublicGoodsDelta extends PublicGoodsRound {
  invalidAutomatonIds: readonly string[];
}

export type PublicGoodsMetrics = {
  groupWelfare: number;
  minScore: number;
  maxScore: number;
  contributionRate: number;
  poolLastRound: number;
  roundsPlayed: number;
  invalidActions: number;
};

function fail(message: string): never {
  throw new Error(`publicGoods: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} carries unknown field "${key}"`);
  }
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be finite`);
  return value;
}

function integer(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field);
  if (!Number.isInteger(parsed)) fail(`${field} must be an integer`);
  return parsed;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function actionKind(value: unknown, field: string): PublicGoodsActionKind {
  if (value !== "contribute" && value !== "withhold") {
    fail(`${field} must be contribute or withhold`);
  }
  return value;
}

function validateSenses(senses: SensePackage, field: string) {
  if (senses.length !== 1 || senses[0].senseId !== "history") {
    fail(`${field} must contain exactly the history Sense`);
  }
  if (senses[0].range !== undefined || senses[0].channels !== undefined) {
    fail(`${field}.history does not accept range or channels`);
  }
}

export function validatePublicGoodsConfig(value: unknown): PublicGoodsConfig {
  if (!isRecord(value)) fail("config must be an object");
  onlyKeys(
    value,
    ["rounds", "endowmentPerRound", "multiplier", "noiseProbability", "maxAutomata"],
    "config",
  );
  const rounds = integer(value.rounds, "config.rounds");
  if (rounds < 1 || rounds > 200) fail("config.rounds must be from 1 through 200");
  const endowmentPerRound = finiteNumber(value.endowmentPerRound, "config.endowmentPerRound");
  if (endowmentPerRound < 1 || endowmentPerRound > 100) {
    fail("config.endowmentPerRound must be from 1 through 100");
  }
  const multiplier = finiteNumber(value.multiplier, "config.multiplier");
  if (multiplier <= 1) fail("config.multiplier must be greater than 1");
  const noiseProbability = finiteNumber(value.noiseProbability, "config.noiseProbability");
  if (noiseProbability < 0 || noiseProbability > 1) {
    fail("config.noiseProbability must be between 0 and 1");
  }
  const maxAutomata = integer(value.maxAutomata, "config.maxAutomata");
  if (maxAutomata < 3 || maxAutomata > MAX_AUTOMATA_PER_RUN) {
    fail(`config.maxAutomata must be from 3 through ${MAX_AUTOMATA_PER_RUN}`);
  }
  return {
    rounds,
    endowmentPerRound,
    multiplier,
    noiseProbability,
    maxAutomata,
  };
}

function validatePopulation(
  slots: readonly {
    slotId: string;
    label: string;
    countMin: number;
    countMax: number;
    count: number;
    senses: SensePackage;
  }[],
  config: PublicGoodsConfig,
  field: string,
) {
  if (slots.length < 1 || slots.length > MAX_SPECIES_SLOTS) {
    fail(`${field} must contain from 1 through ${MAX_SPECIES_SLOTS} slots`);
  }
  const ids = new Set<string>();
  let total = 0;
  for (const [index, slot] of slots.entries()) {
    const slotField = `${field}[${index}]`;
    nonEmptyString(slot.slotId, `${slotField}.slotId`);
    nonEmptyString(slot.label, `${slotField}.label`);
    if (ids.has(slot.slotId)) fail(`${field} repeats slotId "${slot.slotId}"`);
    ids.add(slot.slotId);
    if (
      !Number.isInteger(slot.countMin) ||
      !Number.isInteger(slot.countMax) ||
      !Number.isInteger(slot.count) ||
      slot.countMin < 0 ||
      slot.countMax < slot.countMin ||
      slot.count < slot.countMin ||
      slot.count > slot.countMax
    ) {
      fail(`${slotField} has an invalid count range`);
    }
    validateSenses(slot.senses, `${slotField}.senses`);
    total += slot.count;
  }
  if (total < 3 || total > config.maxAutomata || total > MAX_AUTOMATA_PER_RUN) {
    fail(`the population must contain from 3 through ${config.maxAutomata} Automata`);
  }
  if (config.multiplier >= total) {
    fail("config.multiplier must be less than the launched player count");
  }
  return total;
}

export function validatePublicGoodsSpec(spec: SimulatorSpec): void {
  if (spec.version !== SIMULATOR_PROTOCOL_VERSION) fail(`unsupported SimulatorSpec version ${spec.version}`);
  if (spec.templateId !== "publicGoods") fail(`cannot validate template "${spec.templateId}"`);
  if (spec.templateVersion !== PUBLIC_GOODS_TEMPLATE_VERSION) {
    fail(`unsupported template version ${spec.templateVersion}`);
  }
  const config = validatePublicGoodsConfig(spec.config);
  validatePopulation(
    spec.speciesSlots.map((slot) => ({
      ...slot,
      count: slot.defaultCount,
    })),
    config,
    "speciesSlots",
  );
  if (spec.criterion.kind !== "measured") {
    fail("criterion must be measured");
  }
  const criterionKeys = ["groupWelfare", "minScore", "contributionRate"];
  if (!criterionKeys.includes(spec.criterion.metricKey)) {
    fail(`criterion has unknown group metric "${spec.criterion.metricKey}"`);
  }
  const { iterationTicks, seasonTicks, absoluteMaxTicks } = spec.tickBudget;
  if (
    !Number.isInteger(iterationTicks) ||
    !Number.isInteger(seasonTicks) ||
    !Number.isInteger(absoluteMaxTicks) ||
    iterationTicks < 1 ||
    seasonTicks < iterationTicks ||
    absoluteMaxTicks < seasonTicks ||
    absoluteMaxTicks > config.rounds
  ) {
    fail("tickBudget must be positive, ordered, and no longer than config.rounds");
  }
}

function validateLaunchedSpecies(
  species: readonly LaunchedSpecies[],
  config: PublicGoodsConfig,
) {
  for (const [index, slot] of species.entries()) {
    if (slot.prompt.length > MAX_PROMPT_CHARS) {
      fail(`species[${index}].prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
  }
  return validatePopulation(
    species.map((slot) => ({
      ...slot,
      countMin: 0,
      count: slot.count,
    })),
    config,
    "species",
  );
}

function deterministicUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 2 ** 32;
}

function perceivedCount(input: {
  actual: number;
  players: number;
  probability: number;
  seed: string;
}): { count: number; misperceived: boolean } {
  const misperceived = deterministicUnit(`${input.seed}:noise`) < input.probability;
  if (!misperceived) return { count: input.actual, misperceived: false };
  const offset =
    input.actual === 0
      ? 1
      : input.actual === input.players
        ? -1
        : deterministicUnit(`${input.seed}:direction`) < 0.5
          ? -1
          : 1;
  return { count: input.actual + offset, misperceived: true };
}

export function createPublicGoodsInitialState(input: {
  config: PublicGoodsConfig;
  species: readonly LaunchedSpecies[];
  seed: string;
}): PublicGoodsState {
  const config = validatePublicGoodsConfig(input.config);
  validateLaunchedSpecies(input.species, config);
  const players: PublicGoodsPlayer[] = [];
  for (const species of input.species) {
    for (let index = 0; index < species.count; index += 1) {
      players.push({
        id: `${species.slotId}:${index + 1}`,
        slotId: species.slotId,
        label: species.label,
        senses: species.senses.map((sense) => ({ ...sense })),
        totalScore: 0,
        contributions: 0,
      });
    }
  }
  players.sort((left, right) => left.id.localeCompare(right.id));
  return {
    config: { ...config },
    seed: input.seed,
    players,
    rounds: [],
    totalInvalidActions: 0,
  };
}

export function buildPublicGoodsObservation(input: {
  state: Readonly<PublicGoodsState>;
  automatonId: string;
  senses: SensePackage;
  tick: number;
}): PublicGoodsObservation {
  validateSenses(input.senses, `senses for ${input.automatonId}`);
  const player = input.state.players.find((candidate) => candidate.id === input.automatonId);
  if (!player) fail(`unknown Automaton "${input.automatonId}"`);
  let cumulativeScore = 0;
  const history = input.state.rounds.map((round) => {
    const ownAction = round.actions.find((entry) => entry.automatonId === player.id)!;
    const ownPayoff = round.payoffs.find((entry) => entry.automatonId === player.id)!;
    const reading = round.readings.find((entry) => entry.automatonId === player.id)!;
    cumulativeScore += ownPayoff.value;
    return {
      round: round.round,
      contributorCount: reading.perceivedContributorCount,
      myAction: ownAction.action,
      myPayoff: ownPayoff.value,
      cumulativeScore,
    };
  });
  return {
    self: {
      id: player.id,
      slotId: player.slotId,
      label: player.label,
      totalScore: player.totalScore,
    },
    round: input.tick + 1,
    roundsRemaining: Math.max(0, input.state.config.rounds - input.tick),
    players: input.state.players.length,
    endowmentPerRound: input.state.config.endowmentPerRound,
    multiplier: input.state.config.multiplier,
    history,
  };
}

export function validatePublicGoodsAction(value: unknown): PublicGoodsAction {
  if (!isRecord(value)) fail("action must be an object");
  onlyKeys(value, ["kind"], "action");
  return { kind: actionKind(value.kind, "action.kind") };
}

export function applyPublicGoodsActions(input: {
  state: Readonly<PublicGoodsState>;
  actions: ReadonlyMap<string, PublicGoodsAction>;
  tick: number;
  tickSeed: string;
}): {
  state: PublicGoodsState;
  delta: PublicGoodsDelta;
  terminal: boolean;
  phase: string;
} {
  if (input.tick !== input.state.rounds.length) fail("ticks must advance one round at a time");
  const actions = input.state.players.map((player) => ({
    automatonId: player.id,
    action: input.actions.get(player.id)?.kind ?? "withhold",
  }));
  const contributorCount = actions.filter((entry) => entry.action === "contribute").length;
  const pool =
    contributorCount *
    input.state.config.endowmentPerRound *
    input.state.config.multiplier;
  const sharePerPlayer = pool / input.state.players.length;
  const payoffs = actions.map((entry) => ({
    automatonId: entry.automatonId,
    value:
      (entry.action === "withhold" ? input.state.config.endowmentPerRound : 0) +
      sharePerPlayer,
  }));
  const readings = input.state.players.map((player) => {
    const perceived = perceivedCount({
      actual: contributorCount,
      players: input.state.players.length,
      probability: input.state.config.noiseProbability,
      seed: `${input.tickSeed}:${player.id}:contributors`,
    });
    return {
      automatonId: player.id,
      perceivedContributorCount: perceived.count,
      actualContributorCount: contributorCount,
      misperceived: perceived.misperceived,
    };
  });
  const players = input.state.players.map((player) => {
    const selected = actions.find((entry) => entry.automatonId === player.id)!;
    const payoff = payoffs.find((entry) => entry.automatonId === player.id)!;
    return {
      ...player,
      senses: player.senses.map((sense) => ({ ...sense })),
      totalScore: player.totalScore + payoff.value,
      contributions: player.contributions + (selected.action === "contribute" ? 1 : 0),
    };
  });
  const round: PublicGoodsRound = {
    round: input.tick + 1,
    actions,
    contributorCount,
    pool,
    sharePerPlayer,
    payoffs,
    readings,
  };
  const state: PublicGoodsState = {
    config: { ...input.state.config },
    seed: input.state.seed,
    players,
    rounds: [...input.state.rounds, round],
    totalInvalidActions: input.state.totalInvalidActions,
  };
  return {
    state,
    delta: { ...round, invalidAutomatonIds: [] },
    terminal: state.rounds.length >= state.config.rounds,
    phase: `round ${input.tick + 1}`,
  };
}

export function publicGoodsMetrics(input: {
  previousState: Readonly<PublicGoodsState>;
  state: Readonly<PublicGoodsState>;
  tick: number;
}): PublicGoodsMetrics {
  const scores = input.state.players.map((player) => player.totalScore);
  const roundsPlayed = input.state.rounds.length;
  const contributions = input.state.players.reduce(
    (total, player) => total + player.contributions,
    0,
  );
  return {
    groupWelfare: scores.reduce((total, score) => total + score, 0),
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
    contributionRate:
      roundsPlayed === 0 ? 0 : contributions / (roundsPlayed * input.state.players.length),
    poolLastRound: input.state.rounds.at(-1)?.pool ?? 0,
    roundsPlayed,
    invalidActions: input.state.totalInvalidActions,
  };
}

function roundedCoordinate(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/** Standard math convention: 0 faces +x, angle increases counter-clockwise. */
function villagerAngle(index: number, players: number): number {
  return (index / players) * Math.PI * 2 - Math.PI / 2;
}

function actionTokenColor(action: PublicGoodsActionKind): string {
  return action === "contribute" ? "#15803D" : "#C2410C";
}

function actionTokenLabel(action: PublicGoodsActionKind): string {
  return action === "contribute" ? "Contribute" : "Withhold";
}

export function renderPublicGoodsScene(input: {
  state: Readonly<PublicGoodsState>;
  tick: number;
}): SimulatorSceneV1 {
  const center = 10;
  const radius = 8;
  const latest = input.state.rounds.at(-1);
  const maxPool =
    input.state.players.length *
    input.state.config.endowmentPerRound *
    input.state.config.multiplier;
  const poolNormalized = maxPool === 0 ? 0 : Math.min(1, (latest?.pool ?? 0) / maxPool);
  // Villagers face the pool while contributing this round and face away
  // while withholding (action-dependent, derived fresh each round); a
  // villager who has not yet acted this run faces the pool by default. See
  // contract.ts's "round aliveness conventions" for the heading convention.
  const automata: SimulatorSceneEntityV1[] = input.state.players.map((player, index) => {
    const angle = villagerAngle(index, input.state.players.length);
    const selected = latest?.actions.find((entry) => entry.automatonId === player.id)?.action;
    return {
      id: player.id,
      kind: "automaton",
      x: roundedCoordinate(center + radius * Math.cos(angle)),
      y: roundedCoordinate(center + radius * Math.sin(angle)),
      layer: 2,
      label: player.label,
      color:
        selected === "contribute" ? "#15803D" : selected === "withhold" ? "#C2410C" : "#64748B",
      size: 0.8,
      heading: roundedCoordinate(selected === "withhold" ? angle : angle + Math.PI),
      energy: player.totalScore,
    };
  });
  // One token entity per villager showing this round's coin choice, placed
  // just outside its villager (away from the pool), absent before the first
  // round resolves. Every round always records an action for every player
  // (an unaccepted action falls back to "withhold"), so this lookup never
  // misses once `latest` exists. See contract.ts for the convention.
  const tokenRadius = radius + 1.3;
  const tokens: SimulatorSceneEntityV1[] = latest
    ? input.state.players.map((player, index) => {
        const angle = villagerAngle(index, input.state.players.length);
        const action = latest.actions.find((entry) => entry.automatonId === player.id)!.action;
        return {
          id: `token:${player.id}`,
          kind: `token:${action}`,
          x: roundedCoordinate(center + tokenRadius * Math.cos(angle)),
          y: roundedCoordinate(center + tokenRadius * Math.sin(angle)),
          layer: 3,
          label: actionTokenLabel(action),
          color: actionTokenColor(action),
          size: 0.3,
        };
      })
    : [];
  // The pool itself, promoted to a first-class scene entity (rather than
  // only the background-terrain cell it used to be alone) so a renderer can
  // draw it as a distinct, animatable object; `size` tracks the normalized
  // round pool. The `public-pool` cell below is retained unchanged so a
  // renderer can additionally draw an intensity-mapped glow underneath it --
  // entity plus cell together are the "cluster". No `energy`: that field's
  // established meaning here is an Automaton's cumulative score, and the
  // pool is not an Automaton.
  const pool: SimulatorSceneEntityV1 = {
    id: "pool",
    kind: "pool",
    x: center,
    y: center,
    layer: 1,
    label: "Pool",
    color: "#0369A1",
    size: 0.6 + poolNormalized * 1.4,
  };
  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    templateId: "publicGoods",
    tick: input.tick,
    viewport: { width: 21, height: 21, boundary: "bounded" },
    entities: [pool, ...automata, ...tokens],
    cells: [
      {
        x: center,
        y: center,
        kind: "public-pool",
        intensity: poolNormalized,
      },
    ],
  };
}

function validatePlayer(value: unknown, field: string): PublicGoodsPlayer {
  if (!isRecord(value) || !Array.isArray(value.senses)) fail(`${field} must be a player`);
  const senses = value.senses.map((sense, index) => {
    if (!isRecord(sense)) fail(`${field}.senses[${index}] must be an object`);
    onlyKeys(sense, ["senseId"], `${field}.senses[${index}]`);
    return { senseId: nonEmptyString(sense.senseId, `${field}.senses[${index}].senseId`) };
  });
  validateSenses(senses, `${field}.senses`);
  return {
    id: nonEmptyString(value.id, `${field}.id`),
    slotId: nonEmptyString(value.slotId, `${field}.slotId`),
    label: nonEmptyString(value.label, `${field}.label`),
    senses,
    totalScore: finiteNumber(value.totalScore, `${field}.totalScore`),
    contributions: integer(value.contributions, `${field}.contributions`),
  };
}

function validateRound(value: unknown, field: string): PublicGoodsRound {
  if (
    !isRecord(value) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.payoffs) ||
    !Array.isArray(value.readings)
  ) {
    fail(`${field} must be a round`);
  }
  const actions = value.actions.map((entry, index) => {
    if (!isRecord(entry)) fail(`${field}.actions[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.actions[${index}].automatonId`),
      action: actionKind(entry.action, `${field}.actions[${index}].action`),
    };
  });
  const payoffs = value.payoffs.map((entry, index) => {
    if (!isRecord(entry)) fail(`${field}.payoffs[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.payoffs[${index}].automatonId`),
      value: finiteNumber(entry.value, `${field}.payoffs[${index}].value`),
    };
  });
  const readings = value.readings.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.misperceived !== "boolean") {
      fail(`${field}.readings[${index}] must be an object`);
    }
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.readings[${index}].automatonId`),
      perceivedContributorCount: integer(
        entry.perceivedContributorCount,
        `${field}.readings[${index}].perceivedContributorCount`,
      ),
      actualContributorCount: integer(
        entry.actualContributorCount,
        `${field}.readings[${index}].actualContributorCount`,
      ),
      misperceived: entry.misperceived,
    };
  });
  return {
    round: integer(value.round, `${field}.round`),
    actions,
    contributorCount: integer(value.contributorCount, `${field}.contributorCount`),
    pool: finiteNumber(value.pool, `${field}.pool`),
    sharePerPlayer: finiteNumber(value.sharePerPlayer, `${field}.sharePerPlayer`),
    payoffs,
    readings,
  };
}

function sameIds(entries: readonly { automatonId: string }[], playerIds: readonly string[]) {
  return (
    entries.length === playerIds.length &&
    new Set(entries.map((entry) => entry.automatonId)).size === playerIds.length &&
    entries.every((entry) => playerIds.includes(entry.automatonId))
  );
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9;
}

function validateRoundTruth(
  round: PublicGoodsRound,
  players: readonly PublicGoodsPlayer[],
  config: PublicGoodsConfig,
  expectedRound: number,
  field: string,
) {
  const playerIds = players.map((player) => player.id);
  if (round.round !== expectedRound) fail(`${field}.round is out of sequence`);
  if (
    !sameIds(round.actions, playerIds) ||
    !sameIds(round.payoffs, playerIds) ||
    !sameIds(round.readings, playerIds)
  ) {
    fail(`${field} must carry exactly one action, payoff, and reading per player`);
  }
  const contributorCount = round.actions.filter(
    (entry) => entry.action === "contribute",
  ).length;
  const pool = contributorCount * config.endowmentPerRound * config.multiplier;
  const sharePerPlayer = pool / players.length;
  if (
    round.contributorCount !== contributorCount ||
    !nearlyEqual(round.pool, pool) ||
    !nearlyEqual(round.sharePerPlayer, sharePerPlayer)
  ) {
    fail(`${field} pool totals do not match its actions`);
  }
  for (const action of round.actions) {
    const payoff = round.payoffs.find(
      (entry) => entry.automatonId === action.automatonId,
    )!;
    const expectedPayoff =
      (action.action === "withhold" ? config.endowmentPerRound : 0) +
      sharePerPlayer;
    if (!nearlyEqual(payoff.value, expectedPayoff)) {
      fail(`${field} payoff for "${action.automatonId}" does not match the pool`);
    }
  }
  for (const reading of round.readings) {
    const expectedDistance = reading.misperceived ? 1 : 0;
    if (
      reading.actualContributorCount !== contributorCount ||
      reading.perceivedContributorCount < 0 ||
      reading.perceivedContributorCount > players.length ||
      Math.abs(reading.perceivedContributorCount - contributorCount) !==
        expectedDistance
    ) {
      fail(`${field} contributor reading for "${reading.automatonId}" is inconsistent`);
    }
  }
}

export function validatePublicGoodsState(value: unknown): PublicGoodsState {
  if (!isRecord(value) || !Array.isArray(value.players) || !Array.isArray(value.rounds)) {
    fail("state must be an object with players and rounds");
  }
  const config = validatePublicGoodsConfig(value.config);
  const players = value.players.map((player, index) =>
    validatePlayer(player, `state.players[${index}]`),
  );
  if (new Set(players.map((player) => player.id)).size !== players.length) {
    fail("state repeats a player id");
  }
  if (
    players.length < 3 ||
    players.length > config.maxAutomata ||
    config.multiplier >= players.length
  ) {
    fail("state player count is outside the configured population bounds");
  }
  const rounds = value.rounds.map((round, index) => {
    const parsed = validateRound(round, `state.rounds[${index}]`);
    validateRoundTruth(parsed, players, config, index + 1, `state.rounds[${index}]`);
    return parsed;
  });
  return {
    config,
    seed: nonEmptyString(value.seed, "state.seed"),
    players,
    rounds,
    totalInvalidActions: integer(value.totalInvalidActions, "state.totalInvalidActions"),
  };
}

export function validatePublicGoodsDelta(value: unknown): PublicGoodsDelta {
  const round = validateRound(value, "delta");
  if (!isRecord(value) || !Array.isArray(value.invalidAutomatonIds)) {
    fail("delta.invalidAutomatonIds must be an array");
  }
  return {
    ...round,
    invalidAutomatonIds: value.invalidAutomatonIds.map((entry, index) =>
      nonEmptyString(entry, `delta.invalidAutomatonIds[${index}]`),
    ),
  };
}

export const PUBLIC_GOODS: SimulatorTemplate<
  PublicGoodsConfig,
  PublicGoodsState,
  PublicGoodsObservation,
  PublicGoodsAction,
  PublicGoodsDelta,
  PublicGoodsMetrics
> = {
  id: "publicGoods",
  version: PUBLIC_GOODS_TEMPLATE_VERSION,
  rendererProtocolVersion: RENDERER_PROTOCOL_VERSION,
  cacheablePrefixMeasuredTokens: 0,
  senseIds: PUBLIC_GOODS_SENSE_IDS,
  actionKinds: PUBLIC_GOODS_ACTION_KINDS,
  actionSchema: PUBLIC_GOODS_ACTION_SCHEMA,
  metricKeys: [
    "groupWelfare",
    "minScore",
    "maxScore",
    "contributionRate",
    "poolLastRound",
    "roundsPlayed",
    "invalidActions",
  ],
  summaryMetricKeys: [
    "groupWelfare",
    "minScore",
    "maxScore",
    "contributionRate",
    "poolLastRound",
  ],
  validateConfig: validatePublicGoodsConfig,
  validateState: validatePublicGoodsState,
  validateAction: validatePublicGoodsAction,
  validateDelta: validatePublicGoodsDelta,
  validateSpec: validatePublicGoodsSpec,
  initialState: createPublicGoodsInitialState,
  buildObservation: buildPublicGoodsObservation,
  legalActions: () => [{ kind: "withhold" }, { kind: "contribute" }],
  listAutomata: (state) =>
    state.players.map((player) => ({
      id: player.id,
      slotId: player.slotId,
      senses: player.senses,
    })),
  tickPhase: ({ tick }) => `round ${tick + 1}`,
  applyActions: applyPublicGoodsActions,
  metrics: publicGoodsMetrics,
  withInvalidActions: ({ state, count }) => ({
    ...state,
    totalInvalidActions: state.totalInvalidActions + count,
  }),
  withInvalidActionDelta: ({ delta, automatonIds }) => ({
    ...delta,
    invalidAutomatonIds: [...delta.invalidAutomatonIds, ...automatonIds].sort(),
  }),
  renderScene: renderPublicGoodsScene,
};
