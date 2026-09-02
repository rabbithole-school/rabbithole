/**
 * Knowledge Tree lens (daylight) — reads a scholar's evidence against the
 * curated, code-backed DAG and returns each node's status + a frontier-relative
 * GAP diagnosis. Teacher-facing. The gap/frontier logic is pure + unit-tested
 * in convex/lib/knowledgeTreeFrontier.ts; this query is just the Convex plumbing.
 *
 * §1 collapse: the curated tree now LIVES in the canonical `knowledgeNodes` /
 * `knowledgeNodeEdges` tables (source:"curated", absorbed by
 * knowledgeNodes.rebuildTreeNodes). `reconstructCuratedTrees` is a thin SHIM that
 * reads those rows back into the exact TreeNode/TreeEdge/KnowledgeTree shape the
 * pure frontier logic already consumes — so computeFrontier and the components
 * (KnowledgeTreePanel, ScholarFeed, StandardMeat) are byte-identical to before.
 */

import { v } from "convex/values";
import { teacherQuery } from "./lib/customFunctions";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { canonicalNotation } from "./lib/standardNotation";
import type {
  KnowledgeTree,
  TreeNode,
  TreeEdge,
} from "./lib/knowledgeTreeData";
import { computeFrontier } from "./lib/knowledgeTreeFrontier";
import type { NodeStatus } from "./lib/knowledgeTreeFrontier";

/** Graceful fallback when no curated tree has been absorbed yet. */
const EMPTY_TREE: KnowledgeTree = { domain: "Fractions", nodes: [], edges: [] };

/**
 * SHIM — read the absorbed curated nodes/edges back into the fixture-shaped
 * KnowledgeTree the pure frontier logic consumes, keyed by the tree namespace
 * (the `TREES` map key baked into each nodeKey as `${treeKey}:${key}`). The
 * namespace prefix is STRIPPED here, so every reconstructed node/edge carries
 * the bare fixture key — computeFrontier's output (and therefore the components)
 * is identical to reading the fixtures directly.
 */
async function reconstructCuratedTrees(
  ctx: QueryCtx,
): Promise<Map<string, KnowledgeTree>> {
  const nodeRows = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_source", (q) => q.eq("source", "curated"))
    .collect();

  const byPrefix = new Map<string, typeof nodeRows>();
  for (const n of nodeRows) {
    const colon = n.nodeKey.indexOf(":");
    if (colon < 0) continue; // curated keys are always namespaced
    const prefix = n.nodeKey.slice(0, colon);
    const bucket = byPrefix.get(prefix) ?? byPrefix.set(prefix, []).get(prefix)!;
    bucket.push(n);
  }

  const trees = new Map<string, KnowledgeTree>();
  for (const [prefix, rows] of byPrefix) {
    const domain = rows[0].domain;
    const nodes: TreeNode[] = rows
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((n) => ({
        key: n.nodeKey.slice(prefix.length + 1),
        label: n.label,
        standard: n.standardCodes?.[0]?.code,
        match: n.matchKeywords ?? [],
      }));
    const edgeRows = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect();
    const edges: TreeEdge[] = edgeRows
      .filter(
        (e) =>
          (e.kind === "buildsTowards" || e.kind === "requires") &&
          e.fromKey.startsWith(`${prefix}:`),
      )
      .map((e) => ({
        from: e.fromKey.slice(prefix.length + 1),
        to: e.toKey.slice(prefix.length + 1),
        kind: e.kind as "buildsTowards" | "requires",
      }));
    trees.set(prefix, { domain, nodes, edges });
  }
  return trees;
}

export const frontierForScholar = teacherQuery({
  args: { scholarId: v.id("users"), tree: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireTeacherOrSelf(ctx.user, args.scholarId);
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const trees = await reconstructCuratedTrees(ctx);
    const tree =
      trees.get(args.tree ?? "fractions") ?? trees.get("fractions") ?? EMPTY_TREE;
    const obs = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    return computeFrontier(
      tree,
      obs.map((o) => ({
        conceptLabel: o.conceptLabel,
        masteryLevel: o.masteryLevel,
        evidenceType: o.evidenceType,
        misconceptionStatus: o.misconceptionStatus,
        evidenceSummary: o.evidenceSummary,
        fluencyLevel: o.fluencyLevel,
      })),
    );
  },
});

/**
 * The directional "How this fits" spine for ONE standard (the Tree drill-in's
 * "meat on the skeleton", made directional). Maps a standard → its node in the
 * curated, code-backed Knowledge-Tree DAG (by CCSS notation), then returns the
 * LOCAL prerequisite neighborhood — what builds toward this (foundations) and
 * where this leads (buildsToward) — each bone lit by the scholar's own status
 * (demonstrated / frontier / gap / …) from computeFrontier.
 *
 * The DAG is deliberately sparse (only the curated fixtures carry edges), so
 * this returns `{ node: null }` for the vast majority of standards — the caller
 * (StandardMeat) degrades gracefully to the associative "near in meaning" list.
 * This is additive to the star map: the spine shows DIRECTION (prerequisite
 * order) the associative star map can't.
 */
export type StandardSpineNode = {
  key: string;
  label: string;
  standard?: string;
  status: NodeStatus;
  /** how this neighbor connects to the anchor: soft support vs hard gate. */
  edgeKind?: "buildsTowards" | "requires";
  fluency?: number;
};
export type StandardSpine = {
  /** the anchor standard's node, or null when no curated node covers it. */
  node: StandardSpineNode | null;
  /** nodes that build toward the anchor (its prerequisites / supports). */
  foundations: StandardSpineNode[];
  /** nodes the anchor builds toward (where it leads). */
  buildsToward: StandardSpineNode[];
  domain: string | null;
};

export const spineForStandard = teacherQuery({
  args: { standardId: v.id("standards"), scholarId: v.id("users") },
  handler: async (ctx, args): Promise<StandardSpine> => {
    requireTeacherOrSelf(ctx.user, args.scholarId);
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const empty: StandardSpine = {
      node: null,
      foundations: [],
      buildsToward: [],
      domain: null,
    };

    const standard = await ctx.db.get(args.standardId);
    if (!standard?.notation) return empty;

    // Find the curated tree + node whose CCSS tag matches this standard,
    // comparing canonicalized notations (the Tree fixtures use the cluster form
    // "3.NF.A.3"; the corpus uses "3.NF.3"). Trees are reconstructed from the
    // canonical `knowledgeNodes` (source:"curated") via the shim.
    const trees = await reconstructCuratedTrees(ctx);
    const wanted = canonicalNotation(standard.notation);
    const found = (() => {
      for (const tree of trees.values()) {
        const node = tree.nodes.find((n) => canonicalNotation(n.standard) === wanted);
        if (node) return { tree, node };
      }
      return null;
    })();
    if (!found) return empty;
    const { tree, node } = found;

    const obs = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const frontier = computeFrontier(
      tree,
      obs.map((o) => ({
        conceptLabel: o.conceptLabel,
        masteryLevel: o.masteryLevel,
        evidenceType: o.evidenceType,
        misconceptionStatus: o.misconceptionStatus,
        evidenceSummary: o.evidenceSummary,
        fluencyLevel: o.fluencyLevel,
      })),
    );
    const byKey = new Map(frontier.nodes.map((n) => [n.key, n]));
    const toSpineNode = (
      key: string,
      edgeKind?: "buildsTowards" | "requires",
    ): StandardSpineNode | null => {
      const fn = byKey.get(key);
      if (!fn) return null;
      return {
        key: fn.key,
        label: fn.label,
        standard: fn.standard,
        status: fn.status,
        fluency: fn.fluency,
        edgeKind,
      };
    };

    const self = toSpineNode(node.key);
    if (!self) return empty;
    const foundations = tree.edges
      .filter((e) => e.to === node.key)
      .map((e) => toSpineNode(e.from, e.kind))
      .filter((n): n is StandardSpineNode => n !== null);
    const buildsToward = tree.edges
      .filter((e) => e.from === node.key)
      .map((e) => toSpineNode(e.to, e.kind))
      .filter((n): n is StandardSpineNode => n !== null);

    return { node: self, foundations, buildsToward, domain: tree.domain };
  },
});

/**
 * DEV-ONLY: seed fraction mastery observations for a scholar (by username) so
 * the Knowledge Tree read shows demonstrated nodes, a frontier, and a gap.
 * Run: npx convex run knowledgeTree:devSeedFractionEvidence '{"username":"test-scholar-001"}'
 */
export const devSeedFractionEvidence = internalMutation({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (!scholar) throw new Error(`No user ${args.username}`);
    // any session for FK (mastery obs requires a sessionId; the read is by
    // scholar so ownership of this anchor session doesn't matter for the fixture)
    const session =
      (await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholar._id))
        .first()) ?? (await ctx.db.query("sessions").first());
    if (!session) throw new Error(`No session exists to anchor evidence`);

    // clear prior dev-tree obs
    const prior = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    for (const p of prior) {
      if (p.attemptContext === "dev-tree") await ctx.db.delete(p._id);
    }

    const rows: Array<{
      conceptLabel: string;
      masteryLevel: number;
      evidenceType: string;
      misconceptionStatus?: "open" | "addressed";
      evidenceSummary: string;
      fluencyLevel?: number;
    }> = [
      { conceptLabel: "Partition a whole into equal parts", masteryLevel: 4, evidenceType: "demonstration", evidenceSummary: "Split a pizza into 8 equal slices and named each as 1/8 fluently.", fluencyLevel: 3 },
      { conceptLabel: "Equivalent fractions as fair trades", masteryLevel: 3.5, evidenceType: "demonstration", evidenceSummary: "Reframed 2/4 = 1/2 as a 'fair trade' and justified it.", fluencyLevel: 2 },
      { conceptLabel: "Fraction as a number on the number line", masteryLevel: 3, evidenceType: "demonstration", evidenceSummary: "Placed 3/4 correctly between 0 and 1.", fluencyLevel: 1 },
      { conceptLabel: "Compare fractions by size (1/8 vs 1/4)", masteryLevel: 1, evidenceType: "misconception_signal", misconceptionStatus: "open", evidenceSummary: "Believes 1/8 > 1/4 because 8 > 4 — denominator size confusion." },
    ];

    let n = 0;
    for (const r of rows) {
      await ctx.db.insert("masteryObservations", {
        scholarId: scholar._id,
        conceptLabel: r.conceptLabel,
        domain: "Mathematics",
        observedAt: Date.now(),
        sessionId: session._id,
        transcriptExcerpt: "(dev fixture)",
        masteryLevel: r.masteryLevel,
        confidenceScore: 0.8,
        evidenceSummary: r.evidenceSummary,
        evidenceType: r.evidenceType,
        attemptContext: "dev-tree",
        studentInitiated: true,
        isSuperseded: false,
        misconceptionStatus: r.misconceptionStatus,
        fluencyLevel: r.fluencyLevel,
        fluencySource: r.fluencyLevel ? "external practice" : undefined,
      });
      n++;
    }
    return { scholar: scholar.name ?? args.username, inserted: n };
  },
});
