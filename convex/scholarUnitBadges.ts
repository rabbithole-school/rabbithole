// Per-scholar earned unit completion badges.
//
// Replaces the old quest-scoped badges + scholarBadges tables. Each
// row represents "this scholar finished every online activity in
// this unit and earned the unit's badgeOnCompletion."
//
// Badges carry generative art (convex/badges.ts) minted async after
// earning; these queries resolve the stored image to a serving URL and
// surface the customization state (style/colorway/rerolls).

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { MAX_BADGE_REROLLS, DEFAULT_BADGE_STYLE, DEFAULT_BADGE_COLORWAY } from "./lib/badgeArt";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { isQuestUnitForScholar } from "./lib/questLifecycle";

async function hydrateArt(storage: QueryCtx["storage"], r: Doc<"scholarUnitBadges">) {
  const imageUrl = r.imageStorageId
    ? await storage.getUrl(r.imageStorageId)
    : null;
  const rerollsUsed = r.rerollsUsed ?? 0;
  return {
    imageUrl,
    style: r.style ?? DEFAULT_BADGE_STYLE,
    colorway: r.colorway ?? DEFAULT_BADGE_COLORWAY,
    artStatus: r.artStatus ?? (imageUrl ? "ready" : "generating"),
    rerollsUsed,
    rerollsRemaining: Math.max(0, MAX_BADGE_REROLLS - rerollsUsed),
  };
}

/** Earned badges for the calling scholar, newest first. */
export const myEarnedBadges = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .collect();
    rows.sort((a, b) => b.earnedAt - a.earnedAt);
    return Promise.all(
      rows.map(async (r) => {
        const unit = r.unitId ? await ctx.db.get(r.unitId) : null;
        const art = await hydrateArt(ctx.storage, r);
        const isQuestUnit = r.unitId
          ? await isQuestUnitForScholar(ctx, ctx.user._id, r.unitId)
          : false;
        return {
          _id: r._id,
          kind: r.kind ?? null,
          unitId: r.unitId,
          unitTitle: unit?.title ?? r.badgeSnapshot.title,
          unitEmoji: unit?.emoji ?? r.badgeSnapshot.icon ?? null,
          earnedAt: r.earnedAt,
          badge: r.badgeSnapshot,
          isQuestUnit,
          ...art,
        };
      }),
    );
  },
});

/**
 * The calling scholar's badge for a specific unit (or null). Powers the
 * completion celebration + customization strip — reactive, so the art
 * appears the moment it finishes generating.
 */
export const badgeForUnit = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    const r = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", ctx.user._id).eq("unitId", unitId),
      )
      .first();
    if (!r) return null;
    const unit = await ctx.db.get(unitId);
    const art = await hydrateArt(ctx.storage, r);
    const isQuestUnit = await isQuestUnitForScholar(
      ctx,
      ctx.user._id,
      unitId,
    );
    return {
      _id: r._id,
      kind: r.kind ?? null,
      unitId: r.unitId,
      unitTitle: unit?.title ?? r.badgeSnapshot.title,
      unitEmoji: unit?.emoji ?? r.badgeSnapshot.icon ?? null,
      earnedAt: r.earnedAt,
      badge: r.badgeSnapshot,
      isQuestUnit,
      ...art,
    };
  },
});

/**
 * Earned badges for a GIVEN scholar — teacher/admin (or the scholar themselves).
 * Powers the per-scholar "Badges" strip on the teacher's Work tab. Mirrors
 * myEarnedBadges but takes an explicit scholarId behind a teacher-or-self gate
 * (operations staff are excluded — they never see this surface).
 */
export const badgesForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    const rows = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    rows.sort((a, b) => b.earnedAt - a.earnedAt);
    return Promise.all(
      rows.map(async (r) => {
        const unit = r.unitId ? await ctx.db.get(r.unitId) : null;
        const art = await hydrateArt(ctx.storage, r);
        return {
          _id: r._id,
          kind: r.kind ?? null,
          unitId: r.unitId,
          unitTitle: unit?.title ?? r.badgeSnapshot.title,
          unitEmoji: unit?.emoji ?? r.badgeSnapshot.icon ?? null,
          earnedAt: r.earnedAt,
          badge: r.badgeSnapshot,
          ...art,
        };
      }),
    );
  },
});
