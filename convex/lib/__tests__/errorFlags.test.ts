import { describe, expect, test } from "vitest";
import {
  ERROR_FLAG_MIN_COUNT,
  ERROR_FLAG_WINDOW_MS,
  PATTERN_PHRASING,
  openErrorPatterns,
  hasOpenErrorPattern,
  type ErrorEvent,
} from "../practice/errorFlags";
import type { ErrorPattern } from "../practice/errorPatterns";

const NOW = 1_700_000_000_000;
const ev = (pattern: string, ageMs: number): ErrorEvent => ({
  pattern,
  createdAt: NOW - ageMs,
});

describe("errorFlags — openErrorPatterns windowing", () => {
  test("below the threshold → no open pattern", () => {
    const events = Array.from({ length: ERROR_FLAG_MIN_COUNT - 1 }, () =>
      ev("SMALLER_FROM_LARGER", 1000),
    );
    expect(openErrorPatterns(events, NOW)).toEqual([]);
    expect(hasOpenErrorPattern(events, NOW)).toBe(false);
  });

  test("exactly the threshold inside the window → open, with count + phrasing", () => {
    const events = Array.from({ length: ERROR_FLAG_MIN_COUNT }, () =>
      ev("SMALLER_FROM_LARGER", 1000),
    );
    const open = openErrorPatterns(events, NOW);
    expect(open).toHaveLength(1);
    expect(open[0].pattern).toBe("SMALLER_FROM_LARGER");
    expect(open[0].count).toBe(ERROR_FLAG_MIN_COUNT);
    expect(open[0].phrasing).toBe(PATTERN_PHRASING.SMALLER_FROM_LARGER);
    expect(hasOpenErrorPattern(events, NOW)).toBe(true);
  });

  test("events older than the window don't count (auto-clear by construction)", () => {
    // Two fresh + two stale of the same pattern → only 2 in window → below 3.
    const events = [
      ev("DROPPED_CARRY", 1000),
      ev("DROPPED_CARRY", 2000),
      ev("DROPPED_CARRY", ERROR_FLAG_WINDOW_MS + 5000),
      ev("DROPPED_CARRY", ERROR_FLAG_WINDOW_MS + 6000),
    ];
    expect(openErrorPatterns(events, NOW)).toEqual([]);

    // Once a 3rd fresh one lands, it opens.
    events.push(ev("DROPPED_CARRY", 3000));
    const open = openErrorPatterns(events, NOW);
    expect(open).toHaveLength(1);
    expect(open[0].count).toBe(3);
  });

  test("distinct patterns accumulate independently", () => {
    const events = [
      ...Array.from({ length: 3 }, () => ev("SMALLER_FROM_LARGER", 1000)),
      ...Array.from({ length: 2 }, () => ev("REMAINDER_IGNORED", 1000)),
    ];
    const open = openErrorPatterns(events, NOW);
    // Only the one that reached the threshold is open.
    expect(open.map((p) => p.pattern)).toEqual(["SMALLER_FROM_LARGER"]);
  });

  test("multiple open patterns are returned most-recent-first", () => {
    const events = [
      ...Array.from({ length: 3 }, (_, i) => ev("SMALLER_FROM_LARGER", 10_000 + i)),
      ...Array.from({ length: 3 }, (_, i) => ev("REVERSED_OPERANDS", 100 + i)),
    ];
    const open = openErrorPatterns(events, NOW);
    expect(open).toHaveLength(2);
    // REVERSED_OPERANDS is more recent (smaller age) → first.
    expect(open[0].pattern).toBe("REVERSED_OPERANDS");
    expect(open[1].pattern).toBe("SMALLER_FROM_LARGER");
    expect(open[0].lastAt).toBeGreaterThan(open[1].lastAt);
  });

  test("unknown / retired pattern strings are ignored", () => {
    const events = Array.from({ length: 5 }, () => ev("MYSTERY_BUG", 1000));
    expect(openErrorPatterns(events, NOW)).toEqual([]);
  });

  test("future-dated events (clock skew) are ignored", () => {
    const events = Array.from({ length: 3 }, () => ev("DROPPED_CARRY", -60_000));
    expect(openErrorPatterns(events, NOW)).toEqual([]);
  });
});

describe("errorFlags — phrasing coverage", () => {
  test("every ErrorPattern has growth-framed phrasing", () => {
    const patterns: ErrorPattern[] = [
      "SMALLER_FROM_LARGER",
      "DROPPED_CARRY",
      "PLACE_MISALIGNMENT",
      "OFF_BY_ONE_SKIP",
      "REMAINDER_IGNORED",
      "REVERSED_OPERANDS",
    ];
    for (const p of patterns) {
      expect(PATTERN_PHRASING[p]).toBeTruthy();
      // growth-framed: describes the procedure, never the child, never comparative
      expect(PATTERN_PHRASING[p].toLowerCase()).not.toMatch(/\b(other|behind|below|worse|can't|stupid)\b/);
    }
  });
});
