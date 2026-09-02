/**
 * FACT KEYS — the ONE canonical identity for a single-digit arithmetic fact,
 * shared across the server (fact-fluency bucketing) and both clients (teacher
 * heatmap labels). Pure and import-free so it resolves standalone under Metro
 * when vendored, and is unit-testable without a Convex harness.
 *
 * WHY A SEPARATE IDENTITY FROM `skillKey`. The practice engine's atom is a
 * `skillKey` (e.g. `mult_facts_7_8_9`) — a whole *family* of facts scheduled as
 * one node. Automaticity, though, lives at the grain of the individual fact:
 * a scholar can be instant on 7×2 and still counting on 7×8. FastMath's whole
 * value is resolving that sub-grain. A `factKey` is that finer identity, sitting
 * *beneath* a skillKey. Fact-family generator spaces can overlap (for example,
 * 3×7 belongs to both the ×3/4/6 and ×7/8/9 families), so family membership is
 * derived from the operands rather than stored as single-owner identity.
 *
 * CANONICAL FORM (storage — ASCII, index-safe):
 *   • addition        `add:LO+HI`   operands sorted (commutative: 6+7 ≡ 7+6)
 *   • subtraction     `sub:A-B`     as-written (NOT commutative: 15−8 ≠ 8−15)
 *   • multiplication  `mul:LOxHI`   operands sorted (commutative: 7×8 ≡ 8×7)
 * Division is deliberately out of scope: the served-item operand union is only
 * `+ − ×`, and the ask was addition/subtraction/multiplication automaticity.
 *
 * The KEY is ASCII; the human LABEL (`factKeyLabel`) uses the real glyphs
 * (`+ − ×`) — never build a label by string-substituting the key.
 */

/** The three fact operations, as the glyphs a served item's stem/variant uses
 *  (U+2212 MINUS SIGN, U+00D7 MULTIPLICATION SIGN — matching `ItemVariant.op`). */
export const FACT_OP_GLYPHS = ["+", "−", "×"] as const;
export type FactOpGlyph = (typeof FACT_OP_GLYPHS)[number];

/** The canonical operation tag stored on a fact-fluency row and used as the
 *  `factKey` prefix — a compact, index-friendly, ASCII-only enum. */
export type FactOp = "add" | "sub" | "mul";

/** A canonical fact identity string (see the file header for the grammar). */
export type FactKey = string;

/**
 * The fact-family `skillKey`s — the ONLY skills whose attempts bucket into a
 * `factKey`. Everything else (place value, fractions, word problems, …) is not
 * a bare retrieval fact and must never mint a fact-fluency row. Kept as a set so
 * the record-time gate is an O(1) membership test.
 *
 * `add_subtract_fluency_within_20` intentionally spans BOTH `+` and `−` facts —
 * the op comes from each served item's operands, so one skill legitimately maps
 * to fact keys under two different `FactOp`s.
 */
export const FACT_FAMILY_SKILLS: ReadonlySet<string> = new Set<string>([
  "add_within_5",
  "add_within_10",
  "add_within_20_no_regroup",
  "add_within_20_regroup",
  "subtract_within_5",
  "subtract_within_10",
  "subtract_within_20",
  "add_subtract_fluency_within_20",
  "mult_facts_0_1_2_5_10",
  "mult_facts_3_4_6",
  "mult_facts_7_8_9",
]);

/** True when a `skillKey` names a bare-fact family (see `FACT_FAMILY_SKILLS`). */
export function isFactFamilySkill(skillKey: string): boolean {
  return FACT_FAMILY_SKILLS.has(skillKey);
}

/** Normalize any of the accepted operator spellings (glyphs OR ASCII
 *  `- * x`) to a canonical `FactOp`, or `null` if it isn't one of the three. */
export function normalizeFactOp(op: string): FactOp | null {
  switch (op) {
    case "+":
      return "add";
    case "−":
    case "-":
      return "sub";
    case "×":
    case "*":
    case "x":
    case "X":
      return "mul";
    default:
      return null;
  }
}

/** The display glyph for a canonical `FactOp`. */
export function factOpGlyph(op: FactOp): FactOpGlyph {
  return op === "add" ? "+" : op === "sub" ? "−" : "×";
}

/**
 * Build the canonical `factKey` from operands + operator. Commutative ops sort
 * their operands (so 7×8 and 8×7 collapse to one identity); subtraction keeps
 * order. Returns `null` for a non-fact operator or a non-finite/negative operand
 * — the caller treats `null` as "not a bucketable fact" and skips silently.
 */
export function factKeyFromOperands(a: number, op: string, b: number): FactKey | null {
  const canonical = normalizeFactOp(op);
  if (canonical === null) return null;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return null;
  if (canonical === "sub") return `sub:${a}-${b}`;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return canonical === "add" ? `add:${lo}+${hi}` : `mul:${lo}x${hi}`;
}

/** Structured operands parsed out of a `factKey`. */
export type ParsedFact = { a: number; op: FactOp; b: number };

const KEY_FACT_RE = /^(add|sub|mul):(\d+)([+\-x])(\d+)$/;

/** Reverse a canonical `factKey` back to its operands, or `null` if malformed. */
export function parseFactKey(factKey: FactKey): ParsedFact | null {
  const m = KEY_FACT_RE.exec(factKey);
  if (!m) return null;
  const op = m[1] as FactOp;
  const separator = m[3];
  if (
    (op === "add" && separator !== "+") ||
    (op === "sub" && separator !== "-") ||
    (op === "mul" && separator !== "x")
  ) {
    return null;
  }
  return { a: Number(m[2]), op, b: Number(m[4]) };
}

/**
 * Whether a canonical fact can be generated by a fact-family skill. These are
 * the exact direct-form operand spaces in `convex/lib/practice/templates.ts`;
 * keep changes coupled to those templates.
 */
export function factBelongsToFamily(factKey: FactKey, skillKey: string): boolean {
  const fact = parseFactKey(factKey);
  if (!fact) return false;
  const { a, op, b } = fact;

  switch (skillKey) {
    case "add_within_5":
      return op === "add" && a + b <= 5;
    case "add_within_10":
      return op === "add" && a + b <= 10;
    case "add_within_20_no_regroup": {
      if (op !== "add") return false;
      const generatedOrder = (first: number, second: number) =>
        first <= 19 && second <= 9 && (first % 10) + second <= 9;
      return generatedOrder(a, b) || generatedOrder(b, a);
    }
    case "add_within_20_regroup":
      return op === "add" && a >= 2 && b <= 9 && a + b >= 11;
    case "subtract_within_5":
      return op === "sub" && a <= 5 && b <= a;
    case "subtract_within_10":
      return op === "sub" && a <= 10 && b <= a;
    case "subtract_within_20":
      return op === "sub" && a >= 10 && a <= 20 && b <= a;
    case "add_subtract_fluency_within_20":
      return (
        (op === "add" && a + b <= 20) ||
        (op === "sub" && a <= 20 && b <= a)
      );
    case "mult_facts_0_1_2_5_10":
      return op === "mul" && multiplicationFamilyContains(a, b, [0, 1, 2, 5, 10]);
    case "mult_facts_3_4_6":
      return op === "mul" && multiplicationFamilyContains(a, b, [3, 4, 6]);
    case "mult_facts_7_8_9":
      return op === "mul" && multiplicationFamilyContains(a, b, [7, 8, 9]);
    default:
      return false;
  }
}

function multiplicationFamilyContains(a: number, b: number, factors: readonly number[]): boolean {
  return (
    (factors.includes(a) && b <= 10) ||
    (factors.includes(b) && a <= 10)
  );
}

/** The `FactOp` a `factKey` belongs to (its prefix), or `null` if malformed. */
export function factKeyOp(factKey: FactKey): FactOp | null {
  const idx = factKey.indexOf(":");
  if (idx <= 0) return null;
  const prefix = factKey.slice(0, idx);
  return prefix === "add" || prefix === "sub" || prefix === "mul" ? prefix : null;
}

/**
 * The human-readable fact, using real glyphs — `"7 × 8"`, `"15 − 8"`, `"6 + 7"`.
 * The canonical rendering of a fact anywhere a person sees one (teacher heatmap
 * tooltip, etc). Never shown to a scholar as a score. Returns the raw key
 * unchanged if it can't be parsed (defensive — a label should never throw).
 */
export function factKeyLabel(factKey: FactKey): string {
  const parsed = parseFactKey(factKey);
  if (!parsed) return factKey;
  return `${parsed.a} ${factOpGlyph(parsed.op)} ${parsed.b}`;
}
