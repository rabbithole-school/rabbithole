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
import { assertProposalIsOpen } from "./lib/questStructure";
import { insertBadgeAndMintArt } from "./lib/badgeAward";
import { aboutThreadInstitutionId } from "./lib/scholarThreadAccess";
import { awardQuestBadgeAs } from "./questShowing";
import { noteSkyStar, runSkyHook } from "./lib/skyRefresh";
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
      kind: badge.kind ?? null,
      style: (badge.style ?? DEFAULT_BADGE_STYLE) as BadgeStyle,
      colorway: (badge.colorway ?? DEFAULT_BADGE_COLORWAY) as BadgeColorway,
      previousImageStorageId: badge.imageStorageId ?? null,
      unitTitle: unit?.title ?? badge.badgeSnapshot.title,
      // The badge's own snapshot, never `unit.description`: that is the
      // teacher-facing copy (on a Quest, notes about the child), and the art
      // is something the scholar sees.
      description: badge.badgeSnapshot.description ?? null,
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
    // The Calculator License badge's image is the license card, not art.
    return rows
      .filter((r) => r.kind !== "calculator_license")
      .map((r) => r._id);
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
    // The Calculator License badge is the license card itself — there is no
    // art to remix (the surfaces hide the strip; this refuses it server-side).
    if (badge.kind === "calculator_license") {
      throw new Error("This badge can't be remixed");
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

/** A generated badge name, clipped with an ellipsis to the Quest limit. */
const GENERATED_NAME_MAX = 60;
function fitBadgeName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length <= GENERATED_NAME_MAX) return clean;
  const suffix = " — completed";
  if (clean.endsWith(suffix)) {
    const room = GENERATED_NAME_MAX - suffix.length - 1;
    return `${clean.slice(0, clean.length - suffix.length).slice(0, room).trimEnd()}…${suffix}`;
  }
  return `${clean.slice(0, GENERATED_NAME_MAX - 1).trimEnd()}…`;
}

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
      if (!unit || !unit.isActive) throw new Error("Unit not found");
      // A scholar's own Quest is theirs alone; a curriculum unit, if stamped
      // with a school, is one this scholar is at now.
      if (unit.authorScholarId && unit.authorScholarId !== args.scholarId) {
        throw new Error("Unit not found");
      }
      const schoolId = await aboutThreadInstitutionId(ctx, scholar);
      if (unit.institutionId && unit.institutionId !== schoolId) {
        throw new Error("Unit not found");
      }
      // A proposal or offer Quest earns its badge only through the Quest
      // core, so the two paths can't drift (questShowing.ts).
      if (unit.questApproval) {
        const outcome = await awardQuestBadgeAs(ctx, ctx.user, {
          unitId: unit._id,
          // A name the teacher typed is checked against the Quest limit; the
          // generated default is trimmed to fit it instead.
          badgeName: args.title ?? fitBadgeName(unit.badgeOnCompletion?.title ?? unit.title),
          style: args.style,
          colorway: args.colorway,
        });
        return {
          badgeId: outcome.badgeId,
          alreadyEarned: outcome.alreadyAwarded,
        };
      }
      // A Quest proposal still waiting (or declined) earns nothing yet.
      assertProposalIsOpen(unit);

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
        // The scholar reads this in their trophy case, so the fallback is
        // the unit's scholar-facing copy, never its teacher-facing
        // `description` (on a Quest a teacher offered one scholar, that is
        // the teacher's notes about the child). With neither, no
        // description, which every badge reader already handles.
        description:
          args.description ??
          unit.badgeOnCompletion?.description ??
          unit.scholarDescription ??
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

    const badgeId = await insertBadgeAndMintArt(ctx, {
      scholarId: args.scholarId,
      unitId: args.unitId,
      badgeSnapshot,
      style,
      colorway,
    });
    // A badge on the kid's own older Quest shows it: its bright star on
    // their Sky (TRA-699). Any other unit is not theirs and adds nothing.
    // A local, so the check carries into the hook's closure.
    const unitId = args.unitId;
    if (unitId) {
      await runSkyHook("badges.awardUnitBadge", () =>
        noteSkyStar(ctx, args.scholarId, { unitId }),
      );
    }

    return { badgeId, alreadyEarned: false };
  },
});
