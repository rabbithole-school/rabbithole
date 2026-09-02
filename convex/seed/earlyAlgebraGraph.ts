/**
 * Seed data: early algebra — expressions, equations, patterns, and inequalities.
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * The four strands span grades 4–8 and form the ceiling rung of the cross-domain
 * practice ladder.
 *
 * Twelve live cross-domain prerequisites connect the graph to arithmetic, signed
 * numbers, and proportional relationships it extends. They are declared here
 * (the target side), so the foreign-aware frontier resolver checks mastery in
 * each source domain.
 */

import type { SeedEdge, SeedSkill } from "./wholeNumberArithmeticGraph";

export const EARLY_ALGEBRA_DOMAIN = "early-algebra";

export const EARLY_ALGEBRA_SKILLS: SeedSkill[] = [
  // expressions-variables
  { skillKey: "expr_grouping_symbols", label: "Read parentheses, brackets, and braces as grouping symbols", grade: "5", ccCodes: ["5.OA.A.1"], strand: "expressions-variables", rationale: "Grouping symbols mark which calculation is treated as one unit, so structure rather than left-to-right guessing controls an expression's value." },
  { skillKey: "expr_evaluate_numerical", label: "Evaluate numerical expressions with grouping and operation precedence", grade: "5", ccCodes: ["5.OA.A.1", "5.OA.A.2"], strand: "expressions-variables", rationale: "Coordinating grouping with multiplication, division, addition, and subtraction establishes the evaluation discipline algebra later applies to variables." },
  { skillKey: "expr_variable_meaning", label: "Interpret a variable as a number whose value may vary or be unknown", grade: "6", ccCodes: ["6.EE.B.6"], strand: "expressions-variables", rationale: "A letter can stand for a particular unknown or for quantities that change, freeing reasoning from one fixed arithmetic instance." },
  { skillKey: "expr_terms_factors_coefficients", label: "Identify terms, factors, coefficients, and constants in an expression", grade: "6", ccCodes: ["6.EE.A.2b"], strand: "expressions-variables", rationale: "Seeing an expression as sums of terms and products of factors gives scholars the structural vocabulary needed to reason about how it is evaluated." },
  { skillKey: "expr_translate_words", label: "Match verbal descriptions to algebraic expressions", grade: "6", ccCodes: ["6.EE.A.2a", "6.EE.B.6"], strand: "expressions-variables", rationale: "Translating phrases such as 'five less than three times a number' connects operation order in language to algebraic structure." },
  { skillKey: "expr_evaluate_one_variable", label: "Evaluate a one-variable expression for a given value", grade: "6", ccCodes: ["6.EE.A.2c"], strand: "expressions-variables", rationale: "Substitution turns an algebraic expression into a numerical one while preserving its grouping and operation structure." },
  { skillKey: "expr_evaluate_two_variables", label: "Evaluate an expression with two variables for given values", grade: "6", ccCodes: ["6.EE.A.2c"], strand: "expressions-variables", rationale: "Tracking two substitutions at once develops precision about which value belongs in each position and prepares scholars to evaluate formulas." },
  { skillKey: "expr_evaluate_exponents", label: "Evaluate expressions containing whole-number exponents", grade: "6", ccCodes: ["6.EE.A.1", "6.EE.A.2c"], strand: "expressions-variables", rationale: "Powers compress repeated multiplication and must be evaluated as a unit before surrounding operations." },
  { skillKey: "expr_evaluate_fractions", label: "Evaluate variable expressions with fraction values", grade: "6", ccCodes: ["6.EE.A.2c"], strand: "expressions-variables", rationale: "Fraction inputs show that a variable stands for any number, not only a whole number, and force substitution to remain exact." },
  { skillKey: "expr_distributive_numeric", label: "Use the distributive property to evaluate expressions efficiently", grade: "6", ccCodes: ["6.EE.A.3"], strand: "expressions-variables", rationale: "Viewing a product over a sum as two partial products turns the distributive property into a calculation strategy rather than a symbol-moving rule." },
  { skillKey: "expr_evaluate_formulas", label: "Evaluate a formula from supplied measurements", grade: "6", ccCodes: ["6.EE.A.2c", "6.EE.B.6"], strand: "expressions-variables", rationale: "A formula packages a relationship among quantities; substituting measurements makes variables useful in geometry, science, and everyday calculation." },
  { skillKey: "expr_multi_step_signed", label: "Evaluate linear expressions with signed values, distribution, and like terms", grade: "7", ccCodes: ["6.EE.A.2c", "7.NS.A.3"], strand: "expressions-variables", rationale: "Combining structural algebra moves with signed arithmetic lets scholars evaluate compact expressions without losing signs or operation precedence." },

  // equations-1-2-step
  { skillKey: "eq_unknown_in_arithmetic", label: "Find an unknown number in a multi-step arithmetic relation", grade: "5", ccCodes: ["4.OA.A.3", "5.OA.A.2"], strand: "equations-1-2-step", rationale: "Reasoning backward from a known result makes inverse operations explicit before letters and formal equation-solving procedures are introduced." },
  { skillKey: "eq_solution_meaning", label: "Understand a solution as a value that makes an equation true", grade: "6", ccCodes: ["6.EE.B.5"], strand: "equations-1-2-step", rationale: "Equation solving is a search for truth-preserving values, not merely a sequence of moves applied to symbols." },
  { skillKey: "eq_test_solution", label: "Test whether a given number is a solution of an equation", grade: "6", ccCodes: ["6.EE.B.5"], strand: "equations-1-2-step", rationale: "Substituting a candidate and comparing both sides supplies a direct way to verify a solution and catch algebra mistakes." },
  { skillKey: "eq_one_step_add_sub", label: "Solve one-step addition and subtraction equations", grade: "6", ccCodes: ["6.EE.B.7"], strand: "equations-1-2-step", rationale: "Undoing a single addition or subtraction while preserving equality is the first formal use of inverse operations on an equation." },
  { skillKey: "eq_one_step_mult_div", label: "Solve one-step multiplication and division equations", grade: "6", ccCodes: ["6.EE.B.7"], strand: "equations-1-2-step", rationale: "Multiplication and division undo one another, extending balance-preserving reasoning from additive to multiplicative equations." },
  { skillKey: "eq_one_step_fraction", label: "Solve one-step equations with a fraction coefficient or result", grade: "6", ccCodes: ["6.EE.B.7"], strand: "equations-1-2-step", rationale: "Fraction coefficients reveal that inverse-operation reasoning works for all nonzero rational multipliers, not only friendly whole numbers." },
  { skillKey: "eq_one_step_context", label: "Model and solve a one-step equation from a context", grade: "6", ccCodes: ["6.EE.B.6", "6.EE.B.7"], strand: "equations-1-2-step", rationale: "A contextual unknown gives equation solving a purpose: the operation connecting known quantities determines the inverse operation needed." },
  { skillKey: "eq_two_step_positive", label: "Solve two-step equations with positive rational numbers", grade: "7", ccCodes: ["7.EE.B.4a"], strand: "equations-1-2-step", rationale: "Reversing two operations in the correct order develops a coherent isolation strategy rather than a collection of disconnected tricks." },
  { skillKey: "eq_two_step_integers", label: "Solve two-step equations with signed integer coefficients and constants", grade: "7", ccCodes: ["7.EE.B.4a"], strand: "equations-1-2-step", rationale: "Signed coefficients and constants make sign control part of equation solving while leaving the two-step structure visible." },
  { skillKey: "eq_two_step_fraction_decimal", label: "Solve two-step equations with fraction or terminating-decimal values", grade: "7", ccCodes: ["7.EE.B.3", "7.EE.B.4a"], strand: "equations-1-2-step", rationale: "Rational coefficients make exact arithmetic and equation structure work together, matching the quantities found in measurement and rate problems." },
  { skillKey: "eq_parentheses", label: "Solve two-step equations that require distribution before isolating the variable", grade: "7", ccCodes: ["7.EE.A.1", "7.EE.B.4a"], strand: "equations-1-2-step", rationale: "A grouped expression must first be understood as a distributed quantity before inverse operations can expose the unknown." },
  { skillKey: "eq_context_multi_step", label: "Model and solve a multi-step equation from a real-world context", grade: "7", ccCodes: ["7.EE.B.3", "7.EE.B.4a"], strand: "equations-1-2-step", rationale: "Multi-step contexts require deciding what is unknown, how quantities are connected, and whether the resulting value makes sense in the situation." },
  { skillKey: "eq_both_sides", label: "Solve linear equations with the variable on both sides", grade: "8", ccCodes: ["8.EE.C.7b"], strand: "equations-1-2-step", rationale: "Collecting variable quantities onto one side extends balance reasoning to equations in which both expressions change with the unknown." },
  { skillKey: "eq_identity_contradiction", label: "Distinguish equations with one solution, no solution, or infinitely many solutions", grade: "8", ccCodes: ["8.EE.C.7a"], strand: "equations-1-2-step", rationale: "Simplifying both sides can reveal a true identity or a contradiction, showing that solving is about the relationship between expressions rather than always finding one number." },

  // patterns-sequences
  { skillKey: "pattern_rule_sequence", label: "Generate terms from a stated number pattern rule", grade: "4", ccCodes: ["4.OA.C.5"], strand: "patterns-sequences", rationale: "Applying the same rule repeatedly turns an operation into a process and makes regularity visible across many numbers." },
  { skillKey: "pattern_additive_next", label: "Find the next term and missing terms in an additive sequence", grade: "4", ccCodes: ["4.OA.C.5"], strand: "patterns-sequences", rationale: "A constant additive change is the earliest linear growth pattern and a concrete precursor to slope." },
  { skillKey: "pattern_multiplicative_next", label: "Find the next term in a multiplicative sequence", grade: "4", ccCodes: ["4.OA.C.5"], strand: "patterns-sequences", rationale: "Repeated multiplication produces growth fundamentally different from repeated addition and gives gifted learners an early contrast between linear and exponential behavior." },
  { skillKey: "pattern_corresponding_sequences", label: "Compare corresponding terms from two related sequences", grade: "5", ccCodes: ["5.OA.B.3"], strand: "patterns-sequences", rationale: "Generating two patterns and aligning their terms reveals relationships that are invisible when each sequence is viewed alone." },
  { skillKey: "pattern_function_machine_one_step", label: "Use a one-step function machine to find outputs or inputs", grade: "5", ccCodes: ["5.OA.B.3"], strand: "patterns-sequences", rationale: "A function machine separates the rule from individual values and introduces input-output thinking without requiring formal function notation." },
  { skillKey: "pattern_function_machine_two_step", label: "Use a two-step function machine to find outputs or inputs", grade: "6", ccCodes: ["6.EE.C.9"], strand: "patterns-sequences", rationale: "Composing two operations creates the same structure as a two-step expression while keeping the dependency between input and output concrete." },
  { skillKey: "pattern_table_missing_value", label: "Find a missing value in an input-output table", grade: "6", ccCodes: ["6.EE.C.9"], strand: "patterns-sequences", rationale: "A table displays several instances of the same relationship, making invariant change and dependent quantities available for comparison." },
  { skillKey: "pattern_arithmetic_sequence", label: "Find a distant term in an arithmetic sequence", grade: "6", ccCodes: ["4.OA.C.5"], strand: "patterns-sequences", rationale: "Jumping directly to a distant term replaces repeated addition with multiplicative reasoning about the number of equal steps." },
  { skillKey: "pattern_linear_table_rule", label: "Use a linear table rule to predict an unlisted value", grade: "7", ccCodes: ["6.EE.C.9"], strand: "patterns-sequences", rationale: "A constant additive change in output for equal input steps can be summarized by a linear rule and used beyond the displayed table." },
  { skillKey: "pattern_graph_rate_change", label: "Use a graphed linear pattern to find its rate of change or a missing value", grade: "8", ccCodes: ["8.EE.B.5", "8.EE.B.6"], strand: "patterns-sequences", rationale: "Equal horizontal steps paired with equal vertical changes connect numerical patterns to slope and to the equation of a line." },

  // inequalities
  { skillKey: "ineq_symbol_meaning", label: "Interpret inequality symbols as comparisons and constraints", grade: "6", ccCodes: ["6.EE.B.8"], strand: "inequalities", rationale: "An inequality describes many possible values on one side of a boundary, unlike an equation that asserts exact equality." },
  { skillKey: "ineq_test_solution", label: "Test whether a number satisfies an inequality", grade: "6", ccCodes: ["6.EE.B.5", "6.EE.B.8"], strand: "inequalities", rationale: "Substitution reveals that an inequality has a set of solutions and gives a direct way to check any proposed member of that set." },
  { skillKey: "ineq_one_step_add_sub", label: "Solve one-step addition and subtraction inequalities", grade: "7", ccCodes: ["7.EE.B.4b"], strand: "inequalities", rationale: "Undoing an additive change preserves order, extending inverse-operation reasoning from a single equation solution to a boundary and a direction." },
  { skillKey: "ineq_one_step_mult_div_positive", label: "Solve one-step inequalities by multiplying or dividing by a positive number", grade: "7", ccCodes: ["7.EE.B.4b"], strand: "inequalities", rationale: "Scaling both sides by a positive number preserves their order and exposes the solution boundary." },
  { skillKey: "ineq_context_one_step", label: "Model and solve a one-step inequality from a constraint", grade: "7", ccCodes: ["7.EE.B.4b"], strand: "inequalities", rationale: "Budgets, capacities, and minimum requirements naturally describe ranges of allowed values rather than one exact answer." },
  { skillKey: "ineq_boundary_direction", label: "Connect an inequality's boundary and direction to its solution set", grade: "7", ccCodes: ["6.EE.B.8", "7.EE.B.4b"], strand: "inequalities", rationale: "A boundary point, inclusion choice, and direction together encode every solution, making the geometry of a one-variable inequality explicit." },
  { skillKey: "ineq_negative_coefficient", label: "Solve one-step inequalities involving multiplication or division by a negative number", grade: "7", ccCodes: ["7.EE.B.4b"], strand: "inequalities", rationale: "Multiplying by a negative reverses order because it reflects values across zero, explaining why the inequality direction must reverse." },
  { skillKey: "ineq_two_step", label: "Solve two-step inequalities with rational numbers", grade: "7", ccCodes: ["7.EE.B.4b"], strand: "inequalities", rationale: "Two-step inequalities combine equation-style isolation with careful preservation or reversal of order." },
  { skillKey: "ineq_context_two_step", label: "Model and solve a two-step inequality from a real-world constraint", grade: "7", ccCodes: ["7.EE.B.4b"], strand: "inequalities", rationale: "A fixed amount plus a per-unit amount models real limits such as fees, time, and capacity, where the useful answer is often a maximum whole number." },
];

export const EARLY_ALGEBRA_EDGES: SeedEdge[] = [
  // expressions-variables
  { fromKey: "expr_grouping_symbols", toKey: "expr_evaluate_numerical" },
  { fromKey: "expr_variable_meaning", toKey: "expr_terms_factors_coefficients" },
  { fromKey: "expr_variable_meaning", toKey: "expr_translate_words" },
  { fromKey: "expr_grouping_symbols", toKey: "expr_terms_factors_coefficients" },
  { fromKey: "expr_evaluate_numerical", toKey: "expr_evaluate_one_variable" },
  { fromKey: "expr_variable_meaning", toKey: "expr_evaluate_one_variable" },
  { fromKey: "expr_terms_factors_coefficients", toKey: "expr_evaluate_one_variable" },
  { fromKey: "expr_evaluate_one_variable", toKey: "expr_evaluate_two_variables" },
  { fromKey: "expr_evaluate_numerical", toKey: "expr_evaluate_exponents" },
  { fromKey: "expr_evaluate_one_variable", toKey: "expr_evaluate_fractions" },
  { fromKey: "expr_evaluate_two_variables", toKey: "expr_distributive_numeric" },
  { fromKey: "expr_terms_factors_coefficients", toKey: "expr_distributive_numeric" },
  { fromKey: "expr_evaluate_two_variables", toKey: "expr_evaluate_formulas" },
  { fromKey: "expr_evaluate_fractions", toKey: "expr_evaluate_formulas" },
  { fromKey: "expr_distributive_numeric", toKey: "expr_multi_step_signed" },
  { fromKey: "expr_evaluate_exponents", toKey: "expr_multi_step_signed" },

  // equations-1-2-step
  { fromKey: "eq_unknown_in_arithmetic", toKey: "eq_solution_meaning" },
  { fromKey: "expr_variable_meaning", toKey: "eq_solution_meaning" },
  { fromKey: "eq_solution_meaning", toKey: "eq_test_solution" },
  { fromKey: "expr_evaluate_one_variable", toKey: "eq_test_solution" },
  { fromKey: "eq_test_solution", toKey: "eq_one_step_add_sub" },
  { fromKey: "eq_test_solution", toKey: "eq_one_step_mult_div" },
  { fromKey: "eq_one_step_mult_div", toKey: "eq_one_step_fraction" },
  { fromKey: "eq_one_step_add_sub", toKey: "eq_one_step_context" },
  { fromKey: "eq_one_step_mult_div", toKey: "eq_one_step_context" },
  { fromKey: "eq_one_step_add_sub", toKey: "eq_two_step_positive" },
  { fromKey: "eq_one_step_mult_div", toKey: "eq_two_step_positive" },
  { fromKey: "eq_two_step_positive", toKey: "eq_two_step_integers" },
  { fromKey: "eq_one_step_fraction", toKey: "eq_two_step_fraction_decimal" },
  { fromKey: "eq_two_step_positive", toKey: "eq_two_step_fraction_decimal" },
  { fromKey: "eq_two_step_positive", toKey: "eq_parentheses" },
  { fromKey: "expr_distributive_numeric", toKey: "eq_parentheses" },
  { fromKey: "eq_one_step_context", toKey: "eq_context_multi_step" },
  { fromKey: "eq_two_step_integers", toKey: "eq_context_multi_step" },
  { fromKey: "eq_two_step_fraction_decimal", toKey: "eq_context_multi_step" },
  { fromKey: "eq_parentheses", toKey: "eq_both_sides" },
  { fromKey: "eq_two_step_integers", toKey: "eq_both_sides" },
  { fromKey: "eq_both_sides", toKey: "eq_identity_contradiction" },

  // patterns-sequences
  { fromKey: "pattern_rule_sequence", toKey: "pattern_additive_next" },
  { fromKey: "pattern_rule_sequence", toKey: "pattern_multiplicative_next" },
  { fromKey: "pattern_additive_next", toKey: "pattern_corresponding_sequences" },
  { fromKey: "pattern_multiplicative_next", toKey: "pattern_corresponding_sequences" },
  { fromKey: "pattern_rule_sequence", toKey: "pattern_function_machine_one_step" },
  { fromKey: "pattern_function_machine_one_step", toKey: "pattern_function_machine_two_step" },
  { fromKey: "pattern_corresponding_sequences", toKey: "pattern_table_missing_value" },
  { fromKey: "pattern_function_machine_one_step", toKey: "pattern_table_missing_value" },
  { fromKey: "pattern_additive_next", toKey: "pattern_arithmetic_sequence" },
  { fromKey: "pattern_table_missing_value", toKey: "pattern_linear_table_rule" },
  { fromKey: "pattern_function_machine_two_step", toKey: "pattern_linear_table_rule" },
  { fromKey: "pattern_arithmetic_sequence", toKey: "pattern_linear_table_rule" },
  { fromKey: "pattern_linear_table_rule", toKey: "pattern_graph_rate_change" },

  // inequalities
  { fromKey: "ineq_symbol_meaning", toKey: "ineq_test_solution" },
  { fromKey: "expr_evaluate_one_variable", toKey: "ineq_test_solution" },
  { fromKey: "ineq_test_solution", toKey: "ineq_one_step_add_sub" },
  { fromKey: "ineq_test_solution", toKey: "ineq_one_step_mult_div_positive" },
  { fromKey: "eq_one_step_add_sub", toKey: "ineq_one_step_add_sub" },
  { fromKey: "eq_one_step_mult_div", toKey: "ineq_one_step_mult_div_positive" },
  { fromKey: "ineq_one_step_add_sub", toKey: "ineq_context_one_step" },
  { fromKey: "ineq_one_step_mult_div_positive", toKey: "ineq_context_one_step" },
  { fromKey: "ineq_one_step_add_sub", toKey: "ineq_boundary_direction" },
  { fromKey: "ineq_one_step_mult_div_positive", toKey: "ineq_boundary_direction" },
  { fromKey: "ineq_one_step_mult_div_positive", toKey: "ineq_negative_coefficient" },
  { fromKey: "ineq_negative_coefficient", toKey: "ineq_two_step" },
  { fromKey: "ineq_one_step_add_sub", toKey: "ineq_two_step" },
  { fromKey: "ineq_context_one_step", toKey: "ineq_context_two_step" },
  { fromKey: "ineq_two_step", toKey: "ineq_context_two_step" },

  // Cross-domain prerequisites.
  { fromKey: "order_of_operations", toKey: "expr_evaluate_numerical" },
  // Cross-domain (g5 WNA → g5 early algebra): Reasoning backward to an unknown in a multi-step arithmetic relation presupposes evaluating that relation forward in the correct operation order.
  { fromKey: "order_of_operations", toKey: "eq_unknown_in_arithmetic" },
  { fromKey: "mult_distributive", toKey: "expr_distributive_numeric" },
  { fromKey: "exponents_repeated_mult", toKey: "expr_evaluate_exponents" },
  // Cross-domain (g4 fraction → g6 early algebra): Evaluating a variable expression at a fraction value requires fraction arithmetic (substitute x=3/4 into 2x+1 → multiply, then add).
  { fromKey: "multiply_fraction_by_whole", toKey: "expr_evaluate_fractions" },
  // Cross-domain (g5 fraction → g6 early algebra): Solving a one-step equation with a fraction coefficient/result is performed by multiplying (÷ = ×reciprocal) fractions: (2/3)x=4 → x = 4·(3/2).
  { fromKey: "multiply_fractions", toKey: "eq_one_step_fraction" },
  { fromKey: "integer_expressions", toKey: "expr_multi_step_signed" },
  { fromKey: "add_subtract_integers", toKey: "eq_two_step_integers" },
  { fromKey: "divide_integers", toKey: "eq_two_step_integers" },
  { fromKey: "divide_integers", toKey: "ineq_negative_coefficient" },
  { fromKey: "prop_table_from_rule", toKey: "pattern_linear_table_rule" },
  { fromKey: "prop_constant_graph", toKey: "pattern_graph_rate_change" },

  // Audited and deliberately declined hard gates:
  // P6 HOLD: Number comparison → ineq_symbol_meaning adds clutter without access value because comparison is basic and near-universal by g6.
  // P7 HOLD: Fact fluency → pattern_rule_sequence is not meaningful because the needed arithmetic is sub-grade fact fluency.
  // P8 HOLD: order_of_operations → expr_grouping_symbols would gate pure notation reading; the arithmetic gate belongs on expr_evaluate_numerical.
];

/**
 * INFERENCE-ONLY cross-domain edges (kind:"implies") — genuine information
 * dependencies from the 2026-07-19 entrance audit, given a home that never gates.
 * `implies` feeds the two blessed inference consumers only (implicit credit +
 * placement diagnostic); it is invisible to the frontier gate and prereq
 * recommendations. Stamped with this (to-side) domain by the rebuild.
 *
 * Contract (vetted against the real target TEMPLATES): `expr_grouping_symbols`
 * asks "which operation must be completed first?" — that IS applying order of
 * operations, so `order_of_operations` genuinely underlies it; and
 * `pattern_rule_sequence` computes the Nth term of an "add K each time" sequence
 * (K = 3-9), i.e. the repeated-addition/skip-counting `skip_count_3s_4s` teaches.
 *
 * PRUNED (an adversarial template-vetting review (§5) — target template does NOT exercise
 * the source): `prop_table_from_rule -> expr_variable_meaning` (the target solves
 * one ticket-price unknown; no ratio table / multiplicative rule) and
 * `compare_multidigit -> ineq_symbol_meaning` (the target reads a signed
 * number-line constraint around -8..8; no 4-6 digit place-value comparison).
 */
export const EARLY_ALGEBRA_IMPLIES_EDGES: SeedEdge[] = [
  // "which operation must be completed first?" IS applying order of operations.
  { fromKey: "order_of_operations", toKey: "expr_grouping_symbols" },
  // computing the Nth term of an "add K each time" sequence IS repeated skip-counting.
  { fromKey: "skip_count_3s_4s", toKey: "pattern_rule_sequence" },
];
