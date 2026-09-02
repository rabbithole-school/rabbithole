import { describe, expect, it, vi } from "vitest";

import {
  MAX_OUTBOX_RETRY_DELAY_MS,
  outboxRetryDelayMs,
  PRACTICE_SUBMIT_TIMEOUT_MS,
  withPracticeSubmitTimeout,
} from "./practiceOutboxRetry";

describe("practice outbox retry", () => {
  it("backs off failed drains with a bounded delay", () => {
    expect(outboxRetryDelayMs(1)).toBe(1_000);
    expect(outboxRetryDelayMs(2)).toBe(2_000);
    expect(outboxRetryDelayMs(6)).toBe(MAX_OUTBOX_RETRY_DELAY_MS);
    expect(outboxRetryDelayMs(100)).toBe(MAX_OUTBOX_RETRY_DELAY_MS);
  });

  it("never returns a zero delay, so a bad count can't spin", () => {
    // A caller that hasn't recorded a failure yet must still wait before the
    // next pass rather than busy-looping the drain.
    expect(outboxRetryDelayMs(0)).toBe(1_000);
    expect(outboxRetryDelayMs(-5)).toBe(1_000);
    expect(outboxRetryDelayMs(1.9)).toBe(1_000);
  });

  it("releases a buffered mutation after the bounded submit timeout", async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => {});
    const result = withPracticeSubmitTimeout(pending);
    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(PRACTICE_SUBMIT_TIMEOUT_MS);
    await rejection;
    vi.useRealTimers();
  });

  it("clears the timeout when a submission resolves", async () => {
    vi.useFakeTimers();
    await expect(withPracticeSubmitTimeout(Promise.resolve("recorded"))).resolves.toBe(
      "recorded",
    );
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("clears the timeout when a submission rejects", async () => {
    vi.useFakeTimers();
    await expect(
      withPracticeSubmitTimeout(Promise.reject(new Error("offline"))),
    ).rejects.toThrow("offline");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("exposes no phase-string helper — queued advance is read from typed state", async () => {
    // Guards the deliberate omission documented at the top of the module: an
    // earlier draft exported `queuedFeedbackCanAdvance(phase: string, busy)`,
    // which coupled this pure module to one surface's phase names.
    const mod = await import("./practiceOutboxRetry");
    expect(Object.keys(mod)).not.toContain("queuedFeedbackCanAdvance");
  });
});
