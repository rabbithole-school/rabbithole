/**
 * `toy-warmer-colder` — the toy. Framework-free half.
 *
 * DELIBERATELY TRIVIAL AND DISPOSABLE. It exists to exercise every seam of the
 * games host — seeded state, phases, checkpoint/resume across moves, each
 * evidence kind, prediction↔observation pairing in the digest — and for no
 * other reason. It is not a good game. Do not extend it; write a new game.
 *
 * Rules, in full: a token hides under one of N tiles. The scholar first
 * predicts which HALF it's in, then probes one tile and is told how warm that
 * probe was. They may revise the half, then probe once more. The round ends.
 * Nobody wins anything.
 *
 * This file must stay importable in plain Node — the CI conformance test
 * `require()`s it. No react, no react-native, no reanimated. The renderer lives
 * next door in Screen.tsx.
 */
import type {
  GameModule,
  GameConfigCodec,
  GameStateCodec,
} from "../../../vendor/games/contract";

export interface ToyConfig {
  /** How many tiles in the strip. Even, so "halves" is meaningful. */
  tiles: number;
}

export type ToyPhase = "predict" | "probe1" | "revise" | "probe2" | "done";

export interface ToyState {
  phase: ToyPhase;
  /** 0-based index of the hidden token. Derived from the seed, never client-sent. */
  tokenIndex: number;
  /** The scholar's current belief about which half. */
  half: "left" | "right" | null;
  /** The half they first predicted — kept so a revision has a `before`. */
  firstHalf: "left" | "right" | null;
  probes: number[];
}

const MIN_TILES = 4;
const MAX_TILES = 16;

const config: GameConfigCodec<ToyConfig> = {
  parse(value: unknown): ToyConfig {
    if (!value || typeof value !== "object") {
      throw new Error("toy-warmer-colder config must be an object");
    }
    const tiles = (value as { tiles?: unknown }).tiles;
    if (typeof tiles !== "number" || !Number.isInteger(tiles)) {
      throw new Error("toy-warmer-colder config.tiles must be an integer");
    }
    if (tiles < MIN_TILES || tiles > MAX_TILES) {
      throw new Error(
        `toy-warmer-colder config.tiles must be between ${MIN_TILES} and ${MAX_TILES}`,
      );
    }
    if (tiles % 2 !== 0) {
      throw new Error("toy-warmer-colder config.tiles must be even");
    }
    return { tiles };
  },
};

/**
 * A boring string hash. Deterministic across platforms and needs no crypto —
 * the token's position is not a secret worth defending, it just has to be the
 * SAME on a resume so a checkpointed probe still means what it meant.
 */
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const state: GameStateCodec<ToyConfig, ToyState> = {
  create({ config: cfg, seed }): ToyState {
    return {
      phase: "predict",
      tokenIndex: hashSeed(seed) % cfg.tiles,
      half: null,
      firstHalf: null,
      probes: [],
    };
  },
};

/** Which half a tile index falls in. Pure — the Screen and the tests share it. */
export function halfOf(index: number, tiles: number): "left" | "right" {
  return index < tiles / 2 ? "left" : "right";
}

/**
 * The warmth band for a probe. Presentation-adjacent but pure and on the JS
 * thread, because the digest quotes it — anything the server may re-read must
 * never live in a worklet.
 */
export function bandFor(probe: number, tokenIndex: number, tiles: number): string {
  const d = Math.abs(probe - tokenIndex);
  if (d === 0) return "found it";
  if (d <= Math.max(1, Math.floor(tiles / 8))) return "burning";
  if (d <= Math.floor(tiles / 4)) return "warm";
  if (d <= Math.floor(tiles / 2)) return "cool";
  return "cold";
}

const toyWarmerColder: GameModule<ToyConfig, ToyState> = {
  manifest: {
    gameId: "toy-warmer-colder",
    version: 1,
    // Must be a subset of the catalog's evidence plan; the CI conformance test
    // is what enforces that, so a new key here without a plan entry fails the
    // build rather than being silently dropped at ingest.
    eventKeys: [
      "phase",
      "guess_half",
      "first_tap",
      "feedback_shown",
      "half_revised",
      "probe_read",
      "second_tap",
      "round_ended",
    ],
  },
  config,
  state,
};

export default toyWarmerColder;
