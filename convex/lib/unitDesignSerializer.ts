import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { granuleTexts } from "./granules";

function serializeActivityDesign(
  activity: Doc<"activities">,
  systemPrompt: string | null,
): string[] {
  const lines = [
    `    [${activity.kind}] ${activity.title}${activity.description ? `: ${activity.description}` : ""}`,
    "      systemPrompt:",
    ...(systemPrompt ?? "(none)").split("\n").map((line) => `        ${line}`),
  ];
  if (activity.deliverable) {
    lines.push(
      `      deliverable [${activity.deliverable.kind}, criteria: ${activity.deliverable.mode}]: ${activity.deliverable.prompt}`,
      ...activity.deliverable.criteria.map(
        (criterion) =>
          `        - ${criterion.label}${criterion.description ? `: ${criterion.description}` : ""}`,
      ),
    );
  } else {
    lines.push("      deliverable: (none)");
  }
  return lines;
}

/**
 * Serialize the activity's full unit context. A candidate prompt replaces only
 * the activity under test; passing its current prompt preserves the baked design.
 */
export async function serializeUnitDesign(
  ctx: Pick<QueryCtx, "db">,
  activityDoc: Doc<"activities">,
  candidateSystemPrompt: string | null,
): Promise<string> {
  const fallback = () =>
    [
      `Activity: ${activityDoc.title} (${activityDoc.kind})`,
      ...serializeActivityDesign(activityDoc, candidateSystemPrompt),
    ].join("\n");
  if (!activityDoc.lessonId) return fallback();

  const currentLesson = await ctx.db.get(activityDoc.lessonId);
  if (!currentLesson) return fallback();
  const unit = await ctx.db.get(currentLesson.unitId);
  if (!unit) return fallback();

  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
    .collect();
  lessons.sort((a, b) => a.order - b.order);

  const lines = [
    `Unit: ${unit.title}`,
    unit.subject ? `Subject: ${unit.subject}` : null,
    unit.gradeLevel ? `Grade: ${unit.gradeLevel}` : null,
    unit.bigIdea ? `Big Idea: ${unit.bigIdea}` : "Big Idea: (not set)",
    unit.essentialQuestions?.length
      ? `Essential Questions:\n${granuleTexts(unit.essentialQuestions)
          .map((question) => `  - ${question}`)
          .join("\n")}`
      : "Essential Questions: (none)",
    unit.enduringUnderstandings?.length
      ? `Enduring Understandings:\n${granuleTexts(
          unit.enduringUnderstandings,
        )
          .map((understanding) => `  - ${understanding}`)
          .join("\n")}`
      : "Enduring Understandings: (none)",
    "",
    `Lessons (${lessons.length}):`,
  ].filter((line): line is string => line !== null);

  for (const lesson of lessons) {
    lines.push(
      `  ${lesson.order + 1}. [${lesson.strand ?? "none"}] ${lesson.title}`,
    );
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
      .collect();
    activities.sort((a, b) => a.order - b.order);
    if (activities.length === 0) {
      lines.push("    activities: (none)");
      continue;
    }
    for (const activity of activities) {
      lines.push(
        ...serializeActivityDesign(
          activity,
          activity._id === activityDoc._id
            ? candidateSystemPrompt
            : (activity.systemPrompt ?? null),
        ),
      );
    }
  }
  return lines.join("\n");
}
