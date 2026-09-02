import { describe, expect, it, vi } from "vitest";

import {
  BREAKER_LIFECYCLE_MAX_ATTEMPTS,
  breakerLifecycleEvent,
  recordedBreakerLifecycleOperations,
  retryBreakerLifecycleWrite,
} from "./practiceLifecycleRetry";

describe("breaker lifecycle retry", () => {
  it("retries one failed write with backoff and accepts exact durable evidence", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({
        recorded: true,
        lifecycle: { repairCompletedAt: 123 },
      });
    const wait = vi.fn(async (_delayMs: number) => {});

    await expect(
      retryBreakerLifecycleWrite({
        operation: "repairCompleted",
        write,
        wait,
      }),
    ).resolves.toEqual({ status: "recorded", attempts: 2 });
    expect(write).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(1_000);
  });

  it("stops after bounded failures without manufacturing semantic success", async () => {
    const write = vi.fn(async () => ({
      recorded: true,
      // The server can reject an out-of-order write while returning the prior
      // lifecycle. `recorded: true` alone is not evidence for this operation.
      lifecycle: { repairShownAt: 123 },
    }));
    const wait = vi.fn(async (_delayMs: number) => {});

    const outcome = await retryBreakerLifecycleWrite({
      operation: "repairCompleted",
      write,
      wait,
    });
    expect(outcome.status).toBe("retryable-failure");
    expect(outcome.attempts).toBe(BREAKER_LIFECYCLE_MAX_ATTEMPTS);
    expect(write).toHaveBeenCalledTimes(BREAKER_LIFECYCLE_MAX_ATTEMPTS);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([
      1_000,
      2_000,
    ]);
  });

  it("treats an already-recorded idempotent replay as success", async () => {
    const write = vi.fn(async () => ({
      recorded: true,
      lifecycle: { coachEscalatedAt: 456 },
    }));

    await expect(
      retryBreakerLifecycleWrite({
        operation: "coachEscalated",
        write,
      }),
    ).resolves.toEqual({ status: "recorded", attempts: 1 });
    expect(write).toHaveBeenCalledOnce();
  });

  it("projects exact lifecycle evidence in causal order", () => {
    expect(
      recordedBreakerLifecycleOperations({
        repairShownAt: 1,
        repairStartedAt: 2,
        repairCompletedAt: 3,
        coachEscalatedAt: 4,
      }),
    ).toEqual([
      "repairShown",
      "repairStarted",
      "repairCompleted",
      "coachEscalated",
    ]);
  });

  it("maps every command operation to the server event vocabulary", () => {
    expect([
      breakerLifecycleEvent("repairShown"),
      breakerLifecycleEvent("repairUnavailable"),
      breakerLifecycleEvent("repairStarted"),
      breakerLifecycleEvent("repairCompleted"),
      breakerLifecycleEvent("coachEscalated"),
      breakerLifecycleEvent("stopped"),
    ]).toEqual([
      "repair_shown",
      "repair_unavailable",
      "repair_started",
      "repair_completed",
      "coach_escalated",
      "stopped",
    ]);
  });
});
