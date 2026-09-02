"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { imageUrlToContentPart } from "./lib/imageBytes";
import {
  MODELS,
  PRACTICE_PAD_HINT_MODEL,
} from "./lib/models";
import {
  buildPadHintPrompt,
  PAD_HINT_TOOL,
  supportsPadHintModelCall,
  verifyPadHintOutput,
  type PadHintModelOutput,
} from "./lib/practice/padHints";
import { recordAnthropicUsage } from "./usage";

export const generatePadHint = action({
  args: {
    scholarId: v.id("users"),
    itemId: v.string(),
    padImageId: v.id("_storage"),
    model: v.optional(v.union(v.literal(MODELS.HAIKU), v.literal(MODELS.SONNET))),
  },
  handler: async (ctx, args): Promise<{
    nudge: string | null;
    hasSteps: boolean;
  }> => {
    const callerId = await getAuthUserId(ctx);
    if (!callerId) throw new Error("Not authenticated");
    const owned = await ctx.runQuery(
      internal.practiceWorkImages.ownedImage,
      {
        callerId,
        scholarId: args.scholarId,
        itemId: args.itemId,
        storageId: args.padImageId,
      },
    );
    if (!owned.owned) throw new Error("Practice image ownership could not be verified.");

    const item = await ctx.runQuery(internal.practiceSkills.padHintContext, {
      itemId: args.itemId,
    });
    if (
      !item?.answerCanonical ||
      !supportsPadHintModelCall(item.answerType)
    ) {
      return { nudge: null, hasSteps: false };
    }
    const itemAnswerType = item.answerType as
      | "integer"
      | "decimal"
      | "fraction"
      | "expression";
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: args.scholarId, principal: "scholar" },
    );
    const imageUrl = await ctx.runQuery(internal.files.getUrlInternal, {
      storageId: args.padImageId,
    });
    const imagePart = imageUrl ? await imageUrlToContentPart(imageUrl) : null;
    if (!imagePart) return { nudge: null, hasSteps: false };

    const model = args.model ?? PRACTICE_PAD_HINT_MODEL;
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: 1200,
          tools: [PAD_HINT_TOOL],
          tool_choice: { type: "tool", name: PAD_HINT_TOOL.name },
          messages: [
            {
              role: "user",
              content: [
                imagePart,
                {
                  type: "text",
                  text: buildPadHintPrompt({
                    stem: item.stem,
                    allowSteps: !item.hasDeterministicSteps,
                  }),
                },
              ],
            },
          ],
        },
        { timeout: 10_000 },
      );
      await recordAnthropicUsage(ctx, {
        source: "practice-pad-hint",
        model,
        usage: response.usage,
        institutionId,
      });
      const block = response.content.find((part) => part.type === "tool_use");
      const verified =
        block?.type === "tool_use"
          ? verifyPadHintOutput(block.input as PadHintModelOutput, {
              answerCanonical: item.answerCanonical,
              answerType: itemAnswerType,
              allowSteps: !item.hasDeterministicSteps,
              stem: item.stem,
            })
          : null;
      if (!verified) return { nudge: null, hasSteps: false };

      await ctx.runMutation(internal.practicePadHints.storeVerified, {
        scholarId: args.scholarId,
        itemId: args.itemId,
        imageId: args.padImageId,
        nudge: verified.nudge,
        ...(verified.workedSteps
          ? { workedSteps: verified.workedSteps }
          : {}),
        model,
      });
      return {
        nudge: verified.nudge,
        hasSteps: !!verified.workedSteps,
      };
    } catch (error) {
      console.error("[practice-pad-hint] generation failed:", error);
      return { nudge: null, hasSteps: false };
    }
  },
});
