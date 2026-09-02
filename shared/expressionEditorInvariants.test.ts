import { describe, it, expect } from "vitest";
import {
  createExpressionTemplateState,
  expressionTemplateApplyKey,
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertRoot,
  expressionTemplateToSubmission,
  expressionTemplateToLatex,
  expressionTemplateIsComplete,
  type ExpressionTemplateState,
  type Slot,
  type Item,
} from "./expressionTemplateInput";

// ──────────────────────────────────────────────────────────────────────────
// Precedent-grounded structural invariants for the expression editor.
//
// Distilled from MathQuill (`test/unit/{typing,backspace,updown,SupSub,latex}.test.js`)
// and MathLive (`test/playwright-tests/*.spec.ts`, `src/editor-model/*`). See the
// design doc `review/expression-editor-invariants.html` for the full catalog and
// the per-decision rationale (what `^`/`/` grab, nav semantics, etc.).
//
// THE CORE INVARIANT. This pad has no explicit ×/operator keys, so the ONLY
// meaningful adjacencies inside a slot are:
//   • token, token          → the digits of one number (`12`)
//   • token…, fraction       → a MIXED NUMBER (`2 ½`), fraction LAST
//   • a lone power/fraction  → a single value
// Every other adjacency (a number touching a power, two structures in a row, a
// number after a fraction) reads as implicit multiplication — i.e. nonsense like
// "13²" or "1/23". Our per-op guards enforce this on TYPING; this suite asserts
// it as a GLOBAL postcondition that must hold after ANY reachable sequence, which
// is the real fix for the whack-a-mole (a guard on one entry path never covers
// backspace-unwrap, grab edge cases, etc.).
// ──────────────────────────────────────────────────────────────────────────

function allSlots(slot: Slot): Slot[] {
  const out: Slot[] = [slot];
  for (const item of slot.items) {
    if (item.kind === "fraction") {
      out.push(...allSlots(item.numerator), ...allSlots(item.denominator));
    } else if (item.kind === "root") {
      if (item.index) out.push(...allSlots(item.index));
      out.push(...allSlots(item.radicand));
    } else if (item.kind === "power") {
      out.push(...allSlots(item.base), ...allSlots(item.exponent));
    }
  }
  return out;
}

/** The core grammar check for a single slot's item list (see header). */
function slotViolation(items: Item[]): string | null {
  const structures = items.filter((it) => it.kind !== "token");
  if (structures.length === 0) return null; // all tokens (or empty) — fine
  if (structures.length > 1) {
    return `two+ values in one slot (${structures.map((s) => s.kind).join(",")})`;
  }
  const s = structures[0];
  const idx = items.indexOf(s);
  if (s.kind === "power") {
    // A power is always ALONE at its level. `12^3` lives as base="12" INSIDE the
    // power, never as tokens beside it — so a token beside a power is `1·3²`.
    return items.length === 1 ? null : "a token sits adjacent to a power";
  }
  // Fractions and roots may be preceded by tokens (mixed number / coefficient)
  // but nothing may follow them (`2 ½ 3`, `3√7 2`).
  return idx === items.length - 1 ? null : "a value sits to the right of a fraction";
}

function structuralViolation(state: ExpressionTemplateState): string | null {
  for (const slot of allSlots(state.root)) {
    const v = slotViolation(slot.items);
    if (v) return `slot ${slot.id}: ${v} [${describeItems(slot.items)}]`;
  }
  return null;
}

function describeItems(items: Item[]): string {
  return items
    .map((it) => (it.kind === "token" ? it.value : it.kind === "power" ? "P" : it.kind === "root" ? "R" : "F"))
    .join("");
}

function caretViolation(state: ExpressionTemplateState): string | null {
  const active = allSlots(state.root).find((s) => s.id === state.activeSlotId);
  if (!active) return `activeSlotId ${state.activeSlotId} resolves to no slot`;
  if (state.caretIndex < 0 || state.caretIndex > active.items.length) {
    return `caretIndex ${state.caretIndex} out of [0, ${active.items.length}]`;
  }
  return null;
}

function bracesBalanced(latex: string): boolean {
  let depth = 0;
  for (const ch of latex) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

// A small deterministic PRNG so a failing fuzz run is exactly reproducible.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Step =
  | { kind: "key"; key: string }
  | { kind: "glyphFraction" }
  | { kind: "glyphPower" }
  | { kind: "glyphRoot" };

const STEP_POOL: Step[] = [
  ...["1", "2", "3", "0", "9"].map((key) => ({ kind: "key", key }) as Step),
  // Characters the grammar must REJECT. Feeding them to the fuzzer proves no
  // reachable sequence can smuggle an operator (or a decimal point / stray
  // letter) into the tree — where it would masquerade as a digit and corrupt
  // both the smart-grab boundary and the completeness gate.
  ...["+", "-", "*", "×", ".", "y", " "].map((key) => ({ kind: "key", key }) as Step),
  { kind: "key", key: "x" },
  { kind: "key", key: "/" },
  { kind: "key", key: "^" },
  { kind: "key", key: "Backspace" },
  { kind: "key", key: "Tab" },
  { kind: "key", key: "ShiftTab" },
  { kind: "key", key: "ArrowLeft" },
  { kind: "key", key: "ArrowRight" },
  { kind: "key", key: "ArrowUp" },
  { kind: "key", key: "ArrowDown" },
  { kind: "glyphFraction" },
  { kind: "glyphPower" },
  { kind: "glyphRoot" },
];

/** Every token in the tree must be a VALUE character (digit or `x`) — never an
 *  operator, which the grammar cannot represent (see `isInsertableChar`). */
function charsetViolation(state: ExpressionTemplateState): string | null {
  for (const slot of allSlots(state.root)) {
    for (const item of slot.items) {
      if (item.kind === "token" && !/^[0-9x]$/.test(item.value)) {
        return `slot ${slot.id} holds a non-value token ${JSON.stringify(item.value)}`;
      }
    }
  }
  return null;
}

function applyStep(state: ExpressionTemplateState, step: Step): ExpressionTemplateState {
  if (step.kind === "glyphFraction") return expressionTemplateInsertEmptyFraction(state);
  if (step.kind === "glyphPower") return expressionTemplateInsertExponent(state);
  if (step.kind === "glyphRoot") return expressionTemplateInsertRoot(state);
  return expressionTemplateApplyKey(state, step.key);
}

function stepLabel(step: Step): string {
  if (step.kind === "glyphFraction") return "[frac-glyph]";
  if (step.kind === "glyphPower") return "[pow-glyph]";
  if (step.kind === "glyphRoot") return "[root-glyph]";
  return step.key;
}

describe("expression editor — global invariants under random keystroke fuzzing", () => {
  it("no reachable keystroke sequence violates the structural / caret / serialization invariants", () => {
    const TRIALS = 600;
    const STEPS = 60;
    for (let t = 0; t < TRIALS; t++) {
      const rng = makeRng(0xc0ffee + t * 2654435761);
      let state = createExpressionTemplateState("");
      const journey: string[] = [];
      for (let i = 0; i < STEPS; i++) {
        const step = STEP_POOL[Math.floor(rng() * STEP_POOL.length)];
        journey.push(stepLabel(step));
        state = applyStep(state, step);

        const ctx = `trial ${t}, step ${i}, journey: ${journey.join(" ")}`;

        const caretV = caretViolation(state);
        expect(caretV, `CARET INVARIANT — ${ctx}\n${caretV}`).toBeNull();

        const structV = structuralViolation(state);
        expect(structV, `STRUCTURAL INVARIANT — ${ctx}\n${structV}`).toBeNull();

        const charV = charsetViolation(state);
        expect(charV, `CHARSET INVARIANT — ${ctx}\n${charV}`).toBeNull();

        // Serialization must never throw and must stay well-formed.
        const latex = expressionTemplateToLatex(state);
        expect(bracesBalanced(latex), `LATEX BRACES — ${ctx}\n${latex}`).toBe(true);

        const submission = expressionTemplateToSubmission(state);
        const complete = expressionTemplateIsComplete(state);
        // Submission is non-empty IFF the expression is complete (no holes).
        expect(
          submission.length > 0,
          `SUBMISSION↔COMPLETE — ${ctx}\ncomplete=${complete} submission=${JSON.stringify(submission)}`,
        ).toBe(complete);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Named, concrete regressions for the exact class the fuzzer flushed out
// (a value built ADJACENT to another value → implicit-multiply nonsense). These
// read as documentation; the fuzzer above proves the property holds for ALL
// reachable sequences, these pin the canonical cases by name.
// ──────────────────────────────────────────────────────────────────────────

function drive(steps: Array<string | "frac" | "pow" | "root">): ExpressionTemplateState {
  let state = createExpressionTemplateState("");
  for (const s of steps) {
    if (s === "frac") state = expressionTemplateInsertEmptyFraction(state);
    else if (s === "pow") state = expressionTemplateInsertExponent(state);
    else if (s === "root") state = expressionTemplateInsertRoot(state);
    else state = expressionTemplateApplyKey(state, s);
  }
  return state;
}

/** The root slot's shape as a compact string: tokens verbatim, F = fraction, P = power. */
function rootShape(state: ExpressionTemplateState): string {
  return describeItems(state.root.items);
}

describe("expression editor — structural grammar (no implicit multiplication)", () => {
  it("a power cannot be built to the RIGHT of a fraction (`1/2 · 3²` nonsense)", () => {
    // Build ½, drop the caret to the right of it, then try to add a power.
    const state = drive(["1", "/", "2", "ArrowRight", "pow"]);
    // Caret-right out of the denominator lands after the fraction; the power insert
    // must be a no-op, leaving a lone fraction.
    expect(rootShape(state)).toBe("F");
    expect(structuralViolation(state)).toBeNull();
  });

  it("a fraction cannot be built to the RIGHT of a fraction", () => {
    const state = drive(["1", "/", "2", "ArrowRight", "frac"]);
    expect(rootShape(state)).toBe("F");
    expect(structuralViolation(state)).toBeNull();
  });

  it("a fraction cannot be built adjacent to a power", () => {
    const state = drive(["3", "^", "2", "ArrowRight", "frac"]);
    expect(rootShape(state)).toBe("P");
    expect(structuralViolation(state)).toBeNull();
  });

  it("a whole number to the LEFT of a fraction stays legal — that's a mixed number", () => {
    // `2` then the fraction GLYPH (no grab) → `2 ▢/▢`, then fill it: 2½.
    const state = drive(["2", "frac", "1", "ArrowDown", "2"]);
    expect(rootShape(state)).toBe("2F"); // token then fraction, fraction last
    expect(structuralViolation(state)).toBeNull();
    expect(expressionTemplateToSubmission(state)).toBe("2 1/2");
  });

  it("a coefficient to the LEFT of a root stays legal and round-trips", () => {
    const state = drive(["3", "root", "2", "ArrowDown", "7"]);
    expect(rootShape(state)).toBe("3R");
    expect(structuralViolation(state)).toBeNull();
    expect(expressionTemplateToSubmission(state)).toBe("3√7");
    expect(expressionTemplateToLatex(state)).toBe("3\\sqrt{7}");
  });

  it("no digit can be typed to the right of a fraction (would read as `1/23`)", () => {
    const state = drive(["1", "/", "2", "ArrowRight", "9"]);
    expect(rootShape(state)).toBe("F");
    expect(structuralViolation(state)).toBeNull();
  });

  it("no digit can be typed to the LEFT of a power (would read as `13²`)", () => {
    // Build 3², walk the caret to the far left (root, before the power), type 1.
    const state = drive(["3", "^", "2", "ArrowLeft", "ArrowLeft", "ArrowLeft", "1"]);
    expect(rootShape(state)).toBe("P");
    expect(structuralViolation(state)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Charset: only VALUE characters may enter the tree. The grammar has no operator
// item yet, so an operator token would masquerade as a digit — breaking the
// smart-grab boundary (`1+2/3` → `(1+2)/3`) and the completeness gate (`"2*"`
// submitting as a finished answer). Both key surfaces filter to this set too;
// the model enforces it so a future caller can't reintroduce the hole.
// ──────────────────────────────────────────────────────────────────────────
describe("expression editor — charset (operators are not representable yet)", () => {
  for (const ch of ["+", "-", "*", "×", "÷", ".", "y", "!", " "]) {
    it(`rejects ${JSON.stringify(ch)} as a token`, () => {
      const state = drive(["2", ch, "3"]);
      expect(rootShape(state)).toBe("23"); // the operator never lands
      expect(charsetViolation(state)).toBeNull();
    });
  }

  it("accepts digits and the variable x", () => {
    const state = drive(["2", "x"]);
    expect(rootShape(state)).toBe("2x");
    expect(charsetViolation(state)).toBeNull();
  });

  it("`1+2/3` cannot become `(1+2)/3` — the + never enters, so `/` grabs only `2`", () => {
    const state = drive(["1", "+", "2", "/", "3"]);
    // With `+` rejected the keystrokes read as `12/3`; the grab takes the whole
    // digit run. The point is the ASSERTION that no operator silently widened the
    // numerator — `slotToLatex` must never contain a `+`.
    expect(expressionTemplateToLatex(state)).not.toContain("+");
    expect(charsetViolation(state)).toBeNull();
  });

  it("a lone operator is not a submittable answer", () => {
    const state = drive(["*"]);
    expect(expressionTemplateIsComplete(state)).toBe(false);
    expect(expressionTemplateToSubmission(state)).toBe("");
  });

  it("a trailing operator cannot make an answer look complete", () => {
    const state = drive(["2", "*"]);
    expect(expressionTemplateToSubmission(state)).toBe("2"); // not "2*"
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Roadmap invariants (future equation atoms). Encoded as `.todo` so the
// precedent-grounded catalog is visible as planned work without a red suite.
// Full rationale + citations: review/expression-editor-invariants.html.
// ──────────────────────────────────────────────────────────────────────────
describe("expression editor — roadmap atoms (precedent-grounded, not yet implemented)", () => {
  it.todo("binary operators (+ − × ÷ =): `/` grab stops at an operator boundary (MathQuill LiveFraction)");
  it.todo("subscripts: x_a and x^b on one base merge into a single sub/sup node (MathQuill contactWeld)");
  it.todo("summation/integral: two blocks (lower/upper), Up/Down moves between them");
  it.todo("brackets / smart-fence: auto-pairing, one-sided delimiters, backspace absorbs the fence (MathLive smart-fence)");
  it.todo("matrix / array: row·col grid with Tab navigation between cells");
  it.todo("selection: shift+arrow selects a range, and typing over a selection replaces it");
  it.todo("nesting depth cap: a max script/fraction depth (MathQuill scriptDepth / MathLive isTooDeep)");
});
