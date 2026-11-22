/**
 * The FLAT answer model: one string, edited by one key at a time.
 *
 * Most school answers are a number, not a structure: `42`, `-7`, `3.5`, `3/4`,
 * `7 R 2`, `112 cm³`. For those the pad edits a plain string, and every rule
 * about what a key does lives here, framework-free, so the on-screen pad and a
 * hardware keyboard produce byte-identical strings.
 *
 * Extracted from Rabbithole's shared/practiceLoop.ts (the pad section),
 * native/src/lib/practicePad.ts (the grid layout) and shared/mathNotation.ts
 * (superscript exponents). Code is unchanged; comments were generalized.
 */

/** The answer kinds a flat pad serves. `expression` here means the
 *  whole-number-division remainder form ("7 R 2") and other short typed
 *  expressions; genuine fractions, powers and roots use the 2-D builder.
 *  `solutionSet` is one or more answers separated by commas (`3,-2`), or the
 *  word `none`; on a touch screen it is usually built with the algebra-mode
 *  builder (one box per answer), and typed flat on a hardware keyboard. */
export type PadAnswerType = "integer" | "decimal" | "fraction" | "expression" | "solutionSet";

export function isPadAnswerType(t: string): t is PadAnswerType {
  return (
    t === "integer" || t === "decimal" || t === "fraction" || t === "expression" || t === "solutionSet"
  );
}

/** Expression answers (whole-number division) can carry a remainder → an `R` key. */
export function padShowRemainder(t: PadAnswerType): boolean {
  return t === "expression";
}

/** Numeric-valued pad types (integer/decimal/fraction) can lead with a sign
 *  toggle; expression (the "7 R 2" remainder form) never needs one. */
export function padShowSign(t: PadAnswerType): boolean {
  return t !== "expression";
}

/** Decimal items get a wide `/ (fraction)` accessory key (fraction/expression
 *  pads already carry `/` in the grid). If your checker compares numeric
 *  answers by VALUE (105/16 ≡ 6.5625), a learner who worked in fourths should
 *  not have to convert to decimal notation just to type the answer.
 *  Representation must never gate a correct answer. */
export function padShowFraction(t: PadAnswerType): boolean {
  return t === "decimal";
}

/** Which flat pad types accept a fraction slash `/` at all — the same set the
 *  hardware-keyboard allowlist (`sanitizePadInput`) lets through and the grid
 *  carries. Integer answers never take a slash. */
export function padAcceptsFraction(t: PadAnswerType): boolean {
  return t === "decimal" || t === "fraction" || t === "expression" || t === "solutionSet";
}

/**
 * The bottom-left key of the 3×4 grid: `/` for fraction/expression, `.` for
 * decimal, blank (hidden) for integer. Follows the `applyKey` vocabulary.
 */
export function padOpKey(t: PadAnswerType): string {
  if (t === "fraction" || t === "expression") return "/";
  if (t === "decimal") return ".";
  return "";
}

/** The 12 grid keys in row-major order (`""` = a hidden placeholder cell). */
export function padGridKeys(t: PadAnswerType): string[] {
  return ["7", "8", "9", "4", "5", "6", "1", "2", "3", padOpKey(t), "0", "⌫"];
}

/**
 * Apply one keypad press to the current input string. Backspace trims one char,
 * `R` inserts a spaced remainder token (so the string matches the `"7 R 2"`
 * form), `±` (the pad's dedicated sign key) or a hardware-typed `-` TOGGLES a
 * leading minus sign — never inserts one mid-number, and pressing it again
 * removes it — any other key appends.
 */
export function applyKey(prev: string, key: string): string {
  if (key === "⌫") return prev.slice(0, -1);
  if (key === "R") return `${prev} R `;
  if (key === "±" || key === "-") {
    return prev.startsWith("-") ? prev.slice(1) : `-${prev}`;
  }
  return prev + key;
}

/** A synchronously updated input snapshot for controls whose rendered state may
 * commit after a rapid final-key + submit sequence (a key and Return landing
 * before React re-renders). */
export type InputBuffer = { current: string };

export function setInputBuffer(buffer: InputBuffer, value: string): string {
  buffer.current = value;
  return value;
}

export function applyKeyToInputBuffer(buffer: InputBuffer, key: string): string {
  return setInputBuffer(buffer, applyKey(buffer.current, key));
}

/**
 * Filter raw text (e.g. from a HARDWARE keyboard) down to only the characters a
 * given pad answer type can legitimately contain, so a physical keyboard enters
 * the same values the on-screen pad produces. Mirrors the on-screen pad's key
 * set — digits everywhere; `.` for decimal only; `/` for
 * decimal/fraction/expression; the remainder token (`R` + spaces) for
 * expression — plus a LEADING `-` sign for negatives, never mid-number,
 * matching the on-screen `±` key's leading-only rule. A lowercase `r` is
 * normalized to `R` so a typed "7 r 2" matches the pad's "7 R 2".
 *
 * `opts.allowUnit` is the UNIT-BEARING item's carve-out: when the answer must
 * carry a unit ("in cubic centimeters") the numeric filter would otherwise make
 * it untypeable (it drops every letter). It widens the charset with letters,
 * spaces, and the exponent glyphs a unit can carry (`^`, `²`, `³`, `°`) —
 * nothing else.
 */
export function sanitizePadInput(
  answerType: PadAnswerType,
  raw: string,
  opts?: { allowUnit?: boolean },
): string {
  const allowUnit = opts?.allowUnit === true;
  let out = "";
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "-" && out === "") out += ch;
    else if (ch === "." && answerType === "decimal") out += ch;
    else if (ch === "/" && padAcceptsFraction(answerType)) out += ch;
    else if (answerType === "expression" && (ch === "R" || ch === "r")) out += "R";
    else if (answerType === "expression" && /[A-Za-z()+*^.\s]/.test(ch)) out += ch;
    // A solution set is typed as algebra: letters, operators, brackets, roots,
    // ± and the comma between answers.
    else if (answerType === "solutionSet" && /[A-Za-z()+\-*^.,|±√\s]/.test(ch)) out += ch;
    // The unit tail: letters + spaces + exponent glyphs + the degree sign.
    // Applied AFTER the numeric charset above, so digits/sign/separators keep
    // their exact per-type rules and only the unit vocabulary is added on top.
    else if (allowUnit && /[a-zA-Z ^²³°]/.test(ch)) out += ch;
  }
  return out;
}

/**
 * The on-screen pad's unit keys for a unit-bearing answer, derived from the
 * display unit ("cm³" → ["cm", "cm²", "cm³"]). The pad deliberately offers the
 * whole DIMENSION FAMILY of the base unit, not just the expected one: picking
 * length vs. area vs. volume is part of the answer (a single pre-filled key
 * would type the unit for the learner and test nothing).
 */
export function unitKeyFamily(displayUnit: string): string[] {
  // Degrees is dimensionless — there is no ² / ³ member to choose between, so
  // the family is the single ° key (the cm/m branch below would wrongly offer
  // "°²" / "°³").
  if (displayUnit.trim() === "°") return ["°"];
  const base = displayUnit.replace(/[²³]/g, "").trim();
  if (!base) return [];
  return [base, `${base}²`, `${base}³`];
}

/**
 * A trailing unit token as it can exist mid-typing: letters, then EITHER a
 * hardware-typed caret exponent (`^`, with or without its digit yet — `cm^`
 * is a valid in-progress state) OR an already-superscripted digit (`²`/`³`) —
 * or a lone degree sign (`°`).
 */
const TRAILING_UNIT_RE = /\s*(?:[a-zA-Z]+\s*(?:\^\s*[0-9]*|[²³])?|°)\s*$/;

/**
 * Apply a tapped unit key to the current input: replace any trailing unit
 * token (letters/spaces/exponents in EITHER the caret or superscript form, OR a
 * degree sign) with the tapped one, so switching cm² → cm³ — or cm^2 → cm³ — is
 * one tap, never a backspace dance, and re-tapping ° is idempotent. Degrees
 * binds to the number with no space ("65°"); every other unit keeps the
 * "112 cm³" spacing.
 */
export function applyUnitKey(prev: string, unitDisplay: string): string {
  const numeric = prev.replace(TRAILING_UNIT_RE, "").trim();
  if (numeric === "") return unitDisplay;
  return unitDisplay === "°" ? `${numeric}${unitDisplay}` : `${numeric} ${unitDisplay}`;
}

const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"] as const;

// A base token (digit | letter | `)` | `]`), a caret, then ≥1 digits. The base is
// captured so it survives; only the `^<digits>` run becomes a superscript.
const EXPONENT_RE = /([0-9A-Za-z)\]])\^(\d+)/g;

function toSuperscriptDigits(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    out += SUPERSCRIPT_DIGITS[digits.charCodeAt(i) - 48];
  }
  return out;
}

/**
 * Display-time exponent normalization: `cm^3` → `cm³`, `10^12` → `10¹²`. Only
 * an unambiguous non-negative integer exponent after a base token is rewritten;
 * `a^b`, `10^-3` and a leading `^2` are left alone. The flat field runs this on
 * every keystroke of a unit-bearing answer, so a typed `cm^3` converges on the
 * exact string a tap of the `cm³` unit key produces.
 */
export function superscriptExponents(text: string): string;
export function superscriptExponents(text: string | null | undefined): string | null | undefined;
export function superscriptExponents(
  text: string | null | undefined,
): string | null | undefined {
  if (typeof text !== "string" || text.indexOf("^") === -1) return text;
  // A LaTeX span (`\( … \)` inline or `\[ … \]` display) is for a math
  // renderer, where `x^2` must stay a caret: rewrite only the text between spans.
  if (text.indexOf("\\(") !== -1 || text.indexOf("\\[") !== -1) {
    return text
      .split(LATEX_SPAN_RE)
      .map((part) => (LATEX_SPAN_TEST.test(part) ? part : rewriteExponents(part)))
      .join("");
  }
  return rewriteExponents(text);
}

// Capturing, so `split` keeps the spans.
const LATEX_SPAN_RE = /(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/;
const LATEX_SPAN_TEST = /^(?:\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])$/;

function rewriteExponents(text: string): string {
  return text.replace(EXPONENT_RE, (_full, base: string, digits: string) => base + toSuperscriptDigits(digits));
}
