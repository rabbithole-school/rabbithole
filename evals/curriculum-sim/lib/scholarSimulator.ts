/**
 * The Scholar Simulator — the ONE genuinely new primitive in the
 * self-improving-curricula loop (review/self-improving-curricula-plan.md).
 *
 * An LLM roleplaying a specific kid working through the activity, reacting to
 * whatever the real tutor actually said — turn after turn. This is what today's
 * Test Drive (read-side identity swap, teacher types the kid) and spot-eval
 * (fixed replayed messages) can't do: produce an EMERGENT multi-turn
 * conversation, so a bad activity prompt shows up as a visibly bad conversation.
 *
 * Cheap model on purpose (Haiku) — the population is large in the real loop.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import { buildKidSystem } from "../../../convex/lib/curriculumSimShared";
import type { ScholarProfile, SimActivity, SimTurn } from "./types";

const anthropic = new Anthropic();

export const simModel = process.env.SIM_MODEL || MODELS.HAIKU;
export const simTokens = { input: 0, output: 0 };

/**
 * Control sentinels the kid appends on their OWN line when finished or stuck.
 * The driver parses + strips them before forwarding the message to the tutor,
 * so the tutor never sees them. This is how a session reaches `goal` / `stuck`
 * instead of always running to maxTurns.
 */
export const DONE = "[[DONE]]";
export const STUCK = "[[STUCK]]";

// The kid-roleplay system prompt (the "voice") is single-sourced from
// convex/lib/curriculumSimShared.ts so the eval sims and the product Preflight
// sims always talk the same way — see that file's buildKidSystem. (DONE/STUCK
// above mirror the shared sentinels.)

/** tutor→user, scholar→assistant (the kid is the "assistant" of its own loop). */
function toMessages(turns: SimTurn[]) {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of turns) {
    const role = t.role === "tutor" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n\n${t.content}`;
    else messages.push({ role, content: t.content });
  }
  // Sessions always open with a tutor turn, so this starts with a user message.
  return messages;
}

export type SimReply = { text: string; stop: "goal" | "stuck" | null };

function parseControl(raw: string): SimReply {
  if (raw.includes(DONE)) return { text: raw.replace(DONE, "").trim(), stop: "goal" };
  if (raw.includes(STUCK)) return { text: raw.replace(STUCK, "").trim(), stop: "stuck" };
  return { text: raw.trim(), stop: null };
}

/** Produce the kid's next message given the transcript so far. */
export async function generateScholarTurn(
  profile: ScholarProfile,
  activity: SimActivity,
  turns: SimTurn[],
  offline = false,
): Promise<SimReply> {
  if (offline) return stubScholar(profile, activity, turns);
  const res = await anthropic.messages.create({
    model: simModel,
    max_tokens: 400,
    system: buildKidSystem(profile, activity),
    messages: toMessages(turns),
  });
  const usage = res.usage as unknown as Record<string, number | undefined>;
  simTokens.input += usage.input_tokens ?? 0;
  simTokens.output += usage.output_tokens ?? 0;
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return parseControl(text);
}

/** Deterministic stand-in so the wiring + report render without an API key. */
function stubScholar(
  profile: ScholarProfile,
  _activity: SimActivity,
  turns: SimTurn[],
): SimReply {
  const scholarTurns = turns.filter((t) => t.role === "scholar").length;
  const distractible = profile.traits.some((t) => /distract|tangent|off.?task/i.test(t));
  if (scholarTurns === 0) return { text: "umm i think its about shapes? i like the red one", stop: null };
  if (scholarTurns === 1 && distractible) return { text: "wait my cat just walked on the keyboard lol. ok what were we doing", stop: null };
  if (scholarTurns >= 2) return { text: "ohhh i get it now! you split it in half and each part is the same. done!", stop: "goal" };
  return { text: "i dont really get it... can you just tell me", stop: null };
}
