import { describe, expect, it, vi } from "vitest";

import {
  MAX_OUTBOX_RETRY_DELAY_MS,
  outboxRetryDelayMs,
  PRACTICE_SUBMIT_TIMEOUT_MS,
  withPracticeSubmitTimeout,
} from "../practiceOutboxRetry";

describe("practice outbox retry", () => {
  it("backs off failed drains with a bounded delay", () => {
    expect(outboxRetryDelayMs(0)).toBe(1_000);
    expect(outboxRetryDelayMs(2)).toBe(2_000);
    expect(outboxRetryDelayMs(6)).toBe(MAX_OUTBOX_RETRY_DELAY_MS);
  });

  it("times out a hung submission", async () => {
    vi.useFakeTimers();
    const result = withPracticeSubmitTimeout(new Promise<never>(() => {}));
    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(PRACTICE_SUBMIT_TIMEOUT_MS);
    await rejection;
    vi.useRealTimers();
  });

  it("clears its timer after success", async () => {
    vi.useFakeTimers();
    await expect(withPracticeSubmitTimeout(Promise.resolve("ok"))).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
