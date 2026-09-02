"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { ROLES } from "./lib/roles";
import {
  EOD_CHECKIN_SYSTEM,
  EOD_CHECKIN_TOOL,
  renderEodUserMessage,
  type EodChannelInput,
} from "./lib/eodCheckin";
import { recordAnthropicUsage } from "./usage";

interface GenerateResult {
  ok: boolean;
  hook?: string;
  wrapUp?: string;
  questions?: string[];
}

function validResult(
  parsed:
    | { hook?: unknown; wrapUp?: unknown; questions?: unknown }
    | undefined,
): parsed is { hook: string; wrapUp: string; questions: string[] } {
  return (
    typeof parsed?.hook === "string" &&
    parsed.hook.trim().length > 0 &&
    typeof parsed?.wrapUp === "string" &&
    parsed.wrapUp.trim().length > 0 &&
    Array.isArray(parsed.questions) &&
    parsed.questions.length >= 2 &&
    parsed.questions.length <= 4 &&
    parsed.questions.every(
      (question) =>
        typeof question === "string" && question.trim().length > 0,
    )
  );
}

export const generate = internalAction({
  args: {
    input: v.any(),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args): Promise<GenerateResult> => {
    const input = args.input as EodChannelInput;
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("[EodCheckin] no ANTHROPIC_API_KEY — mechanical fallback");
      return { ok: false };
    }

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      // Render the note in the TARGET institution's identity (school name),
      // resolved from the institution attributed by runDaily. Missing → the
      // configured primary default (byte-identical).
      const profile = await ctx.runQuery(internal.institutions.promptProfile, {
        institutionId: args.institutionId ?? null,
      });
      const systemText = EOD_CHECKIN_SYSTEM(profile);
      let parsed:
        | { hook?: unknown; wrapUp?: unknown; questions?: unknown }
        | undefined;

      for (let attempt = 0; attempt < 2 && !validResult(parsed); attempt++) {
        const response = await anthropic.messages.create({
          model: MODELS.SONNET,
          max_tokens: 2048,
          system: [{ type: "text", text: systemText }],
          tools: [EOD_CHECKIN_TOOL],
          tool_choice: { type: "tool", name: EOD_CHECKIN_TOOL.name },
          messages: [
            { role: "user", content: renderEodUserMessage(input) },
          ],
        });
        await recordAnthropicUsage(ctx, {
          source: "eod-checkin",
          role: ROLES.PLATFORM_ADMIN,
          model: MODELS.SONNET,
          usage: response.usage,
          institutionId: args.institutionId,
        });
        const block = response.content.find((item) => item.type === "tool_use");
        parsed = (
          block as
            | {
                input?: {
                  hook?: unknown;
                  wrapUp?: unknown;
                  questions?: unknown;
                };
              }
            | undefined
        )?.input;
        if (!validResult(parsed)) {
          console.error(
            `[EodCheckin] narrative tool_use missing fields (attempt ${attempt + 1}, stop_reason ${response.stop_reason})`,
          );
        }
      }

      if (!validResult(parsed)) {
        console.error(
          "[EodCheckin] narrative failed twice — mechanical fallback",
        );
        return { ok: false };
      }
      return {
        ok: true,
        hook: parsed.hook.replace(/\s+/g, " ").trim().slice(0, 140),
        wrapUp: parsed.wrapUp.trim(),
        questions: parsed.questions.map((question) => question.trim()),
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[EodCheckin] narrative call FAILED (mechanical fallback): ${message}`,
      );
      return { ok: false };
    }
  },
});
