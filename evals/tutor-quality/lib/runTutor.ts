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
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import { MODELS } from "../../../convex/lib/models";
import type { ScholarContext, Turn, TutorCase } from "./types";

const anthropic = new Anthropic();

/**
 * Model override + token accounting for the Sonnet-vs-Opus bake-off.
 * Set TUTOR_MODEL env var (e.g. "claude-opus-4-8") to swap. Defaults to MODELS.SONNET.
 * Token totals are accumulated across generateAssistantTurn calls so the harness
 * can report per-case cost.
 */
export const tutorModel = process.env.TUTOR_MODEL || MODELS.SONNET;
export const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
export function resetTokenUsage() {
  tokenUsage.input = 0;
  tokenUsage.output = 0;
  tokenUsage.cacheRead = 0;
  tokenUsage.cacheCreate = 0;
}

/** Assemble the production tutor system prompt with the params this eval varies. */
export function assemblePrompt(
  scholar: ScholarContext,
  isFirstTurn: boolean,
  isFirstSession: boolean,
  masteryContext: TutorCase["masteryContext"] = undefined,
  practiceSkillsContext: TutorCase["practiceSkillsContext"] = undefined,
): string {
  return buildSystemPrompt(
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
): Promise<string> {
  const isFirstTurn = history.length === 1 && history[0]?.content === "<start>";
  const system = assemblePrompt(
    scholar,
    isFirstTurn,
    /* isFirstSession */ false,
    masteryContext,
    practiceSkillsContext,
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
  const response = await anthropic.messages.create({
    model: tutorModel,
    max_tokens: 1024,
    system,
    messages,
  });
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
