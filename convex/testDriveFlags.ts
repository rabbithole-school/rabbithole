import { v } from "convex/values";
import {
  authedQuery,
  authedMutation,
} from "./lib/customFunctions";
import { isTeacherRole } from "./lib/roles";

/**
 * Test-drive flag toggle. Teacher clicks 👍 / 👎 on a tutor message in
 * their test drive; this writes (or replaces) a flag record.
 *
 * Behavior:
 *   click 👍                       → creates a `good` flag (no note)
 *   click 👍 again on same msg     → removes the flag (toggle off)
 *   click 👎 after a 👍            → replaces with a `bad` flag
 *
 * Notes are NOT set via this mutation — they're added separately via
 * `setNote` after the teacher types a "why" message in the bot drawer.
 * This mutation is purely for the thumb-up/thumb-down click and the
 * toggle-off semantics. Keeping the surface narrow lets the toggle-off
 * branch be unconditional ("same kind → delete") without worrying about
 * accidentally clearing a note that was set elsewhere.
 *
 * Only the test-drive project's owner may flag, and only test-drive
 * projects accept flags (regular scholar sessions are off-limits — this is
 * a curriculum-design tool, not a feedback feature for live work). Only
 * tutor (assistant) messages can be flagged; the teacher's own scholar-
 * voice messages aren't useful prompt-refinement signals.
 *
 * Returns the new state for the message: "good" | "bad" | null
 * (null = removed by toggle).
 */
export const toggle = authedMutation({
  args: {
    messageId: v.id("messages"),
    kind: v.union(v.literal("good"), v.literal("bad")),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");

    const session = await ctx.db.get(message.sessionId);
    if (!session) throw new Error("Session not found");
    if (!session.isTestDrive) {
      throw new Error("Flags are only available on test-drive projects");
    }

    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher || session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }

    // Only flag tutor messages — flagging the teacher's own input doesn't
    // teach the bot anything about prompt behavior.
    if (message.role !== "assistant") {
      throw new Error("Only tutor (assistant) messages can be flagged");
    }

    const existing = await ctx.db
      .query("testDriveFlags")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .first();

    if (existing) {
      if (existing.kind === args.kind) {
        // Same kind → toggle off. Note (if any) goes with the flag.
        await ctx.db.delete(existing._id);
        return { kind: null as "good" | "bad" | null };
      }
      // Different kind → replace. Drop any prior note since the rationale
      // for a 👍 doesn't carry over to a 👎 of the same message.
      await ctx.db.patch(existing._id, {
        kind: args.kind,
        note: undefined,
      });
      return { kind: args.kind as "good" | "bad" | null };
    }

    await ctx.db.insert("testDriveFlags", {
      sessionId: message.sessionId,
      messageId: args.messageId,
      teacherId: ctx.user._id,
      kind: args.kind,
    });
    return { kind: args.kind as "good" | "bad" | null };
  },
});

/**
 * Attach a note to an existing flag. Used after the teacher hits 👍/👎
 * and then types "why" in the bot drawer's input — the typed text becomes
 * the flag's `note` so the bot sees the rationale alongside the flag.
 *
 * No-op if no flag exists for the message (the teacher must have flagged
 * first; this isn't a way to flag from a fresh state). Owner-only,
 * test-drive-only — same gates as `toggle`.
 */
export const setNote = authedMutation({
  args: {
    messageId: v.id("messages"),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    const session = await ctx.db.get(message.sessionId);
    if (!session) throw new Error("Session not found");
    if (!session.isTestDrive) {
      throw new Error("Flags are only available on test-drive projects");
    }
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher || session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    const existing = await ctx.db
      .query("testDriveFlags")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .first();
    if (!existing) return null; // No flag to annotate.
    await ctx.db.patch(existing._id, { note: args.note });
    return { kind: existing.kind, note: args.note };
  },
});

/**
 * List flags pinned to a test-drive project. Used by the FE to render
 * 👍 / 👎 state on each tutor message inline. Owner-only.
 */
export const listForSession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    if (!session.isTestDrive) return [];

    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher || session.userId !== ctx.user._id) return [];

    const flags = await ctx.db
      .query("testDriveFlags")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    return flags.map((f) => ({
      messageId: f.messageId,
      kind: f.kind,
      note: f.note ?? null,
    }));
  },
});
