/**
 * Socratic practice hints — a nudge toward a STRATEGY, never the answer. This
 * is the homegrown engine's pedagogical edge over a drill app: the tutor method
 * (challenge, withhold the answer) shows up even in fluency practice. Keyed by
 * skill-key prefix; falls back to a general "what does the question ask?" nudge.
 *
 * ORDER MATTERS — this is a first-match-wins list. Fraction and equation-property
 * skills are matched BEFORE the whole-number `add_`/`compare_`/`mult_` prefixes,
 * because those prefixes would otherwise hand a fraction (e.g. `add_subtract_like`,
 * `compare_same_denominator`) or a property fill-in (`add_subtract_properties`) a
 * place-value/tens-and-ones strategy that doesn't fit the question.
 */

const HINTS: { match: (key: string) => boolean; hint: string }[] = [
  // ── Counting: a "how many are here?" set (cardinality) vs. a "what comes
  //    next?" sequence. count_objects_* are cardinality items ("How many dots?"),
  //    so they must be caught before the generic count_ sequence matcher below. ──
  { match: (k) => k.startsWith("cardinality") || k.startsWith("count_objects"), hint: "Touch each dot once as you count. The last number you say is how many." },
  { match: (k) => k.startsWith("count_"), hint: "Say the numbers out loud in order — what comes right after?" },

  // ── Fractions — matched before the whole-number compare_/add_ prefixes ──
  { match: (k) => k === "add_subtract_like", hint: "The bottoms already match, so keep that same bottom number and just add or subtract the tops." },
  { match: (k) => k === "add_subtract_unlike", hint: "The bottoms are different — rewrite both fractions with a common denominator first, then add or subtract the tops." },
  { match: (k) => k === "compare_same_denominator", hint: "The pieces are the same size here, so the fraction with the bigger top number is the greater one." },
  { match: (k) => k === "compare_same_numerator", hint: "Same number of pieces on top, but a bigger bottom means smaller pieces — so the bigger denominator makes the smaller fraction." },
  { match: (k) => k === "compare_benchmarks", hint: "Compare each fraction to one half: is the top more or less than half of the bottom?" },
  { match: (k) => k === "compare_unlike", hint: "Give both fractions the same bottom number first (or cross-multiply), then compare the new tops." },
  { match: (k) => k === "mixed_improper", hint: "Turn each whole into pieces of the same size — the bottom number tells how many pieces per whole — then count every piece, including the extra ones on top." },

  { match: (k) => k.startsWith("compare_"), hint: "Compare the biggest place value first. Which number has more there?" },
  { match: (k) => k === "compose_ten", hint: "How many more do you need to reach a full ten?" },
  { match: (k) => k.startsWith("skip_count"), hint: "How much is added each step? Keep adding that same amount." },
  { match: (k) => k.startsWith("ten_more_ten_less"), hint: "Only the tens digit changes — by one ten." },
  { match: (k) => k.includes("tens_in") || k === "tens_ones_to_99" || k === "hundreds_tens_ones", hint: "Think about how the number is built from hundreds, tens, and ones." },

  // ── Equation-property fill-ins — matched before the add_/mult_ prefixes ──
  { match: (k) => k === "add_subtract_properties", hint: "The same numbers appear on both sides, just grouped differently — and adding or subtracting 0 leaves a number unchanged. What keeps both sides equal?" },
  { match: (k) => k === "mult_commutative_associative", hint: "The same numbers appear on both sides, just reordered or regrouped. What value makes both sides equal?" },
  { match: (k) => k === "mult_distributive", hint: "The number outside the parentheses multiplies each part inside. You already have one part — multiply the outside number by the other number being added." },

  { match: (k) => k.startsWith("add_") && k.includes("regroup"), hint: "Add the ones first. If they make ten or more, carry a ten to the next column." },
  { match: (k) => k.startsWith("add_"), hint: "Try adding the tens first, then the ones." },
  { match: (k) => k.startsWith("subtract_"), hint: "If the top digit is smaller, you may need to borrow from the next place." },
  { match: (k) => k.startsWith("mult_facts"), hint: "Skip-count by one of the numbers, or use a fact you already know nearby." },
  { match: (k) => k.startsWith("mult_"), hint: "Break one number into tens and ones, multiply each part, then add." },
  { match: (k) => k.startsWith("division"), hint: "Ask: how many of the smaller number fit into the bigger one?" },
  { match: (k) => k === "exponents_repeated_mult" || k.startsWith("exponents_"), hint: "An exponent tells how many times to multiply the base by itself. For n³, think n times n times n." },
  { match: (k) => k.startsWith("round_"), hint: "Look at the digit just to the right of the place you're rounding to: 5 or more rounds up." },
  { match: (k) => k === "order_of_operations" || k === "two_step_expressions", hint: "Do the multiplication and division first, then the addition and subtraction." },
  // PR4 — 4th-grade-edge densification
  { match: (k) => k === "place_value_relationships" || k === "powers_of_ten", hint: "Each place is worth 10 times the place to its right. Count how many places apart they are." },
  { match: (k) => k.startsWith("expanded_"), hint: "Each part names one digit's place value. Put the digits back where they belong (or add the parts up)." },
  { match: (k) => k === "number_name_to_standard", hint: "Break the words into thousands, hundreds, tens, and ones, then write each digit in its place." },
  { match: (k) => k === "gcf", hint: "GCF means greatest common factor. List the factors of each number, then choose the biggest one they share." },
  { match: (k) => k === "lcm", hint: "LCM means least common multiple. Skip-count the multiples of each number, then find the smallest one they both reach." },
  { match: (k) => k === "factor_pairs" || k === "is_factor" || k === "common_factors", hint: "A factor divides the number evenly, with no remainder. Try dividing and see if it comes out even." },
  { match: (k) => k === "is_multiple" || k === "common_multiples", hint: "A multiple is a number you land on when you skip-count. Would you reach it counting by that number?" },
  { match: (k) => k === "factors_and_multiples", hint: "Factors are numbers that fit evenly inside. Multiples are numbers you reach by skip-counting." },
  { match: (k) => k === "divisibility_rules_3_9", hint: "A number leaves the same remainder as its digit sum does. Divide the digit sum by 3 or 9 and see what is left over." },
  { match: (k) => k === "divisibility_rules_2_5_10", hint: "Look at the last digit. Even endings work for 2; 0 or 5 works for 5; 0 works for 10." },
  { match: (k) => k === "prime_composite", hint: "Find every factor pair of the number, then count how many different factors that gives you." },
  { match: (k) => k === "prime_or_composite", hint: "Count the factor pairs. Exactly one pair (1 and itself) means prime; more than one means composite." },
  { match: (k) => k === "prime_factorization", hint: "The exponent is the small raised number that tells how many times a prime is multiplied. Find that prime in the factorization and read its exponent (a prime with no raised number counts as 1)." },
  { match: (k) => k.startsWith("equivalent_fractions"), hint: "Multiply or divide the top and bottom by the same number. The pieces change size, but the amount stays equal." },
  { match: (k) => k === "common_denominators", hint: "Make the bottom numbers match first so the pieces are the same size before you add or compare." },
  { match: (k) => k === "unit_fraction", hint: "A unit fraction is one equal piece. The denominator tells how many equal pieces make the whole." },
  { match: (k) => k === "whole_as_fraction", hint: "To show one whole as a fraction, fill every equal piece. The numerator and denominator match." },
  { match: (k) => k === "partition_shapes", hint: "Split the whole into equal pieces, all the same size. The bottom number tells how many equal pieces to make." },
  { match: (k) => k.startsWith("fraction_"), hint: "Draw the whole as equal parts. The denominator says how many parts; the numerator says how many are chosen." },
  { match: (k) => k === "multiply_fraction_by_whole", hint: "Think of groups of the fraction. Add the fraction again and again, or multiply the numerator by the whole number." },
  { match: (k) => k === "multiply_fractions", hint: "Picture taking a fraction of a fraction: multiply the tops for chosen parts and the bottoms for tiny equal pieces." },
  { match: (k) => k === "divide_unit_fractions", hint: "Draw equal pieces and count how many unit-fraction pieces fit into the amount you have." },
  { match: (k) => k === "divide_fractions", hint: "Ask how many groups of the second fraction fit in the first. A number line or bar model can help." },
  { match: (k) => k === "probability_as_fraction", hint: "Write the favorable outcomes over the total number of outcomes, then simplify by dividing the top and bottom by a common factor." },
];

export function hintForSkill(skillKey: string): string {
  return (
    HINTS.find((h) => h.match(skillKey))?.hint ??
    "Read the question again slowly. What exactly is it asking you to find?"
  );
}
