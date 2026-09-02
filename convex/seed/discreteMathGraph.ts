/**
 * Seed data: discrete-math — the raise-the-ceiling enrichment territory above
 * and beside the eight core practice domains.
 *
 * OUR graph — license-clean, ours to evolve; the rare CCSS code rides along as a
 * tag (most discrete-math content has no Common Core home, so `ccCodes` is
 * usually empty). Four strands — counting (combinatorics), graph-theory,
 * number-theory, and logic — span grades 3–9 and give a gifted K–9 scholar real
 * mathematical thinking (parity arguments, pigeonhole, systematic counting,
 * graph reasoning) rather than notation-heavy formalism.
 *
 * This domain ships ELECTIVE: it is never force-probed, only offered as a
 * deliberate pick once its prerequisites converge. It may therefore be
 * adventurous — but every node is still drillable by a deterministic item
 * generator with a single canonical numeric or choice answer, and every
 * graph-theory item is answerable from a TEXT / edge-list / degree-sequence
 * description (no freehand drawing).
 *
 * Cross-domain prerequisites reach into the whole-number-arithmetic
 * number-theory strand (remainders, divisibility, primes, exponents, GCF). They
 * are declared here (the target side, `toKey` = a discrete-math node), so the
 * foreign-aware frontier resolver checks mastery in the source domain. Every
 * such edge is grade-forward (source grade ≤ target grade). In-strand chains
 * keep each node ≤ 1 grade above its nearest graded prerequisite so no node
 * surfaces as "frontier" for a much younger scholar ahead of the difficulty
 * band (the density invariant locked by convex/lib/__tests__/graphGrades.test.ts
 * for the shipped domains).
 *
 * 48 skills · 4 strands. The QB wires this domain into PRACTICE_GRAPHS /
 * domains.ts / labels and authors the T() templates; this file is data only.
 */

import type { SeedEdge, SeedSkill } from "./wholeNumberArithmeticGraph";

export const DISCRETE_MATH_DOMAIN = "discrete-math";

export const DISCRETE_MATH_SKILLS: SeedSkill[] = [
  // ── counting (combinatorics) ───────────────────────────────────────────────
  { skillKey: "count_list_outcomes", label: "List every possible outcome of a small scenario in an organized, non-repeating way", grade: "3", ccCodes: [], strand: "counting", rationale: "Exhaustive organized listing is the concrete root of all counting: a scholar must be able to enumerate a small set before any principle can replace the enumeration." },
  { skillKey: "count_organized_count", label: "Count the outcomes of a two-attribute scenario by listing them systematically", grade: "3", ccCodes: [], strand: "counting", rationale: "Counting the size of an organized list turns enumeration into a number and is the case a scholar later checks the multiplication principle against." },
  { skillKey: "addition_principle", label: "Count a total by adding the sizes of mutually exclusive cases", grade: "4", ccCodes: [], strand: "counting", rationale: "Splitting a count into disjoint cases and adding is one of the two atomic counting moves and is what makes complementary and restricted counting possible." },
  { skillKey: "multiplication_principle", label: "Count the outcomes of a multi-stage choice by multiplying the options at each stage", grade: "4", ccCodes: [], strand: "counting", rationale: "Independent successive choices multiply, the second atomic counting move and the engine behind arrangements, permutations, and combinations." },
  { skillKey: "factorial_arrangements", label: "Count the arrangements of n distinct objects in a row using n!", grade: "5", ccCodes: [], strand: "counting", rationale: "A full ordering is the multiplication principle applied to a shrinking pool of choices, introducing the factorial that every later ordered count is built from." },
  { skillKey: "permutations_r_from_n", label: "Count the ordered arrangements of r objects chosen from n", grade: "6", ccCodes: [], strand: "counting", rationale: "Selecting and ordering only part of a set generalizes the full arrangement and is the ordered count that combinations are later derived from by removing order." },
  { skillKey: "combinations_r_from_n", label: "Count the unordered selections of r objects chosen from n", grade: "7", ccCodes: [], strand: "counting", rationale: "Dividing an ordered count by the arrangements of the chosen set produces the unordered count, the single most useful combinatorial quantity." },
  { skillKey: "permutation_vs_combination", label: "Decide whether a counting problem calls for a permutation or a combination", grade: "7", ccCodes: [], strand: "counting", rationale: "Recognizing whether order matters is the modeling decision that determines which count applies, the judgment that makes the two formulas usable rather than memorized." },
  { skillKey: "count_with_restriction", label: "Count the arrangements of objects subject to a positional restriction", grade: "7", ccCodes: [], strand: "counting", rationale: "Fixing or forbidding a position reduces a clean count to a constrained one, the first counting problem that rewards choosing an order of decisions." },
  { skillKey: "count_complementary", label: "Count the arrangements meeting a condition by subtracting the forbidden ones from the total", grade: "8", ccCodes: [], strand: "counting", rationale: "Counting the complement and subtracting is often far easier than a direct count, the strategic move that turns an intractable restriction into two simple counts." },
  { skillKey: "pigeonhole_basic", label: "Use the pigeonhole principle to find how many items force a repeated category", grade: "5", ccCodes: [], strand: "counting", rationale: "If items outnumber categories some category repeats, a pure existence argument that proves a fact without exhibiting the case, the scholar's first taste of non-constructive reasoning." },
  { skillKey: "pigeonhole_generalized", label: "Use the generalized pigeonhole principle to find the guaranteed minimum in some category", grade: "6", ccCodes: [], strand: "counting", rationale: "Distributing n items into k categories forces some category to hold at least the ceiling of n over k, sharpening the basic principle into a quantitative guarantee." },

  // ── graph-theory ───────────────────────────────────────────────────────────
  { skillKey: "gt_vertices_edges", label: "Identify the vertices and edges of a small graph given as an edge list", grade: "3", ccCodes: [], strand: "graph-theory", rationale: "Reading a graph as a set of dots and connections from a text edge list is the representational root all graph reasoning depends on, and it keeps every item answerable without a drawing." },
  { skillKey: "gt_vertex_degree", label: "Find the degree of a vertex from an edge list", grade: "4", ccCodes: [], strand: "graph-theory", rationale: "Counting the edges at a vertex is the first numerical property of a graph and the quantity the handshake lemma and Euler's rule are both stated in." },
  { skillKey: "gt_degree_sequence", label: "Write the degree sequence of a small graph", grade: "4", ccCodes: [], strand: "graph-theory", rationale: "Collecting every vertex's degree into a list summarizes a graph numerically and is the object that handshake counting and odd-degree arguments operate on." },
  { skillKey: "gt_handshake_sum", label: "Relate the sum of all vertex degrees to twice the number of edges", grade: "5", ccCodes: [], strand: "graph-theory", rationale: "Each edge contributes to exactly two degrees, so the degree sum is always even and equals twice the edge count, the first theorem a scholar can prove by counting one thing two ways." },
  { skillKey: "gt_connected", label: "Decide whether a small graph is connected", grade: "5", ccCodes: [], strand: "graph-theory", rationale: "Whether every vertex is reachable from every other is the structural property that trees, Euler paths, and colorings all presuppose." },
  { skillKey: "gt_path_vs_circuit", label: "Decide whether a described walk is a path or a circuit", grade: "5", ccCodes: [], strand: "graph-theory", rationale: "Distinguishing a walk that returns to its start from one that does not is the vocabulary the Euler-path question is asked in." },
  { skillKey: "gt_euler_path", label: "Decide whether an Euler path exists from the number of odd-degree vertices", grade: "6", ccCodes: [], strand: "graph-theory", rationale: "An Euler path exists exactly when zero or two vertices have odd degree, the classic result that turns a traversal question into a parity count of degrees." },
  { skillKey: "gt_complete_edges", label: "Count the edges of a complete graph on n vertices", grade: "6", ccCodes: [], strand: "graph-theory", rationale: "A complete graph pairs every two vertices, so its edge count is the number of two-element selections, tying graph structure directly to combinations." },
  { skillKey: "gt_tree_definition", label: "Decide whether a small graph is a tree", grade: "6", ccCodes: [], strand: "graph-theory", rationale: "A tree is a connected graph with no circuit, the minimal connected structure that later edge-count and spanning arguments rest on." },
  { skillKey: "gt_tree_edges", label: "Find the number of edges in a tree with n vertices", grade: "6", ccCodes: [], strand: "graph-theory", rationale: "Every tree on n vertices has exactly n − 1 edges, an invariant a scholar can discover by building trees and one that characterizes them among connected graphs." },
  { skillKey: "gt_bipartite", label: "Decide whether a small graph is bipartite (two-colorable)", grade: "6", ccCodes: [], strand: "graph-theory", rationale: "Splitting the vertices into two sides with no edge inside a side is the two-color case of coloring and the structural precondition for it." },
  { skillKey: "gt_coloring", label: "Find the least number of colors needed to color a small graph's vertices", grade: "7", ccCodes: [], strand: "graph-theory", rationale: "The chromatic number is the sharpest single measure of how constrained a graph is, generalizing the bipartite (two-color) case to any number of colors." },

  // ── number-theory ──────────────────────────────────────────────────────────
  { skillKey: "nt_parity_classify", label: "Classify a whole number, sum, or product as even or odd", grade: "5", ccCodes: [], strand: "number-theory", rationale: "Even and odd is divisibility by two made into a two-value invariant, the simplest modular structure and the basis of every parity argument." },
  { skillKey: "nt_parity_argument", label: "Determine the parity of a sum or product from the parities of its parts", grade: "6", ccCodes: [], strand: "number-theory", rationale: "Even and odd combine by fixed rules independent of the actual numbers, letting a scholar reason about a result's parity without computing it." },
  { skillKey: "nt_parity_proof", label: "Decide whether a parity argument rules out a proposed whole-number equation", grade: "7", ccCodes: [], strand: "number-theory", rationale: "A mismatch in parity between two sides proves no solution exists, the scholar's first impossibility proof and the essence of an invariant argument." },
  { skillKey: "nt_modular_clock", label: "Reduce a whole number to its remainder on a clock of size n (mod n)", grade: "6", ccCodes: [], strand: "number-theory", rationale: "Wrapping the number line around a fixed modulus is the concrete meaning of remainders and the setting all later modular reasoning happens in." },
  { skillKey: "nt_mod_cycle", label: "Find the remainder of a large number modulo n by using the repeating cycle", grade: "7", ccCodes: [], strand: "number-theory", rationale: "Remainders of successive values repeat with a fixed period, so a large case reduces to its position in the cycle, the trick behind day-of-week and last-digit puzzles." },
  { skillKey: "nt_modular_arithmetic", label: "Add and multiply whole numbers modulo n", grade: "7", ccCodes: [], strand: "number-theory", rationale: "Arithmetic still works after reducing mod n, giving a small closed number system that makes divisibility and congruence questions computable." },
  { skillKey: "nt_last_digit", label: "Find the last digit of a power by using its units-digit cycle", grade: "6", ccCodes: [], strand: "number-theory", rationale: "The units digit of successive powers cycles with a short period, a striking pattern that is arithmetic mod 10 in disguise and is fully drillable." },
  { skillKey: "nt_divisibility_proof", label: "Justify a divisibility rule (3, 9, or 11) using digit sums", grade: "7", ccCodes: [], strand: "number-theory", rationale: "The digit-sum rules are consequences of each power of ten being congruent to one (or minus one) mod 3, 9, or 11, turning a memorized trick into a proof." },
  { skillKey: "nt_prime_test_deeper", label: "Decide whether a number up to 200 is prime by trial division to its square root", grade: "6", ccCodes: [], strand: "number-theory", rationale: "Testing divisors only up to the square root is the first efficiency argument about primes and extends prime recognition well past the times-table range." },
  { skillKey: "nt_twin_primes", label: "Identify the twin-prime pairs within a given range", grade: "7", ccCodes: [], strand: "number-theory", rationale: "Twin primes make an open frontier of mathematics concrete and drillable: finding the pairs in a range is a definite counting task even though their infinitude is unknown." },
  { skillKey: "nt_prime_gaps", label: "Find the gap between consecutive primes in a range", grade: "7", ccCodes: [], strand: "number-theory", rationale: "Measuring the spacing between primes exposes their irregular distribution and frames a research-level idea as a single-answer computation." },
  { skillKey: "nt_gcd_euclid", label: "Compute a GCD using the Euclidean algorithm", grade: "8", ccCodes: ["6.NS.B.4"], strand: "number-theory", rationale: "Replacing a pair by the smaller number and the remainder repeatedly finds the GCD without factoring, the oldest nontrivial algorithm and the gateway to congruence solving." },
  { skillKey: "nt_linear_congruence", label: "Find the whole number x below n satisfying a·x ≡ b (mod n) by testing residues", grade: "9", ccCodes: [], strand: "number-theory", rationale: "Solving a congruence is the modular analogue of solving a linear equation, and its solvability is governed by the GCD the scholar just learned to compute." },

  // ── logic ──────────────────────────────────────────────────────────────────
  { skillKey: "lg_truth_value", label: "Decide whether a simple statement is true or false", grade: "3", ccCodes: [], strand: "logic", rationale: "Assigning a truth value to a plain statement is the atom every logical connective and deduction operates on." },
  { skillKey: "lg_and", label: "Determine the truth of an AND (conjunction) of two statements", grade: "4", ccCodes: [], strand: "logic", rationale: "Conjunction is true only when both parts are, one of the three connectives from which all compound statements are built." },
  { skillKey: "lg_or", label: "Determine the truth of an OR (disjunction) of two statements", grade: "4", ccCodes: [], strand: "logic", rationale: "Inclusive disjunction is true when at least one part is, the connective scholars most often confuse with everyday exclusive 'or'." },
  { skillKey: "lg_not", label: "Determine the truth of the negation of a statement", grade: "4", ccCodes: [], strand: "logic", rationale: "Negation flips a truth value, the unary operation that makes counterexamples and contradiction arguments expressible." },
  { skillKey: "lg_compound_truth", label: "Determine the truth of a compound statement built with and, or, and not", grade: "5", ccCodes: [], strand: "logic", rationale: "Evaluating a nested combination of connectives is where the three atomic operations become a small algebra of truth values." },
  { skillKey: "lg_negate", label: "Write the negation of a simple or quantified statement", grade: "5", ccCodes: [], strand: "logic", rationale: "Correctly negating a statement, including flipping 'all' to 'some are not', is the precision skill that disproof and contrapositive reasoning require." },
  { skillKey: "lg_if_then", label: "Determine the truth of an if-then (conditional) statement", grade: "6", ccCodes: [], strand: "logic", rationale: "A conditional fails only when its hypothesis holds but its conclusion does not, the connective that carries mathematical implication and the vacuous-truth surprise." },
  { skillKey: "lg_converse", label: "Write the converse of a conditional statement and judge its truth separately", grade: "6", ccCodes: [], strand: "logic", rationale: "Swapping hypothesis and conclusion produces a statement whose truth is independent of the original, the distinction that guards against a common reasoning error." },
  { skillKey: "lg_counterexample", label: "Find a counterexample that disproves a universal claim", grade: "6", ccCodes: [], strand: "logic", rationale: "A single instance where a universal claim fails settles it as false, the most economical form of disproof and the payoff of correct negation." },
  { skillKey: "lg_knights_knaves", label: "Deduce who tells the truth and who lies from a set of statements", grade: "7", ccCodes: [], strand: "logic", rationale: "Testing each truth-teller/liar assignment for consistency is deduction under constraints, the puzzle form that makes case-checking a joy rather than a chore." },
  { skillKey: "lg_deduce_clues", label: "Deduce the unique conclusion forced by a small set of logical clues", grade: "7", ccCodes: [], strand: "logic", rationale: "Combining several constraints to pin down the one possibility left standing is the deductive core of proof, practiced here on a finite, checkable domain." },
];

export const DISCRETE_MATH_EDGES: SeedEdge[] = [
  // counting
  { fromKey: "count_list_outcomes", toKey: "count_organized_count" },
  { fromKey: "count_organized_count", toKey: "addition_principle" },
  { fromKey: "count_organized_count", toKey: "multiplication_principle" },
  { fromKey: "multiplication_principle", toKey: "factorial_arrangements" },
  { fromKey: "factorial_arrangements", toKey: "permutations_r_from_n" },
  { fromKey: "permutations_r_from_n", toKey: "combinations_r_from_n" },
  { fromKey: "combinations_r_from_n", toKey: "permutation_vs_combination" },
  { fromKey: "permutations_r_from_n", toKey: "count_with_restriction" },
  { fromKey: "count_with_restriction", toKey: "count_complementary" },
  { fromKey: "combinations_r_from_n", toKey: "count_complementary" },
  { fromKey: "multiplication_principle", toKey: "pigeonhole_basic" },
  { fromKey: "pigeonhole_basic", toKey: "pigeonhole_generalized" },
  // Cross-strand (grade-forward g6 → g7): the complete graph's concrete
  // pairs-count is the worked instance that motivates the general two-element
  // combination count. (The reverse direction — gating the g6 graph node behind
  // the g7 formula — was a backward-grade jump; caught in QB review.)
  { fromKey: "gt_complete_edges", toKey: "combinations_r_from_n" },

  // graph-theory
  { fromKey: "gt_vertices_edges", toKey: "gt_vertex_degree" },
  { fromKey: "gt_vertex_degree", toKey: "gt_degree_sequence" },
  { fromKey: "gt_degree_sequence", toKey: "gt_handshake_sum" },
  { fromKey: "gt_vertex_degree", toKey: "gt_connected" },
  { fromKey: "gt_connected", toKey: "gt_path_vs_circuit" },
  { fromKey: "gt_handshake_sum", toKey: "gt_euler_path" },
  { fromKey: "gt_path_vs_circuit", toKey: "gt_euler_path" },
  { fromKey: "gt_handshake_sum", toKey: "gt_complete_edges" },
  { fromKey: "gt_connected", toKey: "gt_tree_definition" },
  { fromKey: "gt_tree_definition", toKey: "gt_tree_edges" },
  { fromKey: "gt_connected", toKey: "gt_bipartite" },
  { fromKey: "gt_bipartite", toKey: "gt_coloring" },

  // number-theory (in-strand)
  { fromKey: "nt_parity_classify", toKey: "nt_parity_argument" },
  { fromKey: "nt_parity_argument", toKey: "nt_parity_proof" },
  { fromKey: "nt_modular_clock", toKey: "nt_mod_cycle" },
  { fromKey: "nt_modular_clock", toKey: "nt_modular_arithmetic" },
  { fromKey: "nt_modular_clock", toKey: "nt_last_digit" },
  { fromKey: "nt_modular_arithmetic", toKey: "nt_divisibility_proof" },
  { fromKey: "nt_prime_test_deeper", toKey: "nt_twin_primes" },
  { fromKey: "nt_prime_test_deeper", toKey: "nt_prime_gaps" },
  { fromKey: "nt_mod_cycle", toKey: "nt_gcd_euclid" },
  { fromKey: "nt_gcd_euclid", toKey: "nt_linear_congruence" },
  { fromKey: "nt_modular_arithmetic", toKey: "nt_linear_congruence" },

  // logic
  { fromKey: "lg_truth_value", toKey: "lg_and" },
  { fromKey: "lg_truth_value", toKey: "lg_or" },
  { fromKey: "lg_truth_value", toKey: "lg_not" },
  { fromKey: "lg_and", toKey: "lg_compound_truth" },
  { fromKey: "lg_or", toKey: "lg_compound_truth" },
  { fromKey: "lg_not", toKey: "lg_compound_truth" },
  { fromKey: "lg_not", toKey: "lg_negate" },
  { fromKey: "lg_compound_truth", toKey: "lg_if_then" },
  { fromKey: "lg_if_then", toKey: "lg_converse" },
  { fromKey: "lg_negate", toKey: "lg_counterexample" },
  { fromKey: "lg_if_then", toKey: "lg_knights_knaves" },
  { fromKey: "lg_knights_knaves", toKey: "lg_deduce_clues" },

  // ── Cross-domain prerequisites (foreign fromKey — declared here, target side).
  // Cross-domain (g4 whole-number-arithmetic → g4 discrete-math): counting a multi-stage choice is multiplication read as equal groups of options.
  { fromKey: "equal_groups_concept", toKey: "multiplication_principle" },
  // Cross-domain (g4 whole-number-arithmetic → g5 discrete-math): even/odd is divisibility by two, the parity divisibility rules already decide.
  { fromKey: "divisibility_rules_2_5_10", toKey: "nt_parity_classify" },
  // Cross-domain (g6 whole-number-arithmetic → g6 discrete-math): modular reduction is exactly the wrap-around remainders of the clock/calendar cycles.
  { fromKey: "remainder_cycles", toKey: "nt_modular_clock" },
  // Cross-domain (g6 whole-number-arithmetic → g6 discrete-math): the units-digit cycle of a power is the repeated-multiplication meaning of an exponent, read mod 10.
  { fromKey: "exponents_repeated_mult", toKey: "nt_last_digit" },
  // Cross-domain (g4 whole-number-arithmetic → g6 discrete-math): deeper primality extends the prime/composite classification past the times-table range.
  { fromKey: "prime_or_composite", toKey: "nt_prime_test_deeper" },
  // Cross-domain (g6 whole-number-arithmetic → g6 discrete-math): trial division only to the square root uses square numbers as the cutoff.
  { fromKey: "square_cube_numbers", toKey: "nt_prime_test_deeper" },
  // Cross-domain (g4 whole-number-arithmetic → g7 discrete-math): the 3/9/11 divisibility PROOF explains the digit-sum rule the scholar already applies mechanically.
  { fromKey: "divisibility_rules_3_9", toKey: "nt_divisibility_proof" },
  // Cross-domain (g6 whole-number-arithmetic → g8 discrete-math): the Euclidean algorithm is the fast route to the greatest common factor first met by listing.
  { fromKey: "gcf", toKey: "nt_gcd_euclid" },
];

/**
 * INFERENCE-ONLY cross-domain edges (kind:"implies"). None are warranted yet:
 * discrete-math is elective and structurally sits above the core domains, so no
 * discrete-math skill silently subsumes a lower-grade core skill in a way that
 * should mint placement credit without gating. Kept as an empty export to mirror
 * the other domain graphs' shape.
 */
export const DISCRETE_MATH_IMPLIES_EDGES: SeedEdge[] = [];
