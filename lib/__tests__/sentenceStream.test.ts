import { describe, expect, test } from "vitest";
import {
  SentenceAccumulator,
  stripMarkdownForSpeech,
} from "../sentenceStream";

describe("SentenceAccumulator", () => {
  test("emits a sentence once its boundary arrives", () => {
    const acc = new SentenceAccumulator();
    expect(acc.push("Aloha Kai! Wha")).toEqual(["Aloha Kai!"]);
    expect(acc.push("t are you curious about today? Let")).toEqual([
      "What are you curious about today?",
    ]);
    expect(acc.flush()).toBe("Let");
  });

  test("does not emit mid-stream without a boundary", () => {
    const acc = new SentenceAccumulator();
    expect(acc.push("This sentence never ends and keeps going")).toEqual([]);
    expect(acc.flush()).toBe("This sentence never ends and keeps going");
  });

  test("end of input is not a boundary until flush", () => {
    const acc = new SentenceAccumulator();
    // Ends with "." but no trailing whitespace — could be "3.14" mid-stream.
    expect(acc.push("The answer might be 42.")).toEqual([]);
    expect(acc.flush()).toBe("The answer might be 42.");
  });

  test("short fragments ride along instead of flushing alone", () => {
    const acc = new SentenceAccumulator();
    // "1. " looks like a boundary but is way under the minimum length.
    const out = acc.push("1. Mix the flour with the water until smooth. ");
    expect(out).toEqual(["1. Mix the flour with the water until smooth."]);
  });

  test("newlines act as boundaries", () => {
    const acc = new SentenceAccumulator();
    const out = acc.push("Here is a thought without a period\nAnd another line. ");
    expect(out[0]).toBe("Here is a thought without a period");
  });

  test("multi-delta accumulation across pushes", () => {
    const acc = new SentenceAccumulator();
    const all: string[] = [];
    for (const delta of ["Wha", "t a great ", "question! Let me think ", "about it. "]) {
      all.push(...acc.push(delta));
    }
    expect(all).toEqual(["What a great question!", "Let me think about it."]);
    expect(acc.flush()).toBeNull();
  });
});

describe("stripMarkdownForSpeech", () => {
  test("strips bold, headers, links, bullets", () => {
    expect(
      stripMarkdownForSpeech("## Plan\n- **Mix** the [flour](http://x)\n- Bake"),
    ).toBe("Plan. Mix the flour. Bake");
  });

  test("drops fenced code, keeps inline code text", () => {
    expect(stripMarkdownForSpeech("Use `let` here.\n```js\nconst x = 1;\n```")).toBe(
      "Use let here.",
    );
  });
});
