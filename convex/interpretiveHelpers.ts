/**
 * Interpretive constellation generator — helpers (db side).
 *
 * The "magic" engine: given what a scholar is drawn to, generate a sky of
 * surprising, true, cross-disciplinary exploration seeds (stars) — including
 * `leap` bridges that reach far across human knowledge. Dedicated + EXPANSIVE
 * (the opposite of the conservative live observer), teacher-shaped as an overlay,
 * default-on. See review/learning-lenses-plan.md ("Generating the magic").
 *
 * Split: this file is the db-side query/mutation + the auth'd trigger; the LLM
 * call lives in convex/interpretive.ts ("use node").
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { authedMutation } from "./lib/customFunctions";
import { internal } from "./_generated/api";
import { insertSeed, normalizeSuggestionType } from "./lib/seeds";

/** Gather the raw interest signals the generator reasons over. */
export const gatherInterests = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const [signals, connections, mastery, existing, scholar] = await Promise.all([
      ctx.db
        .query("sessionSignals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .order("desc")
        .take(20),
      ctx.db
        .query("crossDomainConnections")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .order("desc")
        .take(20),
      ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .order("desc")
        .take(30),
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", args.scholarId))
        .collect(),
      ctx.db.get(args.scholarId),
    ]);
    // The topics the LEARNER has actually been drawn to — harvested by the live
    // observer ("ai") or planted by a teacher — are the purest interest signal
    // (e.g. the getting-to-know-you quest's "what pulls you in"). Surface them as
    // positive material the generator builds surprising bridges OUT of, distinct
    // from `existingTopics` (which is only the anti-repeat list). The generator's
    // OWN prior stars (origin "ai-constellation") and dev fixtures are NOT
    // interests, so they're excluded here.
    const statedInterests = existing
      .filter((s) => s.origin === "ai" || s.origin === "teacher" || s.origin === "badge_follow")
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, 12)
      .map((s) => (s.domain ? `${s.topic} [${s.domain}]` : s.topic));
    return {
      scholarName: scholar?.name ?? "this scholar",
      signals: signals.map((s) => ({ type: s.signalType, description: s.description })),
      connections: connections.map((c) => ({
        domains: c.domains,
        concepts: c.conceptLabels,
        description: c.description,
      })),
      concepts: mastery
        .filter((m) => !m.isSuperseded)
        .map((m) => ({ label: m.conceptLabel, domain: m.domain })),
      statedInterests,
      existingTopics: existing.map((s) => s.topic),
    };
  },
});

/** Insert a generated constellation as default-on seeds (idempotent per scholar). */
export const recordConstellation = internalMutation({
  args: {
    scholarId: v.id("users"),
    stars: v.array(
      v.object({
        topic: v.string(),
        domain: v.string(),
        rationale: v.string(),
        connectionTo: v.optional(v.string()),
        suggestionType: v.string(),
        reach: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Clear the previous generated constellation so a refresh replaces rather
    // than piles up — but PRESERVE any star the scholar has engaged with:
    // teacher-pinned ("active"), terminal completed, or any with a linked
    // session (a session stamps its seedId — the "visited" signal, DEC 3).
    // Deleting a visited/completed star would orphan the session it spawned and
    // vanish it from the scholar's map.
    const prior = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_origin", (q) =>
        q.eq("scholarId", args.scholarId).eq("origin", "ai-constellation"),
      )
      .collect();
    const scholarSessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();
    const visitedSeedIds = new Set(
      scholarSessions.filter((s) => s.seedId).map((s) => String(s.seedId)),
    );
    for (const p of prior) {
      const visited = visitedSeedIds.has(String(p._id));
      if (p.status !== "active" && p.status !== "completed" && !visited) {
        await ctx.db.delete(p._id);
      }
    }
    let n = 0;
    for (const s of args.stars) {
      await insertSeed(ctx, {
        scholarId: args.scholarId,
        origin: "ai-constellation",
        status: "pending", // default-on: the scholar sees it without teacher gating
        topic: s.topic,
        domain: s.domain,
        suggestionType: normalizeSuggestionType(s.suggestionType),
        rationale: s.rationale,
        // The constellation generator already writes `rationale` in the kid's
        // 2nd-person voice (interpretive.ts: "shown DIRECTLY TO THE STUDENT"),
        // so it IS the scholar invitation — mirror it so the two-audience model
        // holds (the teacher map can label it "what the scholar sees").
        scholarInvitation: s.rationale,
        connectionTo: s.connectionTo,
        sourceLens: "interpretive",
        reach: s.reach,
      });
      n++;
    }
    return n;
  },
});

/** Self-serve: a scholar (re)generates their own sky. */
export const requestMySky = authedMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.interpretive.generateConstellation, {
      scholarId: ctx.user._id,
    });
    return { scheduled: true };
  },
});

/**
 * Interest signal a cold-start scholar must accumulate before we auto-chart their
 * first sky — so a thin opening beat doesn't burn the one-shot on a generic map.
 * Tuned so a substantive getting-to-know-you turn (≈2 harvested interest-seeds +
 * a signal, or a cross-domain connection) clears it, but a near-empty first
 * exchange does not. Cheap to nudge later; err toward waiting for real signal.
 */
const FIRST_SKY_SIGNAL_FLOOR = 3;

/**
 * Cold-start: once a brand-new scholar has harvested enough interest signal (from
 * the getting-to-know-you quest, or any early session), auto-chart their FIRST
 * interpretive sky so the star map lands populated instead of blank.
 *
 * Called fire-and-forget from the observer after every session analysis:
 *   • Fire-once (best-effort) — bails the instant the scholar has ANY
 *     `ai-constellation` star in ANY status. A dismissed/visited one means we've
 *     already charted for them, so we never re-chart over their curation. (Re-
 *     charting as signal grows is the scholar's explicit call via `requestMySky`,
 *     or a later polish pass.) NOTE: the guard reads the seed but the star isn't
 *     written until `generateConstellation` finishes its (several-second) LLM
 *     call, so two analyses racing across that window can each schedule a
 *     generation. That's benign: `recordConstellation` is clear-and-replace and
 *     preserves engaged stars, so the DB converges to ONE constellation — the
 *     only cost is a redundant generation in the rare race. We accept that over a
 *     synchronous sentinel, whose failure mode (a stranded marker permanently
 *     blocking the first sky if generation errors) is worse than a duplicate.
 *     The curation invariant is unaffected: curation only happens once a sky
 *     exists, by which point the guard reliably sees the star.
 *   • Floor-gated — sums harvested interest signal (observer interest-seeds +
 *     session signals + cross-domain connections, capped) and waits until it's
 *     substantive, so the first sky is personal, not generic.
 * A cheap indexed no-op for everyone who already has a sky. Universal by design:
 * also back-fills existing-roster scholars who predate the interpretive lens.
 */
export const maybeChartFirstSky = internalMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const existingStar = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_origin", (q) =>
        q.eq("scholarId", args.scholarId).eq("origin", "ai-constellation"),
      )
      .first();
    if (existingStar) return { charted: false, reason: "already-charted" as const };

    const [interestSeeds, signals, connections] = await Promise.all([
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_origin", (q) =>
          q.eq("scholarId", args.scholarId).eq("origin", "ai"),
        )
        .take(6),
      ctx.db
        .query("sessionSignals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .take(6),
      ctx.db
        .query("crossDomainConnections")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .take(3),
    ]);
    // Connections are the strongest interest tell (a leap the kid made themselves),
    // so they count double.
    const score =
      Math.min(interestSeeds.length, 6) +
      Math.min(signals.length, 6) +
      2 * Math.min(connections.length, 3);
    if (score < FIRST_SKY_SIGNAL_FLOOR) {
      return { charted: false, reason: "below-floor" as const, score };
    }

    await ctx.scheduler.runAfter(0, internal.interpretive.generateConstellation, {
      scholarId: args.scholarId,
    });
    return { charted: true, score };
  },
});
