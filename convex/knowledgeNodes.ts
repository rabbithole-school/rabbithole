/**
 * The canonical knowledge-node tables (§1 of
 * review/practice/practice-engine-roadmap.html) — the ONE node store that
 * subsumes the three former graph stores (curated knowledgeTree, procedural
 * practiceSkills, and concepts/Sky). A node's IDENTITY is the skill/
 * understanding (`nodeKey` + `label`); a standards code is an OPTIONAL tag.
 *
 * This file owns ALL THREE graph-store writers that collapse into the canonical
 * node:
 *
 *   • PROCEDURAL / practice lane — `rebuild` / `rebuildPracticeNodes` ABSORB the
 *     whole-number-arithmetic practice seed graph into `knowledgeNodes` +
 *     `knowledgeNodeEdges` (kind:"buildsOn"), keyed by nodeKey, idempotent.
 *   • SKY / concept-atlas lane — `upsertConceptNodes` + `pruneStaleSkyNodes`
 *     absorb the former `concepts` table (the registry rebuilt by
 *     concepts.rebuildRegistry from mastery/seeds/standards). A concept becomes
 *     a node whose nodeKey IS its normalizedLabel and whose source is one of
 *     SKY_SOURCES. The rebuild UPSERTS by nodeKey and only ever prunes SKY nodes
 *     — practice/curated nodes are never deleted (see the guard on prune).
 *   • CURATED / knowledge-tree lane — `rebuildTree` / `rebuildTreeNodes` ABSORB
 *     the code-backed knowledgeTree fixtures (lib/knowledgeTreeData `TREES`) into
 *     `knowledgeNodes` (source:"curated", the fixture's `match[]` kept as
 *     `matchKeywords`) + `knowledgeNodeEdges` whose `kind` is PRESERVED as
 *     "buildsTowards" | "requires" (never rewritten to "buildsOn"). Idempotent
 *     upsert-by-nodeKey; prune scoped to source:"curated" (like the Sky prune).
 *
 * All three collapses live together here so the "one node store" invariant is
 * enforced in one place. See review/practice/.
 *
 * The graph is independently authored; it is not scraped or imported from
 * external practice platforms. Standards codes remain provenance tags.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
} from "./seed/wholeNumberArithmeticGraph";
import {
  FRACTION_ARITHMETIC_DOMAIN,
  FRACTION_ARITHMETIC_SKILLS,
  FRACTION_ARITHMETIC_EDGES,
} from "./seed/fractionArithmeticGraph";
import {
  PROBABILITY_DOMAIN,
  PROBABILITY_SKILLS,
  PROBABILITY_EDGES,
  PROBABILITY_IMPLIES_EDGES,
} from "./seed/probabilityGraph";
import {
  GEOMETRY_MEASUREMENT_DOMAIN,
  GEOMETRY_MEASUREMENT_SKILLS,
  GEOMETRY_MEASUREMENT_EDGES,
  GEOMETRY_MEASUREMENT_IMPLIES_EDGES,
} from "./seed/geometryMeasurementGraph";
import {
  RATIO_PROPORTION_PERCENT_DOMAIN,
  RATIO_PROPORTION_PERCENT_SKILLS,
  RATIO_PROPORTION_PERCENT_EDGES,
} from "./seed/ratioProportionPercentGraph";
import {
  INTEGERS_COORDINATES_DOMAIN,
  INTEGERS_COORDINATES_SKILLS,
  INTEGERS_COORDINATES_EDGES,
} from "./seed/integersCoordinatesGraph";
import {
  EARLY_ALGEBRA_DOMAIN,
  EARLY_ALGEBRA_SKILLS,
  EARLY_ALGEBRA_EDGES,
  EARLY_ALGEBRA_IMPLIES_EDGES,
} from "./seed/earlyAlgebraGraph";
import {
  ALGEBRA_1_DOMAIN,
  ALGEBRA_1_SKILLS,
  ALGEBRA_1_EDGES,
  ALGEBRA_1_IMPLIES_EDGES,
} from "./seed/algebra1Graph";
import {
  DISCRETE_MATH_DOMAIN,
  DISCRETE_MATH_SKILLS,
  DISCRETE_MATH_EDGES,
} from "./seed/discreteMathGraph";
import { TREES } from "./lib/knowledgeTreeData";
import { classifyDomain } from "./lib/domainTaxonomy";
import { assertCombinedGraphValid } from "./lib/practice/graphValidation";
import {
  SKY_SOURCES,
  isSkySource,
} from "../shared/knowledgeNodeSources";
import { deleteCacheOwnedEdge } from "./lib/knowledgeNodeEdges";

/**
 * The registry of practice-engine graphs. Each is a self-contained prerequisite
 * DAG absorbed into knowledgeNodes/knowledgeNodeEdges (source:"practice",
 * kind:"buildsOn"), keyed by its kebab-slug domain. Add a domain by adding a row.
 *
 * `impliesEdges` (optional) are the domain's INFERENCE-ONLY cross-domain edges
 * (kind:"implies") — they propagate implicit credit + order placement inference
 * but never gate. Absorbed alongside buildsOn, but structurally invisible to the
 * frontier gate and prereq recommendations.
 */
const PRACTICE_GRAPHS: {
  domain: string;
  skills: typeof WHOLE_NUMBER_ARITHMETIC_SKILLS;
  edges: typeof WHOLE_NUMBER_ARITHMETIC_EDGES;
  impliesEdges?: typeof WHOLE_NUMBER_ARITHMETIC_EDGES;
  /** ELECTIVE domain (enrichment territory, e.g. discrete-math): never joins
   *  the check-in denominator M and is never probed automatically, regardless
   *  of grade tags — it reaches scholars ONLY through the deliberate
   *  new-territory offer once its cross-domain prereqs converge (the
   *  raise-the-ceiling mechanism). Grade tags stay HONEST (they anchor the
   *  placement search's priors once a scholar opts in); electivity is this
   *  flag, never a sandbagged grade. Once deliberately opened, an elective run
   *  joins M via the existing in_flight precedence like any other deliberate
   *  above-ring open. */
  elective?: boolean;
}[] = [
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, skills: WHOLE_NUMBER_ARITHMETIC_SKILLS, edges: WHOLE_NUMBER_ARITHMETIC_EDGES },
  { domain: FRACTION_ARITHMETIC_DOMAIN, skills: FRACTION_ARITHMETIC_SKILLS, edges: FRACTION_ARITHMETIC_EDGES },
  { domain: PROBABILITY_DOMAIN, skills: PROBABILITY_SKILLS, edges: PROBABILITY_EDGES, impliesEdges: PROBABILITY_IMPLIES_EDGES },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, skills: GEOMETRY_MEASUREMENT_SKILLS, edges: GEOMETRY_MEASUREMENT_EDGES, impliesEdges: GEOMETRY_MEASUREMENT_IMPLIES_EDGES },
  { domain: RATIO_PROPORTION_PERCENT_DOMAIN, skills: RATIO_PROPORTION_PERCENT_SKILLS, edges: RATIO_PROPORTION_PERCENT_EDGES },
  { domain: INTEGERS_COORDINATES_DOMAIN, skills: INTEGERS_COORDINATES_SKILLS, edges: INTEGERS_COORDINATES_EDGES },
  { domain: EARLY_ALGEBRA_DOMAIN, skills: EARLY_ALGEBRA_SKILLS, edges: EARLY_ALGEBRA_EDGES, impliesEdges: EARLY_ALGEBRA_IMPLIES_EDGES },
  { domain: ALGEBRA_1_DOMAIN, skills: ALGEBRA_1_SKILLS, edges: ALGEBRA_1_EDGES, impliesEdges: ALGEBRA_1_IMPLIES_EDGES },
  // ELECTIVE — enrichment territory: offered via the reachable new-territory
  // card once its WNA prereqs converge, never force-probed (see the flag doc).
  { domain: DISCRETE_MATH_DOMAIN, skills: DISCRETE_MATH_SKILLS, edges: DISCRETE_MATH_EDGES, elective: true },
];

/** The slugs of every practice domain the engine seeds — the authoritative set.
 *  The display registry (`PRACTICE_DOMAINS` in lib/practice/domains.ts) must stay
 *  in lock-step with this (drift-tested). */
export const REGISTERED_PRACTICE_DOMAINS: readonly string[] = PRACTICE_GRAPHS.map(
  (g) => g.domain,
);

/** Domains flagged `elective` above — the check-in/eligibility loader folds
 *  this into `gradeEligible` (an elective is never grade-eligible), so the map
 *  derivation, denominator, and growth watermark need no elective awareness of
 *  their own. */
export const ELECTIVE_PRACTICE_DOMAINS: ReadonlySet<string> = new Set(
  PRACTICE_GRAPHS.filter((g) => g.elective).map((g) => g.domain),
);

/**
 * STATIC per-domain reachability meta, derived at module scope from the same
 * seed arrays `rebuildPracticeNodes` absorbs into the node tables — so it can
 * gate a cheap pre-check without a DB read, and can only drift from the DB if
 * the deployment was seeded from a different code version (drift-tested against
 * the DB derivation in newTerritoryCards.test.ts).
 *
 * `prereqDomains` mirrors `loadMixedPlacementDomains` exactly: cross-domain
 * `buildsOn` edges only (a foreign FROM-side node marks a prerequisite into
 * another domain); `impliesEdges` are inference-only and never gate.
 * `nodeGrades` feeds `domainHasAffectSafeEntry` for the ring check.
 */
export const DOMAIN_REACHABILITY_STATIC: readonly {
  domain: string;
  prereqDomains: readonly string[];
  nodeGrades: readonly { grade?: string }[];
  /** Mirrors the graph row's `elective` flag — an elective domain is a
   *  reachable-offer candidate regardless of the ring (the pre-check must not
   *  require it to be above-ring). */
  elective: boolean;
}[] = (() => {
  const domainOfKey = new Map<string, string>();
  for (const g of PRACTICE_GRAPHS)
    for (const s of g.skills) domainOfKey.set(s.skillKey, g.domain);
  return PRACTICE_GRAPHS.map((g) => {
    const prereqDomains = new Set<string>();
    for (const e of g.edges) {
      const fromDomain = domainOfKey.get(e.fromKey);
      if (fromDomain && fromDomain !== g.domain) prereqDomains.add(fromDomain);
    }
    return {
      domain: g.domain,
      prereqDomains: [...prereqDomains],
      nodeGrades: g.skills.map((s) => ({ grade: s.grade })),
      elective: g.elective === true,
    };
  });
})();

/**
 * Absorb the practice seed graph into the canonical node tables. For each seed
 * skill → upsert a `knowledgeNodes` row (by_nodeKey, source "practice"); for
 * each seed edge → clear this domain's kind:"buildsOn" `knowledgeNodeEdges`
 * then re-insert. Idempotent. Leaves any bridge/explicit edges + spatial facets
 * (skyX/treeX/…) untouched — the node table is shared across lanes. Returns the
 * node + edge counts. Shared by knowledgeNodes.rebuild and
 * practiceSkills.seedGraph (the db:seed path).
 */
export async function rebuildPracticeNodes(ctx: MutationCtx) {
  // D4 cross-domain guard: validate the COMBINED graph (every domain's nodes +
  // edges, including cross-domain `buildsOn` edges) is a well-formed DAG BEFORE
  // any writes. A cross-domain edge can only be checked against the union of all
  // graphs, and a cycle that closes THROUGH a cross-domain edge is invisible to
  // per-domain validation. Throwing here means a bad seed never lands a partial
  // graph. The DAG check spans buildsOn ∪ implies: an `implies` edge never gates,
  // but an IMPLICATION cycle would break inference (implicit-credit/placement
  // ancestor resolution assumes acyclicity), so the combined graph must stay a DAG.
  assertCombinedGraphValid(
    PRACTICE_GRAPHS.flatMap((g) => g.skills.map((s) => ({ nodeKey: s.skillKey, domain: g.domain }))),
    PRACTICE_GRAPHS.flatMap((g) => [...g.edges, ...(g.impliesEdges ?? [])]),
  );
  let nodes = 0;
  let edges = 0;
  for (const graph of PRACTICE_GRAPHS) {
    for (const [i, s] of graph.skills.entries()) {
      const existing = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", s.skillKey))
        .first();
      const row = {
        nodeKey: s.skillKey,
        label: s.label,
        domain: graph.domain,
        grade: s.grade,
        strand: s.strand,
        // Math domains are CCSS-aligned, so stamp the framework here at load.
        // A skill with no codes maps to no standard (first-class). Other domains'
        // loaders attach their own framework (NGSS, …) or none.
        standardCodes: s.ccCodes.map((code) => ({ framework: "CCSS", code })),
        rationale: s.rationale,
        order: i,
        source: "practice",
      };
      if (existing) {
        // Don't stomp a SKY node's identity when a practice skill shares its
        // nodeKey — preserve `source` so it stays sky-visible (isSkySource) and
        // keeps its standard/seed/mastery semantics. The practice engine finds
        // its skills by DOMAIN (loadDomain), not source, so this is transparent
        // to it; under Option A the node is embedded/placed either way.
        await ctx.db.patch(existing._id, isSkySource(existing.source) ? { ...row, source: existing.source } : row);
      } else await ctx.db.insert("knowledgeNodes", row);
      nodes++;
    }
    // buildsOn + implies edges: clear THIS domain's dependency/inference set and
    // re-insert (the graph is the source). Untouched: any bridge/explicit edges the
    // Sky lane owns. The FIXTURE is authoritative for dependency TOPOLOGY (a pair
    // dropped from the seed graph must disappear — dependency edges gate practice
    // access), but a `story` payload someone attached to a pair is corpus: carry it
    // across the clear+reinsert by pair. Do NOT gate deletion on isDurableEdge here
    // — every reinserted edge is method:"curated", so that predicate would make the
    // practice graph append-only (fixture removals would never propagate).
    const prior = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_domain", (q) => q.eq("domain", graph.domain))
      .collect();
    const storyByPair = new Map(
      prior
        .filter((e) => (e.kind === "buildsOn" || e.kind === "implies") && e.story !== undefined)
        .map((e) => [`${e.kind}|${e.fromKey}|${e.toKey}`, e.story]),
    );
    for (const e of prior) {
      if (e.kind === "buildsOn" || e.kind === "implies") await ctx.db.delete(e._id);
    }
    for (const e of graph.edges) {
      const story = storyByPair.get(`buildsOn|${e.fromKey}|${e.toKey}`);
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: e.fromKey,
        toKey: e.toKey,
        domain: graph.domain,
        kind: "buildsOn",
        method: "curated",
        ...(story !== undefined ? { story } : {}),
      });
      edges++;
    }
    // INFERENCE-ONLY edges (kind:"implies"): absorbed the same way, stamped with
    // this (to-side) domain. Invisible to gating (loaders/consumers filter
    // kind:"buildsOn" for the frontier gate + prereq recs); consumed only by
    // implicit-credit propagation and placement inference.
    for (const e of graph.impliesEdges ?? []) {
      const story = storyByPair.get(`implies|${e.fromKey}|${e.toKey}`);
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: e.fromKey,
        toKey: e.toKey,
        domain: graph.domain,
        kind: "implies",
        method: "curated",
        ...(story !== undefined ? { story } : {}),
      });
      edges++;
    }
  }
  await ctx.runMutation(internal.edgeStories.seedRegistry, {});
  return { nodes, edges };
}

// ── Seed: absorb the practice graph into the canonical tables (idempotent) ──

export const rebuild = internalMutation({
  args: {},
  handler: async (ctx) => rebuildPracticeNodes(ctx),
});

// ── Sky lane: absorb the concept registry into the canonical node tables ──

// The sky facets a concept contributes to a `knowledgeNodes` row. `nodeKey` IS
// the concept's normalizedLabel (identity); the standards code stays an optional
// tag. skyX/skyY are added later by the projection (conceptAtlas.projectAtlas).
export type ConceptNodeInput = {
  nodeKey: string;
  label: string;
  domain: string;
  strand?: string;
  normalizedLabel: string;
  source: string; // one of SKY_SOURCES
  embeddingText: string;
  refCount: number;
  standardId?: Id<"standards">;
};

const conceptNodeValidator = v.object({
  nodeKey: v.string(),
  label: v.string(),
  domain: v.string(),
  strand: v.optional(v.string()),
  normalizedLabel: v.string(),
  source: v.string(),
  embeddingText: v.string(),
  refCount: v.number(),
  standardId: v.optional(v.id("standards")),
});

/**
 * Upsert one batch of SKY (concept-origin) nodes by nodeKey. If a node with that
 * key already exists:
 *   • and it is itself a SKY node → full-replace its sky facets (label, domain,
 *     source, normalizedLabel, embeddingText, refCount, standardId).
 *   • and it is a NON-sky node (practice/curated sharing the key) → this is the
 *     desired practice↔concept merge: add the associative facets (normalizedLabel
 *     + refCount) so mastery observations can still light it, but PRESERVE its
 *     source/label/domain identity so the Sky prune can never delete it.
 * Otherwise insert a fresh sky node. NEVER touches treeX/treeY. Shared by the
 * upsertConceptNodesBatch mutation (called from concepts.rebuildRegistry).
 */
export async function upsertConceptNodes(ctx: MutationCtx, rows: ConceptNodeInput[]) {
  for (const r of rows) {
    const existing = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", r.nodeKey))
      .first();
    if (!existing) {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: r.nodeKey,
        label: r.label,
        domain: r.domain,
        strand: r.strand,
        normalizedLabel: r.normalizedLabel,
        source: r.source,
        embeddingText: r.embeddingText,
        refCount: r.refCount,
        standardId: r.standardId,
      });
    } else if (isSkySource(existing.source)) {
      await ctx.db.patch(existing._id, {
        label: r.label,
        domain: r.domain,
        normalizedLabel: r.normalizedLabel,
        source: r.source,
        embeddingText: r.embeddingText,
        refCount: r.refCount,
        standardId: r.standardId,
      });
    } else {
      // Merge onto a practice/curated node — keep its identity + source.
      await ctx.db.patch(existing._id, {
        normalizedLabel: r.normalizedLabel,
        refCount: r.refCount,
      });
    }
  }
  return rows.length;
}

export const upsertConceptNodesBatch = internalMutation({
  args: { rows: v.array(conceptNodeValidator) },
  handler: async (ctx, args) => upsertConceptNodes(ctx, args.rows),
});

const PRUNE_BATCH = 300;

/**
 * Delete SKY nodes that are no longer in the freshly-rebuilt registry — i.e.
 * source ∈ SKY_SOURCES and nodeKey ∉ keepKeys — along with their
 * knowledgeNodeEmbeddings and their bridge/explicit edges. Bounded to
 * PRUNE_BATCH deletions per call (returns `done:false` if more remain, so the
 * caller loops). The `isSkySource` filter is the hard guarantee that a
 * practice/curated node (or any node without a sky source) is NEVER pruned.
 */
export const pruneStaleSkyNodes = internalMutation({
  args: { keepKeys: v.array(v.string()) },
  handler: async (ctx, args) => {
    const keep = new Set(args.keepKeys);
    let deleted = 0;
    for (const source of SKY_SOURCES) {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_source", (q) => q.eq("source", source))
        .collect();
      for (const n of nodes) {
        if (keep.has(n.nodeKey)) continue;
        // A node anchoring a STORY must survive whole — check that BEFORE
        // deleting anything (deleting the embedding first would orphan the
        // vector on a node we then keep). The anchor is a story-bearing edge,
        // not any durable edge: a plain method:"curated" dependency edge is NOT
        // a story anchor (and sky nodes never touch one anyway).
        const touching = [
          ...(await ctx.db.query("knowledgeNodeEdges").withIndex("by_from", (q) => q.eq("fromKey", n.nodeKey)).collect()),
          ...(await ctx.db.query("knowledgeNodeEdges").withIndex("by_to", (q) => q.eq("toKey", n.nodeKey)).collect()),
        ];
        if (touching.some((e) => e.story !== undefined)) continue;
        const emb = await ctx.db
          .query("knowledgeNodeEmbeddings")
          .withIndex("by_node", (q) => q.eq("nodeId", n._id))
          .unique();
        if (emb) await ctx.db.delete(emb._id);
        // Sky (associative) edges are keyed by nodeKey — drop any non-durable
        // cache edge that touches this node. Tree edges belong to the
        // practice/curated lane, and durable story edges anchor their endpoints.
        for (const e of touching) {
          if (e.kind === "bridge" || e.kind === "explicit" || e.kind === "nn") {
            await deleteCacheOwnedEdge(ctx, e);
          }
        }
        await ctx.db.delete(n._id);
        deleted++;
        if (deleted >= PRUNE_BATCH) return { deleted, done: false };
      }
    }
    return { deleted, done: true };
  },
});

// ── Curated lane: absorb the code-backed knowledgeTree fixtures ────────────

/**
 * Absorb the curated, code-backed Knowledge-Tree fixtures (lib/knowledgeTreeData
 * `TREES`) into the canonical node tables. Each TreeNode → a `knowledgeNodes` row
 * (source "curated"; the fixture's `match[]` kept verbatim as `matchKeywords`;
 * the CCSS tag kept as a standardCodes entry — the RAW notation, canonicalized
 * only at read-time by knowledgeTree.spineForStandard; NO spatial facets — a
 * curated node isn't placed in either projection). Each TreeEdge → a
 * `knowledgeNodeEdges` row whose `kind` is PRESERVED as "buildsTowards" |
 * "requires" (NEVER rewritten to "buildsOn"), which is exactly what keeps these
 * soft-support / hard-gate links OUT of both the practice frontier (reads
 * kind:"buildsOn") and the Sky (kind:"bridge"|"explicit").
 *
 * Node keys are namespaced `${treeKey}:${nodeKey}` (treeKey = the `TREES` map
 * key, e.g. "fractions") so a bare, generic tree key ("compare", "evidence")
 * can never collide with a Sky node whose nodeKey is a normalized concept label.
 * Idempotent: upsert-by-nodeKey; then — mirroring pruneStaleSkyNodes' by_source
 * scoping — delete only source:"curated" nodes no longer in the fixtures, and
 * clear the curated edges (identified by kind ∈ {buildsTowards,requires}) before
 * re-inserting. Practice ("buildsOn") + Sky nodes/edges are never touched.
 * Returns the node + edge counts.
 */
export async function rebuildTreeNodes(ctx: MutationCtx) {
  const keep = new Set<string>();
  let nodes = 0;
  for (const [treeKey, tree] of Object.entries(TREES)) {
    let order = 0;
    for (const node of tree.nodes) {
      const nodeKey = `${treeKey}:${node.key}`;
      keep.add(nodeKey);
      // Canonicalize the fixture's domain + un-flatten to (domain, strand) —
      // e.g. curated "Historical thinking" → "Ways of Thinking" / "Historical
      // Thinking"; "Fractions" → "Mathematics" / "Fractions". See domainTaxonomy.
      const cls = classifyDomain(tree.domain);
      const row = {
        nodeKey,
        label: node.label,
        domain: cls.domain,
        strand: cls.strand,
        source: "curated",
        // OPTIONAL crosswalk tag — raw notation, not identity. A tag-less
        // (humanities) node is first-class.
        standardCodes: node.standard
          ? [{ framework: "CCSS", code: node.standard }]
          : undefined,
        // the observer keyword match (was TreeNode.match) — read by
        // knowledgeTree.frontierForScholar to light this node from evidence.
        matchKeywords: node.match,
        order, // fixture order, so the shim reconstructs a stable node array
      };
      const existing = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
        .first();
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert("knowledgeNodes", row);
      nodes++;
      order++;
    }
  }
  // Prune curated nodes dropped from the fixtures — scoped to source "curated"
  // (the same hard guarantee as pruneStaleSkyNodes: practice/sky nodes, lacking
  // this source, are NEVER deleted here).
  const curated = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_source", (q) => q.eq("source", "curated"))
    .collect();
  for (const n of curated) {
    if (!keep.has(n.nodeKey)) {
      const touching = [
        ...(await ctx.db.query("knowledgeNodeEdges").withIndex("by_from", (q) => q.eq("fromKey", n.nodeKey)).collect()),
        ...(await ctx.db.query("knowledgeNodeEdges").withIndex("by_to", (q) => q.eq("toKey", n.nodeKey)).collect()),
      ];
      // Keep only if a STORY anchors the node. NOT isDurableEdge: this node's own
      // method:"curated" tree edges (which this same rebuild deletes below) would
      // otherwise count as anchors and strand a fixture-dropped node as a ghost.
      if (touching.some((e) => e.story !== undefined)) continue;
      await ctx.db.delete(n._id);
    }
  }
  // Clear + reinsert the curated edges. The curated edges are exactly the
  // buildsTowards/requires kinds — disjoint from practice (buildsOn) and Sky
  // (bridge/explicit), so clearing by kind can never touch another lane.
  // As in the practice lane: the FIXTURE owns topology (deleted pairs must
  // disappear), while `story` payloads are corpus carried across the
  // clear+reinsert by pair. Never gate deletion on isDurableEdge — reinserted
  // rows are method:"curated", which would make this lane append-only.
  let edges = 0;
  const treeStoryByPair = new Map<string, Doc<"knowledgeNodeEdges">["story"]>();
  for (const kind of ["buildsTowards", "requires"] as const) {
    const prior = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_kind", (q) => q.eq("kind", kind))
      .collect();
    for (const e of prior) {
      if (e.story !== undefined) {
        treeStoryByPair.set(`${e.fromKey}|${e.toKey}|${e.kind}`, e.story);
      }
      await ctx.db.delete(e._id);
    }
  }
  for (const [treeKey, tree] of Object.entries(TREES)) {
    for (const e of tree.edges) {
      const fromKey = `${treeKey}:${e.from}`;
      const toKey = `${treeKey}:${e.to}`;
      const story = treeStoryByPair.get(`${fromKey}|${toKey}|${e.kind}`);
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey,
        toKey,
        domain: classifyDomain(tree.domain).domain,
        kind: e.kind, // PRESERVED — never collapsed to "buildsOn"
        method: "curated",
        ...(story !== undefined ? { story } : {}),
      });
      edges++;
    }
  }
  return { nodes, edges };
}

export const rebuildTree = internalMutation({
  args: {},
  handler: async (ctx) => rebuildTreeNodes(ctx),
});
