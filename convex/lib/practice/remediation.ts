/**
 * Auto-remediation on plateau (raise-the-ceiling / parity plan §5, "C").
 *
 * When a scholar keeps making the same buggy-algorithm error on a node (an
 * OPEN error-pattern flag — see `errorFlags.ts`), the engine can automatically
 * serve the weakest PREREQUISITE that node builds on, rather than waiting for a
 * teacher to click "Prescribe practice". The teacher stays a curator, not a
 * gate (the same stance as exploration seeds).
 *
 * TWO functions, both PURE (no Convex imports — mirrors scheduler.ts):
 *  - `pickFlaggedNode` reduces a scholar's recent error events to the single
 *    node whose flag was most recently reinforced (one target at a time).
 *  - `pickRemediationTarget` chooses that node's weakest already-attempted
 *    prerequisite — the skill to drill so the flagged node stops misfiring.
 *
 * Self-terminating by construction: drilling the prerequisite raises its
 * retention/reps until it leaves the candidate set, and the flag itself ages
 * out of the 14-day window. Both stand remediation down with NO extra state.
 */

import { retention, FLUENT_REPS, type GraphEdge, type SkillState } from "./scheduler";
import { openErrorPatterns } from "./errorFlags";

/**
 * A prerequisite is a remediation candidate only while it is NOT yet solid.
 * Solid = demonstrated fluent (`repetition ≥ FLUENT_REPS`) AND still well
 * retained (`retention ≥ REMEDIATION_RETENTION_BAR`). The bar is stricter than
 * the plain due threshold: a prereq under a misfiring node should be genuinely
 * strong, not merely "not due".
 */
export const REMEDIATION_RETENTION_BAR = 0.9;

/** One error event (a classified miss) tagged with the node it happened on. */
export type NodeErrorEvent = {
  nodeKey: string;
  pattern: string;
  createdAt: number;
};

/**
 * The single node currently driving remediation: among all nodes with an OPEN
 * error pattern (≥ MIN_COUNT same-pattern misses inside the window), the one
 * whose flag was most recently reinforced (max `lastAt`). Ties break by
 * `nodeKey` for determinism. Returns null when nothing is flagged.
 */
export function pickFlaggedNode(events: NodeErrorEvent[], now: number): string | null {
  const byNode = new Map<string, NodeErrorEvent[]>();
  for (const e of events) {
    const list = byNode.get(e.nodeKey);
    if (list) list.push(e);
    else byNode.set(e.nodeKey, [e]);
  }

  let best: { nodeKey: string; lastAt: number } | null = null;
  for (const [nodeKey, nodeEvents] of byNode) {
    const open = openErrorPatterns(nodeEvents, now);
    if (open.length === 0) continue;
    // openErrorPatterns returns most-recent-first, so [0].lastAt is this node's
    // freshest qualifying event.
    const lastAt = open[0].lastAt;
    if (
      best === null ||
      lastAt > best.lastAt ||
      (lastAt === best.lastAt && nodeKey < best.nodeKey)
    ) {
      best = { nodeKey, lastAt };
    }
  }
  return best?.nodeKey ?? null;
}

/**
 * The weakest prerequisite of `flaggedNodeKey` to drill, or null to stand down.
 *
 * Candidates are the flagged node's DIRECT `buildsOn` prerequisites (edges where
 * `toKey === flaggedNodeKey`) that the scholar has already attempted (a mastery
 * row exists) AND that are not yet solid (`repetition < FLUENT_REPS` OR
 * `retention < REMEDIATION_RETENTION_BAR`). The lowest-retention candidate wins;
 * ties break by `skillKey`. No candidates → null (the prereqs are solid; the
 * Socratic handoff already covers the flagged node itself, and we never drill
 * the flagged node here).
 *
 * `stateOf` returns the scholar's state for a prerequisite, or `undefined` when
 * there is no mastery row yet (such a prereq is skipped — never invented).
 */
export function pickRemediationTarget(
  flaggedNodeKey: string,
  edges: GraphEdge[],
  stateOf: (key: string) => SkillState | undefined,
  now: number,
): string | null {
  const directPrereqs = edges
    .filter((e) => e.toKey === flaggedNodeKey)
    .map((e) => e.fromKey);

  let best: { key: string; retention: number } | null = null;
  for (const key of directPrereqs) {
    const state = stateOf(key);
    if (state === undefined) continue; // no mastery row → not a candidate
    const ret = retention(state, now);
    const notSolid = state.repetition < FLUENT_REPS || ret < REMEDIATION_RETENTION_BAR;
    if (!notSolid) continue;
    if (
      best === null ||
      ret < best.retention ||
      (ret === best.retention && key < best.key)
    ) {
      best = { key, retention: ret };
    }
  }
  return best?.key ?? null;
}
