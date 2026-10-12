/**
 * The checkRubric arm — one graded submission, through the REAL production
 * grader surface.
 *
 * Production fidelity (what is imported vs. mirrored):
 *  - System prompt: `buildRubricSystemPrompt` from convex/lib/rubricCheckPrompt.ts —
 *    the exact function `checkRubric` calls.
 *  - User turn: `buildRubricCheckUserMessage` from the same module — the exact
 *    activity/reading-level/rubric/submission assembly `checkRubric` sends,
 *    including the numbered `[id]` rubric block from production's own
 *    `renderCriteriaForRubricCheck`.
 *  - Tool: `RUBRIC_TOOL` imported from convex/deliverables.ts — literally the
 *    schema production binds, so the eval cannot drift from it.
 *  - Model + call shape: `MODELS.SONNET`, max_tokens 2048, forced
 *    `tool_choice` — same as the action.
 *  - Verdict sanitization: production's shared `scoreRubricVerdicts`. The
 *    action carries an inline near-duplicate of that sanitizer; the two agree
 *    on every LEVEL (drop unknown ids, first duplicate wins, omitted → "not")
 *    and differ only in the placeholder note text and array order, neither of
 *    which this eval reads.
 *
 * The one thing this eval deliberately does NOT reproduce is the Convex
 * plumbing around the call (deliverable lookup, usage metering, writing the
 * result back) — none of it reaches the model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { RUBRIC_TOOL } from "../../../convex/deliverables";
import {
  buildRubricCheckUserMessage,
  buildRubricSystemPrompt,
} from "../../../convex/lib/rubricCheckPrompt";
import { scoreRubricVerdicts } from "../../../convex/lib/deliverable";
import { MODELS } from "../../../convex/lib/models";
import type { CheckRubricCase, CheckRubricObservation, Level } from "./types";

const anthropic = new Anthropic();

export const checkModel = process.env.CHECK_MODEL || MODELS.SONNET;
export const checkTokens = { input: 0, output: 0 };

type RawVerdict = { criterionId: string; level: Level; note: string };
type RawToolInput = {
  verdicts?: RawVerdict[];
  /** Marked required in RUBRIC_TOOL, but the model does sometimes omit it. */
  overall?: Level;
  feedback: string;
  conceptLabel: string;
  domain: string;
  masteryLevel: number;
  confidence: number;
};

/** The exact prompt pair production sends for this fixture. Exported so the
 * report can show what was actually graded. */
export function assembleCheckPrompts(testCase: CheckRubricCase): {
  system: string;
  user: string;
} {
  return {
    system: buildRubricSystemPrompt(),
    user: buildRubricCheckUserMessage({
      activityTitle: testCase.activityTitle,
      activityDescription: testCase.activityDescription,
      deliverablePrompt: testCase.deliverablePrompt,
      readingLevel: testCase.readingLevel,
      criteria: testCase.criteria,
      angle: null,
      submissionText: testCase.submission,
      assessesWritingMechanics: testCase.assessesWritingMechanics,
    }),
  };
}

export async function runCheckRubric(
  testCase: CheckRubricCase,
  { offline = false }: { offline?: boolean } = {},
): Promise<CheckRubricObservation> {
  if (offline) return stubCheck(testCase);

  const { system, user } = assembleCheckPrompts(testCase);
  const response = await anthropic.messages.create({
    model: checkModel,
    max_tokens: 2048,
    system,
    tools: [RUBRIC_TOOL],
    tool_choice: { type: "tool", name: "report_rubric_check" },
    messages: [{ role: "user", content: user }],
  });
  checkTokens.input += response.usage.input_tokens ?? 0;
  checkTokens.output += response.usage.output_tokens ?? 0;

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("AI did not call report_rubric_check");
  }
  const raw = toolBlock.input as RawToolInput;
  const rawKeys = Object.keys(raw ?? {});
  const scored = scoreRubricVerdicts(testCase.criteria, raw.verdicts ?? []);

  const levels: Record<string, Level> = {};
  const notes: Record<string, string> = {};
  const waived: Record<string, boolean> = {};
  for (const v of scored.verdicts) {
    levels[v.criterionId] = v.level;
    notes[v.criterionId] = v.note ?? "";
    waived[v.criterionId] = v.waived === true;
  }
  return {
    levels,
    notes,
    waived,
    reportedOverall: raw.overall ?? null,
    derivedOverall: scored.overall,
    feedback: raw.feedback,
    conceptLabel: raw.conceptLabel,
    masteryLevel: raw.masteryLevel,
    confidence: raw.confidence,
    stopReason: response.stop_reason ?? null,
    rawKeys,
  };
}

/**
 * Deterministic stand-in so `--offline` exercises the wiring without a key.
 * Deliberately naive (everything full) — NOT a behavior claim about the real
 * grader; only a live run measures anything.
 */
function stubCheck(testCase: CheckRubricCase): CheckRubricObservation {
  const levels: Record<string, Level> = {};
  const notes: Record<string, string> = {};
  const waived: Record<string, boolean> = {};
  for (const c of testCase.criteria) {
    levels[c.id] = "full";
    notes[c.id] = "(offline stub)";
    waived[c.id] = false;
  }
  return {
    levels,
    notes,
    waived,
    reportedOverall: "full",
    derivedOverall: "full",
    feedback: "(offline stub)",
    conceptLabel: testCase.activityTitle,
    masteryLevel: 2,
    confidence: 0.5,
    stopReason: "end_turn",
    rawKeys: ["verdicts", "overall", "feedback", "conceptLabel", "domain", "masteryLevel", "confidence"],
  };
}
