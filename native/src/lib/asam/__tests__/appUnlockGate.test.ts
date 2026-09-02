import { describe, expect, it } from "vitest";

import {
  runAppUnlockGate,
  type AppUnlockGateway,
  type AppUnlockTargetRef,
} from "../appUnlockGate";
import {
  OS_READY_BUDGET_MS,
  type AppUnlockStatus,
  type UnlockPhase,
} from "../appUnlockPolicy";

const TARGET: AppUnlockTargetRef = {
  externalAppId: "external_app_sheets",
  deviceId: "device-uuid",
  leaseToken: "lease-1",
};

const HOUR = 60 * 60 * 1_000;

type Call = "status" | "request";

function status(over: Partial<AppUnlockStatus> = {}): AppUnlockStatus {
  return {
    desiredState: "locked",
    availability: "locked",
    expiresAt: null,
    mdmAcceptedAt: null,
    expectedAvailableAt: null,
    ...over,
  };
}

const locked = status();
const inFlight = status({
  desiredState: "unlocked",
  availability: "mdm-patch-in-flight",
  expiresAt: HOUR,
});
const propagating = status({
  desiredState: "unlocked",
  availability: "mdm-accepted-propagating",
  expiresAt: HOUR,
  mdmAcceptedAt: 0,
  expectedAvailableAt: 15_000,
});
/** An iPad with no dedicated profile — the fleet's normal state. */
const notConfigured = status({ availability: "not-configured" });
const readyStatus = status({
  desiredState: "unlocked",
  availability: "expected-from-mdm-acceptance",
  expiresAt: HOUR,
  mdmAcceptedAt: 0,
  expectedAvailableAt: 0,
});

/**
 * A scripted backend. `statuses` is consumed one reading per `readStatus`, with
 * the last entry repeating, so a test describes an MDM round trip as a sequence
 * ("propagating, propagating, ready") with no timing of its own.
 */
function fakeGateway(options: {
  statuses: AppUnlockStatus[];
  requestResult?: AppUnlockStatus;
  throwOn?: Call;
}) {
  const calls: Call[] = [];
  const clocks: number[] = [];
  let index = 0;
  const next = (): AppUnlockStatus =>
    options.statuses[Math.min(index++, options.statuses.length - 1)]!;
  const gateway: AppUnlockGateway = {
    readStatus: async (_target, nowMs) => {
      calls.push("status");
      clocks.push(nowMs);
      if (options.throwOn === "status") throw new Error("network down");
      return next();
    },
    requestUnlock: async () => {
      calls.push("request");
      if (options.throwOn === "request") throw new Error("MDM rejected");
      return options.requestResult ?? next();
    },
  };
  return { gateway, calls, clocks };
}

/**
 * A virtual clock: `sleep` advances time instantly, so tests never wait.
 *
 * `canOpen` defaults to an iPad that has already applied the profile, so the
 * fail-closed OS gate is transparent unless a test scripts it otherwise.
 */
function harness(
  gateway: AppUnlockGateway,
  over: {
    cancelAfter?: number;
    /** Device answers, one per probe, last repeating. Default: always true. */
    canOpen?: boolean[];
    /** Make the device probe throw instead of answering. */
    canOpenThrows?: boolean;
  } = {},
) {
  let clock = 0;
  let checks = 0;
  let probes = 0;
  const phases: UnlockPhase[] = [];
  return {
    phases,
    elapsed: () => clock,
    probeCount: () => probes,
    deps: {
      gateway,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      onPhase: (phase: UnlockPhase) => {
        if (phases.at(-1) !== phase) phases.push(phase);
      },
      isCancelled: () => {
        checks++;
        return over.cancelAfter !== undefined && checks > over.cancelAfter;
      },
      canOpen: async () => {
        probes++;
        if (over.canOpenThrows) throw new Error("scheme not queryable");
        const scripted = over.canOpen;
        if (!scripted) return true;
        return scripted[Math.min(probes - 1, scripted.length - 1)] ?? true;
      },
      budgetMs: 50_000,
    },
  };
}

/**
 * The FLEET path, and the reason this outcome exists. Dynamic unlocking governs
 * only iPads carrying a per-device dedicated profile; every other managed iPad
 * is allowlisted permanently by the GROUP profile. Gating those launches on an
 * unlock that can never happen is what put "This iPad couldn't unlock LEGO
 * SPIKE" in front of a scholar whose tap would have worked untouched.
 */
describe("runAppUnlockGate — unmediated iPad", () => {
  it("bypasses on the first read: no unlock request, no poll, no device probe", async () => {
    const { gateway, calls } = fakeGateway({ statuses: [notConfigured] });
    const { deps, phases, probeCount, elapsed } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "not-configured",
    });
    // One read and nothing else. A `requestUnlock` here would ask the backend to
    // PATCH a dedicated profile that does not exist.
    expect(calls).toEqual(["status"]);
    // `canOpenURL` is the OTHER thing that must not run: the ordinary launch
    // path does its own open-failure handling, and a false here would convert a
    // working launch into a failure modal.
    expect(probeCount()).toBe(0);
    expect(elapsed()).toBe(0);
    expect(phases).toEqual([]);
  });

  it("resolves DIRECTLY when a poll discovers the binding is gone — no failure modal", async () => {
    // A binding can vanish mid-launch (an operator reconfiguring the profile, a
    // claim removed). `decideUnlockPoll` would read that as a plain relock and
    // say `failed`, which is a failure modal plus a manual Try again in front of
    // a launch that needs no unlock at all. One exit, whichever read finds it.
    const { gateway, calls } = fakeGateway({
      statuses: [locked, propagating, notConfigured],
      requestResult: propagating,
    });
    const { deps, probeCount } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "not-configured",
    });
    // It got as far as one unlock request before the binding disappeared; the
    // discovery must not add a second, nor an OS probe.
    expect(calls.filter((call) => call === "request")).toHaveLength(1);
    expect(probeCount()).toBe(0);
  });

  it("bypasses on a RETRY after an earlier attempt failed, reporting no phase", async () => {
    // The provider's Try again re-invokes the gate. The sequence
    // failure → retry → unmediated must land on the same silent bypass as a
    // first attempt: the caller closes its modal on that ONE outcome, so a retry
    // that reported an unlock phase would leave "Unlocking…" wording behind on
    // an iPad this system does not mediate.
    const failing = fakeGateway({ statuses: [locked], throwOn: "status" });
    const failed = harness(failing.gateway);
    await expect(runAppUnlockGate(TARGET, failed.deps)).resolves.toEqual({
      outcome: "failed",
      reason: "failed",
      message: null,
    });

    const retry = fakeGateway({ statuses: [notConfigured] });
    const retried = harness(retry.gateway);
    await expect(runAppUnlockGate(TARGET, retried.deps)).resolves.toEqual({
      outcome: "not-configured",
    });
    expect(retried.phases).toEqual([]);
    expect(retry.calls).toEqual(["status"]);
    expect(retried.probeCount()).toBe(0);
  });

  it("withholds every phase until the iPad is known to be mediated", async () => {
    // The acknowledgment contract. The caller shows a NEUTRAL "Opening <app>…"
    // on the tap; only a gate-reported phase turns that into unlock wording. So
    // the unmediated path reporting no phase is what keeps that acknowledgment
    // honest — and the mediated paths still reach their own phases.
    const bypass = fakeGateway({ statuses: [notConfigured] });
    const bypassed = harness(bypass.gateway);
    await runAppUnlockGate(TARGET, bypassed.deps);
    expect(bypassed.phases).toEqual([]);

    const cold = fakeGateway({
      statuses: [locked, propagating, readyStatus],
      requestResult: propagating,
    });
    const run = harness(cold.gateway);
    await runAppUnlockGate(TARGET, run.deps);
    expect(run.phases[0]).toBe("asking");
  });

  it("still honours a cancel taken before the bypass is decided", async () => {
    const { gateway, calls } = fakeGateway({ statuses: [notConfigured] });
    const { deps } = harness(gateway, { cancelAfter: 0 });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(calls).toEqual(["status"]);
  });
});

describe("runAppUnlockGate — warm path", () => {
  it("launches on the first read with no unlock PATCH and no modal", async () => {
    const { gateway, calls } = fakeGateway({ statuses: [readyStatus] });
    const { deps, phases } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "ready",
      warm: true,
    });
    expect(calls).toEqual(["status", "request"]);
    // No phase was ever reported → the modal is never revealed on a warm tap.
    expect(phases).toEqual([]);
  });

  it("sends the client clock the backend validates against", async () => {
    const { gateway, clocks } = fakeGateway({ statuses: [readyStatus] });
    const { deps } = harness(gateway);

    await runAppUnlockGate(TARGET, deps);

    expect(clocks).toEqual([0]);
  });
});

describe("runAppUnlockGate — cold path", () => {
  it("requests once, then polls until the backend reports the change propagated", async () => {
    const { gateway, calls } = fakeGateway({
      statuses: [locked, propagating, propagating, readyStatus],
      requestResult: propagating,
    });
    const { deps, phases } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "ready",
      warm: false,
    });
    expect(calls.filter((call) => call === "request")).toHaveLength(1);
    expect(phases[0]).toBe("asking");
    expect(phases).toContain("waiting");
  });

  it("never treats 'accepted but propagating' as ready", async () => {
    const { gateway } = fakeGateway({
      statuses: [locked, propagating],
      requestResult: propagating,
    });
    const { deps } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "failed",
      reason: "timeout",
      message: null,
    });
  });

  it("joins an in-flight PATCH without issuing a redundant one", async () => {
    const { gateway, calls } = fakeGateway({ statuses: [inFlight, readyStatus] });
    const { deps, phases } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "ready",
      warm: false,
    });
    expect(calls.filter((call) => call === "request")).toHaveLength(1);
    expect(phases[0]).toBe("waiting");
  });

  it("re-requests when the lease is nearly spent", async () => {
    const nearlyExpired = status({
      desiredState: "unlocked",
      availability: "expected-from-mdm-acceptance",
      expiresAt: 5_000,
      mdmAcceptedAt: 0,
      expectedAvailableAt: 0,
    });
    const { gateway, calls } = fakeGateway({
      statuses: [nearlyExpired],
      requestResult: readyStatus,
    });
    const { deps } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "ready",
      warm: false,
    });
    expect(calls).toContain("request");
  });
});

describe("runAppUnlockGate — failure", () => {
  it("reports an MDM failure as retryable, with no raw error text", async () => {
    const { gateway } = fakeGateway({
      statuses: [locked],
      requestResult: status({ availability: "mdm-error" }),
    });
    const { deps } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "failed",
      reason: "failed",
      message: null,
    });
  });

  it("fails rather than waiting when another app took the unlock slot", async () => {
    const { gateway } = fakeGateway({
      statuses: [inFlight, locked],
    });
    const { deps } = harness(gateway);

    const result = await runAppUnlockGate(TARGET, deps);

    expect(result).toEqual({ outcome: "failed", reason: "failed", message: null });
  });

  it("turns a thrown transport error into a retryable failure", async () => {
    const { gateway } = fakeGateway({ statuses: [locked], throwOn: "status" });
    const { deps } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "failed",
      reason: "failed",
      message: null,
    });
  });

  it("does not escape when the unlock request itself throws", async () => {
    const { gateway } = fakeGateway({ statuses: [locked], throwOn: "request" });
    const { deps } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "failed",
      reason: "failed",
      message: null,
    });
  });

  it("gives up inside the budget instead of polling forever", async () => {
    const { gateway } = fakeGateway({
      statuses: [locked, propagating],
      requestResult: propagating,
    });
    const { deps, elapsed } = harness(gateway);

    await runAppUnlockGate(TARGET, deps);

    expect(elapsed()).toBeLessThan(60_000);
  });
});

describe("runAppUnlockGate — cancellation", () => {
  it("unwinds at the first await point once cancelled, never reaching ready", async () => {
    const { gateway } = fakeGateway({
      statuses: [locked, propagating, propagating, readyStatus],
      requestResult: propagating,
    });
    const { deps } = harness(gateway, { cancelAfter: 1 });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "cancelled",
    });
  });

  it("cancels before any unlock is requested when the tap is abandoned early", async () => {
    const { gateway, calls } = fakeGateway({ statuses: [locked] });
    const { deps } = harness(gateway, { cancelAfter: 0 });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(calls).toEqual(["status"]);
  });
});

describe("runAppUnlockGate — side effects", () => {
  it("has exactly two ways to touch the backend, and neither locks anything", () => {
    const { gateway } = fakeGateway({ statuses: [readyStatus] });

    expect(Object.keys(gateway).sort()).toEqual(["readStatus", "requestUnlock"]);
  });
});

/**
 * The fail-closed OS gate. MDM acceptance is a control-plane fact; only
 * `canOpenURL` is this iPad's own answer, and both managed schemes are declared
 * in LSApplicationQueriesSchemes so a `false` is meaningful. "Ready" is the ONLY
 * result the caller acts on — it is what releases ASAM and opens the URL — so
 * these tests are the proof that a `false` or a throw can never get there.
 */
describe("runAppUnlockGate — device readiness is fail-closed", () => {
  it("does not report ready while the iPad still refuses the scheme (cold)", async () => {
    const { gateway } = fakeGateway({
      statuses: [locked],
      requestResult: readyStatus,
    });
    const { deps, phases } = harness(gateway, { canOpen: [false] });

    const result = await runAppUnlockGate(TARGET, deps);

    // Not ready → the caller never releases ASAM and never opens the URL.
    expect(result).toEqual({
      outcome: "failed",
      reason: "os-unavailable",
      message: null,
    });
    expect(result).not.toMatchObject({ outcome: "ready" });
    // The scholar was told what was happening rather than left on a spinner.
    expect(phases).toContain("confirming");
  });

  it("does not report ready when the backend says unlocked but the iPad has not applied it (warm)", async () => {
    const { gateway, calls } = fakeGateway({ statuses: [readyStatus] });
    const { deps } = harness(gateway, { canOpen: [false] });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "failed",
      reason: "os-unavailable",
      message: null,
    });
    // A false warm status must not silently re-PATCH either.
    expect(calls).toEqual(["status"]);
  });

  it("treats a throwing device probe as not-ready, never as permission to launch", async () => {
    const { gateway } = fakeGateway({ statuses: [readyStatus] });
    const { deps } = harness(gateway, { canOpenThrows: true });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "failed",
      reason: "os-unavailable",
      message: null,
    });
  });

  it("reports ready as soon as the iPad agrees, after refusing at first", async () => {
    const { gateway } = fakeGateway({ statuses: [readyStatus] });
    const { deps, phases, probeCount } = harness(gateway, {
      canOpen: [false, false, true],
    });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "ready",
      warm: true,
    });
    expect(probeCount()).toBe(3);
    expect(phases).toEqual(["confirming"]);
  });

  it("keeps the ordinary warm tap flash-free — one probe, no phase, no modal", async () => {
    const { gateway, calls } = fakeGateway({ statuses: [readyStatus] });
    const { deps, phases, probeCount } = harness(gateway);

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "ready",
      warm: true,
    });
    expect(probeCount()).toBe(1);
    // Nothing reported → the caller's grace timer never fires → no modal flash.
    expect(phases).toEqual([]);
    expect(calls).toEqual(["status", "request"]);
  });

  it("gives up on the device probe within its own budget rather than spinning forever", async () => {
    const { gateway } = fakeGateway({ statuses: [readyStatus] });
    const { deps, elapsed } = harness(gateway, { canOpen: [false] });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toMatchObject({
      reason: "os-unavailable",
    });
    expect(elapsed()).toBeGreaterThanOrEqual(OS_READY_BUDGET_MS);
    expect(elapsed()).toBeLessThan(OS_READY_BUDGET_MS + 2_000);
  });

  it("honours a cancel taken while waiting on the device", async () => {
    const { gateway } = fakeGateway({ statuses: [readyStatus] });
    const { deps } = harness(gateway, { canOpen: [false], cancelAfter: 2 });

    await expect(runAppUnlockGate(TARGET, deps)).resolves.toEqual({
      outcome: "cancelled",
    });
  });
});
