/**
 * Seed data: integers, signed rational numbers, and coordinate-plane ordering.
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * The three strands span grades 5–7 and are loaded by the multi-graph rebuild
 * in convex/knowledgeNodes.ts.
 *
 * Nine live cross-domain prerequisites connect signed arithmetic to the whole-
 * number, fraction, and coordinate-plane ideas it extends. They are declared
 * here (the target side), so the foreign-aware frontier resolver checks mastery
 * in each source domain.
 */

import type { SeedEdge, SeedSkill } from "./wholeNumberArithmeticGraph";

export const INTEGERS_COORDINATES_DOMAIN = "integers-coordinates";

export const INTEGERS_COORDINATES_SKILLS: SeedSkill[] = [
  // negatives-absvalue
  { skillKey: "positive_negative_contexts", label: "Interpret positive and negative numbers in context relative to zero", grade: "5", ccCodes: ["6.NS.C.5"], strand: "negatives-absvalue", rationale: "Treat zero as a reference point and use sign to encode opposite directions or states, such as elevation, temperature, credit, and debt." },
  { skillKey: "opposite_numbers", label: "Recognize opposite numbers and explain why 0 is its own opposite", grade: "6", ccCodes: ["6.NS.C.6a"], strand: "negatives-absvalue", rationale: "See a number and its opposite as equal distances from zero in opposite directions, with zero as the unique number that is its own opposite." },
  { skillKey: "integers_on_number_line", label: "Locate integers and their opposites on a number line", grade: "6", ccCodes: ["6.NS.C.6a", "6.NS.C.6c"], strand: "negatives-absvalue", rationale: "Make signed integers spatial: right and left encode order, while mirrored locations encode opposites." },
  { skillKey: "compare_integers", label: "Compare integers by their positions on a number line", grade: "6", ccCodes: ["6.NS.C.7a"], strand: "negatives-absvalue", rationale: "Understand that farther right means greater even when both numbers are negative, preventing the common larger-digit-means-larger error." },
  { skillKey: "absolute_value_distance_zero", label: "Interpret absolute value as distance from zero", grade: "6", ccCodes: ["6.NS.C.7c"], strand: "negatives-absvalue", rationale: "Ground |a| in distance, so absolute value is understood as magnitude rather than as a rule that mechanically removes a minus sign." },
  { skillKey: "absolute_value_contexts", label: "Interpret absolute value as magnitude in a real-world context", grade: "6", ccCodes: ["6.NS.C.7c"], strand: "negatives-absvalue", rationale: "Distinguish a signed state from its magnitude, such as an elevation of -80 meters versus a distance of 80 meters below sea level." },
  { skillKey: "compare_absolute_values", label: "Distinguish comparisons of signed values from comparisons of absolute values", grade: "6", ccCodes: ["6.NS.C.7d"], strand: "negatives-absvalue", rationale: "Separate order from magnitude: -12 is less than -5, while |-12| is greater than |-5|." },

  // integer-operations
  { skillKey: "additive_inverses_make_zero", label: "Use additive inverses to make a sum of zero", grade: "7", ccCodes: ["7.NS.A.1a"], strand: "integer-operations", rationale: "Connect opposites to arithmetic: a number and its opposite cancel because their directed movements return to zero." },
  { skillKey: "add_integers_same_sign", label: "Add integers with the same sign", grade: "7", ccCodes: ["7.NS.A.1b"], strand: "integer-operations", rationale: "Combine magnitudes moving in the same direction, preserving the common sign and extending whole-number addition to both sides of zero." },
  { skillKey: "add_integers_opposite_signs", label: "Add integers with opposite signs by comparing magnitudes", grade: "7", ccCodes: ["7.NS.A.1a", "7.NS.A.1b"], strand: "integer-operations", rationale: "Model partial cancellation and keep the sign of the addend with greater magnitude, rather than memorizing an ungrounded sign trick." },
  { skillKey: "add_integers", label: "Add integers fluently across all sign combinations", grade: "7", ccCodes: ["7.NS.A.1b", "7.NS.A.1d"], strand: "integer-operations", rationale: "Choose and execute the appropriate magnitude reasoning without being told whether the signs match." },
  { skillKey: "subtract_integers_add_opposite", label: "Subtract integers by adding the opposite", grade: "7", ccCodes: ["7.NS.A.1c"], strand: "integer-operations", rationale: "Unify subtraction with addition through a - b = a + (-b), including the counterintuitive effect of subtracting a negative." },
  { skillKey: "add_subtract_integers", label: "Add and subtract integers fluently in mixed expressions", grade: "7", ccCodes: ["7.NS.A.1d"], strand: "integer-operations", rationale: "Switch flexibly between addition and subtraction while preserving signs, parentheses, and the add-the-opposite structure." },
  { skillKey: "multiply_integers", label: "Multiply integers and justify the product's sign", grade: "7", ccCodes: ["7.NS.A.2a"], strand: "integer-operations", rationale: "Extend multiplication to signed numbers by preserving familiar magnitudes and reasoning that reversing one factor reverses the product." },
  { skillKey: "divide_integers", label: "Divide integers and justify the quotient's sign", grade: "7", ccCodes: ["7.NS.A.2b"], strand: "integer-operations", rationale: "Use division as the inverse of signed multiplication, including why division by zero remains undefined." },
  { skillKey: "integer_sign_rules", label: "Choose the sign of a product or quotient with several integer factors", grade: "7", ccCodes: ["7.NS.A.2a", "7.NS.A.2b"], strand: "integer-operations", rationale: "Generalize pairwise sign rules by tracking whether an even or odd number of negative factors reverses the result." },
  { skillKey: "integer_expressions", label: "Evaluate multi-operation numerical expressions with integers", grade: "7", ccCodes: ["7.NS.A.3"], strand: "integer-operations", rationale: "Coordinate signed arithmetic with parentheses and operation precedence, where notation and structure matter as much as individual calculations." },
  { skillKey: "integer_context_problems", label: "Solve multi-step problems involving positive and negative integers", grade: "7", ccCodes: ["7.NS.A.3"], strand: "integer-operations", rationale: "Translate changes in temperature, elevation, balance, or score into signed operations and interpret the resulting number in context." },
  { skillKey: "add_subtract_signed_rationals", label: "Add and subtract signed rational numbers", grade: "7", ccCodes: ["7.NS.A.1d"], strand: "integer-operations", rationale: "Carry integer sign and direction reasoning into fractions and decimals while retaining fraction-equivalence and common-denominator structure." },
  { skillKey: "multiply_signed_rationals", label: "Multiply signed rational numbers", grade: "7", ccCodes: ["7.NS.A.2a", "7.NS.A.2c"], strand: "integer-operations", rationale: "Combine fraction multiplication with signed-number structure, separating the sign decision from the magnitude calculation." },
  { skillKey: "divide_signed_rationals", label: "Divide signed rational numbers", grade: "7", ccCodes: ["7.NS.A.2b", "7.NS.A.2c"], strand: "integer-operations", rationale: "Combine fraction division with signed quotient reasoning while preserving the prohibition on division by zero." },
  { skillKey: "four_operations_signed_rationals", label: "Solve multi-step problems with all four operations on signed rational numbers", grade: "7", ccCodes: ["7.NS.A.3"], strand: "integer-operations", rationale: "Integrate signed fraction and decimal arithmetic into one coherent system for real-world and mathematical problems." },

  // rational-ordering
  { skillKey: "signed_rational_numbers", label: "Recognize positive and negative fractions and decimals as rational numbers", grade: "6", ccCodes: ["6.NS.C.6c", "6.NS.C.7a"], strand: "rational-ordering", rationale: "Extend the signed-number system beyond integers while keeping zero, opposites, order, and magnitude as the organizing ideas." },
  { skillKey: "signed_rationals_on_number_line", label: "Locate signed fractions and decimals on a number line", grade: "6", ccCodes: ["6.NS.C.6c"], strand: "rational-ordering", rationale: "Place non-integer rational numbers on both sides of zero, making order and opposites continuous rather than integer-only." },
  { skillKey: "compare_signed_rationals", label: "Compare signed rational numbers in fraction or decimal form", grade: "6", ccCodes: ["6.NS.C.7a"], strand: "rational-ordering", rationale: "Coordinate sign, magnitude, and equivalent forms to compare any two rational numbers, especially two negatives." },
  { skillKey: "rational_inequalities_contexts", label: "Write and interpret rational-number inequalities in context", grade: "6", ccCodes: ["6.NS.C.7b"], strand: "rational-ordering", rationale: "Connect an inequality's direction to a real comparison, such as one temperature being lower or one elevation being higher." },
  { skillKey: "order_signed_rationals", label: "Order a set of signed rational numbers from least to greatest", grade: "6", ccCodes: ["6.NS.C.7a", "6.NS.C.7b"], strand: "rational-ordering", rationale: "Extend pairwise comparison to a mixed set of positive and negative integers, fractions, and decimals." },
  { skillKey: "absolute_value_rationals", label: "Find and compare absolute values of rational numbers", grade: "6", ccCodes: ["6.NS.C.7c", "6.NS.C.7d"], strand: "rational-ordering", rationale: "Extend distance-from-zero reasoning from integers to fractions and decimals, preserving the distinction between value and magnitude." },
  { skillKey: "rational_coordinate_pairs", label: "Plot points with rational coordinates in all four quadrants", grade: "6", ccCodes: ["6.NS.C.6c"], strand: "rational-ordering", rationale: "Extend established four-quadrant plotting from integer coordinates to fractional and decimal positions without introducing plane-shape work." },
  { skillKey: "rational_between_numbers", label: "Find a rational number between two given rational numbers", grade: "7", ccCodes: ["6.NS.C.7a"], strand: "rational-ordering", rationale: "Expose the density of rational numbers: unlike consecutive integers, any two distinct rationals have another rational between them." },
  { skillKey: "signed_fraction_decimal_equivalence", label: "Convert a signed fraction to a terminating or repeating decimal", grade: "7", ccCodes: ["7.NS.A.2d"], strand: "rational-ordering", rationale: "Connect signed fractions and decimal expansions through division, including the structural fact that rational decimals terminate or eventually repeat." },
];

export const INTEGERS_COORDINATES_EDGES: SeedEdge[] = [
  { fromKey: "positive_negative_contexts", toKey: "opposite_numbers" },
  { fromKey: "opposite_numbers", toKey: "integers_on_number_line" },
  { fromKey: "integers_on_number_line", toKey: "compare_integers" },
  { fromKey: "integers_on_number_line", toKey: "absolute_value_distance_zero" },
  { fromKey: "positive_negative_contexts", toKey: "absolute_value_contexts" },
  { fromKey: "absolute_value_distance_zero", toKey: "absolute_value_contexts" },
  { fromKey: "compare_integers", toKey: "compare_absolute_values" },
  { fromKey: "absolute_value_distance_zero", toKey: "compare_absolute_values" },
  { fromKey: "opposite_numbers", toKey: "additive_inverses_make_zero" },
  { fromKey: "integers_on_number_line", toKey: "additive_inverses_make_zero" },
  { fromKey: "integers_on_number_line", toKey: "add_integers_same_sign" },
  { fromKey: "additive_inverses_make_zero", toKey: "add_integers_opposite_signs" },
  { fromKey: "absolute_value_distance_zero", toKey: "add_integers_opposite_signs" },
  { fromKey: "add_integers_same_sign", toKey: "add_integers" },
  { fromKey: "add_integers_opposite_signs", toKey: "add_integers" },
  { fromKey: "add_integers", toKey: "subtract_integers_add_opposite" },
  { fromKey: "opposite_numbers", toKey: "subtract_integers_add_opposite" },
  { fromKey: "subtract_integers_add_opposite", toKey: "add_subtract_integers" },
  { fromKey: "integers_on_number_line", toKey: "multiply_integers" },
  { fromKey: "multiply_integers", toKey: "divide_integers" },
  { fromKey: "multiply_integers", toKey: "integer_sign_rules" },
  { fromKey: "divide_integers", toKey: "integer_sign_rules" },
  { fromKey: "add_subtract_integers", toKey: "integer_expressions" },
  { fromKey: "integer_sign_rules", toKey: "integer_expressions" },
  { fromKey: "positive_negative_contexts", toKey: "integer_context_problems" },
  { fromKey: "integer_expressions", toKey: "integer_context_problems" },
  { fromKey: "signed_rational_numbers", toKey: "add_subtract_signed_rationals" },
  { fromKey: "add_subtract_integers", toKey: "add_subtract_signed_rationals" },
  { fromKey: "signed_rational_numbers", toKey: "multiply_signed_rationals" },
  { fromKey: "integer_sign_rules", toKey: "multiply_signed_rationals" },
  { fromKey: "signed_rational_numbers", toKey: "divide_signed_rationals" },
  { fromKey: "integer_sign_rules", toKey: "divide_signed_rationals" },
  { fromKey: "add_subtract_signed_rationals", toKey: "four_operations_signed_rationals" },
  { fromKey: "multiply_signed_rationals", toKey: "four_operations_signed_rationals" },
  { fromKey: "divide_signed_rationals", toKey: "four_operations_signed_rationals" },
  { fromKey: "positive_negative_contexts", toKey: "signed_rational_numbers" },
  { fromKey: "signed_rational_numbers", toKey: "signed_rationals_on_number_line" },
  { fromKey: "integers_on_number_line", toKey: "signed_rationals_on_number_line" },
  { fromKey: "signed_rationals_on_number_line", toKey: "compare_signed_rationals" },
  { fromKey: "compare_integers", toKey: "compare_signed_rationals" },
  { fromKey: "compare_signed_rationals", toKey: "rational_inequalities_contexts" },
  { fromKey: "positive_negative_contexts", toKey: "rational_inequalities_contexts" },
  { fromKey: "compare_signed_rationals", toKey: "order_signed_rationals" },
  { fromKey: "signed_rationals_on_number_line", toKey: "absolute_value_rationals" },
  { fromKey: "absolute_value_distance_zero", toKey: "absolute_value_rationals" },
  { fromKey: "signed_rationals_on_number_line", toKey: "rational_coordinate_pairs" },
  { fromKey: "signed_rationals_on_number_line", toKey: "rational_between_numbers" },
  { fromKey: "compare_signed_rationals", toKey: "rational_between_numbers" },
  { fromKey: "signed_rational_numbers", toKey: "signed_fraction_decimal_equivalence" },

  // Cross-domain prerequisites.
  { fromKey: "order_of_operations", toKey: "integer_expressions" },
  { fromKey: "long_division_2digit_divisor", toKey: "signed_fraction_decimal_equivalence" },
  { fromKey: "fraction_number_line", toKey: "signed_rationals_on_number_line" },
  { fromKey: "order_fractions", toKey: "compare_signed_rationals" },
  { fromKey: "add_subtract_unlike", toKey: "add_subtract_signed_rationals" },
  { fromKey: "multiply_fractions", toKey: "multiply_signed_rationals" },
  { fromKey: "divide_fractions", toKey: "divide_signed_rationals" },
  { fromKey: "four_quadrant_plane", toKey: "rational_coordinate_pairs" },
  { fromKey: "fraction_as_parts", toKey: "signed_rational_numbers" },
];
