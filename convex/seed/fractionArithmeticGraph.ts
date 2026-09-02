/**
 * Seed data: the fraction-arithmetic prerequisite knowledge graph (Wave D).
 *
 * OUR graph — license-clean, ours to evolve; CCSS codes ride along as tags.
 * Modeled on the whole-number-arithmetic graph (same SeedSkill/SeedEdge shape),
 * loaded by the multi-graph rebuild in convex/knowledgeNodes.ts.
 *
 * DOMAIN SLUG is "fraction-arithmetic" (kebab), NOT "fractions" — deliberately:
 * a bare "Fractions"/"fractions" collides with the concept-atlas "Fractions"
 * cluster under classifyDomain's case-folding (convex/lib/domainTaxonomy.ts),
 * which would reclassify the engine's own domain key. Practice domains stay
 * kebab slugs, parallel to "whole-number-arithmetic".
 *
 * Five strands (the §2 frontier vectors), K–6:
 *   • concept     — what a fraction IS (partition → unit fraction → number line
 *                   → whole-as-fraction → mixed/improper → fraction-as-division)
 *   • equivalence — equivalent fractions, simplifying, common denominators
 *   • comparison  — compare (same denom / same num / benchmarks / unlike) → order
 *   • operations  — add/subtract (like → unlike, mixed) · multiply · divide
 *   • decimals    — decimal notation for base-ten fractions (4.NF.C) → place
 *                   value/rounding → the four decimal operations (5.NBT.B.7,
 *                   6.NS.B.3). Decimals live HERE (not a new domain) because a
 *                   decimal IS a re-notated base-ten fraction — the strand roots
 *                   at `fraction_as_parts`. Added after the pretest audit
 *                   (PRs #881/#888) found several templates (geometry's
 *                   fractional-edge items, the money/percent items) silently
 *                   assuming decimal-operations fluency that NO node measured,
 *                   so a computation slip was unattributable in placement.
 *
 * CROSS-DOMAIN (D4, Stage 3): fraction nodes now declare LIVE grade-FORWARD hard
 * prerequisites into whole-number-arithmetic — `division_as_sharing` (grade 3,
 * partitive division / equal sharing) → `unit_fraction` (grade 3) and →
 * `fraction_as_division` (grade 5). Fractions conceptually require division /
 * equal-sharing (a fraction IS a partition; a/b = a ÷ b), so these edges make the
 * dependency explicit: the mixed "Math Check-In" defers probing fractions until
 * whole-number arithmetic is placed, and the foreign-aware `stateOf` resolves the
 * whole-number prereq against the scholar's real mastery. They are grade-FORWARD
 * (never invert grade), so no grade-4/5 learner is stranded — see the block at
 * the end of FRACTION_ARITHMETIC_EDGES.
 *
 * A SEPARATE pair of cross-domain edges stays GATED OFF (gcf → simplify_fractions,
 * lcm → common_denominators): those are grade-INVERTED (grade-6 number theory
 * gating grade-4/5 fraction skills), which would LOCK those fraction skills for
 * every grade-4/5 learner who hasn't reached grade-6 number theory — stranding
 * exactly the learners this effort means to unstrand. That is a product-judgment
 * hold for Andy (Decision #4); see the fully-explained block there. The combined
 * graph is validated acyclic at seed time (assertCombinedGraphValid in
 * convex/knowledgeNodes.ts).
 */

import type { SeedSkill, SeedEdge } from "./wholeNumberArithmeticGraph";

export const FRACTION_ARITHMETIC_DOMAIN = "fraction-arithmetic";

export const FRACTION_ARITHMETIC_SKILLS: SeedSkill[] = [
  // ── concept ────────────────────────────────────────────────────────────
  { skillKey: "partition_shapes", label: "Partition shapes into equal shares (halves, thirds, fourths)", grade: "1", ccCodes: ["1.G.A.3", "2.G.A.3"], strand: "concept", rationale: "Split a whole into equal parts and name them — the first physical meaning of a fraction, before any symbol." },
  { skillKey: "unit_fraction", label: "Understand a unit fraction 1/b as one of b equal parts", grade: "3", ccCodes: ["3.NF.A.1"], strand: "concept", rationale: "Grasp 1/b as the size of one part when a whole is split into b equal parts — the atom every other fraction is built from." },
  { skillKey: "fraction_as_parts", label: "Understand a/b as a copies of the unit fraction 1/b", grade: "3", ccCodes: ["3.NF.A.1"], strand: "concept", rationale: "See 3/4 as three 1/4-pieces — the count-of-unit-fractions view that makes addition of like fractions obvious." },
  { skillKey: "fraction_number_line", label: "Place and read fractions on a number line", grade: "3", ccCodes: ["3.NF.A.2"], strand: "concept", rationale: "Locate a/b by partitioning the 0–1 interval into b parts — fraction as a NUMBER, not just part of a shape." },
  { skillKey: "whole_as_fraction", label: "Express whole numbers as fractions (e.g. 3 = 3/1, 1 = 4/4)", grade: "3", ccCodes: ["3.NF.A.3c"], strand: "concept", rationale: "Recognize wholes as fractions with denominator 1 (and n/n = 1) — the bridge between whole-number and fraction reasoning." },
  { skillKey: "mixed_improper", label: "Convert between mixed numbers and improper fractions", grade: "4", ccCodes: ["4.NF.B.3b"], strand: "concept", rationale: "Rewrite 7/4 as 1¾ and back — the same quantity in two forms, needed before mixed-number arithmetic." },
  { skillKey: "fraction_as_division", label: "Interpret a fraction as division (a/b = a ÷ b)", grade: "5", ccCodes: ["5.NF.B.3"], strand: "concept", rationale: "See 3/4 as 3 ÷ 4 — the interpretation that unifies fractions with division and unlocks dividing by fractions." },

  // ── equivalence ─────────────────────────────────────────────────────────
  { skillKey: "equivalent_fractions_visual", label: "Recognize simple equivalent fractions with models (1/2 = 2/4)", grade: "3", ccCodes: ["3.NF.A.3a", "3.NF.A.3b"], strand: "equivalence", rationale: "See that different fractions can name the same point/area — the concept before the a/b = n·a/n·b rule." },
  { skillKey: "equivalent_fractions_general", label: "Generate equivalent fractions (a/b = n·a / n·b)", grade: "4", ccCodes: ["4.NF.A.1"], strand: "equivalence", rationale: "Multiply numerator and denominator by the same n — the engine behind common denominators and comparison." },
  { skillKey: "simplify_fractions", label: "Simplify a fraction to lowest terms", grade: "4", ccCodes: ["4.NF.A.1"], strand: "equivalence", rationale: "Divide numerator and denominator by their common factor — cleaner answers, and the reason GCF matters (a WNA leap)." },
  { skillKey: "common_denominators", label: "Find a common denominator for two fractions", grade: "5", ccCodes: ["5.NF.A.1"], strand: "equivalence", rationale: "Rewrite two fractions over a shared denominator (via LCM) — the prerequisite move for adding or comparing unlike fractions." },

  // ── comparison ──────────────────────────────────────────────────────────
  { skillKey: "compare_same_denominator", label: "Compare fractions with the same denominator", grade: "3", ccCodes: ["3.NF.A.3d"], strand: "comparison", rationale: "With equal-size parts, more parts is more — count the numerators." },
  { skillKey: "compare_same_numerator", label: "Compare fractions with the same numerator", grade: "3", ccCodes: ["3.NF.A.3d"], strand: "comparison", rationale: "Same count of parts, but a bigger denominator means smaller parts — the classic counterintuitive fraction fact." },
  { skillKey: "compare_benchmarks", label: "Compare fractions using benchmarks (0, 1/2, 1)", grade: "4", ccCodes: ["4.NF.A.2"], strand: "comparison", rationale: "Judge each fraction against 1/2 or 1 to compare without a common denominator — fraction number sense." },
  { skillKey: "compare_unlike", label: "Compare two fractions with unlike numerators and denominators", grade: "4", ccCodes: ["4.NF.A.2"], strand: "comparison", rationale: "Use equivalence (or a common denominator) to order any two fractions and justify with <, =, >." },
  { skillKey: "order_fractions", label: "Order a set of fractions from least to greatest", grade: "4", ccCodes: ["4.NF.A.2"], strand: "comparison", rationale: "Extend pairwise comparison to a whole set — a fluency check on all the comparison strategies at once." },

  // ── operations ────────────────────────────────────────────────────────────
  { skillKey: "add_subtract_like", label: "Add and subtract fractions with like denominators", grade: "4", ccCodes: ["4.NF.B.3a"], strand: "operations", rationale: "Add the counts of same-size parts (3/8 + 2/8 = 5/8) — the direct payoff of the a-copies-of-1/b view." },
  { skillKey: "decompose_fraction", label: "Decompose a fraction into a sum of fractions", grade: "4", ccCodes: ["4.NF.B.3b"], strand: "operations", rationale: "Write 5/8 = 1/8 + 1/8 + 3/8 in more than one way — flexible part–whole reasoning that supports mixed-number work." },
  { skillKey: "add_subtract_mixed_like", label: "Add and subtract mixed numbers with like denominators", grade: "4", ccCodes: ["4.NF.B.3c"], strand: "operations", rationale: "Combine whole and fractional parts (with regrouping) — the mixed-number analog of like-denominator arithmetic." },
  { skillKey: "add_subtract_unlike", label: "Add and subtract fractions with unlike denominators", grade: "5", ccCodes: ["5.NF.A.1"], strand: "operations", rationale: "Rewrite over a common denominator, then add the counts — the culminating add/subtract skill." },
  { skillKey: "multiply_fraction_by_whole", label: "Multiply a fraction by a whole number", grade: "4", ccCodes: ["4.NF.B.4"], strand: "operations", rationale: "Interpret 3 × 2/5 as 3 copies of 2/5 — multiplication as repeated addition, carried into fractions." },
  { skillKey: "multiply_fractions", label: "Multiply a fraction by a fraction", grade: "5", ccCodes: ["5.NF.B.4"], strand: "operations", rationale: "Take a part of a part (2/3 × 3/4) — multiply numerators and denominators, with an area-model meaning." },
  { skillKey: "fraction_scaling", label: "Interpret fraction multiplication as scaling / resizing", grade: "5", ccCodes: ["5.NF.B.5"], strand: "operations", rationale: "Predict whether a product is bigger or smaller than a factor by the size of the other factor — deep multiplicative reasoning." },
  { skillKey: "divide_unit_fractions", label: "Divide unit fractions by whole numbers and vice versa", grade: "5", ccCodes: ["5.NF.B.7"], strand: "operations", rationale: "Reason about 1/3 ÷ 4 and 4 ÷ 1/3 with models — the conceptual on-ramp to full fraction division." },
  { skillKey: "divide_fractions", label: "Divide a fraction by a fraction", grade: "6", ccCodes: ["6.NS.A.1"], strand: "operations", rationale: "Divide any two fractions (invert-and-multiply, understood via the fraction-as-division view), the capstone of fraction operations." },

  // ── decimals ──────────────────────────────────────────────────────────────
  { skillKey: "decimal_notation_fractions", label: "Write fractions with denominators 10 and 100 as decimals", grade: "4", ccCodes: ["4.NF.C.6"], strand: "decimals", rationale: "Rewrite 7/10 as 0.7 and 43/100 as 0.43 — decimal notation as a re-notation of base-ten fractions, not a new kind of number." },
  { skillKey: "compare_decimals", label: "Compare two decimals to hundredths using <, =, >", grade: "4", ccCodes: ["4.NF.C.7"], strand: "decimals", rationale: "Judge decimal size by place value (0.4 > 0.35), defeating the longer-string-is-bigger misconception." },
  { skillKey: "decimal_place_value_round", label: "Read decimal place value to thousandths and round decimals to any place", grade: "5", ccCodes: ["5.NBT.A.1", "5.NBT.A.3", "5.NBT.A.4"], strand: "decimals", rationale: "Extend the 10×-to-the-left / one-tenth-to-the-right structure below the ones place, and round a decimal at any position." },
  { skillKey: "add_subtract_decimals", label: "Add and subtract decimals to hundredths", grade: "5", ccCodes: ["5.NBT.B.7"], strand: "decimals", rationale: "Line up like place values and carry or borrow exactly as with whole numbers — column arithmetic carried below the decimal point." },
  { skillKey: "multiply_decimals", label: "Multiply decimals to hundredths", grade: "5", ccCodes: ["5.NBT.B.7"], strand: "decimals", rationale: "Multiply as whole numbers, then place the decimal point by counting decimal places — the powers-of-ten reasoning behind the shift." },
  { skillKey: "divide_decimals", label: "Divide decimals to hundredths", grade: "6", ccCodes: ["6.NS.B.3"], strand: "decimals", rationale: "Scale divisor and dividend by the same power of ten until the divisor is whole, then divide — the capstone of decimal operations." },
];

export const FRACTION_ARITHMETIC_EDGES: SeedEdge[] = [
  // concept spine
  { fromKey: "partition_shapes", toKey: "unit_fraction" },
  { fromKey: "unit_fraction", toKey: "fraction_as_parts" },
  { fromKey: "fraction_as_parts", toKey: "fraction_number_line" },
  { fromKey: "fraction_number_line", toKey: "whole_as_fraction" },
  { fromKey: "fraction_as_parts", toKey: "mixed_improper" },
  { fromKey: "fraction_number_line", toKey: "fraction_as_division" },
  { fromKey: "whole_as_fraction", toKey: "fraction_as_division" },

  // equivalence
  { fromKey: "fraction_as_parts", toKey: "equivalent_fractions_visual" },
  { fromKey: "equivalent_fractions_visual", toKey: "equivalent_fractions_general" },
  { fromKey: "equivalent_fractions_general", toKey: "simplify_fractions" },
  { fromKey: "equivalent_fractions_general", toKey: "common_denominators" },

  // comparison
  { fromKey: "fraction_as_parts", toKey: "compare_same_denominator" },
  { fromKey: "unit_fraction", toKey: "compare_same_numerator" },
  { fromKey: "compare_same_denominator", toKey: "compare_benchmarks" },
  { fromKey: "compare_same_numerator", toKey: "compare_benchmarks" },
  { fromKey: "fraction_number_line", toKey: "compare_benchmarks" },
  { fromKey: "compare_benchmarks", toKey: "compare_unlike" },
  { fromKey: "equivalent_fractions_general", toKey: "compare_unlike" },
  { fromKey: "compare_unlike", toKey: "order_fractions" },

  // operations
  { fromKey: "fraction_as_parts", toKey: "add_subtract_like" },
  { fromKey: "add_subtract_like", toKey: "decompose_fraction" },
  { fromKey: "add_subtract_like", toKey: "add_subtract_mixed_like" },
  { fromKey: "mixed_improper", toKey: "add_subtract_mixed_like" },
  { fromKey: "add_subtract_like", toKey: "add_subtract_unlike" },
  { fromKey: "common_denominators", toKey: "add_subtract_unlike" },
  { fromKey: "fraction_as_parts", toKey: "multiply_fraction_by_whole" },
  { fromKey: "multiply_fraction_by_whole", toKey: "multiply_fractions" },
  { fromKey: "equivalent_fractions_general", toKey: "multiply_fractions" },
  { fromKey: "multiply_fractions", toKey: "fraction_scaling" },
  { fromKey: "fraction_as_division", toKey: "divide_unit_fractions" },
  { fromKey: "multiply_fractions", toKey: "divide_unit_fractions" },
  { fromKey: "divide_unit_fractions", toKey: "divide_fractions" },

  // decimals — intra-strand spine: notation → compare/place-value → the four
  // operations in the taught order (add/subtract → multiply → divide).
  { fromKey: "fraction_as_parts", toKey: "decimal_notation_fractions" },
  { fromKey: "decimal_notation_fractions", toKey: "compare_decimals" },
  { fromKey: "decimal_notation_fractions", toKey: "decimal_place_value_round" },
  // 5.NBT.A.3b (compare decimals to thousandths) extends the grade-4 hundredths
  // comparison, so the g5 place-value/rounding node builds on it.
  { fromKey: "compare_decimals", toKey: "decimal_place_value_round" },
  { fromKey: "decimal_place_value_round", toKey: "add_subtract_decimals" },
  { fromKey: "add_subtract_decimals", toKey: "multiply_decimals" },
  { fromKey: "multiply_decimals", toKey: "divide_decimals" },

  // ── Cross-domain HARD prerequisites into whole-number-arithmetic — LIVE ────
  // Fractions conceptually REQUIRE division / equal-sharing: a fraction is the
  // result of partitioning, and a/b literally means a ÷ b. These edges make the
  // dependency explicit so (1) the mixed "Math Check-In" defers probing fractions
  // until whole-number arithmetic is placed (prereq-ordered placement), and
  // (2) the foreign-aware runtime `stateOf` (buildFrontierStateOf) gates the
  // fraction node on the scholar's real whole-number mastery. Declared HERE (the
  // fraction graph) so the rebuild stamps them `domain: "fraction-arithmetic"`
  // (the to-side); `division_as_sharing` is a whole-number node, so intra-domain
  // topo ordering ignores it (endpoints must both be fraction nodes) while the
  // cross-domain frontier resolver honors it.
  //
  // ⚠️ Both edges are deliberately grade-FORWARD (never grade-inverted, unlike
  // the gcf/lcm edges held OFF below): `division_as_sharing` is grade 3, and both
  // targets are grade 3+ — so no grade-4/5 learner is stranded behind grade-6
  // number theory. A young scholar who hasn't reached partitive division simply
  // starts fractions at `partition_shapes` (grade 1, no foreign prereq) and
  // unlocks `unit_fraction` once equal-sharing is proven — pedagogically right.
  { fromKey: "division_as_sharing", toKey: "unit_fraction" },
  { fromKey: "division_as_sharing", toKey: "fraction_as_division" },

  // Cross-domain hard prerequisites for the DECIMALS strand — all grade-forward
  // (every source is a grade-4 WNA node; every target is grade 5–6), and each is
  // "truly required by the item as served" (the #883 blocked-kid bar), not merely
  // typical. NOTE: every source sits at grade ≥ 4, so `division_as_sharing`
  // (grade 3) stays the most-foundational unmet prereq and the fraction domain's
  // gated-entry note keeps naming "division".
  //
  // Decimal place value IS the "a digit is 10× the place to its right" relation
  // extended below the ones (5.NBT.A.1), and rounding a decimal runs the same
  // procedure as rounding a whole number at any place.
  { fromKey: "place_value_relationships", toKey: "decimal_place_value_round" },
  { fromKey: "round_multidigit", toKey: "decimal_place_value_round" },
  // Column add/subtract with regrouping is literally what a decimal sum runs
  // once the points are aligned (3.45 + 2.87 is 345 + 287 column-wise). A
  // scholar who can't carry/borrow multi-digit columns is stuck, not slower.
  { fromKey: "add_multidigit_algorithm", toKey: "add_subtract_decimals" },
  { fromKey: "subtract_multidigit_algorithm", toKey: "add_subtract_decimals" },
  // Decimal multiplication = whole-number multiplication + point placement
  // (0.35 × 6 is 35 × 6, then shift). The items serve up-to-2-digit factors.
  { fromKey: "mult_2digit_by_1digit", toKey: "multiply_decimals" },
  // Decimal division = scale-to-whole + long division; the items serve 1-digit
  // (or 1-digit-after-scaling) divisors, so the 1-digit-divisor node is the
  // honest gate (not the 2-digit-divisor one).
  { fromKey: "long_division_1digit_divisor", toKey: "divide_decimals" },

  // ── Cross-domain hard prerequisites (D4, Stage 3) — IMPLEMENTED, GATED OFF ─
  // The plan calls for restoring the "amber-strip" hard edges Wave D dropped:
  // gcf → simplify_fractions and lcm → common_denominators. The D4 engine now
  // fully supports them — declaring an edge here stamps it `domain:
  // "fraction-arithmetic"` (the to-side), and the foreign-aware `stateOf`
  // (buildFrontierStateOf) resolves gcf/lcm against the scholar's whole-number
  // mastery, so uncommenting the two lines below is all it takes to make them
  // live. The seed-time acyclicity validator and the cross-domain integration
  // tests already cover this case.
  //
  // ⚠️ PRODUCT-JUDGMENT HOLD (QB → Andy, Decision #4): left OFF by default
  // because these edges are GRADE-INVERTED. gcf and lcm are grade-6 WNA nodes;
  // simplify_fractions is grade-4 and common_denominators is grade-5. Making a
  // grade-6 skill a HARD prerequisite for a grade-4/5 fraction skill LOCKS those
  // fraction skills for every grade-4/5 learner who hasn't yet reached grade-6
  // number theory — stranding exactly the learners this effort means to
  // unstrand. The pedagogical relationship is real ("GCF is the engine behind
  // reducing fractions") but it runs helper→skill, not prereq→gate: you can
  // simplify with ANY common factor long before you can find the GREATEST one.
  // If we want the connection live without the lock, prefer a soft/invitation
  // edge or a re-grade of gcf/lcm over a hard prerequisite. Uncomment to enable:
  //
  // { fromKey: "gcf", toKey: "simplify_fractions" },
  // { fromKey: "lcm", toKey: "common_denominators" },
];
