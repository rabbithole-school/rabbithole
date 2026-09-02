import { describe, expect, test } from "vitest";
import {
  INITIAL_RETRY_DELAY_MS,
  nextPendingPreviewRetryDelay,
  pendingPreviewRetryDelay,
} from "../messageLinkPreviewRetry";

describe("pending message link preview retries", () => {
  test("continues retrying a claim that remains pending past three seconds", () => {
    let retryAfterMs = 10_000;
    let retryDelay = INITIAL_RETRY_DELAY_MS;
    let elapsed = 0;
    let retries = 0;

    while (elapsed < 4_000) {
      const delay = pendingPreviewRetryDelay(retryAfterMs, retryDelay);
      expect(delay).toBeGreaterThan(0);
      elapsed += delay;
      retryAfterMs -= delay;
      retryDelay = nextPendingPreviewRetryDelay(retryDelay);
      retries += 1;
    }

    expect(retries).toBeGreaterThan(3);
    expect(pendingPreviewRetryDelay(retryAfterMs, retryDelay)).toBeGreaterThan(0);
  });

  test("uses a positive delay even when a skewed client receives an expired lease", () => {
    expect(pendingPreviewRetryDelay(0, 1_000)).toBe(100);
    expect(pendingPreviewRetryDelay(1, 1_000)).toBe(100);
  });
});
