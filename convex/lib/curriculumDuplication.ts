import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { scheduleProblemSetItemGeneration } from "../practiceSkills";
import { granuleTexts, toKeyedGranules } from "./granules";

export function duplicateUnitDesign(
  source: Doc<"units">,
  teacherId: Id<"users">,
) {
  return {
    teacherId,
    title: `${source.title} (copy)`,
    emoji: source.emoji,
    description: source.description,
    scholarDescription: source.scholarDescription,
    systemPrompt: source.systemPrompt,
    rubric: source.rubric,
    targetBloomLevel: source.targetBloomLevel,
    personaId: source.personaId,
    perspectiveId: source.perspectiveId,
    processId: source.processId,
    durationMinutes: source.durationMinutes,
    youtubeUrl: source.youtubeUrl,
    videoTranscript: source.videoTranscript,
    bigIdea: source.bigIdea,
    essentialQuestions: source.essentialQuestions
      ? toKeyedGranules(
          granuleTexts(source.essentialQuestions),
          undefined,
          "eq",
        )
      : undefined,
    enduringUnderstandings: source.enduringUnderstandings
      ? toKeyedGranules(
          granuleTexts(source.enduringUnderstandings),
          undefined,
          "eu",
        )
      : undefined,
    subject: source.subject,
    gradeLevel: source.gradeLevel,
    mathDomain: source.mathDomain,
    isActive: true,
    badgeOnCompletion: source.badgeOnCompletion
      ? { ...source.badgeOnCompletion }
      : undefined,
    // Slug, scholar/seed provenance, and all separate maturity/review state
    // intentionally stay with the source; the duplicate is a new Draft.
  };
}

export function duplicateLessonDesign(
  source: Doc<"lessons">,
  unitId: Id<"units">,
  order: number,
  title = source.title,
) {
  return {
    unitId,
    title,
    strand: source.strand,
    systemPrompt: source.systemPrompt,
    processId: source.processId,
    order,
    durationMinutes: source.durationMinutes,
    selectionMode: source.selectionMode,
    choicePickCount: source.choicePickCount,
  };
}

export function duplicateActivityDesign(
  source: Doc<"activities">,
  lessonId: Id<"lessons">,
  order: number,
  title = source.title,
) {
  return {
    lessonId,
    title,
    description: source.description,
    kind: source.kind,
    webUrl: source.webUrl,
    webAllowedHosts: source.webAllowedHosts
      ? [...source.webAllowedHosts]
      : undefined,
    externalAppId: source.externalAppId,
    problemSet: source.problemSet
      ? {
          ...source.problemSet,
          targetSkillKeys: [...source.problemSet.targetSkillKeys],
        }
      : undefined,
    probeSkillKeys: source.probeSkillKeys
      ? [...source.probeSkillKeys]
      : undefined,
    game: source.game ? { ...source.game } : undefined,
    hasScholarAngles: source.hasScholarAngles,
    defaultMode: source.defaultMode,
    deliverable: source.deliverable
      ? {
          ...source.deliverable,
          criteria: source.deliverable.criteria.map((criterion) => ({
            ...criterion,
          })),
        }
      : undefined,
    advanceRubric: source.advanceRubric
      ? {
          criteria: source.advanceRubric.criteria.map((criterion) => ({
            ...criterion,
          })),
        }
      : undefined,
    referencedResourceIds: source.referencedResourceIds
      ? [...source.referencedResourceIds]
      : undefined,
    systemPrompt: source.systemPrompt,
    processId: source.processId,
    durationMinutes: source.durationMinutes,
    order,
    shareBackRecipe: source.shareBackRecipe,
    sourceActivityIds: source.sourceActivityIds
      ? [...source.sourceActivityIds]
      : undefined,
    facilitationFocus: source.facilitationFocus,
    recipe: source.recipe,
    // Google Slides attachment IDs and cached Drive metadata are generated
    // external state, not curriculum design, so a duplicate starts unattached.
  };
}

export type CopiedActivity = {
  source: Doc<"activities">;
  copyId: Id<"activities">;
};

export async function duplicateActivitiesIntoLesson(
  ctx: MutationCtx,
  sourceLessonId: Id<"lessons">,
  targetLessonId: Id<"lessons">,
  activityIdMap: Map<string, Id<"activities">>,
): Promise<CopiedActivity[]> {
  const activities = await ctx.db
    .query("activities")
    .withIndex("by_lesson", (q) => q.eq("lessonId", sourceLessonId))
    .collect();
  activities.sort((a, b) => a.order - b.order);

  const copied: CopiedActivity[] = [];
  for (const activity of activities) {
    const copyId = await ctx.db.insert(
      "activities",
      duplicateActivityDesign(
        activity,
        targetLessonId,
        activity.order,
      ),
    );
    if (activity.kind === "problem_set") {
      await scheduleProblemSetItemGeneration(ctx, copyId);
    }
    activityIdMap.set(String(activity._id), copyId);
    copied.push({ source: activity, copyId });
  }
  return copied;
}

export async function remapCopiedActivityReferences(
  ctx: MutationCtx,
  copied: CopiedActivity[],
  activityIdMap: Map<string, Id<"activities">>,
  options: { dropUnmappedResourceReferences?: boolean } = {},
) {
  for (const { source, copyId } of copied) {
    const updates: {
      sourceActivityIds?: Id<"activities">[];
      referencedResourceIds?: Id<"activityResources">[] | undefined;
    } = {};
    if (source.sourceActivityIds) {
      updates.sourceActivityIds = source.sourceActivityIds.map(
        (sourceId) => activityIdMap.get(String(sourceId)) ?? sourceId,
      );
    }
    if (
      options.dropUnmappedResourceReferences &&
      source.referencedResourceIds
    ) {
      updates.referencedResourceIds = undefined;
    }
    if (Object.keys(updates).length > 0) await ctx.db.patch(copyId, updates);
  }
}
