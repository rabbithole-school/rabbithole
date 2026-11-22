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
//        • sky (convex/skyStars.ts `forSelf`, the kid's own Sky both clients
//          draw since TRA-699) draws one star per placed, unhidden `skyStars`
//          row whose wonder or Quest still earns it. So:
//            sky unlocked = the kid has at least one star `forSelf` would draw
//          read through `skyHasStar`, which shares `forSelf`'s rule rather than
//          copying it (TRA-708). The older Sky's evidence (seeds, atlas
//          observations, the welcome badge) no longer counts: none of it draws
//          a star.
//      The CI invariant test (convex/__tests__/mapGatesHonesty.test.ts)
//      asserts the biconditional against the REAL map-query output over
//      fixtures, so a query change that breaks this honesty FAILS CI, not just
//      today's snapshot.
//   2. Is a map's one-time REVEAL still PENDING? — unlocked AND no `mapReveals`
//      row yet. `acknowledgeReveal` stamps the row when the scholar arrives at
//      the map, so it never replays; migrations.backfillMapReveals pre-stamps
//      every already-unlocked scholar so only genuinely NEW scholars see it.
//
// Scholar-self only: teachers / parents / observers always see every map for
// any scholar (that gating lives in the client, which bypasses these for a
// remote/teacher view), and never mint a reveal row here.

import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { skyHasStar } from "./skyStars";

export type MapKind = "sky" | "tree";

export type MapGates = { sky: boolean; tree: boolean };

// Read-only ctx: the gate helpers only query, so they run from a query, a
// mutation, or the backfill migration.
type ReadCtx = QueryCtx | MutationCtx;

/**
 * Evidence-derived unlock state for a scholar's two maps. Pure reads, no
 * side-effects — reused by the query below and by tests.
 *
 * INVARIANT (f6 addendum): each predicate mirrors the set of conditions the
 * map's OWN query renders scholar-specific content from — so "unlocked" ⟺ "the
 * map query would render meaningful content", honest in both directions. See
 * the file header for the per-map derivation.
 */
export async function mapGatesForScholar(
  ctx: ReadCtx,
  scholar: Doc<"users">,
): Promise<MapGates> {
  const scholarId = scholar._id;
  const [mastery, placement, sky] = await Promise.all([
    ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .first(),
    ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
      .first(),
    skyHasStar(ctx, scholar),
  ]);

  // Tree: the proficiency/frontier/retention buildScholarTree renders from
  // practiceMastery, plus the placement on-ramp the reveal fires on. The tree
  // graph is always seeded, so a mastery/placement row reliably renders.
  const tree = mastery !== null || placement !== null;

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
 * lenses are available) and the reveal consumed on arrival at each map.
 */
export const mine = authedQuery({
  args: {},
  handler: async (ctx) => {
    const scholarId = ctx.user._id;
    const gates = await mapGatesForScholar(ctx, ctx.user);
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

    const gates = await mapGatesForScholar(ctx, ctx.user);
    if (!gates[map]) return null; // not unlocked yet — nothing to acknowledge

    return await ctx.db.insert("mapReveals", {
      scholarId,
      map,
      revealedAt: Date.now(),
    });
  },
});
