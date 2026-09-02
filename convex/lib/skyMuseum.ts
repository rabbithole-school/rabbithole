/**
 * The Sky's "night-museum" layers — see review/ (Wave 4 §1: lit constellations
 * + warm cold-start). Two ADDITIVE layers blended into a scholar's Sky, on top
 * of the existing seed/invitation stars. Consumed by BOTH the flat seed list
 * (`seeds.skyForSelf`) AND the LIVE embedding-placed Atlas field
 * (`concepts.skyFieldForScholar`, which feeds web `ConceptAtlasView`'s scholar
 * lens and native `sky.tsx`) — this module owns the ELIGIBILITY/CONTENT core
 * only; a caller that PLACES these stars supplies its own coordinate space
 * (`placeMuseumFloats` below does that for the Atlas's domain-centroid
 * layout). The flat list has no placing surface today: its one client, native's
 * Me tab, renders counts off it rather than a constellation.
 *
 *   - `buildMasteryStars` — the scholar's demonstrated-fluent practice skills
 *     (the homegrown drill engine's OWN fluency bar, `isFluent` with no
 *     read-time context — repetition >= FLUENT_REPS AND earned through real
 *     practice, never an inferred credit) as a "you built this" constellation.
 *   - `buildStarterLayer` — for a scholar whose real sky is still nearly
 *     empty, a warm starter layer derived from data that exists the moment
 *     they're placed: their per-strand frontier ("next step") skills, plus a
 *     small sampler from the curated cross-domain gate registry. Display-only
 *     — no seed row is planted, so tapping one is informational, never a
 *     "Begin Quest".
 *
 * Both layers are STRICTLY display data: a label + a blurb + a light
 * positioning hint (`reach`), never a repetition count, mastery score, or the
 * row's `source` — a fluent skill reads as "you built this", not a
 * scoreboard. Cross-frontend display constants (color, caps, reach values,
 * the "starter" sky role) live in shared/skyTiers.ts so web and native read
 * one source.
 */

import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { isFluent } from "./practice/scheduler";
import { practiceDomainInfo } from "./practice/domains";
import { MATH_CROSS_DOMAIN_SEEDS } from "./practice/crossDomainSeeds";
import {
  MASTERY_STAR_CAP,
  MASTERY_STAR_COLOR,
  MASTERY_STAR_REACH,
  STARTER_FRONTIER_REACH,
  STARTER_REGISTRY_COUNT,
  STARTER_REGISTRY_REACH,
} from "../../shared/skyTiers";

export type MasteryStar = {
  _id: string;
  kind: "mastery";
  topic: string;
  domain: string;
  strand: string | null;
  practiceDomain: string;
  color: string;
  reach: number;
  /** The scholar-safe "you built this" hook — same string every consuming
   *  surface reads (the live Atlas's StarDrawer variants), composed once here
   *  so it never drifts between frontends. */
  blurb: string;
};

export type StarterFrontierStar = {
  _id: string;
  kind: "starter-frontier";
  topic: string;
  domain: string;
  strand: string | null;
  practiceDomain: string;
  reach: number;
  /** The scholar-safe "next step" hook — composed once here (see MasteryStar). */
  blurb: string;
};

export type StarterRegistryStar = {
  _id: string;
  kind: "starter-registry";
  topic: string;
  domain: string;
  blurb: string;
  connectionTo: string;
  reach: number;
};

export type StarterStar = StarterFrontierStar | StarterRegistryStar;

/** Resolve a practice skillKey's display label + strand off `knowledgeNodes`,
 *  cached per call so a batch of rows only looks up each key once (mirrors
 *  the label-cache pattern in practiceDigest.ts). */
function makeLabelResolver(ctx: QueryCtx) {
  const cache = new Map<string, { label: string; strand: string | null }>();
  return async (skillKey: string): Promise<{ label: string; strand: string | null }> => {
    const cached = cache.get(skillKey);
    if (cached) return cached;
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
      .first();
    const resolved = {
      label: node?.label ?? skillKey.replace(/[-_]+/g, " "),
      strand: node?.strand ?? null,
    };
    cache.set(skillKey, resolved);
    return resolved;
  };
}

/** The discipline bucket a practice-domain slug groups under (e.g.
 *  "Mathematics") — falls back to "Mathematics" (today's only registered
 *  discipline) for a domain the registry doesn't recognize, so a display
 *  glitch never throws. Grouping by DISCIPLINE (not the finer practice-domain
 *  slug) keeps every fluent math skill in ONE region of the sky — a single
 *  cluster, not a scatter of per-subdomain slivers. */
function disciplineOfPracticeDomain(domain: string): string {
  return practiceDomainInfo(domain)?.discipline ?? "Mathematics";
}

/** The fixed "you built this" body line — same for every mastery star,
 *  regardless of which surface renders it. No numbers, ever. */
const MASTERY_BLURB = "Practice keeps it bright.";

/** The "next step" body line for a cold-start frontier star — names the
 *  strand when known, otherwise a generic nudge. No numbers, ever. */
function starterFrontierBlurb(strand: string | null): string {
  return strand
    ? `Your next stretch in ${strand} — keep practicing and it'll light up here.`
    : "Keep practicing and it'll light up here.";
}

/**
 * Fluent practice skills as "lit constellation" stars. Capped to the most
 * recently earned (`becameFluentAt`, falling back to `updatedAt` for older
 * rows stamped before that field existed) so an advanced scholar's sky
 * doesn't drown in noise.
 */
export async function buildMasteryStars(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<MasteryStar[]> {
  const rows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();

  const fluent = rows
    .filter((r) => isFluent(r))
    .sort((a, b) => (b.becameFluentAt ?? b.updatedAt) - (a.becameFluentAt ?? a.updatedAt))
    .slice(0, MASTERY_STAR_CAP);

  const resolve = makeLabelResolver(ctx);
  const stars: MasteryStar[] = [];
  for (const row of fluent) {
    const { label, strand } = await resolve(row.skillKey);
    stars.push({
      _id: `mastery:${row.skillKey}`,
      kind: "mastery",
      topic: label,
      domain: disciplineOfPracticeDomain(row.domain),
      strand: strand ?? row.strand ?? null,
      practiceDomain: row.domain,
      color: MASTERY_STAR_COLOR,
      reach: MASTERY_STAR_REACH,
      blurb: MASTERY_BLURB,
    });
  }
  return stars;
}

/**
 * The cold-start layer: display-only stars for a scholar whose real sky
 * (seeds) is still nearly empty. Two sources, both derived from data that
 * exists the moment a scholar is placed — never a new table, never a planted
 * seed row:
 *   - one "next step" star per practiced STRAND's frontier skill (the
 *     engine's own `frontier: true` rows) — a real, near-term reach;
 *   - a small sampler from the curated cross-domain gate registry
 *     (crossDomainSeeds.ts) — a "someday" far star, using the registry's own
 *     kid-safe hook text. Tapping one does NOT plant a seed row (no gate skill
 *     has fired for a brand-new scholar yet), so the caller renders it with no
 *     CTA — informational only.
 */
export async function buildStarterLayer(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<StarterStar[]> {
  const rows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();

  // One star per strand (falling back to the domain slug when a skill has no
  // strand yet) — a scholar's frontier is a handful of active edges, but the
  // starter sky should read as "your next steps", not one star per skill.
  const resolve = makeLabelResolver(ctx);
  const seenStrand = new Set<string>();
  const frontierStars: StarterFrontierStar[] = [];
  for (const row of rows) {
    if (!row.frontier) continue;
    const strandKey = row.strand ?? row.domain;
    if (seenStrand.has(strandKey)) continue;
    seenStrand.add(strandKey);
    const { label, strand } = await resolve(row.skillKey);
    const resolvedStrand = strand ?? row.strand ?? null;
    frontierStars.push({
      _id: `starter-frontier:${row.skillKey}`,
      kind: "starter-frontier",
      topic: label,
      domain: disciplineOfPracticeDomain(row.domain),
      strand: resolvedStrand,
      practiceDomain: row.domain,
      reach: STARTER_FRONTIER_REACH,
      blurb: starterFrontierBlurb(resolvedStrand),
    });
  }

  const registryStars: StarterRegistryStar[] = MATH_CROSS_DOMAIN_SEEDS.slice(
    0,
    STARTER_REGISTRY_COUNT,
  ).map((entry) => ({
    _id: `starter-registry:${entry.gateSkillKey}`,
    kind: "starter-registry" as const,
    topic: entry.topic,
    domain: "exploration",
    blurb: entry.scholarInvitation,
    connectionTo: entry.connectionTo,
    reach: STARTER_REGISTRY_REACH,
  }));

  return [...frontierStars, ...registryStars];
}

// ─── Placement for a domain-centroid atlas (concepts.ts skyFieldForScholar) ──
// The LIVE embedding-placed Atlas free-floats synthetic nodes near their
// domain's centroid, exactly like concepts.ts already does for an unmatched
// seed. `placeMuseumFloats` is that same recipe, pulled out here (pure,
// framework-free, unit-testable) so concepts.ts only has to supply its
// existing domain-centroid lookup + jitter function.

export type MuseumFloatRole = "mastery" | "starter";

/** The minimal shape `placeMuseumFloats` needs from a museum star — both
 *  `MasteryStar` and the `StarterStar` union already satisfy this. */
export type MuseumFloatSource = {
  _id: string;
  topic: string;
  domain: string;
  strand?: string | null;
  blurb: string;
};

export type MuseumFloatNode = {
  id: string;
  label: string;
  domain: string;
  source: MuseumFloatRole;
  x: number;
  y: number;
  refCount: number;
  /** Always 0 — a museum float has no place in the prereq lattice (it's not a
   *  `hopTiers()` BFS participant). Harmless: shared/skyTiers.ts
   *  `classifySkyNode` forces BOTH the mastery and starter roles to a
   *  rest-visible display tier regardless of hopTier — the whole "night
   *  museum" promise is that this content is true on first glance, not
   *  something a scholar has to zoom to discover. */
  hopTier: 0;
};

export type PlacedMuseumStar = {
  node: MuseumFloatNode;
  role: MuseumFloatRole;
  blurb: string;
  strand: string | null;
};

/** `placeMuseumFloats`'s full return: the placed stars, plus (mastery only)
 *  faint nearest-neighbor edges connecting same-domain stars into a
 *  recognizable constellation shape — never an all-pairs starburst, never a
 *  hub. Rendered through the SAME `threads` field the atlas already draws
 *  mastery→standard/mastery→seed lines through (see concepts.ts), so both
 *  frontends pick this up for free with the existing faint-line style — no
 *  new rendering code on either platform. The starter layer never emits
 *  edges: each "someday" star is deliberately its own separate invitation,
 *  not a group. */
export type PlacedMuseumBatch = {
  stars: PlacedMuseumStar[];
  edges: [string, string][];
};

/**
 * Place a batch of museum stars (mastery or starter) near their domain's
 * centroid in the atlas's 0..100 sky space — mirroring exactly how
 * concepts.ts already free-floats an unmatched seed (anchor/domain centroid +
 * deterministic jitter, clamped to the visible field). Falls back to the
 * field's center (50,50) when the domain has no existing centroid (e.g. a
 * discipline with no placed standards/seeds yet on this deployment).
 *
 * Mastery clusters into SEPARATE per-STRAND sub-groups within its domain
 * region — a scholar fluent across several strands (counting, add-subtract,
 * place-value, …) reads as several small, recognizable constellations, not
 * one 40-star tangle. Each strand gets its own small deterministic sub-anchor
 * offset from the domain centroid (`spreadWithCentroid`/`spreadNoCentroid`,
 * same distances as before), then every star in that strand jitters tightly
 * around ITS sub-anchor (`MASTERY_INNER_SPREAD`) — a legible little shape.
 * Nearest-neighbor edges (`constellationEdges` below) connect ONLY within a
 * strand group, so the connective lines trace actual small constellation
 * shapes instead of one long chain crossing the whole region. Starter stars
 * skip all of this — no sub-clustering, no edges: each is deliberately its
 * own independent "someday" point, never a group.
 */
const MASTERY_INNER_SPREAD = 2.2;

export function placeMuseumFloats(
  stars: MuseumFloatSource[],
  role: MuseumFloatRole,
  opts: {
    domainCentroid: (domain: string) => { x: number; y: number } | undefined;
    jitter: (key: string, spread: number) => number;
  },
): PlacedMuseumBatch {
  const spreadWithCentroid = role === "mastery" ? 5 : 8;
  const spreadNoCentroid = role === "mastery" ? 9 : 14;

  const placed = stars.map((s) => {
    const centroid = opts.domainCentroid(s.domain);
    const baseX = centroid?.x ?? 50;
    const baseY = centroid?.y ?? 50;
    const outer = centroid ? spreadWithCentroid : spreadNoCentroid;
    let anchorX = baseX;
    let anchorY = baseY;
    let inner = outer;
    if (role === "mastery") {
      // A per-strand sub-anchor (deterministic, so re-renders don't jitter)
      // pulls this star's whole strand-group to its OWN small region within
      // the domain footprint, distinct from other strands.
      const clusterKey = clusterKeyOf(s);
      anchorX = baseX + opts.jitter(clusterKey + "cx", outer);
      anchorY = baseY + opts.jitter(clusterKey + "cy", outer);
      inner = MASTERY_INNER_SPREAD;
    }
    const x = Math.max(2, Math.min(98, anchorX + opts.jitter(s._id + "jx", inner)));
    const y = Math.max(2, Math.min(98, anchorY + opts.jitter(s._id + "jy", inner)));
    return {
      node: {
        id: s._id,
        label: s.topic,
        domain: s.domain,
        source: role,
        x,
        y,
        refCount: 1,
        hopTier: 0 as const,
      },
      role,
      blurb: s.blurb,
      strand: s.strand ?? null,
    };
  });

  return { stars: placed, edges: role === "mastery" ? constellationEdges(placed) : [] };
}

/** The sub-cluster grouping key for a museum star: domain + strand (falling
 *  back to a shared "misc" bucket when a skill has no strand yet), so
 *  distinct strands within one domain separate into their own constellation
 *  region instead of blending into a single tangle. */
function clusterKeyOf(s: { domain: string; strand?: string | null }): string {
  return `${s.domain}::${s.strand ?? "misc"}`;
}

/**
 * Nearest-neighbor CHAIN per STRAND sub-group (domain + strand — see
 * `clusterKeyOf`) — a greedy walk (start from the first star, always connect
 * to the nearest not-yet-chained star) rather than an all-pairs starburst or
 * a hub-and-spoke, so each group reads as an actual small constellation shape
 * (a connected line of nearby points) instead of one long tangle spanning
 * every strand a scholar has practiced. Groups with fewer than 2 stars get no
 * edges (nothing to connect).
 */
function constellationEdges(placed: PlacedMuseumStar[]): [string, string][] {
  const byGroup = new Map<string, { id: string; x: number; y: number }[]>();
  for (const p of placed) {
    const key = clusterKeyOf({ domain: p.node.domain, strand: p.strand });
    const arr = byGroup.get(key) ?? [];
    arr.push({ id: p.node.id, x: p.node.x, y: p.node.y });
    byGroup.set(key, arr);
  }
  const edges: [string, string][] = [];
  for (const group of byGroup.values()) {
    if (group.length < 2) continue;
    const chained = [group[0]];
    const remaining = group.slice(1);
    while (remaining.length) {
      let bestI = 0;
      let bestJ = 0;
      let bestD = Infinity;
      for (let i = 0; i < chained.length; i++) {
        for (let j = 0; j < remaining.length; j++) {
          const d = Math.hypot(chained[i].x - remaining[j].x, chained[i].y - remaining[j].y);
          if (d < bestD) {
            bestD = d;
            bestI = i;
            bestJ = j;
          }
        }
      }
      edges.push([chained[bestI].id, remaining[bestJ].id]);
      chained.push(remaining[bestJ]);
      remaining.splice(bestJ, 1);
    }
  }
  return edges;
}
