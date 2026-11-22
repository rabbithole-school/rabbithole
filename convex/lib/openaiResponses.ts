/**
 * Text generation through OpenAI's Responses API — today only the charm_model
 * code writer (GPT-6 Astra, lib/charmModelCode.ts). Runtime-agnostic (fetch
 * only); retries 429/5xx like the charm image path (lib/openaiRetry.ts).
 */

import { CHARM_MODEL_WRITER } from "./models";
import { postOpenAIWithRetry } from "./openaiRetry";
import type { OpenAIResponsesUsage } from "./usage";

type ResponsesBody = {
  output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>;
  usage?: OpenAIResponsesUsage;
};

/**
 * One instructions + input exchange. Returns the concatenated output text and
 * the raw usage, or null on any failure (no key, HTTP error, exhausted
 * retries). Usage comes back even when the text turns out to be unusable, so
 * the caller can record what it paid for.
 */
export async function openaiRespond(
  instructions: string,
  input: string,
  opts?: { effort?: "low" | "medium" | "high" },
): Promise<{
  text: string;
  usage: OpenAIResponsesUsage | null;
  model: typeof CHARM_MODEL_WRITER;
} | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[openaiResponses] OPENAI_API_KEY is not set");
    return null;
  }
  const model = CHARM_MODEL_WRITER;
  const data = (await postOpenAIWithRetry(
    "https://api.openai.com/v1/responses",
    apiKey,
    JSON.stringify({
      model,
      instructions,
      input,
      reasoning: { effort: opts?.effort ?? "medium" },
    }),
    "openaiResponses",
  )) as ResponsesBody | null;
  if (!data) return null;
  const text = (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  return { text, usage: data.usage ?? null, model };
}
