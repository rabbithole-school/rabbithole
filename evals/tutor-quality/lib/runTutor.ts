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
import {
  buildSystemPromptParts,
  type SeedOriginContext,
  type TutorAppSurface,
  type UnitContext,
} from "../../../convex/sessionHelpers";
import { layoutTutorRequest } from "../../../convex/sessionStreamHelpers";
import type { ModelId } from "../../../convex/lib/models";
import type { AideEffort } from "../../../convex/lib/aideModel";
import {
  TUTOR_DEFAULT_MODEL,
  supportsMidConversationSystem,
  tutorRuntime,
} from "../../../convex/lib/tutorModel";
import type { ScholarContext, SessionShape, Turn, TutorCase } from "./types";

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
  sessionShape: SessionShape | undefined = undefined,
): ReturnType<typeof buildSystemPromptParts> {
  const shaped = shapedContext(sessionShape);
  return buildSystemPromptParts(
    scholar.readingLevel, // readingLevel
    scholar.name, // scholarName
    shaped.unitContext, null, null, // unit / persona / perspective
    null, null, null, null, null, masteryContext ?? null, null, null, null, null, // process..directives..etc
    null, null, null, null, null, // activity/deliverable/verdicts/prior
    isFirstTurn,
    isFirstSession,
    null, // lastSessionAt
    null, null, null, null, // web practice, granules, recipe, baseline evidence
    shaped.seedOriginContext,
    null, null, // document notes, advance rubric
    practiceSkillsContext ?? null,
    // Positions 32-48 (physical environment … playMode … dossier interests)
    // keep their defaults; `undefined` selects the default, so the off-flag
    // prompt is byte-identical to the pre-flag harness.
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined,
    // The open-exploration "Wrap up" note (TRA-371): every scholar-started
    // chat with no activity shows it, so a shaped case always renders it.
    offersWrapUp || sessionShape !== undefined,
    // prior unit work, parking lot, free play, read/write levels: defaults.
    undefined, undefined, undefined, undefined,
    shaped.appSurface,
  );
}

/**
 * The unit / seed / app context getSessionContext builds for a chat the
 * scholar started themselves (TutorCase.sessionShape): their own Quest's
 * activity-less chat with nothing built in it yet (no bake), or a seed chat
 * with no activity. Neither offers create_code (lib/mission.ts
 * mayCreateAppInSession); both offer the Python bench. No shape → the bare
 * prompt every other case gets.
 */
function shapedContext(shape: SessionShape | undefined): {
  unitContext: UnitContext | null;
  seedOriginContext: SeedOriginContext | null;
  appSurface: TutorAppSurface | undefined;
} {
  if (!shape) {
    return { unitContext: null, seedOriginContext: null, appSurface: undefined };
  }
  const appSurface = (kind: "quest" | "open"): TutorAppSurface => ({
    builderFeatures: false,
    builderPrimary: false,
    sideAppWork: null,
    canCreateApp: false,
    pythonBench: { offered: true, open: false, otherApp: false, kind },
  });
  if (shape.kind === "ownQuestChat") {
    return {
      unitContext: {
        title: shape.unitTitle,
        description: null,
        systemPrompt: null,
        rubric: null,
        youtubeUrl: null,
        videoTranscript: null,
        bigIdea: null,
        essentialQuestions: null,
        enduringUnderstandings: null,
        isOwnIsUnit: true,
        ownIsUnitOutline: [],
        ownIsUnitBuiltInChat: false,
        ownIsUnitNextActivityTitle: null,
        questMission: null,
        isPlanningChat: true,
        questBuildLocked: null,
        questBuildOpen: null,
      },
      seedOriginContext: null,
      appSurface: appSurface("quest"),
    };
  }
  return {
    unitContext: null,
    seedOriginContext: {
      topic: shape.topic,
      domain: shape.domain,
      rationale: null,
      approachHint: null,
      connectionTo: null,
      card: null,
      hasStructure: false,
      assignedAsHomework: false,
      cardAnswer: null,
      storyThreadContext: null,
    },
    appSurface: appSurface("open"),
  };
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
  sessionShape: SessionShape | undefined = undefined,
): Promise<string> {
  const isFirstTurn = history.length === 1 && history[0]?.content === "<start>";
  const parts = assemblePrompt(
    scholar,
    isFirstTurn,
    /* isFirstSession */ false,
    masteryContext,
    practiceSkillsContext,
    offersWrapUp,
    sessionShape,
  );
  // Strip the "<start>" sentinel — the live path treats it as a trigger, not a message.
  // A shaped case keeps it: the live tutor answers "<start>" with the session's
  // opener (the base prompt's <start> bullet), and that opener is part of what
  // a scholar-started chat is judged on.
  const stripped = sessionShape
    ? history
    : history.filter((t) => !(t.role === "user" && t.content === "<start>"));
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
