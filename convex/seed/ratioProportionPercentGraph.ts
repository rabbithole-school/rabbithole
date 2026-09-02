/**
 * Seed data: the ratios, rates, percent, and proportional-reasoning graph.
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * The three strands span grades 6–7 and are loaded by the multi-graph rebuild
 * in convex/knowledgeNodes.ts.
 *
 * Seven live cross-domain prerequisites connect the graph to the arithmetic it
 * applies. They are declared here (the target side), so the foreign-aware
 * frontier resolver checks mastery in the source domain.
 */

import type { SeedEdge, SeedSkill } from "./wholeNumberArithmeticGraph";

export const RATIO_PROPORTION_PERCENT_DOMAIN = "ratio-proportion-percent";

export const RATIO_PROPORTION_PERCENT_SKILLS: SeedSkill[] = [
  // ratios-rates
  { skillKey: "ratio_concept_language", label: "Interpret a ratio as a comparison of two quantities and use ratio language", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.1"], rationale: "A ratio names how much of one quantity there is for each amount of another; this multiplicative comparison is the domain's root." },
  { skillKey: "ratio_forms", label: "Represent the same ratio with words, colon notation, and fraction notation", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.1"], rationale: "Moving fluently among 'a to b,' a:b, and a/b separates notation from the comparison it represents." },
  { skillKey: "ratio_order_matters", label: "Distinguish a ratio from its reversed ratio", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.1"], rationale: "The quantities named first and second determine the ratio, so reversing them usually changes the comparison." },
  { skillKey: "ratio_part_part_to_whole", label: "Relate part-to-part ratios to part-to-whole ratios", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.1"], rationale: "A part-to-part comparison and a part-to-whole comparison use different second quantities even when they describe the same collection." },
  { skillKey: "ratio_equivalent_scale", label: "Generate an equivalent ratio by scaling both quantities", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.3a"], rationale: "Multiplying both quantities by the same positive factor preserves the multiplicative relationship." },
  { skillKey: "ratio_reduce", label: "Reduce a ratio to an equivalent ratio with least whole-number terms", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.3a"], rationale: "Dividing both quantities by a common factor reveals the simplest whole-number description of the same relationship." },
  { skillKey: "ratio_table_complete", label: "Complete a table of equivalent ratios", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.3a"], rationale: "A ratio table makes repeated multiplicative scaling visible across several matched pairs." },
  { skillKey: "ratio_double_number_line", label: "Find missing values on a double number line for equivalent ratios", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.3a"], rationale: "Aligned number lines show that both quantities scale together while retaining their own units." },
  { skillKey: "ratio_compare", label: "Compare two ratios using equivalent ratios or unit rates", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.3a", "6.RP.A.3b"], rationale: "Rewriting two comparisons on a common scale reveals which situation has the greater rate." },
  { skillKey: "rate_unit_whole_numbers", label: "Compute a unit rate from a ratio of whole numbers", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.2", "6.RP.A.3b"], rationale: "Dividing both quantities by the second quantity answers the central 'how much for one?' question." },
  { skillKey: "rate_unit_price", label: "Find and compare unit prices", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.3b"], rationale: "Price per item or per measure turns differently sized offers into a fair comparison." },
  { skillKey: "rate_constant_speed", label: "Use a constant speed as a rate to find distance or time", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.2", "6.RP.A.3b"], rationale: "Constant speed connects a unit rate to multiplicative predictions over any amount of time or distance." },
  { skillKey: "rate_measurement_conversion", label: "Convert measurement units using a unit rate", grade: "6", strand: "ratios-rates", ccCodes: ["6.RP.A.3d"], rationale: "A conversion factor is a rate equal to one, so multiplying or dividing preserves the measurement while changing its unit." },
  { skillKey: "rate_unit_fractional_quantities", label: "Compute a unit rate when one or both quantities are fractions", grade: "7", strand: "ratios-rates", ccCodes: ["7.RP.A.1"], rationale: "Fractional measurements extend unit-rate reasoning beyond whole-number counts to the quantities used in recipes, motion, and measurement." },

  // percent
  { skillKey: "percent_rate_per_hundred", label: "Interpret a percent as a rate per 100", grade: "6", strand: "percent", ccCodes: ["6.RP.A.3c"], rationale: "Percent is not a separate operation: it is a ratio whose comparison quantity has been standardized to 100." },
  { skillKey: "percent_fraction_decimal", label: "Convert among percent, fraction, and decimal forms", grade: "6", strand: "percent", ccCodes: ["6.RP.A.3c"], rationale: "Fraction, decimal, and percent notation are three names for the same relative quantity." },
  { skillKey: "percent_benchmark_reasoning", label: "Estimate percents of quantities using 1%, 10%, 25%, 50%, and 100% benchmarks", grade: "6", strand: "percent", ccCodes: ["6.RP.A.3c"], rationale: "Benchmark percents build magnitude sense and make exact percent answers easier to predict and check." },
  { skillKey: "percent_of_quantity", label: "Find a percent of a quantity", grade: "6", strand: "percent", ccCodes: ["6.RP.A.3c"], rationale: "Scaling a quantity by p/100 answers how much corresponds to p percent of the whole." },
  { skillKey: "percent_find_rate", label: "Find what percent one quantity is of another", grade: "6", strand: "percent", ccCodes: ["6.RP.A.3c"], rationale: "Comparing a part with its whole and scaling that ratio to 100 identifies the unknown percent rate." },
  { skillKey: "percent_find_whole", label: "Find the whole when a part and its percent are known", grade: "6", strand: "percent", ccCodes: ["6.RP.A.3c"], rationale: "Reversing a percent-of calculation recovers the 100% quantity from one known share." },
  { skillKey: "percent_increase", label: "Find a percent increase and the resulting value", grade: "7", strand: "percent", ccCodes: ["7.RP.A.3"], rationale: "A percent increase combines a percent-of calculation with addition to the original amount." },
  { skillKey: "percent_decrease", label: "Find a percent decrease and the resulting value", grade: "7", strand: "percent", ccCodes: ["7.RP.A.3"], rationale: "A percent decrease combines a percent-of calculation with subtraction from the original amount." },
  { skillKey: "percent_change", label: "Compute percent change from an original value to a new value", grade: "7", strand: "percent", ccCodes: ["7.RP.A.3"], rationale: "Percent change measures the difference relative to the original, not relative to the new value or their average." },
  { skillKey: "percent_error", label: "Compute percent error from an estimate and an actual value", grade: "7", strand: "percent", ccCodes: ["7.RP.A.3"], rationale: "Percent error compares the absolute error with the actual value, making errors comparable across scales." },
  { skillKey: "percent_sales_tax", label: "Find sales tax and the total price", grade: "7", strand: "percent", ccCodes: ["7.RP.A.3"], rationale: "Sales tax is a percent increase applied to a purchase price and then added to that price." },
  { skillKey: "percent_discount_price", label: "Find a discount and the sale price", grade: "7", strand: "percent", ccCodes: ["7.RP.A.3"], rationale: "A discount is a percent decrease, and the sale price is what remains after subtracting it." },
  { skillKey: "percent_simple_interest", label: "Compute simple interest from principal, rate, and time", grade: "7", strand: "percent", ccCodes: ["7.RP.A.3"], rationale: "Simple interest applies the same annual percent of the original principal for each unit of time." },

  // proportional-reasoning
  { skillKey: "prop_multiplicative_vs_additive", label: "Distinguish multiplicative scaling from additive change in ratio situations", grade: "6", strand: "proportional-reasoning", ccCodes: ["6.RP.A.3a"], rationale: "Equivalent ratios grow by a common factor, not by adding the same amount to both quantities." },
  { skillKey: "prop_table_from_rule", label: "Build a ratio table from a multiplicative rule", grade: "6", strand: "proportional-reasoning", ccCodes: ["6.RP.A.3a"], rationale: "Generating several input-output pairs from one multiplier exposes the invariant relationship across a table." },
  { skillKey: "prop_plot_equivalent_pairs", label: "Plot pairs of equivalent ratios on the coordinate plane", grade: "6", strand: "proportional-reasoning", ccCodes: ["6.RP.A.3a"], rationale: "Equivalent ratio pairs align on a ray from the origin, linking tables and double number lines to graphs." },
  { skillKey: "prop_decide_table", label: "Decide whether a table represents a proportional relationship", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2a"], rationale: "A table is proportional exactly when every nonzero pair has the same output-to-input ratio." },
  { skillKey: "prop_decide_graph", label: "Decide whether a graph represents a proportional relationship", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2a"], rationale: "A proportional graph is a straight line through the origin; either curvature or a nonzero intercept breaks proportionality." },
  { skillKey: "prop_constant_table", label: "Find the constant of proportionality from a table", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2b"], rationale: "The constant k = y/x is the unit rate shared by every pair in a proportional table." },
  { skillKey: "prop_constant_graph", label: "Find the constant of proportionality from a graph", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2b", "7.RP.A.2d"], rationale: "On y = kx, any nonzero point gives k = y/x and the point (1,k) displays the unit rate directly." },
  { skillKey: "prop_write_equation", label: "Write an equation y = kx for a proportional relationship", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2c"], rationale: "The equation y = kx compresses every pair in a proportional relationship into one rule." },
  { skillKey: "prop_missing_value", label: "Find a missing value in a proportional relationship", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2c"], rationale: "A known unit rate (constant of proportionality) or an equivalent-ratio relationship pins down any missing input or output by scaling - proportional reasoning, not symbolic equation-solving." },
  { skillKey: "prop_interpret_point", label: "Interpret a point (x, y) on a proportional graph in context", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2d"], rationale: "Each point states that x units of one quantity correspond to y units of the other in the same proportional relationship." },
  { skillKey: "prop_interpret_unit_point", label: "Interpret (0, 0) and (1, r) on a proportional graph", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2d"], rationale: "The origin expresses zero-with-zero, while (1,r) identifies the unit rate that controls the entire graph." },
  { skillKey: "prop_match_representations", label: "Match a proportional context, table, graph, and equation", grade: "7", strand: "proportional-reasoning", ccCodes: ["7.RP.A.2a", "7.RP.A.2b", "7.RP.A.2c", "7.RP.A.2d"], rationale: "Recognizing one constant across words, numbers, coordinates, and symbols is the capstone of proportional reasoning." },
];

export const RATIO_PROPORTION_PERCENT_EDGES: SeedEdge[] = [
  // ratios-rates
  { fromKey: "ratio_concept_language", toKey: "ratio_forms" },
  { fromKey: "ratio_concept_language", toKey: "ratio_order_matters" },
  { fromKey: "ratio_concept_language", toKey: "ratio_part_part_to_whole" },
  { fromKey: "ratio_forms", toKey: "ratio_equivalent_scale" },
  { fromKey: "ratio_equivalent_scale", toKey: "ratio_reduce" },
  { fromKey: "ratio_equivalent_scale", toKey: "ratio_table_complete" },
  { fromKey: "ratio_table_complete", toKey: "ratio_double_number_line" },
  { fromKey: "ratio_order_matters", toKey: "ratio_compare" },
  { fromKey: "ratio_reduce", toKey: "ratio_compare" },
  { fromKey: "ratio_table_complete", toKey: "ratio_compare" },
  { fromKey: "ratio_concept_language", toKey: "rate_unit_whole_numbers" },
  { fromKey: "ratio_table_complete", toKey: "rate_unit_whole_numbers" },
  { fromKey: "rate_unit_whole_numbers", toKey: "rate_unit_price" },
  { fromKey: "rate_unit_whole_numbers", toKey: "rate_constant_speed" },
  { fromKey: "rate_unit_whole_numbers", toKey: "rate_measurement_conversion" },
  { fromKey: "ratio_equivalent_scale", toKey: "rate_measurement_conversion" },
  { fromKey: "rate_unit_whole_numbers", toKey: "rate_unit_fractional_quantities" },

  // percent
  { fromKey: "ratio_concept_language", toKey: "percent_rate_per_hundred" },
  { fromKey: "ratio_forms", toKey: "percent_rate_per_hundred" },
  { fromKey: "percent_rate_per_hundred", toKey: "percent_fraction_decimal" },
  { fromKey: "percent_rate_per_hundred", toKey: "percent_benchmark_reasoning" },
  { fromKey: "percent_fraction_decimal", toKey: "percent_benchmark_reasoning" },
  { fromKey: "percent_rate_per_hundred", toKey: "percent_of_quantity" },
  { fromKey: "percent_fraction_decimal", toKey: "percent_of_quantity" },
  { fromKey: "percent_benchmark_reasoning", toKey: "percent_of_quantity" },
  { fromKey: "ratio_equivalent_scale", toKey: "percent_of_quantity" },
  { fromKey: "percent_rate_per_hundred", toKey: "percent_find_rate" },
  { fromKey: "rate_unit_whole_numbers", toKey: "percent_find_rate" },
  { fromKey: "percent_rate_per_hundred", toKey: "percent_find_whole" },
  { fromKey: "percent_of_quantity", toKey: "percent_find_whole" },
  { fromKey: "percent_of_quantity", toKey: "percent_increase" },
  { fromKey: "percent_of_quantity", toKey: "percent_decrease" },
  { fromKey: "percent_find_rate", toKey: "percent_change" },
  { fromKey: "percent_find_rate", toKey: "percent_error" },
  { fromKey: "percent_increase", toKey: "percent_sales_tax" },
  { fromKey: "percent_decrease", toKey: "percent_discount_price" },
  { fromKey: "percent_of_quantity", toKey: "percent_simple_interest" },

  // proportional-reasoning
  { fromKey: "ratio_equivalent_scale", toKey: "prop_multiplicative_vs_additive" },
  { fromKey: "ratio_table_complete", toKey: "prop_table_from_rule" },
  { fromKey: "prop_multiplicative_vs_additive", toKey: "prop_table_from_rule" },
  { fromKey: "prop_table_from_rule", toKey: "prop_plot_equivalent_pairs" },
  { fromKey: "prop_table_from_rule", toKey: "prop_decide_table" },
  { fromKey: "prop_multiplicative_vs_additive", toKey: "prop_decide_table" },
  { fromKey: "prop_plot_equivalent_pairs", toKey: "prop_decide_graph" },
  { fromKey: "prop_multiplicative_vs_additive", toKey: "prop_decide_graph" },
  { fromKey: "prop_decide_table", toKey: "prop_constant_table" },
  { fromKey: "rate_unit_whole_numbers", toKey: "prop_constant_table" },
  { fromKey: "prop_decide_graph", toKey: "prop_constant_graph" },
  { fromKey: "prop_plot_equivalent_pairs", toKey: "prop_constant_graph" },
  { fromKey: "prop_constant_table", toKey: "prop_write_equation" },
  { fromKey: "prop_write_equation", toKey: "prop_missing_value" },
  { fromKey: "prop_decide_graph", toKey: "prop_interpret_point" },
  { fromKey: "prop_write_equation", toKey: "prop_interpret_point" },
  { fromKey: "prop_constant_graph", toKey: "prop_interpret_unit_point" },
  { fromKey: "prop_interpret_point", toKey: "prop_interpret_unit_point" },
  { fromKey: "prop_decide_table", toKey: "prop_match_representations" },
  { fromKey: "prop_decide_graph", toKey: "prop_match_representations" },
  { fromKey: "prop_write_equation", toKey: "prop_match_representations" },

  // Cross-domain: multiplication supplies whole-number ratio scaling.
  { fromKey: "mult_2digit_by_1digit", toKey: "ratio_equivalent_scale" },
  // Cross-domain: fraction-as-division supplies the quotient meaning of unit rate.
  { fromKey: "fraction_as_division", toKey: "rate_unit_whole_numbers" },
  // Cross-domain: fractional unit rates require fraction division.
  { fromKey: "divide_fractions", toKey: "rate_unit_fractional_quantities" },
  // Cross-domain: powers of ten support decimal-percent conversion.
  { fromKey: "powers_of_ten", toKey: "percent_fraction_decimal" },
  // Cross-domain (g4 fraction → g6 ratio): Converting between percent and fraction form is an equivalence operation (3/5 = 60/100 = 60%; 40% = 2/5).
  { fromKey: "equivalent_fractions_general", toKey: "percent_fraction_decimal" },
  // Cross-domain: percent of a quantity applies fraction multiplication.
  { fromKey: "multiply_fraction_by_whole", toKey: "percent_of_quantity" },
  // Cross-domain: fraction scaling supplies the multiplicative resizing lens.
  { fromKey: "fraction_scaling", toKey: "prop_multiplicative_vs_additive" },

  // Cross-domain: the DECIMALS-strand prerequisites the pretest audit (#881)
  // found these items silently assuming. Each passes the blocked-kid bar for
  // the item AS SERVED, and each is grade-forward (g4/g5 → g6/g7):
  //
  // "Write 45% as a decimal" IS writing 45/100 in decimal notation (4.NF.C.6) —
  // a scholar without decimal notation has no way to express the answer.
  { fromKey: "decimal_notation_fractions", toKey: "percent_fraction_decimal" },
  // The money items ask for dollars-and-cents totals ($24.00 + $1.44 tax;
  // $32.00 − $4.80 discount) — decimal addition/subtraction as served.
  { fromKey: "add_subtract_decimals", toKey: "percent_sales_tax" },
  { fromKey: "add_subtract_decimals", toKey: "percent_discount_price" },
  //
  // Surveyed and deliberately NOT gated (typical, not necessary — the #883 bar):
  // • divide_decimals → rate_unit_price: the item is multiple-choice and a
  //   whole-number cents strategy (200¢ ÷ 5) reaches the answer.
  // • add_subtract_decimals → percent_simple_interest: principals/rates are
  //   constructed so every served answer is a whole number of dollars.
];
