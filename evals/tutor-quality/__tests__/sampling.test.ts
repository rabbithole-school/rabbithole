import { describe, expect, test } from "vitest";
import {
  sampleSessions,
  sampleWithoutReplacement,
  seededRandom,
  spreadTurnPositions,
} from "../lib/sampling";

describe("seededRandom", () => {
  test("same seed, same sequence; different seed, different sequence", () => {
    const a = seededRandom("2026-10-02");
    const b = seededRandom("2026-10-02");
    const c = seededRandom("2026-10-09");
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe("sampleWithoutReplacement", () => {
  test("returns k distinct items, or all of them when k is larger", () => {
    const rand = seededRandom("x");
    const picked = sampleWithoutReplacement([1, 2, 3, 4, 5, 6], 3, rand);
    expect(new Set(picked).size).toBe(3);
    expect(sampleWithoutReplacement([1, 2], 5, rand).sort()).toEqual([1, 2]);
  });
});

describe("sampleSessions", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, flagged: true })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, flagged: false })),
  ];
  const isFlagged = (r: { flagged: boolean }) => r.flagged;

  test("flagged sessions take at most half the budget", () => {
    const picked = sampleSessions(rows, 6, isFlagged, seededRandom("s"));
    expect(picked).toHaveLength(6);
    expect(picked.filter(isFlagged)).toHaveLength(3);
    expect(picked.slice(0, 3).every(isFlagged)).toBe(true);
  });

  test("leftover flagged sessions fill slots the unflagged pool can't", () => {
    const fewPlain = [...rows.slice(0, 10), rows[10]];
    const picked = sampleSessions(fewPlain, 6, isFlagged, seededRandom("s"));
    expect(picked).toHaveLength(6);
    expect(picked.filter((r) => !r.flagged)).toHaveLength(1);
  });

  test("a small week is judged in full", () => {
    expect(sampleSessions(rows.slice(8, 12), 12, isFlagged, seededRandom("s"))).toHaveLength(4);
  });
});

describe("spreadTurnPositions", () => {
  test("all turns when the session is within the cap", () => {
    expect(spreadTurnPositions(3, 8)).toEqual([0, 1, 2]);
  });

  test("cap turns spread from first to last", () => {
    const picks = spreadTurnPositions(56, 8);
    expect(picks).toHaveLength(8);
    expect(picks[0]).toBe(0);
    expect(picks[7]).toBe(55);
  });

  test("degenerate caps", () => {
    expect(spreadTurnPositions(10, 1)).toEqual([9]);
    expect(spreadTurnPositions(0, 8)).toEqual([]);
  });
});
