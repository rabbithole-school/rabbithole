// The Quest ideas under a day's wonder (TRA-697): their rows, what a wonder's
// message shows for them, and the check that a tap is on an idea's own post.
// Drafting is dayWonderIdeasActions.ts, storing them is dayWonders.storeIdeas,
// the tap is wonderQuestIdeaSlack.ts, the wording is lib/wonderQuestIdeas.ts.

import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { aboutSlackRootsFor } from "./scholarMessages";
import { ideaStamp, type IdeaForMessage } from "./lib/wonderQuestIdeas";
import { aboutThreadInstitutionId } from "./lib/scholarThreadAccess";
import { internal } from "./_generated/api";

/** A teacher as a message names them. */
function teacherName(user: Doc<"users"> | null): string {
  return user?.name?.trim() || user?.username?.trim() || "a teacher";
}

/** The ideas on one wonder's message, in button order, each with who offered
 *  it once it has been. */
export async function ideasOnWonder(
  ctx: QueryCtx,
  noteId: Id<"dayWonderNotes">,
  seedId: Id<"seeds">,
): Promise<IdeaForMessage[]> {
  const rows = await ctx.db
    .query("wonderQuestIdeas")
    .withIndex("by_note_seed", (q) => q.eq("noteId", noteId).eq("seedId", seedId))
    .collect();
  const out: IdeaForMessage[] = [];
  for (const row of rows) {
    let offeredBy: string | undefined;
    if (row.state === "offered") {
      const unit = row.unitId ? await ctx.db.get(row.unitId) : null;
      const offerer = unit?.questApproval?.offeredBy
        ? await ctx.db.get(unit.questApproval.offeredBy)
        : null;
      offeredBy = teacherName(offerer);
    }
    out.push({
      ideaId: row._id,
      position: row.position,
      kind: row.kind,
      title: row.title,
      mission: row.mission,
      ...(offeredBy === undefined ? {} : { offeredBy }),
    });
  }
  return out.sort((a, b) => a.position - b.position);
}

export const ideasForWonder = internalQuery({
  args: { noteId: v.id("dayWonderNotes"), seedId: v.id("seeds") },
  handler: async (ctx, { noteId, seedId }): Promise<IdeaForMessage[]> =>
    await ideasOnWonder(ctx, noteId, seedId),
});

/**
 * The idea a tap is on, only when the tap is on that idea's own post: the
 * wonder message whose thread is mapped to this kid and this wonder
 * (dayWonders.deliverNote). An id taken from one message and sent from
 * another finds nothing.
 */
export const ideaOnPost = internalQuery({
  args: { channelId: v.string(), ts: v.string(), ideaId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ideaId: Id<"wonderQuestIdeas">;
    noteId: Id<"dayWonderNotes">;
    seedId: Id<"seeds">;
    scholarId: Id<"users">;
    institutionId: Id<"institutions">;
    kind: Doc<"wonderQuestIdeas">["kind"];
    mission: string;
    title: string;
    offered: boolean;
  } | null> => {
    const ideaId = ctx.db.normalizeId("wonderQuestIdeas", args.ideaId);
    if (!ideaId) return null;
    const idea = await ctx.db.get(ideaId);
    if (!idea) return null;
    // An idea belongs to the school it was drafted at: after the kid moves
    // schools it can no longer be redeemed, even by a teacher who reaches both
    // (the stamped-school rule a proposal's answer follows).
    const scholar = await ctx.db.get(idea.scholarId);
    if (!scholar || (await aboutThreadInstitutionId(ctx, scholar)) !== idea.institutionId) {
      return null;
    }
    const roots = await aboutSlackRootsFor(ctx, idea.scholarId, {
      type: "wonder",
      seedId: idea.seedId,
    });
    if (!roots.some((r) => r.channelId === args.channelId && r.threadTs === args.ts)) {
      return null;
    }
    // And it is THIS run's own message for the wonder: another run's post of
    // the same wonder (two classes sharing a channel) doesn't redeem it.
    const note = await ctx.db.get(idea.noteId);
    const posted = note?.postedTs?.find((p) => p.seedId === idea.seedId);
    if (!note || note.channelId !== args.channelId || posted?.ts !== args.ts) return null;
    return {
      ideaId,
      noteId: idea.noteId,
      seedId: idea.seedId,
      scholarId: idea.scholarId,
      institutionId: idea.institutionId,
      kind: idea.kind,
      mission: idea.mission,
      title: idea.title,
      offered: idea.state === "offered",
    };
  },
});

/**
 * Remember the offer on its idea (the first offer wins; a repeat changes
 * nothing) and have the wonder's post brought up to date. The post is only
 * ever written by `dayWonders.syncWonderPost`, from stored state, so taps on
 * different ideas of one post can't undo each other. A repeat tap still asks
 * for a sync, which also puts right a post that still shows a used button.
 */
export const markOffered = internalMutation({
  args: { ideaId: v.id("wonderQuestIdeas"), unitId: v.id("units") },
  handler: async (ctx, { ideaId, unitId }): Promise<void> => {
    const idea = await ctx.db.get(ideaId);
    if (!idea) return;
    if (idea.state !== "offered") {
      await ctx.db.patch(ideaId, { state: "offered", unitId });
    }
    await ctx.scheduler.runAfter(0, internal.dayWonders.syncWonderPost, {
      noteId: idea.noteId,
      seedId: idea.seedId,
      stamp: ideaStamp(await ideasOnWonder(ctx, idea.noteId, idea.seedId)),
    });
  },
});
