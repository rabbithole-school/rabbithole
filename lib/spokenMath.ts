/**
 * spokenMath — turn a Whisper transcript of a spoken math answer into the
 * normalized string the practice number-pad produces ("56", "-5", "3/4",
 * "5.2", "5R3"). Powers always-on voice answering in the practice drill (P9):
 * a scholar taps the mic, says their answer, and we drop the parsed value into
 * the same answer field they'd otherwise type.
 *
 * Deliberately forgiving: Whisper usually returns DIGITS for spoken numbers
 * ("fifty-six" → "56"), so the digit path is primary; spelled-out words are a
 * fallback. Filler ("um", "the answer is", "it's") is ignored. Returns null
 * when nothing number-like is found (the scholar can just type instead).
 *
 * Pure + framework-free so it's unit-testable. NOT a general NLP number parser
 * — scoped to the small vocabulary of K–5 arithmetic answers.
 */

import { formatUnit, splitUnitSuffix } from "@/convex/lib/practice/answers";

export type SpokenAnswerType = "integer" | "decimal" | "fraction" | "expression" | "multipleChoice";

const ONES: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
// Denominator words → number ("three fourths" → /4; "one half" → /2).
const DENOM: Record<string, number> = {
  half: 2, halves: 2, third: 3, thirds: 3, fourth: 4, fourths: 4, quarter: 4, quarters: 4,
  fifth: 5, fifths: 5, sixth: 6, sixths: 6, seventh: 7, sevenths: 7, eighth: 8, eighths: 8,
  ninth: 9, ninths: 9, tenth: 10, tenths: 10, twelfth: 12, twelfths: 12,
};

/** Parse a run of number-words ("three hundred forty two") → 342, or null. */
function wordsToNumber(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let saw = false;
  for (const tok of tokens) {
    if (tok in ONES) {
      current += ONES[tok];
      saw = true;
    } else if (tok in TENS) {
      current += TENS[tok];
      saw = true;
    } else if (tok === "hundred") {
      current = (current || 1) * 100;
      saw = true;
    } else if (tok === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      saw = true;
    } else if (tok === "and") {
      // filler in "three hundred and two"
      continue;
    } else {
      return null; // an unknown token breaks a pure number-word run
    }
  }
  return saw ? total + current : null;
}

/** Extract the first integer a token-run represents (digits or words). */
function parseWholeFromTokens(tokens: string[]): number | null {
  // Digit token first (Whisper's common output), e.g. ["56"].
  for (const t of tokens) {
    if (/^\d+$/.test(t)) return parseInt(t, 10);
  }
  return wordsToNumber(tokens.filter((t) => t !== "and"));
}

/**
 * Normalize a spoken answer to the pad's string form, or null if unparseable.
 * `answerType` biases interpretation (e.g. only "expression" yields a
 * remainder), but the function is tolerant if the scholar phrases it differently.
 */
export function spokenToAnswer(raw: string, answerType: SpokenAnswerType): string | null {
  if (answerType === "multipleChoice") return null; // choice UI handles its own input
  if (!raw) return null;

  let s = raw.toLowerCase().trim();
  // Strip common lead-ins / filler.
  s = s.replace(/\b(um+|uh+|the answer is|answer is|it'?s|its|equals?|is)\b/g, " ");
  // Whisper formats large spoken numbers with thousands-separator commas
  // ("one thousand" → "1,000", "thirty thousand" → "30,000"): strip a comma
  // sitting BETWEEN digits so the number stays one token ("1,000" → "1000").
  // Do this BEFORE turning any remaining commas into separators.
  s = s.replace(/(\d),(?=\d)/g, "$1");
  // Normalize separators to spaces (keep digits, minus, slash, dot).
  s = s.replace(/[,]/g, " ").replace(/\s+/g, " ").trim();

  const negative = /\b(negative|minus)\b/.test(s) || /^-/.test(s);
  s = s.replace(/\b(negative|minus)\b/g, " ").replace(/^-/, " ").trim();
  // Split hyphenated number-words ("fifty-six") AFTER the leading-minus check.
  s = s.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  const sign = negative ? "-" : "";

  // ── Remainder (division): "5 remainder 3", "5 r 3", "5R3" ──
  if (answerType === "expression") {
    const rem = s.match(/(.+?)\b(?:remainder|rem|r)\b(.+)/);
    if (rem) {
      const q = parseWholeFromTokens(rem[1].trim().split(" ").filter(Boolean));
      const r = parseWholeFromTokens(rem[2].trim().split(" ").filter(Boolean));
      if (q !== null && r !== null) return `${sign}${q}R${r}`;
    }
  }

  // ── Fraction: "3/4", "three fourths", "three over four", "3 out of 4" ──
  const slash = s.match(/(\d+)\s*\/\s*(\d+)/);
  if (slash) return `${sign}${slash[1]}/${slash[2]}`;

  const over = s.match(/(.+?)\b(?:over|out of)\b(.+)/);
  if (over) {
    const n = parseWholeFromTokens(over[1].trim().split(" ").filter(Boolean));
    const d = parseWholeFromTokens(over[2].trim().split(" ").filter(Boolean));
    if (n !== null && d !== null && d !== 0) return `${sign}${n}/${d}`;
  }

  // "three fourths" / "one half": last token is a denominator word.
  const toks = s.split(" ").filter(Boolean);
  if (toks.length >= 2) {
    const last = toks[toks.length - 1];
    if (last in DENOM) {
      const n = parseWholeFromTokens(toks.slice(0, -1));
      if (n !== null) return `${sign}${n}/${DENOM[last]}`;
    }
  }

  // ── Decimal: "5.2", "five point two" ──
  const dot = s.match(/(\d+)\.(\d+)/);
  if (dot) return `${sign}${dot[1]}.${dot[2]}`;
  const pointIdx = toks.indexOf("point");
  if (pointIdx > 0) {
    const whole = parseWholeFromTokens(toks.slice(0, pointIdx));
    // digits after "point" are read individually ("point two five" → ".25")
    const fracDigits = toks
      .slice(pointIdx + 1)
      .map((t) => (/^\d+$/.test(t) ? t : t in ONES ? String(ONES[t]) : ""))
      .join("");
    if (whole !== null && fracDigits) return `${sign}${whole}.${fracDigits}`;
  }

  // ── Plain whole number ──
  const whole = parseWholeFromTokens(toks);
  if (whole !== null) return `${sign}${whole}`;

  return null;
}

/**
 * A unit-bearing item's spoken answer ("112 cubic centimeters"): the unit IS
 * part of the answer, but `spokenToAnswer` is a NUMBER parser and drops every
 * trailing word, so dictation alone would silently submit a bare "112" that the
 * grader now marks incorrect. Split the unit phrase off first (the SERVER's
 * alias table — never a second one here), parse the number from what's left,
 * and re-attach the unit in display form.
 *
 * Unit-free items route straight to `spokenToAnswer`, unchanged.
 */
export function spokenToUnitAnswer(
  raw: string,
  answerType: SpokenAnswerType,
  answerUnit: string | undefined,
): string | null {
  if (!answerUnit) return spokenToAnswer(raw, answerType);
  // Whisper punctuates ("…centimeters."), which would hide the trailing alias.
  const split = splitUnitSuffix(raw.trim().replace(/[.,!?;:]+$/, ""));
  // Only a RECOGNIZED alias is peeled off. `splitUnitSuffix`'s generic
  // any-trailing-word fallback would eat the last word of a spelled-out number
  // ("one hundred twelve" → "100 twelve"), so an unrecognized tail falls
  // through to the plain parse and the pre-submit gate asks for the unit.
  if (!split.unit) return spokenToAnswer(raw, answerType);
  const value = spokenToAnswer(split.value, answerType);
  return value === null ? null : `${value} ${formatUnit(split.unit)}`;
}
