// Generative quest-badge art — the async mint + scholar remix flow.
//
// When a scholar finishes a structured quest, `maybeAwardUnitBadge`
// (deliverables.ts) inserts a `scholarUnitBadges` row and schedules
// `badgeArtActions.generateBadgeArt` (a "use node" action — it builds a
// topic-true prompt from lib/badgeArt.ts, calls the Gemini image model on a
// chroma-green screen, strips the green to transparency with pngjs, stores the
// PNG, and patches the row). The emoji snapshot is shown until the art lands
// (or if it fails). This file holds the V8-runtime queries/mutations + remix.
//
// `customizeBadge` lets the scholar remix the art with PRESET style/color
// choices only — capped at MAX_BADGE_REROLLS so it can't become a distraction.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { authedMutation, teacherMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { ROLES } from "./lib/roles";
import {
  isBadgeColorway,
  isBadgeStyle,
  DEFAULT_BADGE_STYLE,
  DEFAULT_BADGE_COLORWAY,
  MAX_BADGE_REROLLS,
  type BadgeColorway,
  type BadgeStyle,
} from "./lib/badgeArt";

// ── Internal: read the data needed to render a badge ──────────────────

export const getBadgeForArt = internalQuery({
  args: { badgeId: v.id("scholarUnitBadges") },
  handler: async (ctx, { badgeId }) => {
    const badge = await ctx.db.get(badgeId);
    if (!badge) return null;
    const unit = badge.unitId ? await ctx.db.get(badge.unitId) : null;
    return {
      style: (badge.style ?? DEFAULT_BADGE_STYLE) as BadgeStyle,
      colorway: (badge.colorway ?? DEFAULT_BADGE_COLORWAY) as BadgeColorway,
      previousImageStorageId: badge.imageStorageId ?? null,
      unitTitle: unit?.title ?? badge.badgeSnapshot.title,
      description: unit?.description ?? badge.badgeSnapshot.description ?? null,
      subject: unit?.subject ?? null,
    };
  },
});

// ── Internal: write the result back ───────────────────────────────────

export const setBadgeArt = internalMutation({
  args: {
    badgeId: v.id("scholarUnitBadges"),
    imageStorageId: v.id("_storage"),
    previousImageStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.badgeId, {
      imageStorageId: args.imageStorageId,
      artStatus: "ready",
    });
    // Clean up the prior image on a remix so we don't orphan storage.
    if (
      args.previousImageStorageId &&
      args.previousImageStorageId !== args.imageStorageId
    ) {
      await ctx.storage.delete(args.previousImageStorageId);
    }
  },
});

export const setBadgeArtStatus = internalMutation({
  args: {
    badgeId: v.id("scholarUnitBadges"),
    status: v.union(
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, { badgeId, status }) => {
    await ctx.db.patch(badgeId, { artStatus: status });
  },
});

// ── The generation action lives in badgeArtActions.ts ("use node") ────
// (it needs pngjs/zlib to chroma-key the green screen; this file is V8-runtime
//  mutations). This query backs the regenerate-art backfill there.

export const allBadgeIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("scholarUnitBadges").collect();
    return rows.map((r) => r._id);
  },
});

// ── Seed support: rows to match against the pre-baked seed badge art ──
// Returns every badge row keyed by the scholar's username + snapshot title so
// the seed's `attach` action (seedBadgeArt.ts) can find the row for each
// fixture badge and stamp its committed image. `hasImage` lets attach skip
// rows already carrying art (idempotent re-seed).
export const seedBadgeRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("scholarUnitBadges").collect();
    return Promise.all(
      rows.map(async (r) => {
        const scholar = await ctx.db.get(r.scholarId);
        return {
          _id: r._id,
          scholarUsername: scholar?.username ?? null,
          title: r.badgeSnapshot.title,
          hasImage: r.imageStorageId != null,
        };
      }),
    );
  },
});

// ── Scholar-facing: remix the badge (preset choices, capped) ──────────

export const customizeBadge = authedMutation({
  args: {
    badgeId: v.id("scholarUnitBadges"),
    style: v.string(),
    colorway: v.string(),
  },
  handler: async (ctx, args) => {
    const badge = await ctx.db.get(args.badgeId);
    if (!badge) throw new Error("Badge not found");
    if (String(badge.scholarId) !== String(ctx.user._id)) {
      throw new Error("Not your badge");
    }
    if (!isBadgeStyle(args.style)) throw new Error("Unknown badge style");
    if (!isBadgeColorway(args.colorway)) throw new Error("Unknown colorway");

    const used = badge.rerollsUsed ?? 0;
    if (used >= MAX_BADGE_REROLLS) {
      throw new Error("No remixes left for this badge");
    }

    await ctx.db.patch(args.badgeId, {
      style: args.style,
      colorway: args.colorway,
      rerollsUsed: used + 1,
      artStatus: "generating",
    });
    await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, {
      badgeId: args.badgeId,
    });

    return { ok: true, rerollsRemaining: MAX_BADGE_REROLLS - (used + 1) };
  },
});

// ── Teacher-facing: manually award a unit badge ───────────────────────
//
// Escape hatch for when a scholar earned a badge in spirit but the
// auto-mint (maybeAwardUnitBadge) didn't fire — a glitch, a curriculum
// edit mid-quest, or a make-good. Mints the row + schedules the same
// generative art as the auto path. The optional snapshot/style/colorway
// overrides let a teacher make a make-good badge extra special. Idempotent
// per (scholar, unit): re-awarding the same unit returns the existing
// badge rather than minting a duplicate.
export const awardUnitBadge = teacherMutation({
  args: {
    scholarId: v.id("users"),
    // Omit to award a free-standing "custom" badge (no unit); a title is then
    // required since there's no unit to derive one from.
    unitId: v.optional(v.id("units")),
    // Optional preset art choices (default to the house style / palette).
    style: v.optional(v.union(v.literal("patch"), v.literal("medallion"))),
    colorway: v.optional(v.string()),
    // Optional snapshot overrides — default to the unit's badgeOnCompletion
    // (falling back to the unit's own title/description/emoji). Required for a
    // custom (unit-less) badge.
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    icon: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Target user is not a scholar");
    }

    let badgeSnapshot: { title: string; description?: string; icon?: string };

    if (args.unitId) {
      const unit = await ctx.db.get(args.unitId);
      if (!unit) throw new Error("Unit not found");

      // Idempotent — never double-award the same (scholar, unit).
      const existing = await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", args.scholarId).eq("unitId", args.unitId),
        )
        .first();
      if (existing) {
        return { badgeId: existing._id, alreadyEarned: true };
      }

      badgeSnapshot = {
        title: args.title ?? unit.badgeOnCompletion?.title ?? unit.title,
        description:
          args.description ??
          unit.badgeOnCompletion?.description ??
          unit.description ??
          undefined,
        icon: args.icon ?? unit.badgeOnCompletion?.icon ?? unit.emoji ?? undefined,
      };
    } else {
      // Custom (unit-less) badge — a title is the only required ingredient. No
      // idempotency: a teacher may award the same custom badge more than once.
      const title = args.title?.trim();
      if (!title) throw new Error("A custom badge needs a title");
      badgeSnapshot = {
        title,
        description: args.description?.trim() || undefined,
        icon: args.icon?.trim() || undefined,
      };
    }

    const style: BadgeStyle = args.style ?? DEFAULT_BADGE_STYLE;
    const colorway: BadgeColorway =
      args.colorway && isBadgeColorway(args.colorway)
        ? args.colorway
        : DEFAULT_BADGE_COLORWAY;

    const badgeId = await ctx.db.insert("scholarUnitBadges", {
      scholarId: args.scholarId,
      ...(args.unitId ? { unitId: args.unitId } : {}),
      earnedAt: Date.now(),
      badgeSnapshot,
      style,
      colorway,
      artStatus: "generating",
      rerollsUsed: 0,
    });
    // Mint the generative art async, exactly like the auto-award path.
    await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, {
      badgeId,
    });

    return { badgeId, alreadyEarned: false };
  },
});
