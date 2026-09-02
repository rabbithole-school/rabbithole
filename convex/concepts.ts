// Concept Atlas — the canonical registry + the read-time views over the one
// shared concept space. See review/mastery-nuggets-vs-lenses.html §5.
//
// The Sky/atlas is now absorbed into the ONE canonical `knowledgeNodes` table
// (§1 of review/practice/): a concept is a knowledgeNodes row whose
// `nodeKey` IS its normalizedLabel and whose `source` ∈ {standard,seed,mastery}
// (a SKY node), with skyX/skyY (was concepts.x/y) as its atlas position and its
// vector in `knowledgeNodeEmbeddings`. Practice/curated nodes share the table
// but carry treeX/treeY, never skyX/skyY — so every Sky READ here filters to the
// PLACED subset (`skyX != null && skyY != null`), which cleanly excludes them.
//
//   rebuildRegistry (action, here)  → SKY knowledgeNodes from 3 sources
//                                     (delegates the write to knowledgeNodes.ts)
//   conceptAtlas.embedConcepts      → embeds label+evidence → knowledgeNodeEmbeddings
//   conceptAtlas.projectAtlas       → PCA → skyX/skyY (the atlas)
//   conceptAtlas.computeEdges       → bridge/explicit/nn knowledgeNodeEdges (nodeKey-keyed)
//
// Queries here are the lenses ON the atlas: the full map, the per-scholar lit
// subset (a scholar's Sky), the class galaxy (union + convergence), and a
// read-time edge overlay (cross-domain bridges + explicit connections). The
// client contract is unchanged — nodes still return {id,label,domain,source,x,y,
// refCount} where id is the knowledgeNodes _id, x/y are skyX/skyY.
import { v } from "convex/values";
import { internalQuery, internalMutation, internalAction } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { authedQuery, teacherQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { strandForStandard } from "./lib/standardStrand";
import { classifyDomain } from "./lib/domainTaxonomy";
import { hopTiers } from "./lib/skyField";
import { buildScholarSky, SKY_FULL_LIVE_POOL } from "./lib/seeds";
import { buildMasteryStars, buildStarterLayer, placeMuseumFloats } from "./lib/skyMuseum";
import { cleanSeedLabel } from "./lib/seedLabel";
import { DEPENDENCY_KINDS } from "../shared/edgeOntology";
import { selectSkySeedCandidates } from "./lib/skySeedSelection";
import {
  isAtlasSource,
  isSkySource,
  isTreeSource,
  isWorldSource,
} from "../shared/knowledgeNodeSources";
import { deleteCacheOwnedEdge } from "./lib/knowledgeNodeEdges";
import { resolveInstitutionLens, scholarIdsInLens } from "./lib/institutionLens";
import { ROLES, isPlatformAdminRole } from "./lib/roles";
import { isEnrolledScholar } from "./lib/enrollmentStanding";
import {
  accessibleScholarIds,
  resolveActiveMembership,
} from "./lib/access";
import { SEED_CONSIDERATION_CAP, SKY_FIELD_SEED_CAP, SKY_COLD_START_MIN_STARS } from "../shared/skyTiers";
import type { Id } from "./_generated/dataModel";

// ─── helpers ────────────────────────────────────────────────────────
export function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function skyDisplayLabel(c: PlacedNode): string {
  return c.source === "seed" ? cleanSeedLabel(c.label) : c.label;
}

const STANDARDS_CAP = 320; // keep the grounded backbone rich but not overwhelming

// Display + compute caps. Prod's atlas is dominated by thousands of per-scholar
// exploration seeds (2500+), which would (a) render thousands of DOM stars and
// (b) blow the O(n²) bridge cosine. Bound both: always keep the structural
// backbone (standards + mastery) + any force-kept ids, then fill the remaining
// budget with the highest-refCount seeds.
const MAX_ATLAS_NODES = 900;

type PlacedNode = {
  _id: Id<"knowledgeNodes">; nodeKey: string; label: string; domain: string;
  source?: string; normalizedLabel?: string; skyX?: number; skyY?: number;
  refCount?: number; standardId?: Id<"standards">;
};

/** Cap the placed nodes for display: always keep the scholar's `keepIds` (touched)
 *  + the SKY backbone (standards/mastery); seeds AND the tech-tree skills
 *  (practice/curated, Option A) are trimmable backdrop, trimmed lowest-refCount
 *  first, to MAX_ATLAS_NODES — so an over-cap Sky sheds far-field skill/seed stars
 *  first, never the touched set or the backbone. */
function capForDisplay<T extends PlacedNode>(placed: T[], keepIds?: Set<string>): T[] {
  if (placed.length <= MAX_ATLAS_NODES) return placed;
  const forced: T[] = [], backdrop: T[] = [];
  for (const c of placed) {
    if (keepIds?.has(c._id) || (c.source !== "seed" && !isTreeSource(c.source))) forced.push(c);
    else backdrop.push(c);
  }
  backdrop.sort((a, b) => (b.refCount ?? 1) - (a.refCount ?? 1));
  return [...forced, ...backdrop].slice(0, Math.max(MAX_ATLAS_NODES, forced.length));
}

/** A knowledgeNodes doc is PLACED in the Sky iff it has skyX/skyY — the marker
 *  the projection stamps ONLY on sky-source nodes, so this cleanly excludes
 *  practice/curated nodes from every atlas read. */
function isPlaced(n: { skyX?: number; skyY?: number }): boolean {
  return n.skyX != null && n.skyY != null;
}

// ─── source readers (internal) ─────────────────────────────────────
export const _masterySources = internalQuery({
  args: {},
  handler: async (ctx) => {
    const obs = await ctx.db.query("masteryObservations").collect();
    // current (non-superseded), non-misconception; best evidence per concept label
    const byLabel = new Map<string, { label: string; domain: string; evidence: string; n: number }>();
    for (const o of obs) {
      if (o.isSuperseded) continue;
      if (o.evidenceType === "misconception_signal") continue;
      const key = normalizeLabel(o.conceptLabel);
      const cur = byLabel.get(key);
      if (!cur) byLabel.set(key, { label: o.conceptLabel, domain: o.domain, evidence: o.evidenceSummary ?? "", n: 1 });
      else cur.n += 1;
    }
    return [...byLabel.values()];
  },
});

export const _seedSources = internalQuery({
  args: {},
  handler: async (ctx) => {
    const seeds = await ctx.db.query("seeds").collect();
    const byTopic = new Map<string, { label: string; domain: string; evidence: string }>();
    for (const s of seeds) {
      const key = normalizeLabel(s.topic);
      if (byTopic.has(key)) continue;
      byTopic.set(key, { label: s.topic, domain: s.domain ?? "exploration", evidence: s.rationale ?? s.scholarInvitation ?? "" });
    }
    return [...byTopic.values()];
  },
});

export const _standardSources = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("standards").withIndex("by_subject_leaf").collect();
    const leaves = all.filter((s) => s.isLeaf && (s.description || s.understanding));
    // Spread the cap across subjects so the backbone isn't all one discipline.
    const bySubject = new Map<string, typeof leaves>();
    for (const s of leaves) {
      const arr = bySubject.get(s.subject) ?? [];
      arr.push(s);
      bySubject.set(s.subject, arr);
    }
    const perSubject = Math.max(20, Math.floor(STANDARDS_CAP / Math.max(1, bySubject.size)));
    const picked: { label: string; domain: string; text: string; standardId: Id<"standards"> }[] = [];
    for (const [subject, arr] of bySubject) {
      const step = Math.max(1, Math.floor(arr.length / perSubject));
      for (let i = 0; i < arr.length && picked.filter((p) => p.domain.startsWith(subject.slice(0, 3))).length < perSubject; i += step) {
        const s = arr[i];
        const strand = strandForStandard(s.subject, s.notation);
        picked.push({
          label: s.understanding ?? s.description.slice(0, 70),
          domain: strand?.label ?? subject,
          text: `${s.notation}: ${s.understanding ?? s.description}`,
          standardId: s._id,
        });
      }
    }
    return picked.slice(0, STANDARDS_CAP);
  },
});

/**
 * Rebuild the canonical SKY registry from all three sources (mastery, seeds,
 * standards), deduped by normalized label. Mastery + seeds win over a standard
 * with the same label (the learner's framing is the canonical one). A concept
 * becomes a `knowledgeNodes` row whose nodeKey IS its normalizedLabel. Idempotent:
 * UPSERTS the new set by nodeKey, then PRUNES sky nodes that vanished — the write
 * lives in knowledgeNodes.ts (next to the practice-lane writer) so both collapses
 * share one code path and the "never delete a practice node" guard. Returns
 * counts by source.
 */
export const rebuildRegistry = internalAction({
  args: {},
  handler: async (ctx): Promise<{ total: number; bySource: Record<string, number> }> => {
    const [mastery, seeds, standards] = await Promise.all([
      ctx.runQuery(internal.concepts._masterySources, {}),
      ctx.runQuery(internal.concepts._seedSources, {}),
      ctx.runQuery(internal.concepts._standardSources, {}),
    ]);

    type Row = { nodeKey: string; label: string; normalizedLabel: string; domain: string; strand?: string; source: string; embeddingText: string; refCount: number; standardId?: Id<"standards"> };
    const byNorm = new Map<string, Row>();
    // standards first (lowest priority), then seeds, then mastery (highest).
    // classifyDomain() canonicalizes the raw source domain + UN-FLATTENS strands
    // (e.g. "Reading" → domain "ELA/Literacy", strand "Reading") — see
    // convex/lib/domainTaxonomy.ts.
    for (const s of standards) {
      const key = normalizeLabel(s.label);
      const c = classifyDomain(s.domain);
      byNorm.set(key, { nodeKey: key, label: s.label, normalizedLabel: key, domain: c.domain, strand: c.strand, source: "standard", embeddingText: s.text, refCount: 1, standardId: s.standardId });
    }
    for (const s of seeds) {
      const key = normalizeLabel(s.label);
      const text = s.evidence ? `${s.label}. ${s.evidence}` : s.label;
      const c = classifyDomain(s.domain);
      byNorm.set(key, { nodeKey: key, label: s.label, normalizedLabel: key, domain: c.domain, strand: c.strand, source: "seed", embeddingText: text, refCount: 1 });
    }
    for (const m of mastery) {
      const key = normalizeLabel(m.label);
      // label + evidence — the spike-validated knob that sharpens placement
      const text = m.evidence ? `${m.label}. ${m.evidence}` : m.label;
      const c = classifyDomain(m.domain);
      byNorm.set(key, { nodeKey: key, label: m.label, normalizedLabel: key, domain: c.domain, strand: c.strand, source: "mastery", embeddingText: text, refCount: m.n });
    }

    const rows = [...byNorm.values()];
    // Upsert the sky nodes by nodeKey (batched — the source tables can be large).
    for (let i = 0; i < rows.length; i += 150) {
      await ctx.runMutation(internal.knowledgeNodes.upsertConceptNodesBatch, { rows: rows.slice(i, i + 150) });
    }
    // Prune sky nodes (and their embeddings + bridge/explicit edges) no longer in
    // the registry — bounded batches, looping until done. NEVER touches practice
    // nodes (the mutation only considers source ∈ SKY_SOURCES).
    const keepKeys = rows.map((r) => r.nodeKey);
    for (;;) {
      const { done } = await ctx.runMutation(internal.knowledgeNodes.pruneStaleSkyNodes, { keepKeys });
      if (done) break;
    }
    const bySource: Record<string, number> = {};
    for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    return { total: rows.length, bySource };
  },
});

// ─── views ON the atlas ─────────────────────────────────────────────

/** The full shared atlas: every placed SKY node (positions + domain + source).
 *  `total` counts the sky registry (placed or not); practice/curated nodes in
 *  the shared table are excluded throughout by the sky-source + placed filters. */
export const getAtlas = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("knowledgeNodes").collect();
    const sky = all.filter((n) => isSkySource(n.source) || isWorldSource(n.source));
    const placed = sky.filter(isPlaced);
    const shown = capForDisplay(placed as PlacedNode[]);
    return {
      ready: placed.length > 0,
      total: sky.length,
      embedded: placed.length,
      shown: shown.length,
      nodes: shown.map((c) => ({ id: c._id, label: skyDisplayLabel(c), domain: c.domain, source: c.source ?? "", x: c.skyX as number, y: c.skyY as number, refCount: c.refCount ?? 1 })),
    };
  },
});

/**
 * Read-time edge overlay: the sparse, meaningful links drawn on the atlas.
 * These are PRECOMPUTED at build time (conceptAtlas.computeEdges) and stored in
 * `knowledgeNodeEdges`, so this query just reads that subset — it never reads
 * the thousands of 512-d node embeddings or runs the O(n²) cosine (which blew
 * the per-query read/compute budget at prod scale). Returns explicit cross-
 * domain connections + the strongest embedding bridges ONLY — the dense per-node
 * "nn" associative edges (also in this table) are deliberately excluded here, as
 * ~thousands of them on the atlas would be visual soup; they surface only in the
 * per-node NodeDrawer.
 */
export const getAtlasEdges = teacherQuery({
  args: { maxBridges: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const max = args.maxBridges ?? 40;
    // Edges are stored KEY-based (fromKey/toKey = nodeKeys). Resolve them to the
    // knowledgeNodes _ids the client matches against getAtlas's node.id, over the
    // PLACED sky nodes only — so the return contract is byte-identical.
    const idByKey = new Map<string, Id<"knowledgeNodes">>();
    for (const n of await ctx.db.query("knowledgeNodes").collect()) {
      if (isPlaced(n)) idByKey.set(n.nodeKey, n._id);
    }
    const explicitRows = await ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", "explicit")).collect();
    const bridgeRows = await ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", "bridge")).collect();
    const explicit = explicitRows.flatMap((e) => {
      const source = idByKey.get(e.fromKey), target = idByKey.get(e.toKey);
      return source && target ? [{ source, target, type: "connection" }] : [];
    });
    const bridges = bridgeRows
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .flatMap((e) => {
        const source = idByKey.get(e.fromKey), target = idByKey.get(e.toKey);
        return source && target ? [{ source, target, type: "bridge", w: +(e.weight ?? 0).toFixed(3) }] : [];
      })
      .slice(0, max);
    return { explicit, bridges };
  },
});

// ─── Edge-build internals (read by the computeEdges action; written back) ──
export const _crossDomainConns = internalQuery({
  args: {},
  handler: async (ctx) => {
    const conns = await ctx.db.query("crossDomainConnections").collect();
    return conns.map((c) => ({ conceptLabels: c.conceptLabels }));
  },
});

/** Clear the Sky's associative edges (bridge/explicit/nn) from the shared edge
 *  table. Leaves the tech-tree edges (buildsOn/buildsTowards/requires) untouched,
 *  and preserves story-bearing / curated corpus edges. */
export const _clearEdges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const bridges = await ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", "bridge")).collect();
    const explicit = await ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", "explicit")).collect();
    const nn = await ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", "nn")).collect();
    let deleted = 0;
    for (const e of [...bridges, ...explicit, ...nn]) {
      if (await deleteCacheOwnedEdge(ctx, e)) deleted++;
    }
    return deleted;
  },
});

/** The tech-tree edge pairs (buildsOn/buildsTowards/requires) — passed to
 *  buildNeighborEdges so the prereq lattice is never duplicated as an
 *  associative "nn" edge. */
export const _treeEdgePairs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = (
      await Promise.all(
        DEPENDENCY_KINDS.map((kind) =>
          ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", kind)).collect(),
        ),
      )
    ).flat();
    return rows.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
  },
});

/** STORY-bearing edge pairs the atlas cache builders must not duplicate with a
 *  cosine bridge/nn. Only stories, NOT all durable edges: dependency pairs are
 *  already excluded via `_treeEdgePairs`, and excluding them here too would
 *  suppress the cross-domain cosine bridge that is the ONLY thing the atlas
 *  renders for such a pair (the dependency edge itself isn't drawn there). */
export const _storyEdgePairs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = (
      await Promise.all(
        (["registry", "authored", "generated"] as const).map((provenance) =>
          ctx.db
            .query("knowledgeNodeEdges")
            .withIndex("by_story_provenance", (q) =>
              q.eq("story.provenance", provenance),
            )
            .collect(),
        ),
      )
    ).flat();
    return rows.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
  },
});

// Sky edges are cross-domain associative links, not domain-scoped prereqs, so
// they carry this sentinel `domain` (the practice lane's by_domain reads all
// filter kind==="buildsOn", so the value is inert to them).
const SKY_EDGE_DOMAIN = "sky";

export const _insertEdges = internalMutation({
  args: {
    rows: v.array(v.object({
      fromKey: v.string(), toKey: v.string(), kind: v.string(), weight: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    for (const r of args.rows) {
      const method =
        r.kind === "explicit" ? "observed" : r.kind === "nn" ? "nn" : "embedding";
      await ctx.db.insert("knowledgeNodeEdges", { ...r, method, domain: SKY_EDGE_DOMAIN });
    }
    return args.rows.length;
  },
});

/**
 * A scholar's Sky = the shared atlas, with THEIR concepts lit. The lit subset has
 * three roles that the renderer draws distinctly (mirrors the design spike):
 *   • `lit`         — mastery concepts (id → mastery level, sized/bright stars)
 *   • `standardLit` — the normative standards they've demonstrated (grounded backbone)
 *   • `seeds`       — pulled-next invitations (hollow), curated + capped
 * `threads` are their personal constellation lines: mastery→standard (demonstrated)
 * and mastery→seed (pulled-next, via the seed's `connectionTo`). Teacher- or self-facing.
 *
 * `skyFieldForScholar` (below) extends this with a FOURTH role, `starter` — see
 * its own doc comment.
 */
// The at-rest consideration set: a legible Sky lights a HANDFUL of seed
// invitations as tier-0 stars, not hundreds of accrued seeds. Single source of
// truth in shared/skyTiers.ts (native vendors it). Seeds past the cap are NOT
// dropped — they lose tier-0 prominence and join the field (their placed concept
// stays in `nodes`, or an unmatched seed free-floats at a deeper hopTier),
// revealed on zoom like any other territory.
const SCHOLAR_SEED_CAP = SEED_CONSIDERATION_CAP;

// Hop-tier stamped on an UNMATCHED seed that overflows the consideration set.
// It has no place in the prereq graph, so it can't earn a real hop distance;
// this lands it in the near/deep field (classifySkyNode maps hopTier 1–2 → tier
// 2) so it reveals on zoom instead of shining at rest — never dropped.
const OVERFLOW_SEED_HOP_TIER = 2;

async function buildScholarAtlas(ctx: Pick<QueryCtx, "db">, scholarId: Id<"users">) {
  const placed = (await ctx.db.query("knowledgeNodes").collect()).filter(isPlaced);
  const byNorm = new Map<string, Id<"knowledgeNodes">>();
  for (const c of placed) if (c.normalizedLabel) byNorm.set(c.normalizedLabel, c._id);
  // standardId → node id, so a demonstrated standard lights its grounded node
  const byStandardId = new Map<string, Id<"knowledgeNodes">>();
  for (const c of placed) if (c.source === "standard" && c.standardId) byStandardId.set(c.standardId as string, c._id);

  const obs = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_current", (q) => q.eq("scholarId", scholarId).eq("isSuperseded", false))
    .collect();
  const lit: Record<string, number> = {};
  const standardLit = new Set<string>();
  const threadSet = new Set<string>(); // "a|b" dedup
  for (const o of obs) {
    if (o.evidenceType === "misconception_signal") continue;
    const mid = byNorm.get(normalizeLabel(o.conceptLabel));
    if (mid) lit[mid] = Math.max(lit[mid] ?? 0, o.masteryLevel);
    for (const sid of o.standardIds ?? []) {
      const scid = byStandardId.get(sid as string);
      if (!scid) continue;
      standardLit.add(scid as string);
      if (mid) threadSet.add(`${mid}|${scid}`); // mastery → standard demonstrated
    }
  }

  // Pulled-next seeds (pending/active), curated: keep threaded ones first, then most-recent, capped.
  const seedRows = (await ctx.db.query("seeds").withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId)).collect())
    .filter((s) => s.status === "pending" || s.status === "active");
  const seedCands: { cid: string; mid?: string; threaded: boolean; t: number }[] = [];
  for (const s of seedRows) {
    const cid = byNorm.get(normalizeLabel(s.topic));
    if (!cid || (cid as string) in lit) continue; // a seed already mastered isn't "pulled next"
    const mid = s.connectionTo ? byNorm.get(normalizeLabel(s.connectionTo)) : undefined;
    seedCands.push({ cid: cid as string, mid: mid as string | undefined, threaded: !!(mid && (mid as string) in lit), t: s._creationTime });
  }
  seedCands.sort((a, b) => (Number(b.threaded) - Number(a.threaded)) || (b.t - a.t));
  const seedIds: Id<"knowledgeNodes">[] = [];
  const seenSeed = new Set<string>();
  for (const c of seedCands) {
    if (seenSeed.has(c.cid)) continue;
    seenSeed.add(c.cid);
    seedIds.push(c.cid as Id<"knowledgeNodes">);
    if (c.mid && c.mid in lit) threadSet.add(`${c.mid}|${c.cid}`); // mastery → pulled-next seed
    if (seedIds.length >= SCHOLAR_SEED_CAP) break;
  }
  const threads = [...threadSet].map((t) => t.split("|") as [string, string]);

  // Always keep this scholar's lit + standard + seed nodes; cap the dimmed backdrop.
  const touchedIds = new Set<string>([...Object.keys(lit), ...standardLit, ...seedIds.map((id) => id as string)]);
  const shown = capForDisplay(placed as PlacedNode[], touchedIds);

  const atlas = {
    nodes: shown.map((c) => ({ id: c._id, label: skyDisplayLabel(c), domain: c.domain, source: c.source ?? "", x: c.skyX as number, y: c.skyY as number, refCount: c.refCount ?? 1 })),
    lit,
    standardLit: [...standardLit],
    seeds: seedIds,
    threads,
    litCount: Object.keys(lit).length,
  };

  return { atlas, shown, touchedIds, placed };
}

export const atlasForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { atlas } = await buildScholarAtlas(ctx, args.scholarId);
    return atlas;
  },
});

export const skyFieldForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const base = await buildScholarAtlas(ctx, args.scholarId);

    // The FOURTH role (see the doc comment on `buildScholarAtlas` above):
    // `starter` — display-only cold-start stars blended in near the bottom of
    // this handler, once the seed floats are computed. Both `lit`'s mastery
    // entries and `starter`'s entries are extended below with the practice
    // engine's own fluency-driven "night museum" layers (skyMuseum.ts),
    // additively — every existing masteryObservations-driven `lit` entry is
    // untouched.

    // ── Seed-meta + free-float + the consideration cap ─────────────────────
    // The engine needs, per seed star: the seedId (to launch "Begin Quest" via
    // createFromSeed) + the scholar-facing blurb + pinned/visited/completed/
    // structured flags. Reuse buildScholarSky so the redaction (blurb =
    // scholarInvitation ?? rationale; teacher rationale/origin nulled at the
    // wire), the visit tally and the flags match the home Sky EXACTLY — no drift.
    // Ask for the FULL live pool (not the default consideration slice) so we can
    // build metadata for every live invitation, including zoom-revealed overflow.
    //
    // Only a HANDFUL of seeds are tier-0 invitations (the consideration set —
    // this surface's own SKY_FIELD_SEED_CAP, not the shared list/galaxy bound).
    // Matched concepts and unmatched free-floats compete in ONE ranking. This is
    // critical: graph matching is a placement detail, not a quality signal, and
    // must not let a stale cluster consume every highlighted slot.
    // Seeds past the cap are NEVER dropped: a matched overflow seed's concept is
    // already a placed node in `nodes` at its real hopTier, and an unmatched
    // overflow seed still free-floats — just at a deeper hopTier (no ring), so it
    // joins the field and reveals on zoom like any other territory. Every live
    // seed retains metadata so it becomes tappable when its tier appears.
    const skyStars = await buildScholarSky(ctx, args.scholarId, {
      liveCap: SKY_FULL_LIVE_POOL,
    }); // scholar-safe payload; full live pool
    type SeedMeta = {
      // "seed" = a real teacher/AI-suggested invitation (launches "Begin
      // Quest" via `seedId`). "mastery"/"starter" are the night-museum's
      // display-only layers (see convex/lib/skyMuseum.ts) — no seedId, no
      // CTA; the client renders `blurb` with no action button.
      kind: "seed" | "mastery" | "starter";
      seedId?: string; blurb: string; pinned: boolean; structured: boolean;
      visited: boolean; visitCount: number; completed: boolean; suggestionType: string;
      // The cross-domain on-ramp target drill (stamped on the seed row), or null.
      // Carried so a star drawer's "practice this" invitation can route straight
      // into the pointed-at drill (e.g. the fractions on-ramp →
      // "fraction-arithmetic"). NOTE: no client reads this yet on either
      // frontend — it's wire-ready for that CTA, not currently rendered.
      practiceDomain: string | null;
      // The skill's sub-thread (e.g. "counting") — mastery/starter-frontier
      // only, so the drawer eyebrow can read "counting · you built this"
      // instead of the coarser discipline domain. Null for real seeds.
      strand: string | null;
    };
    const metaOf = (s: (typeof skyStars)[number]): SeedMeta => ({
      kind: "seed",
      seedId: String(s._id), blurb: s.blurb, pinned: s.pinned, structured: s.structured,
      visited: s.visited, visitCount: s.visitCount, completed: s.completed, suggestionType: s.suggestionType,
      practiceDomain: s.practiceDomain ?? null,
      strand: null,
    });

    // Match against every placed concept, not only the capped backdrop. A newly
    // selected matched invitation is appended to the display set below if needed.
    const placedByNorm = new Map<string, PlacedNode>();
    for (const node of base.placed as PlacedNode[]) {
      if (node.normalizedLabel) placedByNorm.set(node.normalizedLabel, node);
      if (node.source === "seed") {
        placedByNorm.set(normalizeLabel(cleanSeedLabel(node.label)), node);
      }
    }
    const rankedCandidates = skyStars.flatMap((star, recencyRank) => {
      if (star.completed) return [];
      const placed = placedByNorm.get(normalizeLabel(star.topic));
      if (placed && base.atlas.lit[String(placed._id)] !== undefined) {
        return [];
      }
      const anchor = star.connectionTo
        ? placedByNorm.get(normalizeLabel(star.connectionTo))
        : undefined;
      return [
        {
          targetId: placed ? String(placed._id) : `seed:${star._id}`,
          domain: star.domain,
          connectionTo: star.connectionTo,
          suggestionType: star.suggestionType,
          reach: star.reach,
          curated: star.curated,
          pinned: star.pinned,
          structured: star.structured,
          threaded: !!(
            anchor && base.atlas.lit[String(anchor._id)] !== undefined
          ),
          recencyRank,
        },
      ];
    });
    const selected = selectSkySeedCandidates(
      rankedCandidates,
      SKY_FIELD_SEED_CAP,
    );
    const selectedIds = selected.map((candidate) => candidate.targetId);
    const selectedSet = new Set(selectedIds);
    const matchedTargets = new Set(
      rankedCandidates
        .map((candidate) => candidate.targetId)
        .filter((id) => !id.startsWith("seed:")),
    );

    const shownById = new Map(
      base.shown.map((node) => [String(node._id), node as PlacedNode]),
    );
    const placedById = new Map(
      (base.placed as PlacedNode[]).map((node) => [String(node._id), node]),
    );
    // Every matched live invitation must exist in the payload. Only the ranked
    // SKY_FIELD_SEED_CAP are prominent; the rest retain graph placement at a
    // deeper tier.
    for (const id of matchedTargets) {
      const node = placedById.get(id);
      if (node) shownById.set(id, node);
    }
    const shown = [...shownById.values()];

    const idByKey = new Map<string, string>();
    for (const node of shown) idByKey.set(node.nodeKey, node._id as string);

    // The prereq/unlock lattice is all THREE tree kinds — buildsOn (practice) +
    // buildsTowards/requires (curated tree) — not buildsOn alone.
    const edgeRows = (
      await Promise.all(
        DEPENDENCY_KINDS.map((kind) =>
          ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", kind)).collect(),
        ),
      )
    ).flat();
    const prereqEdges = edgeRows.flatMap((edge) => {
      const s = idByKey.get(edge.fromKey);
      const t = idByKey.get(edge.toKey);
      return s && t ? [{ s, t }] : [];
    });

    const practiceRows = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const touched = new Set<string>([
      ...Object.keys(base.atlas.lit),
      ...base.atlas.standardLit,
      ...selectedIds.filter((id) => !id.startsWith("seed:")),
    ]);
    for (const r of practiceRows) {
      const id = idByKey.get(r.skillKey);
      if (id) touched.add(id);
    }
    const tiers = hopTiers(
      touched,
      prereqEdges,
      shown.map((node) => node._id as string),
    );

    // normalizedLabel → placed concept id, over the final display set.
    const cidByNorm = new Map<string, string>();
    const nodeById = new Map<string, PlacedNode>();
    const domAgg: Record<string, { x: number; y: number; n: number }> = {};
    for (const n of shown) {
      if (n.normalizedLabel) cidByNorm.set(n.normalizedLabel, n._id as string);
      if (n.source === "seed") cidByNorm.set(normalizeLabel(cleanSeedLabel(n.label)), n._id as string);
      nodeById.set(n._id as string, n);
      const d = n.domain || "exploration";
      const a = (domAgg[d] ??= { x: 0, y: 0, n: 0 });
      a.x += (n.skyX as number) ?? 50; a.y += (n.skyY as number) ?? 50; a.n++;
    }
    // deterministic ±jitter in the 0..100 sky space, stable per seed
    const jitter = (key: string, spread: number) => {
      let h = 2166136261; for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
      return (((h >>> 0) % 1000) / 1000 - 0.5) * 2 * spread;
    };

    const seedMeta: Record<string, SeedMeta> = {};
    const floatNodes: { id: string; label: string; domain: string; source: string; x: number; y: number; refCount: number; hopTier: number }[] = [];
    for (const star of skyStars) {
      const cid = cidByNorm.get(normalizeLabel(star.topic));
      if (cid) {
        if (!star.completed && !seedMeta[cid]) seedMeta[cid] = metaOf(star);
        continue;
      }
      // Unmatched: float pending/active invitations (not terminal completed ones).
      if (star.completed) continue;
      const anchorCid = star.connectionTo ? cidByNorm.get(normalizeLabel(star.connectionTo)) : undefined;
      const anchor = anchorCid ? nodeById.get(anchorCid) : undefined;
      const dom = star.domain || "exploration";
      const dc = domAgg[dom];
      const baseX = anchor ? (anchor.skyX as number) : dc ? dc.x / dc.n : 50 + jitter(star._id + "x", 30);
      const baseY = anchor ? (anchor.skyY as number) : dc ? dc.y / dc.n : 50 + jitter(star._id + "y", 30);
      const spread = anchor ? 6 : 10;
      const id = `seed:${star._id}`;
      const tier0 = selectedSet.has(id);
      floatNodes.push({
        id, label: cleanSeedLabel(star.topic), domain: dom, source: "seed",
        x: Math.max(2, Math.min(98, baseX + jitter(star._id + "jx", spread))),
        y: Math.max(2, Math.min(98, baseY + jitter(star._id + "jy", spread))),
        refCount: 1, hopTier: tier0 ? 0 : OVERFLOW_SEED_HOP_TIER,
      });
      seedMeta[id] = metaOf(star);
    }

    const standardTargets = new Set(base.atlas.standardLit as string[]);
    const threadSet = new Set(
      base.atlas.threads
        .filter(([, target]) => standardTargets.has(target))
        .map(([source, target]) => `${source}|${target}`),
    );
    for (const star of skyStars) {
      const target =
        cidByNorm.get(normalizeLabel(star.topic)) ?? `seed:${star._id}`;
      if (!selectedSet.has(target) || !star.connectionTo) continue;
      const anchor = cidByNorm.get(normalizeLabel(star.connectionTo));
      if (anchor && base.atlas.lit[anchor] !== undefined) {
        threadSet.add(`${anchor}|${target}`);
      }
    }

    // ── Night-museum layers (lit constellations + warm cold-start) ─────────
    // Two ADDITIVE, display-only layers blended into this SAME field, right
    // alongside the seed floats above — see convex/lib/skyMuseum.ts. Mastery
    // float stars always show (the scholar's demonstrated-fluent practice
    // skills); the starter layer blends in only while the scholar's real sky
    // (`skyStars`, the exact same live pool the seed floats above read) is
    // still nearly empty. Placed near their domain's centroid exactly like an
    // unmatched seed float above (`placeMuseumFloats` is that same recipe,
    // pulled out to skyMuseum.ts so it's shared/testable).
    const domainCentroid = (domain: string) => {
      const dc = domAgg[domain];
      return dc ? { x: dc.x / dc.n, y: dc.y / dc.n } : undefined;
    };
    const museumMastery = await buildMasteryStars(ctx, args.scholarId);
    const museumStarter =
      skyStars.length < SKY_COLD_START_MIN_STARS
        ? await buildStarterLayer(ctx, args.scholarId)
        : [];
    const placedMastery = placeMuseumFloats(museumMastery, "mastery", { domainCentroid, jitter });
    const placedStarter = placeMuseumFloats(museumStarter, "starter", { domainCentroid, jitter });
    const extraLit: Record<string, number> = {};
    const starterIds: string[] = [];
    for (const placed of [...placedMastery.stars, ...placedStarter.stars]) {
      floatNodes.push(placed.node);
      seedMeta[placed.node.id] = {
        kind: placed.role,
        blurb: placed.blurb,
        pinned: false,
        structured: false,
        visited: false,
        visitCount: 0,
        completed: false,
        suggestionType: "",
        practiceDomain: null,
        strand: placed.strand,
      };
      if (placed.role === "mastery") extraLit[placed.node.id] = 1;
      else starterIds.push(placed.node.id);
    }
    const mergedLit = { ...base.atlas.lit, ...extraLit };
    // The mastery layer's own faint nearest-neighbor constellation edges (same
    // domain, connected into a recognizable shape — see skyMuseum.ts
    // constellationEdges) ride the SAME `threads` field as every other
    // connective line the atlas draws, so both frontends render them with the
    // existing faint style for free.
    for (const [a, b] of placedMastery.edges) threadSet.add(`${a}|${b}`);

    return {
      ...base.atlas,
      lit: mergedLit,
      litCount: Object.keys(mergedLit).length,
      nodes: [
        ...shown.map((node) => ({
          id: node._id,
          label: skyDisplayLabel(node),
          domain: node.domain,
          source: node.source ?? "",
          x: node.skyX as number,
          y: node.skyY as number,
          refCount: node.refCount ?? 1,
          hopTier: tiers.get(node._id as string) ?? 3,
        })),
        ...floatNodes,
      ],
      seeds: selectedIds,
      // Cold-start "someday" stars (see skyMuseum.ts) — the atlas's third
      // display-only role alongside `lit`/`standardLit`/`seeds`.
      starter: starterIds,
      threads: [...threadSet].map((thread) => thread.split("|") as [string, string]),
      seedMeta,
      prereqEdges,
    };
  },
});

// Class Galaxy caps. The galaxy is the UNION of every in-scope scholar's Sky, so
// the raw star/thread/seed set grows with the cohort. Bound the synthetic seed
// float layer (matched seeds already ride real placed nodes) so prod's thousands
// of exploration seeds can't explode the payload: keep each scholar's freshest
// invitations, then a global ceiling (threaded/recent first).
const GALAXY_SEED_PER_SCHOLAR = SEED_CONSIDERATION_CAP;
const GALAXY_FLOAT_CAP = 140;

/**
 * The Class Galaxy: the UNION of every in-scope scholar's Sky on the one shared
 * atlas — the same stars and constellation lines each scholar sees, overlaid and
 * lightly de-densified. A concept aggregates roles ACROSS scholars:
 *   • `heat[id]`  — # scholars who've demonstrated it (mastery). ≥2 = a CONVERGENCE
 *                   (multiple kids independently circling the same idea → the
 *                   teacher's group-assignment cue).
 *   • `reached`   — standard concepts ≥1 scholar has demonstrated toward.
 *   • `seeds`     — concepts that are a live invitation for SOMEONE in the cohort
 *                   (gold ring). Matched seeds ride their real placed node; a seed
 *                   with no placed concept free-floats as a synthetic node whose id
 *                   is namespaced per scholar (`seed:<scholarId>:<seedId>`).
 *   • `threads`   — the union of every scholar's constellation lines
 *                   (mastery→standard demonstrated, mastery→pulled-next seed).
 * Teacher-facing. Scoped by the institution lens (`scope`) and, optionally, a
 * single scholar group (`groupId`).
 *
 * Perf: reads the placed knowledgeNodes ONCE, then per in-scope scholar does two
 * INDEXED reads (mastery by_scholar_current, seeds by_scholar_status) — no
 * full-table scan of masteryObservations/seeds. ≈ 1 + 2·N reads for N scholars.
 */
export const classGalaxy = teacherQuery({
  args: { scope: v.optional(v.string()), groupId: v.optional(v.id("scholarGroups")) },
  handler: async (ctx, args) => {
    // ── resolve the in-scope scholar set ──────────────────────────────────
    // A platform admin's omitted scope intentionally remains global. Every other
    // caller resolves a lens, including when scope is omitted.
    let lensIds: Set<Id<"users">> | null = null;
    const platformAdminAll =
      args.scope === undefined && isPlatformAdminRole(ctx.user.role);
    if (!platformAdminAll) {
      const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
      lensIds = await scholarIdsInLens(ctx, lens);
    }
    let scholarIds: Id<"users">[];
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      const ids = group?.scholarIds ?? [];
      scholarIds = lensIds ? ids.filter((id) => lensIds!.has(id)) : ids;
    } else if (lensIds) {
      scholarIds = [...lensIds];
    } else {
      const scholars = await ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
        .collect();
      scholarIds = scholars.map((s) => s._id);
    }

    // ── the shared atlas, read ONCE ────────────────────────────────────────
    const placed = (await ctx.db.query("knowledgeNodes").collect()).filter(isPlaced);
    const byNorm = new Map<string, Id<"knowledgeNodes">>();
    const byStandardId = new Map<string, Id<"knowledgeNodes">>();
    for (const c of placed) {
      if (c.normalizedLabel) byNorm.set(c.normalizedLabel, c._id);
      if (c.source === "standard" && c.standardId) byStandardId.set(c.standardId as string, c._id);
    }

    // Per-concept role aggregation across scholars (Sets so a scholar counts once).
    const litBy = new Map<string, Set<string>>();     // concept id → mastery scholars
    const reachedBy = new Map<string, Set<string>>();  // standard concept id → scholars
    const seedFor = new Map<string, Set<string>>();    // placed concept id → seeded scholars
    const threadSet = new Set<string>();               // "a|b" union, deduped
    const add = (m: Map<string, Set<string>>, id: string, sid: string) => {
      const set = m.get(id) ?? new Set<string>();
      set.add(sid);
      m.set(id, set);
    };

    // Display set + domain centroids for free-floating unmatched seeds (shared
    // across scholars, so computed once). Mirrors skyFieldForScholar's float math.
    const shown = capForDisplay(placed as PlacedNode[]);
    const nodeById = new Map<string, PlacedNode>();
    const cidByNorm = new Map<string, string>();
    const domAgg: Record<string, { x: number; y: number; n: number }> = {};
    for (const n of shown) {
      nodeById.set(n._id as string, n);
      if (n.normalizedLabel) cidByNorm.set(n.normalizedLabel, n._id as string);
      if (n.source === "seed") cidByNorm.set(normalizeLabel(cleanSeedLabel(n.label)), n._id as string);
      const d = n.domain || "exploration";
      const a = (domAgg[d] ??= { x: 0, y: 0, n: 0 });
      a.x += (n.skyX as number) ?? 50; a.y += (n.skyY as number) ?? 50; a.n++;
    }
    const jitter = (key: string, spread: number) => {
      let h = 2166136261; for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
      return (((h >>> 0) % 1000) / 1000 - 0.5) * 2 * spread;
    };

    type FloatNode = { id: string; label: string; domain: string; source: string; x: number; y: number; t: number; threaded: boolean };
    const floatCands: FloatNode[] = [];

    // ── per scholar: two INDEXED reads, aggregate ──────────────────────────
    for (const scholarId of scholarIds) {
      const sid = scholarId as string;
      const obs = await ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar_current", (q) => q.eq("scholarId", scholarId).eq("isSuperseded", false))
        .collect();
      const litHere = new Set<string>(); // this scholar's mastery concept ids
      for (const o of obs) {
        if (o.evidenceType === "misconception_signal") continue;
        const mid = byNorm.get(normalizeLabel(o.conceptLabel));
        if (mid) { add(litBy, mid as string, sid); litHere.add(mid as string); }
        for (const stdId of o.standardIds ?? []) {
          const scid = byStandardId.get(stdId as string);
          if (!scid) continue;
          add(reachedBy, scid as string, sid);
          if (mid) threadSet.add(`${mid}|${scid}`); // mastery → standard demonstrated
        }
      }

      // Pulled-next seeds (pending/active): threaded-first then recency, capped —
      // same selection buildScholarAtlas uses for a single Sky.
      const seedRows = (await ctx.db.query("seeds").withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId)).collect())
        .filter((s) => s.status === "pending" || s.status === "active")
        .sort((a, b) => b._creationTime - a._creationTime);
      let taken = 0;
      const seenTopic = new Set<string>();
      for (const s of seedRows) {
        if (taken >= GALAXY_SEED_PER_SCHOLAR) break;
        const topicNorm = normalizeLabel(s.topic);
        if (seenTopic.has(topicNorm)) continue;
        seenTopic.add(topicNorm);
        const cid = byNorm.get(topicNorm);
        const anchorMid = s.connectionTo ? byNorm.get(normalizeLabel(s.connectionTo)) : undefined;
        if (cid) {
          // Matched: the concept already rides a real placed node; mark it as a
          // cohort invitation and thread it from this scholar's anchor mastery.
          if (litHere.has(cid as string)) continue; // already mastered → not "pulled next"
          add(seedFor, cid as string, sid);
          if (anchorMid && litHere.has(anchorMid as string)) threadSet.add(`${anchorMid}|${cid}`);
          taken++;
        } else {
          // Unmatched: free-float a synthetic node (namespaced per scholar).
          const anchor = anchorMid ? nodeById.get(anchorMid as string) : undefined;
          const dom = s.domain || "exploration";
          const dc = domAgg[dom];
          const baseX = anchor ? (anchor.skyX as number) : dc ? dc.x / dc.n : 50 + jitter(String(s._id) + "x", 30);
          const baseY = anchor ? (anchor.skyY as number) : dc ? dc.y / dc.n : 50 + jitter(String(s._id) + "y", 30);
          const spread = anchor ? 6 : 10;
          floatCands.push({
            id: `seed:${sid}:${String(s._id)}`,
            label: cleanSeedLabel(s.topic),
            domain: dom,
            source: "seed",
            x: Math.max(2, Math.min(98, baseX + jitter(String(s._id) + "jx", spread))),
            y: Math.max(2, Math.min(98, baseY + jitter(String(s._id) + "jy", spread))),
            t: s._creationTime,
            threaded: !!(anchorMid && litHere.has(anchorMid as string)),
          });
          taken++;
        }
      }
    }

    // Global float ceiling: threaded/recent first (see GALAXY_FLOAT_CAP).
    floatCands.sort((a, b) => (Number(b.threaded) - Number(a.threaded)) || (b.t - a.t));
    const floats = floatCands.slice(0, GALAXY_FLOAT_CAP);

    const heat: Record<string, number> = {};
    for (const [id, set] of litBy) heat[id] = set.size;
    const reached = [...reachedBy.keys()].filter((id) => !(id in heat));
    const seedIds = [...seedFor.keys(), ...floats.map((f) => f.id)];
    const convergences = Object.values(heat).filter((n) => n >= 2).length;

    return {
      nodes: [
        ...shown.map((c) => ({ id: c._id as string, label: c.label, domain: c.domain, source: c.source ?? "", x: c.skyX as number, y: c.skyY as number })),
        ...floats.map((f) => ({ id: f.id, label: f.label, domain: f.domain, source: f.source, x: f.x, y: f.y })),
      ],
      heat,
      reached,
      seeds: seedIds,
      threads: [...threadSet].map((t) => t.split("|") as [string, string]),
      litTotal: Object.keys(heat).length,
      convergences,
      seedTotal: seedIds.length,
      scholarCount: scholarIds.length,
    };
  },
});

// ─── internal q/m for the build actions (live here, not in the "use node"
//     conceptAtlas.ts — a node file may only contain actions) ─────────

/** All SKY nodes that still need an embedding (none in the side table). */
export const _conceptsToEmbed = internalQuery({
  args: {},
  handler: async (ctx) => {
    const embedded = new Set(
      (await ctx.db.query("knowledgeNodeEmbeddings").collect()).map((e) => e.nodeId as string),
    );
    // Sky concepts + the tech-tree skills (practice/curated) — the latter so the
    // prereq/unlock lattice's endpoints get PLACED in sky-space (Option A). Tree
    // nodes lack embeddingText, so embed on label + rationale.
    return (await ctx.db.query("knowledgeNodes").collect())
      .filter((n) => isAtlasSource(n.source) && !embedded.has(n._id as string))
      .map((c) => ({
        id: c._id,
        text: c.embeddingText ?? (c.rationale ? `${c.label} — ${c.rationale}` : c.label),
      }));
  },
});

export const _insertEmbeddings = internalMutation({
  args: { rows: v.array(v.object({ nodeId: v.id("knowledgeNodes"), vector: v.array(v.float64()) })) },
  handler: async (ctx, args) => {
    for (const r of args.rows) await ctx.db.insert("knowledgeNodeEmbeddings", { nodeId: r.nodeId, vector: r.vector });
  },
});

/** All embeddings (from the side table) for the projection / edge build. */
export const _allEmbeddings = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("knowledgeNodeEmbeddings").collect();
    return all.map((e) => ({ id: e.nodeId, embedding: e.vector }));
  },
});

/** Light node meta (no vectors) for the edge build — merged with
 *  _allEmbeddings in the computeEdges action. Sky + tree sources, placed —
 *  tree/skill nodes participate too (they're embedded + projected into sky-space
 *  under Option A), so buildNeighborEdges gives them an associative neighborhood.
 *  bridge/explicit stay cross-domain-only via buildEdges' own logic. */
export const _conceptMetaForEdges = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("knowledgeNodes").collect();
    return all
      .filter((c) => isAtlasSource(c.source) && isPlaced(c))
      .map((c) => ({ id: c._id, nodeKey: c.nodeKey, domain: c.domain, refCount: c.refCount ?? 1, normalizedLabel: c.normalizedLabel }));
  },
});

export const _patchPositions = internalMutation({
  args: { rows: v.array(v.object({ id: v.id("knowledgeNodes"), x: v.number(), y: v.number() })) },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const r of args.rows) await ctx.db.patch(r.id, { skyX: r.x, skyY: r.y, projectedAt: now });
  },
});

/** Point-read specific nodes' embeddings (for bounded cosine consumers). */
export const _embeddingsByConceptIds = internalQuery({
  args: { ids: v.array(v.id("knowledgeNodes")) },
  handler: async (ctx, args) => {
    const out: { nodeId: Id<"knowledgeNodes">; vector: number[] }[] = [];
    for (const id of args.ids) {
      const e = await ctx.db.query("knowledgeNodeEmbeddings").withIndex("by_node", (q) => q.eq("nodeId", id)).unique();
      if (e) out.push({ nodeId: id, vector: e.vector });
    }
    return out;
  },
});

/** Scholars who have lit concepts on the atlas — the per-scholar Sky picker. */
export const litScholars = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const sky = (await ctx.db.query("knowledgeNodes").collect()).filter((n) => isSkySource(n.source));
    const placedNorms = new Set(sky.filter(isPlaced).map((c) => c.normalizedLabel));
    const obs = await ctx.db.query("masteryObservations").collect();
    const byScholar = new Map<string, Set<string>>();
    for (const o of obs) {
      if (o.isSuperseded || o.evidenceType === "misconception_signal") continue;
      const key = normalizeLabel(o.conceptLabel);
      if (!placedNorms.has(key)) continue;
      const set = byScholar.get(o.scholarId as unknown as string) ?? new Set();
      set.add(key);
      byScholar.set(o.scholarId as unknown as string, set);
    }
    const out: { id: Id<"users">; name: string; litCount: number }[] = [];
    for (const [sid, set] of byScholar) {
      const u = await ctx.db.get(sid as Id<"users">);
      if (!u) continue;
      out.push({ id: sid as Id<"users">, name: u.name ?? u.username ?? "Scholar", litCount: set.size });
    }
    return out.sort((a, b) => b.litCount - a.litCount);
  },
});

/**
 * Meat on the skeleton (Phase 4): for a standard (a Tree node) + scholar, the
 * scholar's DEMONSTRATED concepts that sit nearest it in the atlas — the
 * connected satellites that show HOW this scholar reached (or orbits) the
 * normative standard. Embedding-cosine to the standard's own concept.
 */
export const meatForStandard = authedQuery({
  args: { standardId: v.id("standards"), scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    // anchor = the sky STANDARD node grounding this standard. `standardId` is a
    // sky-only facet (practice nodes tag standards via `standardCodes`), so this
    // index read never returns a practice node.
    const anchor = (await ctx.db.query("knowledgeNodes").withIndex("by_standard", (q) => q.eq("standardId", args.standardId)).collect())
      .find((c) => c.source === "standard");
    if (!anchor) return { anchor: null as null | { label: string }, satellites: [] as { label: string; domain: string; masteryLevel: number; similarity: number }[] };

    const obs = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) => q.eq("scholarId", args.scholarId).eq("isSuperseded", false))
      .collect();
    const lit = new Map<string, number>();
    for (const o of obs) {
      if (o.evidenceType === "misconception_signal") continue;
      const k = normalizeLabel(o.conceptLabel);
      lit.set(k, Math.max(lit.get(k) ?? 0, o.masteryLevel));
    }
    // Only the scholar's demonstrated (source:"mastery") sky nodes are candidate
    // satellites — a small, bounded set. Point-read just those vectors (+ the
    // anchor) from the side table, never the whole embedding corpus.
    const mastery = await ctx.db.query("knowledgeNodes").withIndex("by_source", (q) => q.eq("source", "mastery")).collect();
    const candidates = mastery.filter((c) => c.normalizedLabel != null && lit.has(c.normalizedLabel));
    const ids = [anchor._id, ...candidates.map((c) => c._id)];
    const vecs = new Map<string, number[]>();
    for (const id of ids) {
      const e = await ctx.db.query("knowledgeNodeEmbeddings").withIndex("by_node", (q) => q.eq("nodeId", id)).unique();
      if (e) vecs.set(id as string, e.vector);
    }
    const anchorVec = vecs.get(anchor._id as string);
    if (!anchorVec) return { anchor: { label: anchor.label }, satellites: [] };
    const sats = candidates
      .map((c) => {
        const v = vecs.get(c._id as string);
        return v ? { label: c.label, domain: c.domain, masteryLevel: lit.get(c.normalizedLabel as string) as number, similarity: cosine(anchorVec, v) } : null;
      })
      .filter(Boolean) as { label: string; domain: string; masteryLevel: number; similarity: number }[];
    const top = sats
      .sort((a, b) => b.similarity - a.similarity)
      .filter((s) => s.similarity > 0.18)
      .slice(0, 5)
      .map((s) => ({ ...s, similarity: +s.similarity.toFixed(2) }));
    return { anchor: { label: anchor.label }, satellites: top };
  },
});

/**
 * Full detail for one concept (the click-through drawer): its nearest neighbors
 * in the atlas, which scholars have demonstrated it, and the standard it grounds
 * (if any). Teacher-facing.
 */
export const conceptDetail = teacherQuery({
  args: { conceptId: v.id("knowledgeNodes"), scholarId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.conceptId);
    if (!c) return null;
    // Light (no vectors) sky nodes only, placed — the atlas the drawer draws over.
    const all = (await ctx.db.query("knowledgeNodes").collect()).filter((o) => isSkySource(o.source) && isPlaced(o));
    const byKey = new Map(all.map((o) => [o.nodeKey, o]));

    // CONNECTED — the actual drawn edges (the lines on the map), now KEY-based in
    // the shared edge table: `bridge` = a strong cross-domain embedding link
    // (weight = similarity); `explicit` = a curriculum-authored connection. The
    // practice lane's kind:"buildsOn" edges are excluded (associative only here).
    const edgeRows = [
      ...await ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", "bridge")).collect(),
      ...await ctx.db.query("knowledgeNodeEdges").withIndex("by_kind", (q) => q.eq("kind", "explicit")).collect(),
    ];
    const connectedMap = new Map<string, { id: string; label: string; domain: string; source: string; kind: string; weight: number }>();
    for (const e of edgeRows) {
      const otherKey = e.fromKey === c.nodeKey ? e.toKey : e.toKey === c.nodeKey ? e.fromKey : null;
      if (!otherKey) continue;
      const o = byKey.get(otherKey);
      if (!o) continue;
      const w = e.weight ?? 0;
      const prev = connectedMap.get(otherKey);
      // keep the strongest edge if a pair is linked more than once; prefer explicit over bridge
      if (!prev || e.kind === "explicit" || (prev.kind !== "explicit" && w > prev.weight)) {
        connectedMap.set(otherKey, { id: o._id, label: o.label, domain: o.domain, source: o.source ?? "", kind: e.kind, weight: +w.toFixed(2) });
      }
    }
    const connected = [...connectedMap.values()].sort((a, b) =>
      (a.kind === b.kind ? b.weight - a.weight : a.kind === "explicit" ? -1 : 1));

    // NEARBY — proximity context, EXCLUDING anything already shown as connected,
    // so the two sections never repeat. Positions ARE the 2-D projection of the
    // embeddings, so position-proximity ≈ embedding-proximity (no vectors read).
    const neighbors = c.skyX != null && c.skyY != null
      ? all
          .filter((o) => o._id !== c._id && !connectedMap.has(o.nodeKey))
          .map((o) => ({
            id: o._id, label: o.label, domain: o.domain, source: o.source ?? "",
            d: Math.hypot((o.skyX as number) - (c.skyX as number), (o.skyY as number) - (c.skyY as number)),
          }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 6)
          .map((n) => ({ id: n.id, label: n.label, domain: n.domain, source: n.source }))
      : [];
    // who demonstrated it
    const obs = await ctx.db.query("masteryObservations").collect();
    const byScholar = new Map<string, { id: string; name: string; image: string | null; level: number }>();
    for (const o of obs) {
      if (o.isSuperseded || o.evidenceType === "misconception_signal") continue;
      if (normalizeLabel(o.conceptLabel) !== c.normalizedLabel) continue;
      const cur = byScholar.get(o.scholarId as unknown as string);
      if (!cur) {
        const u = await ctx.db.get(o.scholarId);
        byScholar.set(o.scholarId as unknown as string, { id: o.scholarId as unknown as string, name: u?.name ?? u?.username ?? "Scholar", image: u?.image ?? null, level: o.masteryLevel });
      } else cur.level = Math.max(cur.level, o.masteryLevel);
    }

    // SEEDED FOR — the facepile: scholars who already have this concept as a live
    // (pending/active) seed, with each one's intent (seed vs destination). Matched
    // by normalized topic (seeds.topic is a free string); dismissed/completed
    // seeds are not live prompts. effectiveIntent: explicit intent, else
    // "destination" if unit-backed.
    const seedRows = (await ctx.db.query("seeds").collect()).filter(
      (s) =>
        (s.status === "pending" || s.status === "active") &&
        normalizeLabel(s.topic) === c.normalizedLabel,
    );
    const seededByScholar = new Map<string, { id: string; name: string; image: string | null; intent: "seed" | "destination"; structured: boolean }>();
    for (const s of seedRows) {
      const sid = s.scholarId as unknown as string;
      const intent: "seed" | "destination" = s.intent ?? (s.unitId ? "destination" : "seed");
      const prev = seededByScholar.get(sid);
      // a destination outranks a plain seed if a scholar somehow has both
      if (!prev || (intent === "destination" && prev.intent !== "destination")) {
        const u = prev ? null : await ctx.db.get(s.scholarId);
        seededByScholar.set(sid, {
          id: sid,
          name: prev?.name ?? u?.name ?? u?.username ?? "Scholar",
          image: prev?.image ?? u?.image ?? null,
          intent,
          structured: prev?.structured || !!s.unitId,
        });
      }
    }
    const seededFor = [...seededByScholar.values()].sort((a, b) =>
      (a.intent === b.intent ? a.name.localeCompare(b.name) : a.intent === "destination" ? -1 : 1));
    // per-scholar state for the opened-from-a-scholar's-sky case
    const forScholar = args.scholarId
      ? (seededByScholar.get(args.scholarId as unknown as string) ?? null)
      : null;

    let standard: { notation: string; description: string } | null = null;
    if (c.standardId) {
      const s = await ctx.db.get(c.standardId);
      if (s) standard = { notation: s.notation ?? "", description: s.description };
    }
    return {
      id: c._id,
      label: c.label,
      domain: c.domain,
      source: c.source ?? "",
      embeddingText: c.embeddingText ?? null,
      connected,
      neighbors,
      litBy: [...byScholar.values()].sort((a, b) => b.level - a.level),
      seededFor,
      forScholar,
      standard,
    };
  },
});

/** All scholars (id + name) — for the "suggest a destination" picker.
 *  Enrolled-only by default; Extended Education (program-guest) scholars are
 *  excluded unless a caller explicitly opts in, matching users.listScholars. */
export const allScholars = teacherQuery({
  args: { includeProgramGuests: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    const isPlatformAdmin = isPlatformAdminRole(ctx.user.role);
    const membership = isPlatformAdmin
      ? null
      : await resolveActiveMembership(ctx, ctx.user);
    const allowedIds = isPlatformAdmin
      ? new Set(users.map((u) => u._id))
      : membership
        ? await accessibleScholarIds(ctx, membership)
        : new Set();
    return users
      .filter(
        (u) =>
          allowedIds.has(u._id) &&
          u.username !== "guest" &&
          (args.includeProgramGuests === true || isEnrolledScholar(u)),
      )
      .map((u) => ({ id: u._id as Id<"users">, name: u.name ?? u.username ?? "Scholar" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
