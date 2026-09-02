import { describe, expect, test } from "vitest";
import { formatAnswer } from "../lib/practice/answers";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import {
  COMPARE_CHOICES,
  generateItem,
  hasTemplate,
  type PracticeItem,
} from "../lib/practice/templates";
import {
  FRACTION_ARITHMETIC_DOMAIN,
  FRACTION_ARITHMETIC_EDGES,
  FRACTION_ARITHMETIC_SKILLS,
} from "../seed/fractionArithmeticGraph";
import { gradeRank } from "../lib/practice/placement";

/**
 * The decimals strand (fraction-arithmetic) — the #881/#888 pretest-audit
 * follow-up that gave decimal operations first-class knowledge-graph nodes.
 * Guards three invariants:
 *
 *   1. Every decimals node is templated (hasTemplate gates placement probing),
 *      deterministic, and grader-round-trips.
 *   2. THE #881 RULE: every typed decimal answer stays within 2 decimal places
 *      across a wide seed sweep — a regression here re-creates the exact
 *      "computation slip reads as a conceptual miss" failure the audit found.
 *   3. The strand's intra-domain spine and its cross-domain hard prerequisites
 *      exist and are grade-forward (never strand an earlier node behind later
 *      work).
 */

const DECIMAL_SKILLS = FRACTION_ARITHMETIC_SKILLS.filter((s) => s.strand === "decimals");
const DECIMAL_KEYS = DECIMAL_SKILLS.map((s) => s.skillKey);

function requiredItem(skillKey: string, seed: number): PracticeItem {
  const item = generateItem(skillKey, seed);
  expect(item, `${skillKey} seed=${seed}`).not.toBeNull();
  if (!item) throw new Error(`Missing decimals template: ${skillKey}`);
  return item;
}

function graderSubmission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice"
    ? String(item.answer.choiceIndex)
    : formatAnswer(item.answer);
}

function numericAnswer(item: PracticeItem): number {
  if (item.answer.type !== "integer" && item.answer.type !== "decimal") {
    throw new Error(`expected numeric answer for ${item.skillKey}: ${item.stem}`);
  }
  return item.answer.value;
}

describe("decimals strand — graph shape", () => {
  test("the six decimal-operations nodes exist with the expected grades and CCSS tags", () => {
    expect(FRACTION_ARITHMETIC_DOMAIN).toBe("fraction-arithmetic");
    const byKey = new Map(DECIMAL_SKILLS.map((s) => [s.skillKey, s]));
    expect([...byKey.keys()].sort()).toEqual([
      "add_subtract_decimals",
      "compare_decimals",
      "decimal_notation_fractions",
      "decimal_place_value_round",
      "divide_decimals",
      "multiply_decimals",
    ]);
    expect(byKey.get("decimal_notation_fractions")?.grade).toBe("4");
    expect(byKey.get("decimal_notation_fractions")?.ccCodes).toContain("4.NF.C.6");
    expect(byKey.get("compare_decimals")?.grade).toBe("4");
    expect(byKey.get("compare_decimals")?.ccCodes).toContain("4.NF.C.7");
    expect(byKey.get("decimal_place_value_round")?.grade).toBe("5");
    expect(byKey.get("decimal_place_value_round")?.ccCodes).toContain("5.NBT.A.4");
    expect(byKey.get("add_subtract_decimals")?.grade).toBe("5");
    expect(byKey.get("add_subtract_decimals")?.ccCodes).toContain("5.NBT.B.7");
    expect(byKey.get("multiply_decimals")?.grade).toBe("5");
    expect(byKey.get("multiply_decimals")?.ccCodes).toContain("5.NBT.B.7");
    expect(byKey.get("divide_decimals")?.grade).toBe("6");
    expect(byKey.get("divide_decimals")?.ccCodes).toContain("6.NS.B.3");
  });

  test("the intra-strand spine roots at fraction_as_parts and orders the operations", () => {
    for (const edge of [
      { fromKey: "fraction_as_parts", toKey: "decimal_notation_fractions" },
      { fromKey: "decimal_notation_fractions", toKey: "compare_decimals" },
      { fromKey: "decimal_notation_fractions", toKey: "decimal_place_value_round" },
      { fromKey: "compare_decimals", toKey: "decimal_place_value_round" },
      { fromKey: "decimal_place_value_round", toKey: "add_subtract_decimals" },
      { fromKey: "add_subtract_decimals", toKey: "multiply_decimals" },
      { fromKey: "multiply_decimals", toKey: "divide_decimals" },
    ]) {
      expect(FRACTION_ARITHMETIC_EDGES).toContainEqual(edge);
    }
  });

  test("every edge into a decimals node is grade-forward (never grade-inverted)", () => {
    // Cross-domain grade-forwardness is asserted per-edge in
    // approvedCrossDomainEdges.test.ts; this locks the same invariant for the
    // whole strand so a future edge can't strand an earlier node behind later
    // work without failing here.
    const decimalKeySet = new Set(DECIMAL_KEYS);
    const gradeOf = new Map(FRACTION_ARITHMETIC_SKILLS.map((s) => [s.skillKey, s.grade]));
    // Foreign (whole-number-arithmetic) sources, with their grades pinned —
    // pinning here means a WNA re-grade that inverts one of these edges is
    // caught by approvedCrossDomainEdges.test.ts, while a typo'd source key
    // is caught by the combined-graph validator.
    for (const e of FRACTION_ARITHMETIC_EDGES) {
      if (!decimalKeySet.has(e.toKey)) continue;
      const from = gradeOf.get(e.fromKey);
      if (from === undefined) continue; // cross-domain — covered elsewhere
      expect(
        gradeRank(from),
        `${e.fromKey} (g${from}) → ${e.toKey} must be grade-forward`,
      ).toBeLessThanOrEqual(gradeRank(gradeOf.get(e.toKey) ?? ""));
    }
  });
});

describe("decimals strand — deterministic templates", () => {
  test("every decimals node has a template (hasTemplate gates placement probing)", () => {
    expect(DECIMAL_KEYS).toHaveLength(6);
    for (const skillKey of DECIMAL_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
    }
  });

  test("generateItem is deterministic for every skill and seed", () => {
    for (const skillKey of DECIMAL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(
          generateItem(skillKey, seed),
        );
      }
    }
  });

  test("every generated answer round-trips through its own grader", () => {
    for (const skillKey of DECIMAL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed);
        const result = gradeTemplateItem(makeItemId(skillKey, seed), graderSubmission(item));
        expect(result, `${skillKey} seed=${seed}`).not.toBeNull();
        expect(result?.correct, `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("THE #881 RULE: every typed decimal answer stays within 2 decimal places", () => {
    const decimalPlaces = (value: number): number =>
      (String(value).split(".")[1] ?? "").length;
    for (const skillKey of DECIMAL_KEYS) {
      for (let seed = 1; seed <= 200; seed++) {
        const item = requiredItem(skillKey, seed);
        if (item.answerType === "multipleChoice") continue; // compare_decimals
        expect(
          decimalPlaces(numericAnswer(item)),
          `${skillKey} seed=${seed}: ${item.stem} → ${formatAnswer(item.answer)}`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  test("compare_decimals uses the shared comparison choice set and varies its answer", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const item = requiredItem("compare_decimals", seed);
      expect(item.answerType).toBe("multipleChoice");
      expect(item.choices).toEqual(COMPARE_CHOICES);
      if (item.answer.type === "multipleChoice") seen.add(item.answer.choiceIndex);
    }
    // Less-than, equal, AND greater-than must all occur — a fixed correct
    // label is the exact learnable-tell defect #881 fixed on the spread item.
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  test("each operation item tests ITS construct (answers match the stated operation)", () => {
    // Recompute the expected answer from the STEM, so a template edit can't
    // silently drift the answer away from the displayed problem.
    const binary = (stem: string): { a: number; op: string; b: number } | null => {
      const m = stem.match(/^(-?[\d.]+)\s*([+−×÷])\s*(-?[\d.]+)\s*= \?$/);
      return m ? { a: Number(m[1]), op: m[2], b: Number(m[3]) } : null;
    };
    const EPS = 1e-9;
    for (const skillKey of ["add_subtract_decimals", "multiply_decimals", "divide_decimals"]) {
      for (let seed = 1; seed <= 100; seed++) {
        const item = requiredItem(skillKey, seed);
        const parsed = binary(item.stem);
        expect(parsed, `${skillKey} seed=${seed}: unparseable stem "${item.stem}"`).not.toBeNull();
        if (!parsed) continue;
        const expected =
          parsed.op === "+"
            ? parsed.a + parsed.b
            : parsed.op === "−"
              ? parsed.a - parsed.b
              : parsed.op === "×"
                ? parsed.a * parsed.b
                : parsed.a / parsed.b;
        expect(
          Math.abs(numericAnswer(item) - expected),
          `${skillKey} seed=${seed}: ${item.stem} → ${formatAnswer(item.answer)}`,
        ).toBeLessThan(EPS);
      }
    }
  });
});
