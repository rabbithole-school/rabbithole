import { describe, expect, test } from "vitest";
import { generateItem, generateSet } from "../practice/templates";

// B4 (raise-the-ceiling §5): the fact-band generators over-sample the
// historically hard facts (6×7, 7×8, 8×8, 9×6, 9×7) ~3×, without ever leaving
// the band. These tests assert both: the domain is unchanged (every item is a
// valid in-band product) and the distribution is biased toward the hard facts.
//
// NOTE: generateSet dedupes by stem, so it can't measure the weighted
// DISTRIBUTION (each distinct fact would appear once). We sample WITH
// replacement via generateItem across many seeds for the distribution test.

const HARD = new Set(["6x7", "7x8", "8x8", "9x6", "9x7"]);
const key = (a: number, b: number) => (a <= b ? `${a}x${b}` : `${b}x${a}`);

function parseFactStem(stem: string): { f: number; b: number } {
  const m = stem.match(/(\d+)\s*×\s*(\d+)/);
  if (!m) throw new Error(`not a fact stem: ${stem}`);
  return { f: Number(m[1]), b: Number(m[2]) };
}

function sampleBand(skillKey: string, n: number): Array<{ f: number; b: number }> {
  const out: Array<{ f: number; b: number }> = [];
  for (let i = 0; i < n; i++) {
    const item = generateItem(skillKey, 1000 + i * 2654435761);
    if (item) out.push(parseFactStem(item.stem));
  }
  return out;
}

describe("fact-band hard-fact weighting (B4)", () => {
  test("mult_facts_7_8_9 only ever produces in-band facts", () => {
    const items = generateSet("mult_facts_7_8_9", 300, 99);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      const { f, b } = parseFactStem(it.stem);
      expect([7, 8, 9]).toContain(f);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(10);
      expect(it.answer).toEqual({ type: "integer", value: f * b });
    }
  });

  test("hard facts are over-represented vs. a uniform baseline (sampled w/ replacement)", () => {
    // Band 7·8·9 × [0..10] = 33 cells; the reachable hard pairs are
    // {7,8},{8,8},{6,9}→9×6,{7,9}→9×7,{6,7}→7×6. A UNIFORM draw lands on a hard
    // cell ~ 5/33 ~ 0.15; with 3x weighting the hard share climbs to ~0.28+.
    const draws = sampleBand("mult_facts_7_8_9", 3000);
    const hard = draws.filter(({ f, b }) => HARD.has(key(f, b))).length;
    const share = hard / draws.length;
    expect(share).toBeGreaterThan(0.24);
    expect(share).toBeLessThan(0.6);
  });

  test("a band with no hard facts (0·1·2·5·10) still generates valid facts", () => {
    const items = generateSet("mult_facts_0_1_2_5_10", 200, 3);
    for (const it of items) {
      const { f, b } = parseFactStem(it.stem);
      expect([0, 1, 2, 5, 10]).toContain(f);
      expect(it.answer).toEqual({ type: "integer", value: f * b });
    }
  });
});
