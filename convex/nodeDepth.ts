/**
 * Per-scholar depth readings on canonical knowledge nodes.
 *
 * Depth is the Bloom conceptual level (masteryObservations.masteryLevel 0–5)
 * normalised to 0..1, surfaced as the right-arc gauge on the
 * KnowledgeNodeDial ("Option B · side-flanks", roadmap §5).
 *
 * ── REDACTION BOUNDARY ───────────────────────────────────────────────────
 * `hasOpenMisconception` (and any further misconception detail) is returned
 * ONLY to teacher/admin callers. A scholar or parent caller receives depth
 * only — the field is structurally absent from their readings, never false
 * or null. This matches the roadmap §5 design decision:
 *
 *   "Misconception flags: teacher-only … stays teacher-side (redaction
 *    boundary) until it can be surfaced as growth."
 *
 * The flag has TWO teacher-only sources, both gated behind `isTeacher`:
 *   • observer channel — an open misconception_signal observation (buildNodeReadings)
 *   • practice channel — a recurring buggy-algorithm pattern in the drill
 *     (C3, §7: ≥3 of the same in 14d, from practiceErrorEvents). The node
 *     drawer distinguishes the two channels; the map flag is shared.
 *
 * The gate is implemented in two layers:
 *   1. Query-level: isTeacher=false → buildNodeReadings never sees the flag.
 *   2. Pure-helper level (lib/nodeDepthHelpers.ts): the `if (isTeacher)`
 *      block in buildNodeReadings() is the structural guarantee.
 *
 * ── SAFE-EMPTY CONTRACT ───────────────────────────────────────────────────
 * On ANY access-check failure this handler returns { readings: [] } —
 * it NEVER throws. A thrown query trips the route ErrorBoundary; a safe
 * empty shape lets the node UI keep rendering. Pattern mirrors
 * messages.ts:getScholarReadingTrend.
 */

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { isTeacherRole } from "./lib/roles";
import { canReadScholarAsTeacher } from "./lib/access";
import {
  normalizeLabel,
  buildNodeReadings,
  type NodeReading,
} from "./lib/nodeDepthHelpers";
import { openErrorPatterns, type ErrorEvent } from "./lib/practice/errorFlags";

export type { NodeReading };

/**
 * Per-scholar depth readings for every canonical knowledge node that has
 * at least one current (non-superseded) mastery observation.
 *
 * Access:
 *   teacher/admin  → { readings: [{ nodeKey, depth, hasOpenMisconception? }] }
 *   self (scholar) → { readings: [{ nodeKey, depth }] }     ← no flag field
 *   unauthorized   → { readings: [] }                       ← safe empty
 *
 * Args:
 *   scholarId  — the scholar whose observations to read
 *   domain     — optional domain filter (e.g. "whole-number-arithmetic");
 *                absent = all domains
 */
export const nodeReadingsForScholar = authedQuery({
  args: {
    scholarId: v.id("users"),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const safeEmpty = (): { readings: NodeReading[] } => ({ readings: [] });

    const isTeacher = isTeacherRole(ctx.user.role);
    const isSelf = ctx.user._id === args.scholarId;

    // ── 1. Identity / role gate ──────────────────────────────────────────
    // Neither teacher nor the scholar themselves → safe empty, never throw.
    if (!isTeacher && !isSelf) return safeEmpty();

    // ── 2. Institution-scope enforcement (teacher path only) ─────────────
    // Mirrors messages.ts:getScholarReadingTrend exactly:
    //   • platform_admin is always allowed (global scope)
    //   • a teacher with no accessible membership for this scholar → safe empty
    if (
      isTeacher &&
      !isSelf &&
      !(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))
    ) {
      return safeEmpty();
    }

    // ── 3. Fetch current (non-superseded) observations ───────────────────
    // Use by_scholar_domain when a domain filter is given (avoids scanning
    // all domains), by_scholar_current otherwise (index-filtered on
    // isSuperseded=false).
    const observations = args.domain
      ? (
          await ctx.db
            .query("masteryObservations")
            .withIndex("by_scholar_domain", (q) =>
              q.eq("scholarId", args.scholarId).eq("domain", args.domain!),
            )
            .collect()
        ).filter((r) => !r.isSuperseded)
      : await ctx.db
          .query("masteryObservations")
          .withIndex("by_scholar_current", (q) =>
            q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
          )
          .collect();

    // Observation-derived depth readings (may be empty — a scholar can have
    // practice-error flags with no conversational observation at all, so we
    // must NOT early-return here).
    let readings: NodeReading[] = [];

    if (observations.length > 0) {
      // ── 4. Group observations by normalized concept label ───────────────
      // Two observations whose conceptLabels normalize to the same string
      // (e.g. "Fractions" and "fractions") live in the same bucket and will
      // resolve to the same node.
      const byNormLabel = new Map<string, typeof observations>();
      for (const obs of observations) {
        const key = normalizeLabel(obs.conceptLabel);
        const bucket = byNormLabel.get(key) ?? [];
        bucket.push(obs);
        byNormLabel.set(key, bucket);
      }

      // ── 5. Resolve nodeKey for each label cluster ───────────────────────
      // Match order (per roadmap §1 node-identity contract):
      //   a. node.normalizedLabel === normLabel  (Sky / concept-atlas nodes)
      //   b. node.nodeKey         === normLabel  (fallback; Sky nodeKey IS
      //                                          normalizedLabel for those nodes)
      // If no node is found, skip the cluster (no canonical home = no reading).
      const nodeKeyMap = new Map<
        string,
        { nodeKey: string; obs: (typeof observations)[number][] }
      >();

      for (const [normLabel, obsBucket] of byNormLabel) {
        const node =
          (await ctx.db
            .query("knowledgeNodes")
            .withIndex("by_normalized", (q) =>
              q.eq("normalizedLabel", normLabel),
            )
            .first()) ??
          (await ctx.db
            .query("knowledgeNodes")
            .withIndex("by_nodeKey", (q) => q.eq("nodeKey", normLabel))
            .first());

        if (!node) continue;

        const existing = nodeKeyMap.get(node.nodeKey);
        if (existing) {
          for (const o of obsBucket) existing.obs.push(o);
        } else {
          nodeKeyMap.set(node.nodeKey, {
            nodeKey: node.nodeKey,
            obs: [...obsBucket],
          });
        }
      }

      // ── 6. Build depth readings + apply misconception redaction ─────────
      // buildNodeReadings() owns the field-level redaction:
      //   isTeacher=true  → depth + hasOpenMisconception (when applicable)
      //   isTeacher=false → depth only; hasOpenMisconception structurally absent
      const groups = [...nodeKeyMap.values()].map(({ nodeKey, obs }) => ({
        nodeKey,
        observations: obs,
      }));
      readings = buildNodeReadings(groups, isTeacher);
    }

    // ── 7. TEACHER-ONLY: merge practice-derived error flags (C3, §7) ───────
    // A recurring buggy-algorithm pattern in the drill (≥3 of the same in 14d)
    // lights the SAME teacher-only node flag as an observer misconception — the
    // node drawer distinguishes the channel. This block MUST NOT run for a
    // scholar/parent caller (the flag is teacher-side), so it is gated on
    // isTeacher exactly like buildNodeReadings' redaction. nodeKey == skillKey
    // (a direct join — practice nodes need no label normalization).
    if (isTeacher) {
      const events = (
        await ctx.db
          .query("practiceErrorEvents")
          .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
          .collect()
      ).filter((e) => !args.domain || e.domain === args.domain);

      if (events.length > 0) {
        const now = Date.now();
        const byNode = new Map<string, ErrorEvent[]>();
        for (const e of events) {
          const bucket = byNode.get(e.nodeKey) ?? [];
          bucket.push({ pattern: e.pattern, createdAt: e.createdAt });
          byNode.set(e.nodeKey, bucket);
        }

        const readingByKey = new Map(readings.map((r) => [r.nodeKey, r]));
        for (const [nodeKey, nodeEvents] of byNode) {
          if (openErrorPatterns(nodeEvents, now).length === 0) continue;
          const existing = readingByKey.get(nodeKey);
          if (existing) {
            existing.hasOpenMisconception = true;
          } else {
            // Practice-only node (no depth observation): a flag-only reading.
            // depth 0 renders as "no depth arc" on the map (same as absent).
            const reading: NodeReading = {
              nodeKey,
              depth: 0,
              hasOpenMisconception: true,
            };
            readings.push(reading);
            readingByKey.set(nodeKey, reading);
          }
        }
      }
    }

    return { readings };
  },
});
