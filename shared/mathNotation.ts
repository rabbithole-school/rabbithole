/**
 * Display-layer math-notation normalization — shared by BOTH frontends.
 *
 * The practice engine stores stems, feedback, and labels as plain ASCII, so an
 * exponent is written with a caret: `5^2`, `2 · 3^2 · 5`, `10^12`. That caret is
 * an authoring convenience, not something a young scholar has ever seen — and it
 * renders inconsistently (a stem shows `5^2` while a model-written explanation
 * shows `5²`). This helper fixes it at RENDER TIME only: stored data and the
 * deterministic generators (convex/lib/practice/*) stay untouched, and every
 * surface that displays the text runs it through `superscriptExponents` so a kid
 * always sees `5²`.
 *
 * This module imports nothing so it vendors cleanly into the native app
 * (native/vendor/shared/mathNotation.ts, via native/scripts/sync-vendor.js) and
 * runs identically on web and native.
 *
 * Behavior (deliberate, and documented for the edge cases):
 *   - Converts a caret to a Unicode superscript ONLY when it directly follows a
 *     base token (a digit, letter, `)` or `]`) AND is followed by one or more
 *     digits — i.e. a clear non-negative integer exponent. Multi-digit exponents
 *     are handled (`10^12` → `10¹²`).
 *   - `x^2` inside a sentence → `x²` (a letter is a valid base).
 *   - `2 · 3^2 · 5` → `2 · 3² · 5` (each caret converted independently).
 *   - Non-math text is left ALONE: `a^b` stays `a^b` because `b` is not a digit,
 *     and a stray `^` with no base token before it (e.g. a leading `^2`) is left
 *     as-is. We only rewrite unambiguous integer-exponent notation; a
 *     negative/decimal/variable exponent (`10^-3`, `2^n`) is intentionally left
 *     untouched (rare in K-8 content, and leaving it is safer than guessing).
 *   - No caret at all → returned unchanged (fast path).
 *   - `null` / `undefined` pass through unchanged (so `{sup(item?.stem)}` in JSX
 *     behaves exactly as `{item?.stem}` did).
 */

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

export function superscriptExponents(text: string): string;
export function superscriptExponents(text: string | null | undefined): string | null | undefined;
export function superscriptExponents(
  text: string | null | undefined,
): string | null | undefined {
  if (typeof text !== "string" || text.indexOf("^") === -1) return text;
  return text.replace(EXPONENT_RE, (_full, base: string, digits: string) => base + toSuperscriptDigits(digits));
}
