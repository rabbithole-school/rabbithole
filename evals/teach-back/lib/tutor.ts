/**
 * The candidate tutor for the teach-back eval.
 *
 * System prompt = a lightweight, eval-local Socratic PREAMBLE + the SHIPPED
 * `buildTeachBackSection` (imported via ../prompt.ts — so the thing measured is
 * the thing served). The tutor is given the SHIPPED start_teach_back /
 * finish_teach_back tools.
 *
 * The preamble is deliberately eval-local (it does NOT import the live tutor
 * system prompt from convex/sessionHelpers) so the candidate can never be
 * confused with production — mirrors evals/problems-in-chat/lib/tutor.ts and
 * evals/socratic-handoff/lib/tutor.ts. What MUST be identical to production is
 * the teach-back section + tools + the guidance each tool hands back, and those
 * are imported, not copied.
 *
 * Tool handling: the two teach-back tools do not compute anything in the eval
 * (there is no Convex here) — they just hand the model the SAME guidance string
 * the live /project-stream handler returns (teachBackStartGuidance /
 * TEACH_BACK_FINISH_GUIDANCE), which is what actually steers the tutor into the
 * novice stance. We record which tool fired (and the conceptLabel) for the
 * judge + the grader.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import {
  buildTeachBackSection,
  START_TEACH_BACK_TOOL,
  FINISH_TEACH_BACK_TOOL,
  teachBackStartGuidance,
  TEACH_BACK_FINISH_GUIDANCE,
  TEACH_BACK_NO_ACTIVE_GUIDANCE,
} from "../prompt";
import type { TeachBackEvent, Turn } from "./types";
import { withRetry } from "./util";

const anthropic = new Anthropic();

export const TUTOR_MODEL = process.env.TUTOR_MODEL || MODELS.SONNET;

/**
 * A minimal Socratic tutor preamble — enough that the tutor behaves like
 * Rabbithole's (probe first, withhold answers, turn thinking back) so the
 * teach-back section is evaluated in a realistic frame, without importing the
 * real prod prompt. The teach-back section under test is appended after this.
 */
const BASE_PREAMBLE = `You are Rabbithole, a warm, curious Socratic tutor for a gifted elementary-school
scholar. Your goal is to make the scholar THINK, never to think for them.

- Probe first: draw out the scholar's own reasoning before you explain anything.
- Withhold answers. Never state or confirm a final answer; guide with questions.
- Follow the scholar's curiosity. If they ask "why", explore the idea with them.
- Read the moment. Meet frustration with support, not more demands.
- Keep replies short and conversational — a sentence or two, like a real chat.
- You are a tool for thinking, not a friend to bond with: warm but clearly an AI.`;

/** Build the tutor system prompt (preamble + shipped teach-back section). */
export function buildTutorSystem(): string {
  return `${BASE_PREAMBLE}\n${buildTeachBackSection()}`;
}

// The shipped tool specs use `inputSchema`; the Anthropic SDK wants `input_schema`.
function toAnthropicTool(spec: {
  name: string;
  description: string;
  inputSchema: unknown;
}): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema as Anthropic.Tool.InputSchema,
  };
}

const START_TOOL = toAnthropicTool(START_TEACH_BACK_TOOL);
const FINISH_TOOL = toAnthropicTool(FINISH_TEACH_BACK_TOOL);

function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * Whether the eval currently has an active (started, not-yet-finished)
 * teach-back — mirrors the server's one-active-per-session invariant so
 * finish_teach_back returns the right guidance.
 */
function hasActive(events: TeachBackEvent[]): boolean {
  let active = false;
  for (const e of events) {
    if (e.tool === "start_teach_back") active = true;
    else if (e.tool === "finish_teach_back") active = false;
  }
  return active;
}

/**
 * Produce one tutor turn given the conversation so far. Runs the tool loop:
 * when the tutor calls a teach-back tool, we hand back the SHIPPED guidance
 * string and let it continue to a final text turn. Cap the loop to catch a
 * pathological chain (which is itself a finding).
 *
 * `history` uses tutor's-eye roles (assistant = tutor, user = scholar). Returns
 * the tutor's visible text plus any teach-back events fired this turn.
 */
export async function tutorTurn(
  system: string,
  history: Turn[],
  turnIndex: number,
  priorEvents: TeachBackEvent[],
): Promise<{ text: string; events: TeachBackEvent[] }> {
  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));
  const events: TeachBackEvent[] = [];
  const seen = () => [...priorEvents, ...events];
  let guard = 0;
  while (guard++ < 4) {
    const msg = await withRetry(() =>
      anthropic.messages.create({
        model: TUTOR_MODEL,
        max_tokens: 600,
        system,
        tools: [START_TOOL, FINISH_TOOL],
        messages,
      }),
    );
    const toolUses = msg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0 || msg.stop_reason !== "tool_use") {
      return { text: extractText(msg), events };
    }
    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === START_TEACH_BACK_TOOL.name) {
        const conceptLabel =
          tu.input && typeof (tu.input as { conceptLabel?: unknown }).conceptLabel === "string"
            ? (tu.input as { conceptLabel: string }).conceptLabel
            : "";
        events.push({ atTurnIndex: turnIndex, tool: "start_teach_back", conceptLabel });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: teachBackStartGuidance(conceptLabel),
        });
      } else if (tu.name === FINISH_TEACH_BACK_TOOL.name) {
        const active = hasActive(seen());
        events.push({ atTurnIndex: turnIndex, tool: "finish_teach_back", conceptLabel: null });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          // Hand back the exact guidance prod returns: the finish text when a
          // teach-back was active, else the no-active text (mirrors the server's
          // one-active-per-session resolution).
          content: active ? TEACH_BACK_FINISH_GUIDANCE : TEACH_BACK_NO_ACTIVE_GUIDANCE,
        });
      } else {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Unknown tool; ignore and continue the conversation naturally.",
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "(tutor exceeded the tool-call loop guard)", events };
}
