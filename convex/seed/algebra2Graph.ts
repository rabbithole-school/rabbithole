/**
 * Seed data: Algebra 2 — the course above Algebra 1.
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * Seven strands span grades 10–11 (HS N-RN/N-CN/A-SSE/A-APR/A-REI/A-CED/F-IF/
 * F-BF/F-LE) and form the next rung of the cross-domain practice ladder, one step
 * above `algebra-1`: functions and their transformations, complex numbers and the
 * rest of quadratics, polynomial functions, rational functions, radicals and
 * rational exponents, exponentials and logarithms, and sequences and series.
 *
 * Deliberately OUT of this domain: trigonometry and the unit circle (a later
 * strand or domain of its own), statistics and probability distributions,
 * conic sections, and matrices.
 *
 * Prerequisites are honest. A node that really needs Algebra 1 factoring builds
 * on the Algebra 1 factoring node, even though that keeps it locked for a
 * scholar who hasn't reached factoring yet; the polynomial and rational strands
 * legitimately wait on Algebra 1 multiplying and factoring. The graph still has
 * several entrances that need only early Algebra 1 (function notation, the
 * exponent rules, exponential functions, simplifying radicals, an early-algebra
 * arithmetic-sequence pattern), so a scholar partway through Algebra 1 finds open
 * work in the functions, radicals, exponential-logarithmic and sequences strands
 * and in the first half of complex numbers.
 *
 * The cross-domain prerequisites are declared here (the target side), so the
 * foreign-aware frontier resolver checks mastery in the source domain. Every one
 * is grade-forward (source grade ≤ target grade), and their source domains
 * (algebra-1, early-algebra, geometry-measurement) are a subset of Algebra 1's
 * own prerequisite domains plus Algebra 1 itself. A small set of inference-only
 * `implies` edges lets mastery of an Algebra 2 skill credit the lower-grade skill
 * it structurally subsumes, for placement inference only.
 *
 * Modulus of a complex number is left out of `cx_plane_plot`: it needs the
 * Pythagorean theorem, which no registered graph has a node for, so the
 * prerequisite could not be stated honestly.
 */

import type { SeedEdge, SeedSkill } from "./wholeNumberArithmeticGraph";

export const ALGEBRA_2_DOMAIN = "algebra-2";

export const ALGEBRA_2_SKILLS: SeedSkill[] = [
  // functions
  { skillKey: "fn_domain_range_graph", label: "Read the domain and range of a function from its graph", grade: "10", ccCodes: ["F-IF.B.5"], strand: "functions", rationale: "Describing which inputs a function accepts and which outputs it reaches is the first question asked of every new function family, and the graph answers it at a glance." },
  { skillKey: "fn_avg_rate_of_change", label: "Compute the average rate of change of a function over an interval", grade: "10", ccCodes: ["F-IF.B.6"], strand: "functions", rationale: "Slope between two points on a curve extends the constant rate of a line to functions whose rate keeps changing, the idea calculus later sharpens." },
  { skillKey: "fn_parent_families", label: "Match parent functions to their graphs and equations", grade: "10", ccCodes: ["F-IF.C.7"], strand: "functions", rationale: "Knowing the shape of each parent function (line, parabola, cubic, absolute value, square root, exponential, reciprocal) gives every later transformation a starting picture to move." },
  { skillKey: "fn_transform_translate", label: "Translate a graph with f(x) + k and f(x − h)", grade: "10", ccCodes: ["F-BF.B.3"], strand: "functions", rationale: "Shifting a graph is the simplest transformation, and seeing that subtracting h moves it right is the counterintuitive fact the rest of the strand depends on." },
  { skillKey: "fn_transform_scale_reflect", label: "Stretch, shrink, and reflect a graph with a·f(x) and f(−x)", grade: "10", ccCodes: ["F-BF.B.3"], strand: "functions", rationale: "Scaling and reflecting change a graph's shape and orientation rather than its position, completing the set of moves that build any family member from its parent." },
  { skillKey: "fn_transform_combined", label: "Read and write a·f(x − h) + k from a graph", grade: "10", ccCodes: ["F-BF.B.3"], strand: "functions", rationale: "Combining a stretch, a reflection, and two shifts into one equation is how a scholar names any graph in a family from the parent shape and a few anchor points." },
  { skillKey: "fn_piecewise_evaluate", label: "Evaluate and graph a piecewise-defined function", grade: "10", ccCodes: ["F-IF.C.7b"], strand: "functions", rationale: "A piecewise rule applies different formulas on different parts of the domain, so evaluating one requires deciding which interval an input belongs to before computing." },
  { skillKey: "fn_compose", label: "Evaluate and write a composition f(g(x))", grade: "10", ccCodes: ["F-BF.A.1c"], strand: "functions", rationale: "Feeding one function's output into another builds complicated functions from simple ones and is the operation that inverses undo." },
  { skillKey: "fn_inverse_find", label: "Find the inverse of a function and write it with f⁻¹ notation", grade: "10", ccCodes: ["F-BF.B.4a"], strand: "functions", rationale: "Swapping the roles of input and output and solving for the new output reverses a function, the move that defines logarithms and radicals as inverses." },
  { skillKey: "fn_inverse_graph", label: "Graph an inverse by reflecting over y = x and restrict a domain so it exists", grade: "10", ccCodes: ["F-BF.B.4"], strand: "functions", rationale: "Reflecting across y = x shows an inverse geometrically, and the need to restrict the domain of a function like x² explains when an inverse is itself a function." },

  // complex-quadratics
  { skillKey: "cx_imaginary_unit", label: "Write the square root of a negative number using i, and simplify powers of i", grade: "10", ccCodes: ["N-CN.A.1"], strand: "complex-quadratics", rationale: "Defining i as a number whose square is −1 extends the number system so every square root exists, and its four-step cycle of powers is the first fact about how it behaves." },
  { skillKey: "cx_add_subtract", label: "Add and subtract complex numbers", grade: "10", ccCodes: ["N-CN.A.2"], strand: "complex-quadratics", rationale: "Combining real parts with real parts and imaginary parts with imaginary parts treats a complex number like a two-term expression, making the new numbers feel like familiar algebra." },
  { skillKey: "cx_multiply", label: "Multiply complex numbers and use conjugates", grade: "10", ccCodes: ["N-CN.A.2"], strand: "complex-quadratics", rationale: "Multiplying binomials and replacing i² with −1 closes the complex numbers under multiplication, and a conjugate pair's real product is the tool division needs." },
  { skillKey: "cx_divide", label: "Divide complex numbers by multiplying by the conjugate", grade: "10", ccCodes: ["N-CN.A.3"], strand: "complex-quadratics", rationale: "Clearing i from a denominator with its conjugate mirrors rationalizing a radical denominator and puts every quotient back in a + bi form." },
  { skillKey: "cx_plane_plot", label: "Plot and read complex numbers on the complex plane", grade: "10", ccCodes: ["N-CN.B.4"], strand: "complex-quadratics", rationale: "Placing a + bi at the point (a, b) gives the new numbers a location, turning an abstract extension of the number line into a familiar coordinate picture." },
  { skillKey: "quad_complex_roots", label: "Solve a quadratic equation whose solutions are complex", grade: "10", ccCodes: ["N-CN.C.7", "A-REI.B.4b"], strand: "complex-quadratics", rationale: "A negative discriminant no longer means 'no solution' once i exists, so the quadratic formula now solves every quadratic and returns a conjugate pair." },
  { skillKey: "quad_from_roots", label: "Write a quadratic equation from its roots", grade: "10", ccCodes: ["A-APR.B.3"], strand: "complex-quadratics", rationale: "Building (x − r)(x − s) = 0 from given roots runs the zero-product reasoning backwards and shows that roots determine a quadratic up to a constant factor." },
  { skillKey: "quad_inequality", label: "Solve a quadratic inequality with a graph or a sign chart", grade: "10", ccCodes: ["A-CED.A.1"], strand: "complex-quadratics", rationale: "The roots split the number line into intervals where the quadratic keeps one sign, so the solution set is read from where the parabola sits above or below the axis." },
  { skillKey: "sys_linear_quadratic", label: "Solve a system of a line and a parabola", grade: "10", ccCodes: ["A-REI.C.7"], strand: "complex-quadratics", rationale: "Substituting a line into a parabola produces a quadratic whose zero, one, or two solutions are the places the two graphs cross." },

  // polynomials
  { skillKey: "poly_end_behavior", label: "Predict end behavior from degree and leading coefficient", grade: "10", ccCodes: ["F-IF.C.7c"], strand: "polynomials", rationale: "The highest-degree term dominates for large inputs, so its degree and sign alone decide where a polynomial's graph heads at both ends." },
  { skillKey: "poly_zeros_multiplicity", label: "Find zeros and their multiplicities from factored form", grade: "10", ccCodes: ["A-APR.B.3"], strand: "polynomials", rationale: "Each factor contributes a zero, and how many times it repeats decides whether the graph crosses the axis there or only touches it." },
  { skillKey: "poly_sketch_factored", label: "Sketch a polynomial from its zeros, multiplicities, and end behavior", grade: "10", ccCodes: ["A-APR.B.3", "F-IF.C.7c"], strand: "polynomials", rationale: "Zeros, crossing behavior, and end behavior together pin down a polynomial's overall shape without plotting a table of points." },
  { skillKey: "poly_factor_grouping_cubes", label: "Factor by grouping and factor sums and differences of cubes", grade: "10", ccCodes: ["A-SSE.A.2"], strand: "polynomials", rationale: "Grouping terms to expose a common binomial and recognizing the cube patterns extend factoring beyond quadratics to the cubics that appear when solving higher-degree equations." },
  { skillKey: "poly_factor_quadratic_form", label: "Factor a polynomial in quadratic form", grade: "10", ccCodes: ["A-SSE.A.2"], strand: "polynomials", rationale: "Seeing x⁴ − 5x² + 4 as a quadratic in x² lets every trinomial factoring technique apply to a higher-degree polynomial unchanged." },
  { skillKey: "poly_long_division", label: "Divide polynomials with long division", grade: "11", ccCodes: ["A-APR.D.6"], strand: "polynomials", rationale: "Polynomial long division follows the same divide-multiply-subtract cycle as numeric long division and writes any quotient as a polynomial plus a remainder over the divisor." },
  { skillKey: "poly_synthetic_division", label: "Divide by x − a with synthetic division", grade: "11", ccCodes: ["A-APR.D.6"], strand: "polynomials", rationale: "Synthetic division strips long division by x − a down to its coefficients, making repeated division by candidate factors quick enough to search with." },
  { skillKey: "poly_remainder_theorem", label: "Use the Remainder Theorem to evaluate p(a)", grade: "11", ccCodes: ["A-APR.B.2"], strand: "polynomials", rationale: "The remainder on dividing by x − a equals p(a), linking division to evaluation and turning a zero of the polynomial into a remainder of zero." },
  { skillKey: "poly_factor_theorem", label: "Use a known zero to factor a cubic completely", grade: "11", ccCodes: ["A-APR.B.2"], strand: "polynomials", rationale: "A zero at a means x − a is a factor, so dividing it out leaves a quadratic that ordinary factoring finishes." },
  { skillKey: "poly_solve_higher_degree", label: "Solve a polynomial equation of degree three or four", grade: "11", ccCodes: ["A-APR.B.3", "A-REI.B.4"], strand: "polynomials", rationale: "Factoring a cubic or quartic completely and applying the zero-product property finds every solution, bringing together each factoring tool in the strand." },
  { skillKey: "poly_binomial_expansion", label: "Expand (a + b)ⁿ with Pascal's triangle", grade: "11", ccCodes: ["A-APR.C.5"], strand: "polynomials", rationale: "Pascal's triangle supplies the coefficients of every binomial power, replacing repeated multiplication with a pattern a scholar can extend by addition." },

  // rational
  { skillKey: "rat_excluded_values", label: "Find the values a rational expression cannot take", grade: "11", ccCodes: ["A-APR.D.6"], strand: "rational", rationale: "Division by zero is undefined, so the zeros of a denominator are excluded from a rational expression's domain before any simplifying happens." },
  { skillKey: "rat_simplify", label: "Simplify a rational expression by factoring and cancelling common factors", grade: "11", ccCodes: ["A-APR.D.6"], strand: "rational", rationale: "Cancelling a common factor, never a common term, is the fraction rule of lowest terms applied to polynomials, and the excluded values must survive the cancelling." },
  { skillKey: "rat_multiply_divide", label: "Multiply and divide rational expressions", grade: "11", ccCodes: ["A-APR.D.7"], strand: "rational", rationale: "Multiplying across and dividing by a reciprocal work exactly as they do for numeric fractions, with factoring first so the cancelling is visible." },
  { skillKey: "rat_add_subtract", label: "Add and subtract rational expressions with unlike denominators", grade: "11", ccCodes: ["A-APR.D.7"], strand: "rational", rationale: "Rewriting over a least common denominator built from factored denominators extends unlike-denominator fraction addition to algebraic fractions." },
  { skillKey: "rat_solve_equation", label: "Solve a rational equation and reject extraneous solutions", grade: "11", ccCodes: ["A-REI.A.2"], strand: "rational", rationale: "Clearing denominators turns a rational equation into a polynomial one, but any solution that makes an original denominator zero must be checked and thrown out." },
  { skillKey: "rat_graph_asymptotes", label: "Find the asymptotes and intercepts of a rational function", grade: "11", ccCodes: ["F-IF.C.7d"], strand: "rational", rationale: "The zeros of the simplified denominator give vertical asymptotes, a cancelled factor gives a hole instead, and comparing degrees gives the horizontal asymptote." },
  { skillKey: "rat_inverse_variation", label: "Model inverse variation with y = k/x", grade: "11", ccCodes: ["A-CED.A.2"], strand: "rational", rationale: "When one quantity halves as another doubles their product is constant, and y = k/x is the simplest rational function that models it." },

  // radicals-rational-exponents
  { skillKey: "rexp_convert", label: "Convert between radical form and rational exponents", grade: "10", ccCodes: ["N-RN.A.1"], strand: "radicals-rational-exponents", rationale: "Defining the nth root as the 1/n power is the choice that keeps the exponent rules true, so roots and powers become one notation." },
  { skillKey: "rexp_evaluate", label: "Evaluate numbers with rational exponents", grade: "10", ccCodes: ["N-RN.A.2"], strand: "radicals-rational-exponents", rationale: "Reading 8^(2/3) as the square of the cube root of 8, and a negative exponent as a reciprocal, turns a fractional exponent into two familiar steps." },
  { skillKey: "rexp_simplify", label: "Simplify expressions with rational exponents using the exponent rules", grade: "10", ccCodes: ["N-RN.A.2"], strand: "radicals-rational-exponents", rationale: "The product, quotient, and power rules apply to fractional exponents unchanged, so simplifying them is fraction arithmetic in the exponents." },
  { skillKey: "rad_add_multiply", label: "Add, subtract, and multiply radical terms", grade: "10", ccCodes: ["N-RN.A.2"], strand: "radicals-rational-exponents", rationale: "Like radicals combine the way like terms do, and the product of roots is the root of the product, so radical arithmetic is algebra with a new kind of term." },
  { skillKey: "rad_rationalize", label: "Rationalize a denominator", grade: "10", ccCodes: ["N-RN.A.2"], strand: "radicals-rational-exponents", rationale: "Multiplying by a well-chosen form of one, a root or a conjugate, clears the radical from a denominator and puts an answer in the standard form others can compare." },
  { skillKey: "rad_solve_equation", label: "Solve a radical equation and reject extraneous solutions", grade: "10", ccCodes: ["A-REI.A.2"], strand: "radicals-rational-exponents", rationale: "Raising both sides to a power undoes the radical but can add solutions that do not check, so solving ends with substituting back into the original equation." },

  // exponential-logarithmic
  { skillKey: "exp_solve_common_base", label: "Solve an exponential equation by rewriting both sides with one base", grade: "10", ccCodes: ["A-SSE.B.3c", "F-LE.A.4"], strand: "exponential-logarithmic", rationale: "When both sides are powers of the same base, equal values force equal exponents, the first exponential equation solved without logarithms." },
  { skillKey: "log_definition", label: "Rewrite between exponential form and logarithmic form", grade: "10", ccCodes: ["F-BF.B.5"], strand: "exponential-logarithmic", rationale: "A logarithm names the exponent that produces a given value, so log_b x = y and b^y = x are the same statement written two ways." },
  { skillKey: "log_evaluate", label: "Evaluate a logarithm without a calculator", grade: "10", ccCodes: ["F-BF.B.5"], strand: "exponential-logarithmic", rationale: "Asking 'what power of the base gives this number?' evaluates logarithms of exact powers and builds a sense of their size." },
  { skillKey: "log_graph_inverse", label: "Graph a logarithm as the inverse of an exponential", grade: "10", ccCodes: ["F-IF.C.7e", "F-BF.B.5"], strand: "exponential-logarithmic", rationale: "Reflecting an exponential graph over y = x produces the logarithm's graph, swapping its horizontal asymptote for a vertical one and its domain for its range." },
  { skillKey: "log_rules_expand", label: "Expand a logarithm with the product, quotient, and power rules", grade: "11", ccCodes: ["F-BF.B.5"], strand: "exponential-logarithmic", rationale: "Because logarithms are exponents, the exponent rules become log rules that split a product, quotient, or power into simpler logarithms." },
  { skillKey: "log_rules_condense", label: "Condense a sum of logarithms into a single logarithm", grade: "11", ccCodes: ["F-BF.B.5"], strand: "exponential-logarithmic", rationale: "Running the log rules in reverse collects several logarithms into one, the form a logarithmic equation must reach before it can be rewritten exponentially." },
  { skillKey: "log_change_of_base", label: "Use the change-of-base formula", grade: "11", ccCodes: ["F-LE.A.4"], strand: "exponential-logarithmic", rationale: "Every logarithm is a ratio of logarithms in any common base, which is how a calculator with only log and ln evaluates log base 2." },
  { skillKey: "exp_solve_with_logs", label: "Solve an exponential equation with logarithms", grade: "11", ccCodes: ["F-LE.A.4"], strand: "exponential-logarithmic", rationale: "Taking a logarithm of both sides brings an unknown exponent down as a factor, solving exponential equations whose sides share no common base." },
  { skillKey: "log_solve_equation", label: "Solve a logarithmic equation and check the domain", grade: "11", ccCodes: ["F-LE.A.4", "A-REI.A.2"], strand: "exponential-logarithmic", rationale: "Condensing and rewriting in exponential form solves a log equation, but a logarithm of zero or a negative number is undefined, so each solution must be checked." },
  { skillKey: "exp_natural_base", label: "Use e and the natural logarithm for continuous growth", grade: "11", ccCodes: ["F-LE.A.4"], strand: "exponential-logarithmic", rationale: "Compounding ever more often converges to the base e, so continuous growth is written with e and undone with ln, its matching logarithm." },
  { skillKey: "exp_model_doubling_halflife", label: "Model doubling time and half-life with exponentials and logarithms", grade: "11", ccCodes: ["F-LE.A.4", "F-LE.A.2"], strand: "exponential-logarithmic", rationale: "Asking how long until an amount doubles or halves is an exponential equation whose answer needs a logarithm, the classic payoff of the strand." },

  // sequences-series
  { skillKey: "seq_arithmetic_explicit", label: "Write and use the explicit rule for an arithmetic sequence", grade: "10", ccCodes: ["F-BF.A.2", "F-IF.A.3"], strand: "sequences-series", rationale: "Writing aₙ = a₁ + (n − 1)d turns a constant-difference pattern into a linear function of the term number, so any term can be found directly." },
  { skillKey: "seq_geometric_explicit", label: "Write and use the explicit rule for a geometric sequence", grade: "10", ccCodes: ["F-BF.A.2", "F-LE.A.2"], strand: "sequences-series", rationale: "Writing aₙ = a₁·rⁿ⁻¹ turns a constant-ratio pattern into an exponential function of the term number, the discrete twin of exponential growth." },
  { skillKey: "seq_recursive", label: "Translate between recursive and explicit rules", grade: "10", ccCodes: ["F-BF.A.2"], strand: "sequences-series", rationale: "A recursive rule says how to get the next term and an explicit rule says how to jump to any term, and moving between them shows they describe the same sequence." },
  { skillKey: "series_sigma_notation", label: "Read and evaluate a sum written in sigma notation", grade: "11", ccCodes: ["A-SSE.B.4"], strand: "sequences-series", rationale: "Sigma notation packs a long sum into a rule and a range of indices, and reading it fluently is what makes series formulas usable." },
  { skillKey: "series_arithmetic_sum", label: "Find the sum of a finite arithmetic series", grade: "11", ccCodes: ["A-SSE.B.4"], strand: "sequences-series", rationale: "Pairing the first and last terms, as in the story of adding 1 to 100, gives the number of terms times the average of the ends." },
  { skillKey: "series_geometric_sum", label: "Find the sum of a finite geometric series", grade: "11", ccCodes: ["A-SSE.B.4"], strand: "sequences-series", rationale: "Subtracting r times the sum from the sum cancels every middle term, which is where the finite geometric series formula comes from." },
  { skillKey: "series_infinite_geometric", label: "Decide whether an infinite geometric series converges and find its sum", grade: "11", ccCodes: ["A-SSE.B.4"], strand: "sequences-series", rationale: "When the ratio is between −1 and 1 the terms shrink fast enough that infinitely many add to a finite number, and the finite formula's limit gives it." },
];

export const ALGEBRA_2_EDGES: SeedEdge[] = [
  // functions
  { fromKey: "fn_parent_families", toKey: "fn_transform_translate" },
  { fromKey: "fn_transform_translate", toKey: "fn_transform_scale_reflect" },
  { fromKey: "fn_transform_scale_reflect", toKey: "fn_transform_combined" },
  { fromKey: "fn_domain_range_graph", toKey: "fn_piecewise_evaluate" },
  { fromKey: "fn_compose", toKey: "fn_inverse_find" },
  { fromKey: "fn_inverse_find", toKey: "fn_inverse_graph" },
  { fromKey: "fn_domain_range_graph", toKey: "fn_inverse_graph" },

  // complex-quadratics
  { fromKey: "cx_imaginary_unit", toKey: "cx_add_subtract" },
  { fromKey: "cx_add_subtract", toKey: "cx_multiply" },
  { fromKey: "cx_multiply", toKey: "cx_divide" },
  { fromKey: "cx_imaginary_unit", toKey: "cx_plane_plot" },
  { fromKey: "cx_imaginary_unit", toKey: "quad_complex_roots" },

  // polynomials
  { fromKey: "poly_end_behavior", toKey: "poly_sketch_factored" },
  { fromKey: "poly_zeros_multiplicity", toKey: "poly_sketch_factored" },
  { fromKey: "poly_long_division", toKey: "poly_synthetic_division" },
  { fromKey: "poly_synthetic_division", toKey: "poly_remainder_theorem" },
  { fromKey: "poly_remainder_theorem", toKey: "poly_factor_theorem" },
  { fromKey: "poly_factor_theorem", toKey: "poly_solve_higher_degree" },
  { fromKey: "poly_factor_quadratic_form", toKey: "poly_solve_higher_degree" },
  { fromKey: "poly_zeros_multiplicity", toKey: "poly_solve_higher_degree" },
  // Cubics are solved by grouping or a cube pattern as often as by a known zero.
  { fromKey: "poly_factor_grouping_cubes", toKey: "poly_solve_higher_degree" },
  // Cross-strand (complex-quadratics → polynomials): x² + m = 0 factors leave solutions ±i√m, so "find every solution" needs i.
  { fromKey: "cx_imaginary_unit", toKey: "poly_solve_higher_degree" },

  // rational
  { fromKey: "rat_excluded_values", toKey: "rat_simplify" },
  { fromKey: "rat_simplify", toKey: "rat_multiply_divide" },
  { fromKey: "rat_simplify", toKey: "rat_add_subtract" },
  { fromKey: "rat_add_subtract", toKey: "rat_solve_equation" },
  { fromKey: "rat_simplify", toKey: "rat_graph_asymptotes" },
  { fromKey: "rat_inverse_variation", toKey: "rat_graph_asymptotes" },
  // Cross-strand (functions → rational): inverse variation is the reciprocal parent function y = 1/x stretched by k.
  { fromKey: "fn_parent_families", toKey: "rat_inverse_variation" },

  // radicals-rational-exponents
  { fromKey: "rexp_convert", toKey: "rexp_evaluate" },
  { fromKey: "rexp_evaluate", toKey: "rexp_simplify" },
  { fromKey: "rad_add_multiply", toKey: "rad_rationalize" },
  { fromKey: "rexp_convert", toKey: "rad_solve_equation" },

  // exponential-logarithmic
  { fromKey: "exp_solve_common_base", toKey: "log_definition" },
  { fromKey: "log_definition", toKey: "log_evaluate" },
  { fromKey: "log_definition", toKey: "log_graph_inverse" },
  { fromKey: "log_evaluate", toKey: "log_rules_expand" },
  { fromKey: "log_rules_expand", toKey: "log_rules_condense" },
  { fromKey: "log_rules_expand", toKey: "log_change_of_base" },
  { fromKey: "log_rules_expand", toKey: "exp_solve_with_logs" },
  { fromKey: "log_rules_condense", toKey: "log_solve_equation" },
  { fromKey: "exp_solve_with_logs", toKey: "exp_natural_base" },
  { fromKey: "exp_solve_with_logs", toKey: "exp_model_doubling_halflife" },
  // Cross-strand (functions → exponential-logarithmic): a logarithm's graph is drawn as the reflection of an exponential over y = x.
  { fromKey: "fn_inverse_graph", toKey: "log_graph_inverse" },

  // sequences-series
  { fromKey: "seq_arithmetic_explicit", toKey: "seq_geometric_explicit" },
  { fromKey: "seq_geometric_explicit", toKey: "seq_recursive" },
  { fromKey: "seq_arithmetic_explicit", toKey: "series_sigma_notation" },
  { fromKey: "series_sigma_notation", toKey: "series_arithmetic_sum" },
  { fromKey: "series_sigma_notation", toKey: "series_geometric_sum" },
  { fromKey: "seq_geometric_explicit", toKey: "series_geometric_sum" },
  { fromKey: "series_geometric_sum", toKey: "series_infinite_geometric" },

  // Cross-domain prerequisites (foreign fromKey — declared here, the target side).
  // functions
  // Cross-domain (g9 algebra-1 → g10 algebra-2): reading which inputs and outputs a graph covers presumes reading f(x) as the output at x.
  { fromKey: "fn_notation_evaluate", toKey: "fn_domain_range_graph" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): the average rate of change is [f(b) − f(a)]/(b − a), evaluating function notation twice.
  { fromKey: "fn_notation_evaluate", toKey: "fn_avg_rate_of_change" },
  // Cross-domain (g8 algebra-1 → g10 algebra-2): an average rate of change is the slope between two points on the curve.
  { fromKey: "slope_two_points", toKey: "fn_avg_rate_of_change" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): a parent function is named by its rule f(x), so matching rules to graphs is read in function notation.
  { fromKey: "fn_notation_evaluate", toKey: "fn_parent_families" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): the parabola is a parent shape the scholar must already read before comparing it with the others.
  { fromKey: "quad_graph_features", toKey: "fn_parent_families" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): composing f(g(x)) means evaluating function notation with an expression as the input.
  { fromKey: "fn_notation_evaluate", toKey: "fn_compose" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): finding an inverse is solving y = f(x) for x, the literal-equation rearrangement.
  { fromKey: "lin_eq_literal", toKey: "fn_inverse_find" },
  // complex-quadratics
  // Cross-domain (g9 algebra-1 → g10 algebra-2): √−18 = 3i√2 needs the radical simplified once the i is pulled out.
  { fromKey: "roots_simplify_radicals", toKey: "cx_imaginary_unit" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): (a + bi)(c + di) is a binomial product before i² is replaced with −1.
  { fromKey: "poly_multiply_binomials", toKey: "cx_multiply" },
  // Cross-domain (g6 geometry-measurement → g10 algebra-2): the complex plane is the coordinate plane with the axes renamed real and imaginary.
  { fromKey: "four_quadrant_plane", toKey: "cx_plane_plot" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): complex solutions come out of the quadratic formula when the discriminant is negative.
  { fromKey: "quad_formula", toKey: "quad_complex_roots" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): writing a quadratic from its roots runs solving-by-factoring backwards.
  { fromKey: "quad_solve_factoring", toKey: "quad_from_roots" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): the boundary points of a quadratic inequality are the solutions of the matching equation.
  { fromKey: "quad_solve_factoring", toKey: "quad_inequality" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): the solution set is an 'and' or 'or' of intervals, the compound-inequality form.
  { fromKey: "lin_ineq_compound", toKey: "quad_inequality" },
  // Cross-domain (g8 algebra-1 → g10 algebra-2): a line-parabola system is solved by substituting the line into the parabola.
  { fromKey: "sys_substitution", toKey: "sys_linear_quadratic" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): substitution leaves a quadratic equation that factoring solves.
  { fromKey: "quad_solve_factoring", toKey: "sys_linear_quadratic" },
  // polynomials
  // Cross-domain (g9 algebra-1 → g10 algebra-2): end behavior is read off the degree and leading coefficient that classifying a polynomial names.
  { fromKey: "poly_classify", toKey: "poly_end_behavior" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): a parabola's opening direction is the degree-two case of end behavior.
  { fromKey: "quad_graph_features", toKey: "poly_end_behavior" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): each factor's zero comes from the zero-product property.
  { fromKey: "quad_zero_product", toKey: "poly_zeros_multiplicity" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): the sum and difference of cubes extend the special-form factoring patterns.
  { fromKey: "factor_special_forms", toKey: "poly_factor_grouping_cubes" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): factoring by grouping pulls a common factor out of each group.
  { fromKey: "factor_gcf", toKey: "poly_factor_grouping_cubes" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): a polynomial in quadratic form is factored as an ax² + bx + c trinomial in x².
  { fromKey: "factor_trinomial_general", toKey: "poly_factor_quadratic_form" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): x⁴ − 5x² + 4 = (x² − 1)(x² − 4) is finished by factoring each difference of squares.
  { fromKey: "factor_special_forms", toKey: "poly_factor_quadratic_form" },
  // Cross-domain (g9 algebra-1 → g11 algebra-2): each long-division step multiplies the divisor by a term of the quotient and subtracts.
  { fromKey: "poly_multiply_binomials", toKey: "poly_long_division" },
  // Cross-domain (g9 algebra-1 → g11 algebra-2): dividing out a known factor leaves a quadratic that trinomial factoring finishes.
  { fromKey: "factor_trinomial_simple", toKey: "poly_factor_theorem" },
  // Cross-domain (g9 algebra-1 → g11 algebra-2): the quadratic left after dividing out x − a often has a leading coefficient, like 2x² + 5x − 3.
  { fromKey: "factor_trinomial_general", toKey: "poly_factor_theorem" },
  // Cross-domain (g9 algebra-1 → g11 algebra-2): Pascal's triangle generalizes the (a + b)² pattern to every power.
  { fromKey: "poly_special_products", toKey: "poly_binomial_expansion" },
  // rational
  // Cross-domain (g9 algebra-1 → g11 algebra-2): the excluded values are the solutions of the denominator set to zero, usually a factorable quadratic.
  { fromKey: "quad_solve_factoring", toKey: "rat_excluded_values" },
  // Cross-domain (g8 algebra-1 → g11 algebra-2): solving a rational equation starts by multiplying through by a common denominator.
  { fromKey: "lin_eq_clear_fractions", toKey: "rat_solve_equation" },
  // radicals-rational-exponents
  // Cross-domain (g9 algebra-1 → g10 algebra-2): a rational exponent is read as a root, so converting needs roots in simplest form.
  { fromKey: "roots_simplify_radicals", toKey: "rexp_convert" },
  // Cross-domain (g8 algebra-1 → g10 algebra-2): (x^(1/n))^n = x is the power-of-a-power rule applied to a fractional exponent.
  { fromKey: "exp_power_rule", toKey: "rexp_convert" },
  // Cross-domain (g8 algebra-1 → g10 algebra-2): a negative rational exponent is a reciprocal, exactly as with integer exponents.
  { fromKey: "exp_zero_negative", toKey: "rexp_evaluate" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): combining and multiplying radicals starts from each radical in simplest form.
  { fromKey: "roots_simplify_radicals", toKey: "rad_add_multiply" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): a conjugate clears a binomial denominator through the difference-of-squares product.
  { fromKey: "poly_special_products", toKey: "rad_rationalize" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): squaring both sides of √(x + a) = x + b leaves a quadratic, where extraneous roots appear.
  { fromKey: "quad_solve_factoring", toKey: "rad_solve_equation" },
  // exponential-logarithmic
  // Cross-domain (g9 algebra-1 → g10 algebra-2): rewriting both sides with one base needs a·bˣ read as repeated multiplication.
  { fromKey: "exp_fn_evaluate", toKey: "exp_solve_common_base" },
  // Cross-domain (g9 algebra-1 → g11 algebra-2): condensing log(x) + log(x − 3) leaves a quadratic, which is where the domain check rejects a root.
  { fromKey: "quad_solve_factoring", toKey: "log_solve_equation" },
  // Cross-domain (g9 algebra-1 → g11 algebra-2): doubling and half-life models are exponential growth and decay with the rate read from b.
  { fromKey: "exp_growth_decay", toKey: "exp_model_doubling_halflife" },
  // sequences-series
  // Cross-domain (g9 algebra-1 → g10 algebra-2): aₙ is function notation with the term number as the input.
  { fromKey: "fn_notation_evaluate", toKey: "seq_arithmetic_explicit" },
  // Cross-domain (g6 early-algebra → g10 algebra-2): jumping to a distant term of an arithmetic sequence is the explicit rule before it is written down.
  { fromKey: "pattern_arithmetic_sequence", toKey: "seq_arithmetic_explicit" },
  // Cross-domain (g9 algebra-1 → g10 algebra-2): a geometric sequence's explicit rule is an exponential function a·bⁿ.
  { fromKey: "exp_fn_evaluate", toKey: "seq_geometric_explicit" },
];

/**
 * INFERENCE-ONLY cross-domain edges (kind:"implies") — genuine information
 * dependencies given a home that never gates. `implies` feeds the two blessed
 * inference consumers only (implicit credit + placement diagnostic); it is
 * invisible to the frontier gate and prereq recommendations. Direction matches
 * `buildsOn` (fromKey is the credited prerequisite, toKey the mastered skill) and
 * is stamped with this (to-side, algebra-2) domain by the rebuild, as in
 * `ALGEBRA_1_IMPLIES_EDGES`.
 *
 * Each edge names a lower-grade skill that the Algebra 2 skill structurally
 * subsumes but that is NOT already one of its `buildsOn` ancestors, so placement
 * can credit it without over-gating.
 */
export const ALGEBRA_2_IMPLIES_EDGES: SeedEdge[] = [
  // Solving a quadratic with complex solutions reads a negative discriminant, the third case of classifying solutions.
  { fromKey: "quad_discriminant", toKey: "quad_complex_roots" },
  // Solving a cubic or quartic by factoring ends by solving the quadratic factors that remain.
  { fromKey: "quad_solve_factoring", toKey: "poly_solve_higher_degree" },
  // Adding rational expressions over a common denominator subsumes adding numeric fractions with unlike denominators.
  { fromKey: "add_subtract_unlike", toKey: "rat_add_subtract" },
  // Writing a geometric sequence's explicit rule subsumes finding the next term of a multiplicative pattern.
  { fromKey: "pattern_multiplicative_next", toKey: "seq_geometric_explicit" },
];
