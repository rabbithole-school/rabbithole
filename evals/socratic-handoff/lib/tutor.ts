/**
 * Calls the candidate handoff tutor (the prompt under test, from
 * ../prompt.ts) against the Sonnet tutor model. Mirrors
 * evals/tutor-quality/lib/runTutor.ts's shape, but deliberately does NOT
 * import convex/sessionHelpers — the candidate prompt is eval-local and
 * must never be confused with the live tutor prompt.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import { buildHandoffPrompt } from "../../../convex/lib/practice/handoff";
import {
  HANDOFF_OPENER,
  SPIRAL_HANDOFF_OPENER,
} from "../../../shared/practiceLoop";
import type { Scenario, Turn } from "./types";
import { withRetry } from "./util";

const anthropic = new Anthropic();

export const TUTOR_MODEL = process.env.TUTOR_MODEL || MODELS.SONNET;

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Production seeds this bubble client-side before the first model call. */
export function tutorOpener(scenario: Scenario): string {
  return scenario.entryMode === "spiral"
    ? SPIRAL_HANDOFF_OPENER
    : HANDOFF_OPENER;
}

/** A subsequent tutor reply, given the conversation so far (assistant = tutor, user = scholar). */
export async function tutorReply(scenario: Scenario, turns: Turn[]): Promise<string> {
  const system = buildHandoffPrompt(
    { stem: scenario.stem, wrongAnswers: scenario.wrongAnswers },
    scenario.entryMode,
    scenario.scholarContext,
  );
  const messages = turns.map((t) => ({ role: t.role, content: t.content }));
  const response = await withRetry(() =>
    anthropic.messages.create({
      model: TUTOR_MODEL,
      max_tokens: 400,
      system,
      messages,
    }),
  );
  return extractText(response);
}
