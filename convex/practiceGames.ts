/**
 * Game-beat lifecycle mutations + the teacher's binding surface.
 *
 * The run selector (`practiceSkills.practiceSession` → `gameBeat`) is a QUERY
 * and cannot write, so the daily budget is claimed here from the client when
 * the doorway mounts — exactly the pattern `instruction.ts` uses for the
 * Launchpad.
 *
 * Every write here is SYSTEM-ONLY scholar telemetry: offers and declines. It
 * must never feed mastery, credit, adaptive difficulty, or any learner-/
 * teacher-facing quality surface. Passing on a game is a preference, not a
 * deficit — and a game's outcome never touches mastery at all (D-3).
 *
 * Note what is NOT here: nothing that grades, scores, or awards. Opening the
 * doorway hands off to `games.start`, which owns the round; the evidence path
 * is the host's and the conclusion is the server's. This file only ever answers
 * "was it offered, and did they take it".
 */

import { v } from "convex/values";

import { dayKeyForTimezone } from "../shared/institutionDay";
import { requireActiveScholarAccess } from "./lib/access";
import { requireTeacherOrSelf } from "./lib/auth";
import { authedMutation, authedQuery, curriculumMutation } from "./lib/customFunctions";
import { timeZoneForScholar } from "./lib/institutionTime";
import { gameBeatKey, gameBeatOfferId } from "./lib/practice/gameBeats";

/**
 * Claim the doorway's impression. Called on mount, idempotent per day.
 *
 * Authoritative half of the advisory selection in `practiceSession`: the query
 * proposes, this re-checks the per-day budget and records the offer. Bumping
 * `offerCount` only when the day actually changes is what keeps a reload from
 * burning the scholar's re-offer allowance.
 */
export const claimGameBeatOffer = authedMutation({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const key = gameBeatKey(String(args.activityId));
    const now = Date.now();
    const dayBucket = dayKeyForTimezone(now, await timeZoneForScholar(ctx, ctx.user._id));
    const existing = await ctx.db
      .query("practiceGameOffers")
      .withIndex("by_scholar_key", (q) => q.eq("scholarId", ctx.user._id).eq("key", key))
      .first();
    if (!existing) {
      await ctx.db.insert("practiceGameOffers", {
        scholarId: ctx.user._id,
        key,
        offerId: gameBeatOfferId(String(ctx.user._id), key),
        activityId: args.activityId,
        offerCount: 1,
        lastOfferedAt: now,
        lastOfferedDayBucket: dayBucket,
      });
      return { claimed: true };
    }
    if (existing.lastOfferedDayBucket === dayBucket) {
      // Same day, same doorway — a remount, not a new offer.
      return { claimed: false };
    }
    await ctx.db.patch(existing._id, {
      offerCount: existing.offerCount + 1,
      lastOfferedAt: now,
      lastOfferedDayBucket: dayBucket,
    });
    return { claimed: true };
  },
});

/**
 * The scholar passed the doorway.
 *
 * Recorded so a repeatedly-passed game eventually rests (`GAME_BEAT_REOFFER_CAP`)
 * — the one fact `gameSessions` structurally cannot hold, because declining
 * starts no session. Deliberately NOT terminal on its own: one pass never
 * suppresses a game permanently.
 */
export const declineGameBeat = authedMutation({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const key = gameBeatKey(String(args.activityId));
    const existing = await ctx.db
      .query("practiceGameOffers")
      .withIndex("by_scholar_key", (q) => q.eq("scholarId", ctx.user._id).eq("key", key))
      .first();
    if (!existing) return { recorded: false };
    await ctx.db.patch(existing._id, { declinedAt: Date.now() });
    return { recorded: true };
  },
});

/**
 * The scholar opened the doorway. Telemetry only — `games.start` opens the
 * actual round and `gameSessions` is the record of it.
 */
export const acceptGameBeat = authedMutation({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const key = gameBeatKey(String(args.activityId));
    const existing = await ctx.db
      .query("practiceGameOffers")
      .withIndex("by_scholar_key", (q) => q.eq("scholarId", ctx.user._id).eq("key", key))
      .first();
    if (!existing) return { recorded: false };
    await ctx.db.patch(existing._id, { lastAcceptedAt: Date.now(), declinedAt: undefined });
    return { recorded: true };
  },
});

// ── Teacher surface: bind a game to a slice of the practice graph ─────────

/** Bind a `kind="game"` activity to a (domain, strand[, skills]) slice. */
export const bindGameToStrand = curriculumMutation({
  args: {
    activityId: v.id("activities"),
    domain: v.string(),
    strand: v.string(),
    skillKeys: v.optional(v.array(v.string())),
    blurb: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (activity.kind !== "game" || !activity.game?.gameId) {
      // Checked here rather than trusted at serve time: a binding that could
      // never render is a silently-dead teacher action, which is worse than a
      // refusal at the moment they made it.
      throw new Error("Only a kind=\"game\" activity can be bound to a strand");
    }
    const existing = await ctx.db
      .query("practiceGameBindings")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();
    const match = existing.find((b) => b.domain === args.domain && b.strand === args.strand);
    if (match) {
      await ctx.db.patch(match._id, {
        skillKeys: args.skillKeys,
        blurb: args.blurb,
        isActive: true,
      });
      return { id: match._id, mode: "updated" as const };
    }
    const id = await ctx.db.insert("practiceGameBindings", {
      activityId: args.activityId,
      domain: args.domain,
      strand: args.strand,
      skillKeys: args.skillKeys,
      blurb: args.blurb,
      isActive: true,
      createdBy: ctx.user._id,
    });
    return { id, mode: "created" as const };
  },
});

/** Turn a binding off without losing how it was configured. */
export const setGameBindingActive = curriculumMutation({
  args: { bindingId: v.id("practiceGameBindings"), isActive: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.bindingId, { isActive: args.isActive });
    return { ok: true };
  },
});

/** Every binding, for the teacher's curriculum surface. */
export const listGameBindings = authedQuery({
  args: { domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("practiceGameBindings").collect();
    const filtered = args.domain ? rows.filter((r) => r.domain === args.domain) : rows;
    return Promise.all(
      filtered.map(async (r) => {
        const activity = await ctx.db.get(r.activityId);
        return {
          _id: r._id,
          activityId: r.activityId,
          activityTitle: activity?.title ?? "(deleted activity)",
          gameId: activity?.kind === "game" ? (activity.game?.gameId ?? null) : null,
          domain: r.domain,
          strand: r.strand,
          skillKeys: r.skillKeys ?? null,
          blurb: r.blurb ?? null,
          isActive: r.isActive,
        };
      }),
    );
  },
});

/**
 * A scholar's game-beat offer history — teacher-readable so a bound game that
 * is never being taken is visible as a CURRICULUM signal (wrong strand? wrong
 * moment?), not as a fact about the child.
 */
export const offersForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("practiceGameOffers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    return rows.map((r) => ({
      key: r.key,
      activityId: r.activityId,
      offerCount: r.offerCount,
      lastOfferedAt: r.lastOfferedAt ?? null,
      lastAcceptedAt: r.lastAcceptedAt ?? null,
      declinedAt: r.declinedAt ?? null,
    }));
  },
});
