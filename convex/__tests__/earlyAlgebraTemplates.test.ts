import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { formatAnswer, numericValue } from "../lib/practice/answers";
import { classifyDomain } from "../lib/domainTaxonomy";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import {
  EARLY_ALGEBRA_DOMAIN,
  EARLY_ALGEBRA_EDGES,
  EARLY_ALGEBRA_SKILLS,
} from "../seed/earlyAlgebraGraph";
import schema from "../schema";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const SKILL_KEYS = EARLY_ALGEBRA_SKILLS.map((skill) => skill.skillKey);
const SKILL_KEY_SET = new Set(SKILL_KEYS);
const CROSS_DOMAIN_FROM_KEYS = [
  "add_subtract_integers",
  "divide_integers",
  "divide_integers",
  "exponents_repeated_mult",
  "integer_expressions",
  "mult_distributive",
  "multiply_fraction_by_whole",
  "multiply_fractions",
  "order_of_operations",
  "order_of_operations",
  "prop_constant_graph",
  "prop_table_from_rule",
];
const INEQUALITY_KEYS = SKILL_KEYS.filter((key) => key.startsWith("ineq_"));
const STRUCTURE_KEYS = [
  "expr_grouping_symbols",
  "expr_variable_meaning",
  "expr_terms_factors_coefficients",
  "expr_translate_words",
  "eq_solution_meaning",
  "eq_test_solution",
  "eq_identity_contradiction",
  "ineq_symbol_meaning",
  "ineq_test_solution",
  "ineq_boundary_direction",
];
const NUMERIC_OUTCOME_KEYS = [
  "expr_evaluate_numerical",
  "expr_evaluate_one_variable",
  "expr_evaluate_two_variables",
  "expr_evaluate_exponents",
  "expr_evaluate_fractions",
  "expr_distributive_numeric",
  "expr_evaluate_formulas",
  "expr_multi_step_signed",
  "eq_unknown_in_arithmetic",
  "eq_one_step_add_sub",
  "eq_one_step_mult_div",
  "eq_one_step_fraction",
  "eq_one_step_context",
  "eq_two_step_positive",
  "eq_two_step_integers",
  "eq_two_step_fraction_decimal",
  "eq_parentheses",
  "eq_context_multi_step",
  "eq_both_sides",
  "pattern_rule_sequence",
  "pattern_additive_next",
  "pattern_multiplicative_next",
  "pattern_corresponding_sequences",
  "pattern_function_machine_one_step",
  "pattern_function_machine_two_step",
  "pattern_table_missing_value",
  "pattern_arithmetic_sequence",
  "pattern_linear_table_rule",
  "pattern_graph_rate_change",
  "ineq_one_step_add_sub",
  "ineq_one_step_mult_div_positive",
  "ineq_context_one_step",
  "ineq_negative_coefficient",
  "ineq_two_step",
  "ineq_context_two_step",
];

function requiredItem(skillKey: string, seed: number, form?: string): PracticeItem {
  const item = generateItem(skillKey, seed, form);
  expect(item, `${skillKey} seed=${seed} form=${form ?? "direct"}`).not.toBeNull();
  if (!item) throw new Error(`Missing early-algebra template: ${skillKey}`);
  return item;
}

function graderSubmission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice"
    ? String(item.answer.choiceIndex)
    : formatAnswer(item.answer);
}

describe("early-algebra deterministic templates", () => {
  test("the authoritative graph has 45 nodes, 78 edges, and twelve foreign prerequisite edges", () => {
    expect(EARLY_ALGEBRA_DOMAIN).toBe("early-algebra");
    expect(EARLY_ALGEBRA_SKILLS).toHaveLength(45);
    expect(EARLY_ALGEBRA_EDGES).toHaveLength(78);
    expect(new Set(SKILL_KEYS).size).toBe(45);
    expect(EARLY_ALGEBRA_EDGES.filter((edge) => SKILL_KEY_SET.has(edge.fromKey))).toHaveLength(66);
    expect(
      EARLY_ALGEBRA_EDGES
        .filter((edge) => !SKILL_KEY_SET.has(edge.fromKey))
        .map((edge) => edge.fromKey)
        .sort(),
    ).toEqual(CROSS_DOMAIN_FROM_KEYS);
    for (const skill of EARLY_ALGEBRA_SKILLS) {
      expect(skill).not.toHaveProperty("servingNote");
    }
    expect(classifyDomain(EARLY_ALGEBRA_DOMAIN, "patterns-sequences")).toEqual({
      domain: EARLY_ALGEBRA_DOMAIN,
      strand: "patterns-sequences",
    });
  });

  test("every graph node has exactly one deterministic template", () => {
    for (const skillKey of SKILL_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(
          generateItem(skillKey, seed),
        );
      }
    }
  });

  test("every generated answer round-trips through its own grader", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed);
        const result = gradeTemplateItem(makeItemId(skillKey, seed), graderSubmission(item));
        expect(result, `${skillKey} seed=${seed}`).not.toBeNull();
        expect(result?.correct, `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("multiple-choice items have 3 or 4 unique, gradeable options", () => {
    let multipleChoiceItems = 0;
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 40; seed++) {
        const item = requiredItem(skillKey, seed);
        if (item.answerType !== "multipleChoice") continue;
        multipleChoiceItems++;
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

  test("all free responses are numeric, and negative outcomes are typed practice (never multiple choice)", () => {
    let negativeOutcomes = 0;
    for (const skillKey of NUMERIC_OUTCOME_KEYS) {
      for (let seed = 1; seed <= 80; seed++) {
        const item = requiredItem(skillKey, seed);
        expect(item.answerType, `${skillKey} seed=${seed}`).not.toBe("expression");
        // Both pads now expose a `±` sign-toggle key, so a negative outcome
        // never needs a multiple-choice fallback.
        expect(item.answerType, `${skillKey} seed=${seed}`).not.toBe("multipleChoice");
        const value = numericValue(item.answer);
        expect(Number.isFinite(value), `${skillKey} seed=${seed}: ${item.stem}`).toBe(true);
        if (value < 0) negativeOutcomes++;
      }
    }
    expect(negativeOutcomes).toBeGreaterThan(0);
  });

  test("structure recognition and which-value-satisfies nodes remain multiple choice", () => {
    for (const skillKey of STRUCTURE_KEYS) {
      for (let seed = 1; seed <= 20; seed++) {
        expect(requiredItem(skillKey, seed).answerType, `${skillKey} seed=${seed}`)
          .toBe("multipleChoice");
      }
    }
    for (let seed = 1; seed <= 20; seed++) {
      expect(requiredItem("ineq_test_solution", seed).choices).toHaveLength(3);
    }
  });

  test("function-machine templates only ask scholars to predict forward outputs", () => {
    for (const skillKey of [
      "pattern_function_machine_one_step",
      "pattern_function_machine_two_step",
    ]) {
      for (let seed = 1; seed <= 30; seed++) {
        const stem = requiredItem(skillKey, seed).stem.toLowerCase();
        expect(stem).toMatch(/output|comes out/);
        expect(stem).not.toMatch(/what input|which input|input replaces/);
      }
    }
    expect(requiredItem("eq_solution_meaning", 7).stem.toLowerCase()).toContain("balance");
  });

  test("inequality solution sets use numberLine and the graph capstone uses coordinatePlane", async () => {
    const t = convexTest(schema, modules);
    const kinds = new Set<string>();
    await t.run(async (ctx) => {
      for (const skillKey of SKILL_KEYS) {
        for (let seed = 1; seed <= 5; seed++) {
          const item = requiredItem(skillKey, seed);
          if (INEQUALITY_KEYS.includes(skillKey)) {
            expect(item.promptVisual?.kind, `${skillKey} seed=${seed}`).toBe("numberLine");
          }
          if (skillKey === "pattern_graph_rate_change") {
            expect(item.promptVisual?.kind, `seed=${seed}`).toBe("coordinatePlane");
          }
          if (!item.promptVisual) continue;
          kinds.add(item.promptVisual.kind);
          await ctx.db.insert("practiceItems", {
            skillKey,
            domain: EARLY_ALGEBRA_DOMAIN,
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

  test("the ceiling nodes preserve real multi-step and signed-number demand", () => {
    let negativeGraphRates = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const expression = requiredItem("expr_multi_step_signed", seed);
      expect(expression.stem.match(/x/g)?.length).toBeGreaterThanOrEqual(2);

      const bothSides = requiredItem("eq_both_sides", seed);
      expect(bothSides.stem.match(/x/g)?.length).toBeGreaterThanOrEqual(2);

      const distant = requiredItem("pattern_arithmetic_sequence", seed);
      expect(distant.stem).toMatch(/(1[89]|[23]\d)(th|st|nd|rd) term/);

      const graph = requiredItem("pattern_graph_rate_change", seed);
      expect(graph.answerType).toBe("integer");
      if (numericValue(graph.answer) < 0) negativeGraphRates++;

      expect(requiredItem("ineq_negative_coefficient", seed).stem).toMatch(/-\d+x/);
      expect(requiredItem("ineq_two_step", seed).stem).toMatch(/x/);
    }
    expect(negativeGraphRates).toBeGreaterThan(0);
  });

  test("natural one-step equation templates support the missing-operand variant", () => {
    for (const skillKey of ["eq_one_step_add_sub", "eq_one_step_mult_div"]) {
      let variants = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const item = requiredItem(skillKey, seed, "missing");
        if (item.form !== "missing") continue;
        variants++;
        expect(
          gradeTemplateItem(makeItemId(skillKey, seed, "missing"), graderSubmission(item))
            ?.correct,
          `${skillKey} seed=${seed}: ${item.stem}`,
        ).toBe(true);
      }
      expect(variants).toBeGreaterThan(0);
    }
  });
});
