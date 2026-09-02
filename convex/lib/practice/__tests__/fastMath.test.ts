/**
 * The Fast Math roll-up — chiefly the DENOMINATOR, which is the load-bearing
 * decision in the whole feature: it is what makes "100%" mean the whole fact
 * space rather than "the facts this scholar happened to touch".
 */

import { describe, it, expect } from "vitest";
import {
  FAST_MATH_MAX_OPERAND,
  fastMathDenominator,
  fastMathFactKeys,
  fastMathProgress,
  isFastMathAutomatic,
} from "../fastMath";
import type { FactFluencyStats } from "../factFluency";
import {
  FACT_FAMILY_SKILLS,
  factBelongsToFamily,
  parseFactKey,
} from "../../../../shared/factKey";

// A fact the classifier will call `automatic`: near-perfect and well under the
// scholar's own baseline.
const AUTOMATIC: FactFluencyStats = {
  seenCount: 12,
  correctCount: 12,
  latencySamplesMs: [700, 720, 740],
  latencyMedianMs: 720,
};
const BASELINE_MS = 4000;

function allAutomatic(): Map<string, FactFluencyStats> {
  const map = new Map<string, FactFluencyStats>();
  for (const factKey of fastMathFactKeys()) map.set(factKey, AUTOMATIC);
  return map;
}

describe("the canonical Fast Math denominator", () => {
  it("is exactly the 418 facts the quick-facts generator space can serve", () => {
    // 121 addition (a+b ≤ 20, unordered) + 231 subtraction (0 ≤ b ≤ a ≤ 20)
    // + 66 multiplication (unordered pairs from 0…10) = 418. Pinned so a
    // template change that widens or narrows the served space has to come
    // through this test rather than silently moving what 100% means.
    expect(fastMathDenominator()).toBe(418);
    expect(fastMathFactKeys()).toHaveLength(418);
  });

  it("holds no duplicates and only canonical, servable facts", () => {
    const keys = fastMathFactKeys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const factKey of keys) {
      const parsed = parseFactKey(factKey);
      expect(parsed).not.toBeNull();
      expect(parsed!.a).toBeLessThanOrEqual(FAST_MATH_MAX_OPERAND);
      expect(parsed!.b).toBeLessThanOrEqual(FAST_MATH_MAX_OPERAND);
      expect(
        [...FACT_FAMILY_SKILLS].some((skillKey) =>
          factBelongsToFamily(factKey, skillKey),
        ),
      ).toBe(true);
    }
  });

  it("covers all three fact operations", () => {
    const ops = new Set(
      fastMathFactKeys().map((factKey) => parseFactKey(factKey)!.op),
    );
    expect(ops).toEqual(new Set(["add", "sub", "mul"]));
  });
});

describe("fastMathProgress", () => {
  it("partitions the canonical denominator by operation", () => {
    const progress = fastMathProgress({
      statsByFactKey: new Map(),
      baseline: BASELINE_MS,
    });
    expect(progress.byOperation.add.denominator).toBe(121);
    expect(progress.byOperation.sub.denominator).toBe(231);
    expect(progress.byOperation.mul.denominator).toBe(66);
    expect(
      Object.values(progress.byOperation).reduce(
        (sum, slice) => sum + slice.denominator,
        0,
      ),
    ).toBe(progress.denominator);
    expect(progress.facts).toHaveLength(progress.denominator);
    expect(new Set(progress.facts.map((fact) => fact.factKey)).size).toBe(
      progress.denominator,
    );
  });

  it("measures overlapping fact families independently", () => {
    const statsByFactKey = new Map<string, FactFluencyStats>([
      ["mul:3x7", AUTOMATIC],
    ]);
    const progress = fastMathProgress({ statsByFactKey, baseline: BASELINE_MS });
    expect(progress.byFamily.mult_facts_3_4_6.automaticCount).toBe(1);
    expect(progress.byFamily.mult_facts_7_8_9.automaticCount).toBe(1);
    expect(progress.byFamily.mult_facts_0_1_2_5_10.automaticCount).toBe(0);
  });

  it("reads 0% for a scholar with no fact history — never 'no data'", () => {
    const progress = fastMathProgress({
      statsByFactKey: new Map(),
      baseline: BASELINE_MS,
    });
    expect(progress.automaticCount).toBe(0);
    expect(progress.percent).toBe(0);
    expect(progress.ready).toBe(false);
    expect(progress.denominator).toBe(fastMathDenominator());
    expect(progress.facts.every((fact) => fact.state === "unseen")).toBe(true);
  });

  it("counts UNSEEN facts against the percent — one drilled fact is not 100%", () => {
    const statsByFactKey = new Map<string, FactFluencyStats>();
    statsByFactKey.set(fastMathFactKeys()[0], AUTOMATIC);
    const progress = fastMathProgress({ statsByFactKey, baseline: BASELINE_MS });
    expect(progress.automaticCount).toBe(1);
    expect(progress.ready).toBe(false);
    expect(progress.percent).toBe(0); // 1/418 floors to 0%
  });

  it("reaches 100% and ready only when EVERY canonical fact is automatic", () => {
    const progress = fastMathProgress({
      statsByFactKey: allAutomatic(),
      baseline: BASELINE_MS,
    });
    expect(progress.automaticCount).toBe(fastMathDenominator());
    expect(progress.percent).toBe(100);
    expect(progress.ready).toBe(true);
    expect(progress.byOperation.add.percent).toBe(100);
    expect(progress.byFamily.add_within_5.percent).toBe(100);
  });

  it("caps a nearly-complete ledger at 99% so rounding can never read as ready", () => {
    const statsByFactKey = allAutomatic();
    statsByFactKey.delete(fastMathFactKeys()[0]);
    const progress = fastMathProgress({ statsByFactKey, baseline: BASELINE_MS });
    // 417/418 = 99.76%
    expect(progress.percent).toBe(99);
    expect(progress.ready).toBe(false);
  });

  it("reads 0% with no latency baseline — an uncalibrated scholar makes no speed claim", () => {
    const progress = fastMathProgress({
      statsByFactKey: allAutomatic(),
      baseline: undefined,
    });
    expect(progress.automaticCount).toBe(0);
    expect(progress.ready).toBe(false);
  });

  it("does not count accuracy alone — a correct-but-slow ledger is not automatic", () => {
    const slow: FactFluencyStats = {
      seenCount: 12,
      correctCount: 12,
      latencySamplesMs: [9000, 9200, 9400],
      latencyMedianMs: 9200,
    };
    const statsByFactKey = new Map<string, FactFluencyStats>();
    for (const factKey of fastMathFactKeys()) statsByFactKey.set(factKey, slow);
    const progress = fastMathProgress({ statsByFactKey, baseline: BASELINE_MS });
    expect(progress.automaticCount).toBe(0);
    expect(progress.percent).toBe(0);
  });
});

describe("automaticity bar", () => {
  it("counts fluent and automatic, and nothing below them", () => {
    expect(isFastMathAutomatic("automatic")).toBe(true);
    expect(isFastMathAutomatic("fluent")).toBe(true);
    expect(isFastMathAutomatic("practicing")).toBe(false);
    expect(isFastMathAutomatic("effortful")).toBe(false);
    expect(isFastMathAutomatic("unseen")).toBe(false);
  });
});
