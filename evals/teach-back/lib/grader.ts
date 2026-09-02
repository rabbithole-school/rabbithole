/**
 * Runs the SHIPPED teach-back grading pass on the transcript the eval produced,
 * so the "before enable" gate also checks the private (teacher-only) rubric
 * actually discriminates a strong explanation from a thin / wrong one.
 *
 * Everything here is the shipped path: buildTeachBackGradingPrompt +
 * TEACH_BACK_GRADING_TOOL (forced tool call) + parseTeachBackRubric, on the
 * observer model tier (OBSERVER_MODEL || SONNET) — identical to
 * convex/teachBackGrading.ts, minus the Convex persistence. The transcript is
 * rendered in the same `Scholar:` / `Tutor:` shape teachBacks.getForGrading
 * feeds the grader, floored at the tutor turn that opened the mode.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import {
  buildTeachBackGradingPrompt,
  parseTeachBackRubric,
  TEACH_BACK_GRADING_TOOL,
  type TeachBackRubric,
} from "../prompt";
import type { Turn } from "./types";
import { withRetry } from "./util";

const anthropic = new Anthropic();

export const GRADER_MODEL = process.env.OBSERVER_MODEL || MODELS.SONNET;

/**
 * Render the teach-back exchange the grader sees. Floors at `startTurnIndex`
 * (the tutor turn that fired start_teach_back — the analogue of
 * startedAtMessageId), inclusive, exactly like teachBacks.getForGrading.
 */
export function renderTeachBackTranscript(turns: Turn[], startTurnIndex: number): string {
  return turns
    .slice(Math.max(0, startTurnIndex))
    .map((t) => `${t.role === "user" ? "Scholar" : "Tutor"}: ${t.content.trim()}`)
    .filter((l) => l.trim() && !l.endsWith(":"))
    .slice(-40)
    .join("\n\n");
}

/** The rubric plus its 0–12 total, or null if grading failed / was unparseable. */
export interface GradeResult {
  rubric: TeachBackRubric | null;
  total: number | null;
}

/** Score one teach-back explanation through the shipped grader. Fail-soft. */
export async function gradeTeachBack(
  conceptLabel: string,
  transcript: string,
): Promise<GradeResult> {
  const { system, user } = buildTeachBackGradingPrompt({ conceptLabel, transcript });
  let rubric: TeachBackRubric | null = null;
  try {
    const response = await withRetry(() =>
      anthropic.messages.create({
        model: GRADER_MODEL,
        max_tokens: 1024,
        system,
        tools: [TEACH_BACK_GRADING_TOOL as unknown as Anthropic.Tool],
        tool_choice: { type: "tool", name: TEACH_BACK_GRADING_TOOL.name },
        messages: [{ role: "user", content: user }],
      }),
    );
    const toolUse = response.content.find((b) => b.type === "tool_use");
    rubric = parseTeachBackRubric(
      toolUse && toolUse.type === "tool_use" ? toolUse.input : null,
    );
  } catch {
    rubric = null;
  }
  const total = rubric
    ? rubric.completeness + rubric.causalChain + rubric.example + rubric.handledProbes
    : null;
  return { rubric, total };
}
