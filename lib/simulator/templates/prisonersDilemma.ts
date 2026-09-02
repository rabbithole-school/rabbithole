import {
  MAX_PROMPT_CHARS,
  MAX_SPECIES_SLOTS,
  RENDERER_PROTOCOL_VERSION,
  SIMULATOR_PROTOCOL_VERSION,
  type LaunchedSpecies,
  type PrisonersDilemmaConfig,
  type PrisonersDilemmaPayoffMatrix,
  type SensePackage,
  type WorldActionSchema,
  type SimulatorSceneEntityV1,
  type SimulatorSceneV1,
  type SimulatorSpec,
  type SimulatorTemplate,
} from "../contract";

export const PRISONERS_DILEMMA_TEMPLATE_VERSION = 1 as const;
export const DEFAULT_PRISONERS_DILEMMA_ROUNDS = 50;
export const PRISONERS_DILEMMA_SENSE_IDS = ["history"] as const;
export const PRISONERS_DILEMMA_ACTION_KINDS = ["cooperate", "defect"] as const;

export type PrisonersDilemmaMove = (typeof PRISONERS_DILEMMA_ACTION_KINDS)[number];
export type PrisonersDilemmaAction = { kind: PrisonersDilemmaMove };

export const PRISONERS_DILEMMA_ACTION_SCHEMA: WorldActionSchema = {
  variants: [
    {
      kind: "cooperate",
      description: "Cooperate with the other Automaton this round.",
      fields: [],
    },
    {
      kind: "defect",
      description: "Defect against the other Automaton this round.",
      fields: [],
    },
  ],
};

export interface PrisonersDilemmaPlayer {
  id: string;
  slotId: string;
  label: string;
  senses: SensePackage;
  totalScore: number;
  cooperations: number;
  forgivenessEvents: number;
}

export interface PrisonersDilemmaReading {
  automatonId: string;
  sawOpponentMove: PrisonersDilemmaMove;
  actualOpponentMove: PrisonersDilemmaMove;
  misperceived: boolean;
}

export interface PrisonersDilemmaRound {
  round: number;
  moves: readonly [
    { automatonId: string; move: PrisonersDilemmaMove },
    { automatonId: string; move: PrisonersDilemmaMove },
  ];
  payoffs: readonly [
    { automatonId: string; value: number },
    { automatonId: string; value: number },
  ];
  readings: readonly [PrisonersDilemmaReading, PrisonersDilemmaReading];
}

type NormalizedPrisonersDilemmaConfig = Omit<PrisonersDilemmaConfig, "rounds"> & {
  rounds: number;
};

export interface PrisonersDilemmaState {
  config: NormalizedPrisonersDilemmaConfig;
  seed: string;
  players: readonly [PrisonersDilemmaPlayer, PrisonersDilemmaPlayer];
  rounds: readonly PrisonersDilemmaRound[];
  totalInvalidActions: number;
}

export interface PrisonersDilemmaObservation {
  self: {
    id: string;
    slotId: string;
    label: string;
    totalScore: number;
  };
  round: number;
  roundsRemaining: number;
  history: readonly {
    round: number;
    myMove: PrisonersDilemmaMove;
    opponentMove: PrisonersDilemmaMove;
    myPayoff: number;
    cumulativeScore: number;
  }[];
}

export interface PrisonersDilemmaDelta {
  round: number;
  moves: PrisonersDilemmaRound["moves"];
  payoffs: PrisonersDilemmaRound["payoffs"];
  /**
   * Human-facing forensic truth. This never enters the next model observation:
   * the Automaton receives only `sawOpponentMove`, while replay can honestly say
   * "saw defect (actually cooperate)".
   */
  readings: PrisonersDilemmaRound["readings"];
  forgivenessAutomatonIds: readonly string[];
}

export type PrisonersDilemmaMetrics = {
  "deckA.totalScore": number;
  "deckB.totalScore": number;
  "deckA.cooperationRate": number;
  "deckB.cooperationRate": number;
  "deckA.cooperations": number;
  "deckB.cooperations": number;
  "deckA.forgivenessEvents": number;
  "deckB.forgivenessEvents": number;
  roundsPlayed: number;
};

function fail(message: string): never {
  throw new Error(`prisonersDilemma: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} carries unknown field "${key}"`);
  }
}

function move(value: unknown, field: string): PrisonersDilemmaMove {
  if (value !== "cooperate" && value !== "defect") fail(`${field} must be cooperate or defect`);
  return value;
}

function payoffMatrix(value: unknown): PrisonersDilemmaPayoffMatrix {
  if (!isRecord(value)) fail("config.payoffMatrix must be an object");
  onlyKeys(
    value,
    ["mutualCooperation", "temptation", "sucker", "mutualDefection"],
    "config.payoffMatrix",
  );
  const matrix = {
    mutualCooperation: finiteNumber(
      value.mutualCooperation,
      "config.payoffMatrix.mutualCooperation",
    ),
    temptation: finiteNumber(value.temptation, "config.payoffMatrix.temptation"),
    sucker: finiteNumber(value.sucker, "config.payoffMatrix.sucker"),
    mutualDefection: finiteNumber(value.mutualDefection, "config.payoffMatrix.mutualDefection"),
  };
  if (
    !(
      matrix.temptation > matrix.mutualCooperation &&
      matrix.mutualCooperation > matrix.mutualDefection &&
      matrix.mutualDefection > matrix.sucker
    )
  ) {
    fail("payoffs must satisfy temptation > mutual cooperation > mutual defection > sucker");
  }
  if (2 * matrix.mutualCooperation <= matrix.temptation + matrix.sucker) {
    fail("mutual cooperation must beat alternating exploitation over two rounds");
  }
  return matrix;
}

export function validatePrisonersDilemmaConfig(
  value: unknown,
): NormalizedPrisonersDilemmaConfig {
  if (!isRecord(value)) fail("config must be an object");
  onlyKeys(value, ["rounds", "noiseProbability", "payoffMatrix", "maxAutomata"], "config");
  const rounds =
    value.rounds === undefined
      ? DEFAULT_PRISONERS_DILEMMA_ROUNDS
      : integer(value.rounds, "config.rounds");
  if (rounds < 1 || rounds > 500) fail("config.rounds must be from 1 through 500");
  const noiseProbability = finiteNumber(value.noiseProbability, "config.noiseProbability");
  if (noiseProbability < 0 || noiseProbability > 1) {
    fail("config.noiseProbability must be between 0 and 1");
  }
  if (value.maxAutomata !== 2) fail("config.maxAutomata must be exactly 2");
  return {
    rounds,
    noiseProbability,
    payoffMatrix: payoffMatrix(value.payoffMatrix),
    maxAutomata: 2,
  };
}

function validateSenses(senses: SensePackage, field: string) {
  if (senses.length !== 1 || senses[0].senseId !== "history") {
    fail(`${field} must contain exactly the history Sense`);
  }
  const sense = senses[0];
  if (sense.range !== undefined || sense.channels !== undefined) {
    fail(`${field}.history does not accept range or channels`);
  }
}

export function validatePrisonersDilemmaSpec(spec: SimulatorSpec): void {
  if (spec.version !== SIMULATOR_PROTOCOL_VERSION) fail(`unsupported SimulatorSpec version ${spec.version}`);
  if (spec.templateId !== "prisonersDilemma") fail(`cannot validate template "${spec.templateId}"`);
  if (spec.templateVersion !== PRISONERS_DILEMMA_TEMPLATE_VERSION) {
    fail(`unsupported template version ${spec.templateVersion}`);
  }
  const config = validatePrisonersDilemmaConfig(spec.config);
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
  if (spec.criterion.kind !== "adversarial") {
    fail("criterion must be adversarial");
  }
  const expectedScoreKeys = ["deckA.totalScore", "deckB.totalScore"];
  if (
    [...spec.criterion.scoreMetricKeys].sort().join("\0") !==
    expectedScoreKeys.sort().join("\0")
  ) {
    fail("criterion must score deckA.totalScore and deckB.totalScore");
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

function flipped(value: PrisonersDilemmaMove): PrisonersDilemmaMove {
  return value === "cooperate" ? "defect" : "cooperate";
}

export function createPrisonersDilemmaInitialState(input: {
  config: PrisonersDilemmaConfig;
  species: readonly LaunchedSpecies[];
  seed: string;
}): PrisonersDilemmaState {
  const config = validatePrisonersDilemmaConfig(input.config);
  validateLaunchedSpecies(input.species);
  const players: PrisonersDilemmaPlayer[] = [];
  for (const species of input.species) {
    for (let index = 0; index < species.count; index += 1) {
      players.push({
        id: `${species.slotId}:${index + 1}`,
        slotId: species.slotId,
        label: species.label,
        senses: species.senses.map((sense) => ({ ...sense })),
        totalScore: 0,
        cooperations: 0,
        forgivenessEvents: 0,
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

export function buildPrisonersDilemmaObservation(input: {
  state: Readonly<PrisonersDilemmaState>;
  automatonId: string;
  senses: SensePackage;
  tick: number;
}): PrisonersDilemmaObservation {
  validateSenses(input.senses, `senses for ${input.automatonId}`);
  const player = input.state.players.find((candidate) => candidate.id === input.automatonId);
  if (!player) fail(`unknown Automaton "${input.automatonId}"`);
  let cumulativeScore = 0;
  const history = input.state.rounds.map((round) => {
    const ownMove = round.moves.find((entry) => entry.automatonId === player.id)!;
    const ownPayoff = round.payoffs.find((entry) => entry.automatonId === player.id)!;
    const reading = round.readings.find((entry) => entry.automatonId === player.id)!;
    cumulativeScore += ownPayoff.value;
    return {
      round: round.round,
      myMove: ownMove.move,
      opponentMove: reading.sawOpponentMove,
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
    history,
  };
}

export function validatePrisonersDilemmaAction(value: unknown): PrisonersDilemmaAction {
  if (!isRecord(value)) fail("action must be an object");
  onlyKeys(value, ["kind"], "action");
  return { kind: move(value.kind, "action.kind") };
}

function score(
  own: PrisonersDilemmaMove,
  opponent: PrisonersDilemmaMove,
  matrix: PrisonersDilemmaPayoffMatrix,
) {
  if (own === "cooperate" && opponent === "cooperate") return matrix.mutualCooperation;
  if (own === "defect" && opponent === "cooperate") return matrix.temptation;
  if (own === "cooperate" && opponent === "defect") return matrix.sucker;
  return matrix.mutualDefection;
}

export function applyPrisonersDilemmaActions(input: {
  state: Readonly<PrisonersDilemmaState>;
  actions: ReadonlyMap<string, PrisonersDilemmaAction>;
  tick: number;
  tickSeed: string;
}): {
  state: PrisonersDilemmaState;
  delta: PrisonersDilemmaDelta;
  terminal: boolean;
  phase: string;
} {
  if (input.tick !== input.state.rounds.length) fail("ticks must advance one round at a time");
  const [first, second] = input.state.players;
  const firstMove = input.actions.get(first.id)?.kind ?? "cooperate";
  const secondMove = input.actions.get(second.id)?.kind ?? "cooperate";
  const firstValue = score(firstMove, secondMove, input.state.config.payoffMatrix);
  const secondValue = score(secondMove, firstMove, input.state.config.payoffMatrix);
  const moves: PrisonersDilemmaRound["moves"] = [
    { automatonId: first.id, move: firstMove },
    { automatonId: second.id, move: secondMove },
  ];
  const payoffs: PrisonersDilemmaRound["payoffs"] = [
    { automatonId: first.id, value: firstValue },
    { automatonId: second.id, value: secondValue },
  ];
  const readings = [first, second].map((player, index) => {
    const actualOpponentMove = index === 0 ? secondMove : firstMove;
    const misperceived =
      deterministicUnit(`${input.tickSeed}:${player.id}:opponent-move`) <
      input.state.config.noiseProbability;
    return {
      automatonId: player.id,
      sawOpponentMove: misperceived ? flipped(actualOpponentMove) : actualOpponentMove,
      actualOpponentMove,
      misperceived,
    };
  }) as [PrisonersDilemmaReading, PrisonersDilemmaReading];
  const previousReadings = input.state.rounds.at(-1)?.readings;
  const forgivenessAutomatonIds = [first, second]
    .filter((player, index) => {
      const action = index === 0 ? firstMove : secondMove;
      const previousReading = previousReadings?.find((reading) => reading.automatonId === player.id);
      return action === "cooperate" && previousReading?.sawOpponentMove === "defect";
    })
    .map((player) => player.id);
  const mappedPlayers = input.state.players.map((player, index) => ({
    ...player,
    senses: player.senses.map((sense) => ({ ...sense })),
    totalScore: player.totalScore + (index === 0 ? firstValue : secondValue),
    cooperations:
      player.cooperations +
      ((index === 0 ? firstMove : secondMove) === "cooperate" ? 1 : 0),
    forgivenessEvents:
      player.forgivenessEvents + (forgivenessAutomatonIds.includes(player.id) ? 1 : 0),
  }));
  const players: [PrisonersDilemmaPlayer, PrisonersDilemmaPlayer] = [
    mappedPlayers[0],
    mappedPlayers[1],
  ];
  const round: PrisonersDilemmaRound = {
    round: input.tick + 1,
    moves,
    payoffs,
    readings,
  };
  const state: PrisonersDilemmaState = {
    config: {
      ...input.state.config,
      payoffMatrix: { ...input.state.config.payoffMatrix },
    },
    seed: input.state.seed,
    players,
    rounds: [...input.state.rounds, round],
    totalInvalidActions: input.state.totalInvalidActions,
  };
  return {
    state,
    delta: { ...round, forgivenessAutomatonIds },
    terminal: state.rounds.length >= state.config.rounds,
    phase: `round ${input.tick + 1}`,
  };
}

export function prisonersDilemmaMetrics(input: {
  previousState: Readonly<PrisonersDilemmaState>;
  state: Readonly<PrisonersDilemmaState>;
  tick: number;
}): PrisonersDilemmaMetrics {
  const played = input.state.rounds.length;
  const [first, second] = input.state.players;
  return {
    "deckA.totalScore": first.totalScore,
    "deckB.totalScore": second.totalScore,
    "deckA.cooperationRate": played === 0 ? 0 : first.cooperations / played,
    "deckB.cooperationRate": played === 0 ? 0 : second.cooperations / played,
    "deckA.cooperations": first.cooperations,
    "deckB.cooperations": second.cooperations,
    "deckA.forgivenessEvents": first.forgivenessEvents,
    "deckB.forgivenessEvents": second.forgivenessEvents,
    roundsPlayed: played,
  };
}

function moveTokenLabel(move: PrisonersDilemmaMove): string {
  return move === "cooperate" ? "Cooperate" : "Defect";
}

function moveTokenColor(move: PrisonersDilemmaMove): string {
  return move === "cooperate" ? "#15803D" : "#B91C1C";
}

export function renderPrisonersDilemmaScene(input: {
  state: Readonly<PrisonersDilemmaState>;
  tick: number;
}): SimulatorSceneV1 {
  const latest = input.state.rounds.at(-1);
  // Automata always face each other -- structural, not action-dependent. See
  // contract.ts's "round aliveness conventions" for the heading convention.
  const automata: SimulatorSceneEntityV1[] = input.state.players.map((player, index) => ({
    id: player.id,
    kind: "automaton",
    x: index === 0 ? 0 : 2,
    y: 0,
    layer: 2,
    label: player.label,
    color: index === 0 ? "#7C3AED" : "#0E7490",
    size: 0.9,
    heading: index === 0 ? 0 : Math.PI,
    energy: player.totalScore,
  }));
  // One token entity per Automaton showing this round's move, absent before
  // the first round resolves. Every round always records a move for both
  // players (an unaccepted action falls back to "cooperate"), so this lookup
  // never misses once `latest` exists. See contract.ts for the convention.
  const tokens: SimulatorSceneEntityV1[] = latest
    ? input.state.players.map((player, index) => {
        const move = latest.moves.find((entry) => entry.automatonId === player.id)!.move;
        return {
          id: `token:${player.id}`,
          kind: `token:${move}`,
          x: index === 0 ? 0.4 : 1.6,
          y: 0,
          layer: 3,
          label: moveTokenLabel(move),
          color: moveTokenColor(move),
          size: 0.35,
        };
      })
    : [];
  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    templateId: "prisonersDilemma",
    tick: input.tick,
    viewport: { width: 3, height: 1, boundary: "bounded" },
    entities: [...automata, ...tokens],
    cells: latest
      ? [
          {
            x: 1,
            y: 0,
            kind:
              latest.moves[0].move === "cooperate" && latest.moves[1].move === "cooperate"
                ? "mutual-cooperation"
                : latest.moves[0].move === "defect" && latest.moves[1].move === "defect"
                  ? "mutual-defection"
                  : "mixed",
            intensity: 1,
          },
        ]
      : [],
  };
}

function validatePlayer(raw: unknown, field: string): PrisonersDilemmaPlayer {
  if (!isRecord(raw) || !Array.isArray(raw.senses)) fail(`${field} must be a player`);
  const senses = raw.senses.map((sense) => {
    if (!isRecord(sense)) fail(`${field}.senses must contain objects`);
    return { senseId: nonEmptyString(sense.senseId, `${field}.senses.senseId`) };
  });
  validateSenses(senses, `${field}.senses`);
  return {
    id: nonEmptyString(raw.id, `${field}.id`),
    slotId: nonEmptyString(raw.slotId, `${field}.slotId`),
    label: nonEmptyString(raw.label, `${field}.label`),
    senses,
    totalScore: finiteNumber(raw.totalScore, `${field}.totalScore`),
    cooperations: integer(raw.cooperations, `${field}.cooperations`),
    forgivenessEvents: integer(raw.forgivenessEvents, `${field}.forgivenessEvents`),
  };
}

function validateRound(raw: unknown, field: string): PrisonersDilemmaRound {
  if (!isRecord(raw) || !Array.isArray(raw.moves) || !Array.isArray(raw.payoffs) || !Array.isArray(raw.readings)) {
    fail(`${field} must be a round`);
  }
  if (raw.moves.length !== 2 || raw.payoffs.length !== 2 || raw.readings.length !== 2) {
    fail(`${field} must carry two players`);
  }
  const moves = raw.moves.map((entry, index) => {
    if (!isRecord(entry)) fail(`${field}.moves[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.moves[${index}].automatonId`),
      move: move(entry.move, `${field}.moves[${index}].move`),
    };
  }) as [PrisonersDilemmaRound["moves"][number], PrisonersDilemmaRound["moves"][number]];
  const payoffs = raw.payoffs.map((entry, index) => {
    if (!isRecord(entry)) fail(`${field}.payoffs[${index}] must be an object`);
    return {
      automatonId: nonEmptyString(entry.automatonId, `${field}.payoffs[${index}].automatonId`),
      value: finiteNumber(entry.value, `${field}.payoffs[${index}].value`),
    };
  }) as [PrisonersDilemmaRound["payoffs"][number], PrisonersDilemmaRound["payoffs"][number]];
  const readings = raw.readings.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.misperceived !== "boolean") {
      fail(`${field}.readings[${index}] must be an object`);
    }
    return {
      automatonId: nonEmptyString(
        entry.automatonId,
        `${field}.readings[${index}].automatonId`,
      ),
      sawOpponentMove: move(
        entry.sawOpponentMove,
        `${field}.readings[${index}].sawOpponentMove`,
      ),
      actualOpponentMove: move(
        entry.actualOpponentMove,
        `${field}.readings[${index}].actualOpponentMove`,
      ),
      misperceived: entry.misperceived,
    };
  }) as [PrisonersDilemmaReading, PrisonersDilemmaReading];
  return { round: integer(raw.round, `${field}.round`), moves, payoffs, readings };
}

export function validatePrisonersDilemmaState(value: unknown): PrisonersDilemmaState {
  if (!isRecord(value) || !Array.isArray(value.players) || !Array.isArray(value.rounds)) {
    fail("state must be an object with players and rounds");
  }
  if (value.players.length !== 2) fail("state must have exactly 2 players");
  const players = value.players.map((player, index) =>
    validatePlayer(player, `state.players[${index}]`),
  ) as [PrisonersDilemmaPlayer, PrisonersDilemmaPlayer];
  if (new Set(players.map((player) => player.id)).size !== 2) fail("state repeats a player id");
  const rounds = value.rounds.map((round, index) =>
    validateRound(round, `state.rounds[${index}]`),
  );
  return {
    config: validatePrisonersDilemmaConfig(value.config),
    seed: nonEmptyString(value.seed, "state.seed"),
    players,
    rounds,
    totalInvalidActions: integer(value.totalInvalidActions, "state.totalInvalidActions"),
  };
}

export function validatePrisonersDilemmaDelta(value: unknown): PrisonersDilemmaDelta {
  const round = validateRound(value, "delta");
  if (!isRecord(value) || !Array.isArray(value.forgivenessAutomatonIds)) {
    fail("delta.forgivenessAutomatonIds must be an array");
  }
  return {
    ...round,
    forgivenessAutomatonIds: value.forgivenessAutomatonIds.map((entry, index) =>
      nonEmptyString(entry, `delta.forgivenessAutomatonIds[${index}]`),
    ),
  };
}

export const PRISONERS_DILEMMA: SimulatorTemplate<
  PrisonersDilemmaConfig,
  PrisonersDilemmaState,
  PrisonersDilemmaObservation,
  PrisonersDilemmaAction,
  PrisonersDilemmaDelta,
  PrisonersDilemmaMetrics
> = {
  id: "prisonersDilemma",
  version: PRISONERS_DILEMMA_TEMPLATE_VERSION,
  rendererProtocolVersion: RENDERER_PROTOCOL_VERSION,
  cacheablePrefixMeasuredTokens: 0,
  senseIds: PRISONERS_DILEMMA_SENSE_IDS,
  actionKinds: PRISONERS_DILEMMA_ACTION_KINDS,
  actionSchema: PRISONERS_DILEMMA_ACTION_SCHEMA,
  metricKeys: [
    "deckA.totalScore",
    "deckB.totalScore",
    "deckA.cooperationRate",
    "deckB.cooperationRate",
    "deckA.cooperations",
    "deckB.cooperations",
    "deckA.forgivenessEvents",
    "deckB.forgivenessEvents",
    "roundsPlayed",
  ],
  summaryMetricKeys: [
    "deckA.totalScore",
    "deckB.totalScore",
    "deckA.cooperationRate",
    "deckB.cooperationRate",
  ],
  validateConfig: validatePrisonersDilemmaConfig,
  validateState: validatePrisonersDilemmaState,
  validateAction: validatePrisonersDilemmaAction,
  validateDelta: validatePrisonersDilemmaDelta,
  validateSpec: validatePrisonersDilemmaSpec,
  initialState: createPrisonersDilemmaInitialState,
  buildObservation: buildPrisonersDilemmaObservation,
  legalActions: () => [{ kind: "cooperate" }, { kind: "defect" }],
  listAutomata: (state) =>
    state.players.map((player) => ({
      id: player.id,
      slotId: player.slotId,
      senses: player.senses,
    })),
  tickPhase: ({ tick }) => `round ${tick + 1}`,
  applyActions: applyPrisonersDilemmaActions,
  metrics: prisonersDilemmaMetrics,
  withInvalidActions: ({ state, count }) => ({
    ...state,
    totalInvalidActions: state.totalInvalidActions + count,
  }),
  withInvalidActionDelta: ({ delta }) => ({ ...delta }),
  renderScene: renderPrisonersDilemmaScene,
};
