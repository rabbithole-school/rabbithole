/**
 * Spotted flair — the observer's flair for an idea nobody listed in advance.
 *
 * The observer proposes; this file decides. `award` is the only writer and
 * re-checks every gate the observer was told about (test drive, per-session
 * cap, per-scholar weekly cap, one award per scholar turn). A teacher can
 * remove an award (`remove`). Pure rules: convex/lib/spottedFlair.ts.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedQuery, teacherMutation } from "./lib/customFunctions";
import {
  canUserReadScholarWork,
  requireScholarWorkAccess,
} from "./lib/access";
import { getActiveOverlay, getSessionOwner } from "./lib/auth";
import {
  SPOTTED_FLAIR_PER_SCHOLAR_WEEK,
  SPOTTED_FLAIR_PER_SESSION,
  SPOTTED_FLAIR_WEEK_MS,
  spottedFlairId,
} from "./lib/spottedFlair";

type AwardBlock = "test_drive" | "session_cap" | "weekly_cap";

/** Spotted flair this scholar earned in the trailing week, across sessions. */
async function weeklySpottedCount(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  now: number,
): Promise<number> {
  const since = now - SPOTTED_FLAIR_WEEK_MS;
  // A session that earned flair this week had a message this week.
  const recent = await ctx.db
    .query("sessions")
    .withIndex("by_user_last_message", (q) =>
      q.eq("userId", scholarId).gte("lastMessageAt", since),
    )
    .collect();
  let count = 0;
  for (const session of recent) {
    for (const flair of session.spottedFlair ?? []) {
      if (flair.earnedAt >= since) count++;
    }
  }
  return count;
}

async function awardBlock(
  ctx: QueryCtx,
  session: Doc<"sessions">,
  now: number,
): Promise<AwardBlock | null> {
  if (session.isTestDrive) return "test_drive";
  if ((session.spottedFlair?.length ?? 0) >= SPOTTED_FLAIR_PER_SESSION) {
    return "session_cap";
  }
  if (
    (await weeklySpottedCount(ctx, session.userId, now)) >=
    SPOTTED_FLAIR_PER_SCHOLAR_WEEK
  ) {
    return "weekly_cap";
  }
  return null;
}

/** Whether the observer should be told spotted flair is open this run. */
export const canAward = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return false;
    // t11-ok: read once per observer run by an action, never subscribed.
    return (await awardBlock(ctx, session, Date.now())) === null;
  },
});

export const award = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    sourceMessageId: v.string(),
    excerpt: v.string(),
    label: v.string(),
    note: v.string(),
  },
  handler: async (ctx, args): Promise<string> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return "skipped: no session";
    const id = spottedFlairId(args.sourceMessageId);
    if ((session.spottedFlair ?? []).some((flair) => flair.id === id)) {
      return "skipped: already awarded for this turn";
    }
    const now = Date.now();
    const block = await awardBlock(ctx, session, now);
    if (block) return `skipped: ${block}`;
    await ctx.db.patch(session._id, {
      spottedFlair: [
        ...(session.spottedFlair ?? []),
        {
          id,
          label: args.label,
          note: args.note,
          excerpt: args.excerpt,
          sourceMessageId: args.sourceMessageId,
          earnedAt: now,
        },
      ],
    });
    return "awarded";
  },
});

/**
 * A session's spotted flair, for the scholar who owns it or a teacher with
 * access. The scholar never receives the evidence excerpt — only the mark,
 * its name and its note.
 */
export const forSession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    const isOwner = session.userId === ctx.user._id;
    // The excerpt is the scholar's own words, so it is learning record: only
    // staff with TEACHING access at the scholar's school may read it. Plain
    // scholar access is not enough, since it admits operations staff.
    const isStaffReader =
      !isOwner && (await canUserReadScholarWork(ctx, ctx.user, session.userId));
    if (!isOwner && !isStaffReader) return [];
    // `remove` refuses read-only identities and impersonation (assertCanWrite);
    // say so up front so the popover never offers a control that will fail.
    const canRemove =
      isStaffReader &&
      (await getSessionOwner(ctx))?.readOnly !== true &&
      (await getActiveOverlay(ctx)) === null;
    return (session.spottedFlair ?? [])
      .filter((flair) => flair.removedAt === undefined)
      .map((flair) => ({
        id: flair.id,
        label: flair.label,
        note: flair.note,
        earnedAt: flair.earnedAt,
        ...(isStaffReader ? { excerpt: flair.excerpt, canRemove } : {}),
      }));
  },
});

/**
 * A teacher takes a spotted flair back: the mark disappears for the scholar.
 * The entry is stamped, not deleted, so the observer cannot award the same
 * moment again on its next read of the transcript.
 */
export const remove = teacherMutation({
  args: { sessionId: v.id("sessions"), flairId: v.string() },
  handler: async (ctx, { sessionId, flairId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");
    await requireScholarWorkAccess(ctx, ctx.user, session.userId);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      spottedFlair: (session.spottedFlair ?? []).map((flair) =>
        flair.id === flairId && flair.removedAt === undefined
          ? { ...flair, removedAt: now, removedBy: ctx.user._id }
          : flair,
      ),
    });
  },
});
