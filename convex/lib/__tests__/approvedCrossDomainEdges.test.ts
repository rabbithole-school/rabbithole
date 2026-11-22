import { describe, expect, test } from "vitest";
import {
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  type SeedEdge,
  type SeedSkill,
} from "../../seed/wholeNumberArithmeticGraph";
import {
  FRACTION_ARITHMETIC_EDGES,
  FRACTION_ARITHMETIC_SKILLS,
} from "../../seed/fractionArithmeticGraph";
import {
  GEOMETRY_MEASUREMENT_EDGES,
  GEOMETRY_MEASUREMENT_SKILLS,
} from "../../seed/geometryMeasurementGraph";
import {
  RATIO_PROPORTION_PERCENT_EDGES,
  RATIO_PROPORTION_PERCENT_SKILLS,
} from "../../seed/ratioProportionPercentGraph";
import {
  EARLY_ALGEBRA_EDGES,
  EARLY_ALGEBRA_SKILLS,
} from "../../seed/earlyAlgebraGraph";
import {
  INTEGERS_COORDINATES_SKILLS,
} from "../../seed/integersCoordinatesGraph";
import {
  ALGEBRA_1_EDGES,
  ALGEBRA_1_SKILLS,
} from "../../seed/algebra1Graph";
import {
  ALGEBRA_2_EDGES,
  ALGEBRA_2_SKILLS,
} from "../../seed/algebra2Graph";
import {
  DISCRETE_MATH_EDGES,
  DISCRETE_MATH_SKILLS,
} from "../../seed/discreteMathGraph";
import { gradeRank } from "../practice/placement";

type ApprovedEdge = SeedEdge & {
  targetEdges: readonly SeedEdge[];
};

const APPROVED_EDGES: ApprovedEdge[] = [
  {
    fromKey: "equivalent_fractions_general",
    toKey: "percent_fraction_decimal",
    targetEdges: RATIO_PROPORTION_PERCENT_EDGES,
  },
  {
    fromKey: "order_of_operations",
    toKey: "eq_unknown_in_arithmetic",
    targetEdges: EARLY_ALGEBRA_EDGES,
  },
  {
    fromKey: "multiply_fractions",
    toKey: "eq_one_step_fraction",
    targetEdges: EARLY_ALGEBRA_EDGES,
  },
  {
    fromKey: "multiply_fraction_by_whole",
    toKey: "expr_evaluate_fractions",
    targetEdges: EARLY_ALGEBRA_EDGES,
  },

  // ── Decimals strand (the #881/#888 pretest-audit follow-up) ──────────────
  // WNA → the fraction-arithmetic decimals strand:
  {
    fromKey: "place_value_relationships",
    toKey: "decimal_place_value_round",
    targetEdges: FRACTION_ARITHMETIC_EDGES,
  },
  {
    fromKey: "round_multidigit",
    toKey: "decimal_place_value_round",
    targetEdges: FRACTION_ARITHMETIC_EDGES,
  },
  {
    fromKey: "add_multidigit_algorithm",
    toKey: "add_subtract_decimals",
    targetEdges: FRACTION_ARITHMETIC_EDGES,
  },
  {
    fromKey: "subtract_multidigit_algorithm",
    toKey: "add_subtract_decimals",
    targetEdges: FRACTION_ARITHMETIC_EDGES,
  },
  {
    fromKey: "mult_2digit_by_1digit",
    toKey: "multiply_decimals",
    targetEdges: FRACTION_ARITHMETIC_EDGES,
  },
  {
    fromKey: "long_division_1digit_divisor",
    toKey: "divide_decimals",
    targetEdges: FRACTION_ARITHMETIC_EDGES,
  },
  // Decimal operations → the geometry items that serve decimal edge lengths:
  {
    fromKey: "multiply_decimals",
    toKey: "area_fraction_side",
    targetEdges: GEOMETRY_MEASUREMENT_EDGES,
  },
  {
    fromKey: "multiply_decimals",
    toKey: "volume_fractional_edges",
    targetEdges: GEOMETRY_MEASUREMENT_EDGES,
  },
  // Decimal notation / add-subtract → the percent and money items:
  {
    fromKey: "decimal_notation_fractions",
    toKey: "percent_fraction_decimal",
    targetEdges: RATIO_PROPORTION_PERCENT_EDGES,
  },
  {
    fromKey: "add_subtract_decimals",
    toKey: "percent_sales_tax",
    targetEdges: RATIO_PROPORTION_PERCENT_EDGES,
  },
  {
    fromKey: "add_subtract_decimals",
    toKey: "percent_discount_price",
    targetEdges: RATIO_PROPORTION_PERCENT_EDGES,
  },

  // ── Algebra 1 ceiling rung ──────────────────────────────────────────────
  { fromKey: "eq_both_sides", toKey: "lin_eq_combine_terms", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "expr_multi_step_signed", toKey: "lin_eq_combine_terms", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "eq_parentheses", toKey: "lin_eq_distribute", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "ineq_two_step", toKey: "lin_ineq_multi_step", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "eq_identity_contradiction", toKey: "sys_special_cases", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "pattern_graph_rate_change", toKey: "slope_from_graph", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "pattern_linear_table_rule", toKey: "lin_fn_from_two_points", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "four_quadrant_plane", toKey: "slope_from_graph", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "prop_constant_graph", toKey: "slope_two_points", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "prop_write_equation", toKey: "slope_intercept_form", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "exponents_repeated_mult", toKey: "exp_product_quotient", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "add_subtract_integers", toKey: "poly_add_subtract", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "multiply_integers", toKey: "exp_zero_negative", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "percent_change", toKey: "exp_growth_decay", targetEdges: ALGEBRA_1_EDGES },
  { fromKey: "absolute_value_distance_zero", toKey: "lin_eq_abs_value", targetEdges: ALGEBRA_1_EDGES },

  // ── Algebra 2 rung (2026-11-20) ─────────────────────────────────────────
  // The structural reason for each edge is the comment beside it in
  // convex/seed/algebra2Graph.ts; every one is grade-forward into g10/g11.
  { fromKey: "fn_notation_evaluate", toKey: "fn_domain_range_graph", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "fn_notation_evaluate", toKey: "fn_avg_rate_of_change", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "slope_two_points", toKey: "fn_avg_rate_of_change", targetEdges: ALGEBRA_2_EDGES }, // g8 algebra-1 → g10 algebra-2
  { fromKey: "fn_notation_evaluate", toKey: "fn_parent_families", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "quad_graph_features", toKey: "fn_parent_families", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "fn_notation_evaluate", toKey: "fn_compose", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "lin_eq_literal", toKey: "fn_inverse_find", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "roots_simplify_radicals", toKey: "cx_imaginary_unit", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "poly_multiply_binomials", toKey: "cx_multiply", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "four_quadrant_plane", toKey: "cx_plane_plot", targetEdges: ALGEBRA_2_EDGES }, // g6 geometry-measurement → g10 algebra-2
  { fromKey: "quad_formula", toKey: "quad_complex_roots", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "quad_solve_factoring", toKey: "quad_from_roots", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "quad_solve_factoring", toKey: "quad_inequality", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "lin_ineq_compound", toKey: "quad_inequality", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "sys_substitution", toKey: "sys_linear_quadratic", targetEdges: ALGEBRA_2_EDGES }, // g8 algebra-1 → g10 algebra-2
  { fromKey: "quad_solve_factoring", toKey: "sys_linear_quadratic", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "poly_classify", toKey: "poly_end_behavior", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "quad_graph_features", toKey: "poly_end_behavior", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "quad_zero_product", toKey: "poly_zeros_multiplicity", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "factor_special_forms", toKey: "poly_factor_grouping_cubes", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "factor_gcf", toKey: "poly_factor_grouping_cubes", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "factor_trinomial_general", toKey: "poly_factor_quadratic_form", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "factor_special_forms", toKey: "poly_factor_quadratic_form", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "poly_multiply_binomials", toKey: "poly_long_division", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g11 algebra-2
  { fromKey: "factor_trinomial_simple", toKey: "poly_factor_theorem", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g11 algebra-2
  { fromKey: "factor_trinomial_general", toKey: "poly_factor_theorem", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g11 algebra-2
  { fromKey: "poly_special_products", toKey: "poly_binomial_expansion", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g11 algebra-2
  { fromKey: "quad_solve_factoring", toKey: "rat_excluded_values", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g11 algebra-2
  { fromKey: "lin_eq_clear_fractions", toKey: "rat_solve_equation", targetEdges: ALGEBRA_2_EDGES }, // g8 algebra-1 → g11 algebra-2
  { fromKey: "roots_simplify_radicals", toKey: "rexp_convert", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "exp_power_rule", toKey: "rexp_convert", targetEdges: ALGEBRA_2_EDGES }, // g8 algebra-1 → g10 algebra-2
  { fromKey: "exp_zero_negative", toKey: "rexp_evaluate", targetEdges: ALGEBRA_2_EDGES }, // g8 algebra-1 → g10 algebra-2
  { fromKey: "roots_simplify_radicals", toKey: "rad_add_multiply", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "poly_special_products", toKey: "rad_rationalize", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "quad_solve_factoring", toKey: "rad_solve_equation", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "exp_fn_evaluate", toKey: "exp_solve_common_base", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "quad_solve_factoring", toKey: "log_solve_equation", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g11 algebra-2
  { fromKey: "exp_growth_decay", toKey: "exp_model_doubling_halflife", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g11 algebra-2
  { fromKey: "fn_notation_evaluate", toKey: "seq_arithmetic_explicit", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2
  { fromKey: "pattern_arithmetic_sequence", toKey: "seq_arithmetic_explicit", targetEdges: ALGEBRA_2_EDGES }, // g6 early-algebra → g10 algebra-2
  { fromKey: "exp_fn_evaluate", toKey: "seq_geometric_explicit", targetEdges: ALGEBRA_2_EDGES }, // g9 algebra-1 → g10 algebra-2

  // ── discrete-math algorithms strand (2026-11-21) ────────────────────────
  // The only one, on purpose: any new source domain would gate all of
  // discrete-math on that domain's placement (see convex/seed/discreteMathGraph.ts).
  { fromKey: "exponents_repeated_mult", toKey: "algo_halving_loop", targetEdges: DISCRETE_MATH_EDGES }, // g6 whole-number-arithmetic → g7 discrete-math
];

const SKILLS: readonly SeedSkill[] = [
  ...WHOLE_NUMBER_ARITHMETIC_SKILLS,
  ...FRACTION_ARITHMETIC_SKILLS,
  ...GEOMETRY_MEASUREMENT_SKILLS,
  ...RATIO_PROPORTION_PERCENT_SKILLS,
  ...EARLY_ALGEBRA_SKILLS,
  ...INTEGERS_COORDINATES_SKILLS,
  ...ALGEBRA_1_SKILLS,
  ...ALGEBRA_2_SKILLS,
  ...DISCRETE_MATH_SKILLS,
];
const gradeByKey = new Map(SKILLS.map((skill) => [skill.skillKey, skill.grade]));

describe("approved cross-domain prerequisite edges", () => {
  test.each(APPROVED_EDGES)(
    "$fromKey → $toKey exists and is grade-forward",
    ({ fromKey, toKey, targetEdges }) => {
      expect(targetEdges).toContainEqual({ fromKey, toKey });

      const sourceGrade = gradeByKey.get(fromKey);
      const targetGrade = gradeByKey.get(toKey);
      expect(sourceGrade, `missing grade for ${fromKey}`).toBeDefined();
      expect(targetGrade, `missing grade for ${toKey}`).toBeDefined();
      expect(gradeRank(sourceGrade ?? "")).toBeLessThanOrEqual(
        gradeRank(targetGrade ?? ""),
      );
    },
  );
});
