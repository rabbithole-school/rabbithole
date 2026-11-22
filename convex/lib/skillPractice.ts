// One math skill as givable work (TRA-582): the practice pair.
//
// A knowledge node isn't an activity, so a skill given to a class is carried
// by a pair: a lesson-less `problem_set` activity whose one target skill is
// the node, and an ad-hoc assignment holding the roster. From there the give
// pipeline, scholar visibility and the skill-scoped practice runner are the
// ones every activity uses. The grid's "+" and the aide reach it through
// gridGiveActions.giveToClass / giveHomework.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { PRACTICE_DOMAINS } from "./practice/domains";
import { readSchedule } from "./scheduleStore";
import { scheduleProblemSetItemGeneration } from "../practiceSkills";

export const NOT_A_PRACTICE_SKILL = "That math skill does not have targeted practice.";

/** True iff this activity is a skill pair's throwaway: a lesson-less one-node
 *  `problem_set`. Curriculum problem sets are always lesson-owned, so
 *  `lessonId` is the discriminator. */
export function isSkillAdapterActivity(act: Doc<"activities">): boolean {
  return (
    act.kind === "problem_set" &&
    !act.lessonId &&
    (act.problemSet?.targetSkillKeys.length ?? 0) === 1
  );
}

/**
 * The teacher's practice pair for (skill × exact roster), made on first use.
 * Giving the same skill to the same group again reuses it, so a scholar's
 * plate never shows the skill twice. A pair an old grid card still schedules
 * is left to that card (removing the card retires its pair).
 */
export async function ensureSkillPractice(
  ctx: MutationCtx,
  args: { teacherId: Id<"users">; roster: Id<"users">[]; nodeKey: string },
): Promise<{ assignmentId: Id<"assignments">; activityId: Id<"activities"> }> {
  const node = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.nodeKey))
    .first();
  if (!node || !PRACTICE_DOMAINS.some((info) => info.domain === node.domain)) {
    throw new ConvexError(NOT_A_PRACTICE_SKILL);
  }
  const roster = Array.from(new Set(args.roster));
  const rosterSet = new Set(roster.map(String));
  const mine = await ctx.db
    .query("assignments")
    .withIndex("by_teacher", (q) => q.eq("teacherId", args.teacherId))
    .collect();
  for (const a of mine) {
    if (a.archivedAt || a.kind !== "adHocDispatch" || a.unitId) continue;
    if (a.scholarIds.length !== rosterSet.size) continue;
    if (!a.scholarIds.every((id) => rosterSet.has(String(id)))) continue;
    for (const entry of await readSchedule(ctx, a)) {
      const act = await ctx.db.get(entry.activityId);
      if (!act || act.archivedAt || !isSkillAdapterActivity(act)) continue;
      if (act.problemSet?.targetSkillKeys[0] !== node.nodeKey) continue;
      const card = await ctx.db
        .query("schedulePlacements")
        .withIndex("by_activity", (q) => q.eq("activityId", act._id))
        .first();
      if (card) continue;
      return { assignmentId: a._id, activityId: act._id };
    }
  }
  const activityId = await ctx.db.insert("activities", {
    title: node.label,
    kind: "problem_set",
    problemSet: { domain: node.domain, targetSkillKeys: [node.nodeKey] },
    order: 0,
  });
  await scheduleProblemSetItemGeneration(ctx, activityId);
  const assignmentId = await ctx.db.insert("assignments", {
    teacherId: args.teacherId,
    scholarIds: roster,
    title: node.label,
    kind: "adHocDispatch",
    startedAt: Date.now(),
  });
  return { assignmentId, activityId };
}
