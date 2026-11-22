// The parent aide — a parent's single-thread chat with an AI that can
// answer questions about THEIR OWN children's non-sensitive learning data
// (mastery / signals / seeds), tier-1 only.
//
// HYBRID design (see review/parent-role-plan.md): the AIDE TOOLS are the
// SAME shared set as the teacher aide (lib/scholarReadTools), scoped to the
// parent's children via `allowedScholarIds`; only the SESSION STORAGE is
// isolated here (parentChatMessages) rather than overloading the teacher-
// keyed chats/curriculumMessages tables. Turn setup (scope, tools, prompt)
// lives in lib/parentAideTurn.ts; the web SSE route is http.ts
// `/parent-chat-stream`.

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
 * A parent's thread never ends, so the aide replays only the current
 * conversation: everything after the last stretch this long with no messages.
 * Replaying the whole thread let months-old answers stand in for fresh tool
 * reads (TRA-623: asked about math with an Aug–Nov thread, the aide called no
 * tool in 6 of 6 replays and repeated its August answer; with no history it
 * read the practice tool and answered correctly).
 *
 * Calibration (prod, Nov 9, 7 parents): of 66 gaps between consecutive
 * parent-aide messages, 53 are under an hour, 13 are over 6 hours, and none
 * fall between 1 and 6 hours. Any cutoff in that range splits conversations
 * the same way; 3 hours sits in the middle of it.
 */
const CONVERSATION_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * Conversation history + the parent's children (id + name) for the aide.
 * The children list is what `/parent-chat-stream` turns into the tool
 * scoping set (`allowedScholarIds`) and the system-prompt name list.
 *
 * The history is the current conversation only (CONVERSATION_GAP_MS); the
 * portal panel (`listMessages`) still shows the whole thread.
 */
export const getContext = internalQuery({
  args: {
    parentUserId: v.id("users"),
    // Bind the history to one turn: drop every row written after this one.
    // A background turn passes its own user message, so a message that lands
    // while it runs (a second text, a web send) can't become the question
    // this turn answers (TRA-558). Must be this parent's own row.
    throughMessageId: v.optional(v.id("parentChatMessages")),
  },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentUserId);
    if (
      !parent ||
      (parent.role !== ROLES.PARENT && !(await hasGuardianships(ctx, args.parentUserId)))
    )
      return null;

    let messages = await ctx.db
      .query("parentChatMessages")
      .withIndex("by_parent", (q) => q.eq("parentUserId", args.parentUserId))
      .collect();
    if (args.throughMessageId) {
      const end = messages.findIndex((m) => m._id === args.throughMessageId);
      if (end === -1) return null; // not this parent's row
      messages = messages.slice(0, end + 1);
    }
    // Walk back from the newest kept row (the turn's own, so always kept) to
    // the first quiet gap. The window can open on an aide row (a text we
    // sent, such as a charge reminder). The API history must open with the
    // parent, so prepareParentAideTurn moves those rows into the turn's
    // system text, with their times (TRA-624).
    let start = messages.length - 1;
    while (
      start > 0 &&
      messages[start]._creationTime - messages[start - 1]._creationTime <=
        CONVERSATION_GAP_MS
    ) {
      start--;
    }
    messages = messages.slice(Math.max(start, 0));

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
        at: m._creationTime,
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
 * The background parent-aide turn's writes (lib/parentAideTurn.runParentAideTurn).
 * No auth identity reaches these: the caller has already resolved which
 * parent sent the message, so the guardian and read-only checks that
 * `authedMutation` + `sendMessage` apply on the web path are repeated here.
 */
export const appendUserMessageInternal = internalMutation({
  args: { parentUserId: v.id("users"), content: v.string() },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentUserId);
    if (
      !parent ||
      (parent.role !== ROLES.PARENT && !(await hasGuardianships(ctx, args.parentUserId)))
    ) {
      throw new Error("Forbidden: not a guardian");
    }
    if (parent.readOnly) throw new Error("Forbidden: read-only account");
    const content = args.content.trim();
    if (!content) throw new Error("Message is empty");
    return await ctx.db.insert("parentChatMessages", {
      parentUserId: args.parentUserId,
      role: "user",
      content,
    });
  },
});

/** The complete reply of a background turn, written once (never streamed). */
export const appendAssistantMessageInternal = internalMutation({
  args: { parentUserId: v.id("users"), content: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("parentChatMessages", {
      parentUserId: args.parentUserId,
      role: "assistant",
      content: args.content,
    });
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
