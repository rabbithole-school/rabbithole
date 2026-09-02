import { describe, expect, test } from "vitest";
import {
  digestStaleness,
  watermarkAdvanced,
  type DigestSourceSnapshot,
} from "../lib/digestStaleness";

// Pure boundary coverage for the digest watermark comparison. See
// convex/classDigests.ts (read-time staleness + auto-regen) and
// convex/teacherToday.ts (suppression) for the Convex callers.

const counts = {
  completedCount: 1,
  startedCount: 2,
  deliverableCount: 0,
};

describe("watermarkAdvanced", () => {
  test("absent snapshot → never advanced (legacy digest untouched)", () => {
    expect(
      watermarkAdvanced(undefined, {
        latestAnalysisAt: 999,
        latestMessageAt: 999,
      }),
    ).toBe(false);
  });

  test("snapshot without watermark fields → no watermark check", () => {
    // An old row that has counts but no watermark: current watermark is far
    // ahead, yet absent == skip → not advanced.
    const snap: DigestSourceSnapshot = { ...counts };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 5000, latestMessageAt: 5000 }),
    ).toBe(false);
  });

  test("analysis watermark advance is detected", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 101, latestMessageAt: 100 }),
    ).toBe(true);
  });

  test("message watermark advance is detected", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 100, latestMessageAt: 101 }),
    ).toBe(true);
  });

  test("equal watermark → not advanced (boundary)", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 100, latestMessageAt: 100 }),
    ).toBe(false);
  });

  test("a zero snapshot watermark still applies (0 is a real stamp, not absent)", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 0,
      latestMessageAt: 0,
    };
    // A digest generated with no analyses yet (0), then one lands (>0).
    expect(
      watermarkAdvanced(snap, { latestAnalysisAt: 1, latestMessageAt: 0 }),
    ).toBe(true);
  });

  test("missing current field defaults to 0 (no false advance)", () => {
    const snap: DigestSourceSnapshot = {
      ...counts,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    expect(watermarkAdvanced(snap, {})).toBe(false);
  });
});

describe("digestStaleness", () => {
  test("absent snapshot → not stale, no delta", () => {
    expect(
      digestStaleness(undefined, { ...counts, latestAnalysisAt: 9 }),
    ).toEqual({
      stale: false,
      newSince: 0,
      countGrew: false,
      watermarkAdvanced: false,
    });
  });

  test("count growth marks stale with a positive delta", () => {
    const snap: DigestSourceSnapshot = {
      completedCount: 1,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    const res = digestStaleness(snap, {
      completedCount: 3,
      startedCount: 3,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    });
    expect(res.stale).toBe(true);
    expect(res.countGrew).toBe(true);
    expect(res.newSince).toBe(2);
    expect(res.watermarkAdvanced).toBe(false);
  });

  test("watermark advance marks stale with unchanged counts (Leilani case)", () => {
    const snap: DigestSourceSnapshot = {
      completedCount: 0,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 100,
      latestMessageAt: 100,
    };
    const res = digestStaleness(snap, {
      completedCount: 0,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 200, // a later observer analysis resolved it
      latestMessageAt: 100,
    });
    expect(res.stale).toBe(true);
    expect(res.watermarkAdvanced).toBe(true);
    expect(res.countGrew).toBe(false);
    expect(res.newSince).toBe(0); // watermark advance has no cardinality
  });

  test("legacy snapshot (no watermark) with unchanged counts stays fresh", () => {
    const snap: DigestSourceSnapshot = {
      completedCount: 1,
      startedCount: 1,
      deliverableCount: 0,
    };
    const res = digestStaleness(snap, {
      completedCount: 1,
      startedCount: 1,
      deliverableCount: 0,
      latestAnalysisAt: 999999, // current source is far ahead …
      latestMessageAt: 999999,
    });
    // … but the snapshot has no watermark to compare → behaves exactly as before.
    expect(res.stale).toBe(false);
    expect(res.watermarkAdvanced).toBe(false);
  });
});
