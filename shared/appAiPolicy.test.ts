import { describe, expect, it } from "vitest";
import {
  MAX_APP_AI_CONTEXT_KEYS,
  MAX_APP_AI_CONTEXT_KEY_CHARS,
  MAX_APP_AI_CONTEXT_VALUE_CHARS,
  normalizeAppAiContext,
} from "./appAiPolicy";

describe("normalizeAppAiContext", () => {
  it("keeps identifier keys with string, finite number, and boolean values in order", () => {
    const context = normalizeAppAiContext({
      stage: 4,
      mode: "  rule  ",
      final: false,
      ratio: -0.5,
    });
    expect(context).toEqual({ stage: 4, mode: "rule", final: false, ratio: -0.5 });
    expect(Object.keys(context ?? {})).toEqual(["stage", "mode", "final", "ratio"]);
  });

  it("returns undefined for anything that is not a plain object, or is empty after filtering", () => {
    for (const value of [
      undefined,
      null,
      "stage: 4",
      4,
      true,
      ["stage"],
      new Date(),
      new Map([["stage", 4]]),
      {},
      { "": 1 },
      { stage: "   " },
    ]) {
      expect(normalizeAppAiContext(value)).toBeUndefined();
    }
    expect(normalizeAppAiContext(Object.assign(Object.create(null), { a: 1 }))).toEqual({
      a: 1,
    });
  });

  it("drops bad keys and unsupported values without dropping the rest", () => {
    expect(
      normalizeAppAiContext({
        "1stage": 1,
        "has space": 1,
        "with-dash": 1,
        _private: 1,
        [`k${"x".repeat(MAX_APP_AI_CONTEXT_KEY_CHARS)}`]: 1,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        nested: { a: 1 },
        list: [1, 2],
        nothing: null,
        missing: undefined,
        fn: () => 1,
        big: BigInt(10),
        ok_Key9: "yes",
      }),
    ).toEqual({ ok_Key9: "yes" });
    const longestKey = `k${"x".repeat(MAX_APP_AI_CONTEXT_KEY_CHARS - 1)}`;
    expect(normalizeAppAiContext({ [longestKey]: 1 })).toEqual({ [longestKey]: 1 });
  });

  it("collapses whitespace so a value stays one line, and clamps long strings", () => {
    expect(normalizeAppAiContext({ note: "a\n\nmode: rule\tb" })).toEqual({
      note: "a mode: rule b",
    });
    const clamped = normalizeAppAiContext({ note: "y".repeat(500) })?.note;
    expect(clamped).toHaveLength(MAX_APP_AI_CONTEXT_VALUE_CHARS);
  });

  it("keeps only the first valid entries up to the key cap", () => {
    const value: Record<string, unknown> = { bad: null };
    for (let index = 0; index < MAX_APP_AI_CONTEXT_KEYS + 4; index++) {
      value[`k${index}`] = index;
    }
    const context = normalizeAppAiContext(value);
    expect(Object.keys(context ?? {})).toEqual(
      Array.from({ length: MAX_APP_AI_CONTEXT_KEYS }, (_, index) => `k${index}`),
    );
  });

  it("carries a scene plus a seven-rule rulebook whole", () => {
    // Teach the robot sends { mode, stage, part, rule1…rule7 } on every call;
    // a dropped rule is a rule the character silently stops obeying.
    const value: Record<string, unknown> = { mode: "ask", stage: 7, part: "antenna" };
    for (let index = 1; index <= 7; index++) {
      value[`rule${index}`] = `r${index} `.padEnd(MAX_APP_AI_CONTEXT_VALUE_CHARS, "x");
    }
    expect(normalizeAppAiContext(value)).toEqual(value);
  });
});
