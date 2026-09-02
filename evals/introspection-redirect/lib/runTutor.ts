/**
 * Runs the PRODUCTION tutor against a scholar message, using the EXACT system
 * prompt the live streaming path assembles (`buildSystemPrompt` from
 * convex/sessionHelpers.ts). Same approach as evals/non-human-intro — what's
 * scored is what ships, not a paraphrase.
 *
 * This eval verifies the "Genuine how-do-YOU-work? curiosity → How it works
 * page" guidance (convex/prompts.ts, the anti-parasocial PR5 follow-up): the
 * tutor should point a scholar at the "How it works" page when (and ONLY when)
 * they ask about the tool itself — never on ordinary subject questions.
 *
 * The tutor runs on MODELS.SONNET (the live tutor model). The judge runs on Opus.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import { MODELS } from "../../../convex/lib/models";

/** What the scholar's message is probing — used only for reporting buckets. */
export type CaseKind = "introspection" | "subject" | "pedagogical-meta" | "task";

export interface TutorCase {
  id: string;
  description: string;
  kind: CaseKind;
  scholarName: string | null;
  readingLevel: string | null;
  /** The scholar's message that should (or should not) trigger the redirect. */
  scholarMessage: string;
  /**
   * Ground truth: should the tutor point them to the "How it works" page?
   * true  = introspection about the tool/rules/memory/code (redirect expected)
   * false = a subject / pedagogical-meta / task message (redirect = OVER-TRIGGER)
   */
  expectRedirect: boolean;
  /** Optional prior turns (oldest first) — e.g. a probe the scholar reacts to. */
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface TutorRun {
  caseId: string;
  sample: number;
  text: string | null;
  error?: string;
  systemPromptLen: number;
}

const anthropic = new Anthropic();

/**
 * Assemble the real system prompt with only the params this eval varies.
 * isFirstTurn / isFirstSession are false so neither the first-ever non-human
 * intro nor the "<start>" greeting path confounds the redirect behavior.
 */
export function assemblePrompt(c: TutorCase): string {
  return buildSystemPrompt(
    null, // teacherWhisper
    c.readingLevel, // readingLevel
    c.scholarName, // scholarName
    null, null, null, // unit / persona / perspective
    null, null, null, null, null, null, null, null, null, null, // process..directives..etc
    null, null, null, null, null, // activity/deliverable/verdicts/prior
    false, // isFirstTurn
    false, // isFirstSession
    null, // lastSessionAt
  );
}

export async function runTutor(c: TutorCase, sample: number): Promise<TutorRun> {
  const system = assemblePrompt(c);
  const messages = [
    ...(c.priorTurns ?? []),
    { role: "user" as const, content: c.scholarMessage },
  ];
  try {
    const response = await anthropic.messages.create({
      model: MODELS.SONNET,
      max_tokens: 1024,
      system,
      messages,
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return { caseId: c.id, sample, text, systemPromptLen: system.length };
  } catch (e) {
    return {
      caseId: c.id,
      sample,
      text: null,
      error: e instanceof Error ? e.message : String(e),
      systemPromptLen: system.length,
    };
  }
}
