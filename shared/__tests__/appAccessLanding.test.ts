import { describe, expect, it } from "vitest";
import {
  INVENTORY_CRON_MINUTE_UTC,
  PROJECTION_SWEEP_MS,
  etaLabel,
  landingProgress,
  nextInventoryCheckAt,
} from "../appAccessLanding";

const HOUR = 60 * 60 * 1_000;

describe("nextInventoryCheckAt", () => {
  it("returns this hour's :17 when it is still ahead", () => {
    const now = Date.parse("2026-09-03T19:05:00.000Z");
    expect(new Date(nextInventoryCheckAt(now)).toISOString()).toBe("2026-09-03T19:17:00.000Z");
  });

  it("rolls to the next hour once :17 has passed", () => {
    const now = Date.parse("2026-09-03T19:30:00.000Z");
    expect(new Date(nextInventoryCheckAt(now)).toISOString()).toBe("2026-09-03T20:17:00.000Z");
  });

  it("rolls forward when sitting exactly on :17", () => {
    const now = Date.parse("2026-09-03T19:17:00.000Z");
    expect(new Date(nextInventoryCheckAt(now)).toISOString()).toBe("2026-09-03T20:17:00.000Z");
  });

  it("crosses midnight", () => {
    const now = Date.parse("2026-09-03T23:45:00.000Z");
    expect(new Date(nextInventoryCheckAt(now)).toISOString()).toBe("2026-09-04T00:17:00.000Z");
  });

  it("matches the cron minute the fleet actually ran on", () => {
    // Real prod read, 2026-09-03: every device shared installedAppsAt
    // 1788463059014 = 19:17:39Z.
    expect(new Date(1788463059014).getUTCMinutes()).toBe(INVENTORY_CRON_MINUTE_UTC);
  });
});

describe("landingProgress", () => {
  const base = {
    allowed: "settled" as const,
    operationStartedAt: null,
    operationKind: null,
    projectionAppliedAt: null,
    projectionDueAt: null,
    installedCheckedAt: null,
    now: 0,
  };

  it("reports sending while a projection PATCH is in flight", () => {
    const started = 1_000_000;
    const p = landingProgress({
      ...base,
      allowed: "pending",
      operationStartedAt: started,
      operationKind: "projection" as const,
      now: started + 30_000,
    });
    expect(p.phase).toBe("sending");
    expect(p.overdue).toBe(false);
    expect(p.pct).toBe(25); // 30s of the 120s operation lease
    expect(p.etaMs).toBe(90_000);
  });

  it("marks sending overdue once the operation lease is spent", () => {
    const started = 1_000_000;
    const p = landingProgress({
      ...base,
      operationStartedAt: started,
      operationKind: "projection" as const,
      now: started + 150_000,
    });
    expect(p.phase).toBe("sending");
    expect(p.overdue).toBe(true);
    expect(p.etaMs).toBeNull();
    expect(p.pct).toBe(100);
  });

  it("leaves the change queued while an unlock ceremony holds the profile", () => {
    const started = 1_000_000;
    const p = landingProgress({
      ...base,
      allowed: "pending",
      operationStartedAt: started,
      operationKind: "ceremony",
      projectionDueAt: started + PROJECTION_SWEEP_MS,
      now: started + 30_000,
    });
    expect(p.phase).toBe("queued");
  });

  it("treats a zero due time as an immediate kick, not a missed deadline", () => {
    const now = 5_000_000;
    const p = landingProgress({ ...base, allowed: "pending", projectionDueAt: 0, now });
    expect(p.phase).toBe("queued");
    expect(p.overdue).toBe(false);
    expect(p.pct).toBe(0);
    expect(p.etaMs).toBe(PROJECTION_SWEEP_MS);
  });

  it("reports queued while the app is not in the live profile and nothing is running", () => {
    const applied = 3_000_000;
    const p = landingProgress({
      ...base,
      allowed: "pending",
      projectionAppliedAt: applied,
      projectionDueAt: applied + PROJECTION_SWEEP_MS,
      now: applied + 60_000,
    });
    expect(p.phase).toBe("queued");
    expect(p.pct).toBe(20); // 1 of the 5 minutes to the next sweep
    expect(p.etaMs).toBe(4 * 60_000);
    expect(p.typical).toContain("5 minutes");
  });

  it("marks queued overdue once the sweep it was waiting for has passed", () => {
    const applied = 3_000_000;
    const p = landingProgress({
      ...base,
      allowed: "pending",
      projectionAppliedAt: applied,
      projectionDueAt: applied + PROJECTION_SWEEP_MS,
      now: applied + PROJECTION_SWEEP_MS + 30_000,
    });
    expect(p.phase).toBe("queued");
    expect(p.overdue).toBe(true);
    expect(p.etaMs).toBeNull();
  });

  it("never lets a lease timestamp stand in for the projection", () => {
    // A settled allowlist with no PATCH running is waiting on inventory, no
    // matter what the device's unrelated unlock ceremony last stamped.
    const now = Date.parse("2026-09-03T19:47:00.000Z");
    const p = landingProgress({
      ...base,
      allowed: "settled",
      projectionAppliedAt: now - HOUR,
      installedCheckedAt: Date.parse("2026-09-03T19:17:00.000Z"),
      now,
    });
    expect(p.phase).toBe("confirming");
  });

  it("reports propagating for the push window after the profile was patched", () => {
    const applied = 2_000_000;
    const p = landingProgress({
      ...base,
      projectionAppliedAt: applied,
      now: applied + 5_000,
    });
    expect(p.phase).toBe("propagating");
    expect(p.pct).toBe(33);
    expect(p.etaMs).toBe(10_000);
    expect(p.typical).toContain("15 seconds");
  });

  it("moves to confirming once the iPad should already have it", () => {
    const now = Date.parse("2026-09-03T19:47:00.000Z");
    const p = landingProgress({
      ...base,
      projectionAppliedAt: now - 60_000,
      installedCheckedAt: Date.parse("2026-09-03T19:17:00.000Z"),
      now,
    });
    expect(p.phase).toBe("confirming");
    // 30 min into the hour between :17 and :17.
    expect(p.pct).toBe(50);
    expect(p.etaMs).toBe(30 * 60_000);
    expect(p.overdue).toBe(false);
  });

  it("still gives confirming a full-hour window when the iPad was never inventoried", () => {
    const now = Date.parse("2026-09-03T19:47:00.000Z");
    const p = landingProgress({ ...base, projectionAppliedAt: now - 60_000, now });
    expect(p.phase).toBe("confirming");
    expect(p.pct).toBe(50);
    expect(p.etaMs).toBe(30 * 60_000);
  });

  it("never reports a percentage outside 0-100", () => {
    const now = Date.parse("2026-09-03T20:16:00.000Z");
    const p = landingProgress({
      ...base,
      projectionAppliedAt: now - HOUR,
      installedCheckedAt: now - 5 * HOUR,
      now,
    });
    expect(p.pct).toBeGreaterThanOrEqual(0);
    expect(p.pct).toBeLessThanOrEqual(100);
  });

  it("stays sane when a pending change has no projector clocks at all", () => {
    const now = 5_000_000;
    const p = landingProgress({ ...base, allowed: "pending", now });
    expect(p.phase).toBe("queued");
    expect(p.pct).toBeGreaterThanOrEqual(0);
    expect(p.pct).toBeLessThanOrEqual(100);
    expect(p.etaMs).toBe(PROJECTION_SWEEP_MS);
  });
});

describe("etaLabel", () => {
  it("uses seconds under a minute", () => {
    expect(etaLabel(9_000)).toBe("in 9s");
  });

  it("never rounds a live ETA down to zero", () => {
    expect(etaLabel(200)).toBe("in 1s");
  });

  it("uses minutes below an hour", () => {
    expect(etaLabel(30 * 60_000)).toBe("in about 30 min");
  });

  it("uses hours above an hour", () => {
    expect(etaLabel(2 * HOUR)).toBe("in about 2 hr");
  });

  it("says overdue when there is no estimate left", () => {
    expect(etaLabel(null)).toBe("overdue");
  });
});
