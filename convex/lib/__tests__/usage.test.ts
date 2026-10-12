import { describe, expect, test } from "vitest";
import {
  addDeltaOutput,
  addStartUsage,
  emptyUsage,
  hasUsage,
  normalizeAnthropicUsage,
} from "../usage";

describe("normalizeAnthropicUsage", () => {
  test("maps Anthropic fields including the 1-hour cache-write subset", () => {
    expect(
      normalizeAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_creation: {
          ephemeral_5m_input_tokens: 18,
          ephemeral_1h_input_tokens: 12,
        },
        cache_read_input_tokens: 20,
      }),
    ).toEqual({
      inputTokens: 100,
      cacheWriteTokens: 30,
      cacheWrite1hTokens: 12,
      cacheReadTokens: 20,
      outputTokens: 50,
    });
  });

  test("missing cache-creation breakdown leaves the 1-hour subset at zero", () => {
    expect(
      normalizeAnthropicUsage({ cache_creation_input_tokens: 30 }),
    ).toEqual({
      ...emptyUsage(),
      cacheWriteTokens: 30,
    });
  });

  test("clamps the 1-hour subset to total cache writes", () => {
    expect(
      normalizeAnthropicUsage({
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_1h_input_tokens: 45 },
      }),
    ).toEqual({
      ...emptyUsage(),
      cacheWriteTokens: 30,
      cacheWrite1hTokens: 30,
    });
  });

  test("null / missing / negative coerce to zero", () => {
    expect(normalizeAnthropicUsage(null)).toEqual(emptyUsage());
    expect(normalizeAnthropicUsage(undefined)).toEqual(emptyUsage());
    expect(
      normalizeAnthropicUsage({ input_tokens: -5, output_tokens: null }),
    ).toEqual(emptyUsage());
  });
});

describe("streaming accumulation", () => {
  test("addStartUsage takes input+cache but NOT output (avoids double-count)", () => {
    const acc = emptyUsage();
    addStartUsage(acc, {
      input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_1h_input_tokens: 4 },
      cache_read_input_tokens: 5,
      output_tokens: 999, // must be ignored — output arrives via message_delta
    });
    expect(acc).toEqual({
      inputTokens: 100,
      cacheWriteTokens: 10,
      cacheWrite1hTokens: 4,
      cacheReadTokens: 5,
      outputTokens: 0,
    });
  });

  test("addStartUsage treats a missing breakdown as zero and clamps the subset", () => {
    const acc = emptyUsage();
    addStartUsage(acc, { cache_creation_input_tokens: 8 });
    addStartUsage(acc, {
      cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_1h_input_tokens: 9 },
    });
    expect(acc.cacheWriteTokens).toBe(10);
    expect(acc.cacheWrite1hTokens).toBe(2);
  });

  test("addDeltaOutput accumulates output only", () => {
    const acc = emptyUsage();
    addDeltaOutput(acc, 20);
    addDeltaOutput(acc, 5);
    expect(acc.outputTokens).toBe(25);
    expect(acc.inputTokens).toBe(0);
  });

  test("a full stream sums each message's prefill + all output deltas", () => {
    const acc = emptyUsage();
    // message 1
    addStartUsage(acc, { input_tokens: 100, cache_read_input_tokens: 40 });
    addDeltaOutput(acc, 30);
    // message 2 (tool loop continuation — its own prefill)
    addStartUsage(acc, { input_tokens: 120, cache_read_input_tokens: 200 });
    addDeltaOutput(acc, 45);
    expect(acc).toEqual({
      inputTokens: 220,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 240,
      outputTokens: 75,
    });
  });
});

describe("hasUsage", () => {
  test("false for all-zero, true when any dimension is set", () => {
    expect(hasUsage(emptyUsage())).toBe(false);
    expect(hasUsage({ ...emptyUsage(), outputTokens: 1 })).toBe(true);
    expect(hasUsage({ ...emptyUsage(), cacheReadTokens: 1 })).toBe(true);
  });
});
