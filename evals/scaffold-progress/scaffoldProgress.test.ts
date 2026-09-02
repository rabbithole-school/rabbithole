/**
 * The scaffold-progress GUARD.
 *
 * `convex/__tests__/workedStepGen.test.ts` already checks that worked steps
 * render, embed the answer, and don't leak the faded text. Every one of those
 * assertions passed on the scaffold that failed a real scholar on 816 ÷ 6:
 *
 *     1. Think of division as the missing factor: 6 × ? = 816.
 *     2. 6 × 136 = 816, so 816 ÷ 6 = 136.        ← blanked; the blank IS 816 ÷ 6
 *
 * Structural correctness is not pedagogical progress. This suite adds the
 * missing axes: the ONE step the teaching moment blanks must ask for a move
 * that is strictly SMALLER than the original problem, every arithmetic claim
 * the steps make must be TRUE, and every number they use must TRACE BACK to
 * the stem or to a value an earlier step derived.
 *
 * See review/math-scaffold-quality.html for the original report.
 */
import { describe, expect, it } from "vitest";
import {
  SCAFFOLDED_FAMILIES,
  auditFamily,
  describeFailure,
  formatReport,
  runSweep,
  totalsOf,
} from "./sweep";
import { auditScaffold } from "./scaffoldProgress";

// Deterministic seed ladder — same one the report's sweep used, so a failure
// here reproduces exactly.
const SWEEP = 300;

describe("scaffold progress — steps must be smaller, true, and traceable", () => {
  for (const family of SCAFFOLDED_FAMILIES) {
    it(`${family}: every evaluable draw passes all three axes`, () => {
      const result = auditFamily(family, SWEEP);
      // Every family in this list must actually emit worked steps.
      expect(result.n).toBeGreaterThan(0);

      if (result.buckets.fail > 0) {
        throw new Error(
          `${describeFailure(result)}\n\n` +
            `Fix the generator in convex/lib/practice/workedStepGen.ts — a step ` +
            `either asserts arithmetic that is false, uses a number that traces ` +
            `to nothing, or ends in a blank that is not a real step forward.`,
        );
      }
      expect(result.buckets.fail).toBe(0);
    });
  }

  it("every math span in the corpus is readable — no silent drops", () => {
    // An unparsed span is a hole in the READER, not a verdict about the
    // generator. If a generator starts emitting a shape `mathClaims.ts` cannot
    // read, the sweep must say so rather than quietly passing the draw.
    const holes = runSweep(SWEEP).flatMap((r) =>
      r.unparsed.map((span) => `${r.skillKey}: ${span}`),
    );
    expect(holes).toEqual([]);
  });
});

describe("the sweep report is honest about what it did not evaluate", () => {
  const results = runSweep(40);
  const totals = totalsOf(results);

  it("splits every draw into exactly one of pass / fail / n-a", () => {
    const sum = totals.buckets.pass + totals.buckets.fail + totals.buckets["n-a"];
    expect(sum).toBe(totals.drawn);
    expect(totals.drawn).toBeGreaterThan(0);
  });

  describe("terminal moves beyond bare arithmetic stems", () => {
    it("evaluates the authored fraction, probability, and statistics families", () => {
      for (const family of [
        "add_subtract_like",
        "add_subtract_unlike",
        "multiply_fraction_by_whole",
        "multiply_fractions",
        "divide_unit_fractions",
        "divide_fractions",
        "decimal_notation_fractions",
        "theoretical_probability_simple",
        "probability_as_fraction",
        "complement_probability",
        "expected_frequency",
        "sample_space",
        "mean",
        "median",
        "range",
      ]) {
        // This is deliberately the full deterministic ladder, not a sampled
        // contract test: exact authored wording may vary by generated case.
        const result = auditFamily(family, SWEEP);
        expect({ family, terminalNa: result.axes.terminal["n/a"] }).toEqual({
          family,
          terminalNa: 0,
        });
      }
    });

    it("rejects a fraction terminal step that merely repeats the stem", () => {
      const audit = auditScaffold("1/3 + 1/4 = ?", "7/12", [
        { text: "Use a common denominator of 12.", blankText: "Find a common denominator: ?" },
        { text: "1/3 + 1/4 = 7/12.", blankText: "Add the fractions: ?" },
      ]);
      expect(audit.verdict).toBe("restates");
    });

    it("catches a narrated favorable-count corruption outside the terminal equation", () => {
      const audit = auditScaffold(
        "3 of the 6 faces are even. Write that probability in simplest form.",
        "1/2",
        [
          {
            text: "Count the favorable outcomes (2) out of all the equally likely outcomes (6).",
            blankText: "Count the favorable outcomes and the total: ?",
          },
          { text: "Write that as a fraction and simplify: 3/6 = 1/2.", blankText: "Simplify: ?" },
        ],
      );
      expect(audit.verdict).toBe("implicit");
    });

    it("catches a narrated statistics-data corruption before selecting the median", () => {
      const audit = auditScaffold("Find the median of 7, 9, 10, 12, 14.", "10", [
        {
          text: "Put the values in order from least to greatest: 7, 9, 11, 12, 14.",
          blankText: "Put the values in order: ?",
        },
        { text: "With 5 values in order, the middle one is 10.", blankText: "Take the middle: ?" },
      ]);
      expect(audit.verdict).toBe("implicit");
    });
  });

  it("computes the pass rate over EVALUABLE draws, not all draws", () => {
    const evaluable = totals.buckets.pass + totals.buckets.fail;
    expect(evaluable).toBeGreaterThan(0);
    expect(totals.passRate).toBeCloseTo(totals.buckets.pass / evaluable, 12);
    // The distinction only means something if the two denominators differ, and
    // they do: some draws are legitimately un-evaluable on every axis.
    expect(totals.naShare).toBe(totals.buckets["n-a"] / totals.drawn);
  });

  it("surfaces each axis's own n/a share", () => {
    for (const axis of ["terminal", "arithmetic", "provenance"] as const) {
      const tally = totals.axes[axis];
      expect(tally.pass + tally.fail + tally["n/a"]).toBe(totals.drawn);
    }
    // The terminal-move axis is the one the old sweep reported as "100% pass"
    // while most of the corpus was un-evaluable. That share must stay visible.
    expect(totals.axes.terminal["n/a"]).toBeGreaterThan(0);
  });

  it("prints the three buckets and the n/a share side by side", () => {
    const report = formatReport(results);
    expect(report).toContain("pass rate over evaluable draws");
    expect(report).toContain("n/a share of all draws");
    expect(report).toContain("by axis:");
  });
});
