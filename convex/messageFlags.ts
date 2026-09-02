import { v } from "convex/values";
import { authedMutation, teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { raiseAlert } from "./alerts";
import { siteUrl, sessionPath, withBase } from "./lib/channels";

/**
 * Scholar "Rabbithole got this wrong" flags.
 *
 * Part of the anti-parasocial / pro-human initiative: a lightweight control
 * lets a scholar flag a tutor (assistant) message as wrong, right where they
 * read it. Catching the AI being wrong is framed as a WIN — it fights
 * automation bias and the oracle-trust that powers parasocial dependence
 * (Rabbithole is a tool meant to be outgrown). The flag is recorded and
 * surfaces to the teacher; it is NOT a planted/intentional error — it's a
 * genuine kid-driven correction signal on real output.
 *
 * Distinct from `testDriveFlags` (a teacher curriculum-design tool). These
 * are real scholar corrections on live sessions and are off-limits on
 * test-drive sessions.
 *
 * Each new flag also (a) posts a calm, non-urgent ℹ️ note to the school-wide
 * #rabbithole-alerts channel (via `alerts.raiseAlert`, fire-and-forget) so
 * staff see scholar feedback as it happens, and (b) feeds the curriculum-bot
 * debrief — `getGroundInput` surfaces these flags on the real transcripts the
 * grounding judge reads, so the Debrief reflects what scholars caught.
 */

/**
 * Toggle a scholar's "got this wrong" flag on a tutor message.
 *
 * Behavior:
 *   first click  → records a flag (optionally with a reason)
 *   click again  → removes it (reversible)
 *
 * Only the session's own scholar may flag, only assistant (tutor) messages
 * can be flagged, and test-drive sessions are off-limits (that's the
 * teacher's `testDriveFlags` surface). Returns the resulting state.
 */
export const toggle = authedMutation({
  args: {
    messageId: v.id("messages"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");

    const session = await ctx.db.get(message.sessionId);
    if (!session) throw new Error("Session not found");

    // Only the scholar who owns the session may flag their own tutor's output.
    if (session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }

    // The scholar "got it wrong" control is a live-work feedback signal, not a
    // curriculum-design tool — test-drive sessions use teacher testDriveFlags.
    if (session.isTestDrive) {
      throw new Error(
        "The 'got this wrong' flag is only available on live scholar sessions"
      );
    }

    // Only the AI's own responses can be flagged as wrong.
    if (message.role !== "assistant") {
      throw new Error("Only tutor (assistant) messages can be flagged");
    }

    const existing = await ctx.db
      .query("messageFlags")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { flagged: false };
    }

    await ctx.db.insert("messageFlags", {
      sessionId: message.sessionId,
      messageId: args.messageId,
      scholarId: ctx.user._id,
      reason: args.reason?.trim() || undefined,
    });

    // Non-urgent ping to the school-wide #rabbithole-alerts channel so staff
    // see scholar feedback in (near) real time — framed as a calm ℹ️ note, not
    // an emergency. Fire-and-forget: raiseAlert never throws into this mutation,
    // and dedups on the messageId so a flag/unflag/flag flurry posts once. Only
    // on the initial flag (the toggle-off branch above already returned).
    const snippet = message.content.replace(/\s+/g, " ").trim().slice(0, 160);
    const reason = args.reason?.trim();
    const scholarName = ctx.user.name ?? "A scholar";
    await raiseAlert(ctx, {
      kind: "scholar_feedback",
      severity: "info",
      audience: "institution",
      title: `${scholarName} gave a thumbs-down to a Rabbithole response`,
      body: [
        `On *${session.title ?? "a session"}*:`,
        `> ${snippet}`,
        reason ? `Their reason: ${reason}` : "(no reason given — one tap)",
      ].join("\n"),
      source: "messageFlags.toggle",
      scholarId: ctx.user._id,
      sessionId: message.sessionId,
      deepLink: withBase(
        siteUrl(),
        sessionPath(message.sessionId, ctx.user._id),
      ),
      dedupKey: `scholar_feedback:${args.messageId}`,
    });

    return { flagged: true };
  },
});

/**
 * Teacher surface: a scholar's "caught the AI" record.
 *
 * Returns the total count plus the most recent catches with enough context
 * (a snippet of the flagged response + the session title) to render on the
 * scholar's profile. Celebrates skepticism — these are wins, not concerns.
 */
export const listForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const flags = await ctx.db
      .query("messageFlags")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();

    const recent = await Promise.all(
      flags.slice(0, 5).map(async (f) => {
        const message = await ctx.db.get(f.messageId);
        const session = await ctx.db.get(f.sessionId);
        const snippet = (message?.content ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 140);
        return {
          _id: f._id,
          messageId: f.messageId,
          sessionId: f.sessionId,
          sessionTitle: session?.title ?? "Session",
          snippet,
          reason: f.reason ?? null,
          flaggedAt: f._creationTime,
        };
      })
    );

    return { count: flags.length, recent };
  },
});
