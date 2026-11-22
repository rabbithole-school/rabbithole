"use node";

// Drafts one kid's "Could become" Quest ideas for a claimed day's wonders note
// (TRA-697). Scheduled by dayWonders.postForDay after the run is claimed, one
// action per kid, so the note never waits on a model. Claimed once per kid per
// run (dayWonders.claimIdeaDraft); one model call, and none when no wonder
// could reach the evidence rule (lib/wonderQuestIdeas.ts). A failure or a slow
// call is no ideas: the note stays as posted, with no buttons for that kid.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ROLES } from "./lib/roles";
import {
  WONDER_IDEAS_MODEL,
  draftIdeasWithModel,
} from "./lib/wonderQuestIdeasModel";
import { recordAnthropicUsage } from "./usage";

export const draft = internalAction({
  args: { noteId: v.id("dayWonderNotes"), scholarId: v.id("users") },
  handler: async (ctx, args): Promise<void> => {
    if (!process.env.ANTHROPIC_API_KEY) return;
    try {
      if (!(await ctx.runMutation(internal.dayWonders.claimIdeaDraft, args))) return;
      const inputs = await ctx.runQuery(internal.dayWonders.ideaInputs, args);
      if (!inputs || inputs.wonders.length === 0) return;
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const result = await draftIdeasWithModel(new Anthropic(), inputs);
      if (result.asked) {
        await recordAnthropicUsage(ctx, {
          source: "wonder-quest-ideas",
          role: ROLES.PLATFORM_ADMIN,
          model: WONDER_IDEAS_MODEL,
          usage: result.usage,
          institutionId: inputs.institutionId,
        });
      }
      if (result.ideas.length === 0) return;
      await ctx.runMutation(internal.dayWonders.storeIdeas, {
        noteId: args.noteId,
        scholarId: args.scholarId,
        ideas: result.ideas.map(({ seedId, ...idea }) => ({
          ...idea,
          seedId: seedId as Id<"seeds">,
        })),
      });
    } catch (error: unknown) {
      console.warn(
        `[DayWonders] Quest ideas failed (the note stays as posted): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
});
