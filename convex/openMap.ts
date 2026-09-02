"use node";

/**
 * openMap — the generative "star map" pivot. Given a grounded concept (an
 * understanding from the Knowledge Tree), generate the open-map neighborhood:
 * surprising, TRUE, transdisciplinary leaps — the curiosity lens, not the
 * prerequisite one. This is the node-level "View in star map" pivot from
 * review/knowledge-tree-expansion.html §6: two separate graphs, one shared
 * anchor concept.
 *
 * Generated on demand (the plan's "generate on demand, persist only decisions"
 * stance) — nothing is written. The tutor's restraint does NOT apply here: this
 * is a teacher/learner-facing browseable surface, encouraged to be boldly
 * associative, with a factuality bar in the prompt (the leap must be real).
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";

const SYSTEM_PROMPT = `You are the "open map" — the generative, curiosity-first lens of a gifted school's learning app. Given one concept a learner understands, surface the most delightful TRUE connections to it across all of human knowledge: other fields, real-world instances, history-of-ideas leaps.

Rules:
- 5-7 leaps. Each is a short topic (≤6 words) + a one-line "because" bridge (≤16 words) explaining the real connection.
- TRUTH BAR: every connection must be factually real. A made-up or strained link is worse than none.
- Favor SURPRISE and reach across domains — math↔music, biology↔economics, art↔geometry. Avoid restating the concept.
- Each leap has a domain (one word: Music, Biology, History, Art, Cooking, Economics, Engineering, Sports, Nature, …) and a reach: 0 = near/same-field, 1 = adjacent, 2 = far/surprising.
- These are invitations to explore, pitched at a curious gifted elementary kid — concrete and evocative, never a lecture.`;

const TOOL = {
  name: "record_leaps" as const,
  description: "Record the open-map leaps from the concept.",
  input_schema: {
    type: "object" as const,
    required: ["leaps"],
    properties: {
      leaps: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["topic", "bridge", "domain", "reach"],
          properties: {
            topic: { type: "string" as const, description: "≤6-word topic to explore" },
            bridge: { type: "string" as const, description: "≤16-word 'because' connection — must be true" },
            domain: { type: "string" as const, description: "one-word domain" },
            reach: { type: "number" as const, description: "0 near, 1 adjacent, 2 far" },
          },
        },
      },
    },
  },
};

export type Leap = { topic: string; bridge: string; domain: string; reach: number };

export const leapsForConcept = action({
  args: { concept: v.string(), grounding: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ concept: string; leaps: Leap[] }> => {
    const userId = await getAuthUserId(ctx);
    const institutionId = userId
      ? await ctx.runQuery(internal.usage.resolveInstitution, {
          userId,
          principal: "scholar",
        })
      : null;
    const userMessage = [
      `Concept the learner understands: "${args.concept}"`,
      args.grounding ? `(from: ${args.grounding})` : "",
      "",
      "Surface the open-map leaps from this concept.",
    ]
      .filter(Boolean)
      .join("\n");

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 1536,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "record_leaps" },
      messages: [{ role: "user", content: userMessage }],
    });
    await recordAnthropicUsage(ctx, {
      source: "open-map",
      model: MODELS.HAIKU,
      usage: response.usage,
      institutionId,
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new Error("No tool_use block from Haiku");
    }
    const parsed = toolBlock.input as { leaps?: Leap[] };
    const leaps = (parsed.leaps ?? [])
      .filter((l) => l.topic && l.bridge)
      .map((l) => ({
        topic: String(l.topic),
        bridge: String(l.bridge),
        domain: String(l.domain ?? "Idea"),
        reach: Math.max(0, Math.min(2, Number(l.reach) || 0)),
      }));
    return { concept: args.concept, leaps };
  },
});
