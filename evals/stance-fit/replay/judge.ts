/**
 * The stance-fit judge, reused for one generated tutor turn.
 *
 * classify.ts exports nothing and runs its CLI on import, so it cannot be
 * imported. Rather than fork its label definitions (which would drift), this
 * reads classify.ts as TEXT and extracts SYSTEM_PROMPT and the three label
 * enums at runtime — one source of truth. If classify.ts is reshaped so the
 * extraction no longer matches, this throws loudly instead of judging with a
 * stale copy. Retire this shim once classify.ts exports
 * { SCHOLAR_STATES, TUTOR_MOVES, STANCE_FITS, SYSTEM_PROMPT, TOOL, buildPrompt,
 *   classifyTurn } and guards main() behind an entry-point check.
 *
 * The user-prompt format (buildJudgePrompt) mirrors classify.ts buildPrompt
 * line for line, so a replayed turn is judged exactly as a shipped turn is.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_MODEL } from "../../../convex/lib/models";
import type { Message, SessionData, Verdict } from "./lib";

const CLASSIFY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "classify.ts");

function extractArray(source: string, name: string): string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) throw new Error(`replay/judge: could not find ${name} in classify.ts`);
  const values = [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  if (values.length === 0) throw new Error(`replay/judge: ${name} in classify.ts is empty`);
  return values;
}

function extractSystemPrompt(source: string): string {
  const match = source.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!match) throw new Error("replay/judge: could not find SYSTEM_PROMPT in classify.ts");
  if (match[1].includes("${") || match[1].includes("\\")) {
    throw new Error("replay/judge: SYSTEM_PROMPT now has interpolation/escapes; extraction is unsafe");
  }
  return match[1];
}

const source = readFileSync(CLASSIFY_PATH, "utf8");
export const SCHOLAR_STATES = extractArray(source, "SCHOLAR_STATES");
export const TUTOR_MOVES = extractArray(source, "TUTOR_MOVES");
export const STANCE_FITS = extractArray(source, "STANCE_FITS");
export const SYSTEM_PROMPT = extractSystemPrompt(source);
export { JUDGE_MODEL };

// Same schema as classify.ts TOOL (built from the extracted enums).
const TOOL = {
  name: "record_stance_fit" as const,
  description: "Classify the scholar state, tutor move, and fit for one tutor turn.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["scholarState", "tutorMove", "stanceFit", "teachingSentences", "rationale"],
    properties: {
      scholarState: { type: "string" as const, enum: SCHOLAR_STATES },
      tutorMove: { type: "string" as const, enum: TUTOR_MOVES },
      stanceFit: { type: "string" as const, enum: STANCE_FITS },
      teachingSentences: {
        type: "integer" as const,
        minimum: 0,
        description: "Declarative sentences conveying content the scholar had not already said.",
      },
      rationale: { type: "string" as const, maxLength: 180, description: "At most 25 words." },
    },
  },
};

/** Fingerprint of everything that defines the judge, for A/B parity checks. */
export const JUDGE_PROMPT_SHA256 = createHash("sha256")
  .update(JSON.stringify({ model: JUDGE_MODEL, system: SYSTEM_PROMPT, tool: TOOL }))
  .digest("hex");

/** classify.ts buildPrompt, applied to prefix + one generated tutor turn. */
export function buildJudgePrompt(session: SessionData, prefix: Message[], generated: string) {
  const messages = [...prefix, { role: "assistant" as const, content: generated }];
  const turnIndex = messages.length - 1;
  const transcript = messages
    .map(
      (message, index) =>
        `${index === turnIndex ? "TARGET " : ""}${message.role.toUpperCase()}: ${message.content}`,
    )
    .join("\n\n");
  return [
    `Reading level: ${session.readingLevel ?? "(unspecified)"}`,
    `Unit: ${session.unitTitle ?? "(independent study)"}`,
    `Activity: ${session.activityTitle ?? "(unspecified)"}`,
    "",
    "Classify the final TARGET ASSISTANT turn using only the evidence available through that turn.",
    "",
    transcript,
  ].join("\n");
}

function assertVerdict(input: unknown): Verdict {
  const v = (input ?? {}) as Record<string, unknown>;
  if (!SCHOLAR_STATES.includes(v.scholarState as string)) throw new Error(`Invalid scholarState: ${String(v.scholarState)}`);
  if (!TUTOR_MOVES.includes(v.tutorMove as string)) throw new Error(`Invalid tutorMove: ${String(v.tutorMove)}`);
  if (!STANCE_FITS.includes(v.stanceFit as string)) throw new Error(`Invalid stanceFit: ${String(v.stanceFit)}`);
  if (typeof v.teachingSentences !== "number" || !Number.isInteger(v.teachingSentences) || v.teachingSentences < 0) {
    throw new Error("Invalid teachingSentences");
  }
  if (typeof v.rationale !== "string") throw new Error("Invalid rationale");
  return {
    scholarState: v.scholarState as string,
    tutorMove: v.tutorMove as string,
    stanceFit: v.stanceFit as string,
    teachingSentences: v.teachingSentences,
    rationale: v.rationale.trim().split(/\s+/).slice(0, 25).join(" "),
  };
}

const retryable = (error: unknown) =>
  /\b(429|500|502|503|504|529)\b|rate.?limit|overloaded|timeout|fetch failed|^Invalid |did not contain a tool call/i.test(
    error instanceof Error ? error.message : String(error),
  );

export async function judgeTurn(anthropic: Anthropic, prompt: string): Promise<Verdict> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content.find((item) => item.type === "tool_use");
      if (!block || block.type !== "tool_use") throw new Error("Judge response did not contain a tool call");
      return assertVerdict(block.input);
    } catch (error) {
      if (attempt === 4 || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw new Error("Judge exhausted retries");
}
