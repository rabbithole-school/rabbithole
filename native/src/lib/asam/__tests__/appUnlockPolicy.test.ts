import { describe, expect, it } from "vitest";

import {
  decideUnlockEntry,
  decideUnlockPoll,
  isLeaseWarm,
  isUnmediatedDevice,
  LEASE_SAFETY_MARGIN_MS,
  nextUnlockPollDelayMs,
  unlockAccessibilityLabel,
  claimUnlockHandoff,
  shouldHandBackUnlockLease,
  unlockFailedMessage,
  unlockFailedTitle,
  unlockHeadline,
  unlockEstimatedProgress,
  unlockProgressCopy,
  UNLOCK_BUDGET_MS,
  UNLOCK_PROGRESS_ESTIMATE_MS,
  UNLOCK_SLOW_AFTER_MS,
  type AppUnlockAvailability,
  type AppUnlockStatus,
} from "../appUnlockPolicy";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1_000;

/** A status reading, defaulting to the backend's "nothing requested" shape. */
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

/** An iPad with no dedicated profile — the unlock system does not govern it. */
function unmediated(): AppUnlockStatus {
  return status({ availability: "not-configured" });
}

/** The backend's terminal "the iPad should have it now" reading. */
function ready(expiresAt: number): AppUnlockStatus {
  return status({
    desiredState: "unlocked",
    availability: "expected-from-mdm-acceptance",
    expiresAt,
    mdmAcceptedAt: NOW - 20_000,
    expectedAvailableAt: NOW - 5_000,
  });
}

describe("isLeaseWarm", () => {
  it("is warm only while the lease has more than the safety margin left", () => {
    expect(isLeaseWarm(ready(NOW + LEASE_SAFETY_MARGIN_MS + 1_000), NOW)).toBe(true);
  });

  it("treats a lease about to expire as cold, so nobody launches into a relock", () => {
    expect(isLeaseWarm(ready(NOW + LEASE_SAFETY_MARGIN_MS - 1), NOW)).toBe(false);
  });

  it("is not warm while the MDM change is still propagating", () => {
    const propagating = status({
      desiredState: "unlocked",
      availability: "mdm-accepted-propagating",
      expiresAt: NOW + HOUR,
      mdmAcceptedAt: NOW,
      expectedAvailableAt: NOW + 15_000,
    });
    expect(isLeaseWarm(propagating, NOW)).toBe(false);
  });

  it("is never warm for a locked device state, whatever the availability says", () => {
    const availabilities: AppUnlockAvailability[] = [
      "locked",
      "expired-awaiting-reconcile",
      "mdm-error",
      "awaiting-mdm-acceptance",
    ];
    for (const availability of availabilities) {
      expect(
        isLeaseWarm(
          status({ desiredState: "locked", availability, expiresAt: NOW + HOUR }),
          NOW,
        ),
      ).toBe(false);
    }
  });
});

describe("decideUnlockEntry", () => {
  it("WARM: a live lease launches now — no modal, no redundant unlock PATCH", () => {
    expect(decideUnlockEntry(ready(NOW + HOUR), NOW)).toBe("launch-now");
  });

  it("COLD: a locked app requests an unlock", () => {
    expect(decideUnlockEntry(status(), NOW)).toBe("request-unlock");
  });

  it("joins a PATCH already in flight instead of issuing a second one", () => {
    for (const availability of [
      "mdm-patch-in-flight",
      "awaiting-mdm-acceptance",
      "mdm-accepted-propagating",
    ] as const) {
      const inFlight = status({
        desiredState: "unlocked",
        availability,
        expiresAt: NOW + HOUR,
      });
      expect(decideUnlockEntry(inFlight, NOW)).toBe("await-unlock");
    }
  });

  it("waits out an in-flight LOCK rather than racing it with an unlock", () => {
    const locking = status({
      desiredState: "locked",
      availability: "mdm-patch-in-flight",
    });
    expect(decideUnlockEntry(locking, NOW)).toBe("await-unlock");
  });

  it("retries after a failed PATCH", () => {
    expect(decideUnlockEntry(status({ availability: "mdm-error" }), NOW)).toBe(
      "request-unlock",
    );
  });

  it("re-requests when the lease lapsed but the relock has not caught up", () => {
    const expired = status({
      availability: "expired-awaiting-reconcile",
      expiresAt: NOW - 1_000,
    });
    expect(decideUnlockEntry(expired, NOW)).toBe("request-unlock");
  });

  it("refreshes an almost-expired lease rather than launching into it", () => {
    expect(decideUnlockEntry(ready(NOW + 1_000), NOW)).toBe("request-unlock");
  });

  it("bypasses entirely for an iPad this system does not mediate", () => {
    expect(decideUnlockEntry(unmediated(), NOW)).toBe("launch-unmediated");
  });

  it("bypasses on availability alone, never on the neutral lease fields", () => {
    // The backend sends `desiredState: "locked"` with no expiry alongside
    // not-configured. Reading that as lease state would classify the whole fleet
    // as COLD and send every launch into an unlock that cannot exist.
    expect(
      decideUnlockEntry(
        status({
          availability: "not-configured",
          desiredState: "unlocked",
          expiresAt: NOW + HOUR,
        }),
        NOW,
      ),
    ).toBe("launch-unmediated");
  });
});

/**
 * The fleet's normal state. Dynamic unlocking governs only iPads with a
 * per-device dedicated profile; every other managed iPad is allowlisted
 * permanently by the GROUP profile, so its launches must not be gated on an
 * unlock that will never happen.
 */
describe("isUnmediatedDevice", () => {
  it("is true only for the backend's not-configured reading", () => {
    expect(isUnmediatedDevice(unmediated())).toBe(true);
    for (const availability of [
      "locked",
      "expired-awaiting-reconcile",
      "mdm-error",
      "mdm-patch-in-flight",
      "awaiting-mdm-acceptance",
      "expected-from-mdm-acceptance",
      "mdm-accepted-propagating",
    ] as const) {
      expect(isUnmediatedDevice(status({ availability }))).toBe(false);
    }
  });

  it("is not a warm lease — there is nothing to launch into or hand back", () => {
    expect(
      isLeaseWarm(
        status({
          availability: "not-configured",
          desiredState: "unlocked",
          expiresAt: NOW + HOUR,
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("decideUnlockPoll", () => {
  const fresh = { elapsedMs: 0, budgetMs: 30_000 };

  it("is ready ONLY on the backend's terminal unlocked reading", () => {
    expect(decideUnlockPoll(ready(NOW + HOUR), fresh)).toBe("ready");
  });

  it("keeps waiting through acceptance and propagation", () => {
    for (const availability of [
      "awaiting-mdm-acceptance",
      "mdm-accepted-propagating",
      "mdm-patch-in-flight",
    ] as const) {
      expect(
        decideUnlockPoll(
          status({ desiredState: "unlocked", availability, expiresAt: NOW + HOUR }),
          fresh,
        ),
      ).toBe("waiting");
    }
  });

  it("reports an MDM failure immediately", () => {
    expect(decideUnlockPoll(status({ availability: "mdm-error" }), fresh)).toBe(
      "failed",
    );
  });

  it("fails fast when our unlock was superseded by another app", () => {
    expect(decideUnlockPoll(status(), fresh)).toBe("failed");
    expect(
      decideUnlockPoll(status({ availability: "expired-awaiting-reconcile" }), fresh),
    ).toBe("failed");
  });

  it("times out a wait that never resolves, rather than guessing ready", () => {
    const stuck = status({
      desiredState: "unlocked",
      availability: "mdm-accepted-propagating",
      expiresAt: NOW + HOUR,
    });
    expect(decideUnlockPoll(stuck, { elapsedMs: 30_000, budgetMs: 30_000 })).toBe(
      "timeout",
    );
  });

  it("still reports ready on the very poll that hits the budget", () => {
    expect(
      decideUnlockPoll(ready(NOW + HOUR), { elapsedMs: 99_000, budgetMs: 30_000 }),
    ).toBe("ready");
  });
});

describe("nextUnlockPollDelayMs", () => {
  it("starts tight and eases off, never going backwards", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 20].map(nextUnlockPollDelayMs);
    expect(delays[0]).toBe(400);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
    expect(delays.at(-1)).toBe(1_500);
  });

  it("covers the backend's ~15s propagation estimate well inside the budget", () => {
    let total = 0;
    let reads = 0;
    while (total < 15_000) total += nextUnlockPollDelayMs(reads++);
    expect(reads).toBeLessThanOrEqual(16);
    expect(total).toBeLessThan(UNLOCK_BUDGET_MS);
  });
});

describe("unlock copy", () => {
  it("names the app in the headline, sentence case", () => {
    expect(unlockHeadline("Google Sheets", "waiting")).toBe(
      "Unlocking Google Sheets…",
    );
    expect(unlockHeadline("Google Sheets", "opening")).toBe(
      "Opening Google Sheets…",
    );
    expect(unlockHeadline("Google Sheets", "preparing")).toBe(
      "Opening Google Sheets…",
    );
  });

  it("keeps the tap acknowledgment free of any unlock claim", () => {
    // `preparing` is what the launcher shows the instant a managed-scheme tile
    // is tapped, BEFORE the status read that decides whether this iPad is even
    // unlock-mediated. Most of the fleet is not, so this copy must not promise
    // an unlock; the "Unlocking…" wording arrives only with a gate-reported
    // phase, which the gate withholds until it knows.
    expect(unlockHeadline("LEGO SPIKE", "preparing")).not.toMatch(/unlock/i);
    expect(unlockProgressCopy("preparing", 0)).not.toMatch(/unlock/i);
    expect(unlockProgressCopy("preparing", UNLOCK_SLOW_AFTER_MS)).not.toMatch(
      /unlock/i,
    );
  });

  describe("unlockEstimatedProgress", () => {
    it("tracks elapsed time through the 16-second wait estimate", () => {
      expect(UNLOCK_PROGRESS_ESTIMATE_MS).toBe(16_000);
      expect(unlockEstimatedProgress(0)).toBe(0);
      expect(unlockEstimatedProgress(8_000)).toBe(0.5);
      expect(unlockEstimatedProgress(16_000)).toBe(1);
    });

    it("clamps early and long-running waits without affecting readiness", () => {
      expect(unlockEstimatedProgress(-1_000)).toBe(0);
      expect(unlockEstimatedProgress(60_000)).toBe(1);
    });
  });

  it("never invents a percentage or a fake stage count", () => {
    const lines = [
      unlockProgressCopy("asking", 0),
      unlockProgressCopy("preparing", 0),
      unlockProgressCopy("waiting", 3_000),
      unlockProgressCopy("waiting", UNLOCK_SLOW_AFTER_MS),
      unlockProgressCopy("confirming", 0),
      unlockProgressCopy("opening", 60_000),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/%|\bstep\b|\d\s*of\s*\d/i);
    }
  });

  it("does not cry 'slow' during the normal propagation wait", () => {
    expect(UNLOCK_SLOW_AFTER_MS).toBeGreaterThan(15_000);
    expect(unlockProgressCopy("waiting", 14_000)).not.toMatch(/longer than usual/i);
  });

  it("admits when the wait is genuinely running long", () => {
    expect(unlockProgressCopy("waiting", UNLOCK_SLOW_AFTER_MS)).toMatch(
      /longer than usual/i,
    );
  });

  it("keeps 'opening' honest once the wait is over, at any elapsed time", () => {
    expect(unlockProgressCopy("opening", 60_000)).toBe(
      "Almost there — opening it now.",
    );
  });

  it("acknowledges the tap neutrally before warm or cold status is known", () => {
    expect(unlockProgressCopy("preparing", 0)).toBe("Getting things ready…");
  });

  it("gives the screen reader the app name and the same status as the copy", () => {
    const label = unlockAccessibilityLabel("LEGO SPIKE", "waiting", 0);
    expect(label).toContain("LEGO SPIKE");
    expect(label).toContain(unlockProgressCopy("waiting", 0));
    expect(unlockAccessibilityLabel("Google Sheets", "opening", 0)).toContain(
      "Opening Google Sheets",
    );
  });

  it("matches the existing open-failed title shape", () => {
    expect(unlockFailedTitle("Google Sheets")).toBe("Couldn't open Google Sheets");
  });

  it("never claims the app opened or that it is missing", () => {
    for (const reason of ["timeout", "failed", "os-unavailable"] as const) {
      const message = unlockFailedMessage("Google Sheets", reason);
      expect(message).not.toMatch(/opened|installed/i);
      expect(message).toMatch(/ask a teacher/i);
    }
  });

  it("distinguishes a timeout from an outright failure", () => {
    expect(unlockFailedMessage("Sheets", "timeout")).not.toBe(
      unlockFailedMessage("Sheets", "failed"),
    );
  });

  it("says the iPad has not finished unlocking when only the device disagrees", () => {
    const message = unlockFailedMessage("Google Sheets", "os-unavailable");
    // The control plane accepted; this iPad has not applied it yet. Say that,
    // and never that the app is missing.
    expect(message).toMatch(/this iPad/i);
    expect(message).not.toMatch(/installed|missing|deleted/i);
    expect(message).not.toBe(unlockFailedMessage("Google Sheets", "failed"));
  });

  it("prefers a scholar-safe message when one is supplied", () => {
    expect(
      unlockFailedMessage("Sheets", "failed", "  Ask Ms. Lee to turn Sheets on. "),
    ).toBe("Ask Ms. Lee to turn Sheets on.");
  });

  it("ignores an empty supplied message rather than showing a blank line", () => {
    expect(unlockFailedMessage("Sheets", "failed", "   ")).toBe(
      unlockFailedMessage("Sheets", "failed"),
    );
  });
});

/**
 * The abandoned-lease rule. `requestUnlock` arms the lease for the long
 * active-session cap on the assumption the scholar is about to use the app; if
 * the launch never reaches the app, that assumption is wrong and the lease has
 * to go back on the one-hour idle clock.
 */
describe("shouldHandBackUnlockLease", () => {
  it("hands back a lease this launch armed but never used", () => {
    // Cancel, an OS check that never confirmed, a newer tap — all "abandoned".
    expect(
      shouldHandBackUnlockLease({ unlockRequested: true, exit: "abandoned" }),
    ).toBe(true);
  });

  it("leaves the lease alone once the app was actually opened", () => {
    // The scholar is in Sheets. Shortening the lease here is exactly the
    // mid-task relock the warm-lease design exists to prevent.
    expect(
      shouldHandBackUnlockLease({ unlockRequested: true, exit: "launched" }),
    ).toBe(false);
  });

  it("says nothing about a device whose lease this launch never touched", () => {
    // Cancelled before requesting: no lease of ours, so no return signal — it
    // would otherwise idle out another launch's live session.
    expect(
      shouldHandBackUnlockLease({ unlockRequested: false, exit: "abandoned" }),
    ).toBe(false);
    expect(
      shouldHandBackUnlockLease({ unlockRequested: false, exit: "launched" }),
    ).toBe(false);
  });
});

/**
 * The handoff record, and the ordering bug it exists to close: the record has to
 * be written BEFORE the app switch is requested, because a fast
 * background→active bounce restores ASAM and reads it synchronously — possibly
 * before `Linking.openURL` has even resolved.
 */
describe("claimUnlockHandoff", () => {
  const handoff = { deviceId: "ipad-7", leaseToken: "lease-3", launchGen: 3 };

  it("returns the device to signal and clears the record", () => {
    expect(claimUnlockHandoff(handoff)).toEqual({
      target: { deviceId: "ipad-7", leaseToken: "lease-3" },
      next: null,
    });
  });

  it("is idempotent — a second claim signals nothing", () => {
    const { next } = claimUnlockHandoff(handoff);
    expect(claimUnlockHandoff(next)).toEqual({ target: null, next: null });
  });

  it("lets the launch that armed it claim it back", () => {
    expect(claimUnlockHandoff(handoff, { onlyLaunchGen: 3 })).toEqual({
      target: { deviceId: "ipad-7", leaseToken: "lease-3" },
      next: null,
    });
  });

  it("refuses to let a superseded launch swallow a newer launch's return", () => {
    // Launch 3 was superseded and is cleaning up; launch 4 has already armed
    // its own handoff. Claiming here would strand launch 4's return.
    expect(claimUnlockHandoff({
      deviceId: "ipad-7",
      leaseToken: "lease-4",
      launchGen: 4,
    }, {
      onlyLaunchGen: 3,
    })).toEqual({
      target: null,
      next: { deviceId: "ipad-7", leaseToken: "lease-4", launchGen: 4 },
    });
  });

  it("survives a return that beats the openURL promise (the ordering bug)", () => {
    // Ordering as shipped: record → request switch → (iOS backgrounds and
    // re-activates) → restore reads the record → openURL finally resolves.
    let pending: ReturnType<typeof claimUnlockHandoff>["next"] = {
      deviceId: "ipad-7",
      leaseToken: "lease-3",
      launchGen: 3,
    };

    const onReentry = claimUnlockHandoff(pending);
    pending = onReentry.next;

    // The return signal fires with the right iPad, so the lease drops to the
    // one-hour idle clock instead of sitting armed for the 8h failsafe.
    expect(onReentry.target).toEqual({
      deviceId: "ipad-7",
      leaseToken: "lease-3",
    });

    // openURL resolving late must not re-signal or resurrect the record.
    expect(claimUnlockHandoff(pending, { onlyLaunchGen: 3 })).toEqual({
      target: null,
      next: null,
    });
  });

  it("signals nothing for a launch that never armed a handoff", () => {
    // Unmanaged app, or a launch abandoned before the switch was requested.
    expect(claimUnlockHandoff(null, { onlyLaunchGen: 3 })).toEqual({
      target: null,
      next: null,
    });
  });
});
