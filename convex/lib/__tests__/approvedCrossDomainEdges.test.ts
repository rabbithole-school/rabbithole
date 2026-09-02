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
];

const SKILLS: readonly SeedSkill[] = [
  ...WHOLE_NUMBER_ARITHMETIC_SKILLS,
  ...FRACTION_ARITHMETIC_SKILLS,
  ...GEOMETRY_MEASUREMENT_SKILLS,
  ...RATIO_PROPORTION_PERCENT_SKILLS,
  ...EARLY_ALGEBRA_SKILLS,
  ...INTEGERS_COORDINATES_SKILLS,
  ...ALGEBRA_1_SKILLS,
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
