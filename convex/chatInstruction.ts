import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authedMutation } from "./lib/customFunctions";
import {
  instructionContentForKeyInContext,
  recordInstructionTerminalInContext,
  type InstructionPlatform,
} from "./instruction";
import {
  CHAT_INSTRUCTION_ALREADY_COMPLETED_GUIDANCE,
  CHAT_INSTRUCTION_NO_CONTENT_GUIDANCE,
  instructionCompletionAction,
  instructionCompletionHandback,
  resolveInstructionAnchor,
} from "./lib/practice/chatInstruction";
import {
  instructionOfferId,
  strandInstructionKey,
} from "./lib/practice/instructionEntries";
import { AUTHORED_LAUNCHPADS } from "./seed/instructionSeed";
import { reapAndInsertAssistantPlaceholder } from "./sessions";
import { requireActiveLearnerInstitution } from "./lib/scholarEnrollment";

const platformValidator = v.union(v.literal("web"), v.literal("native"));

async function resolveChatInstructionInContext(
  ctx: QueryCtx,
  args: {
    scholarId: Id<"users">;
    skill: string;
    platform: InstructionPlatform;
  },
) {
  const anchor = resolveInstructionAnchor(args.skill, AUTHORED_LAUNCHPADS);
  if (!anchor) return null;
  const key = strandInstructionKey(anchor.domain, anchor.strand);
  const content = await instructionContentForKeyInContext(
    ctx,
    key,
    args.platform,
  );
  return content ? { ...content, key } : null;
}

export const resolveChatInstruction = internalQuery({
  args: {
    scholarId: v.id("users"),
    skill: v.string(),
    platform: platformValidator,
  },
  handler: async (ctx, args) =>
    await resolveChatInstructionInContext(ctx, args),
});

async function persistInstructionMessage(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    scholarId: Id<"users">;
    currentMessageId: Id<"messages">;
    contentSoFar: string;
  },
  instruction: NonNullable<
    Awaited<ReturnType<typeof resolveChatInstructionInContext>>
  >,
) {
  const currentMessage = await ctx.db.get(args.currentMessageId);
  const dims = {
    personaId: currentMessage?.personaId,
    unitId: currentMessage?.unitId,
    perspectiveId: currentMessage?.perspectiveId,
    processId: currentMessage?.processId,
    promptVersion: currentMessage?.promptVersion,
  };

  if (!args.contentSoFar.trim()) {
    await ctx.db.delete(args.currentMessageId);
  } else {
    await ctx.db.patch(args.currentMessageId, {
      content: args.contentSoFar,
      streamId: undefined,
    });
  }

  await ctx.db.insert("messages", {
    sessionId: args.sessionId,
    role: "tool",
    content: "",
    toolAction: `Instruction: ${instruction.title}`,
    ...dims,
    flagged: false,
    instruction,
  });

  const event = await ctx.db
    .query("instructionEvents")
    .withIndex("by_scholar_key", (q) =>
      q.eq("scholarId", args.scholarId).eq("key", instruction.key),
    )
    .unique();
  if (!event) {
    await ctx.db.insert("instructionEvents", {
      scholarId: args.scholarId,
      key: instruction.key,
      offerId: instructionOfferId(args.scholarId, instruction.key),
      offerCount: 0,
      retrievals: [],
    });
  }

  return await ctx.db.insert("messages", {
    sessionId: args.sessionId,
    role: "assistant",
    content: "",
    ...dims,
    flagged: false,
    lastStreamActivityAt: Date.now(),
  });
}

export const serveChatInstruction = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    currentMessageId: v.id("messages"),
    contentSoFar: v.string(),
    skill: v.string(),
    platform: platformValidator,
  },
  handler: async (ctx, args) => {
    const instruction = await resolveChatInstructionInContext(ctx, args);
    if (!instruction) {
      return {
        ok: false as const,
        reason: CHAT_INSTRUCTION_NO_CONTENT_GUIDANCE,
      };
    }
    const event = await ctx.db
      .query("instructionEvents")
      .withIndex("by_scholar_key", (q) =>
        q.eq("scholarId", args.scholarId).eq("key", instruction.key),
      )
      .unique();
    if (event?.completedAt != null) {
      return {
        ok: false as const,
        reason: CHAT_INSTRUCTION_ALREADY_COMPLETED_GUIDANCE,
      };
    }

    const newMessageId = await persistInstructionMessage(
      ctx,
      args,
      instruction,
    );
    return {
      ok: true as const,
      newMessageId,
      title: instruction.title,
    };
  },
});

export const completeChatInstruction = authedMutation({
  args: {
    scholarId: v.id("users"),
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    if (String(ctx.user._id) !== String(args.scholarId)) {
      throw new Error("Only the scholar may complete an instruction segment");
    }
    await requireActiveLearnerInstitution(ctx, ctx.user._id);
    const [session, message] = await Promise.all([
      ctx.db.get(args.sessionId),
      ctx.db.get(args.messageId),
    ]);
    if (
      !session ||
      session.userId !== args.scholarId ||
      !message ||
      message.sessionId !== args.sessionId ||
      message.role !== "tool" ||
      message.instruction?.key !== args.key
    ) {
      throw new Error("Instruction message does not belong to this session");
    }

    const viewedEventId = await recordInstructionTerminalInContext(
      ctx,
      args.scholarId,
      args.key,
      "viewedAt",
    );
    const completedEventId = await recordInstructionTerminalInContext(
      ctx,
      args.scholarId,
      args.key,
      "completedAt",
    );
    if (!viewedEventId || !completedEventId) {
      throw new Error("Instruction lifecycle row is missing");
    }

    const toolAction = instructionCompletionAction(args.messageId);
    const sessionMessages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const existingHandback = sessionMessages.find(
      (candidate) =>
        candidate.role === "system" &&
        candidate.toolAction === toolAction,
    );
    if (existingHandback) {
      const existingReply = sessionMessages.find(
        (candidate) =>
          candidate._creationTime > existingHandback._creationTime &&
          candidate.role === "assistant",
      );
      return {
        completed: true as const,
        handback:
          existingReply?.streamId && existingReply.content.trim() === ""
            ? {
                sessionId: args.sessionId,
                streamId: existingReply.streamId,
                assistantMsgId: existingReply._id,
              }
            : null,
      };
    }

    await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      role: "system",
      content: instructionCompletionHandback(message.instruction.title),
      toolAction,
      flagged: false,
    });
    if (session.sessionTimeLimit && session.sessionStartTime) {
      const elapsed = Date.now() - session.sessionStartTime;
      if (elapsed >= session.sessionTimeLimit * 60 * 1000) {
        return { completed: true as const, handback: null };
      }
    }
    const handback = await reapAndInsertAssistantPlaceholder(ctx, session);
    return {
      completed: true as const,
      handback: {
        sessionId: args.sessionId,
        ...handback,
      },
    };
  },
});
