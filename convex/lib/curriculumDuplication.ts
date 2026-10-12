import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { generateAppToken } from "../customApps";
import { scheduleProblemSetItemGeneration } from "../practiceSkills";
import { granuleTexts, toKeyedGranules } from "./granules";
import { institutionIdForUnitAuthor } from "./unitAccess";
import { normalizeStoredTutorModel } from "./tutorModel";
import { isUsableVibecodeStarterApp } from "./vibecodeStarter";

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
    // A copy starts unpublished even when its source is published: it is a
    // new Draft the teacher is about to change, so scholars meet it only
    // once it is published or assigned (TRA-490).
    unpublished: true,
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
    tutorModel:
      source.kind === "vibecode"
        ? normalizeStoredTutorModel(source.tutorModel)
        : undefined,
    starterAppId: source.starterAppId,
    scholarsStartFrom: source.scholarsStartFrom,
    // The model contract travels with the design (duplicate AND fork).
    buildContract:
      source.kind === "vibecode" && source.buildContract
        ? {
            invariants: [...source.buildContract.invariants],
            freedoms: [...source.buildContract.freedoms],
            ...(source.buildContract.gate
              ? { gate: source.buildContract.gate }
              : {}),
          }
        : undefined,
    allowSilence:
      source.kind === "vibecode" ? source.allowSilence : undefined,
    hasScholarAngles: source.hasScholarAngles,
    assessesWritingMechanics: source.assessesWritingMechanics,
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

function labUnitTitle(activityTitle: string): string {
  const title = activityTitle.trim() || "Activity";
  return /\blab$/i.test(title) ? title : `${title} Lab`;
}

/**
 * Fork one activity into curriculum owned by `callerUserId`.
 *
 * Unlike the ordinary duplicate operations, this is a portability boundary:
 * a vibecode starter is cloned into a new `customApps` row so the caller can
 * edit their fork without changing the source teacher's app.
 */
export async function forkActivityIntoOwnedUnit(
  ctx: MutationCtx,
  source: Doc<"activities">,
  callerUserId: Id<"users">,
  targetUnitId?: Id<"units">,
) {
  let unit: Doc<"units"> | null = null;
  if (targetUnitId) {
    unit = await ctx.db.get(targetUnitId);
    if (!unit) throw new Error("Target unit not found");
    if (unit.teacherId !== callerUserId || unit.authorScholarId) {
      throw new Error("Forbidden: target unit must be owned by you");
    }
  } else {
    const title = labUnitTitle(source.title);
    const institutionId = await institutionIdForUnitAuthor(
      ctx,
      callerUserId,
    );
    const primaryInstitution = (
      await ctx.db.query("institutions").collect()
    ).find((institution) => institution.isPrimary);
    const authoredUnits = await ctx.db
      .query("units")
      .withIndex("by_teacher", (q) => q.eq("teacherId", callerUserId))
      .collect();
    unit =
      authoredUnits.find(
        (candidate) =>
          !candidate.authorScholarId &&
          (candidate.institutionId === institutionId ||
            (candidate.institutionId === undefined &&
              primaryInstitution?._id === institutionId)) &&
          candidate.title.trim().toLowerCase() === title.toLowerCase(),
      ) ?? null;
    if (!unit) {
      const unitId = await ctx.db.insert("units", {
        teacherId: callerUserId,
        institutionId,
        title,
        isActive: true,
        // Teachers only until published or assigned (TRA-490).
        unpublished: true,
      });
      unit = await ctx.db.get(unitId);
    }
  }
  if (!unit) throw new Error("Could not create target unit");

  const lessonTitle = `Explore ${source.title.trim() || "activity"}`;
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
    .collect();
  let lesson: Doc<"lessons"> | null =
    lessons.find(
      (candidate) =>
        candidate.title.trim().toLowerCase() === lessonTitle.toLowerCase(),
    ) ?? null;
  if (!lesson) {
    const lessonId = await ctx.db.insert("lessons", {
      unitId: unit._id,
      title: lessonTitle,
      order: lessons.reduce(
        (max, candidate) => Math.max(max, candidate.order),
        -1,
      ) + 1,
    });
    lesson = await ctx.db.get(lessonId);
  }
  if (!lesson) throw new Error("Could not create target lesson");

  const activities = await ctx.db
    .query("activities")
    .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
    .collect();
  const existingActivity = activities.find(
    (candidate) =>
      candidate.title.trim().toLowerCase() ===
      source.title.trim().toLowerCase(),
  );
  if (existingActivity) {
    return {
      unitId: unit._id,
      unitTitle: unit.title,
      lessonId: lesson._id,
      activityId: existingActivity._id,
      activityTitle: existingActivity.title,
    };
  }

  let starterAppId: Id<"customApps"> | undefined;
  if (source.starterAppId) {
    const starter = await ctx.db.get(source.starterAppId);
    if (!isUsableVibecodeStarterApp(starter)) {
      throw new Error("Activity starter app is missing or unusable");
    }
    starterAppId = await ctx.db.insert("customApps", {
      token: generateAppToken(),
      name: starter.name,
      kind: "static",
      status: "live",
      html: starter.html,
      appAi: starter.appAi,
      origin: "starter",
      createdBy: callerUserId,
      updatedAt: Date.now(),
    });
  }

  const activityId = await ctx.db.insert("activities", {
    ...duplicateActivityDesign(
      source,
      lesson._id,
      activities.reduce(
        (max, candidate) => Math.max(max, candidate.order),
        -1,
      ) + 1,
    ),
    appRequest: source.appRequest,
    starterAppId,
  });
  if (source.kind === "problem_set") {
    await scheduleProblemSetItemGeneration(ctx, activityId);
  }

  return {
    unitId: unit._id,
    unitTitle: unit.title,
    lessonId: lesson._id,
    activityId,
    activityTitle: source.title,
  };
}
