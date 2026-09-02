/**
 * The GPT-family (second-family) judge for cross-family verification.
 *
 * It re-scores a curriculum-sim session with the EXACT SAME rubric + tool schema
 * the Anthropic curriculum judge used, so the two families' scores are directly
 * comparable. To keep this fully independent of the (Anthropic-constructing)
 * evals/curriculum-sim/lib/judge.ts module — which builds `new Anthropic()` at
 * import time and would demand an ANTHROPIC key even for a dry run — we import the
 * canonical product-owned judge module.
 *
 * Structured output is FORCED (tool_choice pins the one function) at temperature 0,
 * mirroring the Anthropic forced-tool pattern so the shapes line up 1:1.
 *
 * Requires OPENAI_API_KEY (unless --dry-run, which uses stubSecondFamilyVerdict).
 */
import OpenAI from "openai";
import {
  JUDGE_RUBRIC,
  JUDGE_TOOL,
  formatSessionForJudge,
} from "../../../convex/lib/curriculumJudge";
import { NUMERIC_DIMS } from "./compare";
import type { SessionVerdict } from "../../curriculum-sim/lib/score";
import type { SessionResult, SimActivity } from "../../curriculum-sim/lib/types";

/**
 * The GPT-family judge model. A DIFFERENT family from the Opus curriculum judge is
 * the whole point (Finding 2). Override with OPENAI_JUDGE_MODEL. Default is a
 * current GPT-4o snapshot that supports strict function-calling / structured output.
 */
export const CROSS_FAMILY_JUDGE_MODEL =
  process.env.OPENAI_JUDGE_MODEL || "gpt-4o";

export const openaiTokens = { input: 0, output: 0 };

/**
 * Stable facade for tests and callers; both model families receive the exact
 * canonical payload.
 */
export function formatSession(activity: SimActivity, session: SessionResult): string {
  return formatSessionForJudge(
    activity,
    session.profile,
    session.turns,
    session.stopReason,
  );
}

/** Convert the shared Anthropic-style tool into an OpenAI strict function tool. */
function openaiTool(): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: JUDGE_TOOL.name,
      description: JUDGE_TOOL.description,
      // strict structured output: every property required + no extras. The shared
      // The canonical tool lists every field as required, so it qualifies as-is.
      strict: true,
      parameters: {
        type: "object",
        properties: JUDGE_TOOL.input_schema.properties,
        required: [...JUDGE_TOOL.input_schema.required],
        additionalProperties: false,
      },
    },
  };
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Export it to run the real GPT-family judge, or pass --dry-run for a keyless structure demo.",
    );
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

/**
 * Re-judge ONE session with the GPT-family model, returning a SessionVerdict in the
 * same shape the Anthropic judge produces.
 */
export async function judgeSessionOpenAI(
  activity: SimActivity,
  session: SessionResult,
  model = CROSS_FAMILY_JUDGE_MODEL,
): Promise<SessionVerdict> {
  const completion = await client().chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: JUDGE_RUBRIC },
      { role: "user", content: formatSession(activity, session) },
    ],
    tools: [openaiTool()],
    tool_choice: { type: "function", function: { name: JUDGE_TOOL.name } },
  });

  const usage = completion.usage;
  openaiTokens.input += usage?.prompt_tokens ?? 0;
  openaiTokens.output += usage?.completion_tokens ?? 0;

  const call = completion.choices[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== "function") {
    throw new Error(`judgeSessionOpenAI: model returned no forced ${JUDGE_TOOL.name} call`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (e) {
    throw new Error(
      `judgeSessionOpenAI: could not parse tool arguments as JSON: ${(e as Error).message}\n--- raw ---\n${call.function.arguments.slice(0, 1000)}`,
    );
  }
  return coerceVerdict(parsed);
}

const FREE_TEXT: (keyof SessionVerdict)[] = ["stallPoint", "promptAttribution", "summary"];

/**
 * Validate + coerce a parsed tool payload into a SessionVerdict: every numeric
 * dimension must be a finite number (clamped to the 1–5 rubric range), and the
 * three free-text fields must be strings. Fails loud on a missing dimension so a
 * half-written verdict can't silently skew the aggregate.
 */
export function coerceVerdict(parsed: unknown): SessionVerdict {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("coerceVerdict: expected a JSON object");
  }
  const rec = parsed as Record<string, unknown>;
  const out = {} as Record<string, unknown>;
  for (const dim of NUMERIC_DIMS) {
    const v = rec[dim];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`coerceVerdict: dimension "${dim}" is missing or not a number (got ${JSON.stringify(v)})`);
    }
    out[dim] = Math.max(1, Math.min(5, v));
  }
  for (const key of FREE_TEXT) {
    const v = rec[key];
    out[key] = typeof v === "string" ? v : "";
  }
  return out as unknown as SessionVerdict;
}

/**
 * DRY-RUN second-family stand-in — no API call, no key. A deliberately SKEPTICAL
 * stub: it reads the winner's Anthropic verdict a notch more conservatively on the
 * outcome claims (goalAttainment/deliverableReach), which is exactly the
 * cross-family divergence the literature predicts (a same-family judge over-reads
 * "understanding"; Findings 1 & 2). Deterministic — the report structure is
 * reproducible without touching the network.
 */
export function stubSecondFamilyVerdict(anthropic: SessionVerdict): SessionVerdict {
  const clamp = (n: number) => Math.max(1, Math.min(5, n));
  const measured = (value: number | undefined, fallback = 3) =>
    clamp(typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return {
    goalAttainment: clamp(anthropic.goalAttainment - 2),
    deliverableReach: clamp(anthropic.deliverableReach - 1),
    productiveStruggle: clamp(anthropic.productiveStruggle + 1),
    socratic: anthropic.socratic,
    cognitiveOffloading: clamp(anthropic.cognitiveOffloading - 1),
    noSpoilers: anthropic.noSpoilers,
    sycophancy: anthropic.sycophancy,
    ageFit: anthropic.ageFit,
    depth: anthropic.depth,
    complexity: clamp(anthropic.complexity - 1),
    abstraction: anthropic.abstraction,
    inquiry: anthropic.inquiry,
    authenticity: anthropic.authenticity,
    singleSpine: measured(anthropic.singleSpine),
    discoveryArc: measured(anthropic.discoveryArc),
    handsOnMission: measured(anthropic.handsOnMission),
    earnedPayoff: measured(anthropic.earnedPayoff),
    stallPoint: "[dry-run stub] not a real GPT judgement",
    promptAttribution: "none",
    summary: "[dry-run stub] second-family verdict simulated without an API call",
  };
}
