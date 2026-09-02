"use node";

/**
 * Teach-the-Tutor — the grading pass.
 *
 * Scheduled by teachBacks.finish once the scholar has finished teaching. Pulls
 * the explanation transcript, asks Claude (observer tier — Sonnet) to score it
 * against a strict 0–3 × 4 rubric via a forced tool call, and writes the
 * TEACHER-ONLY rubric onto the teach-back row (active→graded).
 *
 * REDACTION (why we do NOT also write a mastery observation): the rubric is
 * teacher-facing analysis. A masteryObservations row carries numeric
 * masteryLevel + confidenceScore that ARE returned by scholar-/parent-readable
 * reads (masteryObservations.listForScholar, parents.childMastery, rendered in
 * MasteryTab / the parent portrait). Deriving those numbers from the rubric —
 * or even stamping fixed ones off a teach-back — leaks a teacher-only assessment
 * into a kid/parent surface and risks over-claiming mastery off a single viva.
 * So teach-back scoring lives EXCLUSIVELY on the teacher-only teachBacks row
 * (read only via teacherQuery). This is the spec's explicitly-sanctioned
 * fallback ("write ONLY the teachBacks rubric") — see DRAFT-NOTES.md.
 *
 * FAIL-SOFT by contract: any error (no context, API failure, unparseable rubric)
 * logs and returns, leaving the row `active` and re-gradeable. It NEVER throws —
 * grading runs off the live tutor stream and must not surface an error there.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import {
  buildTeachBackGradingPrompt,
  parseTeachBackRubric,
  TEACH_BACK_GRADING_TOOL,
} from "./lib/teachBack";

export const gradeTeachBack = internalAction({
  args: { teachBackId: v.id("teachBacks") },
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(internal.teachBacks.getForGrading, {
      teachBackId: args.teachBackId,
    });
    if (!data) {
      console.log(`[TeachBack] Skipping — teach-back ${args.teachBackId} not found`);
      return null;
    }
    if (data.status !== "active") {
      console.log(`[TeachBack] Skipping — already ${data.status}`);
      return null;
    }
    if (!data.transcript.trim()) {
      console.log(`[TeachBack] Skipping — no explanation transcript to grade`);
      return null;
    }
    const institutionId = data.scholarId
      ? await ctx.runQuery(internal.usage.resolveInstitution, {
          userId: data.scholarId,
          principal: "scholar",
        })
      : null;

    const { system, user } = buildTeachBackGradingPrompt({
      conceptLabel: data.conceptLabel,
      transcript: data.transcript,
    });

    const model = process.env.OBSERVER_MODEL || MODELS.SONNET;
    let rubric;
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system,
        tools: [TEACH_BACK_GRADING_TOOL],
        tool_choice: { type: "tool", name: TEACH_BACK_GRADING_TOOL.name },
        messages: [{ role: "user", content: user }],
      });
      await recordAnthropicUsage(ctx, {
        source: "teach_back_grading",
        role: ROLES.SCHOLAR,
        model,
        usage: response.usage,
        sessionId: data.sessionId,
        institutionId,
      });
      const toolUse = response.content.find((b) => b.type === "tool_use");
      rubric = parseTeachBackRubric(
        toolUse && toolUse.type === "tool_use" ? toolUse.input : null,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[TeachBack] Grading API failed (non-fatal): ${message}`);
      return null;
    }

    if (!rubric) {
      console.error(`[TeachBack] Unparseable rubric — leaving teach-back active`);
      return null;
    }

    // Write the teacher-only rubric (active→graded). This is the ONLY durable
    // record of the assessment — see the REDACTION note above for why no
    // scholar-/parent-readable mastery observation is written.
    await ctx.runMutation(internal.teachBacks.recordGrade, {
      teachBackId: args.teachBackId,
      rubric,
    });
    console.log(
      `[TeachBack] Graded "${data.conceptLabel}": completeness ${rubric.completeness}, causal ${rubric.causalChain}, example ${rubric.example}, probes ${rubric.handledProbes}`,
    );

    return rubric;
  },
});
