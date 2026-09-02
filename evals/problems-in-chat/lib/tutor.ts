/**
 * The candidate tutor for the ⑮ problems-in-chat eval.
 *
 * System prompt = a lightweight, eval-local Socratic PREAMBLE + the SHIPPED
 * `buildChatPracticeSection` and the activity-kind-scoped `buildActivitySection`
 * (both imported via ../prompt.ts — so the thing measured is the thing served).
 * The tutor is given the SHIPPED `serve_practice_problem` tool.
 *
 * The preamble is deliberately eval-local (it does NOT import the live tutor
 * system prompt from convex/sessionHelpers) so the candidate can never be
 * confused with production — mirrors evals/socratic-handoff/lib/tutor.ts. What
 * MUST be identical to production is the practice section + tool, and those are
 * imported, not copied.
 *
 * Tool handling: when the tutor calls serve_practice_problem, the harness
 * resolves the free-text skill against the scenario's candidates (shipped
 * resolveChatPracticeSkill), generates a REAL item (shipped serveChatItem),
 * returns ONLY the stem as the tool_result (answer withheld, exactly like the
 * server → client contract), and records the served item for the judge/sim.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import { gradeTemplateItem } from "../../../convex/lib/practice/session";
import {
  buildChatPracticeSection,
  buildActivitySection,
  hasExplicitPracticeWithholdSignal,
  resolveChatPracticeSkill,
  serveChatItem,
  SERVE_PRACTICE_PROBLEM_TOOL,
} from "../prompt";
import type { Scenario, ServedItem, Turn } from "./types";
import { withRetry } from "./util";

const anthropic = new Anthropic();

export const TUTOR_MODEL = process.env.TUTOR_MODEL || MODELS.SONNET;

/**
 * A minimal Socratic tutor preamble — enough that the tutor behaves like
 * Rabbithole's (probe first, withhold answers, turn thinking back) so the
 * practice section is evaluated in a realistic frame, without importing the
 * real prod prompt. The practice section under test is appended after this.
 */
const BASE_PREAMBLE = `You are Rabbithole, a warm, curious Socratic tutor for a gifted elementary-school
scholar. Your goal is to make the scholar THINK, never to think for them.

- Probe first: draw out the scholar's own reasoning before you explain anything.
  Ask a real question about how they're thinking.
- Withhold answers. Never state or confirm a final answer; guide with questions.
- Follow the scholar's curiosity. If they ask "why", explore the idea with them.
- Read the moment. Meet frustration with support, not more demands. Meet a
  personal aside like a person, not a worksheet.
- Keep replies short and conversational — a sentence or two, like a real chat.`;

/** Build the tutor system prompt for a scenario (preamble + shipped section). */
export function buildTutorSystem(scenario: Scenario): string {
  const practiceSection = buildChatPracticeSection({
    fluentLabels: scenario.fluentLabels,
    frontierLabels: scenario.frontierLabels,
    dueLabels: scenario.dueLabels,
  });
  const activitySection = buildActivitySection({
    title: "Guided practice quest",
    description: null,
    kind: "problem_set",
    durationMinutes: null,
    systemPrompt: null,
    processTitle: null,
    processEmoji: null,
    recipe: null,
    problemSet: {
      domain: "whole_number_arithmetic",
      targetSkillKeys: scenario.candidates.map((candidate) => candidate.skillKey),
      targetSkillLabels: scenario.candidates.map((candidate) => candidate.label),
      itemCount: scenario.problemSetItemCount ?? 10,
    },
  });
  return [BASE_PREAMBLE, practiceSection, activitySection].filter(Boolean).join("\n");
}

// The shipped tool spec uses `inputSchema`; the Anthropic SDK wants `input_schema`.
const ANTHROPIC_TOOL: Anthropic.Tool = {
  name: SERVE_PRACTICE_PROBLEM_TOOL.name,
  description: SERVE_PRACTICE_PROBLEM_TOOL.description,
  input_schema: SERVE_PRACTICE_PROBLEM_TOOL.inputSchema as unknown as Anthropic.Tool.InputSchema,
};

function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * Serve one item for a tutor tool call: resolve → generate → withhold answer.
 * Returns the tool_result string (stem only) + the recorded ServedItem.
 */
function serveForToolCall(
  scenario: Scenario,
  skillArg: string,
  seed: number,
  atTurnIndex: number,
  latestScholarMessage: string,
): { toolResult: string; served: ServedItem } {
  if (hasExplicitPracticeWithholdSignal(latestScholarMessage)) {
    return {
      toolResult:
        "Do not serve a practice problem right now. The scholar explicitly needs support or a pause; respond to their thinking instead.",
      served: {
        atTurnIndex,
        skillArg,
        resolvedSkillKey: null,
        itemId: null,
        stem: null,
        correctAnswer: null,
      },
    };
  }
  const resolvedSkillKey = resolveChatPracticeSkill(skillArg, scenario.candidates);
  if (!resolvedSkillKey) {
    return {
      toolResult:
        "Could not find a practice item for that skill. Don't mention this error to the scholar; just continue the conversation naturally.",
      served: {
        atTurnIndex,
        skillArg,
        resolvedSkillKey: null,
        itemId: null,
        stem: null,
        correctAnswer: null,
      },
    };
  }
  const item = serveChatItem(resolvedSkillKey, seed);
  if (!item) {
    return {
      toolResult:
        "Could not generate a practice item. Don't mention this error; continue naturally.",
      served: { atTurnIndex, skillArg, resolvedSkillKey, itemId: null, stem: null, correctAnswer: null },
    };
  }
  const grade = gradeTemplateItem(item.itemId, "0"); // "0" is almost never right — just to read back correctAnswer
  return {
    toolResult: `Served this problem to the scholar in an interactive answer box: "${item.stem}". They will type their answer there and it will be graded automatically. You are NOT told the correct answer and have no way to compute a guaranteed-correct one — do not state or confirm any answer. Now write a short, encouraging hand-back line and let them solve it.`,
    served: {
      atTurnIndex,
      skillArg,
      resolvedSkillKey,
      itemId: item.itemId,
      stem: item.stem,
      correctAnswer: grade ? grade.correctAnswer : null,
    },
  };
}

/**
 * Produce one tutor turn given the conversation so far. Runs the tool loop:
 * if the tutor calls serve_practice_problem, we feed back the stem and let it
 * continue to a final text turn (cap the loop at 2 tool calls to catch a
 * pathological chain — which itself is a finding).
 *
 * `history` uses tutor's-eye roles (assistant = tutor, user = scholar). Returns
 * the tutor's visible text plus any items it served this turn.
 */
export async function tutorTurn(
  scenario: Scenario,
  system: string,
  history: Turn[],
  turnIndex: number,
  seedBase: number,
): Promise<{ text: string; served: ServedItem[] }> {
  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));
  const served: ServedItem[] = [];
  let guard = 0;
  while (guard++ < 4) {
    const msg = await withRetry(() =>
      anthropic.messages.create({
        model: TUTOR_MODEL,
        max_tokens: 500,
        system,
        tools: [ANTHROPIC_TOOL],
        messages,
      }),
    );
    const toolUses = msg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0 || msg.stop_reason !== "tool_use") {
      return { text: extractText(msg), served };
    }
    // Echo the assistant's tool_use block, then answer each tool call.
    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const skillArg =
        tu.name === SERVE_PRACTICE_PROBLEM_TOOL.name &&
        tu.input &&
        typeof (tu.input as { skill?: unknown }).skill === "string"
          ? (tu.input as { skill: string }).skill
          : "";
      const { toolResult, served: s } = serveForToolCall(
        scenario,
        skillArg,
        seedBase + served.length + 1,
        turnIndex,
        [...history].reverse().find((turn) => turn.role === "user")?.content ?? "",
      );
      served.push(s);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: toolResult });
    }
    messages.push({ role: "user", content: results });
  }
  // Loop guard tripped (pathological tool chaining) — grab whatever text exists.
  return { text: "(tutor exceeded the tool-call loop guard)", served };
}
