/**
 * Regenerate-mode: replay each scholar turn through the LIVE tutor model with
 * the EXACT system prompt the streaming path assembles
 * (`buildSystemPrompt` from convex/sessionHelpers.ts). This is what lets the
 * eval verify "would the current tutor do better on this same scholar?" — what
 * we score is what would ship today, not a paraphrase.
 *
 * Used only when `--mode regenerate`. For `--mode asis` the harness skips this
 * file entirely and scores the shipped messages as-is.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPromptParts } from "../../../convex/sessionHelpers";
import { layoutTutorRequest } from "../../../convex/sessionStreamHelpers";
import type { ModelId } from "../../../convex/lib/models";
import type { AideEffort } from "../../../convex/lib/aideModel";
import {
  TUTOR_DEFAULT_MODEL,
  supportsMidConversationSystem,
  tutorRuntime,
} from "../../../convex/lib/tutorModel";
import type { ScholarContext, Turn, TutorCase } from "./types";

const anthropic = new Anthropic();

/**
 * Model override + token/latency accounting for model bake-offs.
 * TUTOR_MODEL swaps the model (default: the live tutor, TUTOR_DEFAULT_MODEL). max_tokens and effort
 * come from the live `tutorRuntime` so a run matches what the tutor stream
 * would send; TUTOR_EFFORT overrides the effort (e.g. "low" for Opus 5.5).
 * Totals accumulate across generateAssistantTurn calls so the harness can
 * report per-case cost and latency.
 */
export const tutorModel = process.env.TUTOR_MODEL || TUTOR_DEFAULT_MODEL;
const runtime = tutorRuntime(tutorModel as ModelId);
export const tutorEffort: AideEffort | undefined =
  (process.env.TUTOR_EFFORT as AideEffort | undefined) || runtime.effort;
export const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
/** Per tutor call: ms to the first visible text delta, and to the end. */
export const turnLatency: Array<{ firstTextMs: number | null; totalMs: number }> = [];
export function resetTokenUsage() {
  tokenUsage.input = 0;
  tokenUsage.output = 0;
  tokenUsage.cacheRead = 0;
  tokenUsage.cacheCreate = 0;
  turnLatency.length = 0;
}

/**
 * Assemble the production tutor prompt with the params this eval varies, split
 * the way /session-stream sends it (layoutTutorRequest): stable, turn-1 and
 * documents parts as `system`, the per-turn session state as a trailing
 * role:"system" message, and the clock/pacing turn context at the end of the
 * latest user message (TRA-407).
 */
export function assemblePrompt(
  scholar: ScholarContext,
  isFirstTurn: boolean,
  isFirstSession: boolean,
  masteryContext: TutorCase["masteryContext"] = undefined,
  practiceSkillsContext: TutorCase["practiceSkillsContext"] = undefined,
  offersWrapUp = false,
): ReturnType<typeof buildSystemPromptParts> {
  return buildSystemPromptParts(
    null, // teacherWhisper
    scholar.readingLevel, // readingLevel
    scholar.name, // scholarName
    null, null, null, // unit / persona / perspective
    null, null, null, null, null, masteryContext ?? null, null, null, null, null, // process..directives..etc
    null, null, null, null, null, // activity/deliverable/verdicts/prior
    isFirstTurn,
    isFirstSession,
    null, // lastSessionAt
    null, null, null, null, null, null, null, // web practice..advance rubric
    practiceSkillsContext ?? null,
    // Positions 33-49 (physical environment … playMode … dossier interests)
    // keep their defaults; `undefined` selects the default, so the off-flag
    // prompt is byte-identical to the pre-flag harness.
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined,
    // The open-exploration "Wrap up" note (TRA-371), off unless the case asks.
    offersWrapUp,
  );
}

/**
 * Given the conversation up to a scholar turn, ask the live tutor model for a
 * response. Returns the assistant text.
 */
export async function generateAssistantTurn(
  scholar: ScholarContext,
  history: Turn[],
  masteryContext: TutorCase["masteryContext"] = undefined,
  practiceSkillsContext: TutorCase["practiceSkillsContext"] = undefined,
  offersWrapUp = false,
): Promise<string> {
  const isFirstTurn = history.length === 1 && history[0]?.content === "<start>";
  const parts = assemblePrompt(
    scholar,
    isFirstTurn,
    /* isFirstSession */ false,
    masteryContext,
    practiceSkillsContext,
    offersWrapUp,
  );
  // Strip the "<start>" sentinel — the live path treats it as a trigger, not a message.
  const stripped = history.filter(
    (t) => !(t.role === "user" && t.content === "<start>"),
  );
  // Coalesce consecutive same-role turns so the array strictly alternates —
  // the Anthropic API requires it and rejects a history ending in assistant.
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of stripped) {
    const last = messages[messages.length - 1];
    if (last && last.role === t.role) {
      last.content = `${last.content}\n\n${t.content}`;
    } else {
      messages.push({ role: t.role, content: t.content });
    }
  }
  // Must start with a user message and end with one (no assistant prefill).
  while (messages.length && messages[0].role === "assistant") messages.shift();
  while (messages.length && messages[messages.length - 1].role === "assistant") {
    messages.pop();
  }
  if (messages.length === 0) {
    // First-turn opener: pass a single seed user message so the model greets.
    messages.push({ role: "user", content: "(start)" });
  }
  // Streamed, like the live tutor, so time-to-first-text is measurable.
  const started = Date.now();
  let firstTextMs: number | null = null;
  const request = layoutTutorRequest({
    ...parts,
    messages,
    midConversationSystem: supportsMidConversationSystem(tutorModel),
  });
  const stream = anthropic.beta.messages.stream({
    model: tutorModel,
    max_tokens: runtime.maxTokens,
    system: request.system,
    // The trailing role:"system" message postdates the pinned SDK's types.
    messages: request.messages as typeof messages,
    ...(tutorEffort ? { output_config: { effort: tutorEffort } } : {}),
  });
  stream.on("text", () => {
    if (firstTextMs === null) firstTextMs = Date.now() - started;
  });
  const response = await stream.finalMessage();
  turnLatency.push({ firstTextMs, totalMs: Date.now() - started });
  const usage = response.usage as unknown as Record<string, number | undefined>;
  tokenUsage.input += usage.input_tokens ?? 0;
  tokenUsage.output += usage.output_tokens ?? 0;
  tokenUsage.cacheRead += usage.cache_read_input_tokens ?? 0;
  tokenUsage.cacheCreate += usage.cache_creation_input_tokens ?? 0;
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}
