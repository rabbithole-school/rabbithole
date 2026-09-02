import { describe, expect, it } from "vitest";
import { hintForSkill } from "./mathPracticeHints";

const GENERIC_HINT = "Read the question again slowly. What exactly is it asking you to find?";

const coveredSkillKeys = [
  "exponents_repeated_mult",
  "gcf",
  "lcm",
  "divisibility_rules_3_9",
  "divisibility_rules_2_5_10",
  "prime_composite",
  "prime_or_composite",
  "prime_factorization",
  "factors_and_multiples",
  "factor_pairs",
  "is_factor",
  "is_multiple",
  "equivalent_fractions_general",
  "equivalent_fractions_visual",
  "common_denominators",
  "unit_fraction",
  "whole_as_fraction",
  "mixed_improper",
  "partition_shapes",
  "fraction_as_parts",
  "fraction_number_line",
  "fraction_as_division",
  "add_subtract_like",
  "add_subtract_unlike",
  "add_subtract_properties",
  "mult_commutative_associative",
  "mult_distributive",
  "compare_same_denominator",
  "compare_same_numerator",
  "compare_benchmarks",
  "compare_unlike",
  "multiply_fraction_by_whole",
  "multiply_fractions",
  "divide_fractions",
  "divide_unit_fractions",
  "probability_as_fraction",
];

describe("hintForSkill", () => {
  it("has non-generic hints for registered edge and fraction skills", () => {
    for (const key of coveredSkillKeys) {
      const hint = hintForSkill(key);
      expect(hint, key).not.toBe(GENERIC_HINT);
      expect(hint.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("nudges exponents toward repeated multiplication, not multiplying by the exponent", () => {
    const hint = hintForSkill("exponents_repeated_mult");

    expect(hint.toLowerCase()).toMatch(/multiply|times itself/);
    expect(hint).not.toMatch(/[×x]\s*3\b/);
  });

  // Regression: the whole-number `add_`/`compare_` prefix matchers must NOT
  // capture fraction skills and hand them a place-value / tens-and-ones strategy.
  it("gives fraction add/subtract a fraction strategy, not a tens-and-ones one", () => {
    for (const key of ["add_subtract_like", "add_subtract_unlike"]) {
      const hint = hintForSkill(key).toLowerCase();
      expect(hint, key).not.toMatch(/tens/);
      expect(hint, key).toMatch(/bottom|denominator|top/);
    }
  });

  it("gives fraction comparisons a fraction strategy, not a place-value one", () => {
    for (const key of [
      "compare_same_denominator",
      "compare_same_numerator",
      "compare_benchmarks",
      "compare_unlike",
    ]) {
      const hint = hintForSkill(key).toLowerCase();
      expect(hint, key).not.toMatch(/place value/);
      expect(hint, key).toMatch(/bottom|top|half|denominator/);
    }
  });

  // Regression: a "how many dots?" cardinality item must get the touch-each-dot
  // hint, not the "what number comes next" counting-sequence hint.
  it("gives count-the-objects items a cardinality hint", () => {
    expect(hintForSkill("count_objects_within_10").toLowerCase()).toMatch(/dot|count/);
  });

  it("keeps the generic fallback for unknown skill keys", () => {
    expect(hintForSkill("totally_made_up_key")).toBe(GENERIC_HINT);
  });
});
