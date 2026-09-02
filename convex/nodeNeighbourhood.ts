/**
 * Neighbourhood query for the NodeDrawer — one-hop graph around a canonical
 * knowledgeNode (§5 of review/practice/practice-engine-roadmap.html).
 *
 * Accepts either `nodeKey` (canonical) or `standardId` (legacy, resolved via
 * by_standard index) so CellDetailView can bridge from the old standards-row
 * identity without touching acceleration.cellDetail.
 *
 * Per-scholar readings (mastery state + retention + depth) are returned when
 * `scholarId` is supplied. Auth model: `authedQuery` — any authenticated user
 * may read the curriculum graph; the caller (teacher surface / scholar's own
 * view) is responsible for passing the correct scholarId, matching the pattern
 * in concepts.conceptDetail.
 *
 * NOTE: This file is new. It will not appear in _generated until the
 * quarterback runs `npx convex dev --once`. The source is correct; the
 * generated types just don't exist in the sandbox yet.
 */

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { isTeacherRole } from "./lib/roles";
import { canReadScholarAsTeacher } from "./lib/access";
import {
  proficiencyFromReps,
  retention,
  retentionLabel,
  isDemonstratedSource,
  type SkillState,
} from "./lib/practice/scheduler";
import { runnableSkillKeySet } from "./practiceSkills";
import type { Id } from "./_generated/dataModel";
import { methodOf, relationOf } from "../shared/edgeOntology";
import { masteryOf, type MasteryState } from "../shared/treeMapLayout";
import { storyArtUrlForNode } from "./lib/scholarReads";

/**
 * Map a practiceMastery row's rep count + source → the five MasteryState
 * bands the Dial/NodeDrawer render — reusing the CANONICAL two-axis rule
 * (`masteryOf` / `DEMONSTRATED_SOURCES`) from `shared/treeMapLayout.ts`,
 * the same helper `cohortPractice.ts`/`practiceSkills.ts` use for the map.
 * Access-proven-but-INFERRED credit (placement / accelerated / re-probe)
 * reads as "placed" (provisional), never the solid-green "fluent".
 */
function toMasteryState(
  row: {
    repetition: number;
    frontier: boolean;
    source?: string;
    missStreak?: number;
  },
  surfaceStruggling: boolean,
): MasteryState {
  return masteryOf({
    skillKey: "",
    label: "",
    domain: "",
    repetition: row.repetition,
    proficiency: proficiencyFromReps(row.repetition),
    retention: "none",
    frontier: row.frontier,
    demonstrated: isDemonstratedSource(row.source),
    // "struggling" (red) is teacher/parent-facing; on a scholar's own view it's
    // omitted so masteryOf can never derive the red deficit mark for them.
    missStreak: surfaceStruggling ? row.missStreak : undefined,
  });
}

export const neighbourhood = authedQuery({
  args: {
    /** Canonical nodeKey — preferred. */
    nodeKey: v.optional(v.string()),
    /** Legacy: resolve via knowledgeNodes.by_standard if nodeKey is absent. */
    standardId: v.optional(v.id("standards")),
    /** When provided, attach per-scholar mastery + retention + depth readings. */
    scholarId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    // ── 1. Resolve focal node ──────────────────────────────────────────────
    let node = null;
    if (args.nodeKey) {
      node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.nodeKey!))
        .first();
    } else if (args.standardId) {
      node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_standard", (q) => q.eq("standardId", args.standardId!))
        .first();
    }
    if (!node) return null;

    // ── 2. Edges — both directions ─────────────────────────────────────────
    const [edgesTo, edgesFrom] = await Promise.all([
      ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_to", (q) => q.eq("toKey", node!.nodeKey))
        .collect(),
      ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", node!.nodeKey))
        .collect(),
    ]);

    const rawEdges = [...edgesTo, ...edgesFrom];
    const genericEdges = [];
    for (const edge of rawEdges) {
      if (edge.story !== undefined) continue;
      // INFERENCE-ONLY (`implies`) edges are never a user-facing relationship:
      // `relationOf("implies")` is "dependency" (directional render), so without
      // this skip the NodeDrawer would draw them as prerequisite/unlock arrows and
      // chips — a leak of an inference-only edge into a gating-looking surface.
      // The neighbourhood is not one of the two blessed inference consumers
      // (implicit-credit + placement), so it must drop `implies` entirely.
      if (edge.kind === "implies") continue;
      try {
        genericEdges.push({
          fromKey: edge.fromKey,
          toKey: edge.toKey,
          kind: edge.kind,
          relation: relationOf(edge.kind),
          method: methodOf(edge),
          weight: edge.weight ?? null,
        });
      } catch (err) {
        console.error("Unknown knowledge edge kind in neighbourhood response", {
          edgeId: edge._id,
          kind: edge.kind,
          err,
        });
      }
    }

    const storyEdges = rawEdges.filter((edge) => edge.story !== undefined);

    // ── 3. Collect neighbour nodeKeys (deduped) ────────────────────────────
    const neighbourKeys = new Set([
      ...genericEdges.map((e) => (e.toKey === node!.nodeKey ? e.fromKey : e.toKey)),
      ...storyEdges.map((e) =>
        e.fromKey === node!.nodeKey ? e.toKey : e.fromKey,
      ),
    ]);

    // ── 4. Fetch neighbour node records ────────────────────────────────────
    const neighbourNodes = (
      await Promise.all(
        [...neighbourKeys].map((k) =>
          ctx.db
            .query("knowledgeNodes")
            .withIndex("by_nodeKey", (q) => q.eq("nodeKey", k))
            .first(),
        ),
      )
    ).filter(Boolean) as NonNullable<typeof node>[];
    const neighbourByKey = new Map(
      neighbourNodes.map((neighbour) => [neighbour.nodeKey, neighbour]),
    );

    // ── 5. Per-scholar readings (optional, GATED) ─────────────────────────
    // Per-scholar mastery/depth is sensitive. Gate `scholarId` the same way
    // nodeDepth.ts / messages.getScholarReadingTrend do — teacher-or-self,
    // institution-scoped — and NEVER trust the client to pass "the right"
    // scholarId. If the caller can't access this scholar we simply OMIT the
    // readings (the shared graph structure below is not sensitive), rather
    // than throw (a thrown query trips the route ErrorBoundary).
    let canReadReadings = false;
    if (args.scholarId) {
      if (ctx.user._id === args.scholarId) {
        canReadReadings = true;
      } else if (isTeacherRole(ctx.user.role)) {
        canReadReadings = await canReadScholarAsTeacher(
          ctx,
          ctx.user,
          args.scholarId,
        );
      }
    }

    type RetLabel = "fresh" | "due" | "none";

    let focalReadings: {
      mastery: MasteryState;
      automaticity: number;
      /** Normalized 0..1 mastery level from the latest observer attribution. */
      depth: number;
      retentionLabel: RetLabel;
    } | null = null;

    const neighbourMastery = new Map<
      string,
      { mastery: MasteryState; automaticity: number; retentionLabel: RetLabel }
    >();

    if (args.scholarId && canReadReadings) {
      const now = Date.now();
      // Struggling (red) is redacted from a scholar's OWN view: surface it only
      // when the reader is a teacher looking at someone else, never scholar-self.
      const surfaceStruggling = ctx.user._id !== args.scholarId;

      // practiceMastery rows for this scholar+domain (covers focal + neighbours
      // in the same domain — most common case; cross-domain sky neighbours
      // won't have a matching row, which is fine).
      const masteryRows = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", args.scholarId!).eq("domain", node!.domain),
        )
        .collect();
      const masteryByKey = new Map(masteryRows.map((m) => [m.skillKey, m]));

      // masteryObservations filtered to this scholar+domain, non-superseded —
      // used for the Bloom depth reading on the focal node.
      const observations = await ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", args.scholarId!).eq("domain", node!.domain),
        )
        .filter((q) => q.eq(q.field("isSuperseded"), false))
        .collect();

      // Best depth observation for the focal node: match by conceptLabel (case-
      // insensitive) or by standardId back-link.
      const focalLabel = node.label.toLowerCase();
      const focalObs = observations
        .filter(
          (o) =>
            o.conceptLabel.toLowerCase() === focalLabel ||
            (node!.standardId &&
              o.standardIds?.includes(node!.standardId as Id<"standards">)),
        )
        .sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;

      const depthNorm = focalObs
        ? Math.max(0, Math.min(1, focalObs.masteryLevel))
        : 0;

      // Focal readings
      const focalMastery = masteryByKey.get(node.nodeKey);
      if (focalMastery) {
        const state: SkillState = {
          repetition: focalMastery.repetition,
          halfLifeDays: focalMastery.halfLifeDays,
          lastPracticedAt: focalMastery.lastPracticedAt,
        };
        focalReadings = {
          mastery: toMasteryState(focalMastery, surfaceStruggling),
          automaticity: retention(state, now),
          depth: depthNorm,
          retentionLabel: retentionLabel(state, now),
        };
      } else {
        focalReadings = {
          mastery: "locked",
          automaticity: 0,
          depth: depthNorm,
          retentionLabel: "none",
        };
      }

      // Neighbour readings (mastery + retention only — no depth to unpack here)
      for (const nk of neighbourKeys) {
        const m = masteryByKey.get(nk);
        if (m) {
          const state: SkillState = {
            repetition: m.repetition,
            halfLifeDays: m.halfLifeDays,
            lastPracticedAt: m.lastPracticedAt,
          };
          neighbourMastery.set(nk, {
            mastery: toMasteryState(m, surfaceStruggling),
            automaticity: retention(state, now),
            retentionLabel: retentionLabel(state, now),
          });
        }
      }
    }

    // ── 6. Return shaped payload ───────────────────────────────────────────
    // Whether targeted practice (?skill=) can actually serve this node — the
    // engine's own required-lane rule (deterministic template OR a stored
    // non-stretch item). The legacy `knowledgeNodes.verifierKind` field is NOT
    // that signal: the practice-graph seeder never writes it, so gating on it
    // refuses freshly-seeded skills the engine serves fine.
    const practiceServeable = (
      await runnableSkillKeySet(ctx, [node.nodeKey])
    ).has(node.nodeKey);
    return {
      node: {
        _id: node._id,
        nodeKey: node.nodeKey,
        label: node.label,
        domain: node.domain,
        strand: node.strand ?? null,
        standardCodes: node.standardCodes ?? null,
        verifierKind: node.verifierKind ?? null,
        practiceServeable,
        rationale: node.rationale ?? null,
        source: node.source ?? null,
      },
      edges: genericEdges,
      stories: await Promise.all(storyEdges.map(async (edge) => {
        const direction =
          edge.fromKey === node!.nodeKey ? "outgoing" : "incoming";
        const fromNode =
          direction === "outgoing" ? node! : neighbourByKey.get(edge.fromKey);
        const toNode =
          direction === "incoming" ? node! : neighbourByKey.get(edge.toKey);
        const artUrl = await storyArtUrlForNode(ctx, edge.toKey);
        return {
          edgeId: edge._id,
          direction,
          fromKey: edge.fromKey,
          fromLabel: fromNode?.label ?? edge.fromKey,
          fromDomain: fromNode?.domain ?? edge.domain,
          toKey: edge.toKey,
          toLabel: toNode?.label ?? edge.toKey,
          toDomain: toNode?.domain ?? edge.domain,
          ...(artUrl === undefined ? {} : { artUrl }),
          story: edge.story!,
        };
      })),
      neighbours: neighbourNodes.map((n) => ({
        nodeKey: n.nodeKey,
        label: n.label,
        domain: n.domain,
        source: n.source ?? null,
        standardCodes: n.standardCodes ?? null,
      })),
      focalReadings,
      /** Keyed by nodeKey. Only present for nodes the scholar has practiced. */
      neighbourMastery: Object.fromEntries(neighbourMastery),
    };
  },
});

/**
 * storyCountsForDomain — per-node world-connection story counts across a whole
 * domain, keyed by nodeKey. This is the bulk sibling of `neighbourhood`'s
 * single-node `stories.length`: the Math Skills mastery matrix shows a story
 * count as each skill row's subtext (in place of the developer-facing nodeKey
 * slug), and rendering that for every visible row needs one aggregate rather
 * than one neighbourhood query per row.
 *
 * A "story" is a story-bearing edge (`edge.story !== undefined`) touching the
 * node in EITHER direction, matching the per-node semantics of the neighbourhood
 * `stories` array exactly. authedQuery: the curriculum graph is readable by any
 * authenticated user (same posture as `neighbourhood`); no per-scholar data.
 */
export const storyCountsForDomain = authedQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => {
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .collect();
    const entries = await Promise.all(
      nodes.map(async (node) => {
        const [edgesTo, edgesFrom] = await Promise.all([
          ctx.db
            .query("knowledgeNodeEdges")
            .withIndex("by_to", (q) => q.eq("toKey", node.nodeKey))
            .collect(),
          ctx.db
            .query("knowledgeNodeEdges")
            .withIndex("by_from", (q) => q.eq("fromKey", node.nodeKey))
            .collect(),
        ]);
        const count = [...edgesTo, ...edgesFrom].filter(
          (edge) => edge.story !== undefined,
        ).length;
        return [node.nodeKey, count] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<string, number>;
  },
});
