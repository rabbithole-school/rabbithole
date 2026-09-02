import type {
  GraphemeStage,
  GraphemeStages,
} from "@/shared/graphemeSegments";

export type InventoryTeam = { team: string; stage: GraphemeStage };

export function buildStageMap(
  teams: readonly InventoryTeam[] | undefined | null,
): GraphemeStages {
  const map: GraphemeStages = {};
  if (!teams) return map;
  for (const { team, stage } of teams) {
    map[team] = stage;
  }
  return map;
}
