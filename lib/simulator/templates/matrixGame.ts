import {
  MAX_PROMPT_CHARS,
  MAX_SPECIES_SLOTS,
  RENDERER_PROTOCOL_VERSION,
  SIMULATOR_PROTOCOL_VERSION,
  type LaunchedSpecies,
  type MatrixGameActionId,
  type MatrixGameConfig,
  type SensePackage,
  type WorldActionSchema,
  type SimulatorSceneEntityV1,
  type SimulatorSceneV1,
  type SimulatorSpec,
  type SimulatorTemplate,
} from "../contract";

export const MATRIX_GAME_TEMPLATE_VERSION = 1 as const;
export const MATRIX_GAME_SENSE_IDS = ["history"] as const;
export const MATRIX_GAME_ACTION_KINDS = ["optionA", "optionB"] as const;

export type MatrixGameAction = { kind: MatrixGameActionId };

export const MATRIX_GAME_ACTION_SCHEMA: WorldActionSchema = {
  variants: [
    {
      kind: "optionA",
      description: "Choose the first authored action this round.",
      fields: [],
    },
    {
      kind: "optionB",
      description: "Choose the second authored action this round.",
      fields: [],
    },
  ],
};

export interface MatrixGamePlayer {
  id: string;
  slotId: string;
  label: string;
  senses: SensePackage;
  totalScore: number;
  optionACount: number;
}

export interface MatrixGameReading {
  automatonId: string;
  sawOpponentAction: MatrixGameActionId;
  actualOpponentAction: MatrixGameActionId;
  misperceived: boolean;
}

export interface MatrixGameRound {
  round: number;
  actions: readonly [
    { automatonId: string; actionId: MatrixGameActionId },
    { automatonId: string; actionId: MatrixGameActionId },
  ];
  payoffs: readonly [
    { automatonId: string; value: number },
    { automatonId: string; value: number },
  ];
  readings: readonly [MatrixGameReading, MatrixGameReading];
}

export interface MatrixGameState {
  config: MatrixGameConfig;
  seed: string;
  players: readonly [MatrixGamePlayer, MatrixGamePlayer];
  rounds: readonly MatrixGameRound[];
  totalInvalidActions: number;
}

export interface MatrixGameObservation {
  self: {
    id: string;
    slotId: string;
    label: string;
    role: "row" | "column";
    totalScore: number;
  };
  actions: readonly [
    { actionId: MatrixGameActionId; label: string },
    { actionId: MatrixGameActionId; label: string },
  ];
  round: number;
  roundsRemaining: number;
  history: readonly {
    round: number;
    myAction: MatrixGameActionId;
    myActionLabel: string;
    opponentAction: MatrixGameActionId;
    opponentActionLabel: string;
    myPayoff: number;
    cumulativeScore: number;
  }[];
}

export interface MatrixGameDelta extends MatrixGameRound {
  invalidAutomatonIds: readonly string[];
}

export type MatrixGameMetrics = {
  "deckA.totalScore": number;
  "deckB.totalScore": number;
  jointScore: number;
  "deckA.optionARate": number;
  "deckB.optionARate": number;
  roundsPlayed: number;
};

function fail(message: string): never {
  throw new Error(`matrixGame: ${message}`);
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

function boundedPayoff(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field);
  if (Math.abs(parsed) > 1_000) fail(`${field} must be between -1000 and 1000`);
  return parsed;
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

function actionId(value: unknown, field: string): MatrixGameActionId {
  if (value !== "optionA" && value !== "optionB") fail(`${field} must be optionA or optionB`);
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

function validateActions(value: unknown): MatrixGameConfig["actions"] {
  if (!Array.isArray(value) || value.length !== 2) {
    fail("config.actions must contain exactly two actions");
  }
  const parsed = value.map((raw, index) => {
    if (!isRecord(raw)) fail(`config.actions[${index}] must be an object`);
    onlyKeys(raw, ["actionId", "label"], `config.actions[${index}]`);
    return {
      actionId: actionId(raw.actionId, `config.actions[${index}].actionId`),
      label: nonEmptyString(raw.label, `config.actions[${index}].label`),
    };
  });
  if (new Set(parsed.map((entry) => entry.actionId)).size !== 2) {
    fail("config.actions must declare optionA and optionB exactly once");
  }
  return [parsed[0], parsed[1]];
}

function validatePayoffs(value: unknown): MatrixGameConfig["payoffs"] {
  if (!isRecord(value)) fail("config.payoffs must be an object");
  onlyKeys(value, MATRIX_GAME_ACTION_KINDS, "config.payoffs");
  const result = {} as MatrixGameConfig["payoffs"];
  for (const rowAction of MATRIX_GAME_ACTION_KINDS) {
    const row = value[rowAction];
    if (!isRecord(row)) fail(`config.payoffs.${rowAction} must be an object`);
    onlyKeys(row, MATRIX_GAME_ACTION_KINDS, `config.payoffs.${rowAction}`);
    result[rowAction] = {} as MatrixGameConfig["payoffs"][MatrixGameActionId];
    for (const colAction of MATRIX_GAME_ACTION_KINDS) {
      const cell = row[colAction];
      if (!isRecord(cell)) {
        fail(`config.payoffs.${rowAction}.${colAction} must be an object`);
      }
      onlyKeys(cell, ["a", "b"], `config.payoffs.${rowAction}.${colAction}`);
      result[rowAction][colAction] = {
        a: boundedPayoff(cell.a, `config.payoffs.${rowAction}.${colAction}.a`),
        b: boundedPayoff(cell.b, `config.payoffs.${rowAction}.${colAction}.b`),
      };
    }
  }
  return result;
}

export function validateMatrixGameConfig(value: unknown): MatrixGameConfig {
  if (!isRecord(value)) fail("config must be an object");
  onlyKeys(value, ["rounds", "noiseProbability", "actions", "payoffs", "maxAutomata"], "config");
  const rounds = integer(value.rounds, "config.rounds");
  if (rounds < 1 || rounds > 500) fail("config.rounds must be from 1 through 500");
  const noiseProbability = finiteNumber(value.noiseProbability, "config.noiseProbability");
  if (noiseProbability < 0 || noiseProbability > 1) {
    fail("config.noiseProbability must be between 0 and 1");
  }
  if (value.maxAutomata !== 2) fail("config.maxAutomata must be exactly 2");
  return {
    rounds,
    noiseProbability,
    actions: validateActions(value.actions),
    payoffs: validatePayoffs(value.payoffs),
    maxAutomata: 2,
  };
}

function validateTickBudget(spec: Extract<SimulatorSpec, { templateId: "matrixGame" }>, rounds: number) {
  const { iterationTicks, seasonTicks, absoluteMaxTicks } = spec.tickBudget;
  if (
    !Number.isInteger(iterationTicks) ||
    !Number.isInteger(seasonTicks) ||
    !Number.isInteger(absoluteMaxTicks) ||
    iterationTicks < 1 ||
    seasonTicks < iterationTicks ||
    absoluteMaxTicks < seasonTicks ||
    absoluteMaxTicks > rounds
  ) {
    fail("tickBudget must be positive, ordered, and no longer than config.rounds");
  }
}

export function validateMatrixGameSpec(spec: SimulatorSpec): void {
  if (spec.version !== SIMULATOR_PROTOCOL_VERSION) fail(`unsupported SimulatorSpec version ${spec.version}`);
  if (spec.templateId !== "matrixGame") fail(`cannot validate template "${spec.templateId}"`);
  if (spec.templateVersion !== MATRIX_GAME_TEMPLATE_VERSION) {
    fail(`unsupported template version ${spec.templateVersion}`);
  }
  const config = validateMatrixGameConfig(spec.config);
  if (spec.speciesSlots.length < 1 || spec.speciesSlots.length > 2) {
    fail("speciesSlots must contain one self-play strategy or two matched strategies");
  }
  if (spec.speciesSlots.length > MAX_SPECIES_SLOTS) fail("too many Species slots");
  const slotIds = new Set<string>();
  let total = 0;
  for (const [index, slot] of spec.speciesSlots.entries()) {
    const field = `speciesSlots[${index}]`;
    nonEmptyString(slot.slotId, `${field}.slotId`);
    nonEmptyString(slot.label, `${field}.label`);
    if (slotIds.has(slot.slotId)) fail(`speciesSlots repeats slotId "${slot.slotId}"`);
    slotIds.add(slot.slotId);
    if (
      !Number.isInteger(slot.countMin) ||
      !Number.isInteger(slot.countMax) ||
      !Number.isInteger(slot.defaultCount) ||
      slot.countMin < 1 ||
      slot.countMax < slot.countMin ||
      slot.defaultCount < slot.countMin ||
      slot.defaultCount > slot.countMax
    ) {
      fail(`${field} has an invalid count range`);
    }
    validateSenses(slot.senses, `${field}.senses`);
    total += slot.defaultCount;
  }
  if (total !== config.maxAutomata) fail("the default prompt deck must launch exactly 2 Automata");
  if (spec.criterion.kind === "adversarial") {
    const expected = ["deckA.totalScore", "deckB.totalScore"];
    if (
      [...spec.criterion.scoreMetricKeys].sort().join("\0") !==
      expected.sort().join("\0")
    ) {
      fail("adversarial criterion must score deckA.totalScore and deckB.totalScore");
    }
  } else if (spec.criterion.kind !== "measured" || spec.criterion.metricKey !== "jointScore") {
    fail("criterion must be adversarial or measure jointScore");
  }
  validateTickBudget(spec, config.rounds);
}

function validateLaunchedSpecies(species: readonly LaunchedSpecies[]) {
  if (species.length < 1 || species.length > 2) fail("launch requires one or two strategy slots");
  const ids = new Set<string>();
  let total = 0;
  for (const [index, slot] of species.entries()) {
    if (ids.has(slot.slotId)) fail(`launch repeats slotId "${slot.slotId}"`);
    ids.add(slot.slotId);
    nonEmptyString(slot.slotId, `species[${index}].slotId`);
    nonEmptyString(slot.label, `species[${index}].label`);
    if (!Number.isInteger(slot.count) || slot.count < 1 || slot.count > slot.countMax) {
      fail(`species[${index}].count is outside its slot range`);
    }
    if (slot.prompt.length > MAX_PROMPT_CHARS) {
      fail(`species[${index}].prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    validateSenses(slot.senses, `species[${index}].senses`);
    total += slot.count;
  }
  if (total !== 2) fail("a match must launch exactly 2 Automata");
}

function deterministicUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 2 ** 32;
}

function flipped(value: MatrixGameActionId): MatrixGameActionId {
  return value === "optionA" ? "optionB" : "optionA";
}

function cloneConfig(config: MatrixGameConfig): MatrixGameConfig {
  return {
    ...config,
    actions: [{ ...config.actions[0] }, { ...config.actions[1] }],
    payoffs: {
      optionA: {
        optionA: { ...config.payoffs.optionA.optionA },
        optionB: { ...config.payoffs.optionA.optionB },
      },
      optionB: {
        optionA: { ...config.payoffs.optionB.optionA },
        optionB: { ...config.payoffs.optionB.optionB },
      },
    },
  };
}

export function createMatrixGameInitialState(input: {
  config: MatrixGameConfig;
  species: readonly LaunchedSpecies[];
  seed: string;
}): MatrixGameState {
  const config = validateMatrixGameConfig(input.config);
  validateLaunchedSpecies(input.species);
  const players: MatrixGamePlayer[] = [];
  for (const species of input.species) {
    for (let index = 0; index < species.count; index += 1) {
      players.push({
        id: `${species.slotId}:${index + 1}`,
        slotId: species.slotId,
        label: species.label,
        senses: species.senses.map((sense) => ({ ...sense })),
        totalScore: 0,
        optionACount: 0,
      });
    }
  }
  players.sort((left, right) => left.id.localeCompare(right.id));
  return {
    config,
    seed: input.seed,
    players: [players[0], players[1]],
    rounds: [],
    totalInvalidActions: 0,
  };
}

function labelFor(config: MatrixGameConfig, id: MatrixGameActionId): string {
  return config.actions.find((action) => action.actionId === id)!.label;
}

export function buildMatrixGameObservation(input: {
  state: Readonly<MatrixGameState>;
  automatonId: string;
  senses: SensePackage;
  tick: number;
}): MatrixGameObservation {
  validateSenses(input.senses, `senses for ${input.automatonId}`);
  const player = input.state.players.find((candidate) => candidate.id === input.automatonId);
  if (!player) fail(`unknown Automaton "${input.automatonId}"`);
  const playerIndex = input.state.players.findIndex(
    (candidate) => candidate.id === input.automatonId,
  );
  let cumulativeScore = 0;
  const history = input.state.rounds.map((round) => {
    const ownAction = round.actions.find((entry) => entry.automatonId === player.id)!;
    const ownPayoff = round.payoffs.find((entry) => entry.automatonId === player.id)!;
    const reading = round.readings.find((entry) => entry.automatonId === player.id)!;
    cumulativeScore += ownPayoff.value;
    return {
      round: round.round,
      myAction: ownAction.actionId,
      myActionLabel: labelFor(input.state.config, ownAction.actionId),
      opponentAction: reading.sawOpponentAction,
      opponentActionLabel: labelFor(input.state.config, reading.sawOpponentAction),
      myPayoff: ownPayoff.value,
      cumulativeScore,
    };
  });
  return {
    self: {
      id: player.id,
      slotId: player.slotId,
      label: player.label,
      role: playerIndex === 0 ? "row" : "column",
      totalScore: player.totalScore,
    },
    actions: [{ ...input.state.config.actions[0] }, { ...input.state.config.actions[1] }],
    round: input.tick + 1,
    roundsRemaining: Math.max(0, input.state.config.rounds - input.tick),
    history,
  };
}

export function validateMatrixGameAction(value: unknown): MatrixGameAction {
  if (!isRecord(value)) fail("action must be an object");
  onlyKeys(value, ["kind"], "action");
  return { kind: actionId(value.kind, "action.kind") };
}

export function applyMatrixGameActions(input: {
  state: Readonly<MatrixGameState>;
  actions: ReadonlyMap<string, MatrixGameAction>;
  tick: number;
  tickSeed: string;
}): {
  state: MatrixGameState;
  delta: MatrixGameDelta;
  terminal: boolean;
  phase: string;
} {
  if (input.tick !== input.state.rounds.length) fail("ticks must advance one round at a time");
  const [first, second] = input.state.players;
  const firstAction = input.actions.get(first.id)?.kind ?? "optionA";
  const secondAction = input.actions.get(second.id)?.kind ?? "optionA";
  const cell = input.state.config.payoffs[firstAction][secondAction];
  const actions: MatrixGameRound["actions"] = [
    { automatonId: first.id, actionId: firstAction },
    { automatonId: second.id, actionId: secondAction },
  ];
  const payoffs: MatrixGameRound["payoffs"] = [
    { automatonId: first.id, value: cell.a },
    { automatonId: second.id, value: cell.b },
  ];
  const readings = [first, second].map((player, index) => {
    const actualOpponentAction = index === 0 ? secondAction : firstAction;
    const misperceived =
      deterministicUnit(`${input.tickSeed}:${player.id}:opponent-action`) <
      input.state.config.noiseProbability;
    return {
      automatonId: player.id,
      sawOpponentAction: misperceived ? flipped(actualOpponentAction) : actualOpponentAction,
      actualOpponentAction,
      misperceived,
    };
  }) as [MatrixGameReading, MatrixGameReading];
  const mappedPlayers = input.state.players.map((player, index) => {
    const selected = index === 0 ? firstAction : secondAction;
    return {
      ...player,
      senses: player.senses.map((sense) => ({ ...sense })),
      totalScore: player.totalScore + (index === 0 ? cell.a : cell.b),
      optionACount: player.optionACount + (selected === "optionA" ? 1 : 0),
    };
  });
  const players: [MatrixGamePlayer, MatrixGamePlayer] = [mappedPlayers[0], mappedPlayers[1]];
  const round: MatrixGameRound = {
    round: input.tick + 1,
    actions,
    payoffs,
    readings,
  };
  const state: MatrixGameState = {
    config: cloneConfig(input.state.config),
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

export function matrixGameMetrics(input: {
  previousState: Readonly<MatrixGameState>;
  state: Readonly<MatrixGameState>;
  tick: number;
}): MatrixGameMetrics {
  const played = input.state.rounds.length;
  const [first, second] = input.state.players;
  return {
    "deckA.totalScore": first.totalScore,
    "deckB.totalScore": second.totalScore,
    jointScore: first.totalScore + second.totalScore,
    "deckA.optionARate": played === 0 ? 0 : first.optionACount / played,
    "deckB.optionARate": played === 0 ? 0 : second.optionACount / played,
    roundsPlayed: played,
  };
}

function actionTokenColor(actionId: MatrixGameActionId): string {
  return actionId === "optionA" ? "#15803D" : "#C2410C";
}

export function renderMatrixGameScene(input: {
  state: Readonly<MatrixGameState>;
  tick: number;
}): SimulatorSceneV1 {
  const latest = input.state.rounds.at(-1);
  // Automata always face each other -- structural, not action-dependent. See
  // contract.ts's "round aliveness conventions" for the heading convention.
  const automata: SimulatorSceneEntityV1[] = input.state.players.map((player, index) => {
    const selected = latest?.actions.find((action) => action.automatonId === player.id)?.actionId;
    return {
      id: player.id,
      kind: "automaton",
      x: index === 0 ? 0 : 2,
      y: 0,
      layer: 2,
      label: player.label,
      color: selected === "optionA" ? "#15803D" : selected === "optionB" ? "#C2410C" : "#64748B",
      size: 0.9,
      heading: index === 0 ? 0 : Math.PI,
      energy: player.totalScore,
    };
  });
  // One token entity per Automaton showing this round's action, absent
  // before the first round resolves. Every round always records an action
  // for both players (an unaccepted action falls back to "optionA"), so this
  // lookup never misses once `latest` exists. See contract.ts for the
  // convention; the label is the AUTHORED action label, never the actionId.
  const tokens: SimulatorSceneEntityV1[] = latest
    ? input.state.players.map((player, index) => {
        const actionId = latest.actions.find((action) => action.automatonId === player.id)!.actionId;
        return {
          id: `token:${player.id}`,
          kind: `token:${actionId}`,
          x: index === 0 ? 0.4 : 1.6,
          y: 0,
          layer: 3,
          label: labelFor(input.state.config, actionId),
          color: actionTokenColor(actionId),
          size: 0.35,
        };
      })
    : [];
  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    templateId: "matrixGame",
    tick: input.tick,
    viewport: { width: 3, height: 1, boundary: "bounded" },
    entities: [...automata, ...tokens],
    cells: latest
      ? [
          {
            x: 1,
            y: 0,
            kind: `${latest.actions[0].actionId}-${latest.actions[1].actionId}`,
            intensity: 1,
          },
        ]
      : [],
  };
}

function validatePlayer(value: unknown, field: string): MatrixGamePlayer {
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
    optionACount: integer(value.optionACount, `${field}.optionACount`),
  };
}

function validateRound(value: unknown, field: string): MatrixGameRound {
  if (
    !isRecord(value) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.payoffs) ||
    !Array.isArray(value.readings) ||
    value.actions.length !== 2 ||
    value.payoffs.length !== 2 ||
    value.readings.length !== 2
  ) {
    fail(`${field} must carry one round for two players`);
  }
  const actions = value.actions.map((entry, index) => {
    if (!isRecord(entry)) fail(`${field}.actions[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.actions[${index}].automatonId`),
      actionId: actionId(entry.actionId, `${field}.actions[${index}].actionId`),
    };
  }) as [MatrixGameRound["actions"][number], MatrixGameRound["actions"][number]];
  const payoffs = value.payoffs.map((entry, index) => {
    if (!isRecord(entry)) fail(`${field}.payoffs[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.payoffs[${index}].automatonId`),
      value: finiteNumber(entry.value, `${field}.payoffs[${index}].value`),
    };
  }) as [MatrixGameRound["payoffs"][number], MatrixGameRound["payoffs"][number]];
  const readings = value.readings.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.misperceived !== "boolean") {
      fail(`${field}.readings[${index}] must be an object`);
    }
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.readings[${index}].automatonId`),
      sawOpponentAction: actionId(
        entry.sawOpponentAction,
        `${field}.readings[${index}].sawOpponentAction`,
      ),
      actualOpponentAction: actionId(
        entry.actualOpponentAction,
        `${field}.readings[${index}].actualOpponentAction`,
      ),
      misperceived: entry.misperceived,
    };
  }) as [MatrixGameReading, MatrixGameReading];
  return {
    round: integer(value.round, `${field}.round`),
    actions,
    payoffs,
    readings,
  };
}

export function validateMatrixGameState(value: unknown): MatrixGameState {
  if (!isRecord(value) || !Array.isArray(value.players) || !Array.isArray(value.rounds)) {
    fail("state must be an object with players and rounds");
  }
  if (value.players.length !== 2) fail("state must have exactly 2 players");
  const players = value.players.map((player, index) =>
    validatePlayer(player, `state.players[${index}]`),
  ) as [MatrixGamePlayer, MatrixGamePlayer];
  if (new Set(players.map((player) => player.id)).size !== players.length) {
    fail("state repeats a player id");
  }
  const rounds = value.rounds.map((round, index) => validateRound(round, `state.rounds[${index}]`));
  return {
    config: validateMatrixGameConfig(value.config),
    seed: nonEmptyString(value.seed, "state.seed"),
    players,
    rounds,
    totalInvalidActions: integer(value.totalInvalidActions, "state.totalInvalidActions"),
  };
}

export function validateMatrixGameDelta(value: unknown): MatrixGameDelta {
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

export const MATRIX_GAME: SimulatorTemplate<
  MatrixGameConfig,
  MatrixGameState,
  MatrixGameObservation,
  MatrixGameAction,
  MatrixGameDelta,
  MatrixGameMetrics
> = {
  id: "matrixGame",
  version: MATRIX_GAME_TEMPLATE_VERSION,
  rendererProtocolVersion: RENDERER_PROTOCOL_VERSION,
  cacheablePrefixMeasuredTokens: 0,
  senseIds: MATRIX_GAME_SENSE_IDS,
  actionKinds: MATRIX_GAME_ACTION_KINDS,
  actionSchema: MATRIX_GAME_ACTION_SCHEMA,
  metricKeys: [
    "deckA.totalScore",
    "deckB.totalScore",
    "jointScore",
    "deckA.optionARate",
    "deckB.optionARate",
    "roundsPlayed",
  ],
  summaryMetricKeys: [
    "deckA.totalScore",
    "deckB.totalScore",
    "jointScore",
    "deckA.optionARate",
    "deckB.optionARate",
  ],
  validateConfig: validateMatrixGameConfig,
  validateState: validateMatrixGameState,
  validateAction: validateMatrixGameAction,
  validateDelta: validateMatrixGameDelta,
  validateSpec: validateMatrixGameSpec,
  initialState: createMatrixGameInitialState,
  buildObservation: buildMatrixGameObservation,
  legalActions: () => [{ kind: "optionA" }, { kind: "optionB" }],
  listAutomata: (state) =>
    state.players.map((player) => ({
      id: player.id,
      slotId: player.slotId,
      senses: player.senses,
    })),
  tickPhase: ({ tick }) => `round ${tick + 1}`,
  applyActions: applyMatrixGameActions,
  metrics: matrixGameMetrics,
  withInvalidActions: ({ state, count }) => ({
    ...state,
    totalInvalidActions: state.totalInvalidActions + count,
  }),
  withInvalidActionDelta: ({ delta, automatonIds }) => ({
    ...delta,
    invalidAutomatonIds: [...delta.invalidAutomatonIds, ...automatonIds].sort(),
  }),
  renderScene: renderMatrixGameScene,
};
