// Milestone REVEALS for the scholar's two maps (Sky + Tree).
//
// The scholar's OWN nav hides each map until it first has real data behind it,
// then reveals it once as a fun moment. This module owns the two questions the
// UI asks:
//
//   1. Is a map UNLOCKED?  — derived purely from EVIDENCE, never a stored flag,
//      so an existing scholar with history is never re-locked. The BINDING
//      invariant (Andy's f6 addendum): a gate means RENDERABLE EVIDENCE, honest
//      in BOTH directions — if a map's OWN query would render meaningful
//      scholar-specific content it is unlocked; if it would render empty it is
//      locked. So each predicate is DERIVED FROM THE MAP QUERY'S OWN RENDER
//      LOGIC:
//        • tree (convex/practiceSkills.ts `treeForScholar` → `buildScholarTree`)
//          renders per-scholar proficiency/frontier/retention from
//          `practiceMastery` (a completed placement always writes ≥1 mastery
//          row). The practice TREE graph is always seeded (db-seed.sh's
//          `knowledgeNodes:rebuildTree`), so mastery reliably renders. So:
//            tree unlocked = any `practiceMastery` OR any `practicePlacements`
//          (placement is the check-in on-ramp the reveal fires on; a completed
//          placement co-writes mastery, so it never opens ahead of a rendered
//          tree over real/seeded data).
//        • sky (convex/concepts.ts `skyFieldForScholar` → `buildScholarAtlas`)
//          lights a GOLD star from a `masteryObservation` ONLY when the concept
//          maps to a PLACED atlas node, and shows a SEED star from any
//          pending/active `seed` (a seed free-floats even with no atlas). The
//          atlas placement (skyX/skyY) comes from a separate embeddings
//          PROJECTION (`conceptAtlas.projectAtlas`) that is NOT in the standard
//          seed — so on an unprojected deployment (every worktree) observations
//          light NOTHING and the sky renders seeds only. The gate is therefore
//          deployment-faithful:
//            sky unlocked = any pending/active `seed`
//                           OR any `masteryObservation` that maps to a PLACED
//                              atlas node (mirrors buildScholarAtlas `lit`)
//                           OR welcome-unit complete.
//          The night-museum layers (mastery + starter stars, skyMuseum.ts)
//          never count — the Sky gate keys off EXPLORATION evidence only;
//          museum layers decorate an already-earned sky (Andy, 2026-07-15).
//          Welcome-completion is an ADDITIONAL trigger; in every real
//          completion path the observer has already planted seeds (so it never
//          opens ahead of a rendered sky). The CI invariant test
//          (convex/__tests__/mapGatesHonesty.test.ts) asserts the biconditional
//          against the REAL map-query output over fixtures so a seed-script (or
//          query) change that breaks this honesty FAILS CI, not just today's
//          snapshot.
//   2. Is a map's one-time REVEAL still PENDING? — unlocked AND no `mapReveals`
//      row yet. `acknowledgeReveal` stamps the row when the celebratory card is
//      shown, so it never replays; migrations.backfillMapReveals pre-stamps
//      every already-unlocked scholar so only genuinely NEW scholars see it.
//
// Scholar-self only: teachers / parents / observers always see every map for
// any scholar (that gating lives in the client, which bypasses these for a
// remote/teacher view), and never mint a reveal row here.

import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ONBOARDING_UNIT_SLUG } from "./onboardingData";
import { normalizeLabel } from "./concepts";

export type MapKind = "sky" | "tree";

export type MapGates = { sky: boolean; tree: boolean };

// Read-only ctx: the gate helpers only query, so they run from a query, a
// mutation, or the backfill migration.
type ReadCtx = QueryCtx | MutationCtx;

/** A knowledge node is PLACED in the sky/atlas once the embeddings projection
 *  has stamped its coordinates. Mirrors the private `isPlaced` in
 *  convex/concepts.ts (the sky query's own render gate). */
function isPlaced(n: { skyX?: number; skyY?: number }): boolean {
  return n.skyX != null && n.skyY != null;
}

/** Has the scholar finished the "Welcome to Rabbithole" onboarding unit?
 *  Signalled by the completion badge (scholarUnitBadges) for that unit. */
async function hasWelcomeBadge(
  ctx: ReadCtx,
  scholarId: Id<"users">,
): Promise<boolean> {
  const unit = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
    .first();
  if (!unit) return false;
  const badge = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar_unit", (q) =>
      q.eq("scholarId", scholarId).eq("unitId", unit._id),
    )
    .first();
  return badge !== null;
}

/**
 * Would the scholar's SKY light a GOLD star? Mirrors buildScholarAtlas `lit`:
 * a non-superseded, non-misconception `masteryObservation` lights a star ONLY
 * when its concept label matches a PLACED atlas node. On an unprojected
 * deployment (no placed nodes) this is always false, so observations don't
 * unlock a sky that would render empty. Bounded by the scholar's own
 * observation count and short-circuits on the first match.
 */
async function anyObservationLitOnSky(
  ctx: ReadCtx,
  scholarId: Id<"users">,
): Promise<boolean> {
  const observations = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_current", (q) =>
      q.eq("scholarId", scholarId).eq("isSuperseded", false),
    )
    .collect();
  for (const o of observations) {
    if (o.evidenceType === "misconception_signal") continue;
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_normalized", (q) =>
        q.eq("normalizedLabel", normalizeLabel(o.conceptLabel)),
      )
      .first();
    if (node && isPlaced(node)) return true;
  }
  return false;
}

/**
 * Evidence-derived unlock state for a scholar's two maps. Pure reads, no
 * side-effects — reused by the query below and by tests.
 *
 * INVARIANT (f6 addendum): each predicate mirrors the set of conditions the
 * map's OWN query renders scholar-specific content from — so "unlocked" ⟺ "the
 * map query would render meaningful content", honest in both directions
 * (including on deployments where the sky atlas is unprojected). See the file
 * header for the per-map derivation.
 */
export async function mapGatesForScholar(
  ctx: ReadCtx,
  scholarId: Id<"users">,
): Promise<MapGates> {
  // A seed only unlocks the sky if it actually RENDERS there — buildScholarAtlas
  // (convex/concepts.ts) shows only pending/active seeds, so a scholar whose only
  // seed is dismissed/completed would otherwise get an unlocked-but-empty sky.
  // Match that filter exactly (two point lookups on by_scholar_status), not a
  // status-blind "any seed" read.
  const [pendingSeed, activeSeed, mastery, placement] = await Promise.all([
    ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", scholarId).eq("status", "pending"),
      )
      .first(),
    ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", scholarId).eq("status", "active"),
      )
      .first(),
    ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .first(),
    ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
      .first(),
  ]);
  const seed = pendingSeed ?? activeSeed;

  // Tree: the proficiency/frontier/retention buildScholarTree renders from
  // practiceMastery, plus the placement on-ramp the reveal fires on. The tree
  // graph is always seeded, so a mastery/placement row reliably renders.
  const tree = mastery !== null || placement !== null;

  // Sky: a seed star (always renders) OR a lit observation on a PLACED atlas
  // node (renders only where the atlas is projected) OR welcome-completion. A
  // seed short-circuits the (bounded) observation scan.
  //
  // The night-museum layers (skyMuseum.ts mastery + starter stars) are
  // deliberately NOT unlock evidence (Andy's ruling, 2026-07-15: a pure
  // driller's sky — fluent skills only, no exploration — is "totally
  // uninteresting and should be locked"). The Sky is the EXPLORATION surface;
  // its gate keys off exploration evidence only. The museum layers are
  // decoration that enriches a sky the scholar has already earned — visible
  // whenever the sky is visible, never what reveals it. (The tree is the
  // practice-progress surface, so fluency rows unlock THAT.)
  const sky =
    seed !== null ||
    (await hasWelcomeBadge(ctx, scholarId)) ||
    (await anyObservationLitOnSky(ctx, scholarId));

  return { sky, tree };
}

async function revealed(
  ctx: ReadCtx,
  scholarId: Id<"users">,
  map: MapKind,
): Promise<boolean> {
  const row = await ctx.db
    .query("mapReveals")
    .withIndex("by_scholar_map", (q) =>
      q.eq("scholarId", scholarId).eq("map", map),
    )
    .first();
  return row !== null;
}

/**
 * The calling scholar's map gates + whether each map's one-time reveal is still
 * pending. Drives both the nav gate (show "Your Map" iff sky || tree, and which
 * lenses are available) and the celebratory reveal cards.
 */
export const mine = authedQuery({
  args: {},
  handler: async (ctx) => {
    const scholarId = ctx.user._id;
    const gates = await mapGatesForScholar(ctx, scholarId);
    const [skyRevealed, treeRevealed] = await Promise.all([
      revealed(ctx, scholarId, "sky"),
      revealed(ctx, scholarId, "tree"),
    ]);
    return {
      sky: gates.sky,
      tree: gates.tree,
      skyRevealPending: gates.sky && !skyRevealed,
      treeRevealPending: gates.tree && !treeRevealed,
    };
  },
});

/**
 * Record that the calling scholar has seen a map's reveal, so it never replays.
 * Idempotent (one row per scholar per map) and self-gated by construction —
 * only ever stamps the caller's own row, only for a map that is actually
 * unlocked. A no-op for a locked map (nothing to reveal yet).
 */
export const acknowledgeReveal = authedMutation({
  args: { map: v.union(v.literal("sky"), v.literal("tree")) },
  handler: async (ctx, { map }) => {
    const scholarId = ctx.user._id;
    const existing = await ctx.db
      .query("mapReveals")
      .withIndex("by_scholar_map", (q) =>
        q.eq("scholarId", scholarId).eq("map", map),
      )
      .first();
    if (existing) return existing._id;

    const gates = await mapGatesForScholar(ctx, scholarId);
    if (!gates[map]) return null; // not unlocked yet — nothing to acknowledge

    return await ctx.db.insert("mapReveals", {
      scholarId,
      map,
      revealedAt: Date.now(),
    });
  },
});
