"use node";

/**
 * understandings — turn a committee standard (notation + dense description) into
 * a short, kid-/teacher-legible UNDERSTANDING, so the Knowledge Tree's node
 * identity is the understanding and the CCSS/ASN code is just a tag.
 *
 * `translateBand` batches one grade-banded strand into a SINGLE Haiku call
 * (cheap, fast) and persists the result on each standard. Idempotent: standards
 * that already carry an understanding are skipped, so re-running is free.
 *
 * This is the real "translate" job from review/knowledge-tree-expansion.html §2
 * — the LLM rephrases established pedagogy into kid-legible language; it does
 * not invent the curriculum.
 */

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";

const SYSTEM_PROMPT = `You rephrase formal K-12 curriculum standards into short, plain "I can…"-style understandings for a gifted elementary school's teachers and learners.

Rules:
- One understanding per standard, ≤ 12 words, concrete and human.
- Say what the learner can DO or GETS, in everyday language — never restate the code or committee jargon.
- No "the student will", no "demonstrate the ability to". Start with a verb or a noun phrase.
- Keep it true to the standard's actual content; do not generalize away the specific skill.
Examples:
- "4.NF.A.2 | Compare two fractions with different numerators and different denominators…" → "Tell which of two fractions is bigger"
- "RF.1.2 | Demonstrate understanding of spoken words, syllables, and sounds…" → "Hear and play with the sounds inside words"
- "3.MD.C.7 | Relate area to the operations of multiplication and addition." → "See area as rows-times-columns"`;

const TOOL = {
  name: "record_understandings" as const,
  description: "Record the plain-language understanding for each standard.",
  input_schema: {
    type: "object" as const,
    required: ["items"],
    properties: {
      items: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["notation", "understanding"],
          properties: {
            notation: { type: "string" as const, description: "The standard's notation code, exactly as given" },
            understanding: { type: "string" as const, description: "≤12-word plain-language understanding" },
          },
        },
      },
    },
  },
};

type TranslateResult = { items: Array<{ notation: string; understanding: string }> };

export const translateBand = action({
  args: { strandKey: v.string(), grade: v.string() },
  handler: async (ctx, args): Promise<{ translated: number; skipped: number }> => {
    const standards = await ctx.runQuery(
      internal.understandingsData.bandForTranslation,
      { strandKey: args.strandKey, grade: args.grade },
    );
    const todo = standards.filter((s) => !s.understanding);
    if (todo.length === 0) return { translated: 0, skipped: standards.length };

    const userMessage = [
      `Rephrase each of these grade-${args.grade} standards into a short plain understanding:`,
      "",
      ...todo.map((s) => `${s.notation ?? s.asnId} | ${s.description}`),
    ].join("\n");

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "record_understandings" },
      messages: [{ role: "user", content: userMessage }],
    });
    await recordAnthropicUsage(ctx, {
      source: "understandings",
      model: MODELS.HAIKU,
      usage: response.usage,
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new Error("No tool_use block from Haiku");
    }
    const parsed = toolBlock.input as TranslateResult;
    const byNotation = new Map<string, string>();
    for (const item of parsed.items ?? []) {
      if (item.notation && item.understanding) {
        byNotation.set(item.notation.trim(), item.understanding.trim());
      }
    }

    const patches: Array<{ id: Id<"standards">; understanding: string }> = [];
    for (const s of todo) {
      const u = byNotation.get((s.notation ?? s.asnId).trim());
      if (u) patches.push({ id: s._id, understanding: u });
    }
    await ctx.runMutation(internal.understandingsData.setUnderstandings, {
      patches,
      source: MODELS.HAIKU,
    });

    return { translated: patches.length, skipped: standards.length - todo.length };
  },
});
