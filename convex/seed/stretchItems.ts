/**
 * Seed data: hand-authored STRETCH-tier practice items (deliberate difficulty).
 *
 * The Beast-Academy-inspired depth tier (see practiceItems.tier in schema.ts):
 * each item is an INSIGHT problem on a node a scholar may already own — harder
 * by requiring an idea (working backward, casework, an invariant, a telescoping
 * pattern), never by adding steps. Served only through the opt-in "Go deeper"
 * tail on demonstrated-fluent nodes; a miss never touches the mastery row; a
 * solo success writes depth evidence (evidenceType "stretch_success") that
 * moves the node dial's depth arc.
 *
 * Authoring bar: every item must have (a) a single unambiguous canonical
 * answer in an authorable answerType (integer / decimal / fraction), (b) a
 * genuine insight step a well-drilled kid can MISS, and (c) an answer that is
 * hand-verified in the comment. ~60–70% first-try success for a fluent scholar
 * is the design target. Keep the pool small and excellent — this is curated
 * content, not generation.
 *
 * Idempotent: an item is skipped when a stored row with the same
 * (skillKey, stem) already exists. Renamed items carry their prior stems so the
 * existing row is updated in place instead of leaving stale copy behind. Run via
 *   npx convex run seed/stretchItems:seedStretchItems
 * (wired into scripts/db-seed.sh).
 */

import { internalMutation } from "../_generated/server";

type StretchSeedItem = {
  skillKey: string;
  stem: string;
  answerType: "integer" | "decimal" | "fraction" | "dialogue";
  /** Empty string for a dialogue item (nothing to type). */
  answer: string;
  technique: string;
  /** Bloom level (0–5) a solo success evidences. */
  bloomLevel: number;
  /** DIALOGUE items only: the judge's criteria (server-only; 2–3 essentials —
   *  the pass bar is all-of-them). */
  rubricCriteria?: string[];
  /** Prior authored stems that should be renamed in place. */
  legacyStems?: string[];
};

export const STRETCH_SEED_ITEMS: StretchSeedItem[] = [
  // ── whole-number-arithmetic ─────────────────────────────────────────────
  {
    skillKey: "mult_facts_7_8_9",
    stem: "Two one-digit numbers add up to 15, and their product ends in 4. What is their product?",
    answerType: "integer",
    answer: "54",
    // Pairs summing to 15: (6,9) → 54 ✓ ends in 4; (7,8) → 56 ends in 6. Answer 54.
    technique: "casework",
    bloomLevel: 3,
  },
  {
    skillKey: "mult_distributive",
    stem: "Without working out either multiplication: what is 37 × 25 − 36 × 25?",
    answerType: "integer",
    answer: "25",
    // 37×25 − 36×25 = (37−36)×25 = 25.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "division_with_remainders",
    stem: "A number bigger than 20 leaves remainder 4 when divided by 5, and remainder 1 when divided by 2. What is the smallest number that works?",
    answerType: "integer",
    answer: "29",
    // ≡4 (mod 5): 24, 29, 34… — must also be odd → 29.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "remainder_cycles",
    stem: "Multiply ten 7s together: 7 × 7 × 7 × … × 7. What is the ones digit of the answer?",
    answerType: "integer",
    answer: "9",
    // Ones digits of powers of 7 cycle 7, 9, 3, 1 (length 4); 10 ≡ 2 (mod 4) → 9.
    technique: "invariant",
    bloomLevel: 4,
  },
  {
    skillKey: "factor_pairs",
    stem: "A rectangle has whole-number side lengths and an area of 36. What is the smallest perimeter it could have?",
    answerType: "integer",
    answer: "24",
    // 1×36→74, 2×18→40, 3×12→30, 4×9→26, 6×6→24. Squarest is smallest.
    technique: "extremal",
    bloomLevel: 4,
  },
  {
    skillKey: "prime_composite",
    stem: "Exactly one prime number lives between 90 and 100. Which one?",
    answerType: "integer",
    answer: "97",
    // 91=7×13, 93=3×31, 97 prime, 99=9×11; evens/95 composite.
    technique: "casework",
    bloomLevel: 3,
  },
  {
    skillKey: "order_of_operations",
    stem: "Add one pair of parentheses to 2 + 3 × 4 − 1 to make the biggest possible value. What is that value?",
    answerType: "integer",
    answer: "19",
    // (2+3)×4−1 = 19; (2+3)×(4−1) = 15; 2+3×(4−1) = 11; plain = 13.
    technique: "extremal",
    bloomLevel: 4,
  },
  {
    skillKey: "factors_and_multiples",
    stem: "How many numbers from 1 to 100 are multiples of BOTH 6 and 8?",
    answerType: "integer",
    answer: "4",
    // LCM(6,8) = 24 → 24, 48, 72, 96.
    technique: "structure",
    bloomLevel: 4,
  },
  // ── fraction-arithmetic ─────────────────────────────────────────────────
  {
    skillKey: "equivalent_fractions_general",
    stem: "A fraction is equivalent to 3/5, and its numerator and denominator add up to 56. What is its numerator?",
    answerType: "integer",
    answer: "21",
    // 3k + 5k = 8k = 56 → k = 7 → 21/35. (Asked as an integer so the graded
    // answer can't be satisfied by just re-typing 3/5.)
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "compare_unlike",
    stem: "How many of these five fractions are greater than 1/2:  4/9,  5/11,  7/13,  9/17,  5/8?",
    answerType: "integer",
    answer: "3",
    // Halves benchmark: 4/9 < ½, 5/11 < ½, 7/13 > ½, 9/17 > ½, 5/8 > ½ → 3.
    technique: "benchmarks",
    bloomLevel: 3,
  },
  {
    skillKey: "multiply_fractions",
    stem: "What is 1/2 × 2/3 × 3/4 × 4/5 × 5/6?",
    answerType: "fraction",
    answer: "1/6",
    // Telescopes: everything cancels except 1 on top and 6 on the bottom.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "add_subtract_unlike",
    stem: "What is 1/2 + 1/4 + 1/8 + 1/16?",
    answerType: "fraction",
    answer: "15/16",
    // Each step lands 1/16 short of a whole: 8/16 + 4/16 + 2/16 + 1/16 = 15/16.
    technique: "structure",
    bloomLevel: 4,
  },
  // ── DIALOGUE stretch items (the rubric'd-chat vessel) ───────────────────
  // Graded on /practice-dialogue by the rubric judge, never by the arithmetic
  // verifier. These reach the evaluate/create band typed items can't.
  {
    skillKey: "multiply_fractions",
    stem: "Work out 1/2 × 2/3 × 3/4 × 4/5 × 5/6 — then explain why the answer comes out so simple, and what a chain going all the way to 99/100 would equal.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Identifies, in their own words, that each numerator cancels with the previous fraction's denominator (chain/telescoping cancellation).",
      "States that only the first numerator and the last denominator survive, so the product is 1/6.",
      "Correctly generalizes the pattern: the chain ending at 99/100 equals 1/100.",
    ],
  },
  {
    skillKey: "area_model_multiplication",
    stem: "A friend says 23 × 17 must equal 20 × 10 + 3 × 7 = 221 — multiply the tens together, multiply the ones together, add. Their answer is wrong. Explain what their method misses, and how the area model shows it.",
    answerType: "dialogue",
    answer: "",
    technique: "error_analysis",
    bloomLevel: 5,
    rubricCriteria: [
      "Identifies the missing cross partial products (tens × ones both ways: 20 × 7 and 3 × 10).",
      "Connects the four partial products to the four regions of the area model (or an equivalent picture in their own words).",
    ],
  },
  {
    skillKey: "fraction_as_division",
    stem: "Three sandwiches are shared equally by four hikers. Explain why each hiker gets exactly 3/4 of a sandwich — and why it comes out the same whether you cut every sandwich into four pieces first, or share them some other fair way.",
    answerType: "dialogue",
    answer: "",
    technique: "multiple_paths",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that sharing 3 things among 4 people means each gets 3 ÷ 4, and that this IS the fraction 3/4 (fraction as division), in their own words.",
      "Describes at least one concrete fair-sharing strategy and shows it lands on 3/4 (e.g. a quarter of each of the three sandwiches).",
    ],
  },

  // ══ WAVE 1 — K-6 whole-number-arithmetic Go-deeper coverage ═══════════════
  // Insight problems on the three foundational strands (add-subtract,
  // mult-divide, place-value). Each takes an IDEA — compensation, constant
  // difference, a fact family, an invariant, working backward, a place-value
  // surprise — not a bigger number. Kid-register (grades 2-6), anti-deficit.

  // ── whole-number-arithmetic / add-subtract ──────────────────────────────
  {
    skillKey: "add_within_5",
    stem: "How many different ways can you fill in ⬜ + ⬜ = 5 using two whole numbers from 0 to 5? Count 1 + 4 and 4 + 1 as different ways.",
    answerType: "integer",
    answer: "6",
    // (0,5)(1,4)(2,3)(3,2)(4,1)(5,0) → 6. The staircase of pairs.
    technique: "counting",
    bloomLevel: 3,
  },
  {
    skillKey: "add_within_10",
    stem: "Two numbers add up to 10, and the bigger one is 2 more than the smaller one. What is the bigger number?",
    answerType: "integer",
    answer: "6",
    // s + (s+2) = 10 → s = 4, bigger = 6.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "add_subtract_word_problems_within_10",
    stem: "Sam and Bo have 9 marbles altogether. Sam has 3 more than Bo. How many marbles does Sam have?",
    answerType: "integer",
    answer: "6",
    // Larger = (9 + 3) / 2 = 6 (Bo has 3). Sum-and-difference for little numbers.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "subtract_within_5",
    stem: "Look at the pattern: 5 − 2 = 3 and 5 − 3 = 2 — the answers swap! If 5 − 4 = 1, then what is 5 − 1?",
    answerType: "integer",
    answer: "4",
    // Fact-family flip: the two parts of 5 trade places.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "subtract_within_10",
    stem: "You know 9 − 4 = 5. Add 1 to BOTH numbers to get 10 − 5. Without subtracting the hard way, what does 10 − 5 equal?",
    answerType: "integer",
    answer: "5",
    // Constant difference: sliding both numbers up 1 leaves the gap the same.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "add_within_20_no_regroup",
    stem: "13 + 5 and 15 + 3 look like different problems, but they have the same total. What is it?",
    answerType: "integer",
    answer: "18",
    // Moving 2 from one addend to the other doesn't change the sum.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "add_within_20_regroup",
    stem: "You know 9 + 9 = 18. Without adding again, what is 9 + 8?",
    answerType: "integer",
    answer: "17",
    // One less than the double: 8 is one less than 9.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "add_subtract_properties",
    stem: "10 − 4 = 6. Using only that fact and no new subtracting, what is 10 − 6?",
    answerType: "integer",
    answer: "4",
    // 4, 6, and 10 are one fact family: swap the parts.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "make_ten_strategy",
    stem: "To add 8 + 5, Maya first makes a ten. Explain how she breaks up the 5, and why turning the problem into “10 plus something” makes it easier to finish.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that the 5 is split so that 2 joins the 8 to make 10, leaving 3 — in their own words.",
      "Explains that 10 + 3 is easy (adding onto a ten is simple), giving 13.",
    ],
  },
  {
    skillKey: "add_2digit_no_regroup",
    stem: "Two 2-digit numbers add up to exactly 100. One of them is 37. What is the other one?",
    answerType: "integer",
    answer: "63",
    // Complement to 100: 100 − 37 = 63.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "add_2digit_regroup",
    stem: "26 + 27 is a double plus one. Since 26 + 26 = 52, what is 26 + 27?",
    answerType: "integer",
    answer: "53",
    // Near-double: one more than 52.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "add_3digit_no_regroup",
    stem: "246 + 100 is easy — it's 346. Use that to find 246 + 99 without adding 99 the long way.",
    answerType: "integer",
    answer: "345",
    // Add 100, step back 1: 346 − 1 = 345.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "add_3digit_regroup",
    stem: "Round 398 up to 400, add 247 to get 647, then fix the overshoot. What is 398 + 247?",
    answerType: "integer",
    answer: "645",
    // 647 − 2 = 645 (you added 2 extra when you rounded up).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "add_subtract_fluency_within_20",
    stem: "Two whole numbers add up to 12 and differ by 4. What is the larger one?",
    answerType: "integer",
    answer: "8",
    // Larger = (12 + 4) / 2 = 8 (smaller = 4).
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "subtract_2digit_no_regroup",
    stem: "48 − 23. Add 2 to BOTH numbers to make the easier 50 − 25. What is 48 − 23?",
    answerType: "integer",
    answer: "25",
    // Constant difference: 50 − 25 = 25, same gap as 48 − 23.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "subtract_within_20",
    stem: "17 − 9 = 8. Without subtracting the hard way, what is 17 − 8?",
    answerType: "integer",
    answer: "9",
    // Same whole (17), the two parts 8 and 9 trade places.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "subtract_2digit_regroup",
    stem: "Find 63 − 28 by counting UP from 28 to 63 instead of borrowing. How far is it from 28 to 63?",
    answerType: "integer",
    answer: "35",
    // Subtraction as distance: 28 → 63 is 35 (28 + 35 = 63).
    technique: "multiple_paths",
    bloomLevel: 3,
  },
  {
    skillKey: "subtract_3digit_regroup",
    stem: "Instead of borrowing across the zeros in 600 − 247, first do 599 − 247 (no borrowing), then add 1 back. What is 600 − 247?",
    answerType: "integer",
    answer: "353",
    // 599 − 247 = 352, then + 1 = 353.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "add_multidigit_algorithm",
    stem: "When you add 468 + 357 with the standard algorithm, how many times do you carry (regroup) a 1?",
    answerType: "integer",
    answer: "2",
    // ones 8+7=15 → carry; tens 6+5+1=12 → carry; hundreds 4+3+1=8 → no. Two carries.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "add_multidigit_algorithm",
    stem: "When you add 468 + 357 and the ones make 15, you write 5 and carry a 1 to the tens. Explain what that carried 1 really stands for, and why carrying it keeps the answer correct.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that the carried 1 stands for one ten (ten of the ones regrouped into a single ten), in their own words.",
      "Explains that moving it into the tens column keeps the total unchanged because 15 ones = 1 ten and 5 ones.",
    ],
  },
  {
    skillKey: "subtract_multidigit_algorithm",
    stem: "To do 5000 − 2367 you'd borrow across all those zeros. Instead compute 4999 − 2367 (no borrowing) then add 1 back. What is 5000 − 2367?",
    answerType: "integer",
    answer: "2633",
    // 4999 − 2367 = 2632, then + 1 = 2633.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "add_subtract_word_problems_multidigit",
    stem: "A number plus 250 gives the same result as 400 minus that same number. What is the number?",
    answerType: "integer",
    answer: "75",
    // x + 250 = 400 − x → 2x = 150 → x = 75.
    technique: "working_backward",
    bloomLevel: 4,
  },

  // ── whole-number-arithmetic / mult-divide ───────────────────────────────
  {
    skillKey: "skip_count_2s_5s_10s",
    stem: "Some numbers get said when you count by 2s AND when you count by 5s. What is the smallest one bigger than 0?",
    answerType: "integer",
    answer: "10",
    // First shared landing of the 2s and 5s counts is 10.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "skip_count_3s_4s",
    stem: "Counting by 3s and counting by 4s, what is the first number after 0 that both counts land on?",
    answerType: "integer",
    answer: "12",
    // Smallest number in both the 3s and 4s counts is 12.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "skip_count_6s_7s_8s_9s",
    stem: "Count by 9s: 9, 18, 27, 36, 45. The two digits of each number always add up to the same number. What is it?",
    answerType: "integer",
    answer: "9",
    // Digit sum of every multiple of 9 is 9 (9, 1+8, 2+7, …).
    technique: "invariant",
    bloomLevel: 4,
  },
  {
    skillKey: "mult_commutative_associative",
    stem: "You can multiply 2 × 9 × 5 in any order. Pick the order that makes a ten first, then give the answer.",
    answerType: "integer",
    answer: "90",
    // 2 × 5 = 10, then × 9 = 90. Reorder to make the easy pair.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "mult_facts_0_1_2_5_10",
    stem: "5 × 2 = 10, 5 × 4 = 20, 5 × 6 = 30. What is the ones digit of 5 times ANY even number?",
    answerType: "integer",
    answer: "0",
    // 5 × even is always a multiple of 10 → ones digit 0.
    technique: "invariant",
    bloomLevel: 4,
  },
  {
    skillKey: "mult_facts_3_4_6",
    stem: "You know 6 × 4 = 24. Since 8 is double 4, what is 6 × 8?",
    answerType: "integer",
    answer: "48",
    // Double the fact: 24 × 2 = 48.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "division_facts_0_5",
    stem: "12 ÷ 3 = 4. Without dividing, what is 12 ÷ 4?",
    answerType: "integer",
    answer: "3",
    // 3, 4, 12 are one fact family: the two divisors swap.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "division_facts_6_9",
    stem: "A mystery number divided by 6 is 8. What is that same number divided by 8?",
    answerType: "integer",
    answer: "6",
    // The number is 48; 48 ÷ 8 = 6. Fact family 6, 8, 48.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "division_as_sharing",
    stem: "You want to share 24 marbles into equal groups, with more than 1 group and more than 1 marble in each group. How many different group sizes are possible?",
    answerType: "integer",
    answer: "6",
    // Group counts 2,3,4,6,8,12 give sizes 12,8,6,4,3,2 — six equal-share splits.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "division_as_grouping",
    stem: "You have 30 apples and fill bags of 4. How many apples are left over that can't fill a bag?",
    answerType: "integer",
    answer: "2",
    // 30 = 7 × 4 + 2 → remainder 2.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "equal_groups_concept",
    stem: "5 equal boxes hold 30 crayons in all. If you add one more box of the same size, how many crayons is that altogether?",
    answerType: "integer",
    answer: "36",
    // Each box holds 30 ÷ 5 = 6; 6 boxes × 6 = 36.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "arrays_concept",
    stem: "A dot array has 3 rows and 5 columns, so 15 dots. Turn it a quarter-turn so the rows become columns. Explain why it still has 15 dots — and how that shows 3 × 5 equals 5 × 3.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that turning the array adds and removes no dots, so the total is still 15 — in their own words.",
      "Connects this to why 3 × 5 = 5 × 3 (the same array counted rows-times-columns either way).",
    ],
  },
  {
    skillKey: "long_division_1digit_divisor",
    stem: "When you divide any whole number by 7, what is the largest remainder you could ever get?",
    answerType: "integer",
    answer: "6",
    // A remainder must be less than the divisor 7 → biggest is 6.
    technique: "invariant",
    bloomLevel: 4,
  },
  {
    skillKey: "mult_2digit_by_1digit",
    stem: "6 × 99 is easier as 6 × 100 − 6. What is 6 × 99?",
    answerType: "integer",
    answer: "594",
    // 600 − 6 = 594 (the distributive shortcut).
    technique: "distributive",
    bloomLevel: 4,
  },
  {
    skillKey: "mult_3digit_by_1digit",
    stem: "You know 8 × 125 = 1000. Using that, what is 16 × 125?",
    answerType: "integer",
    answer: "2000",
    // 16 is double 8, so double 1000.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "two_step_expressions",
    stem: "Add one pair of parentheses to 24 ÷ 4 + 2 to make it equal 4. What number do you end up dividing 24 by?",
    answerType: "integer",
    answer: "6",
    // 24 ÷ (4 + 2) = 24 ÷ 6 = 4.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "long_division_2digit_divisor",
    stem: "Without long division: about how many times does 48 go into 500? Use 48 ≈ 50 to help, and give the whole-number quotient.",
    answerType: "integer",
    answer: "10",
    // 48 × 10 = 480 (remainder 20); 48 × 11 = 528 is too big → 10.
    technique: "benchmarks",
    bloomLevel: 4,
  },
  {
    skillKey: "mult_2digit_by_2digit",
    stem: "25 × 16 is easy if you split the 16 into 4 × 4: then 25 × 4 = 100 and 100 × 4 = 400. What is 25 × 16?",
    answerType: "integer",
    answer: "400",
    // Regroup the factors: 25 × 4 × 4 = 400.
    technique: "structure",
    bloomLevel: 4,
  },

  // ── whole-number-arithmetic / place-value ───────────────────────────────
  {
    skillKey: "compose_ten",
    stem: "A number is made of some tens and some ones and equals 34. If you use exactly 2 tens, how many ones do you need?",
    answerType: "integer",
    answer: "14",
    // 34 − 20 = 14 ones. Ten can be composed flexibly.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "compare_2digit",
    stem: "I'm a 2-digit number. My tens digit is 3 more than my ones digit, and my two digits add up to 11. What number am I?",
    answerType: "integer",
    answer: "74",
    // ones = 4, tens = 7 (4 + 7 = 11, 7 − 4 = 3).
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "ten_more_ten_less",
    stem: "Start at 47. Add ten, add ten, take ten away, then add ten. Where do you land?",
    answerType: "integer",
    answer: "67",
    // Net change +2 tens = +20; the ones digit never moves. 47 → 67.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "tens_ones_to_99",
    stem: "A number is made of 4 tens and 12 ones. What number is it?",
    answerType: "integer",
    answer: "52",
    // 12 ones regroup to 1 ten 2 ones → 5 tens 2 ones = 52.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "compare_3digit",
    stem: "Using the digits 4, 7, and 2 once each, subtract the smallest 3-digit number you can make from the largest. What do you get?",
    answerType: "integer",
    answer: "495",
    // 742 − 247 = 495.
    technique: "extremal",
    bloomLevel: 4,
  },
  {
    skillKey: "hundreds_tens_ones",
    stem: "A number has 2 hundreds, 15 tens, and 3 ones. What number is it?",
    answerType: "integer",
    answer: "353",
    // 200 + 150 + 3 = 353 (the 15 tens regroup up).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "place_value_to_1000",
    stem: "In the number 505, one 5 is worth how many times the other 5?",
    answerType: "integer",
    answer: "100",
    // 500 vs 5 → 100 times as much. Same digit, different place.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expanded_form_3digit",
    stem: "Which is bigger: 400 + 5, or 300 + 90 + 8? Write the bigger one as a standard number.",
    answerType: "integer",
    answer: "405",
    // 405 > 398 — expanded form hides which is larger.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "round_to_nearest_10_100",
    stem: "What is the smallest whole number that rounds to 400 when you round to the nearest hundred?",
    answerType: "integer",
    answer: "350",
    // 350 rounds up to 400; 349 rounds to 300. The boundary.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "place_value_relationships",
    stem: "In 4,440, how many times greater is the 4 in the hundreds place than the 4 in the tens place?",
    answerType: "integer",
    answer: "10",
    // 400 vs 40 → 10 times. Each place is 10× the next.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "compare_multidigit",
    stem: "Which is greater, 89,999 or 90,000 — and by how much? Give how much greater the larger one is.",
    answerType: "integer",
    answer: "1",
    // Just 1 apart, even though every digit changes across the rollover.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expanded_form_multidigit",
    stem: "A number equals 20,000 + 500 + 7. What digit is in its thousands place?",
    answerType: "integer",
    answer: "0",
    // The number is 20,507 — the skipped thousands place is 0.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "round_multidigit",
    stem: "What is the largest whole number that still rounds to 7,000 when you round to the nearest thousand?",
    answerType: "integer",
    answer: "7499",
    // 7,499 rounds down to 7,000; 7,500 rounds up to 8,000.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "place_value_multidigit",
    stem: "In 66,666, how many times greater is the 6 in the ten-thousands place than the 6 in the tens place?",
    answerType: "integer",
    answer: "1000",
    // 60,000 vs 60 → 1000 times. Three places apart = ×10×10×10.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expanded_to_standard_form",
    stem: "Write the standard number for 7 × 1000 + 0 × 100 + 4 × 10 + 3.",
    answerType: "integer",
    answer: "7043",
    // The 0 hundreds is a placeholder → 7,043.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "number_name_to_standard",
    stem: "Write “six thousand forty” as a number.",
    answerType: "integer",
    answer: "6040",
    // No hundreds and no ones said → both are 0: 6,040.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "powers_of_ten",
    stem: "Multiply 100 × 1,000. How many zeros does the answer have?",
    answerType: "integer",
    answer: "5",
    // 100,000 has 5 zeros (2 zeros + 3 zeros).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "powers_of_ten",
    stem: "When you multiply a whole number by 10, you can just write a 0 on the end. Explain WHY that works using place value — and why 100 × 1,000 ends up with 5 zeros.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that multiplying by 10 shifts every digit one place to the left (each becomes worth ten times as much), so a 0 fills the empty ones place — in their own words.",
      "Explains that 100 (2 zeros) × 1,000 (3 zeros) shifts by 2 then 3 places, giving 5 zeros in all.",
    ],
  },

  // ══ WAVE 2 — geometry-measurement & the next ranked strands ════════════════
  // Same-idea-deeper go-deeper items: why a formula works, an invariant hiding
  // in plain sight, a surprising equivalence, a generalization. Kid-register
  // (grades 2-7), anti-deficit, one unambiguous server-verifiable answer each.

  // ── geometry-measurement / area-perimeter ───────────────────────────────
  {
    skillKey: "partition_rectangles_rows_cols",
    stem: "A rectangle is cut into equal squares. It has 3 rows, and there are 15 squares in all. How many columns does it have?",
    answerType: "integer",
    answer: "5",
    // 15 squares ÷ 3 rows = 5 in each row → 5 columns. Rows × columns is the array.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "area_unit_squares",
    stem: "Shape A is drawn on grid paper and covers exactly 12 unit squares. Shape B is made by cutting Shape A into a few pieces and rearranging them with no gaps or overlaps, so it looks completely different. What is Shape B's area, in square units?",
    answerType: "integer",
    answer: "12",
    // Cutting and rearranging adds and removes no squares, so area is conserved:
    // Shape B still covers 12 — the invariant behind every dissection area proof.
    technique: "invariant",
    bloomLevel: 5,
  },
  {
    skillKey: "perimeter_polygons",
    stem: "A square and an equilateral triangle have the same perimeter. The triangle's side is 8. How long is the square's side?",
    answerType: "integer",
    answer: "6",
    // Triangle perimeter = 3×8 = 24; square side = 24 ÷ 4 = 6. Same distance around.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "area_rectangle",
    stem: "Two rectangles have the same area. One is 4 by 6. The other is 3 units tall. How wide is the other one?",
    answerType: "integer",
    answer: "8",
    // Area = 24; the other is 24 ÷ 3 = 8 wide. Same area, traded-off sides.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "area_rectangle",
    stem: "A rectangle is 6 units long and 4 units wide. Explain why multiplying 6 × 4 gives its area — connect it to rows and columns of unit squares that cover the rectangle.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that the unit squares form 4 rows with 6 in each row (or 6 columns of 4) — in their own words.",
      "Connects that 6 × 4 counts all those equal squares at once, so it equals the area (24 square units).",
    ],
  },
  {
    skillKey: "area_distributive",
    stem: "A 6-by-13 rectangle is split into a 6-by-10 piece and a 6-by-3 piece. The 6-by-10 piece has area 60. What is the area of the whole rectangle?",
    answerType: "integer",
    answer: "78",
    // 60 + 6×3 = 60 + 18 = 78 = 6×13. The split areas add up.
    technique: "distributive",
    bloomLevel: 4,
  },
  {
    skillKey: "area_distributive",
    stem: "A rectangle is 8 tall and (5 + 2) wide. Explain why its area equals an 8×5 rectangle's area plus an 8×2 rectangle's area — and how that picture shows 8 × (5 + 2) = 8 × 5 + 8 × 2.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that a vertical cut splits the rectangle into an 8-by-5 part and an 8-by-2 part with no area lost or added — in their own words.",
      "Connects the two pieces to 8×5 and 8×2, so the whole area 8×(5+2) equals 8×5 + 8×2.",
    ],
  },
  {
    skillKey: "area_rectilinear_decompose",
    stem: "An L-shaped room is a full 6-by-5 rectangle with a 2-by-3 rectangle missing from one corner. Instead of splitting the L into two pieces and adding, find its area by starting from the whole 6-by-5 rectangle. What is the L's area, in square units?",
    answerType: "integer",
    answer: "24",
    // Bounding rectangle minus the hole: 6×5 − 2×3 = 30 − 6 = 24 — the subtract-a-
    // piece path a kid drilled to always ADD rectangles tends to miss.
    technique: "multiple_paths",
    bloomLevel: 4,
  },
  {
    skillKey: "area_perimeter_relationship",
    stem: "Two rectangles both have perimeter 20. One is 2 by 8, the other is 5 by 5. How much bigger is the square's area than the other rectangle's area?",
    answerType: "integer",
    answer: "9",
    // 5×5 = 25, 2×8 = 16, difference 9. Same perimeter, different area.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "perimeter_composite",
    stem: "A 10-by-8 rectangle has a small 3-by-3 square cut out of one corner, making an L-shape. What is the perimeter of the L-shape?",
    answerType: "integer",
    answer: "36",
    // Cutting a corner notch swaps two outer edges for two equal inner edges, so
    // the perimeter is UNCHANGED: 2×(10+8) = 36.
    technique: "invariant",
    bloomLevel: 5,
  },
  {
    skillKey: "area_perimeter_unknown_side",
    stem: "A rectangle has area 48 and one side of length 6. What is its perimeter?",
    answerType: "integer",
    answer: "28",
    // Other side = 48 ÷ 6 = 8; perimeter = 2×(6+8) = 28. Reverse the area formula first.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "area_word_problems",
    stem: "A 12-by-8 rug lies in the middle of a room, leaving a 1-unit strip of floor showing all the way around it. What is the area of the whole room, in square units?",
    answerType: "integer",
    answer: "140",
    // The border adds 1 on every side: room is (12+2) by (8+2) = 14×10 = 140.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "same_perimeter_optimize",
    stem: "A rectangle has whole-number sides and a perimeter of 20. What is the largest area it can have, in square units?",
    answerType: "integer",
    answer: "25",
    // Sides add to 10; the squarest split 5×5 = 25 beats 4×6=24, 3×7=21, … .
    technique: "extremal",
    bloomLevel: 4,
  },
  {
    skillKey: "same_perimeter_optimize",
    stem: "Among all rectangles with whole-number sides and perimeter 24, one has the biggest area. Explain which one it is and why making the two side lengths as equal as possible gives the most area.",
    answerType: "dialogue",
    answer: "",
    technique: "extremal",
    bloomLevel: 5,
    rubricCriteria: [
      "Identifies the 6-by-6 square (area 36) as the biggest — in their own words.",
      "Explains that a long thin rectangle wastes area: the closer the two sides are to equal, the larger the product/area (e.g. compares to 1×11, 2×10).",
    ],
  },
  {
    skillKey: "area_fraction_side",
    stem: "A rectangle is 3/4 of a unit wide and 2/3 of a unit tall. What is its area, in square units?",
    answerType: "fraction",
    answer: "1/2",
    // 3/4 × 2/3 = 6/12 = 1/2. Tiling fractional sides IS multiplying the fractions.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "area_parallelogram",
    stem: "A parallelogram has base 10 and height 4. A rectangle has length 10 and width 4. How much bigger is the rectangle's area than the parallelogram's area?",
    answerType: "integer",
    answer: "0",
    // Both are base × height = 40 — they're equal. Slanting doesn't change area.
    technique: "invariant",
    bloomLevel: 5,
  },
  {
    skillKey: "area_parallelogram",
    stem: "A parallelogram has base 8, height 5, and a slanted side of length 6. A friend says its area is 8 × 6 = 48. Explain why the area is really 8 × 5 = 40, using the idea of cutting a triangle off one end and sliding it to make a rectangle.",
    answerType: "dialogue",
    answer: "",
    technique: "error_analysis",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that area uses the perpendicular HEIGHT (5), not the slanted side (6) — in their own words.",
      "Describes cutting a right triangle off one end and sliding it to the other to form an 8-by-5 rectangle, showing the area is 40.",
    ],
  },
  {
    skillKey: "area_triangle",
    stem: "A triangle and a parallelogram share the same base of 8 and the same height of 6. The parallelogram's area is 48. What is the triangle's area?",
    answerType: "integer",
    answer: "24",
    // A triangle is half of a parallelogram with the same base and height: 48 ÷ 2 = 24.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "area_trapezoid",
    stem: "A trapezoid has parallel sides of 5 and 9 and a height of 4. A rectangle with the same height 4 has exactly the same area. How long is that rectangle?",
    answerType: "integer",
    answer: "7",
    // Trapezoid area = ((5+9)/2)×4 = 7×4 = 28; rectangle length = 28÷4 = 7 = the
    // AVERAGE of the two parallel sides.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "area_composite_polygons",
    stem: "A 10-by-6 rectangle has a right triangle cut off one corner. The triangle's two legs are 6 and 4. What area is left, in square units?",
    answerType: "integer",
    answer: "48",
    // 10×6 − (1/2)×6×4 = 60 − 12 = 48. Decompose: whole minus the triangle.
    technique: "structure",
    bloomLevel: 4,
  },

  // ── whole-number-arithmetic / number-theory ─────────────────────────────
  {
    skillKey: "prime_or_composite",
    stem: "There is exactly one even number that is prime. What is it?",
    answerType: "integer",
    answer: "2",
    // Every other even number has 2 as a factor, so 2 is the only even prime.
    technique: "casework",
    bloomLevel: 3,
  },
  {
    skillKey: "is_factor",
    stem: "7 is a factor of both 21 and 56. What is (21 + 56) ÷ 7?",
    answerType: "integer",
    answer: "11",
    // A factor of two numbers is a factor of their sum: 21/7 + 56/7 = 3 + 8 = 11
    // — no need to add to 77 first. Factors distribute over addition.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "is_multiple",
    stem: "Every multiple of 12 is also a multiple of some smaller numbers. Of these four — 2, 3, 4, 5 — how many is EVERY multiple of 12 always a multiple of?",
    answerType: "integer",
    answer: "3",
    // 12 = 2·2·3, so its multiples are always multiples of 2, 3, and 4 — but not 5.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "divisibility_rules_2_5_10",
    stem: "What is the largest 3-digit number that is divisible by BOTH 2 and 5?",
    answerType: "integer",
    answer: "990",
    // Divisible by 2 and 5 means divisible by 10 (ends in 0); the largest 3-digit one is 990.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "divisibility_rules_3_9",
    stem: "In the number 4⬜2, what single digit goes in the box to make the whole number divisible by 9?",
    answerType: "integer",
    answer: "3",
    // Digit sum 4+□+2 must be a multiple of 9; 6+3 = 9, and no other single digit works.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "divisibility_rules_3_9",
    stem: "There's a trick: a number is divisible by 9 exactly when its digits add up to a multiple of 9. Explain why adding the digits works — you can use 27 or another multiple of 9 to show your thinking.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that each place value (10, 100, …) is one more than a multiple of 9, so every digit contributes its face value plus a multiple of 9 — in their own words.",
      "Concludes that what's left over after the multiples of 9 is just the digit sum, so the number is divisible by 9 exactly when that sum is.",
    ],
  },
  {
    skillKey: "factor_pairs",
    stem: "Most numbers have an even number of factors, because factors pair up. What is the smallest whole number bigger than 1 that has an ODD number of factors?",
    answerType: "integer",
    answer: "4",
    // 4 has factors 1, 2, 4 — three of them. Its middle factor 2 pairs with itself
    // (2×2), so perfect squares have an odd factor count.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "factors_and_multiples",
    stem: "Which single whole number is a factor of 6 AND also a multiple of 6?",
    answerType: "integer",
    answer: "6",
    // Every number is both a factor of itself and a multiple of itself: 6.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "common_factors",
    stem: "The common factors of two numbers are exactly the factors of their greatest common factor. Two numbers have a GCF of 12. How many common factors do they share?",
    answerType: "integer",
    answer: "6",
    // Factors of 12: 1, 2, 3, 4, 6, 12 — six of them.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "prime_factorization",
    stem: "Written with primes, 72 = 2 × 2 × 2 × 3 × 3. What is the smallest whole number you can multiply 72 by so the result is a perfect square?",
    answerType: "integer",
    answer: "2",
    // 72 = 2³·3². A square needs EVERY prime's exponent even; only the 2 is odd,
    // so one more 2 fixes it: 72×2 = 144 = 12². The insight is exponent parity.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "prime_factorization",
    stem: "No matter how you start a factor tree for 36, you always end with the same primes. Explain why every whole number bigger than 1 has only ONE prime factorization — use 36 to show two different starts landing on the same primes.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Shows two different first splits of 36 (e.g. 4×9 and 6×6) both ending at 2 × 2 × 3 × 3 — in their own words.",
      "States that the set of primes (with their counts) comes out the same every time, so the prime factorization is unique.",
    ],
  },
  {
    skillKey: "common_multiples",
    stem: "The common multiples of two numbers are exactly the multiples of their least common multiple. Two numbers have an LCM of 6. How many common multiples do they have between 1 and 30?",
    answerType: "integer",
    answer: "5",
    // Multiples of 6 up to 30: 6, 12, 18, 24, 30 — five of them.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "exponents_repeated_mult",
    stem: "Which is bigger, 2⁵ or 5²? Give the bigger value.",
    answerType: "integer",
    answer: "32",
    // 2⁵ = 32, 5² = 25 — swapping base and exponent changes the value.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "exponents_repeated_mult",
    stem: "What is the ones digit of 2¹⁰ (that's ten 2s multiplied together)?",
    answerType: "integer",
    answer: "4",
    // Ones digits of powers of 2 cycle 2, 4, 8, 6 (length 4); 10 ≡ 2 (mod 4) → 4.
    technique: "invariant",
    bloomLevel: 4,
  },
  {
    skillKey: "gcf",
    stem: "For any two numbers, (their GCF) × (their LCM) equals the two numbers multiplied together. Two numbers have GCF 4 and LCM 24. What is the product of the two numbers?",
    answerType: "integer",
    answer: "96",
    // GCF × LCM = product → 4 × 24 = 96.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "lcm",
    stem: "Two gears start lined up. One clicks every 6 seconds, the other every 8 seconds. After how many seconds do they next click at the same moment?",
    answerType: "integer",
    answer: "24",
    // First shared moment is the LCM of 6 and 8: 24.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "remainder_cycles",
    stem: "A clock shows 10 o'clock now. What hour will it show 100 hours from now?",
    answerType: "integer",
    answer: "2",
    // Hours wrap every 12: 100 ≡ 4 (mod 12), so 10 + 4 = 14 → 2 o'clock.
    technique: "invariant",
    bloomLevel: 4,
  },
  {
    skillKey: "square_cube_numbers",
    stem: "What is the smallest whole number bigger than 1 that is BOTH a perfect square and a perfect cube?",
    answerType: "integer",
    answer: "64",
    // 64 = 8² = 4³ (it's 2⁶). The smallest such number above 1.
    technique: "structure",
    bloomLevel: 5,
  },

  // ── ratio-proportion-percent / ratios-rates ─────────────────────────────
  {
    skillKey: "ratio_concept_language",
    stem: "A fruit bowl has apples and oranges in the ratio 3 to 5 (apples to oranges). What fraction of the fruit is apples?",
    answerType: "fraction",
    answer: "3/8",
    // 3 parts apples out of 3+5 = 8 parts total → 3/8. Part-to-part becomes part-to-whole.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "ratio_part_part_to_whole",
    stem: "A necklace uses red and blue beads in the ratio 3 : 5. What fraction of all the beads are blue?",
    answerType: "fraction",
    answer: "5/8",
    // 5 blue parts out of 3+5 = 8 total parts → 5/8.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "ratio_order_matters",
    stem: "In a room the ratio of teachers to students is 1 to 20. A student says, \"So the ratio of students to teachers must also be 1 to 20.\" Explain what's wrong and give the correct students-to-teachers ratio.",
    answerType: "dialogue",
    answer: "",
    technique: "error_analysis",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that a ratio compares the quantities in a specific order, so reversing which comes first changes it — in their own words.",
      "Gives the correct reversed ratio as 20 to 1 (20 students for each teacher).",
    ],
  },
  {
    skillKey: "ratio_equivalent_scale",
    stem: "A paint mix is 2 cups blue to 3 cups yellow. You already poured a batch, then add 4 more cups of blue. How many cups of yellow must you add to keep the exact same shade?",
    answerType: "integer",
    answer: "6",
    // The ADDED paint must itself be 2:3. 4 blue is 2 lots of 2, so it needs 2 lots
    // of 3 = 6 yellow. (Adding equal amounts to both would change the shade.)
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "ratio_reduce",
    stem: "The ratios 12 : 18 and 20 : 30 look different. Reduce each to lowest terms — surprisingly they become the SAME ratio a : b. What is a + b?",
    answerType: "integer",
    answer: "5",
    // 12:18 ÷6 = 2:3; 20:30 ÷10 = 2:3. Both are 2:3 → 2 + 3 = 5. Different-looking
    // ratios can be equal — lowest terms is the shared fingerprint.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "ratio_table_complete",
    stem: "A ratio table has the columns (3, 12) and (5, 20). A friend adds the two columns straight down to get a new column (8, 32) and claims it is still part of the same ratio. Explain why adding any two columns of a ratio table always gives another correct column of the same ratio.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that every column has the same multiplier from its first entry to its second (here ×4), and adding column-to-column adds the firsts and adds the seconds — in their own words.",
      "Concludes that the summed column (8, 32) keeps that same ×4 relationship, so it belongs to the same ratio.",
    ],
  },
  {
    skillKey: "ratio_double_number_line",
    stem: "On a double number line, 4 pairs with 10, and 6 pairs with 15. Using just those two facts (no dividing to find a rate), what number pairs with 2?",
    answerType: "integer",
    answer: "5",
    // Subtract the two marks: 6 − 4 = 2 pairs with 15 − 10 = 5. The line's marks
    // add and subtract, so you never needed the unit rate.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "ratio_compare",
    stem: "Which juice mix tastes more orangey: 2 cups juice to 3 cups water, or 3 cups juice to 5 cups water? Answer with the juice-out-of-total fraction of the more-orangey mix.",
    answerType: "fraction",
    answer: "2/5",
    // Juice fractions: 2/5 = 0.40 vs 3/8 = 0.375; 2/5 is greater, so that mix is
    // more orangey. Compare on a common scale.
    technique: "benchmarks",
    bloomLevel: 5,
  },
  {
    skillKey: "rate_unit_whole_numbers",
    stem: "6 apples cost the same as 4 oranges. One apple costs 6 coins. What does one orange cost, in coins?",
    answerType: "integer",
    answer: "9",
    // Bridge through equal totals: 6 apples = 36 coins = 4 oranges → 36 ÷ 4 = 9.
    // Not a direct per-item scale — you route through the shared total.
    technique: "working_backward",
    bloomLevel: 5,
  },
  {
    skillKey: "rate_unit_price",
    stem: "A 6-pack of the same juice costs 18 coins; a 10-pack costs 25 coins. How many coins cheaper PER BOTTLE is the better deal?",
    answerType: "decimal",
    answer: "0.5",
    // 6-pack: 18÷6 = 3.00 each; 10-pack: 25÷10 = 2.50 each; the 10-pack is 0.5 cheaper each.
    technique: "benchmarks",
    bloomLevel: 5,
  },
  {
    skillKey: "rate_constant_speed",
    stem: "A train travels at a steady 60 miles per hour. How many miles does it cover in 40 minutes?",
    answerType: "integer",
    answer: "40",
    // 40 minutes is 40/60 = 2/3 of an hour; 60 × 2/3 = 40 miles.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "rate_measurement_conversion",
    stem: "There are 12 inches in a foot and 3 feet in a yard. How many inches LONGER is 3 yards than 100 inches?",
    answerType: "integer",
    answer: "8",
    // Convert to compare: 3 yd = 3×3×12 = 108 in; 108 − 100 = 8. The units must
    // match before the comparison means anything.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "rate_unit_fractional_quantities",
    stem: "A snail crawls 1/2 of a meter in 1/4 of an hour at a steady pace. How many meters does it crawl in one whole hour?",
    answerType: "integer",
    answer: "2",
    // 1/4 hour fits into 1 hour four times, so distance ×4: (1/2)×4 = 2 meters.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "ratio_forms",
    stem: "The ratio 12 : 8 is the same as 6 : 4 and as 3 : 2. Counting 12 : 8 itself, how many ways can you write this ratio using two whole numbers that are EACH 12 or less?",
    answerType: "integer",
    answer: "4",
    // Equivalent ratios are the whole-number multiples of the simplest form 3:2:
    // 3:2, 6:4, 9:6, 12:8 — four of them fit under 12. Beyond 3:2 the next is 15:10.
    technique: "structure",
    bloomLevel: 4,
  },

  // ── geometry-measurement / angles ───────────────────────────────────────
  {
    skillKey: "angle_concept",
    stem: "Two angles are drawn. One has short little rays; the other has long rays stretching across the page — but both open up by the same amount. Explain why they are the SAME size, and what actually decides an angle's size.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that an angle's size is the amount of turn (or the spread) between the two rays, not how long the rays are drawn — in their own words.",
      "Concludes that lengthening the rays doesn't change the opening, so the two angles are equal.",
    ],
  },
  {
    skillKey: "angle_turns_circle",
    stem: "The minute hand of a clock sweeps all the way around — a full 360° turn — in 60 minutes. How many degrees does it turn in just 10 minutes?",
    answerType: "integer",
    answer: "60",
    // 10 minutes is 10/60 of a full turn: 360 × 10/60 = 60°.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "benchmark_angles",
    stem: "An angle is bigger than a right angle but smaller than a straight angle. Of these measures — 45°, 90°, 120°, 180° — which one could it be?",
    answerType: "integer",
    answer: "120",
    // Between 90° (right) and 180° (straight) → 120° is the obtuse one that fits.
    technique: "casework",
    bloomLevel: 3,
  },
  {
    skillKey: "angle_classification",
    stem: "How many degrees are in an angle exactly halfway between a right angle and a straight angle?",
    answerType: "integer",
    answer: "135",
    // Halfway between 90° and 180° → (90+180)/2 = 135°.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "parallel_perpendicular_lines",
    stem: "Two different lines are each drawn perpendicular (at a right angle) to the same third line. Explain why those two lines must be parallel to each other.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that both lines make the same right angle with the shared line, so they point in the same direction — in their own words.",
      "Concludes that, heading the same way, the two lines never meet, which is what parallel means.",
    ],
  },
  {
    skillKey: "angle_additivity",
    stem: "Three angles sit side by side along a straight line, so together they make 180°. Two of them are 50° and 60°. What is the third angle?",
    answerType: "integer",
    answer: "70",
    // 180 − 50 − 60 = 70. The parts of a straight angle add to 180°.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "classify_triangles_sides",
    stem: "An isosceles triangle has two equal sides of length 7 and a third side of a different length. Its perimeter is 20. How long is the third side?",
    answerType: "integer",
    answer: "6",
    // Two equal sides give 14; 20 − 14 = 6 for the third side.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "classify_triangles_angles",
    stem: "A triangle's three angles always add to 180°. At most, how many of its angles can be right angles (exactly 90°)?",
    answerType: "integer",
    answer: "1",
    // Two right angles would already use 180°, leaving 0° for the third — impossible. So at most 1.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "classify_quadrilaterals",
    stem: "A shape has 4 sides, both pairs of opposite sides parallel, and 4 right angles. One friend calls it a rectangle; another calls it a parallelogram. Explain why BOTH names are correct.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that having both pairs of opposite sides parallel already makes it a parallelogram — in their own words.",
      "Explains that adding four right angles makes it a rectangle too, so a rectangle is a special parallelogram (both names fit).",
    ],
  },
  {
    skillKey: "quadrilateral_hierarchy",
    stem: "A square fits inside a family of shape names. Of these four names — square, rectangle, rhombus, parallelogram — how many correctly describe every square?",
    answerType: "integer",
    answer: "4",
    // A square has 4 right angles (rectangle), 4 equal sides (rhombus), and opposite
    // sides parallel (parallelogram) — all 4 names apply.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "angle_sum_triangle",
    stem: "A triangle has two equal angles, and its third angle is 80°. How many degrees is each of the two equal angles?",
    answerType: "integer",
    answer: "50",
    // The two equal angles share 180 − 80 = 100°, so each is 100 ÷ 2 = 50°.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "angle_sum_triangle",
    stem: "The three angles of any triangle always add to exactly 180°. Explain why — you can use the idea of tearing off the three corners and fitting them together along a straight line.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Describes tearing off the three corners and placing them side by side so they meet at one point — in their own words.",
      "Observes that the three corners together form a straight line (a straight angle), which is 180°, so the angles sum to 180°.",
    ],
  },

  // ── early-algebra / expressions-variables ───────────────────────────────
  {
    skillKey: "expr_grouping_symbols",
    stem: "Add one pair of parentheses to 12 − 4 − 2 to make the value as big as possible. What is that biggest value?",
    answerType: "integer",
    answer: "10",
    // 12 − (4 − 2) = 12 − 2 = 10, beating the plain 12 − 4 − 2 = 6.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_evaluate_numerical",
    stem: "What is the value of 20 − 2 × (3 + 4)?",
    answerType: "integer",
    answer: "6",
    // Parentheses first (3+4=7), then multiply (2×7=14), then subtract: 20 − 14 = 6.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_variable_meaning",
    stem: "In \"n + 5,\" the letter n can stand for lots of different numbers. But in \"□ + 3 = 7,\" the box stands for just one number. Explain the difference between a letter that VARIES and one that is a specific unknown.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that in n + 5 the letter can take many values, so the expression has many possible values — in their own words.",
      "Explains that □ + 3 = 7 pins the box to one value (4) because the equation must be true.",
    ],
  },
  {
    skillKey: "expr_terms_factors_coefficients",
    stem: "In the term 7x the coefficient is 7. In the term x, written all by itself with no number in front, what is its coefficient?",
    answerType: "integer",
    answer: "1",
    // x means 1·x, so the coefficient is the invisible 1 — the case kids overlook.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_translate_words",
    stem: "Work out the value of \"five less than three times four.\"",
    answerType: "integer",
    answer: "7",
    // "three times four" = 12, then "five less than" it = 12 − 5 = 7 (the words
    // flip the subtraction order).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_evaluate_one_variable",
    stem: "For what whole-number value of n does 2n + 1 equal 11?",
    answerType: "integer",
    answer: "5",
    // 2n = 10 → n = 5. Reverse the evaluation.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_evaluate_two_variables",
    stem: "The expression 3a + 2b equals 22 when a = 4 and b = 5. If you SWAP the values so a = 5 and b = 4, what does the expression equal now?",
    answerType: "integer",
    answer: "23",
    // 3×5 + 2×4 = 15 + 8 = 23 ≠ 22. Unequal coefficients mean swapping the values
    // changes the result — the expression isn't symmetric in a and b.
    technique: "structure",
    bloomLevel: 5,
  },
  {
    skillKey: "expr_evaluate_exponents",
    stem: "What is the value of 2 + 3²?",
    answerType: "integer",
    answer: "11",
    // The power comes first: 3² = 9, then 2 + 9 = 11 (not (2+3)² = 25).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_evaluate_fractions",
    stem: "Evaluate n² (that's n × n) when n = 1/2. Give your answer as a fraction.",
    answerType: "fraction",
    answer: "1/4",
    // (1/2) × (1/2) = 1/4 — squaring a fraction between 0 and 1 makes it smaller.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_distributive_numeric",
    stem: "Use the distributive property to compute 7 × 99 by thinking of it as 7 × 100 − 7. What is 7 × 99?",
    answerType: "integer",
    answer: "693",
    // 7×100 − 7×1 = 700 − 7 = 693.
    technique: "distributive",
    bloomLevel: 4,
  },
  {
    skillKey: "expr_evaluate_formulas",
    stem: "The perimeter of a rectangle is given by the formula P = 2 × (l + w). A rectangle has perimeter 20 and length 7. Use the formula to find its width.",
    answerType: "integer",
    answer: "3",
    // Run the formula backward: 2×(7+w) = 20 → 7+w = 10 → w = 3.
    technique: "working_backward",
    bloomLevel: 5,
  },
  {
    skillKey: "expr_multi_step_signed",
    stem: "Evaluate 2 × (x − 3) + 4 when x = −1.",
    answerType: "integer",
    answer: "-4",
    // x − 3 = −4; 2 × (−4) = −8; −8 + 4 = −4.
    technique: "structure",
    bloomLevel: 5,
  },

  // ── whole-number-arithmetic / counting (K — kept only where a genuine
  //    same-idea-deeper 'ooh' clears the bar; drill-only nodes are skipped) ──
  {
    skillKey: "count_to_100_tens",
    stem: "Counting by tens — 10, 20, 30 … — how many tens do you say to get from 0 all the way to 100?",
    answerType: "integer",
    answer: "10",
    // Ten tens make one hundred: 10, 20, …, 100 is 10 numbers.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "count_to_100_ones",
    stem: "Counting from 1 to 100, how many of the numbers you say END in a zero?",
    answerType: "integer",
    answer: "10",
    // 10, 20, 30, …, 100 → exactly 10 of them end in 0.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "count_on",
    stem: "Instead of starting at 1, count forward from 7 up to 12: 8, 9, 10, 11, 12. How many numbers did you say?",
    legacyStems: [
      "Instead of starting at 1, count ON from 7 up to 12: 8, 9, 10, 11, 12. How many numbers did you say?",
    ],
    answerType: "integer",
    answer: "5",
    // Counting on from 7 to 12 is the distance 12 − 7 = 5.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "compare_within_10",
    stem: "Ana has more stickers than Bo, and Bo has more stickers than Cy. Explain how you can be sure Ana has more stickers than Cy, without ever counting Cy's.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that Ana sits above Bo, and Bo sits above Cy, on the 'how many' order, so Ana must sit above Cy too — in their own words.",
      "States the general idea: 'more than' carries along a chain (if A > B and B > C then A > C), so Cy never needs counting.",
    ],
  },
  {
    skillKey: "count_objects_within_20",
    stem: "There are 14 buttons in a row. You count them left to right and get 14. If you count the very same buttons right to left instead, how many will you get?",
    answerType: "integer",
    answer: "14",
    // The count of a set doesn't depend on the order you count in — still 14.
    technique: "invariant",
    bloomLevel: 3,
  },
  {
    skillKey: "cardinality_within_10",
    stem: "You count a row of blocks starting from the left: 1, 2, 3, 4, 5 — so there are 5. Your friend counts the SAME blocks starting from the right and also ends on 5. Explain why the last number you say is 5 no matter which end you start from.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that every block gets counted exactly once whichever way you go, so no block is added or missed — in their own words.",
      "Concludes that the last number said is the total amount of blocks, and that total (5) doesn't change with the starting end.",
    ],
  },

  // ══ WAVE 3 — fraction-arithmetic Go-deeper coverage ═══════════════════════
  // Insight problems across every fraction-arithmetic strand still below the
  // 50%-stretch bar (operations first, then equivalence, comparison, concept,
  // decimals). Each item takes a FRACTION IDEA a well-drilled kid can miss —
  // why common denominators work, multiplication that makes things smaller,
  // division-as-how-many-fit, an equivalence invariant, unit-fraction
  // reasoning — never a bigger number. Kid-register (grades 1-6), anti-deficit.
  // No operations node needed skipping: each cleared the structure-over-drill
  // 'ooh' bar. Drill-only shells with no genuine same-idea-deeper angle simply
  // aren't listed here.

  // ── fraction-arithmetic / operations ────────────────────────────────────
  {
    skillKey: "add_subtract_like",
    stem: "What is 1/7 + 2/7 + 3/7 + 4/7 + 5/7 + 6/7?",
    answerType: "integer",
    answer: "3",
    // Same-size pieces, so just count sevenths: 1+2+3+4+5+6 = 21 sevenths =
    // 21/7 = 3. (Pair them 1+6, 2+5, 3+4 → three whole 7/7s.)
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "add_subtract_like",
    stem: "A fraction with denominator 12 is added to 5/12 and the total is exactly 1. What is that fraction?",
    answerType: "fraction",
    answer: "7/12",
    // A whole is 12/12; 12/12 − 5/12 = 7/12. Complement to one whole.
    technique: "working_backward",
    bloomLevel: 4,
  },
  // (review cut: the "fifths to the next whole" complement item was a
  // one-step drill in stretch clothing — deleted, skipped beats sub-bar.)
  {
    skillKey: "add_subtract_mixed_like",
    stem: "To work out 4 1/6 − 1 5/6 a friend subtracts the wholes and the sixths separately and writes 3 and −4/6, then gets stuck. Explain what went wrong, and show any way you like to finish the problem correctly — then give the answer.",
    answerType: "dialogue",
    answer: "",
    technique: "error_analysis",
    bloomLevel: 5,
    rubricCriteria: [
      "Identifies that you can't take 5/6 from 1/6, so a negative −4/6 appears — subtracting the parts separately breaks down here.",
      // Method-agnostic: ANY mathematically valid completion counts —
      // borrowing (4 1/6 → 3 7/6), converting both to improper fractions
      // (25/6 − 11/6), or even interpreting 3 − 4/6 correctly as 3 minus
      // 4/6. A rubric must never mandate one method.
      "Shows one valid way to finish — e.g. borrowing a whole as 6/6 (3 7/6 − 1 5/6), converting to improper fractions (25/6 − 11/6), or resolving 3 − 4/6 — explained in their own words.",
      "Gives the correct answer 2 2/6 (or the equivalent 2 1/3).",
    ],
  },
  {
    skillKey: "decompose_fraction",
    stem: "In how many ways can you write 7/8 as a sum of two eighths-fractions with positive whole-number tops (like 1/8 + 6/8), if the order of the two parts doesn't matter?",
    answerType: "integer",
    answer: "3",
    // Tops must be positive and add to 7 with a ≤ b: (1,6)(2,5)(3,4) → 3 ways.
    technique: "casework",
    bloomLevel: 4,
  },
  {
    skillKey: "decompose_fraction",
    stem: "3/4 is broken into two quarter-fractions, a/4 + b/4, where a and b are positive whole numbers and a is twice as big as b. What is a?",
    answerType: "integer",
    answer: "2",
    // a + b = 3 and a = 2b → 2b + b = 3 → b = 1, a = 2.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "multiply_fraction_by_whole",
    stem: "What whole number times 3/8 gives exactly 3?",
    answerType: "integer",
    answer: "8",
    // n × 3/8 = 3 → n × 3 = 24 → n = 8. (Eight lots of 3/8 make 24/8 = 3.)
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "multiply_fraction_by_whole",
    stem: "Kayla multiplies a whole number bigger than 0 by 5/6, and for the first time the answer is a whole number. What whole number did she use?",
    answerType: "integer",
    answer: "6",
    // n × 5/6 is whole only when 6 divides n; the smallest such n is 6 (→ 5).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "divide_unit_fractions",
    stem: "How many 1/4s are in 3?",
    answerType: "integer",
    answer: "12",
    // Division as how-many-fit: 3 ÷ 1/4 — each whole holds four quarters, so 12.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "divide_unit_fractions",
    stem: "Dividing 2 by 1/3 gives 6 — a BIGGER number than the 2 you started with, even though it's division. Explain why 2 ÷ 1/3 counts how many thirds fit into 2, and why that makes the answer come out bigger than 2.",
    answerType: "dialogue",
    answer: "",
    technique: "multiple_paths",
    bloomLevel: 5,
    rubricCriteria: [
      "Reframes 2 ÷ 1/3 as 'how many 1/3-pieces fit into 2', not 'split 2 into 3', in their own words.",
      "Explains that each whole holds three thirds, so 2 wholes hold 6 — and that dividing by a piece smaller than 1 gives an answer bigger than the starting number.",
    ],
  },
  {
    skillKey: "fraction_scaling",
    stem: "Without doing the multiplication: is 7/8 × 5/6 bigger than 5/6, smaller than 5/6, or equal to it? Answer 1 for bigger, 2 for smaller, 3 for equal.",
    answerType: "integer",
    answer: "2",
    // Multiplying by 7/8 (a factor less than 1) scales 5/6 DOWN → smaller.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "fraction_scaling",
    stem: "A classmate says 'multiplying always makes a number bigger.' Explain why that's not true, using 12 × 1/2 and 12 × 3/2 to show when a product ends up smaller, the same, or bigger than 12.",
    answerType: "dialogue",
    answer: "",
    technique: "error_analysis",
    bloomLevel: 5,
    rubricCriteria: [
      "Computes 12 × 1/2 = 6 (smaller) and 12 × 3/2 = 18 (bigger), and notes 12 × 1 would be 12 (the same).",
      "Generalizes: multiplying by a factor less than 1 shrinks, equal to 1 keeps it, greater than 1 grows it — in their own words.",
    ],
  },
  {
    skillKey: "divide_fractions",
    stem: "How many 3/4-cup scoops does it take to fill a 6-cup container exactly?",
    answerType: "integer",
    answer: "8",
    // 6 ÷ 3/4 = 6 × 4/3 = 8. Division as how-many-fit.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "divide_fractions",
    stem: "Explain why dividing a number by 1/2 gives the same result as multiplying it by 2 — using 'how many halves fit', not the flip-and-multiply rule.",
    answerType: "dialogue",
    answer: "",
    technique: "multiple_paths",
    bloomLevel: 5,
    rubricCriteria: [
      "Reframes 'divide by 1/2' as 'how many 1/2-pieces fit', and observes each whole holds two halves — in their own words.",
      "Concludes that counting the halves in n wholes gives 2n, which is exactly n × 2, so dividing by 1/2 equals doubling.",
    ],
  },

  // ── fraction-arithmetic / equivalence ────────────────────────────────────
  {
    skillKey: "common_denominators",
    stem: "What is the smallest number that works as a common denominator for 1/6 and 1/4?",
    answerType: "integer",
    answer: "12",
    // Smallest number both 6 and 4 divide is LCM(6,4) = 12 (not 6×4 = 24).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "common_denominators",
    stem: "To add 1/3 + 1/4 you first rewrite them as 4/12 and 3/12. Explain why you're allowed to change 1/3 into 4/12 in the middle of the problem, and why you can't just add across the tops and bottoms to get 2/7.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that 1/3 and 4/12 name the same amount (multiplying top and bottom by 4 doesn't change the value), so the rewrite is legal.",
      "Explains that you can only add fractions once the pieces are the SAME size (same denominator); adding across to 2/7 mixes unequal pieces and is wrong.",
    ],
  },
  {
    skillKey: "simplify_fractions",
    stem: "A fraction simplifies to 2/3. Its numerator is 14. What is its denominator?",
    answerType: "integer",
    answer: "21",
    // 2/3 = 14/21 (multiply top and bottom by 7). Denominator 21.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "equivalent_fractions_visual",
    stem: "On a fraction wall, the 1/2 bar lines up exactly with a whole number of twelfths. How many twelfths equal 1/2?",
    answerType: "integer",
    answer: "6",
    // 1/2 = 6/12 — six of the twelve equal pieces reach halfway.
    technique: "structure",
    bloomLevel: 3,
  },

  // ── fraction-arithmetic / comparison ─────────────────────────────────────
  {
    skillKey: "compare_same_numerator",
    stem: "The fractions 3/4, 3/5, 3/7, and 3/10 all have the top number 3. Which denominator gives the LARGEST fraction?",
    answerType: "integer",
    answer: "4",
    // Same count of pieces; the fewer the pieces the whole is cut into, the
    // bigger each piece — so the smallest denominator, 4, wins.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "compare_same_denominator",
    // Replaces a one-step "read the numerator" drill (review cut): this one
    // needs a conversion to a common denominator BEFORE the same-denominator
    // comparison does any work — the skill's idea, one level up.
    stem: "How many ninths sit strictly between 1/3 and 2/3?",
    answerType: "integer",
    answer: "2",
    // 1/3 = 3/9 and 2/3 = 6/9, so the ninths strictly between are 4/9 and
    // 5/9 — two of them.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "compare_benchmarks",
    stem: "How many of these five fractions are greater than 1:  5/4,  3/7,  8/8,  9/5,  2/3?",
    answerType: "integer",
    answer: "2",
    // Compare each top to its bottom: 5/4 > 1 and 9/5 > 1; 8/8 = 1 (not more),
    // 3/7 and 2/3 < 1. Two of them.
    technique: "benchmarks",
    bloomLevel: 3,
  },
  {
    skillKey: "order_fractions",
    stem: "Put 2/3, 3/4, and 5/6 in order from smallest to largest. Which one is in the middle?",
    answerType: "fraction",
    answer: "3/4",
    // Over twelfths: 8/12, 9/12, 10/12 → the middle is 9/12 = 3/4.
    technique: "structure",
    bloomLevel: 4,
  },

  // ── fraction-arithmetic / concept ────────────────────────────────────────
  {
    skillKey: "unit_fraction",
    stem: "Explain why 1/8 is a SMALLER piece than 1/3, even though 8 is a bigger number than 3 — use the idea of cutting the same cake into more pieces.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 4,
    rubricCriteria: [
      "Explains that a bigger bottom number means the whole is cut into MORE pieces, so each piece is smaller — in their own words.",
      "Concludes that cutting a cake into 8 gives thinner slices than cutting it into 3, so 1/8 < 1/3.",
    ],
  },
  {
    skillKey: "whole_as_fraction",
    stem: "The whole number 3 can be written as a fraction with denominator 5. What is its numerator?",
    answerType: "integer",
    answer: "15",
    // 3 wholes = 15 fifths (each whole is 5/5), so 3 = 15/5.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "fraction_number_line",
    stem: "On a number line, what fraction sits exactly halfway between 0 and 1/2?",
    answerType: "fraction",
    answer: "1/4",
    // Halfway to 1/2 is 1/4 (half of a half).
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "mixed_improper",
    stem: "How many thirds are there in 2 1/3?",
    answerType: "integer",
    answer: "7",
    // Each whole is 3/3, so 2 wholes = 6 thirds, plus 1 more third = 7 thirds.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "fraction_as_parts",
    stem: "You have 7 copies of 1/4. That's more than one whole. After you make as many wholes as you can, how many quarters are left over?",
    answerType: "integer",
    answer: "3",
    // 7 fourths = 1 whole (4 fourths) + 3 fourths left → 7/4 = 1 3/4.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "partition_shapes",
    stem: "A rectangle is cut into 4 equal pieces and you shade 1 of them. Then someone cuts EVERY piece in half. How many of the new smaller pieces are shaded now?",
    answerType: "integer",
    answer: "2",
    // 1/4 = 2/8: the shaded amount is unchanged, but it's now 2 of the 8 pieces.
    technique: "structure",
    bloomLevel: 3,
  },

  // ── fraction-arithmetic / decimals (a decimal IS a fraction) ─────────────
  {
    skillKey: "decimal_notation_fractions",
    stem: "0.5, 5/10, and 1/2 all name the same amount. Written as a fraction in lowest terms, what is its denominator?",
    answerType: "integer",
    answer: "2",
    // 0.5 = 5/10 = 1/2; lowest-terms denominator is 2.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "compare_decimals",
    stem: "A friend says 0.45 must be bigger than 0.5 because 45 is bigger than 5. Explain why 0.5 is actually the bigger number.",
    answerType: "dialogue",
    answer: "",
    technique: "error_analysis",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains that decimal places have values (tenths, hundredths), so you compare tenths first — not the length of the digit string.",
      "Shows 0.5 = 0.50 = 50 hundredths versus 0.45 = 45 hundredths, so 0.5 is bigger — in their own words.",
    ],
  },
  {
    skillKey: "decimal_place_value_round",
    stem: "Rounded to the nearest tenth, some hundredths round down to 0.4 and others round up to 0.5. What is the LARGEST hundredths value that still rounds down to 0.4?",
    answerType: "decimal",
    answer: "0.44",
    // 0.45 rounds up to 0.5; the largest that rounds down is 0.44.
    technique: "working_backward",
    bloomLevel: 4,
  },
  {
    skillKey: "add_subtract_decimals",
    stem: "What is 0.9 + 0.09 + 0.009?",
    answerType: "decimal",
    answer: "0.999",
    // Each addend lands in its own place (tenths, hundredths, thousandths) —
    // nothing carries, so the digits stack to 0.999.
    technique: "structure",
    bloomLevel: 3,
  },
  {
    skillKey: "multiply_decimals",
    stem: "0.3 × 0.2 = 0.06. Explain why the answer has TWO decimal places, and why it turns out SMALLER than both of the numbers you multiplied.",
    answerType: "dialogue",
    answer: "",
    technique: "structure",
    bloomLevel: 5,
    rubricCriteria: [
      "Explains the two decimal places as tenths × tenths = hundredths (one place plus one place), i.e. 3/10 × 2/10 = 6/100.",
      "Explains that multiplying by 0.2 (a factor less than 1) scales the number down, so the product is smaller than both factors — in their own words.",
    ],
  },
  {
    skillKey: "divide_decimals",
    stem: "How many 0.25s are in 2?",
    answerType: "integer",
    answer: "8",
    // 0.25 = 1/4; four quarters per whole → 2 ÷ 0.25 = 8. How-many-fit.
    technique: "structure",
    bloomLevel: 4,
  },

  // ── WAVE 4 — algebra-1 APPLICATION lane (linear-equations, linear-functions)
  //
  // Measured on prod: the algebra-1 domain's `linear-equations` and
  // `linear-functions` strands were 100% symbolic drill — every node had a
  // deterministic template, zero stored items, and the whole domain carried
  // only 3 stretch items (all story-carried, in storyRegistry.ts). A teacher
  // asked for word problems "to see if he can apply the math." These are that:
  // one genuine APPLICATION per node — a real person, in a real situation, who
  // needs THIS algebra for an answer they actually want — authored against
  // review/applications-authoring-bar.html (the A1–A6 do-ability gates), NOT
  // the story ⭐ wonder bar. Unlike the retrofit corpus in storyRegistry.ts,
  // algebra-1 has ZERO story edges, so these are PLAIN stretch items with no
  // storyToKey (applicationEligibility.isOptionalDepthItemEligible supports
  // that path); they surface in the ordinary "Go deeper" tail on a fluent node.
  // Favor interpret-the-result (S5) and spot-the-error (S6) over the thin
  // costume-equation templates (`lin_eq_model_context` "a gym charges…",
  // `lin_fn_interpret_context` "what does 25 represent") they beat. Authored via
  // a two-family tournament + adversarial pseudocontext/blind-solve gates; 8 of
  // the 20 scoped nodes returned REJECT-ALL (a skipped node beats a costume).

  // ── linear-equations ────────────────────────────────────────────────────
  {
    skillKey: "lin_ineq_multi_step",
    stem: "A research grant has $8,000 left, fieldwork costs $650 per week, and the team must keep at least $2,000 in reserve, so 8000 − 650w ≥ 2000. A student divides both sides by −650 without changing the inequality sign and concludes the team can work at least 10 weeks. What is the actual greatest whole number of weeks the team can do fieldwork?",
    answerType: "integer",
    answer: "9",
    // 8000 − 650w ≥ 2000 → 6000 ≥ 650w → w ≤ 9.23…, so at most 9 whole weeks.
    // Dividing by the negative −650 must REVERSE the inequality; the student
    // forgot, flipping "at most 9" into "at least 10". The sign reversal is the
    // whole point.
    technique: "sign_reversal",
    bloomLevel: 4,
  },
  {
    skillKey: "lin_ineq_compound",
    stem: "On a calibration bench, a sensor shows a reading of 2d + 5 when a technician sets a whole-number dial to position d. The sensor is in spec only when its reading is between 17 and 29, inclusive. To judge how much adjustment room there is, the technician wants to know how many whole dial positions keep the sensor in spec. How many are there?",
    answerType: "integer",
    answer: "7",
    // 17 ≤ 2d + 5 ≤ 29 → 12 ≤ 2d ≤ 24 → 6 ≤ d ≤ 12. Integer positions 6..12 →
    // 12 − 6 + 1 = 7. The whole solution set (both bounds) is load-bearing.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "lin_eq_model_context",
    stem: "During a drought, the water level in a town's well is modeled by L = 200 − 2.5d, where L is the level in centimeters above a marker stone and d is the number of days into the drought. The town must begin rationing on the day the level first reaches the marker. On what day does the model say rationing begins?",
    answerType: "integer",
    answer: "80",
    // "Reaches the marker" means L = 0: 200 − 2.5d = 0 → 2.5d = 200 → d = 80.
    // The context supplies the model and what the trigger event (L = 0) means —
    // the bare number 200/2.5 says neither.
    technique: "modeling",
    bloomLevel: 4,
  },

  // ── linear-functions ──────────────────────────────────────────────────────
  {
    skillKey: "fn_identify_function",
    stem: "A database designer for a school's records must decide which lookups are safe to store as a single-value rule and which need a full list, so she checks whether each lookup's output is completely determined by its input. Assume each student has exactly one homeroom and one birthday, while any homeroom or birthday is shared by many students. For how many of these four lookups is the output completely determined by the input: (1) student → their homeroom, (2) homeroom → a student in it, (3) student → their birthday, (4) birthday → a student born that day?",
    answerType: "integer",
    answer: "2",
    // A lookup is a function when each input has exactly one output. (1) yes and
    // (3) yes (one homeroom, one birthday per student); (2) no and (4) no (a
    // homeroom/birthday is shared, so the input maps to many students). Count 2.
    // The insight — a shared OUTPUT is fine, a split INPUT is not, so direction
    // matters — is exactly what makes a database key.
    technique: "structure",
    bloomLevel: 4,
  },
  {
    skillKey: "slope_two_points",
    stem: "A hiker's watch logged her elevation as 1,850 m at 9:00 and 2,090 m at 11:00. A friend estimates her climbing rate as 2,090 ÷ 2 = 1,045 meters per hour. Assuming she climbed at a steady rate, what was her actual climbing rate in meters per hour?",
    answerType: "integer",
    answer: "120",
    // Slope = rise/run = (2090 − 1850)/(11 − 9) = 240/2 = 120. The friend divided
    // the final elevation instead of the CHANGE — the classic slope error.
    technique: "error_analysis",
    bloomLevel: 4,
  },
  {
    skillKey: "lin_fn_from_two_points",
    stem: "A rideshare driver notices her app's running total was $47 after 10 trips and $110 after 25 trips one evening. If her earnings rise at a steady rate per trip, what total should the app show after 40 trips?",
    answerType: "integer",
    answer: "173",
    // Rate = (110 − 47)/(25 − 10) = 63/15 = 4.2 per trip. Line: earnings =
    // 4.2·trips + 5 (since 47 = 4.2·10 + 5). At 40 trips: 4.2·40 + 5 = 173. Two
    // points determine the whole line, then extrapolate.
    technique: "interpolate",
    bloomLevel: 4,
  },
  {
    skillKey: "lin_fn_standard_form",
    stem: "A trip organizer has exactly $105 for a group's theater tickets. Adult tickets cost $15 and child tickets cost $9, so the spending fits 15a + 9c = 105. She needs at least one adult to chaperone and wants to bring as many children as possible. What is the greatest number of child tickets she can buy?",
    answerType: "integer",
    answer: "10",
    // On the standard-form budget line 15a + 9c = 105, whole-number solutions are
    // a = 1 → c = 10, a = 4 → c = 5, a = 7 → c = 0. Maximizing c means the
    // smallest allowed a (a = 1, one chaperone) → c = 10. Reading the constraint
    // line and its integer points is the standard-form skill.
    technique: "casework",
    bloomLevel: 4,
  },
  {
    skillKey: "lin_fn_interpret_context",
    stem: "A physical therapist models a patient's walking distance as d = 50 + 20w meters, where w is the number of weeks into recovery. The patient wants to know how far she should be walking after 5 weeks, and reasons: \"20 meters a week times 5 weeks is 100 meters.\" According to the model, what distance will she actually be walking after 5 weeks?",
    answerType: "integer",
    answer: "150",
    // d = 50 + 20·5 = 150. The patient multiplied the slope (20/week) by the time
    // but forgot to add the intercept (50, her starting distance) — the classic
    // "forget the baseline" extrapolation error. Both parameters are load-bearing.
    technique: "error_analysis",
    bloomLevel: 4,
  },
  {
    skillKey: "fn_compare_representations",
    stem: "Two savings plans start at the same time and each grows at a steady rate. Plan A is given by the equation b = 15w + 40, where b is dollars saved after w weeks. Plan B is shown in a table: at week 0 it holds $100, and at week 2 it holds $124. After how many weeks do the two plans hold the same amount?",
    answerType: "integer",
    answer: "20",
    // Read Plan B from the table: rate = (124 − 100)/2 = 12/week, start 100, so
    // b = 12w + 100. Set equal to Plan A: 15w + 40 = 12w + 100 → 3w = 60 → w = 20.
    // The table must be turned into an equation before the two can be compared.
    technique: "structure",
    bloomLevel: 5,
  },
];

/** Insert the curated stretch items (idempotent on (skillKey, stem)); updates
 *  known legacy stems in place and reports nodes missing from the deployment. */
export const seedStretchItems = internalMutation({
  args: {},
  handler: async (ctx) => {
    let inserted = 0;
    let updated = 0;
    let skippedExisting = 0;
    const missingNodes: string[] = [];
    for (const item of STRETCH_SEED_ITEMS) {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", item.skillKey))
        .first();
      if (!node) {
        missingNodes.push(item.skillKey);
        continue;
      }
      const rows = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", item.skillKey))
        .collect();
      const currentRows = rows.filter((row) => row.stem === item.stem);
      const legacyStems = item.legacyStems;
      if (legacyStems?.length) {
        const legacyRows = rows.filter((row) => legacyStems.includes(row.stem));
        if (legacyRows.length) {
          for (const legacy of legacyRows) {
            await ctx.db.patch(legacy._id, { stem: item.stem });
            updated++;
          }
          continue;
        }
      }
      if (currentRows.length) {
        skippedExisting++;
        continue;
      }
      const isDialogue = item.answerType === "dialogue";
      await ctx.db.insert("practiceItems", {
        skillKey: item.skillKey,
        domain: node.domain,
        stem: item.stem,
        answerType: item.answerType,
        answerCanonical: item.answer,
        verifierKind: isDialogue ? "rubric_dialogue" : "arithmetic",
        tier: "stretch",
        technique: item.technique,
        bloomLevel: item.bloomLevel,
        ...(isDialogue ? { rubricCriteria: item.rubricCriteria ?? [] } : {}),
        source: "authored",
        verifiedAt: Date.now(),
      });
      inserted++;
    }
    return { inserted, updated, skippedExisting, missingNodes };
  },
});
