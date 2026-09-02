/**
 * buildStageMap — turn a scholar's grapheme inventory (the `{ team, stage }[]`
 * returned by `api.graphemeInventory.mine`) into the per-team `GraphemeStages`
 * lookup that `GraphemeText` / `toSegments` consume
 * (review/young-learners-plan.html §10).
 *
 * Pure + framework-free (type-only import of the vendored render core) so it
 * unit-tests under the native `src/lib/*` vitest config with no RN renderer.
 *
 * An empty / absent inventory folds to an empty map, which the session screen
 * uses as its "plain text, skip GraphemeText entirely" fast path — the only
 * gate a caller needs is "is this map non-empty?".
 */
import type {
  GraphemeStage,
  GraphemeStages,
} from "../../vendor/shared/graphemeSegments";

/** One inventory entry, matching `api.graphemeInventory.mine`'s element shape. */
export type InventoryTeam = { team: string; stage: GraphemeStage };

/**
 * Fold the inventory list into a `team → stage` record. Later entries win on a
 * duplicate team (defensive; the inventory is already deduped server-side).
 *
 * Every team is carried through — `graduated` included — because `toSegments`
 * treats a graduated team exactly like a missing one (plain ink). Keeping the
 * map a faithful 1:1 mirror of the inventory means "non-empty map" cleanly
 * stands in for "this scholar has an active reading-ramp inventory".
 */
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
