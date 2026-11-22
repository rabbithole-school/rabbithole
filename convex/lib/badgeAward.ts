// Shared badge-award check — call after ANY path marks an activity
// complete (AI rubric pass, manual "Mark complete" toggle, or a web
// activity finishing). When the activity's unit has a `badgeOnCompletion`
// config AND every online activity in the unit is now complete for the
// scholar, mint the badge once and schedule its generative art.
//
// Lives here (not in deliverables.ts) so every completion path shares one
// definition — otherwise badges only mint on the rubric path and a manual
// completion silently skips them.

import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  DEFAULT_BADGE_STYLE,
  DEFAULT_BADGE_COLORWAY,
  type BadgeColorway,
  type BadgeStyle,
} from "./badgeArt";
import { ONBOARDING_UNIT, ONBOARDING_UNIT_SLUG } from "../onboardingData";
import { effectiveActivityKind } from "../../shared/appSurface";
import { noteSkyStar, runSkyHook } from "./skyRefresh";

/**
 * The one writer of a manually awarded badge row: inserts it and schedules
 * the same generative art the auto path mints. Shared by `awardUnitBadge` and
 * a Quest's showing (questShowing.ts), so neither can skip the art.
 */
export async function insertBadgeAndMintArt(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    unitId?: Id<"units">;
    badgeSnapshot: { title: string; description?: string; icon?: string };
    style: BadgeStyle;
    colorway: BadgeColorway;
  },
): Promise<Id<"scholarUnitBadges">> {
  const badgeId = await ctx.db.insert("scholarUnitBadges", {
    scholarId: args.scholarId,
    ...(args.unitId ? { unitId: args.unitId } : {}),
    earnedAt: Date.now(),
    badgeSnapshot: args.badgeSnapshot,
    style: args.style,
    colorway: args.colorway,
    artStatus: "generating",
    rerollsUsed: 0,
  });
  // Mint the generative art async, exactly like the auto-award path.
  await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, {
    badgeId,
  });
  return badgeId;
}

export async function maybeAwardUnitBadge(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
) {
  const activity = await ctx.db.get(activityId);
  if (!activity?.lessonId) return;
  const lesson = await ctx.db.get(activity.lessonId);
  if (!lesson) return;
  const unit = await ctx.db.get(lesson.unitId);
  if (!unit?.badgeOnCompletion) return;
  // A Quest that came through a proposal or a teacher's offer earns its badge
  // when a teacher awards it (questShowing.ts awardQuestBadgeAs), never on
  // completion. Older Quests without `questApproval` keep this path.
  if (unit.questApproval) return;

  // Already earned?
  const existing = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar_unit", (q) =>
      q.eq("scholarId", scholarId).eq("unitId", unit._id),
    )
    .first();
  if (existing) return;

  // Gather every activity in the unit (online only — offline activities
  // don't have completion semantics).
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
    .collect();
  const allActivities: Doc<"activities">[] = [];
  for (const l of lessons) {
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
      .collect();
    allActivities.push(...acts);
  }
  const currentOnboardingTitles =
    unit.slug === ONBOARDING_UNIT_SLUG
      ? new Set(ONBOARDING_UNIT.activities.map((activity) => activity.title))
      : null;
  const onlineActivities = allActivities.filter(
    (activity) =>
      effectiveActivityKind(activity) === "online" &&
      (!currentOnboardingTitles || currentOnboardingTitles.has(activity.title)),
  );
  if (onlineActivities.length === 0) return;

  const completions = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar_unit", (q) =>
      q.eq("scholarId", scholarId).eq("unitId", unit._id),
    )
    .collect();
  const doneIds = new Set(completions.map((c) => String(c.activityId)));
  const allDone = onlineActivities.every((a) => doneIds.has(String(a._id)));
  if (!allDone) return;

  const badgeId = await ctx.db.insert("scholarUnitBadges", {
    scholarId,
    unitId: unit._id,
    earnedAt: Date.now(),
    badgeSnapshot: unit.badgeOnCompletion,
    style: DEFAULT_BADGE_STYLE,
    colorway: DEFAULT_BADGE_COLORWAY,
    artStatus: "generating",
    rerollsUsed: 0,
  });
  // Generative art is minted async (Gemini, like the tutor's generate_image)
  // — the emoji snapshot shows until it lands. See convex/badges.ts.
  await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, { badgeId });
  // An older Quest of the kid's own, shown: its bright star (TRA-699).
  if (unit.authorScholarId === scholarId) {
    await runSkyHook("badgeAward", () => noteSkyStar(ctx, scholarId, { unitId: unit._id }));
  }
}
