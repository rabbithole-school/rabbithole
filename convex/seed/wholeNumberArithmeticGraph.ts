/**
 * Seed data: the whole-number-arithmetic prerequisite knowledge graph.
 *
 * LLM-generated (Sonnet) and validated as a DAG, finer than CCSS
 * (review/practice/spikes.html §B), then topologically ordered here.
 * This is OUR graph — license-clean, ours to evolve. CCSS codes ride along as
 * tags. Loaded by convex/practiceSkills.ts:seedGraph.
 *
 * 87 skills · 149 buildsOn edges · validated acyclic.
 * (67→75, 108→119 in Wave A: the number-theory strand built out — raise-the-ceiling §2.)
 * (75→87, 119→143 in PR4: 4th-grade-edge densification — multiplicative place
 *  value, expanded↔standard form, factors/multiples, prime/composite, multi-step
 *  expressions + the cross-strand prereqs those imply. See review/placement-v2/.)
 * (143→149 in graph-density check-in #1: surgical densification — added the
 *  missing one-grade-below prerequisite to the six nodes whose grade jumped >1
 *  over their nearest graded prereq, so a high-grade node no longer surfaces as
 *  "frontier" for a much younger scholar ahead of the difficulty band. Every
 *  whole-number node now sits ≤1 grade above a graded prerequisite — locked
 *  against drift by convex/lib/__tests__/graphGrades.test.ts. See
 *  review/practice/algo-audit-2026-07.md.)
 */

export const WHOLE_NUMBER_ARITHMETIC_DOMAIN = "whole-number-arithmetic";

export type SeedSkill = {
  skillKey: string;
  label: string;
  grade: string;
  ccCodes: string[];
  // Sub-thread within the domain (§2 frontier vector) — one skill, one PRIMARY
  // strand; cross-strand prerequisites stay as buildsOn edges, never dual
  // membership. One of the five whole-number-arithmetic keys: counting ·
  // place-value · add-subtract · mult-divide · number-theory.
  strand: string;
  rationale?: string;
};

export type SeedEdge = { fromKey: string; toKey: string };

export const WHOLE_NUMBER_ARITHMETIC_SKILLS: SeedSkill[] = [
  { skillKey: "count_to_10", label: "Count to 10 by ones", grade: "K", ccCodes: ["K.CC.A.1"], strand: "counting", rationale: "Recite and recognize the count sequence 1–10, the bedrock of all number work." },
  { skillKey: "cardinality_within_10", label: "Understand cardinality: last number counted tells how many", grade: "K", ccCodes: ["K.CC.B.4"], strand: "counting", rationale: "Grasp that the final tag in a count represents the total quantity of a set." },
  { skillKey: "count_to_100_tens", label: "Count to 100 by tens", grade: "K", ccCodes: ["K.CC.A.1"], strand: "counting", rationale: "Count 10, 20, 30 … 100, anchoring the tens structure of the base-ten system." },
  { skillKey: "count_to_20", label: "Count to 20 by ones", grade: "K", ccCodes: ["K.CC.A.1"], strand: "counting", rationale: "Extend the verbal count sequence through 20, enabling work with teen numbers." },
  { skillKey: "count_objects_within_10", label: "Count objects to tell how many (within 10)", grade: "K", ccCodes: ["K.CC.B.5"], strand: "counting", rationale: "Apply one-to-one correspondence to count a physical set of up to 10 objects accurately." },
  { skillKey: "count_on", label: "Count forward from any number within 20", grade: "K", ccCodes: ["K.CC.A.2"], strand: "counting", rationale: "Start counting from a number other than 1, an efficient cognitive strategy for early addition." },
  { skillKey: "count_to_100_ones", label: "Count to 100 by ones", grade: "K", ccCodes: ["K.CC.A.1"], strand: "counting", rationale: "Recite the full 1–100 sequence by ones, establishing the complete base-ten number line." },
  { skillKey: "write_numerals_to_20", label: "Write numerals 0–20", grade: "K", ccCodes: ["K.CC.A.3"], strand: "counting", rationale: "Form the symbols 0–20 to connect spoken count words to written notation." },
  { skillKey: "add_within_5", label: "Add within 5 (fluency)", grade: "K", ccCodes: ["K.OA.A.5"], strand: "add-subtract", rationale: "Instantly recall all addition combinations with sums up to 5." },
  { skillKey: "compare_within_10", label: "Compare two groups or numbers within 10 (greater, less, equal)", grade: "K", ccCodes: ["K.CC.C.6", "K.CC.C.7"], strand: "counting", rationale: "Identify which of two quantities is greater, less, or equal using counting or matching." },
  { skillKey: "count_objects_within_20", label: "Count objects to tell how many (within 20)", grade: "K", ccCodes: ["K.CC.B.5"], strand: "counting", rationale: "Count sets up to 20 objects accurately, bridging cardinality to teen-number structure." },
  { skillKey: "subtract_within_5", label: "Subtract within 5 (fluency)", grade: "K", ccCodes: ["K.OA.A.5"], strand: "add-subtract", rationale: "Instantly recall all subtraction combinations within 5." },
  { skillKey: "skip_count_2s_5s_10s", label: "Skip-count by 2s, 5s, and 10s", grade: "2", ccCodes: ["2.NBT.A.2"], strand: "mult-divide", rationale: "Recite multiples of 2, 5, and 10 — the conceptual bridge to multiplication facts." },
  { skillKey: "add_within_10", label: "Add within 10 (fluency)", grade: "K", ccCodes: ["K.OA.A.2", "K.OA.A.3"], strand: "add-subtract", rationale: "Solve all addition facts with sums up to 10 with speed and accuracy." },
  { skillKey: "compose_ten", label: "Compose and decompose 11–19 as ten ones plus some ones", grade: "K", ccCodes: ["K.NBT.A.1"], strand: "place-value", rationale: "See teen numbers as 10 + n, the conceptual root of all base-ten place value." },
  { skillKey: "subtract_within_10", label: "Subtract within 10 (fluency)", grade: "K", ccCodes: ["K.OA.A.2"], strand: "add-subtract", rationale: "Solve all subtraction facts within 10 fluently, using the inverse relationship to addition." },
  { skillKey: "skip_count_3s_4s", label: "Skip-count by 3s and 4s", grade: "3", ccCodes: ["3.OA.D.9"], strand: "mult-divide", rationale: "Generate multiples of 3 and 4 to scaffold memorization of those fact families." },
  { skillKey: "add_subtract_properties", label: "Commutative, associative, and identity properties of addition", grade: "1", ccCodes: ["1.OA.B.3"], strand: "add-subtract", rationale: "Apply a+b=b+a, (a+b)+c=a+(b+c), and a+0=a to build flexible computation strategies." },
  { skillKey: "make_ten_strategy", label: "Make-ten strategy for addition", grade: "1", ccCodes: ["1.OA.C.6"], strand: "add-subtract", rationale: "Decompose an addend to form a group of 10, then add the remainder (e.g., 8 + 5 → 10 + 3)." },
  { skillKey: "tens_ones_to_99", label: "Understand tens and ones in two-digit numbers (11–99)", grade: "1", ccCodes: ["1.NBT.B.2"], strand: "place-value", rationale: "Interpret any two-digit number as bundles of tens plus leftover ones." },
  { skillKey: "add_subtract_word_problems_within_10", label: "Solve add/subtract word problems within 10", grade: "K", ccCodes: ["K.OA.A.2"], strand: "add-subtract", rationale: "Represent and solve joining, separating, and comparing situations with numbers up to 10." },
  { skillKey: "skip_count_6s_7s_8s_9s", label: "Skip-count by 6s, 7s, 8s, and 9s", grade: "3", ccCodes: ["3.OA.D.9"], strand: "mult-divide", rationale: "Generate multiples of 6–9 to scaffold recall of the hardest single-digit multiplication facts." },
  { skillKey: "add_within_20_no_regroup", label: "Add within 20 without regrouping", grade: "1", ccCodes: ["1.OA.C.6"], strand: "add-subtract", rationale: "Add two numbers through 20 where no carrying is needed across the tens boundary." },
  { skillKey: "compare_2digit", label: "Compare two two-digit numbers using <, =, >", grade: "1", ccCodes: ["1.NBT.B.3"], strand: "place-value", rationale: "Use place-value understanding to determine the relative size of two two-digit numbers." },
  { skillKey: "hundreds_tens_ones", label: "Understand hundreds, tens, and ones in three-digit numbers", grade: "2", ccCodes: ["2.NBT.A.1"], strand: "place-value", rationale: "Extend place value to a third position, reading and writing numbers up to 999." },
  { skillKey: "ten_more_ten_less", label: "Mentally add and subtract 10 from a two-digit number", grade: "1", ccCodes: ["1.NBT.C.5"], strand: "place-value", rationale: "Change only the tens digit when ±10, reinforcing place-value fluency before algorithms." },
  { skillKey: "add_within_20_regroup", label: "Add within 20 with regrouping (carrying)", grade: "1", ccCodes: ["1.OA.C.6"], strand: "add-subtract", rationale: "Add two numbers where the ones sum exceeds 9, requiring a carry into the tens place." },
  { skillKey: "subtract_within_20", label: "Subtract within 20", grade: "1", ccCodes: ["1.OA.C.6"], strand: "add-subtract", rationale: "Compute all differences within 20, including those requiring decomposition of a ten." },
  { skillKey: "compare_3digit", label: "Compare three-digit numbers using <, =, >", grade: "2", ccCodes: ["2.NBT.A.4"], strand: "place-value", rationale: "Apply place-value reasoning to compare numbers up to 999 by inspecting each digit position." },
  { skillKey: "expanded_form_3digit", label: "Write three-digit numbers in expanded form", grade: "2", ccCodes: ["2.NBT.A.3"], strand: "place-value", rationale: "Express 347 as 300 + 40 + 7, making each digit's contribution to value explicit." },
  { skillKey: "place_value_to_1000", label: "Understand place value through 1,000", grade: "2", ccCodes: ["2.NBT.A.1", "2.NBT.A.3"], strand: "place-value", rationale: "Read, write, and represent whole numbers to 1,000 using base-ten notation." },
  { skillKey: "round_to_nearest_10_100", label: "Round three-digit numbers to the nearest 10 or 100", grade: "3", ccCodes: ["3.NBT.A.1"], strand: "place-value", rationale: "Approximate three-digit numbers to the nearest ten or hundred for estimation of sums and differences." },
  { skillKey: "add_subtract_fluency_within_20", label: "Fluency: add and subtract within 20 from memory", grade: "2", ccCodes: ["2.OA.B.2"], strand: "add-subtract", rationale: "Know all addition and subtraction facts within 20 by instant recall, freeing working memory for multi-digit work." },
  { skillKey: "place_value_multidigit", label: "Understand place value in multi-digit whole numbers (to 1,000,000)", grade: "4", ccCodes: ["4.NBT.A.1", "4.NBT.A.2"], strand: "place-value", rationale: "Recognize that each position is 10× the one to its right, extending place value to millions." },
  { skillKey: "add_2digit_no_regroup", label: "Add two 2-digit numbers without regrouping", grade: "1", ccCodes: ["1.NBT.C.4"], strand: "add-subtract", rationale: "Add two-digit numbers where ones digits sum to 9 or less, using place-value structure column by column." },
  { skillKey: "equal_groups_concept", label: "Understand multiplication as equal groups (repeated addition)", grade: "3", ccCodes: ["3.OA.A.1"], strand: "mult-divide", rationale: "Interpret a × b as a groups of b, connecting multiplication directly to additive reasoning." },
  { skillKey: "subtract_2digit_no_regroup", label: "Subtract two 2-digit numbers without regrouping", grade: "1", ccCodes: ["1.NBT.C.4"], strand: "add-subtract", rationale: "Subtract within 100 when each subtrahend digit is ≤ the corresponding minuend digit." },
  { skillKey: "expanded_form_multidigit", label: "Read, write, and express multi-digit numbers in expanded form", grade: "4", ccCodes: ["4.NBT.A.2"], strand: "place-value", rationale: "Represent numbers beyond 1,000 in expanded notation to support multi-digit computation and rounding." },
  { skillKey: "round_multidigit", label: "Round multi-digit numbers to any place", grade: "4", ccCodes: ["4.NBT.A.3"], strand: "place-value", rationale: "Apply rounding rules at any digit position to produce useful estimates and reasonableness checks." },
  { skillKey: "add_2digit_regroup", label: "Add two 2-digit numbers with regrouping", grade: "2", ccCodes: ["2.NBT.B.5"], strand: "add-subtract", rationale: "Carry a new ten when the ones digits sum to 10 or more — the core of the addition algorithm." },
  { skillKey: "arrays_concept", label: "Understand multiplication using arrays and rows-and-columns", grade: "3", ccCodes: ["2.OA.C.4", "3.OA.A.1"], strand: "mult-divide", rationale: "Arrange objects in rectangular arrays to visualize products and build toward the area model." },
  { skillKey: "division_as_grouping", label: "Understand division as repeated subtraction and grouping (quotitive division)", grade: "3", ccCodes: ["3.OA.A.2"], strand: "mult-divide", rationale: "Interpret a÷b as asking how many groups of b fit into a." },
  { skillKey: "division_as_sharing", label: "Understand division as equal sharing (partitive division)", grade: "3", ccCodes: ["3.OA.A.2"], strand: "mult-divide", rationale: "Interpret a÷b as splitting a objects equally into b groups to find how many per group." },
  { skillKey: "mult_facts_0_1_2_5_10", label: "Multiplication facts: ×0, ×1, ×2, ×5, ×10 (fluency)", grade: "3", ccCodes: ["3.OA.C.7"], strand: "mult-divide", rationale: "Know the easiest fact families (zeros, ones, doubles, fives, tens) by instant recall." },
  { skillKey: "subtract_2digit_regroup", label: "Subtract two 2-digit numbers with regrouping (borrowing)", grade: "2", ccCodes: ["2.NBT.B.5"], strand: "add-subtract", rationale: "Decompose a ten when the ones digit of the minuend is too small — the core of the subtraction algorithm." },
  { skillKey: "add_3digit_no_regroup", label: "Add 3-digit numbers without regrouping", grade: "2", ccCodes: ["2.NBT.B.7"], strand: "add-subtract", rationale: "Apply place-value addition column by column to three-digit numbers with no carrying." },
  { skillKey: "division_facts_0_5", label: "Division facts through ÷5 (fluency)", grade: "3", ccCodes: ["3.OA.C.7"], strand: "mult-divide", rationale: "Recall quotients for dividends within 25, treating division as an unknown-factor problem." },
  { skillKey: "mult_commutative_associative", label: "Commutative and associative properties of multiplication", grade: "3", ccCodes: ["3.OA.B.5"], strand: "mult-divide", rationale: "Apply a×b=b×a and (a×b)×c=a×(b×c) to rearrange factors and reduce memorization load." },
  { skillKey: "mult_facts_3_4_6", label: "Multiplication facts: ×3, ×4, ×6 (fluency)", grade: "3", ccCodes: ["3.OA.C.7"], strand: "mult-divide", rationale: "Master the medium-difficulty fact families to complete fluency through all facts up to 6×9." },
  { skillKey: "subtract_3digit_regroup", label: "Subtract 3-digit numbers with regrouping", grade: "2", ccCodes: ["2.NBT.B.7"], strand: "add-subtract", rationale: "Borrow across ones and tens columns in three-digit subtraction." },
  { skillKey: "add_3digit_regroup", label: "Add 3-digit numbers with regrouping", grade: "2", ccCodes: ["2.NBT.B.7"], strand: "add-subtract", rationale: "Carry across ones, tens, and hundreds columns when column sums exceed 9." },
  { skillKey: "mult_distributive", label: "Distributive property of multiplication over addition", grade: "3", ccCodes: ["3.OA.B.5"], strand: "mult-divide", rationale: "Use a×(b+c)=a×b+a×c to decompose hard facts into known ones and to underpin multi-digit algorithms." },
  { skillKey: "mult_facts_7_8_9", label: "Multiplication facts: ×7, ×8, ×9 (fluency)", grade: "3", ccCodes: ["3.OA.C.7"], strand: "mult-divide", rationale: "Achieve instant recall of the hardest single-digit fact families, completing times-table fluency." },
  { skillKey: "subtract_multidigit_algorithm", label: "Multi-digit subtraction standard algorithm (up to 1,000,000)", grade: "4", ccCodes: ["4.NBT.B.4"], strand: "add-subtract", rationale: "Apply the column-wise borrow algorithm fluently to numbers of any size." },
  { skillKey: "add_multidigit_algorithm", label: "Multi-digit addition standard algorithm (up to 1,000,000)", grade: "4", ccCodes: ["4.NBT.B.4"], strand: "add-subtract", rationale: "Apply the column-wise carry algorithm fluently to addends of any size." },
  { skillKey: "area_model_multiplication", label: "Area model for multi-digit multiplication", grade: "4", ccCodes: ["4.NBT.B.5"], strand: "mult-divide", rationale: "Decompose factors by place value and sum partial products using a rectangular area model." },
  { skillKey: "division_facts_6_9", label: "Division facts ÷6 through ÷9 (fluency)", grade: "3", ccCodes: ["3.OA.C.7"], strand: "mult-divide", rationale: "Complete all single-digit division fact recall, enabling efficient multi-digit computation." },
  { skillKey: "add_subtract_word_problems_multidigit", label: "Solve multi-step addition and subtraction word problems", grade: "4", ccCodes: ["4.OA.A.3"], strand: "add-subtract", rationale: "Model and solve real-world problems requiring multiple addition or subtraction steps with large numbers." },
  { skillKey: "mult_2digit_by_1digit", label: "Multiply a 2-digit number by a 1-digit number", grade: "4", ccCodes: ["4.NBT.B.5"], strand: "mult-divide", rationale: "Compute products like 34×7 using partial products or the standard algorithm." },
  { skillKey: "division_with_remainders", label: "Divide with remainders; interpret the remainder's meaning", grade: "4", ccCodes: ["4.NBT.B.6", "4.OA.A.3"], strand: "mult-divide", rationale: "Compute whole-number quotients with remainders and decide whether to round up, truncate, or report the remainder." },
  { skillKey: "factors_and_multiples", label: "Identify factors and multiples of whole numbers (within 100)", grade: "4", ccCodes: ["4.OA.B.4"], strand: "number-theory", rationale: "Find all factor pairs for a number within 100 and recognize whether a given number is a multiple of another." },
  { skillKey: "mult_3digit_by_1digit", label: "Multiply a 3-digit number by a 1-digit number", grade: "4", ccCodes: ["4.NBT.B.5"], strand: "mult-divide", rationale: "Extend multi-digit multiplication to three-place numbers, carrying across two positions." },
  { skillKey: "order_of_operations", label: "Apply order of operations (parentheses, then × and ÷, then + and −)", grade: "5", ccCodes: ["5.OA.A.1"], strand: "mult-divide", rationale: "Evaluate numerical expressions by performing operations in the agreed-upon sequence." },
  { skillKey: "long_division_1digit_divisor", label: "Long division: multi-digit ÷ 1-digit divisor", grade: "4", ccCodes: ["4.NBT.B.6"], strand: "mult-divide", rationale: "Apply the divide-multiply-subtract-bring-down cycle to 3- and 4-digit dividends with a 1-digit divisor." },
  { skillKey: "prime_composite", label: "Identify prime and composite numbers up to 100", grade: "4", ccCodes: ["4.OA.B.4"], strand: "number-theory", rationale: "Classify whole numbers by factor count: exactly one pair (prime) or more than one pair (composite)." },
  { skillKey: "mult_2digit_by_2digit", label: "Multiply a 2-digit number by a 2-digit number", grade: "5", ccCodes: ["5.NBT.B.5"], strand: "mult-divide", rationale: "Compute products like 36×47 using the full standard algorithm with four partial products." },
  { skillKey: "long_division_2digit_divisor", label: "Long division: multi-digit ÷ 2-digit divisor", grade: "5", ccCodes: ["5.NBT.B.6"], strand: "mult-divide", rationale: "Extend long division to 2-digit divisors, estimating each partial quotient using place-value reasoning." },

  // ── Number theory (§2 — the gifted strand; most nodes carry NO standard tag,
  //    which is the point: identity is the idea, standards are an optional tag).
  //    GCF/LCM are the cross-domain on-ramp into fractions-decimals (simplify /
  //    unlike denominators) — see raise-the-ceiling-plan §1–§2. ──
  { skillKey: "divisibility_rules_2_5_10", label: "Divisibility rules for 2, 5, and 10", grade: "4", ccCodes: [], strand: "number-theory", rationale: "Decide instantly whether a number is divisible by 2, 5, or 10 from its last digit — the first taste of number structure over brute division." },
  { skillKey: "divisibility_rules_3_9", label: "Divisibility rules for 3 and 9", grade: "4", ccCodes: [], strand: "number-theory", rationale: "Test divisibility by 3 and 9 via digit sums, a surprising property that seeds later work in modular arithmetic." },
  { skillKey: "prime_factorization", label: "Prime factorization (factor trees)", grade: "5", ccCodes: [], strand: "number-theory", rationale: "Decompose any composite number into its unique product of primes — the fundamental theorem of arithmetic, made concrete." },
  { skillKey: "gcf", label: "Greatest common factor (GCF)", grade: "6", ccCodes: ["6.NS.B.4"], strand: "number-theory", rationale: "Find the largest factor two numbers share (via prime factorization) — the engine behind reducing fractions to lowest terms." },
  { skillKey: "lcm", label: "Least common multiple (LCM)", grade: "6", ccCodes: ["6.NS.B.4"], strand: "number-theory", rationale: "Find the smallest multiple two numbers share — the engine behind adding fractions with unlike denominators." },
  { skillKey: "exponents_repeated_mult", label: "Exponents as repeated multiplication", grade: "6", ccCodes: ["6.EE.A.1"], strand: "number-theory", rationale: "Read and evaluate powers (2⁵ = 32) as repeated multiplication, the notation that compresses growth." },
  { skillKey: "square_cube_numbers", label: "Square and cube numbers", grade: "6", ccCodes: [], strand: "number-theory", rationale: "Recognize perfect squares and cubes and the geometry behind them (why they're called square and cube)." },
  { skillKey: "remainder_cycles", label: "Remainder cycles (clock & modular arithmetic)", grade: "6", ccCodes: [], strand: "number-theory", rationale: "Use remainders that wrap around a fixed modulus — the math of clocks, calendars, day-of-week puzzles, and cryptography." },

  // ── 4th-grade-edge densification (PR4 — placement-v2 graph) ───────────────
  //   The cleanroom gap analysis vs. a mature ~140-topic engine flagged these
  //   grade-4 concepts as un/under-modeled: multiplicative place-value comparison
  //   (10×), expanded↔standard form, prime/composite, factors, multiples, and
  //   multi-step expression evaluation. New CCSS tags use SirFizX abbreviated
  //   notation (no cluster letters) to match the DB standard format. ──

  // place-value (the 10× relationship + form conversions)
  { skillKey: "place_value_relationships", label: "A digit is 10× the same digit one place to its right", grade: "4", ccCodes: ["4.NBT.1"], strand: "place-value", rationale: "Recognize that the 5 in 500 is worth ten times the 5 in 50 — the multiplicative structure of base ten, not just naming a digit's value." },
  { skillKey: "compare_multidigit", label: "Compare two multi-digit numbers using <, =, >", grade: "4", ccCodes: ["4.NBT.2"], strand: "place-value", rationale: "Extend place-value comparison past 999 to four- to six-digit numbers by inspecting the highest differing place." },
  { skillKey: "expanded_to_standard_form", label: "Write a number given in expanded form in standard form", grade: "4", ccCodes: ["4.NBT.2"], strand: "place-value", rationale: "Compose 400 + 30 + 7 back into 437 — the inverse of decomposing, and a direct check on place-value understanding." },
  { skillKey: "number_name_to_standard", label: "Write a number given in words as a numeral", grade: "4", ccCodes: ["4.NBT.2"], strand: "place-value", rationale: "Translate 'four hundred thirty-seven' into 437, connecting the spoken/number-name form to base-ten notation." },
  { skillKey: "powers_of_ten", label: "Multiply and divide whole numbers by powers of ten", grade: "5", ccCodes: ["5.NBT.2"], strand: "place-value", rationale: "See ×10 / ×100 / ÷10 as shifts across place value — the grade-5 extension of the 10× relationship." },

  // number-theory (factors, multiples, prime/composite, common factors/multiples)
  { skillKey: "factor_pairs", label: "Find all factor pairs of a whole number within 100", grade: "4", ccCodes: ["4.OA.4"], strand: "number-theory", rationale: "List the pairs whose product is the number (1×24, 2×12, 3×8, 4×6) — the concrete move behind 4.OA.4, distinct from just counting factors." },
  { skillKey: "is_factor", label: "Decide whether a number is a factor of another", grade: "4", ccCodes: ["4.OA.4"], strand: "number-theory", rationale: "Test 'is k a factor of n?' by whether n divides evenly — the factor half of the factor/multiple relationship kids reliably confuse." },
  { skillKey: "is_multiple", label: "Decide whether a number is a multiple of a one-digit number", grade: "4", ccCodes: ["4.OA.4"], strand: "number-theory", rationale: "Test 'is n a multiple of k?' by whether it lands on a skip-count of k — the multiple half of 4.OA.4, the inverse of is_factor." },
  { skillKey: "prime_or_composite", label: "Classify a whole number as prime or composite", grade: "4", ccCodes: ["4.OA.4"], strand: "number-theory", rationale: "Make the prime-vs-composite decision directly (does it have exactly one factor pair?), the naming skill on top of counting factors." },
  { skillKey: "common_factors", label: "Find the common factors of two whole numbers", grade: "5", ccCodes: [], strand: "number-theory", rationale: "List the factors two numbers share — the step between finding one number's factors and finding the GREATEST common one." },
  { skillKey: "common_multiples", label: "Recognize common multiples of two whole numbers", grade: "5", ccCodes: [], strand: "number-theory", rationale: "Spot a number that is a multiple of both — the step between listing multiples and finding the LEAST common one." },

  // mult-divide (multi-step expression evaluation — the order-of-operations on-ramp)
  { skillKey: "two_step_expressions", label: "Evaluate a two-operation numerical expression using precedence", grade: "5", ccCodes: ["5.OA.1"], strand: "mult-divide", rationale: "Compute 4 + 3 × 2 by doing the multiplication first — formal operator precedence is 5.OA.1, the two-operation precursor to the full order of operations (kept out of the grade-4 first-probe set so a grade-4 scholar isn't opened on precedence)." },
];

export const WHOLE_NUMBER_ARITHMETIC_EDGES: SeedEdge[] = [
  { fromKey: "count_to_10", toKey: "count_to_20" },
  { fromKey: "count_to_20", toKey: "count_to_100_ones" },
  { fromKey: "count_to_10", toKey: "count_to_100_tens" },
  { fromKey: "count_to_20", toKey: "count_on" },
  { fromKey: "count_to_10", toKey: "cardinality_within_10" },
  { fromKey: "cardinality_within_10", toKey: "count_objects_within_10" },
  { fromKey: "count_to_10", toKey: "count_objects_within_10" },
  { fromKey: "count_objects_within_10", toKey: "count_objects_within_20" },
  { fromKey: "count_to_20", toKey: "count_objects_within_20" },
  { fromKey: "count_objects_within_10", toKey: "compare_within_10" },
  { fromKey: "count_to_20", toKey: "write_numerals_to_20" },
  { fromKey: "count_to_100_tens", toKey: "compose_ten" },
  { fromKey: "count_objects_within_20", toKey: "compose_ten" },
  { fromKey: "compose_ten", toKey: "tens_ones_to_99" },
  { fromKey: "count_to_100_ones", toKey: "tens_ones_to_99" },
  { fromKey: "tens_ones_to_99", toKey: "compare_2digit" },
  { fromKey: "tens_ones_to_99", toKey: "ten_more_ten_less" },
  { fromKey: "tens_ones_to_99", toKey: "hundreds_tens_ones" },
  { fromKey: "hundreds_tens_ones", toKey: "expanded_form_3digit" },
  { fromKey: "hundreds_tens_ones", toKey: "compare_3digit" },
  { fromKey: "hundreds_tens_ones", toKey: "place_value_to_1000" },
  { fromKey: "place_value_to_1000", toKey: "place_value_multidigit" },
  { fromKey: "place_value_multidigit", toKey: "expanded_form_multidigit" },
  { fromKey: "hundreds_tens_ones", toKey: "round_to_nearest_10_100" },
  { fromKey: "place_value_multidigit", toKey: "round_multidigit" },
  { fromKey: "round_to_nearest_10_100", toKey: "round_multidigit" },
  { fromKey: "count_objects_within_10", toKey: "add_within_5" },
  { fromKey: "count_objects_within_10", toKey: "subtract_within_5" },
  { fromKey: "add_within_5", toKey: "add_within_10" },
  { fromKey: "subtract_within_5", toKey: "subtract_within_10" },
  { fromKey: "count_on", toKey: "add_within_10" },
  { fromKey: "add_within_10", toKey: "add_subtract_word_problems_within_10" },
  { fromKey: "subtract_within_10", toKey: "add_subtract_word_problems_within_10" },
  { fromKey: "add_within_10", toKey: "make_ten_strategy" },
  { fromKey: "compose_ten", toKey: "make_ten_strategy" },
  { fromKey: "make_ten_strategy", toKey: "add_within_20_no_regroup" },
  { fromKey: "add_within_10", toKey: "add_within_20_no_regroup" },
  { fromKey: "add_within_20_no_regroup", toKey: "add_within_20_regroup" },
  { fromKey: "subtract_within_10", toKey: "subtract_within_20" },
  { fromKey: "add_within_20_no_regroup", toKey: "subtract_within_20" },
  { fromKey: "add_within_10", toKey: "add_subtract_properties" },
  { fromKey: "add_within_20_regroup", toKey: "add_subtract_fluency_within_20" },
  { fromKey: "subtract_within_20", toKey: "add_subtract_fluency_within_20" },
  { fromKey: "tens_ones_to_99", toKey: "add_2digit_no_regroup" },
  { fromKey: "add_subtract_fluency_within_20", toKey: "add_2digit_no_regroup" },
  { fromKey: "add_subtract_properties", toKey: "add_2digit_no_regroup" },
  { fromKey: "add_2digit_no_regroup", toKey: "add_2digit_regroup" },
  { fromKey: "add_within_20_regroup", toKey: "add_2digit_regroup" },
  { fromKey: "tens_ones_to_99", toKey: "subtract_2digit_no_regroup" },
  { fromKey: "add_subtract_fluency_within_20", toKey: "subtract_2digit_no_regroup" },
  { fromKey: "subtract_2digit_no_regroup", toKey: "subtract_2digit_regroup" },
  { fromKey: "subtract_within_20", toKey: "subtract_2digit_regroup" },
  { fromKey: "hundreds_tens_ones", toKey: "add_3digit_no_regroup" },
  { fromKey: "add_2digit_regroup", toKey: "add_3digit_no_regroup" },
  { fromKey: "add_3digit_no_regroup", toKey: "add_3digit_regroup" },
  { fromKey: "hundreds_tens_ones", toKey: "subtract_3digit_regroup" },
  { fromKey: "subtract_2digit_regroup", toKey: "subtract_3digit_regroup" },
  { fromKey: "add_3digit_regroup", toKey: "add_multidigit_algorithm" },
  { fromKey: "place_value_multidigit", toKey: "add_multidigit_algorithm" },
  { fromKey: "subtract_3digit_regroup", toKey: "subtract_multidigit_algorithm" },
  { fromKey: "place_value_multidigit", toKey: "subtract_multidigit_algorithm" },
  { fromKey: "add_multidigit_algorithm", toKey: "add_subtract_word_problems_multidigit" },
  { fromKey: "subtract_multidigit_algorithm", toKey: "add_subtract_word_problems_multidigit" },
  { fromKey: "count_to_100_ones", toKey: "skip_count_2s_5s_10s" },
  { fromKey: "count_to_100_tens", toKey: "skip_count_2s_5s_10s" },
  { fromKey: "skip_count_2s_5s_10s", toKey: "skip_count_3s_4s" },
  { fromKey: "skip_count_3s_4s", toKey: "skip_count_6s_7s_8s_9s" },
  { fromKey: "skip_count_2s_5s_10s", toKey: "equal_groups_concept" },
  { fromKey: "add_subtract_fluency_within_20", toKey: "equal_groups_concept" },
  { fromKey: "equal_groups_concept", toKey: "arrays_concept" },
  { fromKey: "equal_groups_concept", toKey: "mult_facts_0_1_2_5_10" },
  { fromKey: "skip_count_2s_5s_10s", toKey: "mult_facts_0_1_2_5_10" },
  { fromKey: "mult_facts_0_1_2_5_10", toKey: "mult_commutative_associative" },
  { fromKey: "add_subtract_properties", toKey: "mult_commutative_associative" },
  { fromKey: "mult_facts_0_1_2_5_10", toKey: "mult_facts_3_4_6" },
  { fromKey: "skip_count_3s_4s", toKey: "mult_facts_3_4_6" },
  { fromKey: "mult_facts_3_4_6", toKey: "mult_facts_7_8_9" },
  { fromKey: "skip_count_6s_7s_8s_9s", toKey: "mult_facts_7_8_9" },
  { fromKey: "mult_commutative_associative", toKey: "mult_distributive" },
  { fromKey: "mult_distributive", toKey: "area_model_multiplication" },
  { fromKey: "tens_ones_to_99", toKey: "area_model_multiplication" },
  { fromKey: "mult_distributive", toKey: "mult_2digit_by_1digit" },
  { fromKey: "mult_facts_7_8_9", toKey: "mult_2digit_by_1digit" },
  { fromKey: "area_model_multiplication", toKey: "mult_2digit_by_1digit" },
  { fromKey: "mult_2digit_by_1digit", toKey: "mult_3digit_by_1digit" },
  { fromKey: "hundreds_tens_ones", toKey: "mult_3digit_by_1digit" },
  { fromKey: "mult_2digit_by_1digit", toKey: "mult_2digit_by_2digit" },
  { fromKey: "mult_3digit_by_1digit", toKey: "mult_2digit_by_2digit" },
  { fromKey: "equal_groups_concept", toKey: "division_as_sharing" },
  { fromKey: "equal_groups_concept", toKey: "division_as_grouping" },
  { fromKey: "mult_facts_0_1_2_5_10", toKey: "division_facts_0_5" },
  { fromKey: "division_as_sharing", toKey: "division_facts_0_5" },
  { fromKey: "division_facts_0_5", toKey: "division_facts_6_9" },
  { fromKey: "mult_facts_7_8_9", toKey: "division_facts_6_9" },
  { fromKey: "division_as_grouping", toKey: "division_facts_6_9" },
  { fromKey: "division_facts_6_9", toKey: "division_with_remainders" },
  { fromKey: "division_with_remainders", toKey: "long_division_1digit_divisor" },
  { fromKey: "subtract_multidigit_algorithm", toKey: "long_division_1digit_divisor" },
  { fromKey: "mult_2digit_by_1digit", toKey: "long_division_1digit_divisor" },
  { fromKey: "long_division_1digit_divisor", toKey: "long_division_2digit_divisor" },
  { fromKey: "mult_2digit_by_2digit", toKey: "long_division_2digit_divisor" },
  { fromKey: "mult_facts_7_8_9", toKey: "factors_and_multiples" },
  { fromKey: "division_facts_6_9", toKey: "factors_and_multiples" },
  { fromKey: "factors_and_multiples", toKey: "prime_composite" },
  { fromKey: "add_subtract_properties", toKey: "order_of_operations" },
  { fromKey: "mult_commutative_associative", toKey: "order_of_operations" },
  { fromKey: "mult_2digit_by_1digit", toKey: "order_of_operations" },
  { fromKey: "division_facts_6_9", toKey: "order_of_operations" },

  // ── Number theory (§2) — buildsOn edges are pedagogical claims (Opus-curated).
  //    Forward-only from existing arithmetic into the new strand, and within it,
  //    so the graph stays acyclic. GCF/LCM depend on prime factorization + the
  //    factors/multiples concept; they are the fractions-domain on-ramp. ──
  { fromKey: "factors_and_multiples", toKey: "divisibility_rules_2_5_10" },
  { fromKey: "factors_and_multiples", toKey: "divisibility_rules_3_9" },
  { fromKey: "prime_composite", toKey: "prime_factorization" },
  { fromKey: "divisibility_rules_3_9", toKey: "prime_factorization" },
  { fromKey: "factors_and_multiples", toKey: "gcf" },
  { fromKey: "prime_factorization", toKey: "gcf" },
  { fromKey: "factors_and_multiples", toKey: "lcm" },
  { fromKey: "prime_factorization", toKey: "lcm" },
  { fromKey: "mult_facts_7_8_9", toKey: "exponents_repeated_mult" },
  { fromKey: "exponents_repeated_mult", toKey: "square_cube_numbers" },
  { fromKey: "division_with_remainders", toKey: "remainder_cycles" },

  // ── 4th-grade-edge densification (PR4) — new edges ────────────────────────
  //   All forward (foundational → advanced, lower grade → higher), so the graph
  //   stays acyclic (validateCombinedGraph enforces over the combined set).
  //   ⭑ = CROSS-STRAND prereq: a genuine dependency that crosses strand
  //   boundaries (e.g. the 10× place-value idea needs multiplication-by-10).
  //   placement.topoOrderStrand drops cross-strand edges for WITHIN-strand
  //   ordering, but the real engine's computeFrontier honors them — see the
  //   ordering decision in review/placement-v2/graph-progress.md. ──

  // place-value: the 10× relationship, form conversions, powers of ten
  { fromKey: "place_value_multidigit", toKey: "place_value_relationships" },
  { fromKey: "mult_facts_0_1_2_5_10", toKey: "place_value_relationships" }, // ⭑ mult-divide → place-value
  { fromKey: "place_value_multidigit", toKey: "compare_multidigit" },
  { fromKey: "compare_3digit", toKey: "compare_multidigit" },
  { fromKey: "expanded_form_3digit", toKey: "expanded_to_standard_form" },
  { fromKey: "place_value_to_1000", toKey: "expanded_to_standard_form" },
  { fromKey: "hundreds_tens_ones", toKey: "number_name_to_standard" },
  { fromKey: "place_value_multidigit", toKey: "number_name_to_standard" },
  { fromKey: "place_value_relationships", toKey: "powers_of_ten" },
  { fromKey: "mult_facts_0_1_2_5_10", toKey: "powers_of_ten" }, // ⭑ mult-divide → place-value

  // number-theory: factors / multiples / prime-composite / common factors+multiples
  { fromKey: "factors_and_multiples", toKey: "factor_pairs" },
  { fromKey: "factors_and_multiples", toKey: "is_factor" },
  { fromKey: "division_facts_6_9", toKey: "is_factor" }, // ⭑ mult-divide → number-theory
  { fromKey: "factors_and_multiples", toKey: "is_multiple" },
  { fromKey: "mult_facts_7_8_9", toKey: "is_multiple" }, // ⭑ mult-divide → number-theory
  { fromKey: "factor_pairs", toKey: "prime_or_composite" },
  { fromKey: "prime_composite", toKey: "prime_or_composite" },
  { fromKey: "factor_pairs", toKey: "common_factors" },
  { fromKey: "common_factors", toKey: "gcf" },
  { fromKey: "is_multiple", toKey: "common_multiples" },
  { fromKey: "common_multiples", toKey: "lcm" },

  // mult-divide: multi-step expression evaluation → order of operations
  { fromKey: "mult_facts_7_8_9", toKey: "two_step_expressions" },
  { fromKey: "add_subtract_fluency_within_20", toKey: "two_step_expressions" }, // ⭑ add-subtract → mult-divide
  { fromKey: "two_step_expressions", toKey: "order_of_operations" },

  // ── Surgical densification (graph-density check-in #1) ────────────────────
  //   Deepen the six whole-number chains whose grade jumped >1 over their
  //   nearest graded prerequisite — the shallow spots that let a higher-grade
  //   node surface as "frontier" for a much younger scholar before the
  //   difficulty band caught it (review/practice/algo-audit-2026-07.md). Each
  //   edge adds a GENUINE one-grade-below prerequisite, so the node only becomes
  //   frontier once the scholar has demonstrably reached the grade below it (the
  //   band ceiling rises with them). Forward-only (lower→higher grade), so the
  //   graph stays acyclic. ⭑ = cross-strand. graphGrades.test.ts locks the
  //   resulting "≤1 grade above a prerequisite" invariant against drift. ──
  { fromKey: "powers_of_ten", toKey: "exponents_repeated_mult" }, // ⭑ place-value → number-theory g5→g6: exponents generalize the ×10 powers-of-ten pattern
  { fromKey: "common_multiples", toKey: "remainder_cycles" }, // number-theory g5→g6: modular/clock cycles ARE the periodicity of common multiples
  { fromKey: "round_to_nearest_10_100", toKey: "place_value_multidigit" }, // place-value g3→g4: consolidate 3-digit place value (rounding is its capstone) before extending to 1,000,000. Softest of the six — a consolidation edge, not a strict prereq (CCSS has no true g3 "place value beyond 1000" node); a new g3 node was the alternative, deferred to keep this edges-only.
  { fromKey: "expanded_form_multidigit", toKey: "expanded_to_standard_form" }, // place-value g4: writing standard form from expanded is the inverse of writing multi-digit expanded form
  { fromKey: "mult_2digit_by_1digit", toKey: "two_step_expressions" }, // mult-divide g4→g5: evaluating two-operation expressions needs multi-digit multiplication
  { fromKey: "ten_more_ten_less", toKey: "skip_count_2s_5s_10s" }, // ⭑ place-value → mult-divide g1→g2: skip-counting by 10s is repeatedly adding ten
];
