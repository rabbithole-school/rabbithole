/**
 * The tutor side of the loop. We call the PRODUCTION `buildSystemPrompt` from
 * convex/sessionHelpers.ts so the conversation runs against the exact prompt
 * the streaming path assembles — improving anything else would optimize a
 * fiction (same reasoning as evals/tutor-quality/lib/runTutor.ts).
 *
 * Difference from the tutor-quality harness: we DO pass the activity under test
 * (as `lessonActivityContext`, which carries activities.systemPrompt) and the
 * synthetic dossier, so the tutor is really driven by the curriculum + the
 * synthetic scholar — not a blank-slate prompt.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import { MODELS } from "../../../convex/lib/models";
import type { ScholarProfile, SimActivity, SimTurn } from "./types";
import { sanitizeToolText } from "./toolText";

const anthropic = new Anthropic();

export const tutorModel = process.env.TUTOR_MODEL || MODELS.SONNET;
export const tutorTokens = { input: 0, output: 0 };

/** Assemble the production tutor system prompt for this scholar × activity. */
export function assembleTutorPrompt(
  profile: ScholarProfile,
  activity: SimActivity,
  isFirstTurn: boolean,
  isFirstSession: boolean,
): string {
  const lessonActivityContext = {
    title: activity.title,
    description: activity.deliverablePrompt ?? null,
    kind: activity.kind,
    systemPrompt: activity.systemPrompt,
    durationMinutes: activity.durationMinutes ?? null,
    processTitle: null,
    processEmoji: null,
  };
  // Positional call — order mirrors convex/sessionHelpers.ts:1343.
  return buildSystemPrompt(
    null, // teacherWhisper
    profile.readingLevel, // readingLevel
    profile.name, // scholarName
    null, // unitContext
    null, // personaContext
    null, // perspectiveContext
    null, // processContext
    null, // processStateData
    null, // artifactData
    profile.dossier, // dossierContent  ← synthetic dossier path
    null, // seedsData
    null, // masteryContext
    null, // signalContext
    null, // timingContext
    null, // lessonContext
    null, // teacherDirectives
    lessonActivityContext, // lessonActivityContext ← activity under test
    null, // priorActivityContext
    null, // activityContext
    null, // standaloneDeliverableContext
    null, // currentVerdictsContext
    isFirstTurn,
    isFirstSession,
    null, // lastSessionAt
    null, // webPracticeContext
  );
}

/** scholar→user, tutor→assistant, coalesced + trimmed to a valid message array. */
function toMessages(turns: SimTurn[]) {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of turns) {
    const role = t.role === "scholar" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n\n${t.content}`;
    else messages.push({ role, content: t.content });
  }
  while (messages.length && messages[0].role === "assistant") messages.shift();
  while (messages.length && messages[messages.length - 1].role === "assistant") {
    messages.pop();
  }
  return messages;
}

/**
 * Ask the live tutor for its next message given the transcript so far.
 * `turns` holds prior turns (tutor speaks first, so an empty array = opener).
 */
export async function generateTutorTurn(
  profile: ScholarProfile,
  activity: SimActivity,
  turns: SimTurn[],
  offline = false,
): Promise<string> {
  const isFirstTurn = turns.length === 0;
  if (offline) return stubTutor(profile, activity, turns);
  const system = assembleTutorPrompt(profile, activity, isFirstTurn, true);
  const messages = toMessages(turns);
  if (messages.length === 0) messages.push({ role: "user", content: "(start)" });
  const res = await anthropic.messages.create({
    model: tutorModel,
    max_tokens: 1024,
    system,
    messages,
  });
  const usage = res.usage as unknown as Record<string, number | undefined>;
  tutorTokens.input += usage.input_tokens ?? 0;
  tutorTokens.output += usage.output_tokens ?? 0;
  const raw = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  // The harness binds no tools, so the tutor sometimes emits a tool call as
  // text. Normalize it to a neutral "[the tutor showed an image]" marker so it
  // doesn't pollute the next turn's context or read as broken output to the
  // judge. See lib/toolText.ts.
  return sanitizeToolText(raw);
}

/** Deterministic stand-in so the wiring + report render without an API key. */
function stubTutor(
  profile: ScholarProfile,
  activity: SimActivity,
  turns: SimTurn[],
): string {
  if (turns.length === 0) {
    return `Hi ${profile.name}! I'm a computer helper, not a real person. Today we're going to play with ${activity.title.toLowerCase()}. What do you already notice about it?`;
  }
  const lastScholar = [...turns].reverse().find((t) => t.role === "scholar");
  return `That's a great noticing. Instead of me telling you — what do you think would happen if you tried it yourself? (re: "${lastScholar?.content.slice(0, 40) ?? ""}")`;
}
