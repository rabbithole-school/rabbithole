"use node";
import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { isTeacherRole, ROLES } from "./lib/roles";
import { assertWritableAction } from "./lib/auth";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import {
  countWords,
  MIN_TYPED_WORDS_FOR_ESTIMATE,
  normalizeReadingLevel,
} from "./lib/readingLevels";
import { SCHOLAR_PRONOUN_GUIDANCE } from "./lib/scholarPronouns";

const anthropic = new Anthropic();
export const READING_LEVEL_SYSTEM_PROMPT = SCHOLAR_PRONOUN_GUIDANCE;

/**
 * Teacher-triggered AI **writing-derived** grade-level estimate.
 *
 * ⚠️ Naming: this writes `users.readingLevelSuggestion`, but every input is the
 * scholar's own TYPED production — the last 30 days of typed tutor-chat
 * messages (spoken and app-button turns are excluded, and handwriting is not
 * read: the profile line says "typed writing", so both writers measure that and
 * only that). There is no reception evidence
 * here; nothing in this action observes what the scholar can READ. The output is
 * an estimate from the scholar's own writing. It is not a Lexile measure, not a
 * normed assessment, and not a screener result. Describe it that way in any
 * human-facing copy. (The stored field keeps the legacy name — renaming it is a
 * migration with blast radius well beyond this naming problem. See
 * `convex/lib/readingLevels.ts` for the full record.)
 *
 * Calls Claude Haiku, then writes to `readingLevelSuggestion` via
 * `scholars.setReadingLevelSuggestionFromAnalysis` (which also stamps the
 * estimate's age and typed-word count). Info-only: shown under the Write row,
 * never promoted into the talk level (TRA-513). Returns the result so the UI
 * can show it immediately.
 */
export const analyzeReadingLevelAI = action({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<{ level: string; wordCount: number; rationale: string } | null> => {
    const user = await ctx.runQuery(api.users.currentUser);
    if (!user || (!isTeacherRole(user.role))) {
      throw new Error("Forbidden: teacher or admin role required");
    }
    // It spends AI and stores a suggestion on the scholar row (TRA-494).
    await assertWritableAction(ctx);

    const texts = await ctx.runQuery(api.messages.getScholarUserMessages30d, {
      scholarId: args.scholarId,
    });
    // The sample the model actually reads (sliced below), so the stored word
    // count is the evidence, not the 30-day total.
    const chatCombined = texts.join(" ").trim().slice(0, 6000);
    // Chat input is typed turns only (spoken ones are filtered upstream), so a
    // scholar who mostly dictates can land here with no estimate — the honest
    // answer, rather than grading the speech-to-text engine (TRA-495).
    const wordCount = countWords(chatCombined);
    if (wordCount < MIN_TYPED_WORDS_FOR_ESTIMATE) return null;

    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 256,
      system: READING_LEVEL_SYSTEM_PROMPT,
      tools: [
        {
          name: "report_reading_level",
          description: "Report the estimated grade level of the student's typed writing",
          input_schema: {
            type: "object" as const,
            properties: {
              level: {
                type: "string",
                description:
                  "Typed-writing grade level with one-decimal precision: 'K', a whole grade '1'–'12', a tenth-of-a-grade like '7.3' (≈ three-tenths into grade 7), or 'college'. Use the decimal to place the scholar finely within a grade rather than rounding to the nearest whole grade.",
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
          content: `Estimate the grade level of the student's TYPED writing from the messages below. Assess vocabulary, sentence structure, and conceptual expression. Use US grade levels with **one decimal of precision** — e.g. "7.3" means roughly three-tenths of the way into grade 7. This fine granularity matters: place the scholar within the grade rather than rounding to a whole grade. Use "K" for kindergarten or "college" for college-level.\n\n## Tutor chat messages (typed by the student)\n${chatCombined}`,
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
    // "Grade 7.3" → "7.3"); bail if it can't be mapped. The writer validates
    // again, so no caller can store an unchecked model answer.
    const level = normalizeReadingLevel(input.level);
    if (!level) return null;

    await ctx.runMutation(api.scholars.setReadingLevelSuggestionFromAnalysis, {
      scholarId: args.scholarId,
      suggestion: level,
      typedWords: wordCount,
    });

    return { level, wordCount, rationale: input.rationale };
  },
});
