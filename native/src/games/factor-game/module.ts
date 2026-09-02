/**
 * `factor-game` — the framework-free half: manifest, config codec, state codec.
 *
 * The rules live next door in `rules.ts`; the renderer in `Screen.tsx`. This
 * file must stay importable in plain Node — the CI conformance test requires
 * it. No react, no react-native, no reanimated.
 *
 * Note what is NOT in the manifest's `eventKeys`: nothing about winning. The
 * game reports the moves that were made and files the final standing as an
 * `outcome_claimed` key. Whether a scholar came out ahead of a greedy heuristic
 * is a fact about the round, not about the child, and nothing downstream is
 * permitted to read it as one.
 */
import type { GameModule, GameConfigCodec, GameStateCodec } from "../../../vendor/games/contract";

import {
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  initialState,
  type FactorConfig,
  type FactorPlayer,
  type FactorState,
} from "./rules";

const PLAYERS: readonly FactorPlayer[] = ["scholar", "opponent"];

const config: GameConfigCodec<FactorConfig> = {
  parse(value: unknown): FactorConfig {
    if (!value || typeof value !== "object") {
      throw new Error("factor-game config must be an object");
    }
    const raw = value as { boardSize?: unknown; firstTurn?: unknown };
    if (typeof raw.boardSize !== "number" || !Number.isInteger(raw.boardSize)) {
      throw new Error("factor-game config.boardSize must be an integer");
    }
    if (raw.boardSize < MIN_BOARD_SIZE || raw.boardSize > MAX_BOARD_SIZE) {
      throw new Error(
        `factor-game config.boardSize must be between ${MIN_BOARD_SIZE} and ${MAX_BOARD_SIZE}`,
      );
    }
    const firstTurn = raw.firstTurn ?? "scholar";
    if (typeof firstTurn !== "string" || !PLAYERS.includes(firstTurn as FactorPlayer)) {
      throw new Error('factor-game config.firstTurn must be "scholar" or "opponent"');
    }
    return { boardSize: raw.boardSize, firstTurn: firstTurn as FactorPlayer };
  },
};

/**
 * Deterministic for a fixed (config, seed) — asserted by the conformance test.
 *
 * The Factor Game has no hidden information, so the seed genuinely does not
 * affect the opening position; `create` ignores it. That is fine and is checked
 * for what it is: determinism, not seed-sensitivity.
 */
const state: GameStateCodec<FactorConfig, FactorState> = {
  create({ config: cfg }): FactorState {
    return initialState(cfg);
  },
};

const factorGame: GameModule<FactorConfig, FactorState> = {
  manifest: {
    gameId: "factor-game",
    version: 1,
    eventKeys: [
      "phase",
      "scholar_pick",
      "giveaway_seen",
      "opponent_pick",
      "opponent_giveaway",
      "pick_rationale",
      "no_moves_left",
      "round_ended",
    ],
  },
  config,
  state,
};

export default factorGame;
