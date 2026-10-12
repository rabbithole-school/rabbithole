// The parent aide — a parent's single-thread chat with an AI that can
// answer questions about THEIR OWN children's non-sensitive learning data
// (mastery / signals / seeds), tier-1 only.
//
// HYBRID design (see review/parent-role-plan.md): the AIDE TOOLS are the
// SAME shared set as the teacher aide (lib/scholarReadTools), scoped to the
// parent's children via `allowedScholarIds`; only the SESSION STORAGE is
// isolated here (parentChatMessages) rather than overloading the teacher-
// keyed chats/curriculumMessages tables. The streaming + tool wiring
// lives in http.ts `/parent-chat-stream`.

import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { internalQuery, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { hasGuardianships } from "./lib/auth";
import { ROLES } from "./lib/roles";
import { renderStoppedAssistantContent } from "../shared/stoppedTurn";

async function stampLatestStreamingParentMessage(
  ctx: Pick<MutationCtx, "db">,
  parentUserId: Id<"users">,
): Promise<boolean> {
  const recent = await ctx.db
    .query("parentChatMessages")
    .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
    .order("desc")
    .take(20);
  const streaming = recent.find(
    (message) => message.role === "assistant" && message.streamId,
  );
  if (!streaming) return false;
  if (streaming.stopRequestedAt === undefined) {
    await ctx.db.patch(streaming._id, { stopRequestedAt: Date.now() });
  }
  return true;
}

// ── Parent-facing (role === parent) ─────────────────────────────────────

/** The signed-in parent's own chat history (oldest first). */
export const listMessages = authedQuery({
  args: {},
  handler: async (ctx) => {
    if (ctx.user.role !== ROLES.PARENT && !(await hasGuardianships(ctx, ctx.user._id))) return [];
    const rows = await ctx.db
      .query("parentChatMessages")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
      .collect();
    return rows.map((m) => ({
      _id: m._id,
      role: m.role,
      content: m.content,
      streamId: m.streamId ?? null,
      stopRequestedAt: m.stopRequestedAt ?? null,
      createdAt: m._creationTime,
    }));
  },
});

/**
 * Post a parent's message + create the empty assistant row the stream will
 * fill. Returns the ids the client hands to `/parent-chat-stream`.
 */
export const sendMessage = authedMutation({
  args: { content: v.string() },
  handler: async (ctx, args) => {
    if (ctx.user.role !== ROLES.PARENT && !(await hasGuardianships(ctx, ctx.user._id))) {
      throw new Error("Forbidden: not a guardian");
    }
    const content = args.content.trim();
    if (!content) throw new Error("Message is empty");
    await stampLatestStreamingParentMessage(ctx, ctx.user._id);

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const streamId = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await ctx.db.insert("parentChatMessages", {
      parentUserId: ctx.user._id,
      role: "user",
      content,
    });
    const assistantMsgId = await ctx.db.insert("parentChatMessages", {
      parentUserId: ctx.user._id,
      role: "assistant",
      content: "",
      streamId,
    });
    return { assistantMsgId, streamId };
  },
});

export const requestStop = authedMutation({
  args: { messageId: v.id("parentChatMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || !message.streamId) return { stopped: false };
    if (message.parentUserId !== ctx.user._id) {
      throw new Error("Forbidden: not your parent chat");
    }
    if (message.stopRequestedAt === undefined) {
      await ctx.db.patch(args.messageId, { stopRequestedAt: Date.now() });
    }
    return { stopped: true };
  },
});

/** Clear the parent's whole thread. */
export const clearMessages = authedMutation({
  args: {},
  handler: async (ctx) => {
    if (ctx.user.role !== ROLES.PARENT && !(await hasGuardianships(ctx, ctx.user._id))) {
      throw new Error("Forbidden: not a guardian");
    }
    const rows = await ctx.db
      .query("parentChatMessages")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
      .collect();
    await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
  },
});

// ── Internal (called by the /parent-chat-stream HTTP action) ────────────

/**
 * Conversation history + the parent's children (id + name) for the aide.
 * The children list is what `/parent-chat-stream` turns into the tool
 * scoping set (`allowedScholarIds`) and the system-prompt name list.
 */
export const getContext = internalQuery({
  args: { parentUserId: v.id("users") },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentUserId);
    if (
      !parent ||
      (parent.role !== ROLES.PARENT && !(await hasGuardianships(ctx, args.parentUserId)))
    )
      return null;

    const messages = await ctx.db
      .query("parentChatMessages")
      .withIndex("by_parent", (q) => q.eq("parentUserId", args.parentUserId))
      .collect();

    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", args.parentUserId))
      .collect();
    const children = (
      await Promise.all(
        links.map(async (link) => {
          const scholar = await ctx.db.get(link.scholarUserId);
          return scholar && scholar.role === ROLES.SCHOLAR
            ? { id: scholar._id, name: scholar.name ?? "Scholar" }
            : null;
        }),
      )
    ).filter((c): c is NonNullable<typeof c> => c !== null);

    return {
      parentName: parent.name ?? "there",
      messages: messages.map((m) => ({
        role: m.role,
        content:
          m.role === "assistant"
            ? renderStoppedAssistantContent(m.content, m.stopRequestedAt)
            : m.content,
      })),
      children,
    };
  },
});

/**
 * The owning parent of a message row (or null). The stream handler calls
 * this to verify a body-supplied `assistantMsgId` actually belongs to the
 * authenticated caller BEFORE streaming into it — otherwise one parent
 * could overwrite/delete another parent's chat row by passing its id.
 */
export const getMessageOwner = internalQuery({
  args: { messageId: v.id("parentChatMessages") },
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.messageId);
    return m?.parentUserId ?? null;
  },
});

export const updateStreamContent = internalMutation({
  args: { messageId: v.id("parentChatMessages"), content: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return { stopRequested: false };
    await ctx.db.patch(args.messageId, { content: args.content });
    return { stopRequested: message.stopRequestedAt !== undefined };
  },
});

export const isStopRequested = internalQuery({
  args: { messageId: v.id("parentChatMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    return message?.stopRequestedAt !== undefined;
  },
});

export const finalizeStream = internalMutation({
  args: { messageId: v.id("parentChatMessages"), content: v.string() },
  handler: async (ctx, args) => {
    if (!args.content.trim()) {
      // Nothing streamed (error/empty) — drop the placeholder row.
      await ctx.db.delete(args.messageId);
    } else {
      await ctx.db.patch(args.messageId, {
        content: args.content,
        streamId: undefined,
      });
    }
  },
});
