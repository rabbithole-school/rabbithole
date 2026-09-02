/**
 * Seed data: Algebra 1 — the real course above the early-algebra on-ramp.
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * Six strands span grades 8–9 (8.EE/8.F + HS A-SSE/A-APR/A-CED/A-REI/F-IF/F-LE)
 * and form the ceiling rung of the cross-domain practice ladder, one step above
 * `early-algebra`: multi-step linear equations, linear functions, systems,
 * exponents & exponential growth, polynomials & factoring, and quadratics.
 *
 * Fifteen live cross-domain prerequisites connect the graph to the pre-algebra,
 * signed-number, proportional-reasoning, coordinate-geometry, and whole-number
 * skills it extends. They are declared here (the target side), so the
 * foreign-aware frontier resolver checks mastery in each source domain. A small
 * set of inference-only `implies` edges lets mastery of an Algebra 1 skill credit
 * the lower-grade skill it structurally subsumes, for placement inference only.
 */

import type { SeedEdge, SeedSkill } from "./wholeNumberArithmeticGraph";

export const ALGEBRA_1_DOMAIN = "algebra-1";

export const ALGEBRA_1_SKILLS: SeedSkill[] = [
  // linear-equations
  { skillKey: "lin_eq_combine_terms", label: "Solve linear equations by combining like terms before isolating the variable", grade: "8", ccCodes: ["8.EE.C.7b"], strand: "linear-equations", rationale: "Collapsing each side to a single linear expression is the move that turns a cluttered equation into one the balance rules can finish." },
  { skillKey: "lin_eq_distribute", label: "Solve linear equations that require distributing over parentheses first", grade: "8", ccCodes: ["8.EE.C.7b"], strand: "linear-equations", rationale: "A grouped quantity must be expanded before like terms are visible, so distribution is the gateway to every multi-step linear equation." },
  { skillKey: "lin_eq_clear_fractions", label: "Solve linear equations by clearing fraction or decimal coefficients", grade: "8", ccCodes: ["8.EE.C.7b", "A-REI.B.3"], strand: "linear-equations", rationale: "Multiplying through by a common denominator converts an awkward rational equation into an integer one, keeping the arithmetic exact." },
  { skillKey: "lin_eq_justify_steps", label: "Justify each equation-solving step as an equality-preserving move", grade: "9", ccCodes: ["A-REI.A.1"], strand: "linear-equations", rationale: "Naming the property behind each step makes solving a chain of deductions rather than remembered manipulation, which is what later proof-style algebra requires." },
  { skillKey: "lin_eq_literal", label: "Rearrange a literal equation to isolate a specified quantity", grade: "9", ccCodes: ["A-CED.A.4"], strand: "linear-equations", rationale: "Solving a formula for a chosen variable applies inverse-operation reasoning to symbolic coefficients, the skill that makes formulas reusable across problems." },
  { skillKey: "lin_eq_abs_value", label: "Solve absolute value equations by splitting into two cases", grade: "9", ccCodes: ["A-REI.B.3"], strand: "linear-equations", rationale: "An absolute value equation encodes two distances from zero, so it must be broken into two linear equations before either can be solved." },
  { skillKey: "lin_ineq_multi_step", label: "Solve multi-step linear inequalities, reversing direction on negative scaling", grade: "8", ccCodes: ["A-REI.B.3"], strand: "linear-equations", rationale: "Multi-step inequalities extend linear solving to a boundary and a direction, where scaling by a negative reflects order and must flip the relation." },
  { skillKey: "lin_ineq_compound", label: "Solve compound inequalities and describe the solution set", grade: "9", ccCodes: ["A-REI.B.3"], strand: "linear-equations", rationale: "Joining constraints with 'and' or 'or' produces an intersection or union of intervals, forcing precise reasoning about which values satisfy the whole statement." },
  { skillKey: "lin_eq_model_context", label: "Model a context with a linear equation or inequality and solve it", grade: "9", ccCodes: ["A-CED.A.1"], strand: "linear-equations", rationale: "Deciding what is unknown and how quantities are linked is where equation solving earns its purpose and where the answer must be checked against the situation." },

  // linear-functions
  { skillKey: "fn_identify_function", label: "Decide whether a table, graph, or set of pairs defines a function", grade: "8", ccCodes: ["8.F.A.1", "F-IF.A.1"], strand: "linear-functions", rationale: "The single-output rule is the definition every later function idea rests on, so recognizing it across representations comes first." },
  { skillKey: "fn_notation_evaluate", label: "Evaluate and interpret function notation f(x)", grade: "9", ccCodes: ["F-IF.A.2"], strand: "linear-functions", rationale: "Reading f(x) as 'the output at input x' separates a function's rule from its values and is the language all function work is written in." },
  { skillKey: "slope_two_points", label: "Compute the slope of a line from two points", grade: "8", ccCodes: ["8.F.B.4", "F-IF.B.6"], strand: "linear-functions", rationale: "Slope as change-in-output over change-in-input turns a line into a rate, the single number that governs its equation and behavior." },
  { skillKey: "slope_from_graph", label: "Read slope and intercepts directly from a graph", grade: "8", ccCodes: ["8.F.B.4"], strand: "linear-functions", rationale: "Extracting rate and starting value from a picture connects the visual line to the algebraic parameters that reproduce it." },
  { skillKey: "slope_intercept_form", label: "Move between y = mx + b and its graph", grade: "8", ccCodes: ["8.F.A.3"], strand: "linear-functions", rationale: "Slope-intercept form is the hinge between equation and graph, letting a scholar draw a line from its rule and read a rule off a line." },
  { skillKey: "lin_fn_from_two_points", label: "Write the equation of a line through two given points", grade: "9", ccCodes: ["F-LE.A.2"], strand: "linear-functions", rationale: "Recovering a linear rule from two observations is the core modeling move: two data points determine the rate and the whole line." },
  { skillKey: "lin_fn_point_slope", label: "Write and convert line equations using point-slope form", grade: "9", ccCodes: ["F-LE.A.2"], strand: "linear-functions", rationale: "Point-slope form builds a line directly from one point and a rate, making it the most efficient bridge from given information to an equation." },
  { skillKey: "lin_fn_standard_form", label: "Convert among linear forms and find intercepts from standard form", grade: "9", ccCodes: ["A-CED.A.2"], strand: "linear-functions", rationale: "Standard form exposes both intercepts symmetrically and is the form systems and constraints are usually written in, so fluent conversion keeps every representation available." },
  { skillKey: "lin_fn_interpret_context", label: "Interpret slope and intercept within a modeling context", grade: "8", ccCodes: ["8.F.B.4"], strand: "linear-functions", rationale: "Attaching units and meaning to rate and starting value is what makes a linear model explanatory rather than a bare formula." },
  { skillKey: "lin_fn_parallel_perpendicular", label: "Relate the slopes of parallel and perpendicular lines", grade: "9", ccCodes: ["G-GPE.B.5"], strand: "linear-functions", rationale: "Equal and negative-reciprocal slopes translate a geometric relationship between lines into an algebraic condition, linking coordinate geometry to functions." },
  { skillKey: "fn_compare_representations", label: "Compare two linear functions given in different representations", grade: "8", ccCodes: ["8.F.A.2"], strand: "linear-functions", rationale: "Comparing a graph against a table or equation forces a scholar to extract the same rate and intercept from unlike surfaces and reason about which grows faster." },

  // systems
  { skillKey: "sys_solution_meaning", label: "Interpret and verify the solution of a system as a point on both lines", grade: "8", ccCodes: ["8.EE.C.8a"], strand: "systems", rationale: "A system's solution is the shared point that satisfies every equation at once, and grasping that meaning is what makes each solving method sensible rather than mechanical." },
  { skillKey: "sys_solve_graphing", label: "Solve a system of linear equations by graphing", grade: "8", ccCodes: ["8.EE.C.8b"], strand: "systems", rationale: "Graphing shows the solution as an intersection, grounding the algebraic methods in the geometry of two lines meeting." },
  { skillKey: "sys_substitution", label: "Solve a system of linear equations by substitution", grade: "8", ccCodes: ["8.EE.C.8b", "A-REI.C.6"], strand: "systems", rationale: "Replacing one variable with its equivalent expression collapses two equations into one solvable equation, the first exact algebraic method for systems." },
  { skillKey: "sys_elimination", label: "Solve a system of linear equations by elimination", grade: "9", ccCodes: ["A-REI.C.5", "A-REI.C.6"], strand: "systems", rationale: "Adding scaled equations to cancel a variable relies on the fact that a system's solution is preserved by such combinations, an idea that generalizes to larger systems." },
  { skillKey: "sys_special_cases", label: "Recognize systems with no solution or infinitely many solutions", grade: "8", ccCodes: ["8.EE.C.8b"], strand: "systems", rationale: "Parallel and coincident lines reveal that solving a system is really about how two lines relate, not always about finding one point." },
  { skillKey: "sys_model_context", label: "Model a context with a system of equations and solve it", grade: "8", ccCodes: ["8.EE.C.8c", "A-CED.A.3"], strand: "systems", rationale: "Two unknowns constrained by two relationships is the natural shape of mixture, rate, and cost problems, where a system is the tool that separates the quantities." },
  { skillKey: "sys_linear_inequalities", label: "Graph the solution region of a system of linear inequalities", grade: "9", ccCodes: ["A-REI.D.12"], strand: "systems", rationale: "Intersecting half-planes turns several constraints into a feasible region, extending single-inequality reasoning to the two-variable setting behind optimization." },

  // exponents-exponential
  { skillKey: "exp_product_quotient", label: "Apply the product and quotient rules for exponents", grade: "8", ccCodes: ["8.EE.A.1"], strand: "exponents-exponential", rationale: "Adding and subtracting exponents follows from counting repeated factors, the structural fact that all exponent manipulation is built on." },
  { skillKey: "exp_power_rule", label: "Apply the power-of-a-power and power-of-a-product rules", grade: "8", ccCodes: ["8.EE.A.1"], strand: "exponents-exponential", rationale: "A power raised to a power multiplies the counts of factors, extending the product rule to nested exponents." },
  { skillKey: "exp_zero_negative", label: "Evaluate expressions with zero and negative exponents", grade: "8", ccCodes: ["8.EE.A.1"], strand: "exponents-exponential", rationale: "Requiring the exponent rules to keep holding forces zero to mean one and negatives to mean reciprocals, completing the integer-exponent system consistently." },
  { skillKey: "roots_square_cube", label: "Evaluate square and cube roots and solve x² = p and x³ = p", grade: "8", ccCodes: ["8.EE.A.2"], strand: "exponents-exponential", rationale: "Reading a root as the inverse of a power is the first equation whose solution is not found by the four operations, and it seeds later radical and quadratic work." },
  { skillKey: "roots_simplify_radicals", label: "Simplify integer-index roots", grade: "9", ccCodes: ["N-RN.A.2"], strand: "exponents-exponential", rationale: "Factoring out perfect-power parts puts an irrational root in exact canonical form, which the quadratic formula and radical arithmetic depend on." },
  { skillKey: "sci_notation_convert", label: "Convert between standard and scientific notation and compare magnitudes", grade: "8", ccCodes: ["8.EE.A.3"], strand: "exponents-exponential", rationale: "Expressing a number as a coefficient times a power of ten makes its order of magnitude explicit and manageable for very large or very small quantities." },
  { skillKey: "sci_notation_operations", label: "Multiply and divide numbers written in scientific notation", grade: "8", ccCodes: ["8.EE.A.4"], strand: "exponents-exponential", rationale: "Operating on scientific notation combines the exponent rules with coefficient arithmetic, the everyday calculation of scientific and engineering magnitudes." },
  { skillKey: "exp_fn_evaluate", label: "Evaluate exponential functions of the form a·bˣ", grade: "9", ccCodes: ["F-IF.A.2", "F-LE.A.2"], strand: "exponents-exponential", rationale: "Substituting into a·bˣ produces the repeated multiplication that defines exponential change, the concrete basis for reasoning about growth." },
  { skillKey: "exp_growth_decay", label: "Identify growth versus decay and the rate in y = a·bˣ", grade: "9", ccCodes: ["F-LE.A.1c", "F-IF.C.8b"], strand: "exponents-exponential", rationale: "Reading b as a constant multiplicative rate, above or below one, is how the parameters of an exponential model are interpreted in context." },
  { skillKey: "lin_vs_exp", label: "Distinguish linear from exponential growth across tables and contexts", grade: "9", ccCodes: ["F-LE.A.1"], strand: "exponents-exponential", rationale: "Telling a constant difference from a constant ratio is the decision that determines whether a situation is modeled by a line or an exponential, the central contrast of Algebra 1 modeling." },

  // polynomials-factoring
  { skillKey: "poly_classify", label: "Classify a polynomial by degree, terms, and leading coefficient", grade: "9", ccCodes: ["A-SSE.A.1a"], strand: "polynomials-factoring", rationale: "Naming a polynomial's structure supplies the vocabulary needed to predict how it behaves and which operations and factoring strategies apply." },
  { skillKey: "poly_add_subtract", label: "Add and subtract polynomials by combining like terms", grade: "9", ccCodes: ["A-APR.A.1"], strand: "polynomials-factoring", rationale: "Combining terms of equal degree treats a polynomial as a sum of independent place-like parts, establishing closure under addition." },
  { skillKey: "poly_multiply_monomial", label: "Multiply a polynomial by a monomial", grade: "9", ccCodes: ["A-APR.A.1"], strand: "polynomials-factoring", rationale: "Distributing a single term across a polynomial applies the distributive property with exponents and is the atomic step inside every larger product." },
  { skillKey: "poly_multiply_binomials", label: "Multiply two binomials", grade: "9", ccCodes: ["A-APR.A.1"], strand: "polynomials-factoring", rationale: "Multiplying two binomials requires distributing every term over every other, the pattern that produces the trinomials factoring must later undo." },
  { skillKey: "poly_special_products", label: "Expand (a ± b)² and (a + b)(a − b) as patterns", grade: "9", ccCodes: ["A-APR.A.1", "A-SSE.A.2"], strand: "polynomials-factoring", rationale: "Recognizing squares and difference-of-squares as reusable forms replaces slower term-by-term work and is exactly the structure completing the square exploits." },
  { skillKey: "factor_gcf", label: "Factor out the greatest common monomial factor", grade: "9", ccCodes: ["A-SSE.A.2"], strand: "polynomials-factoring", rationale: "Extracting the common factor reverses monomial multiplication and is the first factoring step to attempt because it simplifies everything that follows." },
  { skillKey: "factor_trinomial_simple", label: "Factor a trinomial x² + bx + c", grade: "9", ccCodes: ["A-SSE.B.3a"], strand: "polynomials-factoring", rationale: "Finding two numbers with a given sum and product inverts binomial multiplication and exposes the roots hidden in a quadratic expression." },
  { skillKey: "factor_trinomial_general", label: "Factor a trinomial ax² + bx + c", grade: "9", ccCodes: ["A-SSE.B.3a"], strand: "polynomials-factoring", rationale: "A leading coefficient forces grouping or the ac-method, generalizing simple-trinomial factoring to every factorable quadratic." },
  { skillKey: "factor_special_forms", label: "Factor a difference of squares and perfect-square trinomials", grade: "9", ccCodes: ["A-SSE.A.2"], strand: "polynomials-factoring", rationale: "Reading special-product patterns backward factors them instantly, a recognition that shortcuts solving and simplifying throughout algebra." },

  // quadratics
  { skillKey: "quad_graph_features", label: "Read a parabola's vertex, axis, intercepts, and opening direction", grade: "9", ccCodes: ["F-IF.B.4"], strand: "quadratics", rationale: "Locating the vertex, axis, and intercepts describes a quadratic's behavior geometrically and anchors every algebraic solving method to its graph." },
  { skillKey: "quad_solve_sqrt", label: "Solve ax² = c and (x − p)² = q by taking square roots", grade: "9", ccCodes: ["A-REI.B.4b"], strand: "quadratics", rationale: "Undoing a square with a root — and keeping both signs — is the most direct quadratic solution and the step completing the square reduces every quadratic to." },
  { skillKey: "quad_zero_product", label: "Apply the zero-product property to a factored equation", grade: "9", ccCodes: ["A-REI.B.4b"], strand: "quadratics", rationale: "A product equals zero only when a factor does, the logical principle that converts a factored quadratic into two linear equations." },
  { skillKey: "quad_solve_factoring", label: "Solve a quadratic equation by factoring", grade: "9", ccCodes: ["A-REI.B.4b", "A-SSE.B.3a"], strand: "quadratics", rationale: "Factoring then applying the zero-product property is the fastest exact method when the roots are rational and ties solving to the structure of the expression." },
  { skillKey: "quad_complete_square", label: "Solve a quadratic by completing the square", grade: "9", ccCodes: ["A-REI.B.4a"], strand: "quadratics", rationale: "Rewriting a quadratic as a perfect square plus a constant solves any quadratic and is the derivation from which the quadratic formula and vertex form both follow." },
  { skillKey: "quad_formula", label: "Solve a quadratic equation with the quadratic formula", grade: "9", ccCodes: ["A-REI.B.4b"], strand: "quadratics", rationale: "The formula packages completing the square into a general solution that works for every quadratic, including those with irrational roots." },
  { skillKey: "quad_discriminant", label: "Use the discriminant to count and classify solutions", grade: "9", ccCodes: ["A-REI.B.4"], strand: "quadratics", rationale: "The sign of b² − 4ac reveals how many real solutions exist before any are computed, connecting the algebra to the parabola's position." },
  { skillKey: "quad_vertex_form", label: "Use vertex form to read features and convert a quadratic", grade: "9", ccCodes: ["F-IF.C.8a"], strand: "quadratics", rationale: "Vertex form displays the maximum or minimum and the axis directly, making it the form of choice for interpreting and graphing a quadratic." },
  { skillKey: "quad_model_context", label: "Model a projectile or area context with a quadratic", grade: "9", ccCodes: ["A-CED.A.1", "F-IF.B.4"], strand: "quadratics", rationale: "Projectile height and area problems are inherently quadratic, and interpreting their vertex and intercepts is where quadratic solving pays off in the world." },
];

export const ALGEBRA_1_EDGES: SeedEdge[] = [
  // linear-equations
  { fromKey: "lin_eq_combine_terms", toKey: "lin_eq_distribute" },
  { fromKey: "lin_eq_distribute", toKey: "lin_eq_clear_fractions" },
  { fromKey: "lin_eq_distribute", toKey: "lin_eq_justify_steps" },
  { fromKey: "lin_eq_clear_fractions", toKey: "lin_eq_literal" },
  { fromKey: "lin_eq_distribute", toKey: "lin_eq_abs_value" },
  { fromKey: "lin_eq_combine_terms", toKey: "lin_ineq_multi_step" },
  { fromKey: "lin_ineq_multi_step", toKey: "lin_ineq_compound" },
  { fromKey: "lin_eq_clear_fractions", toKey: "lin_eq_model_context" },

  // linear-functions
  { fromKey: "fn_identify_function", toKey: "fn_notation_evaluate" },
  { fromKey: "slope_two_points", toKey: "slope_intercept_form" },
  { fromKey: "slope_from_graph", toKey: "slope_intercept_form" },
  { fromKey: "slope_intercept_form", toKey: "lin_fn_from_two_points" },
  { fromKey: "slope_intercept_form", toKey: "lin_fn_interpret_context" },
  { fromKey: "slope_intercept_form", toKey: "fn_compare_representations" },
  { fromKey: "slope_from_graph", toKey: "fn_compare_representations" },
  { fromKey: "lin_fn_from_two_points", toKey: "lin_fn_point_slope" },
  { fromKey: "lin_fn_point_slope", toKey: "lin_fn_standard_form" },
  { fromKey: "lin_fn_from_two_points", toKey: "lin_fn_parallel_perpendicular" },

  // systems
  { fromKey: "sys_solution_meaning", toKey: "sys_solve_graphing" },
  { fromKey: "sys_solve_graphing", toKey: "sys_substitution" },
  { fromKey: "sys_solve_graphing", toKey: "sys_special_cases" },
  { fromKey: "sys_substitution", toKey: "sys_elimination" },
  { fromKey: "sys_substitution", toKey: "sys_model_context" },
  { fromKey: "sys_solve_graphing", toKey: "sys_linear_inequalities" },
  // Cross-strand (linear-functions → systems): a system solved by graphing is the intersection of two y = mx + b lines, so graphing them comes first.
  { fromKey: "slope_intercept_form", toKey: "sys_solve_graphing" },
  // Cross-strand (linear-equations → systems): the equation substitution produces still needs distribution and like-term collection to finish.
  { fromKey: "lin_eq_distribute", toKey: "sys_substitution" },
  // Cross-strand (linear-equations → systems): a two-variable inequality region is bounded by the same compound-constraint reasoning done on one line.
  { fromKey: "lin_ineq_compound", toKey: "sys_linear_inequalities" },

  // exponents-exponential
  { fromKey: "exp_product_quotient", toKey: "exp_power_rule" },
  { fromKey: "exp_power_rule", toKey: "exp_zero_negative" },
  { fromKey: "exp_zero_negative", toKey: "sci_notation_convert" },
  { fromKey: "sci_notation_convert", toKey: "sci_notation_operations" },
  { fromKey: "roots_square_cube", toKey: "roots_simplify_radicals" },
  { fromKey: "exp_zero_negative", toKey: "exp_fn_evaluate" },
  { fromKey: "exp_fn_evaluate", toKey: "exp_growth_decay" },
  { fromKey: "exp_growth_decay", toKey: "lin_vs_exp" },
  // Cross-strand (linear-functions → exponents-exponential): distinguishing exponential from linear growth requires already holding the linear model to contrast against.
  { fromKey: "slope_intercept_form", toKey: "lin_vs_exp" },

  // polynomials-factoring
  { fromKey: "poly_classify", toKey: "poly_add_subtract" },
  { fromKey: "poly_add_subtract", toKey: "poly_multiply_monomial" },
  { fromKey: "poly_multiply_monomial", toKey: "poly_multiply_binomials" },
  { fromKey: "poly_multiply_binomials", toKey: "poly_special_products" },
  { fromKey: "poly_multiply_monomial", toKey: "factor_gcf" },
  { fromKey: "poly_multiply_binomials", toKey: "factor_trinomial_simple" },
  { fromKey: "factor_trinomial_simple", toKey: "factor_trinomial_general" },
  { fromKey: "poly_special_products", toKey: "factor_special_forms" },
  { fromKey: "factor_trinomial_simple", toKey: "factor_special_forms" },

  // quadratics
  { fromKey: "quad_zero_product", toKey: "quad_solve_factoring" },
  { fromKey: "quad_solve_sqrt", toKey: "quad_complete_square" },
  { fromKey: "quad_complete_square", toKey: "quad_formula" },
  { fromKey: "quad_formula", toKey: "quad_discriminant" },
  { fromKey: "quad_complete_square", toKey: "quad_vertex_form" },
  { fromKey: "quad_graph_features", toKey: "quad_vertex_form" },
  { fromKey: "quad_formula", toKey: "quad_model_context" },
  { fromKey: "quad_graph_features", toKey: "quad_model_context" },
  // Cross-strand (exponents-exponential → quadratics): solving x² = p by roots is the special case that seeds every square-root-based quadratic method.
  { fromKey: "roots_square_cube", toKey: "quad_solve_sqrt" },
  // Cross-strand (polynomials-factoring → quadratics): the zero-product property acts on the factored form GCF factoring first exposes.
  { fromKey: "factor_gcf", toKey: "quad_zero_product" },
  // Cross-strand (polynomials-factoring → quadratics): solving by factoring is exactly trinomial factoring applied to an equation set to zero.
  { fromKey: "factor_trinomial_simple", toKey: "quad_solve_factoring" },
  // Cross-strand (polynomials-factoring → quadratics): completing the square rewrites the quadratic using the perfect-square pattern from special products.
  { fromKey: "poly_special_products", toKey: "quad_complete_square" },
  // Cross-strand (exponents-exponential → quadratics): the quadratic formula's answers are simplified radicals, so radical form is a prerequisite for stating them.
  { fromKey: "roots_simplify_radicals", toKey: "quad_formula" },
  // Cross-strand (linear-functions → quadratics): reading a line's graph for slope and intercepts is the graph-reading habit extended to a parabola's features.
  { fromKey: "slope_intercept_form", toKey: "quad_graph_features" },

  // Cross-domain prerequisites (foreign fromKey — declared here, the target side).
  // Cross-domain (g8 early-algebra → g8 algebra-1): collecting the variable onto one side is the pre-algebra move Algebra 1's like-term solving assumes fluent.
  { fromKey: "eq_both_sides", toKey: "lin_eq_combine_terms" },
  // Cross-domain (g7 early-algebra → g8 algebra-1): combining like terms with signed distribution is the expression skill that solving now embeds in an equation.
  { fromKey: "expr_multi_step_signed", toKey: "lin_eq_combine_terms" },
  // Cross-domain (g7 early-algebra → g8 algebra-1): distributing before isolating was first met on two-step equations with parentheses.
  { fromKey: "eq_parentheses", toKey: "lin_eq_distribute" },
  // Cross-domain (g7 early-algebra → g8 algebra-1): multi-step linear inequalities extend the two-step inequality solving learned in pre-algebra.
  { fromKey: "ineq_two_step", toKey: "lin_ineq_multi_step" },
  // Cross-domain (g8 early-algebra → g8 algebra-1): a system's no-solution / infinitely-many case is the identity-vs-contradiction distinction seen on a single equation.
  { fromKey: "eq_identity_contradiction", toKey: "sys_special_cases" },
  // Cross-domain (g8 early-algebra → g8 algebra-1): reading rate of change off a graphed line is exactly what slope from a graph formalizes.
  { fromKey: "pattern_graph_rate_change", toKey: "slope_from_graph" },
  // Cross-domain (g7 early-algebra → g9 algebra-1): writing a line through two points builds on summarizing a linear table as a rule.
  { fromKey: "pattern_linear_table_rule", toKey: "lin_fn_from_two_points" },
  // Cross-domain (g6 geometry-measurement → g8 algebra-1): reading slope off a graph presupposes plotting and reading points across all four quadrants.
  { fromKey: "four_quadrant_plane", toKey: "slope_from_graph" },
  // Cross-domain (g7 ratio-proportion-percent → g8 algebra-1): the constant of proportionality read from a graph is the slope of a line through the origin.
  { fromKey: "prop_constant_graph", toKey: "slope_two_points" },
  // Cross-domain (g7 ratio-proportion-percent → g8 algebra-1): y = kx is slope-intercept form with zero intercept, the seed of the general y = mx + b.
  { fromKey: "prop_write_equation", toKey: "slope_intercept_form" },
  // Cross-domain (g6 whole-number-arithmetic → g8 algebra-1): the exponent rules generalize the repeated-multiplication meaning of a power.
  { fromKey: "exponents_repeated_mult", toKey: "exp_product_quotient" },
  // Cross-domain (g7 integers-coordinates → g9 algebra-1): subtracting polynomials is signed integer subtraction applied coefficient by coefficient.
  { fromKey: "add_subtract_integers", toKey: "poly_add_subtract" },
  // Cross-domain (g7 integers-coordinates → g8 algebra-1): negative exponents mean reciprocals, and reasoning about them rests on signed multiplication.
  { fromKey: "multiply_integers", toKey: "exp_zero_negative" },
  // Cross-domain (g7 ratio-proportion-percent → g9 algebra-1): a growth or decay rate is a percent change compounded each step.
  { fromKey: "percent_change", toKey: "exp_growth_decay" },
  // Cross-domain (g6 integers-coordinates → g9 algebra-1): the two cases of an absolute value equation are its two distances from zero.
  { fromKey: "absolute_value_distance_zero", toKey: "lin_eq_abs_value" },
];

/**
 * INFERENCE-ONLY cross-domain edges (kind:"implies") — genuine information
 * dependencies given a home that never gates. `implies` feeds the two blessed
 * inference consumers only (implicit credit + placement diagnostic); it is
 * invisible to the frontier gate and prereq recommendations. Direction matches
 * `buildsOn` (fromKey is the credited prerequisite, toKey the mastered skill) and
 * is stamped with this (to-side, algebra-1) domain by the rebuild — verified
 * against `EARLY_ALGEBRA_IMPLIES_EDGES` and the `ancestorWeights` /
 * `topoOrderStrand` consumers.
 *
 * Each edge names a lower-grade skill that the Algebra 1 skill structurally
 * subsumes but does NOT already declare as a hard `buildsOn` prerequisite, so
 * placement can credit it without over-gating.
 */
export const ALGEBRA_1_IMPLIES_EDGES: SeedEdge[] = [
  // Solving a linear equation by collecting like terms subsumes solving a two-step integer equation.
  { fromKey: "eq_two_step_integers", toKey: "lin_eq_combine_terms" },
  // Clearing fraction/decimal coefficients from a multi-step equation subsumes solving a two-step fraction/decimal equation.
  { fromKey: "eq_two_step_fraction_decimal", toKey: "lin_eq_clear_fractions" },
  // Multi-step inequality solving demonstrates the negative-coefficient direction flip in isolation.
  { fromKey: "ineq_negative_coefficient", toKey: "lin_ineq_multi_step" },
  // Multiplying two binomials exercises and demonstrates signed integer multiplication term by term.
  { fromKey: "multiply_integers", toKey: "poly_multiply_binomials" },
];
