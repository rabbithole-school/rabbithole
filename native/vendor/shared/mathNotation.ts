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
 * The code lives in the keypad package (packages/react-native-math-keypad/
 * src/model/flatPad.ts), whose pad superscripts unit exponents the same way.
 * The native vendor sync (native/scripts/sync-vendor.js) rewrites this import
 * for the iPad app's copy, so web and native still run one implementation.
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

export { superscriptExponents } from "../react-native-math-keypad/model/flatPad";
