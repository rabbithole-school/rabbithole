import { describe, expect, test } from "vitest";
import { formatAnswer } from "../lib/practice/answers";
import { classifyDomain } from "../lib/domainTaxonomy";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate } from "../lib/practice/templates";
import {
  ALGEBRA_2_DOMAIN,
  ALGEBRA_2_EDGES,
  ALGEBRA_2_IMPLIES_EDGES,
  ALGEBRA_2_SKILLS,
} from "../seed/algebra2Graph";

const SKILL_KEYS = ALGEBRA_2_SKILLS.map((skill) => skill.skillKey);
const SKILL_KEY_SET = new Set(SKILL_KEYS);

// Every cross-domain prerequisite `fromKey` (an edge whose source lives in
// another domain), sorted and de-duplicated. Recounted from the real graph below.
const CROSS_DOMAIN_FROM_KEYS = [
  "exp_fn_evaluate",
  "exp_growth_decay",
  "exp_power_rule",
  "exp_zero_negative",
  "factor_gcf",
  "factor_special_forms",
  "factor_trinomial_general",
  "factor_trinomial_simple",
  "fn_notation_evaluate",
  "four_quadrant_plane",
  "lin_eq_clear_fractions",
  "lin_eq_literal",
  "lin_ineq_compound",
  "pattern_arithmetic_sequence",
  "poly_classify",
  "poly_multiply_binomials",
  "poly_special_products",
  "quad_formula",
  "quad_graph_features",
  "quad_solve_factoring",
  "quad_zero_product",
  "roots_simplify_radicals",
  "slope_two_points",
  "sys_substitution",
];

const IMPLIES_PAIRS = [
  "quad_discriminant->quad_complex_roots",
  "quad_solve_factoring->poly_solve_higher_degree",
  "add_subtract_unlike->rat_add_subtract",
  "pattern_multiplicative_next->seq_geometric_explicit",
];

const STRAND_COUNTS: Record<string, number> = {
  functions: 10,
  "complex-quadratics": 9,
  polynomials: 11,
  rational: 7,
  "radicals-rational-exponents": 6,
  "exponential-logarithmic": 11,
  "sequences-series": 7,
};

/**
 * Nodes still waiting for a deterministic template. The templates pass (D2)
 * shrinks this to empty and then deletes it, turning the `test.todo`s below into
 * real tests. Until it is empty, `coverageInvariant.test.ts` stays red for
 * exactly these nodes — on purpose; it is never weakened to hide them.
 */
// Every node, as of 2026-11-20 (the graph lands before its templates).
const PENDING_TEMPLATES: readonly string[] = [];

describe("algebra-2 graph", () => {
  test("the authoritative graph has 61 nodes, 92 edges, 41 foreign prerequisites (24 distinct sources), and 4 implies edges", () => {
    expect(ALGEBRA_2_DOMAIN).toBe("algebra-2");
    expect(ALGEBRA_2_SKILLS).toHaveLength(61);
    expect(SKILL_KEY_SET.size).toBe(61);
    expect(ALGEBRA_2_EDGES).toHaveLength(92);

    const localFrom = ALGEBRA_2_EDGES.filter((edge) => SKILL_KEY_SET.has(edge.fromKey));
    expect(localFrom).toHaveLength(51);

    const foreign = ALGEBRA_2_EDGES.filter((edge) => !SKILL_KEY_SET.has(edge.fromKey));
    expect(foreign).toHaveLength(41);
    expect([...new Set(foreign.map((edge) => edge.fromKey))].sort()).toEqual(CROSS_DOMAIN_FROM_KEYS);

    // algebra-2 is a pure sink domain: no edge points out of it.
    for (const edge of ALGEBRA_2_EDGES) {
      expect(SKILL_KEY_SET.has(edge.toKey), `toKey ${edge.toKey}`).toBe(true);
    }

    // Every node sits in the course's two grades, and every LOCAL edge is
    // grade-forward (the repo-wide lock in graphGrades.test.ts covers only
    // cross-domain edges). Ranked numerically: "10" < "9" as strings.
    const rank = (g: string) => Number(g);
    const gradeByKey = new Map(ALGEBRA_2_SKILLS.map((s) => [s.skillKey, s.grade]));
    for (const s of ALGEBRA_2_SKILLS) expect(["10", "11"], s.skillKey).toContain(s.grade);
    for (const edge of ALGEBRA_2_EDGES) {
      const from = gradeByKey.get(edge.fromKey);
      if (from === undefined) continue;
      const to = gradeByKey.get(edge.toKey)!;
      expect(
        rank(from) <= rank(to),
        `local edge ${edge.fromKey}(${from}) -> ${edge.toKey}(${to}) goes backward in grade`,
      ).toBe(true);
    }

    expect(ALGEBRA_2_IMPLIES_EDGES.map((edge) => `${edge.fromKey}->${edge.toKey}`)).toEqual(
      IMPLIES_PAIRS,
    );
    for (const edge of ALGEBRA_2_IMPLIES_EDGES) {
      expect(SKILL_KEY_SET.has(edge.fromKey), `implies fromKey ${edge.fromKey}`).toBe(false);
      expect(SKILL_KEY_SET.has(edge.toKey), `implies toKey ${edge.toKey}`).toBe(true);
    }

    const counts: Record<string, number> = {};
    for (const skill of ALGEBRA_2_SKILLS) counts[skill.strand] = (counts[skill.strand] ?? 0) + 1;
    expect(counts).toEqual(STRAND_COUNTS);

    expect(classifyDomain(ALGEBRA_2_DOMAIN, "functions")).toEqual({
      domain: "algebra-2",
      strand: "functions",
    });
  });

  test("an implies edge never duplicates a buildsOn ancestor (it would credit nothing new)", () => {
    const parents = new Map<string, string[]>();
    for (const e of ALGEBRA_2_EDGES) parents.set(e.toKey, [...(parents.get(e.toKey) ?? []), e.fromKey]);
    const ancestors = (key: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [...(parents.get(key) ?? [])];
      while (stack.length) {
        const k = stack.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(...(parents.get(k) ?? []));
      }
      return seen;
    };
    // Only algebra-2's own edges are walked here, so a foreign ancestor two
    // domains down is not seen; the four sources are checked by hand against
    // the algebra-1 graph in the seed file's comments.
    for (const e of ALGEBRA_2_IMPLIES_EDGES) {
      expect(ancestors(e.toKey).has(e.fromKey), `${e.fromKey}->${e.toKey}`).toBe(false);
    }
  });
});

describe("algebra-2 deterministic templates", () => {
  // Written now so the templates pass only has to delete PENDING_TEMPLATES.
  // While any node is pending these are `test.todo`.
  const ready = PENDING_TEMPLATES.length === 0;
  const t = ready ? test : test.todo;

  test("PENDING_TEMPLATES lists exactly the algebra-2 nodes with no template", () => {
    expect([...PENDING_TEMPLATES].sort()).toEqual(SKILL_KEYS.filter((k) => !hasTemplate(k)).sort());
  });

  t("every graph node has exactly one deterministic, reproducible template", () => {
    for (const skillKey of SKILL_KEYS) {
      expect(hasTemplate(skillKey), skillKey).toBe(true);
      for (let seed = 1; seed <= 30; seed++) {
        expect(generateItem(skillKey, seed), `${skillKey} seed=${seed}`).toEqual(
          generateItem(skillKey, seed),
        );
      }
    }
  });

  t("every generated answer round-trips through its own grader", () => {
    for (const skillKey of SKILL_KEYS) {
      for (let seed = 1; seed <= 20; seed++) {
        const item = generateItem(skillKey, seed);
        expect(item, `${skillKey} seed=${seed}`).not.toBeNull();
        if (!item) continue;
        const submission =
          item.answer.type === "multipleChoice" ? String(item.answer.choiceIndex) : formatAnswer(item.answer);
        const graded = gradeTemplateItem(makeItemId(skillKey, seed), submission);
        expect(graded?.correct, `${skillKey} seed=${seed}`).toBe(true);
      }
    }
  });
});
