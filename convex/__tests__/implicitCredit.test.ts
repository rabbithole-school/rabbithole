/**
 * FIRe — Fractional Implicit Repetition (§4A). Pure-lib tests for
 * `convex/lib/practice/implicitCredit.ts`: the ancestor-weight walk over the
 * `buildsOn` DAG and the retention-only credit application. No Convex here —
 * these mirror the scheduler's pure-lib test style.
 */
import { describe, expect, test } from "vitest";
import type { GraphEdge, SkillState } from "../lib/practice/scheduler";
import { HALFLIFE_GROWTH } from "../lib/practice/scheduler";
import {
  ancestorWeights,
  applyImplicitCredit,
  IMPLICIT_CREDIT_FLOOR,
  IMPLICIT_HALFLIFE_CAP_DAYS,
  IMPLICIT_CREDIT_SLOW_LATENCY_MULTIPLE,
  IMPLICIT_WEIGHT_DEFAULT,
  shouldSkipImplicitCredit,
} from "../lib/practice/implicitCredit";

const DAY = 86_400_000;

/** Build a `buildsOn` edge — "toKey builds on fromKey" (fromKey is the prereq). */
function edge(fromKey: string, toKey: string, weight?: number): GraphEdge {
  return weight === undefined ? { fromKey, toKey } : { fromKey, toKey, weight };
}

describe("ancestorWeights — DAG walk", () => {
  test("linear chain: weights halve per hop, prune below the floor", () => {
    // e builds on d builds on c builds on b builds on a.
    const edges = [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
    ];
    const w = ancestorWeights("e", edges);
    // default 0.5 per hop: d=0.5, c=0.25, b=0.125 (≥ 0.1), a=0.0625 (< 0.1, pruned).
    expect(w.get("d")).toBeCloseTo(0.5, 10);
    expect(w.get("c")).toBeCloseTo(0.25, 10);
    expect(w.get("b")).toBeCloseTo(0.125, 10);
    expect(w.has("a")).toBe(false);
    expect(w.has("e")).toBe(false); // never the answered skill itself
  });

  test("diamond: a prereq reached by two paths takes the MAX-product path", () => {
    // d builds on b and c (default 0.5 each); b builds on a (0.5), c builds on a (0.9).
    const edges = [
      edge("b", "d"),
      edge("c", "d"),
      edge("a", "b", 0.5),
      edge("a", "c", 0.9),
    ];
    const w = ancestorWeights("d", edges);
    expect(w.get("b")).toBeCloseTo(0.5, 10);
    expect(w.get("c")).toBeCloseTo(0.5, 10);
    // via b: 0.5·0.5 = 0.25; via c: 0.5·0.9 = 0.45 → max wins.
    expect(w.get("a")).toBeCloseTo(0.45, 10);
  });

  test("explicit edge weight is honored; > 1 clamps to 1, ≤ 0 / non-finite → default", () => {
    expect(ancestorWeights("b", [edge("a", "b", 0.8)]).get("a")).toBeCloseTo(0.8, 10);
    expect(ancestorWeights("b", [edge("a", "b", 5)]).get("a")).toBeCloseTo(1, 10); // clamped
    expect(ancestorWeights("b", [edge("a", "b", 0)]).get("a")).toBeCloseTo(
      IMPLICIT_WEIGHT_DEFAULT,
      10,
    ); // ≤ 0 → default
    expect(ancestorWeights("b", [edge("a", "b", -3)]).get("a")).toBeCloseTo(
      IMPLICIT_WEIGHT_DEFAULT,
      10,
    );
    expect(ancestorWeights("b", [edge("a", "b", NaN)]).get("a")).toBeCloseTo(
      IMPLICIT_WEIGHT_DEFAULT,
      10,
    );
  });

  test("a floor-pruned first hop yields no ancestors at all", () => {
    // Single hop below the floor → nothing credited, walk stops.
    const w = ancestorWeights("b", [edge("a", "b", 0.05)]);
    expect(w.size).toBe(0);
  });

  test("order-independent and idempotent", () => {
    const edges = [edge("c", "d"), edge("a", "b"), edge("b", "c")];
    const w1 = ancestorWeights("d", edges);
    const w2 = ancestorWeights("d", [...edges].reverse());
    expect([...w1.entries()].sort()).toEqual([...w2.entries()].sort());
  });

  test("terminates and excludes the answered skill on malformed cyclic input", () => {
    // a→b→a cycle: answering a must not credit a, and must not loop forever.
    const w = ancestorWeights("a", [edge("a", "b"), edge("b", "a")]);
    expect(w.has("a")).toBe(false);
    expect(w.get("b")).toBeCloseTo(0.5, 10);
  });
});

describe("applyImplicitCredit — retention-only refresh", () => {
  const now = 1_000 * DAY; // arbitrary fixed clock

  test("shrinks the decay interval and grows half-life by a fractional power", () => {
    const prev: SkillState = { repetition: 2, halfLifeDays: 4, lastPracticedAt: now - 10 * DAY };
    const out = applyImplicitCredit(prev, 0.5, now);
    // lastPracticedAt′ = now − (1 − 0.5)·10d = now − 5d
    expect(out.lastPracticedAt).toBeCloseTo(now - 5 * DAY, 6);
    // halfLife′ = 4 · 2.3^0.5
    expect(out.halfLifeDays).toBeCloseTo(4 * Math.pow(HALFLIFE_GROWTH, 0.5), 6);
  });

  test("repetition is NEVER changed (implicit credit is not a demonstration)", () => {
    const prev: SkillState = { repetition: 2, halfLifeDays: 4, lastPracticedAt: now - 10 * DAY };
    for (const weight of [0.125, 0.25, 0.5, 1]) {
      expect(applyImplicitCredit(prev, weight, now).repetition).toBe(2);
    }
  });

  test("half-life growth is capped", () => {
    const prev: SkillState = { repetition: 3, halfLifeDays: 50, lastPracticedAt: now - DAY };
    // 50 · 2.3^1 = 115 → capped at 60.
    expect(applyImplicitCredit(prev, 1, now).halfLifeDays).toBe(IMPLICIT_HALFLIFE_CAP_DAYS);
  });

  test("no-op (same reference) when never demonstrated / no lastPracticedAt / below floor", () => {
    const noRep: SkillState = { repetition: 0, halfLifeDays: 4, lastPracticedAt: now - DAY };
    expect(applyImplicitCredit(noRep, 0.5, now)).toBe(noRep);

    const noLast: SkillState = { repetition: 2, halfLifeDays: 4 };
    expect(applyImplicitCredit(noLast, 0.5, now)).toBe(noLast);

    const strong: SkillState = { repetition: 2, halfLifeDays: 4, lastPracticedAt: now - DAY };
    expect(applyImplicitCredit(strong, IMPLICIT_CREDIT_FLOOR - 0.01, now)).toBe(strong);
  });
});

describe("shouldSkipImplicitCredit — struggling prerequisite guard", () => {
  test("absent signals preserve existing FIRe behavior", () => {
    expect(shouldSkipImplicitCredit(undefined, undefined)).toBe(false);
    expect(shouldSkipImplicitCredit({ correct: true }, undefined)).toBe(false);
    expect(shouldSkipImplicitCredit({ correct: true, firstKeyMs: 99_999 }, undefined)).toBe(false);
  });

  test("a last real miss blocks implicit credit", () => {
    expect(shouldSkipImplicitCredit({ correct: false }, 1_000)).toBe(true);
  });

  test("a slow last-attempt latency blocks only above 2x scholar baseline", () => {
    expect(shouldSkipImplicitCredit({ correct: true, firstKeyMs: 2_000 }, 1_000)).toBe(false);
    expect(shouldSkipImplicitCredit({ correct: true, firstKeyMs: 2_001 }, 1_000)).toBe(true);
    expect(IMPLICIT_CREDIT_SLOW_LATENCY_MULTIPLE).toBe(2);
  });
});
