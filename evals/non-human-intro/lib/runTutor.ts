/**
 * Runs the PRODUCTION tutor against an opening scholar message, using the EXACT
 * system prompt the live streaming path assembles (`buildSystemPrompt` from
 * convex/sessionHelpers.ts). This is what lets the eval verify PR #38's
 * non-human-introduction behavior on the real artifact, not a paraphrase.
 *
 * The tutor runs on MODELS.SONNET (the live tutor model). The judge (judge.ts)
 * runs on Opus.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import { MODELS } from "../../../convex/lib/models";

export interface TutorCase {
  id: string;
  description: string;
  scholarName: string | null;
  readingLevel: string | null;
  isFirstTurn: boolean;
  isFirstSession: boolean;
  lastSessionAt: number | null;
  /** The scholar's message. "<start>" triggers the opening-greeting path. */
  scholarMessage: string;
  /** Ground truth: should this response disclose the tutor is an AI/non-human? */
  expectedDisclosure: boolean;
  /** Optional prior turns (for mid-session cases), oldest first. */
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

/** Assemble the real system prompt with only the params this eval varies. */
export function assemblePrompt(c: TutorCase): string {
  return buildSystemPrompt(
    null, // teacherWhisper
    c.readingLevel, // readingLevel
    c.scholarName, // scholarName
    null, null, null, // unit / persona / perspective
    null, null, null, null, null, null, null, null, null, null, // process..directives..etc
    null, null, null, null, null, // activity/deliverable/verdicts/prior
    c.isFirstTurn,
    c.isFirstSession,
    c.lastSessionAt,
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
