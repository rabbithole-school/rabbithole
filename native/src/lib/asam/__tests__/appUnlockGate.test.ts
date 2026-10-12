import { describe, expect, it, vi } from "vitest";

import { runAppReadyGate, type AppReadyGateDeps } from "../appUnlockGate";
import { READY_BUDGET_MS } from "../appUnlockPolicy";

const PROBE_INTERVAL_MS = 250;

/**
 * A scripted device + backend.
 *
 * `opens` is consumed one answer per `canOpen`, with the LAST entry repeating,
 * so a test describes an iPad catching up as a sequence of answers
 * (`[false, false, true]`) rather than by mocking a clock.
 *
 * Time advances deterministically: every `sleep(ms)` moves the fake clock by
 * exactly `ms`, so budget behavior is exercised without real waiting.
 */
function harness(
  opens: boolean[],
  over: Partial<AppReadyGateDeps> = {},
): {
  deps: AppReadyGateDeps;
  /** Every time the gate announced "this is now a wait". */
  waits: () => number;
  probes: () => number;
  nudges: () => number;
  elapsedMs: () => number;
} {
  let waitCount = 0;
  let now = 1_000_000;
  let probeCount = 0;
  let nudgeCount = 0;
  const started = now;

  const deps: AppReadyGateDeps = {
    canOpen: async () => {
      const answer = opens[Math.min(probeCount, opens.length - 1)] ?? false;
      probeCount += 1;
      return answer;
    },
    nudge: async () => {
      nudgeCount += 1;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    onWaiting: () => {
      waitCount += 1;
    },
    isCancelled: () => false,
    probeIntervalMs: PROBE_INTERVAL_MS,
    ...over,
  };

  return {
    deps,
    waits: () => waitCount,
    probes: () => probeCount,
    nudges: () => nudgeCount,
    elapsedMs: () => now - started,
  };
}

describe("runAppReadyGate — warm path", () => {
  it("opens on the first ask with NO backend call and NO sheet announced", async () => {
    // The overwhelming majority of taps. The projection converged long before
    // the scholar tapped, so the launch must cost exactly one local canOpenURL:
    // no nudge, no sleep, and — critically — no `onWaiting`, which is what
    // keeps a warm launch from flashing a modal for a frame.
    const h = harness([true]);

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "ready" });

    expect(h.probes()).toBe(1);
    expect(h.nudges()).toBe(0);
    expect(h.waits()).toBe(0);
    expect(h.elapsedMs()).toBe(0);
  });
});

describe("runAppReadyGate — cold path", () => {
  it("announces the wait ONCE, nudges ONCE, and launches the moment iOS flips", async () => {
    const h = harness([false, false, false, true]);

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "ready" });

    // Announced once for the whole wait — not re-announced per probe, which
    // would remount the sheet and restart its elapsed clock every 250ms.
    expect(h.waits()).toBe(1);
    // One nudge for the whole wait: it is a latency hint, and the reconciler is
    // the authority. Re-nudging every probe would be asking a converging
    // backend to converge harder.
    expect(h.nudges()).toBe(1);
    expect(h.probes()).toBe(4);
    // Three sleeps between the four probes — the launch does not sit out a
    // fourth interval after the answer arrives.
    expect(h.elapsedMs()).toBe(3 * PROBE_INTERVAL_MS);
  });

  it("nudges only AFTER iOS has said no — never speculatively", async () => {
    const order: string[] = [];
    const h = harness([false, true], {
      canOpen: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("probe");
          return false;
        })
        .mockImplementation(async () => {
          order.push("probe");
          return true;
        }),
      nudge: async () => {
        order.push("nudge");
      },
    });

    await runAppReadyGate(h.deps);

    expect(order).toEqual(["probe", "nudge", "probe"]);
  });

  it("does not let a nudge that NEVER SETTLES block the probe loop", async () => {
    // A Convex mutation issued while the socket is down does not reject — it
    // sits pending until the client reconnects. If the gate awaited it, an iPad
    // that became ready seconds later would never launch and the budget clock
    // would never run, so the retry dialog would never appear either.
    const h = harness([false, false, true], {
      nudge: () => new Promise<never>(() => {}),
    });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "ready" });
    expect(h.probes()).toBe(3);
  });

  it("still times out on schedule behind a wedged nudge", async () => {
    const h = harness([false], {
      nudge: () => new Promise<never>(() => {}),
      budgetMs: 1_000,
    });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "timeout" });
    expect(h.elapsedMs()).toBe(1_000);
  });

  it("keeps waiting when the nudge itself fails", async () => {
    // The nudge is latency-only: the reconciler's cron converges the device
    // regardless, so a transport failure must not turn a launch that is about
    // to succeed into a failure dialog.
    const h = harness([false, true], {
      nudge: async () => {
        throw new Error("network down");
      },
    });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "ready" });
  });
});

describe("runAppReadyGate — failure budget", () => {
  it("times out once the budget is spent, never claiming ready on elapsed time", async () => {
    const h = harness([false]);

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "timeout" });

    expect(h.elapsedMs()).toBeGreaterThanOrEqual(READY_BUDGET_MS);
    // The budget is a wait, not a grant: the gate probed the whole way and
    // still refused because iOS never agreed.
    expect(h.probes()).toBeGreaterThan(1);
  });

  it("honours a shortened budget", async () => {
    const h = harness([false], { budgetMs: 1_000 });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "timeout" });
    expect(h.elapsedMs()).toBe(1_000);
  });
});

describe("runAppReadyGate — fail closed", () => {
  it("treats a probe that THROWS as 'not open-able', never as permission", async () => {
    const h = harness([], {
      canOpen: async () => {
        throw new Error("Linking exploded");
      },
      budgetMs: 1_000,
    });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({ outcome: "timeout" });
    expect(h.nudges()).toBe(1);
  });
});

describe("runAppReadyGate — cancellation", () => {
  it("cancels before asking iOS anything", async () => {
    const h = harness([true], { isCancelled: () => true });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(h.probes()).toBe(0);
    expect(h.nudges()).toBe(0);
  });

  it("cancels mid-wait and stops probing", async () => {
    let cancelled = false;
    const h = harness([false], {
      isCancelled: () => cancelled,
      nudge: async () => {
        cancelled = true;
      },
    });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({
      outcome: "cancelled",
    });
    // The one entry probe, and nothing after the cancel landed.
    expect(h.probes()).toBe(1);
  });

  it("cancels between the sleep and the next probe", async () => {
    let probes = 0;
    let cancelled = false;
    const h = harness([false], {
      canOpen: async () => {
        probes += 1;
        return false;
      },
      sleep: async () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });

    await expect(runAppReadyGate(h.deps)).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(probes).toBe(1);
  });
});
