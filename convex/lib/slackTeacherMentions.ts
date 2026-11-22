// Who a staff Slack copy of a Messages conversation @-mentions: the teachers
// the conversation concerns. Shared by the parent-message channel
// (parentMessages.getSlackNotificationContext) and the scholar-conversation
// channel (scholarMessageSlack.ts).

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { teachesAtInstitution } from "./scholarThreadAccess";

/** A Slack member id we may put in a mention. */
const SLACK_MEMBER_ID = /^[UW][A-Za-z0-9_-]+$/;

type RelevantTeacherArgs = {
  institutionId: Id<"institutions">;
  scholarIds: Id<"users">[];
  staffWriterIds: Id<"users">[];
  authorUserId: Id<"users"> | undefined;
};

/**
 * The teachers a conversation concerns: the staff who wrote in it and the
 * owners of the scholars' classes at `institutionId`, minus the message's
 * author. Only someone on that school's teaching team counts, so an outside
 * mentor or an operations staffer is never included. Shared by the Slack
 * mentions below and the staff email copy (parentMessageStaffEmail.ts).
 */
export async function relevantTeacherIds(
  ctx: QueryCtx,
  args: RelevantTeacherArgs,
): Promise<Doc<"users">[]> {
  const candidates = new Set<Id<"users">>(args.staffWriterIds);
  if (args.scholarIds.length > 0) {
    const groups = await ctx.db
      .query("scholarGroups")
      .withIndex("by_institution", (q) => q.eq("institutionId", args.institutionId))
      .collect();
    for (const group of groups) {
      if (group.ownerId && args.scholarIds.some((id) => group.scholarIds.includes(id))) {
        candidates.add(group.ownerId);
      }
    }
  }
  if (args.authorUserId) candidates.delete(args.authorUserId);

  const users = await Promise.all(
    [...candidates].map(async (userId) => {
      const user = await ctx.db.get(userId);
      if (!user || user.isSystem) return null;
      return (await teachesAtInstitution(ctx, userId, args.institutionId))
        ? user
        : null;
    }),
  );
  return users.filter((user): user is Doc<"users"> => user !== null);
}

/** The Slack ids of `relevantTeacherIds` who have a linked Slack member id. */
export async function relevantTeacherSlackIds(
  ctx: QueryCtx,
  args: RelevantTeacherArgs,
): Promise<string[]> {
  const slackIds = (await relevantTeacherIds(ctx, args))
    .map((user) => user.slackUserId)
    .filter((id): id is string => !!id && SLACK_MEMBER_ID.test(id));
  return [...new Set(slackIds)].sort();
}
