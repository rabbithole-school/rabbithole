/**
 * Runs the PRODUCTION observer against a transcript under a chosen model.
 *
 * Imports the exact system prompt, tool schema, and user-message builder the
 * live observer uses (`convex/prompts.ts` + `convex/lib/observerShared.ts`), so
 * what the eval scores is what actually ships — not a paraphrase.
 */
import Anthropic from "@anthropic-ai/sdk";
import { OBSERVER_SYSTEM_PROMPT } from "../../../convex/prompts";
import {
  OBSERVER_TOOL,
  buildObserverUserMessage,
  buildObserverTranscript,
  parseObserverResponse,
  type ObserverResult,
  type MasteryObservationDoc,
  type SeedDoc,
  type PendingSeedDoc,
  type SessionSignalDoc,
} from "../../../convex/lib/observerShared";

export interface TranscriptCase {
  id: string;
  title: string;
  scholarName: string | null;
  unitTitle: string | null;
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  /** Prior observer state to feed in (for supersession realism). Optional. */
  currentObservations?: MasteryObservationDoc[];
  activeSeeds?: SeedDoc[];
  /** Pending observer seeds with ids — refreshesSeedId dedup targets. */
  pendingSeeds?: PendingSeedDoc[];
  recentSignals?: SessionSignalDoc[];
  /** Hand-authored gold expectations (fixtures only). */
  expectations?: string[];
  traps?: string[];
  source: "fixture" | "dev";
}

export interface ObserverRun {
  caseId: string;
  model: string;
  result: ObserverResult | null;
  error?: string;
  latencyMs: number;
  usage: { input: number; output: number };
}

const anthropic = new Anthropic();

export async function runObserver(
  c: TranscriptCase,
  model: string
): Promise<ObserverRun> {
  // Same transcript shaping the live observer applies (SCHOLAR/TUTOR labels,
  // last-30-message window) — imported, not re-implemented, so the eval can't
  // drift from prod.
  const transcriptText = buildObserverTranscript(
    c.transcript.map((message, index) => ({
      ...message,
      id: `eval-message-${index + 1}`,
      sourceRole: message.role,
    })),
  );
  const userMessage = buildObserverUserMessage(
    transcriptText,
    c.currentObservations ?? [],
    c.activeSeeds ?? [],
    c.recentSignals ?? [],
    {
      scholarName: c.scholarName,
      scholarId: "eval-scholar",
      title: c.title,
      unitContext: c.unitTitle ? { title: c.unitTitle } : null,
    },
    c.pendingSeeds ?? [],
  );

  const start = Date.now();
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: OBSERVER_SYSTEM_PROMPT,
      tools: [OBSERVER_TOOL],
      tool_choice: { type: "tool", name: "record_observations" },
      messages: [{ role: "user", content: userMessage }],
    });
    const latencyMs = Date.now() - start;
    // Same parse + default-normalization the live observer applies.
    const result = parseObserverResponse(response.content);
    if (!result) {
      return {
        caseId: c.id,
        model,
        result: null,
        error: "no tool_use block",
        latencyMs,
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      };
    }
    if (!result.pulse) {
      // Degraded pulse — no usable summary. The scorer expects a real pulse, so
      // treat it as the unusable case (parity with the live observer, which
      // skips the pulse write here).
      return {
        caseId: c.id,
        model,
        result: null,
        error: "degraded pulse (no usable summary)",
        latencyMs,
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      };
    }
    return {
      caseId: c.id,
      model,
      result: { ...result, pulse: result.pulse },
      latencyMs,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  } catch (e) {
    return {
      caseId: c.id,
      model,
      result: null,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - start,
      usage: { input: 0, output: 0 },
    };
  }
}
