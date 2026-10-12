import { describe, expect, it } from "vitest";

import {
  OS_READY_INTERVAL_MS,
  READY_BUDGET_MS,
  UNLOCK_PROGRESS_ESTIMATE_MS,
  UNLOCK_SLOW_AFTER_MS,
  unlockAccessibilityLabel,
  unlockEstimatedProgress,
  unlockFailedMessage,
  unlockFailedTitle,
  unlockHeadline,
  unlockProgressCopy,
} from "../appUnlockPolicy";

const APP = "LEGO SPIKE";

describe("cold-path copy", () => {
  it("uses ONE neutral headline that stays true on both paths", () => {
    // "Getting X ready" is honest whether this iPad is waiting on its allowlist
    // or was already good to go, so nothing the scholar reads gets walked back
    // when a warm launch resolves instantly. It also never says "unlocking",
    // which describes a ceremony that no longer runs.
    expect(unlockHeadline(APP)).toBe("Getting LEGO SPIKE ready…");
    expect(unlockHeadline(APP)).not.toMatch(/unlock/i);
  });

  it("names the real app, never 'the app'", () => {
    expect(unlockHeadline("Google Sheets")).toContain("Google Sheets");
    expect(unlockFailedTitle("Google Sheets")).toBe("Couldn't open Google Sheets");
    expect(unlockFailedMessage("Google Sheets")).toContain("Google Sheets");
  });

  it("says plainly, and only, when the wait has run long", () => {
    expect(unlockProgressCopy(0)).toBe("Waiting for this iPad to allow it…");
    expect(unlockProgressCopy(UNLOCK_SLOW_AFTER_MS - 1)).toBe(
      "Waiting for this iPad to allow it…",
    );
    expect(unlockProgressCopy(UNLOCK_SLOW_AFTER_MS)).toBe(
      "This is taking longer than usual. Still working…",
    );
  });

  it("never promises the app opened, and never says it is missing", () => {
    const message = unlockFailedMessage(APP);
    expect(message).toMatch(/try again/i);
    expect(message).not.toMatch(/opened|installed|missing|not found/i);
  });

  it("carries the same status to a screen reader that the sighted copy shows", () => {
    // Nothing may be conveyed by the spinner or the bar alone.
    expect(unlockAccessibilityLabel(APP, UNLOCK_SLOW_AFTER_MS)).toBe(
      "Getting LEGO SPIKE ready. This is taking longer than usual. Still working…",
    );
  });
});

describe("the wait estimate", () => {
  it("is elapsed time against the normal propagation window, clamped", () => {
    expect(unlockEstimatedProgress(0)).toBe(0);
    expect(unlockEstimatedProgress(-5_000)).toBe(0);
    expect(unlockEstimatedProgress(UNLOCK_PROGRESS_ESTIMATE_MS / 2)).toBe(0.5);
    expect(unlockEstimatedProgress(UNLOCK_PROGRESS_ESTIMATE_MS)).toBe(1);
    expect(unlockEstimatedProgress(UNLOCK_PROGRESS_ESTIMATE_MS * 10)).toBe(1);
  });

  it("admits the wait is long only AFTER the estimate has been exceeded", () => {
    // Otherwise the ordinary case tells the scholar it is running long while it
    // is, in fact, running normally.
    expect(UNLOCK_SLOW_AFTER_MS).toBeGreaterThan(UNLOCK_PROGRESS_ESTIMATE_MS);
  });
});

describe("the failure budget", () => {
  it("outlasts several propagation windows without approaching the server's own lease", () => {
    // Anchors, from convex/deviceAppUnlock.ts: EXPECTED_MDM_PROPAGATION_MS is
    // 15s and OPERATION_TIMEOUT_MS is 120s. The budget has to be long enough
    // that a converging device is never abandoned a second early, and short
    // enough that a child is not held at a sheet for the server's whole
    // operation lease.
    expect(READY_BUDGET_MS).toBeGreaterThanOrEqual(4 * UNLOCK_PROGRESS_ESTIMATE_MS);
    expect(READY_BUDGET_MS).toBeLessThanOrEqual(0.75 * 120_000);
  });

  it("re-asks iOS often enough that a flip is not perceived as lag", () => {
    expect(OS_READY_INTERVAL_MS).toBeLessThanOrEqual(500);
  });
});
