import { describe, expect, test } from "vitest";
import {
  readAgentStream,
  STREAM_ENDED_EARLY,
  type StreamEvent,
} from "../useAgentStream";

/** A reader that yields each string as one chunk, then closes. */
function readerOf(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    async read() {
      if (index >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: encoder.encode(chunks[index++]) };
    },
  };
}

const sse = (event: StreamEvent) => `data: ${JSON.stringify(event)}\n\n`;

async function collect(chunks: string[]) {
  const events: StreamEvent[] = [];
  const completed = await readAgentStream(readerOf(chunks), (event) => {
    events.push(event);
  });
  return { completed, events };
}

describe("readAgentStream", () => {
  test("a stream that ends with done completes", async () => {
    const { completed, events } = await collect([
      sse({ text: "Hi" }),
      sse({ done: true }),
    ]);
    expect(completed).toBe(true);
    expect(events).toEqual([{ text: "Hi" }, { done: true }]);
  });

  test("a stream that ends early fails through a synthetic error event", async () => {
    const { completed, events } = await collect([sse({ text: "Half a th" })]);
    expect(completed).toBe(false);
    expect(events).toEqual([
      { text: "Half a th" },
      { error: STREAM_ENDED_EARLY },
    ]);
  });

  test("an empty stream fails", async () => {
    const { completed, events } = await collect([]);
    expect(completed).toBe(false);
    expect(events).toEqual([{ error: STREAM_ENDED_EARLY }]);
  });

  test("a server error is not doubled by the synthetic one", async () => {
    const { completed, events } = await collect([sse({ error: "Stream error" })]);
    expect(completed).toBe(false);
    expect(events).toEqual([{ error: "Stream error" }]);
  });

  test("a done event split across two chunks still completes", async () => {
    const whole = sse({ done: true });
    const { completed } = await collect([
      sse({ text: "Hi" }) + whole.slice(0, 9),
      whole.slice(9),
    ]);
    expect(completed).toBe(true);
  });

  test("a final event without a trailing newline is still read", async () => {
    const { completed } = await collect([`data: ${JSON.stringify({ done: true })}`]);
    expect(completed).toBe(true);
  });

  test("stops reading when the handler asks to", async () => {
    const seen: StreamEvent[] = [];
    const completed = await readAgentStream(
      readerOf([sse({ done: true }), sse({ text: "after" })]),
      (event) => {
        seen.push(event);
        return event.done === true;
      },
    );
    expect(completed).toBe(true);
    expect(seen).toEqual([{ done: true }]);
  });
});
