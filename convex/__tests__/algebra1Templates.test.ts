import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { formatAnswer, numericValue } from "../lib/practice/answers";
import { classifyDomain } from "../lib/domainTaxonomy";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import {
  ALGEBRA_1_DOMAIN,
  ALGEBRA_1_EDGES,
  ALGEBRA_1_IMPLIES_EDGES,
  ALGEBRA_1_SKILLS,
} from "../seed/algebra1Graph";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SKILL_KEYS = ALGEBRA_1_SKILLS.map((skill) => skill.skillKey);
const SKILL_KEY_SET = new Set(SKILL_KEYS);

// Every cross-domain prerequisite `fromKey` (an edge whose source lives in
// another domain). Recounted directly from the real graph in the count test;
// this is the expected sorted list.
const CROSS_DOMAIN_FROM_KEYS = [
  "absolute_value_distance_zero",
  "add_subtract_integers",
  "eq_both_sides",
  "eq_identity_contradiction",
  "eq_parentheses",
  "exponents_repeated_mult",
  "expr_multi_step_signed",
  "four_quadrant_plane",
  "ineq_two_step",
  "multiply_integers",
  "pattern_graph_rate_change",
  "pattern_linear_table_rule",
  "percent_change",
  "prop_constant_graph",
  "prop_write_equation",
];

const IMPLIES_PAIRS = [
  "eq_two_step_integers->lin_eq_combine_terms",
  "eq_two_step_fraction_decimal->lin_eq_clear_fractions",
  "ineq_negative_coefficient->lin_ineq_multi_step",
  "multiply_integers->poly_multiply_binomials",
];

const STRAND_COUNTS: Record<string, number> = {
  "linear-equations": 9,
  "linear-functions": 11,
  systems: 7,
  "exponents-exponential": 10,
  "polynomials-factoring": 9,
  quadratics: 9,
};

// Structural-recognition / classify / compare nodes that must stay multiple
// choice (no free-response equivalent-expression grading).
const MULTIPLE_CHOICE_KEYS = [
  "lin_eq_justify_steps",
  "lin_eq_literal",
  "lin_ineq_compound",
  "lin_eq_model_context",
  "fn_identify_function",
  "lin_fn_interpret_context",
  "fn_compare_representations",
  "sys_solution_meaning",
  "sys_special_cases",
  "sys_linear_inequalities",
  "exp_growth_decay",
  "lin_vs_exp",
  "poly_classify",
  "poly_special_products",
  "factor_gcf",
  "factor_trinomial_simple",
  "factor_trinomial_general",
  "factor_special_forms",
];

// Free-response numeric families; every answer is an int/fraction the code
// computed, never an equivalent expression string.
const NUMERIC_OUTCOME_KEYS = SKILL_KEYS.filter(
  (key) => !MULTIPLE_CHOICE_KEYS.includes(key) && key !== "roots_simplify_radicals",
);

const ALLOWED_ANSWER_TYPES = new Set(["integer", "fraction", "expression", "multipleChoice"]);

function requiredItem(skillKey: string, seed: number, form?: string): PracticeItem {
  const item = generateItem(skillKey, seed, form);
  expect(item, `${skillKey} seed=${seed} form=${form ?? "direct"}`).not.toBeNull();
  if (!item) throw new Error(`Missing algebra-1 template: ${skillKey}`);
  return item;
}

function graderSubmission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice"
    ? String(item.answer.choiceIndex)
    : formatAnswer(item.answer);
}

/** Parse a monic quadratic rendered by templates.ts `quadExpr(1, b, c)`. */
function parseMonicQuadratic(expr: string): { b: number; c: number } {
  let s = expr.replace(/\s+/g, "");
  // Drop the leading "x²" (two code units: 'x' and the superscript ²).
  s = s.slice(2);
  let b = 0;
  const bMatch = s.match(/^([+-])(\d*)x/);
  if (bMatch) {
    b = (bMatch[1] === "-" ? -1 : 1) * (bMatch[2] === "" ? 1 : Number(bMatch[2]));
    s = s.slice(bMatch[0].length);
  }
  let c = 0;
  const cMatch = s.match(/^([+-])(\d+)$/);
  if (cMatch) c = (cMatch[1] === "-" ? -1 : 1) * Number(cMatch[2]);
  return { b, c };
}

describe("algebra-1 deterministic templates", () => {
  test("the authoritative graph has 55 nodes, 74 edges, 15 foreign prerequisites, and 4 implies edges", () => {
    expect(ALGEBRA_1_DOMAIN).toBe("algebra-1");
    expect(ALGEBRA_1_SKILLS).toHaveLength(55);
    expect(SKILL_KEY_SET.size).toBe(55);
    expect(ALGEBRA_1_EDGES).toHaveLength(74);

    const localFrom = ALGEBRA_1_EDGES.filter((edge) => SKILL_KEY_SET.has(edge.fromKey));
    expect(localFrom).toHaveLength(59);

    const foreign = ALGEBRA_1_EDGES.filter((edge) => !SKILL_KEY_SET.has(edge.fromKey));
    expect(foreign).toHaveLength(15);
    expect(foreign.map((edge) => edge.fromKey).sort()).toEqual(CROSS_DOMAIN_FROM_KEYS);

    // Every edge endpoint is a real key: `toKey` is always local (algebra-1 is a
    // pure sink domain — no edge points out of it).
    for (const edge of ALGEBRA_1_EDGES) {
      expect(SKILL_KEY_SET.has(edge.toKey), `toKey ${edge.toKey}`).toBe(true);
    }

    // Every LOCAL edge is grade-forward. The repo-wide drift lock only covers
    // CROSS-DOMAIN edges (graphGrades.test.ts), which is how a grade-9 →
    // grade-8 inversion slipped into this domain's first draft (caught in
    // review). Scoped here rather than repo-wide because whole-number
    // arithmetic carries two deliberate legacy backward pairs.
    const gradeByKey = new Map(ALGEBRA_1_SKILLS.map((s) => [s.skillKey, s.grade]));
    const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    for (const edge of ALGEBRA_1_EDGES) {
      const from = gradeByKey.get(edge.fromKey);
      if (from === undefined) continue; // foreign edges: covered by graphGrades
      const to = gradeByKey.get(edge.toKey)!;
      expect(
        GRADE_ORDER.indexOf(from) <= GRADE_ORDER.indexOf(to),
        `local edge ${edge.fromKey}(${from}) -> ${edge.toKey}(${to}) goes backward in grade`,
      ).toBe(true);
    }

    expect(ALGEBRA_1_IMPLIES_EDGES).toHaveLength(4);
    expect(
      ALGEBRA_1_IMPLIES_EDGES.map((edge) => `${edge.fromKey}->${edge.toKey}`),
    ).toEqual(IMPLIES_PAIRS);
    // The credited (fromKey) side of every implies edge is foreign; the mastered
    // (toKey) side is a local algebra-1 skill.
    for (const edge of ALGEBRA_1_IMPLIES_EDGES) {
      expect(SKILL_KEY_SET.has(edge.fromKey), `implies fromKey ${edge.fromKey}`).toBe(false);
      expect(SKILL_KEY_SET.has(edge.toKey), `implies toKey ${edge.toKey}`).toBe(true);
    }

    const counts: Record<string, number> = {};
    for (const skill of ALGEBRA_1_SKILLS) {
      const strand = (skill as { strand?: string }).strand ?? "";
      counts[strand] = (counts[strand] ?? 0) + 1;
    }
    expect(counts).toEqual(STRAND_COUNTS);

    expect(classifyDomain(ALGEBRA_1_DOMAIN, "linear-equations")).toEqual({
      domain: "algebra-1",
      strand: "linear-equations",
    });
  });

  test("every graph node has exactly one deterministic, reproducible template", () => {
    for (const skillKey of SKILL_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(
          generateItem(skillKey, seed),
        );
      }
    }
  });

  test("every template produces varied items across seeds", () => {
    for (const skillKey of SKILL_KEYS) {
      const signatures = new Set<string>();
      for (let seed = 1; seed <= 50; seed++) {
        const item = requiredItem(skillKey, seed);
        // Graph/MC families carry a fixed question stem; their variation lives in
        // the choices, the plotted visual, and the answer.
        signatures.add(
          [
            item.stem,
            JSON.stringify(item.choices ?? null),
            JSON.stringify(item.promptVisual ?? null),
            formatAnswer(item.answer),
          ].join("¦"),
        );
      }
      expect(
        signatures.size,
        `${skillKey} only produced ${signatures.size} distinct items`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test("every generated answer round-trips through its own grader", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 40; seed++) {
        const item = requiredItem(skillKey, seed);
        const result = gradeTemplateItem(makeItemId(skillKey, seed), graderSubmission(item));
        expect(result, `${skillKey} seed=${seed}`).not.toBeNull();
        expect(result?.correct, `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("simplifying radicals requires canonical form through the template grader", () => {
    const symbols = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const item = requiredItem("roots_simplify_radicals", seed);
      const match = item.stem.match(/((?:√(?:\[\d+\])?|∛))(\d+)/);
      expect(match, item.stem).not.toBeNull();
      if (!match) continue;
      const [, symbol, radicand] = match;
      symbols.add(symbol);
      expect(
        gradeTemplateItem(makeItemId("roots_simplify_radicals", seed), `${symbol}${radicand}`)?.correct,
      ).toBe(false);
      expect(
        gradeTemplateItem(
          makeItemId("roots_simplify_radicals", seed),
          graderSubmission(item),
        )?.correct,
      ).toBe(true);
    }
    expect(symbols).toEqual(new Set(["√", "∛", "√[4]", "√[5]"]));
  });

  test("answer types stay within the numeric-or-choice policy, with the radical editor exception", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 40; seed++) {
        const item = requiredItem(skillKey, seed);
        expect(
          item.answerType === "expression",
          `${skillKey} seed=${seed}`,
        ).toBe(skillKey === "roots_simplify_radicals");
        expect(
          ALLOWED_ANSWER_TYPES.has(item.answerType),
          `${skillKey} seed=${seed}: unexpected type ${item.answerType}`,
        ).toBe(true);
      }
    }
  });

  test("multiple-choice items have 3 or 4 unique, gradeable options", () => {
    let multipleChoiceItems = 0;
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 60; seed++) {
        const item = requiredItem(skillKey, seed);
        if (item.answerType !== "multipleChoice") continue;
        multipleChoiceItems++;
        expect(MULTIPLE_CHOICE_KEYS, `${skillKey} unexpectedly MC`).toContain(skillKey);
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeGreaterThanOrEqual(3);
        expect(item.choices?.length, `${skillKey} seed=${seed}`).toBeLessThanOrEqual(4);
        expect(new Set(item.choices).size, `${skillKey} seed=${seed}`).toBe(item.choices?.length);
        expect(item.answer.type, `${skillKey} seed=${seed}`).toBe("multipleChoice");
        if (item.answer.type === "multipleChoice") {
          expect(item.answer.choiceIndex).toBeGreaterThanOrEqual(0);
          expect(item.answer.choiceIndex).toBeLessThan(item.choices?.length ?? 0);
        }
      }
    }
    expect(multipleChoiceItems).toBeGreaterThan(0);
  });

  test("free-response families are numeric, and signed answers stay typed (never MC)", () => {
    let negativeOutcomes = 0;
    for (const skillKey of NUMERIC_OUTCOME_KEYS) {
      for (let seed = 1; seed <= 60; seed++) {
        const item = requiredItem(skillKey, seed);
        expect(item.answerType, `${skillKey} seed=${seed}`).not.toBe("multipleChoice");
        expect(item.answerType, `${skillKey} seed=${seed}`).not.toBe("expression");
        const value = numericValue(item.answer);
        expect(Number.isFinite(value), `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
        if (value < 0) negativeOutcomes++;
      }
    }
    expect(negativeOutcomes).toBeGreaterThan(0);
  });

  test("prompt visuals are restricted to coordinatePlane / numberLine and persist", async () => {
    const graphKeys = ["slope_from_graph", "sys_solve_graphing", "quad_graph_features"];
    const t = convexTest(schema, modules);
    const kinds = new Set<string>();
    await t.run(async (ctx) => {
      for (const skillKey of SKILL_KEYS) {
        for (let seed = 1; seed <= 6; seed++) {
          const item = requiredItem(skillKey, seed);
          if (graphKeys.includes(skillKey)) {
            expect(item.promptVisual?.kind, `${skillKey} seed=${seed}`).toBe("coordinatePlane");
          }
          if (skillKey === "lin_ineq_multi_step") {
            expect(item.promptVisual?.kind, `seed=${seed}`).toBe("numberLine");
          }
          if (!item.promptVisual) continue;
          expect(["coordinatePlane", "numberLine"]).toContain(item.promptVisual.kind);
          kinds.add(item.promptVisual.kind);
          await ctx.db.insert("practiceItems", {
            skillKey,
            domain: ALGEBRA_1_DOMAIN,
            stem: item.stem,
            answerType: item.answerType,
            answerCanonical: formatAnswer(item.answer),
            promptVisual: item.promptVisual,
            source: "template-test",
            verifiedAt: seed,
          });
        }
      }
    });
    expect([...kinds].sort()).toEqual(["coordinatePlane", "numberLine"]);
  });

  test("quadratic solve templates disambiguate which root is wanted", () => {
    for (let seed = 1; seed <= 40; seed++) {
      expect(requiredItem("quad_solve_sqrt", seed).stem).toMatch(/positive/);
      for (const skillKey of ["quad_zero_product", "quad_solve_factoring", "quad_formula"]) {
        expect(requiredItem(skillKey, seed).stem, `${skillKey} seed=${seed}`).toMatch(/larger/);
      }
      const squareRoot = requiredItem("roots_square_cube", seed);
      if (squareRoot.stem.includes("x²")) {
        expect(squareRoot.stem).toMatch(/positive/);
      }
    }
  });

  // Re-derive three solve families' answers mathematically from the rendered
  // stem (never from the generator), exactly the early-algebra discipline.
  test("linear-combine-terms answers solve their own equation", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const item = requiredItem("lin_eq_combine_terms", seed);
      const m = item.stem
        .replace(/\s+/g, " ")
        .match(/Solve for x: (\d+)x ([+-]) (\d+)x( [+-] \d+)? = (-?\d+)\./);
      expect(m, item.stem).not.toBeNull();
      if (!m) continue;
      const a = Number(m[1]);
      const b = Number(m[3]);
      const combined = m[2] === "+" ? a + b : a - b;
      const konst = m[4] ? Number(m[4].replace(/\s/g, "")) : 0;
      const rhs = Number(m[5]);
      const x = (rhs - konst) / combined;
      expect(Number.isInteger(x)).toBe(true);
      expect(numericValue(item.answer)).toBe(x);
    }
  });

  test("elimination answers solve the rendered 2x2 system", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const item = requiredItem("sys_elimination", seed);
      const m = item.stem.match(
        /elimination: (\d+)x \+ (\d+)y = (-?\d+) and (\d+)x \+ (\d+)y = (-?\d+)\./,
      );
      expect(m, item.stem).not.toBeNull();
      if (!m) continue;
      const [a1, b1, r1, a2, b2, r2] = m.slice(1).map(Number);
      const det = a1 * b2 - a2 * b1;
      expect(det).not.toBe(0);
      const x = (r1 * b2 - r2 * b1) / det;
      // Normalize a possible -0 from the division before the identity compare.
      expect(numericValue(item.answer)).toBe(x === 0 ? 0 : x);
    }
  });

  test("factor-solve answers are the larger root of the rendered quadratic", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const item = requiredItem("quad_solve_factoring", seed);
      const m = item.stem.match(/Solve (.+?) = 0 by factoring/);
      expect(m, item.stem).not.toBeNull();
      if (!m) continue;
      const { b, c } = parseMonicQuadratic(m[1]);
      const answer = numericValue(item.answer);
      // Satisfies x² + bx + c = 0 …
      expect(answer * answer + b * answer + c).toBe(0);
      // … and is the larger of the two roots (sum of roots = -b).
      const otherRoot = -b - answer;
      expect(answer).toBeGreaterThanOrEqual(otherRoot);
    }
  });

  test("the ceiling nodes preserve real algebra-1 demand", () => {
    for (let seed = 1; seed <= 40; seed++) {
      // Exponent rules genuinely operate on powers.
      expect(requiredItem("exp_product_quotient", seed).stem).toMatch(/\^/);
      expect(requiredItem("exp_power_rule", seed).stem).toMatch(/\^/);

      // Slope from two points shows two distinct ordered pairs.
      expect(requiredItem("slope_two_points", seed).stem).toMatch(
        /\(-?\d+, -?\d+\).*\(-?\d+, -?\d+\)/,
      );

      // Binomial product asks for a specific coefficient of a genuine product.
      const binomial = requiredItem("poly_multiply_binomials", seed);
      expect(binomial.stem).toMatch(/\(.*\)\(.*\)/);
      expect(binomial.stem).toMatch(/coefficient of x/);

      // The discriminant question names the b² − 4ac form.
      expect(requiredItem("quad_discriminant", seed).stem).toMatch(/b² - 4ac/);

      // Systems solve families state which coordinate to report.
      for (const skillKey of ["sys_solve_graphing", "sys_substitution", "sys_elimination"]) {
        expect(requiredItem(skillKey, seed).stem, `${skillKey} seed=${seed}`).toMatch(
          /x-value of the solution/,
        );
      }
    }
  });
});
