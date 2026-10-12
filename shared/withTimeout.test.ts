import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimeoutError, withTimeout } from "./withTimeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with a TimeoutError when the promise never settles", async () => {
    // A Convex call queued behind a dead socket: never resolves, never rejects.
    const hung = new Promise<never>(() => {});
    const result = withTimeout(hung, 25_000, "Couldn't reach Rabbithole");
    const settled = expect(result).rejects.toThrow(TimeoutError);

    await vi.advanceTimersByTimeAsync(24_999);
    let early = false;
    void result.catch(() => {
      early = true;
    });
    await Promise.resolve();
    expect(early).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await settled;
    await expect(result).rejects.toThrow("Couldn't reach Rabbithole");
  });

  it("passes through a value that arrives before the deadline", async () => {
    const result = withTimeout(Promise.resolve({ id: "s1" }), 25_000, "late");
    await expect(result).resolves.toEqual({ id: "s1" });
    // The deadline is cleared, so no stray timer is left behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes through the original error, not a timeout", async () => {
    const boom = new Error("Unit not found");
    const result = withTimeout(Promise.reject(boom), 25_000, "late");
    await expect(result).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a result that arrives after the deadline", async () => {
    let resolveLate!: (value: string) => void;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const result = withTimeout(late, 15_000, "timed out");
    const settled = expect(result).rejects.toThrow(TimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    resolveLate("too late");
    await expect(result).rejects.toThrow("timed out");
  });
});
