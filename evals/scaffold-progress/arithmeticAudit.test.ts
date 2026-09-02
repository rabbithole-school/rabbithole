/**
 * The ARITHMETIC + PROVENANCE axes' own tests.
 *
 * Two things need proving about a tightened checker. First, that it accepts the
 * scaffolds it should — a sweep that fails everything is as useless as one that
 * passes everything. Second, and harder, that it has TEETH: the old sweep's
 * "a new number appears" heuristic passed every one of the corrupted scaffolds
 * below, which is the whole reason this module exists.
 *
 * The MUTATION PINS at the bottom measure that second property over the real
 * corpus: bump one digit anywhere in any step and the audit must notice. They
 * are the guard against this checker quietly decaying into another rubber
 * stamp.
 */
import { describe, expect, it } from "vitest";
import { formatAnswer } from "../../convex/lib/practice/answers";
import { generateItem } from "../../convex/lib/practice/templates";
import type { WorkedStep } from "../../convex/lib/practice/fadedSteps";
import { auditArithmetic } from "./arithmeticAudit";
import { HARD_FAILURES, auditScaffold } from "./scaffoldProgress";
import { SCAFFOLDED_FAMILIES, SEED_STRIDE } from "./sweep";

const steps = (...texts: string[]): WorkedStep[] =>
  texts.map((text, i) => ({ text, blankText: `step ${i + 1}: ?` }));

describe("arithmetic correctness", () => {
  it("passes a scaffold whose every claim is true and reaches the answer", () => {
    const audit = auditArithmetic(
      "664 × 2 = ?",
      "1328",
      steps(
        "Break 664 apart by place value: 600 + 60 + 4.",
        "Multiply each part by 2: 600 × 2 = 1200, 60 × 2 = 120, 4 × 2 = 8.",
        "Add the partial products: 1200 + 120 + 8 = 1328.",
      ),
    );
    expect(audit.arithmetic).toBe("pass");
    expect(audit.provenance).toBe("pass");
    expect(audit.issues).toEqual([]);
  });

  it("FAILS a step whose arithmetic is simply wrong", () => {
    // The old sweep passed this: every step introduces a new number, the final
    // step embeds the answer, nothing leaks. It is still nonsense.
    const audit = auditArithmetic(
      "664 × 2 = ?",
      "1328",
      steps(
        "Break 664 apart by place value: 600 + 60 + 4.",
        "Multiply each part by 2: 600 × 2 = 1300, 60 × 2 = 120, 4 × 2 = 8.",
        "Add the partial products: 1200 + 120 + 8 = 1328.",
      ),
    );
    expect(audit.arithmetic).toBe("fail");
    expect(audit.issues.map((i) => i.kind)).toContain("false-equation");
    const wrong = audit.issues.find((i) => i.kind === "false-equation");
    expect(wrong?.step).toBe(2);
  });

  it("FAILS a scaffold that never reaches the item's own answer", () => {
    // Each step below is locally true. The scaffold still solves a different
    // problem than the one asked, which only an end-to-end check can see.
    const audit = auditArithmetic(
      "664 × 2 = ?",
      "1328",
      steps(
        "Break 664 apart by place value: 600 + 60 + 4.",
        "Multiply the biggest part by 2: 600 × 2 = 1200.",
      ),
    );
    expect(audit.arithmetic).toBe("fail");
    expect(audit.issues.map((i) => i.kind)).toContain("answer-not-derived");
  });

  it("FAILS a stats step that quietly alters the data set", () => {
    const audit = auditArithmetic(
      "Find the median of 7, 12, 14, 10, 9.",
      "10",
      steps("Put them in order: 7, 9, 11, 12, 14.", "The middle value is 10."),
    );
    expect(audit.arithmetic).toBe("fail");
    expect(audit.issues.map((i) => i.kind)).toContain("list-not-stem");
  });

  it("accepts a decimal-point placement as a real derivation", () => {
    const audit = auditArithmetic(
      "1.1 × 6 = ?",
      "6.6",
      steps(
        "Ignore the decimal points and multiply the digits: this gives 66.",
        "The factors have 1 place in total, so put the point 1 place into 66: 6.6.",
      ),
    );
    expect(audit.arithmetic).toBe("pass");
    expect(audit.derivation).toBe("notation");
  });

  it("is n/a when the answer is not a number at all", () => {
    const audit = auditArithmetic(
      "Which is heavier?",
      "the melon",
      steps("Compare the two masses."),
    );
    expect(audit.arithmetic).toBe("n/a");
  });
});

describe("operand provenance", () => {
  it("FAILS a number conjured out of nowhere", () => {
    // 15 is not in the stem and no earlier step produced it; the parts do not
    // recombine to 364 either, so the decomposition does not rescue it.
    const audit = auditArithmetic(
      "364 ÷ 4 = ?",
      "91",
      steps("Break 364 into chunks: 350 + 15.", "Divide each chunk, so 364 ÷ 4 = 91."),
    );
    expect(audit.provenance).toBe("fail");
    expect(audit.issues.map((i) => i.kind)).toContain("unexplained-number");
  });

  it("accepts the same shape when the chunks actually recombine", () => {
    const audit = auditArithmetic(
      "364 ÷ 4 = ?",
      "91",
      steps("Break 364 into chunks: 360 + 4.", "Divide each chunk, so 364 ÷ 4 = 91."),
    );
    expect(audit.provenance).toBe("pass");
  });

  it("FAILS an equation that balances but invents its right-hand side", () => {
    // 50 + 2 = 26 + 26 is TRUE. It is still not a step about this problem: the
    // 26s appear from nowhere, which arithmetic alone cannot see.
    const audit = auditArithmetic(
      "50 + 2 = ?",
      "52",
      steps("Regroup: 50 + 2 = 26 + 26.", "So 50 + 2 = 52."),
    );
    expect(audit.provenance).toBe("fail");
    expect(audit.issues.map((i) => i.kind)).toContain("unexplained-number");
  });

  it("traces a number back through an earlier step's result", () => {
    const audit = auditArithmetic(
      "24 × 13 = ?",
      "312",
      steps(
        "Multiply by the ones: 24 × 3 = 72.",
        "Multiply by the tens: 24 × 10 = 240.",
        "Add the partial products: 72 + 240 = 312.",
      ),
    );
    expect(audit.provenance).toBe("pass");
  });

  it("is n/a when the stem is not numerically self-contained", () => {
    // "A fair number cube" is six-sided by world knowledge, not by anything the
    // text says, so a 6 in the scaffold is not evidence of invention. Reporting
    // this as n/a is the honest call; failing it would be a false alarm.
    const audit = auditArithmetic(
      "A fair number cube is rolled. What is the probability of rolling a 4?",
      "1/6",
      steps("A number cube has 6 faces.", "Exactly 1 face shows a 4, so the chance is 1/6."),
    );
    expect(audit.provenance).toBe("n/a");
    expect(audit.basis).toBeNull();
  });
});

// ── Mutation pins ────────────────────────────────────────────────────────────

/** Bump the `nth` number in `text` by one, preserving its width. */
function bumpNthNumber(text: string, nth: number): string | null {
  let seen = 0;
  let out: string | null = null;
  text.replace(/\d+/g, (match, offset: number) => {
    if (seen++ === nth) {
      const bumped = String(Number(match) + 1).padStart(match.length, "0");
      out = text.slice(0, offset) + bumped + text.slice(offset + match.length);
    }
    return match;
  });
  return out;
}

type MutationScore = { caught: number; missed: number; caughtByTerminalMove: number };

/** Corrupt one number at a time across a family's scaffolds and count how many
 *  corruptions the audit notices. */
function mutationScore(family: string, draws: number): MutationScore {
  const score: MutationScore = { caught: 0, missed: 0, caughtByTerminalMove: 0 };
  for (let i = 0; i < draws; i++) {
    const item = generateItem(family, 1 + i * SEED_STRIDE);
    const original = item?.workedSteps;
    if (!item || !original || original.length === 0) continue;
    const answer = formatAnswer(item.answer);
    const clean = auditArithmetic(item.stem, answer, original);
    if (clean.arithmetic !== "pass" || clean.provenance === "fail") continue;

    for (let s = 0; s < original.length; s++) {
      for (let nth = 0; nth < 3; nth++) {
        const text = bumpNthNumber(original[s]!.text, nth);
        if (text === null || text === original[s]!.text) continue;
        const mutated = original.map((step, idx) => (idx === s ? { ...step, text } : step));
        const after = auditArithmetic(item.stem, answer, mutated);
        // A corruption the READER cannot parse is a reader hole, not a catch.
        if (after.unparsed.length > clean.unparsed.length) continue;
        if (after.arithmetic === "fail" || after.provenance === "fail") score.caught++;
        else score.missed++;
        // What the sweep would have caught BEFORE these axes existed.
        const before = auditScaffold(item.stem, answer, original);
        const now = auditScaffold(item.stem, answer, mutated);
        if (!HARD_FAILURES.includes(before.verdict) && HARD_FAILURES.includes(now.verdict)) {
          score.caughtByTerminalMove++;
        }
      }
    }
  }
  return score;
}

describe("mutation pins — the checker has teeth", () => {
  it("catches the great majority of single-digit corruptions across the corpus", () => {
    const total = SCAFFOLDED_FAMILIES.reduce<MutationScore>(
      (acc, family) => {
        const s = mutationScore(family, 20);
        return {
          caught: acc.caught + s.caught,
          missed: acc.missed + s.missed,
          caughtByTerminalMove: acc.caughtByTerminalMove + s.caughtByTerminalMove,
        };
      },
      { caught: 0, missed: 0, caughtByTerminalMove: 0 },
    );
    const attempts = total.caught + total.missed;
    expect(attempts).toBeGreaterThan(1000);
    // The floor sits below the measured rate (≈88%) so that generator wording
    // changes don't make this brittle; a real regression drops it much further.
    expect(total.caught / attempts).toBeGreaterThan(0.8);
    // The terminal reader now covers authored fraction, probability, and stats
    // contracts, including narrated quantities outside equations. It must catch
    // a material share on its own rather than silently treating those families
    // as n/a.
    expect(total.caughtByTerminalMove / attempts).toBeGreaterThan(0.1);
  });

  it("catches EVERY corruption in the families whose steps are all equations", () => {
    // Two of these are families whose scaffolds hard-failed 100% before #1178.
    // Every number they print now sits inside an equation, so every one of them
    // is checkable and nothing is allowed to slip through. (Families that also
    // NARRATE quantities — "multiply each part by 9" — cannot reach 100%: a
    // corrupted 9 in the prose is still a legitimate number elsewhere in the
    // step, and no deterministic reader can align prose to arithmetic.)
    for (const family of [
      "add_multidigit_algorithm",
      "subtract_multidigit_algorithm",
      "order_of_operations",
      "multiply_fractions",
      "divide_fractions",
    ]) {
      const s = mutationScore(family, 20);
      expect(s.caught).toBeGreaterThan(0);
      expect({ family, missed: s.missed }).toEqual({ family, missed: 0 });
    }
  });
});
