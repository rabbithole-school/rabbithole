import { describe, expect, it, test } from "vitest";
import {
  buildPlacementRevealLine,
  strategyRevealLine,
  workedStepsRevealLine,
  revealLineNumbersOk,
  verifyRevealLine,
  extractNumbers,
  pickTier2Line,
  TIER2_REVEAL_LINES,
} from "../lib/practice/revealLine";
import { allTemplatedSkillKeys, generateItem } from "../lib/practice/templates";
import { formatAnswerForDisplay } from "../lib/practice/answers";

/**
 * The PLACEMENT WARMTH FLOOR (ruling-placement-idk.html Option F, two-tier).
 * These pin the invariants the floor promises — "never cold, never wrong":
 *   • FAMILY COVERAGE — every registered generator family yields a non-empty
 *     reveal line (Tier 1 or Tier 2), never an empty string.
 *   • S8 operand-substitution ban — a generated/templated line's numbers are the
 *     ITEM's numbers (operands / answer / a value reached by arithmetic on them),
 *     never a foreign operand.
 *   • The verification gate rejects an intentionally-wrong (foreign-number) line.
 */

// The item's OWN numbers — everything a reveal line is allowed to reference
// (before arithmetic derivations): the stem's numbers + the answer's numbers.
function itemNumbers(skillKey: string, seed: number, form?: string): number[] {
  const item = generateItem(skillKey, seed, form);
  if (!item) return [];
  const ans = formatAnswerForDisplay(item.answer, item.choices);
  return [...extractNumbers(item.stem), ...extractNumbers(ans)];
}

describe("placement warmth floor — family coverage (never cold)", () => {
  const keys = allTemplatedSkillKeys();

  it("registers a non-trivial set of families", () => {
    expect(keys.length).toBeGreaterThan(20);
  });

  test.each(keys)("every family yields a non-empty reveal line: %s", (skillKey) => {
    for (const seed of [1, 7, 42, 1001, 999983]) {
      const item = generateItem(skillKey, seed);
      if (!item) continue;
      const answer = formatAnswerForDisplay(item.answer, item.choices);
      const line = buildPlacementRevealLine({
        kind: "template",
        correctAnswer: answer,
        workedSteps: item.workedSteps,
        stem: item.stem,
        variant: item.variant,
        form: item.form,
        seed,
      });
      expect(line.text.trim().length).toBeGreaterThan(0);
      expect([1, 2]).toContain(line.tier);

      // The missing-operand FORM (where a family supports it) must also be warm.
      const missing = generateItem(skillKey, seed, "missing");
      if (missing && missing.form === "missing") {
        const mAns = formatAnswerForDisplay(missing.answer, missing.choices);
        const mLine = buildPlacementRevealLine({
          kind: "template",
          correctAnswer: mAns,
          workedSteps: missing.workedSteps,
          stem: missing.stem,
          variant: missing.variant,
          form: missing.form,
          seed,
        });
        expect(mLine.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("a manipulative probe (no answer string) still gets a warm Tier-2 line", () => {
    const line = buildPlacementRevealLine({ kind: "manipulative", correctAnswer: null, seed: 3 });
    expect(line.tier).toBe(2);
    expect(line.text.trim().length).toBeGreaterThan(0);
  });

  it("a stored item with no line and no worked steps falls to Tier 2, never empty", () => {
    const line = buildPlacementRevealLine({
      kind: "stored",
      correctAnswer: "12",
      storedRevealLine: null,
      seed: 5,
    });
    expect(line.tier).toBe(2);
    expect(line.source).toBe("generic");
    expect(line.text.trim().length).toBeGreaterThan(0);
  });
});

describe("placement warmth floor — tier precedence", () => {
  it("prefers a stored (pre-verified) line over everything (Tier 1c)", () => {
    const line = buildPlacementRevealLine({
      kind: "stored",
      correctAnswer: "12",
      storedRevealLine: "Three groups of 4 is 12.",
      workedSteps: [{ text: "should be ignored" }],
      seed: 1,
    });
    expect(line).toMatchObject({ tier: 1, source: "stored", text: "Three groups of 4 is 12." });
  });

  it("uses worked steps when present (Tier 1a)", () => {
    const line = buildPlacementRevealLine({
      kind: "template",
      correctAnswer: "83",
      workedSteps: [{ text: "Break by place value." }, { text: "45 + 38 = 83." }],
      seed: 1,
    });
    expect(line).toMatchObject({ tier: 1, source: "workedSteps" });
    expect(line.text).toContain("45 + 38 = 83.");
  });

  it("uses an authored strategy line for a bare fact (Tier 1b)", () => {
    const line = buildPlacementRevealLine({
      kind: "template",
      correctAnswer: "56",
      stem: "7 × 8 = ?",
      variant: { a: 7, op: "×", b: 8 },
      seed: 1,
    });
    expect(line).toMatchObject({ tier: 1, source: "strategy" });
    expect(line.text).toContain("56");
  });
});

describe("strategyRevealLine — correct-by-construction", () => {
  it("frames multiplication as groups", () => {
    expect(strategyRevealLine({ correctAnswer: "56", variant: { a: 7, op: "×", b: 8 } })).toBe(
      "That's 7 groups of 8, which makes 56.",
    );
  });
  it("frames addition as counting forward from the bigger operand", () => {
    expect(strategyRevealLine({ correctAnswer: "13", variant: { a: 5, op: "+", b: 8 } })).toBe(
      "Start at 8 and count forward 5 steps to reach 13.",
    );
  });
  it("frames subtraction as taking away", () => {
    expect(strategyRevealLine({ correctAnswer: "9", variant: { a: 14, op: "−", b: 5 } })).toBe(
      "Take away 5 from 14 to get 9.",
    );
  });
  it("fills the blank for a missing-operand item", () => {
    expect(
      strategyRevealLine({ correctAnswer: "7", stem: "? × 8 = 56", form: "missing" }),
    ).toBe("The missing number is 7, because 7 × 8 = 56.");
  });
  it("recovers a fact strategy from a bare 'a op b = ?' stem (no variant needed)", () => {
    expect(strategyRevealLine({ correctAnswer: "7", stem: "6 + 1 = ?" })).toBe(
      "Start at 6 and count forward 1 step to reach 7.",
    );
    expect(strategyRevealLine({ correctAnswer: "50", stem: "10 × 5 = ?" })).toBe(
      "That's 10 groups of 5, which makes 50.",
    );
    expect(strategyRevealLine({ correctAnswer: "2", stem: "3 − 1 = ?" })).toBe(
      "Take away 1 from 3 to get 2.",
    );
  });
  it("returns null for an item it can't safely address", () => {
    expect(strategyRevealLine({ correctAnswer: "5", stem: "Which is greater, 3 or 5?" })).toBeNull();
  });
});

describe("workedStepsRevealLine", () => {
  it("joins step text into one mini-lesson", () => {
    expect(workedStepsRevealLine([{ text: "Step one." }, { text: "Step two." }])).toBe(
      "Step one. Step two.",
    );
  });
  it("returns null with no steps", () => {
    expect(workedStepsRevealLine([])).toBeNull();
    expect(workedStepsRevealLine(undefined)).toBeNull();
  });
});

describe("S8 operand-substitution ban", () => {
  it("extracts numeric tokens (including a fraction's parts)", () => {
    expect(extractNumbers("8×8=64")).toEqual([8, 8, 64]);
    expect(extractNumbers("answer 3/4")).toEqual([3, 4]);
  });

  it("permits the item's own numbers and one-step derivations", () => {
    // 64 = 8×8 (derived from an operand); 56 = 7×8 (the answer).
    expect(revealLineNumbersOk("56 — one 7 less than 8×8=64", [7, 8, 56])).toBe(true);
    expect(revealLineNumbersOk("That's 7 groups of 8, which makes 56.", [7, 8, 56])).toBe(true);
  });

  it("rejects a foreign operand from a different example", () => {
    expect(revealLineNumbersOk("the answer is 100 because 5 × 20", [7, 8, 56])).toBe(false);
  });

  it("holds for every generated multiplication-fact strategy line", () => {
    for (const seed of [1, 2, 3, 4, 5, 99, 12345]) {
      const skillKey = "mult_facts_7_8_9";
      const item = generateItem(skillKey, seed);
      if (!item || !item.variant) continue;
      const answer = formatAnswerForDisplay(item.answer, item.choices);
      const line = strategyRevealLine({ correctAnswer: answer, variant: item.variant, stem: item.stem });
      if (!line) continue;
      expect(revealLineNumbersOk(line, itemNumbers(skillKey, seed))).toBe(true);
    }
  });

  it("holds for missing-operand fill-in lines", () => {
    for (const seed of [1, 5, 9, 77]) {
      for (const skillKey of ["add_within_20_regroup", "subtract_within_20", "mult_facts_3_4_6"]) {
        const item = generateItem(skillKey, seed, "missing");
        if (!item || item.form !== "missing") continue;
        const answer = formatAnswerForDisplay(item.answer, item.choices);
        const line = strategyRevealLine({ correctAnswer: answer, stem: item.stem, form: "missing" });
        if (!line) continue;
        expect(revealLineNumbersOk(line, itemNumbers(skillKey, seed, "missing"))).toBe(true);
      }
    }
  });
});

describe("verifyRevealLine — the Tier-1c generation gate", () => {
  it("accepts a line using only the item's numbers + derivations", () => {
    expect(verifyRevealLine("Three baskets of 4 apples is 3 groups of 4, which makes 12.", [3, 4, 12]))
      .toEqual({ ok: true });
  });

  it("REJECTS an intentionally-wrong line with a foreign number", () => {
    const r = verifyRevealLine("The answer is 30 — just add 7 and 23.", [3, 4, 12]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/foreign number/i);
  });

  it("rejects empty, over-long, and Markdown lines", () => {
    expect(verifyRevealLine("  ", [3, 4, 12]).ok).toBe(false);
    expect(verifyRevealLine("x".repeat(500), [3, 4, 12]).ok).toBe(false);
    expect(verifyRevealLine("**bold** 12", [3, 4, 12]).ok).toBe(false);
  });
});

describe("pickTier2Line", () => {
  it("is deterministic and rotates over the fixed set", () => {
    expect(pickTier2Line(0)).toBe(TIER2_REVEAL_LINES[0]);
    expect(pickTier2Line(0)).toBe(pickTier2Line(0));
    expect(pickTier2Line(-3)).toBe(pickTier2Line(-3 + TIER2_REVEAL_LINES.length));
    for (let s = 0; s < 20; s++) expect(pickTier2Line(s).length).toBeGreaterThan(0);
  });
});
