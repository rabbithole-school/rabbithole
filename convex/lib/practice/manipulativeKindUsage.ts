/**
 * Manipulative KIND usage — the pure grouping behind the Library's "In use /
 * Never used" scoreboard and each kind's "Where it's used" list.
 *
 * The one cross-reference no surface can answer today: the pool stores a
 * `manipulativeCount` per node but never parses a spec, so kind → skill is
 * invisible at every layer (convex/practiceItemPool.ts). This extracts `kind`
 * out of each stored `manipulativeSpec` (a JSON string) and tallies items and
 * distinct skills per kind, zero-filling every kind so a mechanic with no items
 * still shows up as "never used" — which is the whole point of the readout.
 *
 * Kept a pure function (no ctx, no db) so the extraction/grouping is unit-tested
 * directly; the Convex query in `practiceItemPool.ts` does the db read + label
 * join and calls this.
 *
 * A malformed, legacy, or kind-less spec MUST NOT throw and take the query down,
 * and MUST NOT be silently dropped (that would make the scoreboard lie). We use
 * the shared `parseManipulativeSpec` (which returns null instead of throwing),
 * treat a spec whose `kind` is not a CURRENT union member as legacy/unknown, and
 * fold both into an explicit `unparseableCount` the caller can surface.
 */

import {
  ALL_MANIPULATIVE_KINDS,
  isCurrentManipulativeKind,
  parseManipulativeSpec,
  type ManipulativeKind,
} from "../../../lib/manipulative/types";

/** The minimal shape this needs off a stored `practiceItems` manipulative row. */
export interface KindUsageRow {
  skillKey: string;
  manipulativeSpec: string | null | undefined;
}

/** One skill's contribution to a kind — how many stored items of this kind sit
 *  on this skill. */
export interface KindSkillUsage {
  skillKey: string;
  count: number;
}

/** Per-kind tally — present for EVERY kind (zero-filled), so a never-used kind
 *  reads `itemCount: 0`. */
export interface ManipulativeKindUsage {
  kind: ManipulativeKind;
  /** Stored items of this kind (across all skills). */
  itemCount: number;
  /** Distinct skills carrying at least one item of this kind, sorted. */
  skillKeys: string[];
  /** Per-skill breakdown for the "Where it's used" list — busiest skill first. */
  perSkill: KindSkillUsage[];
}

export interface ManipulativeKindUsageBreakdown {
  /** Every kind, zero-filled — the complete scoreboard. */
  byKind: Record<ManipulativeKind, ManipulativeKindUsage>;
  /** Manipulative rows whose spec failed to parse OR whose `kind` is not a
   *  current union member (a legacy/removed mechanic). Surfaced, never dropped,
   *  so the counts don't silently understate reality. */
  unparseableCount: number;
}

/**
 * Group stored manipulative rows by their spec's `kind`. Rows are the already
 * manipulative-filtered items; each may carry a good, malformed, legacy, or
 * absent spec. Output is a complete, zero-filled Record plus the count of rows
 * that couldn't be attributed to a current kind.
 */
export function groupManipulativeKindUsage(
  rows: readonly KindUsageRow[],
): ManipulativeKindUsageBreakdown {
  // skillKey → count, per kind — accumulated first, then shaped into the Record.
  const perKindSkillCounts = new Map<ManipulativeKind, Map<string, number>>();
  let unparseableCount = 0;

  for (const row of rows) {
    const spec = parseManipulativeSpec(row.manipulativeSpec);
    // parse-null (malformed / kind-less JSON) OR a kind outside the current
    // closed union (a legacy/removed mechanic) both count as unattributable.
    if (!spec || !isCurrentManipulativeKind(spec.kind)) {
      unparseableCount += 1;
      continue;
    }
    const kind = spec.kind;
    let skillCounts = perKindSkillCounts.get(kind);
    if (!skillCounts) {
      skillCounts = new Map<string, number>();
      perKindSkillCounts.set(kind, skillCounts);
    }
    skillCounts.set(row.skillKey, (skillCounts.get(row.skillKey) ?? 0) + 1);
  }

  const byKind = {} as Record<ManipulativeKind, ManipulativeKindUsage>;
  for (const kind of ALL_MANIPULATIVE_KINDS) {
    const skillCounts = perKindSkillCounts.get(kind);
    if (!skillCounts) {
      byKind[kind] = { kind, itemCount: 0, skillKeys: [], perSkill: [] };
      continue;
    }
    const perSkill: KindSkillUsage[] = [...skillCounts.entries()]
      .map(([skillKey, count]) => ({ skillKey, count }))
      // Busiest skill first; skillKey breaks ties so the order is deterministic.
      .sort((a, b) => b.count - a.count || a.skillKey.localeCompare(b.skillKey));
    byKind[kind] = {
      kind,
      itemCount: perSkill.reduce((sum, s) => sum + s.count, 0),
      skillKeys: perSkill
        .map((s) => s.skillKey)
        .sort((a, b) => a.localeCompare(b)),
      perSkill,
    };
  }

  return { byKind, unparseableCount };
}
