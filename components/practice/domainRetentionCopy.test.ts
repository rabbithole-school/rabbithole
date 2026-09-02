import { describe, expect, it } from "vitest";
import {
  lastDrilledClause,
  retentionHoverClause,
  retentionStripSentence,
} from "./domainRetentionCopy";
import type { DomainRetentionSummary } from "@/convex/lib/practice/domainRetention";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("lastDrilledClause — the honest last-drilled clock", () => {
  it("says 'not yet drilled' when lastAttemptAt is null (placement/reprobe only credit)", () => {
    // Never fabricates a date, and never substitutes lastPracticedAt (the SR
    // clock) for the honest drill clock — spec Signal #3.
    expect(lastDrilledClause(null, NOW)).toBe("not yet drilled (placement only)");
  });

  it("says 'today' / '1 day ago' / 'N days ago' for the ordinary cases", () => {
    expect(lastDrilledClause(NOW, NOW)).toBe("last drilled today");
    expect(lastDrilledClause(NOW - 1 * DAY_MS, NOW)).toBe("last drilled 1 day ago");
    expect(lastDrilledClause(NOW - 24 * DAY_MS, NOW)).toBe("last drilled 24 days ago");
  });
});

describe("retentionHoverClause — Tier 1 (matrix cell hover)", () => {
  it("is undefined when there is nothing due — a fresh or empty domain says nothing extra", () => {
    expect(retentionHoverClause(undefined, NOW)).toBeUndefined();
    expect(
      retentionHoverClause({ dueCount: 0, greenCount: 0 }, NOW),
    ).toBeUndefined();
    expect(
      retentionHoverClause({ dueCount: 0, greenCount: 6 }, NOW),
    ).toBeUndefined();
  });

  it("names the count and the honest recency when something is due", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 3,
      greenCount: 9,
      mostOverdue: { lastAttemptAt: NOW - 24 * DAY_MS, halfLifeDays: 18 },
    };
    expect(retentionHoverClause(retention, NOW)).toBe(
      "3 of 9 fluent skills due — last drilled 24 days ago",
    );
  });

  it("singularizes 'skill' when exactly one is due", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 1,
      greenCount: 4,
      mostOverdue: { lastAttemptAt: NOW - 5 * DAY_MS, halfLifeDays: 12 },
    };
    expect(retentionHoverClause(retention, NOW)).toBe(
      "1 of 4 fluent skill due — last drilled 5 days ago",
    );
  });

  it("uses the honest placement-only fallback, never a fabricated date", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 1,
      greenCount: 2,
      mostOverdue: { lastAttemptAt: null, halfLifeDays: 20 },
    };
    expect(retentionHoverClause(retention, NOW)).toBe(
      "1 of 2 fluent skill due — not yet drilled (placement only)",
    );
  });
});

describe("retentionStripSentence — Tier 2 (the detail panel strip)", () => {
  it("is undefined under the exact same conditions as the Tier 1 clause (one vocabulary)", () => {
    expect(retentionStripSentence(undefined, NOW)).toBeUndefined();
    expect(
      retentionStripSentence({ dueCount: 0, greenCount: 0 }, NOW),
    ).toBeUndefined();
    expect(
      retentionStripSentence({ dueCount: 0, greenCount: 5 }, NOW),
    ).toBeUndefined();
  });

  it("adds the half-life so 'due' reads as decay, not an arbitrary flag", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 2,
      greenCount: 7,
      mostOverdue: { lastAttemptAt: NOW - 24 * DAY_MS, halfLifeDays: 18.4 },
    };
    expect(retentionStripSentence(retention, NOW)).toBe(
      "2 of 7 fluent skills decayed past due — last drilled 24 days ago, half-life ~18d.",
    );
  });

  it("carries the honest placement-only fallback through to the panel too", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 1,
      greenCount: 3,
      mostOverdue: { lastAttemptAt: null, halfLifeDays: 15 },
    };
    expect(retentionStripSentence(retention, NOW)).toBe(
      "1 of 3 fluent skill decayed past due — not yet drilled (placement only), half-life ~15d.",
    );
  });
});
