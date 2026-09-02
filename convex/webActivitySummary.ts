"use node";

// Cheap Haiku pass that writes the one-line `summary` on a Web Assignment
// session from its captured metadata, for the teacher card. Best-effort and
// additive: scheduled from webActivitySessions.finalize, never blocks the
// session, and the card falls back to structured course/badge/task lines
// when absent. Same shape as chatTitles.autoNameChat.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import {
  WEB_SUMMARY_SYSTEM,
  webSessionFacts,
  cleanSummary,
} from "./lib/webSessionSummary";

export const summarize = internalAction({
  args: { sessionId: v.id("webActivitySessions") },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(
      internal.webActivitySessions.getForSummary,
      { sessionId: args.sessionId },
    );
    if (!session) return;
    // Already written (e.g. a double finalize: webview close then the
    // done-prompt scheduled a second run before the first landed) — don't
    // redo the model call.
    if (session.summary) return;
    const facts = webSessionFacts(session.extracted);
    if (!facts) return; // nothing meaningful captured — skip the call
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: session.scholarId, principal: "scholar" },
    );

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      const response = await anthropic.messages.create({
        model: MODELS.HAIKU,
        max_tokens: 90,
        system: WEB_SUMMARY_SYSTEM,
        messages: [
          {
            role: "user",
            content: `${facts}\n\nOne-sentence summary for the teacher:`,
          },
        ],
      });
      await recordAnthropicUsage(ctx, {
        source: "web-activity-summary",
        role: ROLES.SCHOLAR,
        model: MODELS.HAIKU,
        usage: response.usage,
        institutionId,
      });
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") return;
      const summary = cleanSummary(textBlock.text);
      if (!summary) return;
      await ctx.runMutation(internal.webActivitySessions.setSummary, {
        sessionId: args.sessionId,
        summary,
      });
    } catch (err) {
      console.error("[webActivitySummary] summary generation failed:", err);
    }
  },
});
