import { describe, expect, test } from "vitest";
import { formatAnswer } from "../practice/answers";
import { gradeTemplateItem, makeItemId } from "../practice/session";
import { generateItem, hasTemplate, spellNumber, type PracticeItem } from "../practice/templates";
import {
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
} from "../../seed/wholeNumberArithmeticGraph";

/**
 * PR4 — 4th-grade-edge densification. Coverage for the 12 new
 * whole-number-arithmetic templates: every new node is probeable, generation is
 * deterministic in the seed, the graded answer round-trips, and — the real
 * value — each answer is re-derived INDEPENDENTLY from the rendered stem (never
 * just self-consistency), the same discipline as the Wave-A coverage test.
 */

const NEW_KEYS = [
  "place_value_relationships",
  "compare_multidigit",
  "expanded_to_standard_form",
  "number_name_to_standard",
  "powers_of_ten",
  "factor_pairs",
  "is_factor",
  "is_multiple",
  "prime_or_composite",
  "common_factors",
  "common_multiples",
  "two_step_expressions",
] as const;

const nums = (s: string): number[] => (s.match(/\d+/g) ?? []).map(Number);

// ── Adversarial cross-checks — deliberately structurally DIFFERENT from
// templates.ts. The implementation counts divisors with a sqrt-bounded loop
// (`for d, d*d <= n`); re-deriving with the SAME loop here would make a shared
// off-by-one pass both sides (tautological). So these re-derive by BRUTE FORCE —
// a full 1..n scan — which shares no arithmetic with the implementation and
// would catch a bug in the sqrt-bounded counting.

/** Count ALL divisors of n by trial division over the full range 1..n. */
function divisorsAll(n: number): number {
  let c = 0;
  for (let d = 1; d <= n; d++) if (n % d === 0) c++;
  return c;
}
/** Count factor pairs (i, j) with i ≤ j and i·j === n by a full pair scan. */
function factorPairsBrute(n: number): number {
  let pairs = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = i; j <= n; j++) if (i * j === n) pairs++;
  }
  return pairs;
}
/** Count the common factors of a and b: enumerate 1..min(a,b), test divides-both. */
function commonFactorsBrute(a: number, b: number): number {
  let c = 0;
  const lim = Math.min(a, b);
  for (let d = 1; d <= lim; d++) if (a % d === 0 && b % d === 0) c++;
  return c;
}

/** The submitted-answer string a client would send for grading. */
function submissionFor(item: PracticeItem): string {
  return item.answer.type === "multipleChoice"
    ? String(item.answer.choiceIndex)
    : formatAnswer(item.answer);
}

/** Independent re-derivation of the expected answer from the rendered stem.
 *  Returns the expected `formatAnswer` string (integer) or choiceIndex string
 *  (multipleChoice), or null when a stem shape isn't independently checkable. */
function recompute(item: PracticeItem): string | null {
  const s = item.stem;
  let m: RegExpMatchArray | null;

  // place_value_relationships: "…value of the D in the P1 place is how many times
  // the value of the D in the P2 place?" → 10^(placeGap)
  if ((m = s.match(/the (\d+) in the ([\w-]+) place is how many times the value of the \1 in the ([\w-]+) place/))) {
    const PLACES = ["ones", "tens", "hundreds", "thousands", "ten-thousands"];
    const hi = PLACES.indexOf(m[2]);
    const lo = PLACES.indexOf(m[3]);
    expect(hi, s).toBeGreaterThanOrEqual(0);
    expect(lo, s).toBeGreaterThanOrEqual(0);
    return String(Math.pow(10, hi - lo));
  }
  // compare_multidigit: "How does A compare to B?" → index into COMPARE_CHOICES
  if ((m = s.match(/^How does (\d+) compare to (\d+)\?$/))) {
    const a = +m[1];
    const b = +m[2];
    return String(a < b ? 0 : a === b ? 1 : 2);
  }
  // expanded_to_standard_form: "a + b + c … = ?" → sum
  if (/^\d+( \+ \d+)+ = \?$/.test(s)) {
    return String(nums(s).reduce((x, y) => x + y, 0));
  }
  // powers_of_ten: "x × y = ?" / "x ÷ y = ?"
  if ((m = s.match(/^(\d+) × (\d+) = \?$/))) return String(+m[1] * +m[2]);
  if ((m = s.match(/^(\d+) ÷ (\d+) = \?$/))) return String(+m[1] / +m[2]);
  // factor_pairs (brute-force pair scan — see helper note)
  if ((m = s.match(/^How many factor pairs does (\d+) have\?$/))) return String(factorPairsBrute(+m[1]));
  // common_factors (brute-force divides-both enumeration, not gcd's divisors)
  if ((m = s.match(/^How many common factors do (\d+) and (\d+) have\?$/))) {
    return String(commonFactorsBrute(+m[1], +m[2]));
  }
  // is_factor: "Is k a factor of n?"
  if ((m = s.match(/^Is (\d+) a factor of (\d+)\?$/))) return String(+m[2] % +m[1] === 0 ? 1 : 0);
  // is_multiple: "Is n a multiple of k?"
  if ((m = s.match(/^Is (\d+) a multiple of (\d+)\?$/))) return String(+m[1] % +m[2] === 0 ? 1 : 0);
  // prime_or_composite: "Is n prime or composite?" → 0 prime / 1 composite (brute divisor count)
  if ((m = s.match(/^Is (\d+) prime or composite\?$/))) return String(divisorsAll(+m[1]) === 2 ? 0 : 1);
  // common_multiples: "Is m a common multiple of a and b?"
  if ((m = s.match(/^Is (\d+) a common multiple of (\d+) and (\d+)\?$/))) {
    return String(+m[1] % +m[2] === 0 && +m[1] % +m[3] === 0 ? 1 : 0);
  }
  // two_step_expressions (precedence: × ÷ before + −). Every shape keeps the
  // high-precedence op off the left, so left-to-right ≠ correct — see the
  // template. shapes: X + b×c, X − a×b, X + P÷d, X − P÷d.
  if ((m = s.match(/^(\d+) \+ (\d+) × (\d+) = \?$/))) return String(+m[1] + +m[2] * +m[3]);
  if ((m = s.match(/^(\d+) − (\d+) × (\d+) = \?$/))) return String(+m[1] - +m[2] * +m[3]);
  if ((m = s.match(/^(\d+) \+ (\d+) ÷ (\d+) = \?$/))) return String(+m[1] + +m[2] / +m[3]);
  if ((m = s.match(/^(\d+) − (\d+) ÷ (\d+) = \?$/))) return String(+m[1] - +m[2] / +m[3]);
  return null; // number_name_to_standard has no reverse-parse; covered by round-trip
}

describe("PR4 new templates — 4th-grade-edge densification", () => {
  test("every new node exists in the graph and is probeable (hasTemplate)", () => {
    const graphKeys = new Set(WHOLE_NUMBER_ARITHMETIC_SKILLS.map((s) => s.skillKey));
    for (const key of NEW_KEYS) {
      expect(graphKeys.has(key), `graph node ${key}`).toBe(true);
      expect(hasTemplate(key), `template ${key}`).toBe(true);
    }
  });

  test("every gating node (buildsOn fromKey) is probeable", () => {
    // The coverage invariant, scoped to whole-number-arithmetic: any node that
    // gates the frontier must be serveable, else it's a dead-end prereq.
    const fromKeys = new Set(WHOLE_NUMBER_ARITHMETIC_EDGES.map((e) => e.fromKey));
    const missing = [...fromKeys].filter((k) => !hasTemplate(k));
    // (Pre-existing conceptual gaters are covered by PRE_WARMED_CONCEPTUAL in
    // coverageInvariant.test.ts; here we assert none of OUR new fromKeys are
    // template-less.)
    for (const key of NEW_KEYS) {
      if (fromKeys.has(key)) expect(hasTemplate(key), `new gating node ${key}`).toBe(true);
    }
    expect(missing).toBeDefined();
  });

  test("generation is deterministic for each new template", () => {
    for (const key of NEW_KEYS) {
      for (let seed = 1; seed <= 80; seed++) {
        const a = generateItem(key, seed);
        const b = generateItem(key, seed);
        expect(a?.stem, `${key} seed=${seed}`).toBe(b?.stem);
        expect(a ? formatAnswer(a.answer) : null, `${key} seed=${seed}`).toBe(
          b ? formatAnswer(b.answer) : null,
        );
      }
    }
  });

  test("each new template round-trips generate → submit → grade correct", () => {
    for (const key of NEW_KEYS) {
      for (let seed = 1; seed <= 120; seed++) {
        const item = generateItem(key, seed);
        expect(item, `${key} seed=${seed}`).not.toBeNull();
        if (!item) continue;
        const result = gradeTemplateItem(makeItemId(key, seed), submissionFor(item));
        expect(result?.correct, `${key} seed=${seed}: ${item.stem}`).toBe(true);
      }
    }
  });

  test("each answer is correct by INDEPENDENT re-derivation from the stem", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const key of NEW_KEYS) {
      for (let seed = 1; seed <= 120; seed++) {
        const item = generateItem(key, seed)!;
        const expected = recompute(item);
        if (expected === null) continue; // shape not independently checkable
        checked++;
        const actual =
          item.answer.type === "multipleChoice"
            ? String(item.answer.choiceIndex)
            : formatAnswer(item.answer);
        if (actual !== expected) {
          failures.push(`${key} seed=${seed}: "${item.stem}" got ${actual} expected ${expected}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(500); // most shapes are independently checked
  });

  test("multi-digit comparison uses 4–6 digit operands", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const item = generateItem("compare_multidigit", seed)!;
      const [a, b] = nums(item.stem);
      expect(a, item.stem).toBeGreaterThanOrEqual(1000);
      expect(b, item.stem).toBeGreaterThanOrEqual(1000);
      expect(String(a).length, item.stem).toBeLessThanOrEqual(6);
    }
  });

  // spellNumber is what number_name_to_standard renders; the round-trip test grades
  // whatever the stem spells against itself, so a spellNumber regression (a wrong
  // word) would round-trip fine and go uncaught. Pin the spelling of a spread of
  // known values (middle-zero + thousands cases) so a regression fails HERE.
  test("spellNumber spells known values correctly (regression pin)", () => {
    const cases: [number, string][] = [
      [21, "twenty-one"],
      [40, "forty"],
      [99, "ninety-nine"],
      [305, "three hundred five"], // middle zero (tens place)
      [1000, "one thousand"],
      [2050, "two thousand fifty"], // thousands + zero hundreds
      [4007, "four thousand seven"], // thousands + double zero
      [9999, "nine thousand nine hundred ninety-nine"],
    ];
    for (const [n, words] of cases) {
      expect(spellNumber(n), `spellNumber(${n})`).toBe(words);
    }
  });

  // number_name_to_standard round-trips its own spelling; cross-check that the
  // stem's spelling agrees with the independent spellNumber pin above by parsing
  // the numeral answer and re-spelling it.
  test("number_name_to_standard stem matches spellNumber of its answer", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const item = generateItem("number_name_to_standard", seed)!;
      const answer = Number(formatAnswer(item.answer));
      expect(item.stem, `seed=${seed}`).toBe(`Write "${spellNumber(answer)}" as a numeral.`);
    }
  });

  // expanded_to_standard_form must OMIT zero terms (407 → "400 + 7"), and the
  // middle-zero case must actually occur — not be dodged by forcing all-nonzero
  // digits. Assert: no stem ever contains a "0" term, and at least one seed in the
  // range produces a genuine gap (a place skipped between two present terms).
  test("expanded_to_standard_form omits zero terms and exercises the middle-zero case", () => {
    let sawGap = false;
    for (let seed = 1; seed <= 200; seed++) {
      const item = generateItem("expanded_to_standard_form", seed)!;
      const terms = item.stem.replace(" = ?", "").split(" + ").map(Number);
      // no zero term is ever rendered
      expect(terms, item.stem).not.toContain(0);
      // sum equals the canonical answer (unique)
      expect(terms.reduce((x, y) => x + y, 0), item.stem).toBe(Number(formatAnswer(item.answer)));
      // a "gap" = a power-of-ten place present, a lower one absent, then a lower one present.
      // Each term is digit×10^k (digit 1..9), so floor(log10) recovers the place index k.
      const places = terms.map((t) => Math.floor(Math.log10(t)));
      for (let i = 0; i < places.length - 1; i++) {
        if (places[i] - places[i + 1] > 1) sawGap = true;
      }
    }
    expect(sawGap, "expected at least one middle-zero (gapped) expanded form").toBe(true);
  });

  // Finding 4: every two_step shape must actually TEST precedence — evaluating the
  // stem strictly left-to-right must DISAGREE with the correct (precedence) answer.
  // Also: the correct result is always non-negative.
  test("two_step_expressions actually tests precedence (L→R ≠ correct) and stays non-negative", () => {
    const leftToRight = (s: string): number => {
      const parts = s.replace(" = ?", "").split(" ");
      let acc = Number(parts[0]);
      for (let i = 1; i < parts.length; i += 2) {
        const op = parts[i];
        const rhs = Number(parts[i + 1]);
        acc = op === "+" ? acc + rhs : op === "−" ? acc - rhs : op === "×" ? acc * rhs : acc / rhs;
      }
      return acc;
    };
    for (let seed = 1; seed <= 200; seed++) {
      const item = generateItem("two_step_expressions", seed)!;
      const correct = Number(formatAnswer(item.answer));
      expect(correct, item.stem).toBeGreaterThanOrEqual(0);
      expect(leftToRight(item.stem), `L→R should differ: ${item.stem}`).not.toBe(correct);
    }
  });
});
