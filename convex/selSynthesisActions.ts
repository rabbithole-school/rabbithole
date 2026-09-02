"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { SEL_SYNTHESIS_MODEL } from "./lib/models";
import {
  SEL_SYNTHESIS_PROMPT_VERSION,
  SEL_SYNTHESIS_TOOL,
  SEL_SYNTHESIS_TOOL_NAME,
  buildSelSynthesisSystemPrompt,
  buildSelSynthesisUserPrompt,
  validateSelSynthesisClaims,
  type SelSynthesisToolInput,
} from "./lib/selSynthesisPrompt";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";

const windowValidator = v.object({
  startMs: v.number(),
  endMs: v.number(),
});

type GeneratedSynthesis = {
  scholarId: string;
  quiet: boolean;
  strengthCount: number;
  watchCount: number;
};

export const generateSelSynthesisForScholar = internalAction({
  args: {
    scholarId: v.id("users"),
    weekKey: v.string(),
    window: windowValidator,
  },
  handler: async (ctx, args): Promise<GeneratedSynthesis> => {
    const collected = await ctx.runQuery(
      internal.selSyntheses.collectEvidenceForScholar,
      { scholarId: args.scholarId, window: args.window },
    );

    if (collected.evidence.length === 0) {
      await ctx.runMutation(internal.selSyntheses.upsert, {
        scholarId: args.scholarId,
        institutionId: collected.institutionId,
        weekKey: args.weekKey,
        strengths: [],
        watch: [],
        quiet: true,
        window: args.window,
        model: SEL_SYNTHESIS_MODEL,
        promptVersion: SEL_SYNTHESIS_PROMPT_VERSION,
        generatedAt: Date.now(),
      });
      return {
        scholarId: String(args.scholarId),
        quiet: true,
        strengthCount: 0,
        watchCount: 0,
      };
    }

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: SEL_SYNTHESIS_MODEL,
      max_tokens: 1800,
      system: buildSelSynthesisSystemPrompt(),
      tools: [SEL_SYNTHESIS_TOOL],
      tool_choice: { type: "tool", name: SEL_SYNTHESIS_TOOL_NAME },
      messages: [
        {
          role: "user",
          content: buildSelSynthesisUserPrompt({
            scholarName: collected.scholarName,
            weekKey: args.weekKey,
            window: args.window,
            evidence: collected.evidence,
          }),
        },
      ],
    });
    await recordAnthropicUsage(ctx, {
      source: "sel-synthesis",
      role: ROLES.TEACHER,
      institutionId: collected.institutionId,
      model: SEL_SYNTHESIS_MODEL,
      usage: response.usage,
    });

    const toolBlock = response.content.find(
      (block) =>
        block.type === "tool_use" && block.name === SEL_SYNTHESIS_TOOL_NAME,
    );
    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new Error("SEL synthesis model returned no structured output");
    }
    const claims = validateSelSynthesisClaims(
      toolBlock.input as SelSynthesisToolInput,
      collected.evidence,
    );

    await ctx.runMutation(internal.selSyntheses.upsert, {
      scholarId: args.scholarId,
      institutionId: collected.institutionId,
      weekKey: args.weekKey,
      strengths: claims.strengths,
      watch: claims.watch,
      quiet: false,
      window: args.window,
      model: SEL_SYNTHESIS_MODEL,
      promptVersion: SEL_SYNTHESIS_PROMPT_VERSION,
      generatedAt: Date.now(),
    });
    return {
      scholarId: String(args.scholarId),
      quiet: false,
      strengthCount: claims.strengths.length,
      watchCount: claims.watch.length,
    };
  },
});

export const generateSelSynthesesForWeek = internalAction({
  args: {
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    window: windowValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    institutionId: string;
    weekKey: string;
    eligibleScholarCount: number;
    generatedCount: number;
    quietCount: number;
    failedCount: number;
    failedScholarIds: Id<"users">[];
  }> => {
    const scholarIds = await ctx.runQuery(
      internal.selSyntheses.eligibleScholarsForWeek,
      { institutionId: args.institutionId },
    );
    let generatedCount = 0;
    let quietCount = 0;
    const failedScholarIds: Id<"users">[] = [];
    for (const scholarId of scholarIds) {
      try {
        const result = await ctx.runAction(
          internal.selSynthesisActions.generateSelSynthesisForScholar,
          {
            scholarId,
            weekKey: args.weekKey,
            window: args.window,
          },
        );
        generatedCount += 1;
        if (result.quiet) quietCount += 1;
      } catch (error) {
        failedScholarIds.push(scholarId);
        console.error(
          `[SEL synthesis] Failed scholar ${scholarId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return {
      institutionId: String(args.institutionId),
      weekKey: args.weekKey,
      eligibleScholarCount: scholarIds.length,
      generatedCount,
      quietCount,
      failedCount: failedScholarIds.length,
      failedScholarIds,
    };
  },
});
