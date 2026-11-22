/**
 * runAideStream × a person's Stop: the in-app chats (staff aide, parent,
 * reflection) stop the run from a stamp on the message row. Aborting the
 * Anthropic request mid-reply can kill a Convex action before it finalizes
 * that row (seen live on the Slack path, 2026-11-08), so a stop reads the
 * rest of the message unseen, runs no further tool, and still finalizes.
 */
import { describe, expect, test } from "vitest";
import { runAideStream, type AideStreamConfig } from "../lib/aideStream";
import { MODELS } from "../lib/models";

type Event = Record<string, unknown>;
const start: Event = {
  type: "message_start",
  message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
};
const say = (text: string): Event => ({
  type: "content_block_delta",
  delta: { type: "text_delta", text },
});
const toolUse: Event = {
  type: "content_block_start",
  content_block: { type: "tool_use", name: "list_units" },
};
const usage = (output: number): Event => ({
  type: "message_delta",
  delta: { stop_reason: "tool_use" },
  usage: { output_tokens: output },
});

function fakeAnthropic(messages: Event[][]) {
  const seen = { aborted: 0, toolRan: false };
  const toolRunner = () => ({
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < messages.length; i++) {
        if (i > 0) seen.toolRan = true; // the SDK runs tools between messages
        yield {
          abort: () => {
            seen.aborted++;
          },
          async *[Symbol.asyncIterator]() {
            yield* messages[i];
          },
        };
      }
    },
  });
  return { anthropic: { beta: { messages: { toolRunner } } }, seen };
}

async function run(
  messages: Event[][],
  stopAfterPersists: number,
) {
  const { anthropic, seen } = fakeAnthropic(messages);
  let persists = 0;
  const finalized: Array<{ content: string; tokensUsed: number }> = [];
  const res = runAideStream({
    anthropic: anthropic as unknown as AideStreamConfig["anthropic"],
    model: MODELS.SONNET_5_5,
    maxTokens: 1000,
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    // The in-app routes answer each persist with whether Stop was pressed.
    persist: async () => ({ stopRequested: ++persists > stopAfterPersists }),
    finalize: async (r) => {
      finalized.push({ content: r.content, tokensUsed: r.tokensUsed });
      return null;
    },
    label: "test",
  });
  const events = (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  return { events, finalized, seen };
}

describe("runAideStream stop", () => {
  const long = "x".repeat(250); // past the 200-character persist cadence

  test("a stop mid-reply never aborts, runs no further tool, and still finalizes", async () => {
    const { events, finalized, seen } = await run(
      [
        [start, say(long), say("never shown"), toolUse, usage(9)],
        [start, say("Found none.")],
      ],
      0, // the first persist reports the stop
    );
    expect(seen.aborted).toBe(0);
    expect(seen.toolRan).toBe(false);
    const texts = events.filter((e) => "text" in e).map((e) => e.text);
    expect(texts).toEqual([long]);
    expect(events.some((e) => "toolStart" in e)).toBe(false);
    // The row is finalized with what was shown, and the read-out is billed.
    expect(finalized).toEqual([{ content: long, tokensUsed: 9 }]);
    expect(events.at(-1)).toEqual({ done: true, stopped: true });
  });

  test("a client that goes away mid-reply: no abort, no further tool, finalized once", async () => {
    // The model pauses mid-message while the reader cancels, then the rest of
    // the message arrives.
    let release: () => void = () => {};
    const paused = new Promise<void>((resolve) => (release = resolve));
    let finalizedOnce: () => void = () => {};
    const finalizedSignal = new Promise<void>((resolve) => (finalizedOnce = resolve));
    const seen = { aborted: 0, toolRan: false };
    const toolRunner = () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          abort: () => {
            seen.aborted++;
          },
          async *[Symbol.asyncIterator]() {
            yield start;
            yield say(long);
            await paused;
            yield say("never shown");
            yield toolUse;
            yield usage(9);
          },
        };
        seen.toolRan = true; // the SDK runs tools before the next message
        yield {
          abort: () => {},
          async *[Symbol.asyncIterator]() {
            yield start;
            yield say("Found none.");
          },
        };
      },
    });
    const finalized: Array<{ content: string; tokensUsed: number }> = [];
    const persisted: string[] = [];
    const res = runAideStream({
      anthropic: { beta: { messages: { toolRunner } } } as unknown as AideStreamConfig["anthropic"],
      model: MODELS.SONNET_5_5,
      maxTokens: 1000,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      persist: async (content) => {
        persisted.push(content);
        return null;
      },
      finalize: async (r) => {
        finalized.push({ content: r.content, tokensUsed: r.tokensUsed });
        finalizedOnce();
        return null;
      },
      label: "test",
    });
    const reader = res.body!.getReader();
    await reader.read(); // the first words arrive
    await reader.cancel(); // the client goes away
    release();
    await finalizedSignal;
    expect(seen.aborted).toBe(0);
    expect(seen.toolRan).toBe(false);
    expect(finalized).toEqual([{ content: long, tokensUsed: 9 }]);
    expect(persisted.every((p) => !p.includes("never shown"))).toBe(true);
  });

  test("with no stop, the run goes on through the tool", async () => {
    const { finalized, seen } = await run(
      [
        [start, say(long), toolUse, usage(9)],
        [start, say(" Found none.")],
      ],
      Infinity,
    );
    expect(seen.toolRan).toBe(true);
    expect(finalized[0].content).toBe(`${long}\n\nFound none.`);
  });
});
