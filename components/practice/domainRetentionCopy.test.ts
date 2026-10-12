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

  it("names the count and pluralizes 'skill(s)' based on the due count", () => {
    const plural: DomainRetentionSummary = {
      dueCount: 3,
      greenCount: 9,
      mostOverdue: { lastAttemptAt: NOW - 24 * DAY_MS, halfLifeDays: 18 },
    };
    const singular: DomainRetentionSummary = {
      dueCount: 1,
      greenCount: 4,
      mostOverdue: { lastAttemptAt: NOW - 5 * DAY_MS, halfLifeDays: 12 },
    };
    expect(retentionHoverClause(plural, NOW)).toContain("3 of 9 fluent skills due");
    expect(retentionHoverClause(singular, NOW)).toContain("1 of 4 fluent skill due");
    expect(retentionHoverClause(singular, NOW)).not.toContain("skills due");
  });

  it("uses the honest placement-only fallback, never a fabricated date", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 1,
      greenCount: 2,
      mostOverdue: { lastAttemptAt: null, halfLifeDays: 20 },
    };
    expect(retentionHoverClause(retention, NOW)).toContain(
      "not yet drilled (placement only)",
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

  it("adds the rounded half-life so 'due' reads as decay, not an arbitrary flag", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 2,
      greenCount: 7,
      mostOverdue: { lastAttemptAt: NOW - 24 * DAY_MS, halfLifeDays: 18.4 },
    };
    expect(retentionStripSentence(retention, NOW)).toContain("half-life ~18d.");
  });

  it("carries the honest placement-only fallback through to the panel too", () => {
    const retention: DomainRetentionSummary = {
      dueCount: 1,
      greenCount: 3,
      mostOverdue: { lastAttemptAt: null, halfLifeDays: 15 },
    };
    const sentence = retentionStripSentence(retention, NOW);
    expect(sentence).toContain("not yet drilled (placement only)");
    expect(sentence).toContain("half-life ~15d.");
  });
});
