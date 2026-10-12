/**
 * runAideStream × extended thinking: the staff reasoning accordion only fills
 * if the REQUEST asks Fable for summarized thinking, and the monologue only
 * leaves the server on a `streamThinking` surface.
 */
import { describe, expect, test } from "vitest";
import { runAideStream, type AideStreamConfig } from "../lib/aideStream";
import { MODELS } from "../lib/models";

type Params = Record<string, unknown>;

/** One scripted assistant message per toolRunner call. */
function fakeAnthropic(scripts: Array<{ refuse?: boolean }>) {
  const calls: Params[] = [];
  const toolRunner = (params: Params) => {
    const script = scripts[calls.length] ?? {};
    calls.push(params);
    const events = [
      {
        type: "message_start",
        message: { model: params.model, usage: { input_tokens: 1, output_tokens: 0 } },
      },
      ...(script.refuse
        ? []
        : [
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weighing it." } },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
          ]),
      {
        type: "message_delta",
        delta: { stop_reason: script.refuse ? "refusal" : "end_turn" },
        usage: { output_tokens: 5 },
      },
    ];
    const messageStream = {
      abort() {},
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield messageStream;
      },
    };
  };
  return { anthropic: { beta: { messages: { toolRunner } } }, calls };
}

async function run(
  model: string,
  streamThinking: boolean | undefined,
  scripts: Array<{ refuse?: boolean }> = [{}],
) {
  const { anthropic, calls } = fakeAnthropic(scripts);
  const res = runAideStream({
    anthropic: anthropic as unknown as AideStreamConfig["anthropic"],
    model: model as AideStreamConfig["model"],
    maxTokens: 1000,
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    persist: async () => null,
    finalize: async () => null,
    label: "test",
    streamThinking,
  });
  const events = (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  return { calls, events };
}

describe("runAideStream thinking", () => {
  test.each([MODELS.OPUS_5_5, MODELS.FABLE])(
    "staff surface on %s requests summarized thinking and streams it",
    async (model) => {
      const { calls, events } = await run(model, true);
      expect(calls[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(events).toContainEqual({ thinkingStart: { textOffset: 0 } });
      expect(events).toContainEqual({ thinkingText: "Weighing it." });
    },
  );

  test("non-staff surface sends no thinking param and never streams the monologue", async () => {
    const { calls, events } = await run(MODELS.FABLE, false);
    expect(calls[0]).not.toHaveProperty("thinking");
    expect(events).toContainEqual({ thinking: true });
    expect(events.some((e) => "thinkingText" in e || "thinkingStart" in e)).toBe(false);
  });

  test("the Opus 4.8 refusal-retry omits the thinking param", async () => {
    const { calls } = await run(MODELS.OPUS_5_5, true, [{ refuse: true }, {}]);
    expect(calls.map((c) => c.model)).toEqual([MODELS.OPUS_5_5, MODELS.OPUS]);
    expect(calls[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(calls[1]).not.toHaveProperty("thinking");
  });
});
