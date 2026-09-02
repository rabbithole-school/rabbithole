"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";

/**
 * Generate a short (4-6 word) human-readable project title from the first
 * user/assistant exchange. Scheduled in the background after the first turn
 * completes so scholars' home cards aren't littered with truncated full
 * sentences.
 */
export const generateTitle = internalAction({
  args: {
    sessionId: v.id("sessions"),
    // The stopgap title set when this action was scheduled. Passed through to
    // setGeneratedTitle so we only overwrite if the project title hasn't been
    // hand-edited in the meantime.
    stopgapTitle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const snapshot = await ctx.runQuery(
      internal.sessionHelpers.getFirstExchange,
      { sessionId: args.sessionId },
    );
    if (!snapshot) return;
    const { firstUserMessage, firstAssistantMessage } = snapshot;
    if (!firstUserMessage) return;
    const institutionId = await ctx.runQuery(
      internal.usage.resolveSessionInstitution,
      { sessionId: args.sessionId },
    );

    const userExcerpt = firstUserMessage.slice(0, 600);
    const assistantExcerpt = (firstAssistantMessage ?? "").slice(0, 400);

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      const response = await anthropic.messages.create({
        model: MODELS.HAIKU,
        max_tokens: 40,
        system:
          "You title a student's tutoring session based on their first question and the tutor's first reply. " +
          "Return ONLY a short title, 4-6 words, title case, no punctuation, no quotes. Capture the topic/focus, not the format. STRICT: never exceed 6 words. " +
          "Examples: 'Multiplication Tables Warm-Up', 'Questions About The Water Cycle', 'Writing A Haiku About Volcanoes'.",
        messages: [
          {
            role: "user",
            content: `SCHOLAR: ${userExcerpt}\n\nTUTOR: ${assistantExcerpt}\n\nTitle:`,
          },
        ],
      });
      await recordAnthropicUsage(ctx, {
        source: "session-title",
        role: ROLES.SCHOLAR,
        model: MODELS.HAIKU,
        usage: response.usage,
        institutionId,
        sessionId: args.sessionId,
      });
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") return;
      const raw = textBlock.text.trim();
      // Defensive cleanup: strip quotes, trailing punctuation, newlines
      const cleaned = raw
        .replace(/[\r\n]+/g, " ")
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/[.!?,:;]+$/g, "")
        .trim();
      // Hard cap at 6 words
      const words = cleaned.split(/\s+/);
      const capped = words.length > 6 ? words.slice(0, 6).join(" ") : cleaned;
      if (!capped || capped.length > 60) return;
      await ctx.runMutation(internal.sessionHelpers.setGeneratedTitle, {
        sessionId: args.sessionId,
        title: capped,
        stopgapTitle: args.stopgapTitle,
      });
    } catch (err) {
      console.error("[sessionTitles] title generation failed:", err);
    }
  },
});
