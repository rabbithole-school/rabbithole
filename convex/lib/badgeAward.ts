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
import { DEFAULT_BADGE_STYLE, DEFAULT_BADGE_COLORWAY } from "./badgeArt";
import { ONBOARDING_UNIT, ONBOARDING_UNIT_SLUG } from "../onboardingData";

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
      activity.kind === "online" &&
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
}
