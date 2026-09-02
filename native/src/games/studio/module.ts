import type {
  GameConfigCodec,
  GameModule,
  GameStateCodec,
} from "../../../vendor/games/contract";

import {
  STUDIO_LEVEL_IDS,
  initialStudioGameState,
  type StudioGameConfig,
  type StudioGameState,
} from "./rules";

const levelIds = new Set(STUDIO_LEVEL_IDS);

const config: GameConfigCodec<StudioGameConfig> = {
  parse(value: unknown): StudioGameConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("studio config must be an object");
    }
    const raw = value as { levelIds?: unknown };
    if (raw.levelIds === undefined) return { levelIds: [...STUDIO_LEVEL_IDS] };
    if (!Array.isArray(raw.levelIds)) {
      throw new Error("studio config.levelIds must be an array of level ids");
    }
    if (raw.levelIds.length === 0) return { levelIds: [...STUDIO_LEVEL_IDS] };

    const parsed: string[] = [];
    for (const levelId of raw.levelIds) {
      if (typeof levelId !== "string" || !levelIds.has(levelId)) {
        throw new Error(`studio config.levelIds contains unknown level id "${String(levelId)}"`);
      }
      if (parsed.includes(levelId)) {
        throw new Error(`studio config.levelIds contains duplicate level id "${levelId}"`);
      }
      parsed.push(levelId);
    }
    return { levelIds: parsed };
  },
};

const state: GameStateCodec<StudioGameConfig, StudioGameState> = {
  create({ config: parsedConfig }): StudioGameState {
    return initialStudioGameState(parsedConfig);
  },
};

const studio: GameModule<StudioGameConfig, StudioGameState> = {
  manifest: {
    gameId: "studio",
    version: 1,
    eventKeys: ["run_result"],
  },
  config,
  state,
};

export default studio;
