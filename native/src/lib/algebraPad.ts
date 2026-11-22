/**
 * The on-screen ALGEBRA keypad's layout — which keys, in which rows — as plain
 * data, so it can be unit-tested without a renderer and the component only
 * draws it.
 *
 * Eight columns, four rows (keys 52pt tall; ≈ 60pt wide in landscape's
 * 520pt answer column, ≈ 55pt in portrait's 480pt column — above the 44pt
 * touch floor either way). The answer column's height budget is worked out
 * below and asserted in algebraPad.test.ts. The digit block sits on the left as on every number
 * pad; editing (brackets, backspace, the caret arrows) runs along the top;
 * operators and structures fill the middle and right; the palette's own keys
 * fill the free cells, so nothing sits on a mostly-empty row.
 *
 *     ┌───┬───┬───┬───┬───┬───┬───┬───┐
 *     │ 7 │ 8 │ 9 │ ( │ ) │ ⌫ │ ← │ → │
 *     │ 4 │ 5 │ 6 │ + │ − │ × │ ▭ │ ▭ⁿ│   ▭ = fraction
 *     │ 1 │ 2 │ 3 │ x │ y │ E │ x²│ √ │   E… = palette keys, in order:
 *     │ 0 │ . │ E │ E │ E │ E │   │ ⁿ√│   complex: i · logs: log▭ ln e ·
 *     └───┴───┴───┴───┴───┴───┴───┴───┘   sequence: n · solution set: ±
 *
 * There is ONE minus key. Whether it means "subtract" or "negative" depends on
 * where it is typed, exactly as on paper; the grader reads it the same way.
 * There is no ÷ key: dividing is the fraction key, which is how the answer
 * will be read back.
 */

import type { AnswerPalette } from "../../vendor/shared/practiceAnswerForm";
import type { AlgebraAnswerController } from "../../vendor/shared/useAlgebraAnswerController";
import {
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertGroup,
  expressionTemplateInsertLog,
  expressionTemplateInsertRoot,
  expressionTemplateInsertSquare,
  expressionTemplateInsertSquareRoot,
  type ExpressionTemplateState,
} from "../../vendor/shared/expressionTemplateInput";

export const ALGEBRA_PAD_COLUMNS = 8;
/** Key height and the gap between keys and rows, in points. */
export const ALGEBRA_KEY_HEIGHT = 52;
export const ALGEBRA_KEY_GAP = 8;

/** A structural key: builds a box rather than typing a character. */
export type AlgebraStructureOp = "fraction" | "power" | "square" | "sqrt" | "root" | "log" | "ln";

export type AlgebraPadKey =
  /** Types `key` through the shared key map (`expressionTemplateApplyKey`). */
  | { kind: "key"; id: string; testID: string; key: string; label: string; a11y: string }
  | { kind: "op"; id: string; testID: string; op: AlgebraStructureOp; label: string; a11y: string }
  /** An empty grid cell that keeps the columns aligned. */
  | { kind: "spacer"; id: string };

/** Stable test ids (`pad-key-…`) for the simulator scenarios. */
const KEY_SLUG: Record<string, string> = {
  "(": "open",
  ")": "close",
  "+": "plus",
  "-": "minus",
  "*": "times",
  ".": "dot",
  "±": "plusminus",
  "⌫": "backspace",
  ArrowLeft: "left",
  ArrowRight: "right",
};
const OP_SLUG: Record<AlgebraStructureOp, string> = {
  fraction: "frac",
  power: "pow",
  square: "square",
  sqrt: "sqrt",
  root: "root",
  log: "log",
  ln: "ln",
};

function key(k: string, label = k, a11y = `key ${label}`): AlgebraPadKey {
  return { kind: "key", id: `k:${k}`, testID: `pad-key-${KEY_SLUG[k] ?? k}`, key: k, label, a11y };
}

function op(o: AlgebraStructureOp, label: string, a11y: string): AlgebraPadKey {
  return { kind: "op", id: `o:${o}`, testID: `pad-key-${OP_SLUG[o]}`, op: o, label, a11y };
}

function spacer(i: number): AlgebraPadKey {
  return { kind: "spacer", id: `s:${i}` };
}

const BACKSPACE = key("⌫", "⌫", "key backspace");
const LEFT = key("ArrowLeft", "←", "move left");
const RIGHT = key("ArrowRight", "→", "move right, out of a box");
const FRACTION = op("fraction", "fraction", "insert fraction");
const POWER = op("power", "exponent", "insert exponent");
const SQUARE = op("square", "x²", "square it");
const SQRT = op("sqrt", "square root", "insert a square root");
const ROOT = op("root", "root", "insert a root with an index");
const LOG = op("log", "log", "insert a logarithm with a base");
const LN = op("ln", "ln", "insert natural log");
const PLUS_MINUS = key("±", "±", "key plus or minus");

/** The palette's own keys, in the order they fill the free cells. */
function extras(palette: AnswerPalette, solutionSet: boolean): AlgebraPadKey[] {
  const out: AlgebraPadKey[] = [];
  if (palette === "complex") out.push(key("i", "i", "key i, the imaginary unit"));
  if (palette === "logs") out.push(LOG, LN, key("e", "e", "key e"));
  if (palette === "sequence") out.push(key("n"));
  if (solutionSet) out.push(PLUS_MINUS);
  return out;
}

/** The full touch keypad, row by row, each row exactly eight cells. */
export function algebraPadRows(palette: AnswerPalette, opts: { solutionSet: boolean }): AlgebraPadKey[][] {
  const extra = extras(palette, opts.solutionSet);
  // Five free cells: one on row three, four on row four (at most four extras).
  const free = [...extra, ...Array.from({ length: 5 - extra.length }, (_, i) => spacer(i))];
  return [
    [key("7"), key("8"), key("9"), key("(", "(", "key open bracket"), key(")", ")", "key close bracket"), BACKSPACE, LEFT, RIGHT],
    [key("4"), key("5"), key("6"), key("+", "+", "key plus"), key("-", "−", "key minus"), key("*", "×", "key times"), FRACTION, POWER],
    [key("1"), key("2"), key("3"), key("x"), key("y"), free[0], SQUARE, SQRT],
    [key("0"), key(".", ".", "key decimal point"), free[1], free[2], free[3], free[4], spacer(9), ROOT],
  ];
}

/** Height of the touch keypad in points. */
export function algebraPadHeight(rows: number): number {
  return rows * ALGEBRA_KEY_HEIGHT + (rows - 1) * ALGEBRA_KEY_GAP;
}

/**
 * The iPad landscape height budget (1180 × 820pt, the smallest landscape iPad
 * the fleet runs), measured from the device review:
 *   820 screen − 80 status bar + header − 78 pinned Check lane − 52 help row
 *   (confidence chips · Hint · "I haven't learned this yet") − 24 stage padding
 *   = 586pt.
 *
 * In landscape an algebra item is laid out in TWO columns (app/practice.tsx):
 * the question — stem, worked-steps scaffold, prompt visual — on the left,
 * scrolling on its own; the answer on the right, which must fit without
 * scrolling. The right column holds, top to bottom: the answer box (or chips),
 * the form hint, a two-line form nudge, the solution-set action row, and the
 * keypad.
 */
export const LANDSCAPE_COLUMN_BUDGET = 820 - 80 - 78 - 52 - 24;

export const ALGEBRA_ANSWER_BOX_HEIGHT = 72;
export const ALGEBRA_SET_ACTIONS_HEIGHT = 44;

/** The answer column's height for an algebra item with the form hint and a
 *  two-line form nudge showing (its tallest state while answering). */
export function algebraAnswerColumnHeight(palette: AnswerPalette, opts: { solutionSet: boolean }): number {
  const innerGap = 8; // the answer stack's own gap
  const hint = 20;
  const nudge = 2 * 21;
  const setActions = opts.solutionSet ? ALGEBRA_SET_ACTIONS_HEIGHT + ALGEBRA_KEY_GAP : 0;
  const pad = algebraPadHeight(algebraPadRows(palette, opts).length);
  return ALGEBRA_ANSWER_BOX_HEIGHT + innerGap + hint + 4 + nudge + innerGap + setActions + pad;
}

/** What each structural key builds in the active answer box. */
export const ALGEBRA_STRUCTURE_OPS: Record<
  AlgebraStructureOp,
  (state: ExpressionTemplateState) => ExpressionTemplateState
> = {
  fraction: expressionTemplateInsertEmptyFraction,
  power: expressionTemplateInsertExponent,
  square: expressionTemplateInsertSquare,
  sqrt: expressionTemplateInsertSquareRoot,
  root: expressionTemplateInsertRoot,
  log: expressionTemplateInsertLog,
  ln: (state) => expressionTemplateInsertGroup(state, "ln"),
};

/** THE function an on-screen key's press runs (AlgebraPadAnswer calls only
 *  this), so tests can drive exactly what a tap does. */
export function algebraPadPress(
  controller: Pick<AlgebraAnswerController, "applyKey" | "edit">,
  key: AlgebraPadKey,
): void {
  if (key.kind === "key") controller.applyKey(key.key);
  else if (key.kind === "op") controller.edit(ALGEBRA_STRUCTURE_OPS[key.op]);
}

/** A `focusKey` suffix that means "showing a verdict": keep the answer. */
const NON_ANSWERING_PHASE = /:(?:feedback|retry|handoff|queued|breakerRepair|breakerClose)$/;

/**
 * The controller's rebuild key for a host `focusKey`: the key itself while
 * answering (so a new item or a retry rebuilds), null while a verdict shows.
 * Hosts that key by item alone (placement, the chat item) rebuild per item.
 */
export function algebraPadResetKey(focusKey: string): string | null {
  return NON_ANSWERING_PHASE.test(focusKey) ? null : focusKey;
}

/**
 * With a hardware keyboard the digits, letters and operators come from the
 * keyboard; the pad shrinks to the keys a keyboard cannot type well — the
 * structures and the palette's special keys (`e`, `i` and `n` are typeable).
 */
export function algebraHardwareKeys(palette: AnswerPalette, opts: { solutionSet: boolean }): AlgebraPadKey[] {
  const out: AlgebraPadKey[] = [FRACTION, POWER, SQUARE, SQRT, ROOT];
  if (palette === "logs") out.push(LOG, LN);
  if (opts.solutionSet) out.push(PLUS_MINUS);
  return out;
}
