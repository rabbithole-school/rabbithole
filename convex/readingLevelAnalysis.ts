"use node";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { isTeacherRole, ROLES } from "./lib/roles";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { normalizeReadingLevel } from "./lib/readingLevels";
import { SCHOLAR_PRONOUN_GUIDANCE } from "./lib/scholarPronouns";

const anthropic = new Anthropic();
export const READING_LEVEL_SYSTEM_PROMPT = SCHOLAR_PRONOUN_GUIDANCE;

/**
 * Teacher-triggered AI **writing-derived** grade-level estimate.
 *
 * ⚠️ Naming: this writes `users.readingLevelSuggestion`, but every input is the
 * scholar's own PRODUCTION — the last 30 days of typed tutor-chat messages plus
 * OCR-transcribed handwritten portfolio prose. There is no reception evidence
 * here; nothing in this action observes what the scholar can READ. The output is
 * an estimate from the scholar's own writing. It is not a Lexile measure, not a
 * normed assessment, and not a screener result. Describe it that way in any
 * human-facing copy. (The stored field keeps the legacy name — renaming it is a
 * migration with blast radius well beyond this naming problem. See
 * `convex/lib/readingLevels.ts` for the full record.)
 *
 * Calls Claude Haiku, then writes to `readingLevelSuggestion` via
 * `scholars.setReadingLevelSuggestionFromAnalysis` (which also stamps the
 * estimate's age). Returns the result so the UI can show it immediately.
 *
 * The model-facing instruction below deliberately keeps its existing construct
 * ("reading/writing level"). Narrowing the model's target to writing alone would
 * shift the estimate distribution, and teachers accept these suggestions into the
 * confirmed level that drives tutor adaptation — so that is a prompt change on
 * the eval-risk path, not a copy fix. It is proposed as a separate, evaluated
 * change rather than smuggled in here.
 */
export const analyzeReadingLevelAI = action({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<{ level: string; wordCount: number; rationale: string } | null> => {
    const user = await ctx.runQuery(api.users.currentUser);
    if (!user || (!isTeacherRole(user.role))) {
      throw new Error("Forbidden: teacher or admin role required");
    }

    const texts = await ctx.runQuery(api.messages.getScholarUserMessages30d, {
      scholarId: args.scholarId,
    });
    const portfolioTexts = await ctx.runQuery(api.messages.getScholarPortfolioProse30d, {
      scholarId: args.scholarId,
    });
    const chatCombined = texts.join(" ").trim();
    const portfolioCombined = portfolioTexts.join("\n\n").trim();
    const countWords = (text: string) =>
      text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
    const wordCount = countWords(chatCombined) + countWords(portfolioCombined);
    if (wordCount < 10) return null;

    const evidenceSections = [
      `## Tutor chat messages (typed by the student)\n${chatCombined.slice(0, 6000) || "(none)"}`,
      `## Scanned written work — OCR transcription of the student's handwriting\n${portfolioCombined.slice(0, 4000) || "(none)"}`,
    ].join("\n\n");

    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 256,
      system: READING_LEVEL_SYSTEM_PROMPT,
      tools: [
        {
          name: "report_reading_level",
          description: "Report estimated reading/writing grade level",
          input_schema: {
            type: "object" as const,
            properties: {
              level: {
                type: "string",
                description:
                  "Reading/writing grade level with one-decimal precision: 'K', a whole grade '1'–'12', a tenth-of-a-grade like '7.3' (≈ three-tenths into grade 7), or 'college'. Use the decimal to place the scholar finely within a grade rather than rounding to the nearest whole grade.",
              },
              rationale: {
                type: "string",
                description: "One sentence explaining the assessment",
              },
            },
            required: ["level", "rationale"],
          },
        },
      ],
      tool_choice: { type: "any" as const },
      messages: [
        {
          role: "user",
          content: `Estimate the reading/writing level of the student from the evidence below. Assess vocabulary, sentence structure, and conceptual expression. Use US grade levels with **one decimal of precision** — e.g. "7.3" means roughly three-tenths of the way into grade 7. This fine granularity matters: place the scholar within the grade rather than rounding to a whole grade. Use "K" for kindergarten or "college" for college-level.\n\nYou have two kinds of evidence. Weigh both. The scanned written work is the student's composed, on-paper writing — usually a stronger signal of writing level than quick chat — but it was transcribed by OCR, so judge its vocabulary and sentence structure and do NOT judge spelling from it (transcription normalizes spelling). If one section is "(none)", rely on the other.\n\n${evidenceSections}`,
        },
      ],
    });
    const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
      userId: args.scholarId,
      principal: "scholar",
    });
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return null;
    await recordAnthropicUsage(ctx, {
      source: "reading-level",
      role: ROLES.SCHOLAR,
      model: MODELS.HAIKU,
      usage: response.usage,
      institutionId,
    });
    const input = toolUse.input as { level: string; rationale: string };

    // Coerce the model's free-form answer to a canonical valid level (e.g.
    // "Grade 7.3" → "7.3", "7" → "7"); bail if it can't be mapped so we never
    // store a level the teacher's accept flow would then propagate unchecked.
    const level = normalizeReadingLevel(input.level);
    if (!level) return null;

    await ctx.runMutation(api.scholars.setReadingLevelSuggestionFromAnalysis, {
      scholarId: args.scholarId,
      suggestion: level,
    });

    return { level, wordCount, rationale: input.rationale };
  },
});
