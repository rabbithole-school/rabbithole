import { describe, expect, it } from "vitest";
import {
  readTutorSse,
  TUTOR_STREAM_ENDED_EARLY,
  type TutorStreamEvent,
} from "../tutorSse";

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

const sse = (event: TutorStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;

async function collect(chunks: string[]) {
  const events: TutorStreamEvent[] = [];
  const completed = await readTutorSse(readerOf(chunks), (event) => {
    events.push(event);
  });
  return { completed, events };
}

describe("readTutorSse", () => {
  it("completes on a done event", async () => {
    const { completed, events } = await collect([
      sse({ text: "Hi" }),
      sse({ done: true }),
    ]);
    expect(completed).toBe(true);
    expect(events).toEqual([{ text: "Hi" }, { done: true }]);
  });

  it("fails a stream that ends early through a synthetic error event", async () => {
    const { completed, events } = await collect([sse({ text: "Half a th" })]);
    expect(completed).toBe(false);
    expect(events).toEqual([
      { text: "Half a th" },
      { error: TUTOR_STREAM_ENDED_EARLY },
    ]);
  });

  it("does not double a server error", async () => {
    const { completed, events } = await collect([sse({ error: "Stream error" })]);
    expect(completed).toBe(false);
    expect(events).toEqual([{ error: "Stream error" }]);
  });

  it("completes when the done event is split across chunks", async () => {
    const whole = sse({ done: true });
    const { completed } = await collect([whole.slice(0, 9), whole.slice(9)]);
    expect(completed).toBe(true);
  });

  it("stops reading when the handler asks to", async () => {
    const seen: TutorStreamEvent[] = [];
    const completed = await readTutorSse(
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
