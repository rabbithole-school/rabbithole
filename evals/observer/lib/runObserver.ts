/**
 * Runs the PRODUCTION observer against a transcript under a chosen model.
 *
 * Imports the exact system prompt, request builder (tool, tool_choice,
 * max_tokens, effort), no-call retry, and user-message builder the live
 * observer uses (`convex/prompts.ts` + `convex/lib/observerShared.ts`), so what
 * the eval scores is what actually ships — not a paraphrase.
 */
import Anthropic from "@anthropic-ai/sdk";
import { OBSERVER_SYSTEM_PROMPT } from "../../../convex/prompts";
import {
  buildObserverRequest,
  buildObserverUserMessage,
  createObserverMessage,
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
  /** Unparsed API responses, including any no-tool-call retry. */
  responses: Array<Pick<Anthropic.Message, "id" | "model" | "stop_reason" | "usage" | "content">>;
  maxTokens: number;
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
  const request = buildObserverRequest({
    model,
    system: OBSERVER_SYSTEM_PROMPT,
    userContent: userMessage,
  });
  const responses: ObserverRun["responses"] = [];
  const usage = { input: 0, output: 0 };
  const diagnostics = { responses, usage, maxTokens: request.max_tokens };
  try {
    // Eval-only effort sweep: OBSERVER_EFFORT_OVERRIDE=low|medium|high.
    const effort = process.env.OBSERVER_EFFORT_OVERRIDE as
      | "low"
      | "medium"
      | "high"
      | undefined;
    const response = await createObserverMessage(
      () =>
        anthropic.messages.create(
          effort ? { ...request, output_config: { effort } } : request,
        ),
      (r) => {
        responses.push({
          id: r.id,
          model: r.model,
          stop_reason: r.stop_reason,
          usage: r.usage,
          content: r.content,
        });
        usage.input += r.usage.input_tokens;
        usage.output += r.usage.output_tokens;
      },
    );
    const latencyMs = Date.now() - start;
    // Same parse + default-normalization the live observer applies.
    const result = parseObserverResponse(response.content);
    if (!result) {
      return {
        caseId: c.id,
        model,
        result: null,
        error: `no tool_use block (stop_reason: ${response.stop_reason})`,
        latencyMs,
        ...diagnostics,
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
        ...diagnostics,
      };
    }
    return {
      caseId: c.id,
      model,
      result: { ...result, pulse: result.pulse },
      latencyMs,
      ...diagnostics,
    };
  } catch (e) {
    return {
      caseId: c.id,
      model,
      result: null,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - start,
      ...diagnostics,
    };
  }
}
