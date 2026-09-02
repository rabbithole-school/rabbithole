import { describe, expect, test } from "vitest";
import {
  generateItem,
  hasTemplate,
} from "../practice/templates";
import { makeItemId, parseItemId, gradeTemplateItem, buildSession } from "../practice/session";
import { formatAnswer } from "../practice/answers";

// C1 (§6): the missing-operand FORM variant — inverse thinking on the same
// fact ("? × 8 = 56"). The anti-cheat contract is that grading RE-DERIVES the
// exact served item from the itemId (which now encodes the form), so these
// tests prove round-trip correctness + determinism + safe fallback.

const VARIANT_SKILLS = [
  "mult_facts_7_8_9",
  "mult_facts_3_4_6",
  "mult_2digit_by_1digit",
  "add_within_20_regroup",
  "subtract_within_20",
];

/** Parse a missing-operand stem and check the answer completes the equation. */
function equationHolds(stem: string, answerValue: number): boolean {
  const m = stem.match(/^(\?|-?\d+)\s*([+\u2212×])\s*(\?|-?\d+)\s*=\s*(-?\d+)$/);
  if (!m) return false;
  const [, lhs, op, rhs, resStr] = m;
  const left = lhs === "?" ? answerValue : Number(lhs);
  const right = rhs === "?" ? answerValue : Number(rhs);
  const result = Number(resStr);
  const computed = op === "+" ? left + right : op === "\u2212" ? left - right : left * right;
  return computed === result && (lhs === "?" || rhs === "?");
}

describe("form variants — itemId encoding round-trips (C1)", () => {
  test("makeItemId/parseItemId carry the form (and stay backward-compatible)", () => {
    expect(parseItemId(makeItemId("mult_facts_7_8_9", 123))).toEqual({
      skillKey: "mult_facts_7_8_9",
      seed: 123,
      form: undefined,
    });
    expect(parseItemId(makeItemId("mult_facts_7_8_9", 123, "missing"))).toEqual({
      skillKey: "mult_facts_7_8_9",
      seed: 123,
      form: "missing",
    });
    // a gen# stored-item id must NOT parse as a template item
    expect(parseItemId("gen#k1739xyz")).toBeNull();
  });

  test("missing-operand items are mathematically correct + grade-consistent", () => {
    for (const key of VARIANT_SKILLS) {
      let sawMissing = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const item = generateItem(key, seed, "missing");
        expect(item).not.toBeNull();
        expect(item!.form).toBe("missing");
        expect(item!.answerType).toBe("integer");
        expect(item!.stem).toContain("?");
        const value = item!.answer.type === "integer" ? item!.answer.value : NaN;
        // the hidden operand actually completes the equation
        expect(equationHolds(item!.stem, value)).toBe(true);
        // and grading the itemId re-derives the SAME item: correct answer passes,
        // a wrong one fails (anti-cheat re-derivation from the form-encoded id)
        const itemId = makeItemId(key, seed, "missing");
        expect(gradeTemplateItem(itemId, formatAnswer(item!.answer))!.correct).toBe(true);
        expect(gradeTemplateItem(itemId, String(value + 1))!.correct).toBe(false);
        sawMissing++;
      }
      expect(sawMissing).toBe(60);
    }
  });

  test("generateItem is deterministic in (seed, form)", () => {
    for (const key of VARIANT_SKILLS) {
      const a = generateItem(key, 4242, "missing");
      const b = generateItem(key, 4242, "missing");
      expect(a).toEqual(b);
    }
  });

  test("a skill with NO variant falls back to the direct item (form absent)", () => {
    // count_to_10 is templated but declares no variant → "missing" is ignored.
    expect(hasTemplate("count_to_10")).toBe(true);
    const direct = generateItem("count_to_10", 7);
    const asked = generateItem("count_to_10", 7, "missing");
    expect(asked!.form).toBeUndefined();
    expect(asked!.stem).toBe(direct!.stem);
    // and grading a "missing"-tagged id for it re-derives the same direct item
    expect(
      gradeTemplateItem(makeItemId("count_to_10", 7, "missing"), formatAnswer(direct!.answer))!
        .correct,
    ).toBe(true);
  });

  test("buildSession serves form variants and they grade correctly", () => {
    // formFor forces "missing" for the variant skill; the served itemIds encode
    // it and grade round-trips.
    const served = buildSession(
      VARIANT_SKILLS.map((k) => ({ key: k, label: k })),
      20,
      99,
      (key) => (key === "mult_facts_7_8_9" ? "missing" : undefined),
    );
    const missingItems = served.filter((s) => s.itemId.endsWith("#missing"));
    expect(missingItems.length).toBeGreaterThan(0);
    for (const it of missingItems) {
      expect(it.skillKey).toBe("mult_facts_7_8_9");
      expect(it.stem).toContain("?");
      // grade it: re-derive the correct answer from the id and confirm it passes
      const truth = gradeTemplateItem(it.itemId, "0");
      expect(gradeTemplateItem(it.itemId, truth!.correctAnswer)!.correct).toBe(true);
    }
  });
});
