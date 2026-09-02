import {
  MAX_EVENT_TEXT_LEN,
  type GameEventInput,
} from "../../../vendor/games/contract";
import type { StudioRunResult } from "../../../vendor/shared/studioContract";
import {
  STUDIO_LEVELS,
  deriveStudioWorldSeed,
} from "../../../vendor/shared/studioLevels";

export interface StudioGameConfig {
  /** Normalized to the configured subset, or every level when authored empty. */
  levelIds: string[];
}

export interface StudioGameState {
  activeLevelId: string;
  attemptsByLevel: Record<string, number>;
  runCount: number;
  solvedLevelIds: string[];
}

export const STUDIO_LEVEL_IDS = STUDIO_LEVELS.map((level) => level.id);

export function levelsForConfig(config: StudioGameConfig) {
  const allowed = new Set(config.levelIds);
  return STUDIO_LEVELS.filter((level) => allowed.has(level.id));
}

export function initialStudioGameState(config: StudioGameConfig): StudioGameState {
  return {
    activeLevelId: config.levelIds[0]!,
    attemptsByLevel: {},
    runCount: 0,
    solvedLevelIds: [],
  };
}

export function allocateStudioWorld(
  state: StudioGameState,
  launchSeed: string,
  levelId: string,
): { state: StudioGameState; seed: string } {
  const attempt = state.attemptsByLevel[levelId] ?? 0;
  return {
    seed: deriveStudioWorldSeed(launchSeed, levelId, attempt),
    state: {
      ...state,
      activeLevelId: levelId,
      attemptsByLevel: {
        ...state.attemptsByLevel,
        [levelId]: attempt + 1,
      },
    },
  };
}

export function recordStudioRun(
  state: StudioGameState,
  run: StudioRunResult,
): StudioGameState {
  const solved = new Set(state.solvedLevelIds);
  if (run.status === "win") solved.add(run.levelId);
  return {
    ...state,
    activeLevelId: run.levelId,
    runCount: state.runCount + 1,
    solvedLevelIds: [...solved].sort(),
  };
}

export function studioEvidenceStatus(
  status: StudioRunResult["status"],
): "solved" | "failed" | "stopped" {
  if (status === "win") return "solved";
  if (status === "stopped") return "stopped";
  return "failed";
}

export function studioRunEvidence(run: StudioRunResult): GameEventInput {
  const frames = [...run.trace.frames];
  let omitted = run.trace.truncated;
  const format = (
    levelId = run.levelId,
    seed = run.seed,
    steps = String(run.steps),
  ) => {
    const trace = frames
      .map((frame) => `${frame.note}@${frame.x},${frame.y}:L${frame.line}`)
      .join(">");
    return [
      `level=${levelId}`,
      `status=${studioEvidenceStatus(run.status)}`,
      `steps=${steps}`,
      `seed=${seed}`,
      `assisted=${run.assisted}`,
      `trace=${trace || "none"}`,
      `truncated=${omitted}`,
    ].join("; ");
  };

  let detail = format();
  while (detail.length > MAX_EVENT_TEXT_LEN && frames.length > 0) {
    frames.pop();
    omitted = true;
    detail = format();
  }
  if (detail.length > MAX_EVENT_TEXT_LEN) {
    frames.length = 0;
    omitted = true;
    detail = format(
      run.levelId.slice(0, 64),
      run.seed.slice(0, 64),
      String(run.steps).slice(0, 32),
    );
  }

  return {
    eventKey: "run_result",
    payload: {
      kind: "local_rule_result",
      passed: run.status === "win",
      detail,
    },
  };
}
