import { describe, expect, test } from "vitest";
import {
  summarizeDomainRetention,
  type DomainRetentionInput,
} from "../domainRetention";
import { FLUENT_REPS, OVERLEARNED_REPS, PRACTICING_REPS } from "../scheduler";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-01-01T00:00:00Z");

function row(over: Partial<DomainRetentionInput> = {}): DomainRetentionInput {
  return {
    repetition: FLUENT_REPS,
    halfLifeDays: 30,
    lastPracticedAt: NOW,
    ...over,
  };
}

describe("summarizeDomainRetention — the one Tier 1/Tier 2 freshness aggregate", () => {
  test("no rows at all is a calm empty state, not an error", () => {
    expect(summarizeDomainRetention([], NOW)).toEqual({
      dueCount: 0,
      greenCount: 0,
      mostOverdue: undefined,
    });
  });

  test("below-fluent rows (not_started/practicing) count toward neither green nor due", () => {
    const rows = [
      row({ repetition: 0 }),
      row({ repetition: PRACTICING_REPS }),
    ];
    expect(summarizeDomainRetention(rows, NOW)).toEqual({
      dueCount: 0,
      greenCount: 0,
      mostOverdue: undefined,
    });
  });

  test("a fresh green skill is green but not due — the calm, common case", () => {
    // Practiced today, generous half-life: nowhere near due.
    const rows = [row({ lastPracticedAt: NOW, halfLifeDays: 60 })];
    const summary = summarizeDomainRetention(rows, NOW);
    expect(summary.greenCount).toBe(1);
    expect(summary.dueCount).toBe(0);
    expect(summary.mostOverdue).toBeUndefined();
  });

  test("a decayed green (overlearned) skill is counted due, with its honest recency", () => {
    const staleAttempt = NOW - 24 * DAY_MS;
    const rows = [
      row({
        repetition: OVERLEARNED_REPS,
        halfLifeDays: 18,
        lastPracticedAt: staleAttempt,
        lastAttemptAt: staleAttempt,
      }),
    ];
    const summary = summarizeDomainRetention(rows, NOW);
    expect(summary.greenCount).toBe(1);
    expect(summary.dueCount).toBe(1);
    expect(summary.mostOverdue).toEqual({
      lastAttemptAt: staleAttempt,
      halfLifeDays: 18,
    });
  });

  test("the HONEST case: a due skill whose credit came entirely from placement/reprobe reports a NULL lastAttemptAt, never lastPracticedAt", () => {
    const staleClock = NOW - 40 * DAY_MS;
    const rows = [
      row({
        halfLifeDays: 10,
        lastPracticedAt: staleClock, // the SR clock, used for the isDue math
        lastAttemptAt: undefined, // never actually drilled — must not be backfilled
      }),
    ];
    const summary = summarizeDomainRetention(rows, NOW);
    expect(summary.dueCount).toBe(1);
    expect(summary.mostOverdue?.lastAttemptAt).toBeNull();
    // The honest recency is null, NOT silently substituted with the SR clock.
    expect(summary.mostOverdue?.lastAttemptAt).not.toBe(staleClock);
  });

  test("among several due skills, the MOST overdue (lowest retention ratio) wins — not the first or last row", () => {
    const rows = [
      row({ halfLifeDays: 10, lastPracticedAt: NOW - 20 * DAY_MS, lastAttemptAt: NOW - 20 * DAY_MS }),
      // Much further past its half-life — this one should win.
      row({ halfLifeDays: 5, lastPracticedAt: NOW - 40 * DAY_MS, lastAttemptAt: NOW - 40 * DAY_MS }),
      row({ halfLifeDays: 10, lastPracticedAt: NOW - 22 * DAY_MS, lastAttemptAt: NOW - 22 * DAY_MS }),
    ];
    const summary = summarizeDomainRetention(rows, NOW);
    expect(summary.greenCount).toBe(3);
    expect(summary.dueCount).toBe(3);
    expect(summary.mostOverdue).toEqual({
      lastAttemptAt: NOW - 40 * DAY_MS,
      halfLifeDays: 5,
    });
  });

  test("greenCount and dueCount mix: some green skills fresh, some due, non-green ignored", () => {
    const staleAttempt = NOW - 25 * DAY_MS;
    const rows = [
      row({ repetition: 0 }), // not started — ignored entirely
      row({ lastPracticedAt: NOW, halfLifeDays: 90 }), // green, fresh
      row({
        halfLifeDays: 12,
        lastPracticedAt: staleAttempt,
        lastAttemptAt: staleAttempt,
      }), // green, due
    ];
    const summary = summarizeDomainRetention(rows, NOW);
    expect(summary.greenCount).toBe(2);
    expect(summary.dueCount).toBe(1);
    expect(summary.mostOverdue).toEqual({
      lastAttemptAt: staleAttempt,
      halfLifeDays: 12,
    });
  });
});
