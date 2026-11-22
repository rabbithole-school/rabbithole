/**
 * The 2-D answer-builder MODEL: a pure-TS slot tree plus edit operations.
 *
 * Extracted from Rabbithole (shared/expressionTemplateInput.ts), where the web
 * editor, the iPad editor and a vanilla-DOM widget all run this one state
 * machine. It imports nothing but `rootIndex.ts`, so it runs anywhere.
 */
import { parseRootIndex } from "./rootIndex";

export type SlotId = string;

export type TokenItem = { kind: "token"; value: string };
export type FractionItem = { kind: "fraction"; numerator: Slot; denominator: Slot };
export type PowerItem = { kind: "power"; base: Slot; exponent: Slot };
/** An implicit square root has no index slot; an indexed root has an editable
 * integer index slot whose blank value deliberately means 2. */
export type RootItem = { kind: "root"; index: Slot | null; radicand: Slot };
/** ALGEBRA mode only: a logarithm with a subscript base box and an argument box.
 *  An empty base means base 10 (`log(…)`). */
export type LogItem = { kind: "log"; base: Slot; argument: Slot };
/** ALGEBRA mode only: one box wrapped by a pair of delimiters. `paren` is a
 *  bracketed group (typing `(` builds it, so brackets can never be unbalanced),
 *  `ln` a natural log, `abs` an absolute value drawn as bars. */
export type GroupFn = "paren" | "ln" | "abs";
export type GroupItem = { kind: "group"; fn: GroupFn; inner: Slot };
export type Item = TokenItem | FractionItem | PowerItem | RootItem | LogItem | GroupItem;
export type Slot = { id: SlotId; items: Item[] };

/**
 * `"algebra"` widens the editor from "one number per box" to a free run of
 * algebra in every box: digits, single-letter variables, the constants i, e and
 * π, the operators + − × ±, bracketed groups, and log/ln/abs on top of the
 * fraction/power/root structures. The caller opts in per answer
 * (`createAlgebraTemplateState`); absent, every op below behaves exactly as
 * it always has.
 */
export type ExpressionEditorMode = "algebra";

export type ExpressionTemplateState = {
  /** See `ExpressionEditorMode`. Absent ⇒ the constrained number-pad grammar. */
  mode?: ExpressionEditorMode;
  root: Slot;
  activeSlotId: SlotId;
  /** The insertion bar's position WITHIN the active slot's item list: 0..items.length.
   *  A digit is inserted here (pushing later items right), backspace deletes the
   *  item to its left, and ←/→ walk it one position (descending into / ascending
   *  out of a fraction/power/root at slot boundaries). Every op keeps this in sync with
   *  `activeSlotId` so "focus" is always a definite POINT, never a whole region. */
  caretIndex: number;
  nextId: number;
  /** Locked template: the answer's structure was pre-built from a skeleton
   *  (see `expressionTemplateSeedFromSkeleton`) and is FIXED. The learner only
   *  fills the empty number boxes; the structural keys
   *  (fraction / power / root) are hidden and backspace never deletes a template box. */
  structureLocked?: boolean;
};

const EMPTY_BOX = "\\square";

function newSlot(state: ExpressionTemplateState): Slot {
  const id = `slot_${state.nextId}`;
  state.nextId += 1;
  return { id, items: [] };
}

/** A structure's boxes in VISUAL order (left-to-right, top-to-bottom). Every
 *  tree walk below goes through this one table, so a new structure kind is
 *  wired into focus order, caret walking, cloning and lookup in one place. */
export function itemSlots(item: Item): Slot[] {
  switch (item.kind) {
    case "token":
      return [];
    case "fraction":
      return [item.numerator, item.denominator];
    case "power":
      return [item.base, item.exponent];
    case "root":
      return item.index ? [item.index, item.radicand] : [item.radicand];
    case "log":
      return [item.base, item.argument];
    case "group":
      return [item.inner];
  }
}

/** Rebuild a structure with each of its boxes passed through `f`. */
function mapItemSlots(item: Item, f: (slot: Slot) => Slot): Item {
  switch (item.kind) {
    case "token":
      return item;
    case "fraction":
      return { kind: "fraction", numerator: f(item.numerator), denominator: f(item.denominator) };
    case "power":
      return { kind: "power", base: f(item.base), exponent: f(item.exponent) };
    case "root":
      return { kind: "root", index: item.index ? f(item.index) : null, radicand: f(item.radicand) };
    case "log":
      return { kind: "log", base: f(item.base), argument: f(item.argument) };
    case "group":
      return { kind: "group", fn: item.fn, inner: f(item.inner) };
  }
}

function cloneItem(item: Item): Item {
  return item.kind === "token" ? { ...item } : mapItemSlots(item, cloneSlot);
}

function cloneSlot(slot: Slot): Slot {
  return { id: slot.id, items: slot.items.map(cloneItem) };
}

function mapSlot(slot: Slot, slotId: string, updater: (slot: Slot) => Slot): Slot {
  if (slot.id === slotId) return updater(slot);
  return {
    ...slot,
    items: slot.items.map((item) => mapItemSlots(item, (child) => mapSlot(child, slotId, updater))),
  };
}

function flattenSlots(slot: Slot): SlotId[] {
  const out: SlotId[] = [slot.id];
  for (const item of slot.items) {
    for (const child of itemSlots(item)) out.push(...flattenSlots(child));
  }
  return out;
}

// A submitted operand needs wrapping parens only when it is COMPOUND — it
// contains a nested `/` or `^`. A plain digit-run (`12`) or single variable
// stays bare, so a simple single fraction submits as `2/3` (which a strict
// fraction checker accepts — it wants exactly `n/d`, no parens),
// while a nested operand keeps the parens an expression evaluator needs for
// correct precedence (`(2/3)/4`, `(2/3)^2`). Operands never contain `+ − ×`
// (the pad has no such keys), so `/` and `^` are the only precedence hazards.
function wrapIfCompound(s: string): string {
  return /[/^]/.test(s) ? `(${s})` : s;
}

/** Serialize a fraction item to `n/d`, each side wrapped only if compound. */
function fractionToExpr(item: FractionItem): string {
  const num = slotToExpr(item.numerator);
  const den = slotToExpr(item.denominator);
  if (!num || !den) return "";
  return `${wrapIfCompound(num)}/${wrapIfCompound(den)}`;
}

function itemToExpr(item: Item): string {
  if (item.kind === "token") return item.value;
  if (item.kind === "fraction") return fractionToExpr(item);
  if (item.kind === "root") {
    const index = rootIndexValue(item);
    const radicand = slotToExpr(item.radicand);
    if (!index || !radicand) return "";
    return `${rootSymbol(index)}${wrapIfCompound(radicand)}`;
  }
  // log / group exist only in algebra mode, whose serializer is
  // `algebraSlotToExpr`; reaching here would mean a mixed document.
  if (item.kind === "log" || item.kind === "group") return algebraItemToExpr(item);
  const base = slotToExpr(item.base);
  const exponent = slotToExpr(item.exponent);
  if (!base || !exponent) return "";
  return `${wrapIfCompound(base)}^${wrapIfCompound(exponent)}`;
}

function rootSymbol(index: number): string {
  if (index === 2) return "√";
  if (index === 3) return "∛";
  return `√[${index}]`;
}

/** Resolve a root's index. Blank and omitted indices both mean square root;
 * explicit indices must be safe integers of at least 2. */
export function rootIndexValue(item: RootItem): number | null {
  if (!item.index || item.index.items.length === 0) return 2;
  return parseRootIndex(slotToExpr(item.index));
}

function slotToExpr(slot: Slot): string {
  let out = "";
  for (let i = 0; i < slot.items.length; i++) {
    const item = slot.items[i];
    // MIXED NUMBER: a whole-number run immediately followed by a bare fraction
    // (nothing between them) serializes with a SPACE — `2 1/2`, the usual
    // plain-text mixed-number convention — NOT `2(1/2)` (which an arithmetic
    // evaluator would read as 2×½). The fraction stays bare (no wrapping
    // parens) so the mixed number reads cleanly and a checker can parse it.
    if (item.kind === "fraction" && i > 0 && trailingRunIsWhole(slot, i)) {
      const frac = fractionToExpr(item);
      // A SIMPLE proper fraction rides the bare space form — `2 1/2`, the mixed
      // convention. But a COMPOUND fractional part (a nested fraction or power,
      // which `fractionToExpr` parenthesizes) can't: `2 (1/3)/4` would be read as
      // 2×(1/3)/4. So make the addition EXPLICIT — `2+(1/3)/4` — which evaluates
      // to the true mixed value (2 + 1/12), the same number the kid built.
      if (frac) out += /^\d+\/\d+$/.test(frac) ? ` ${frac}` : `+${frac}`;
      continue;
    }
    out += itemToExpr(item);
  }
  return out;
}

/** Whether the contiguous token run ending at index `before` (exclusive of the
 *  item AT `before`) is a plain whole number — used to decide mixed-number join. */
function trailingRunIsWhole(slot: Slot, before: number): boolean {
  let i = before - 1;
  let sawDigit = false;
  while (i >= 0 && slot.items[i].kind === "token") {
    const v = (slot.items[i] as TokenItem).value;
    if (!/^[0-9]$/.test(v)) return false;
    sawDigit = true;
    i--;
  }
  // The run must start at the slot's beginning (a mixed number is `whole frac`
  // with nothing before the whole) — a `x/y 1/2` sequence isn't a mixed number.
  return sawDigit && i < 0;
}

const TOKEN_LATEX: Record<string, string> = {
  "*": "\\times ",
  "±": "\\pm ",
  "π": "\\pi ",
};

function itemToLatex(item: Item): string {
  if (item.kind === "token") return TOKEN_LATEX[item.value] ?? escapeLatexText(item.value);
  if (item.kind === "log") {
    const base = item.base.items.length > 0 ? `_{${slotToLatex(item.base)}}` : "";
    return `\\log${base}\\left(${slotToLatex(item.argument)}\\right)`;
  }
  if (item.kind === "group") {
    const inner = slotToLatex(item.inner);
    if (item.fn === "abs") return `\\left|${inner}\\right|`;
    return `${item.fn === "ln" ? "\\ln" : ""}\\left(${inner}\\right)`;
  }
  if (item.kind === "fraction") {
    const num = slotToLatex(item.numerator);
    const den = slotToLatex(item.denominator);
    return `\\frac{${num}}{${den}}`;
  }
  if (item.kind === "root") {
    const index = rootIndexValue(item);
    const radicand = slotToLatex(item.radicand);
    if (index === 2) return `\\sqrt{${radicand}}`;
    return index ? `\\sqrt[${index}]{${radicand}}` : `\\sqrt[${slotToLatex(item.index!)}]{${radicand}}`;
  }
  const base = slotToLatex(item.base);
  const exponent = slotToLatex(item.exponent);
  return `{${base}}^{${exponent}}`;
}

function slotToLatex(slot: Slot): string {
  if (slot.items.length === 0) return EMPTY_BOX;
  return slot.items.map(itemToLatex).join("");
}

function escapeLatexText(text: string): string {
  return text.replace(/([{}])/g, "\\$1");
}

function slotHasHoles(slot: Slot): boolean {
  if (slot.items.length === 0) return true;
  for (const item of slot.items) {
    if (item.kind === "token") continue;
    if (item.kind === "fraction") {
      if (slotHasHoles(item.numerator) || slotHasHoles(item.denominator)) return true;
      continue;
    }
    if (item.kind === "root") {
      if (!rootIndexValue(item) || slotHasHoles(item.radicand)) return true;
      continue;
    }
    if (item.kind === "log" || item.kind === "group") {
      if (algebraSlotHasHoles({ id: "", items: [item] })) return true;
      continue;
    }
    if (slotHasHoles(item.base) || slotHasHoles(item.exponent)) return true;
  }
  return false;
}

/** Split a raw string into per-CHARACTER token items. One char per item keeps
 *  the caret a simple item index, so ←/→/Backspace and click-to-place all work
 *  a single glyph at a time; serialization re-joins them, so `12` round-trips. */
function tokensFromRaw(raw: string): TokenItem[] {
  return raw
    .trim()
    .split("")
    .filter((c) => c.trim().length > 0)
    .map((value) => ({ kind: "token", value }));
}

export function createExpressionTemplateState(raw = ""): ExpressionTemplateState {
  const items = tokensFromRaw(raw);
  return {
    root: { id: "slot_0", items },
    activeSlotId: "slot_0",
    caretIndex: items.length,
    nextId: 1,
  };
}

/** An empty ALGEBRA-mode document (see `ExpressionEditorMode`). */
export function createAlgebraTemplateState(): ExpressionTemplateState {
  return { mode: "algebra", root: { id: "slot_0", items: [] }, activeSlotId: "slot_0", caretIndex: 0, nextId: 1 };
}

/** Clamp a caret index into a slot's valid range. */
function clampCaret(slot: Slot, index: number): number {
  return Math.max(0, Math.min(slot.items.length, index));
}

/**
 * The characters that may become a token. Deliberately narrow: exactly the
 * VALUE characters the pad's grammar can represent — digits and the variable
 * `x`. Everything else is rejected at the model layer, most importantly the
 * binary OPERATORS (`+ - * ×`) and the decimal point.
 *
 * Why the model and not just the UI: every key surface (the on-screen pad,
 * the hardware-keyboard capture, a web keydown handler) can filter to this
 * same set, but that's two hand-maintained lists that must stay
 * in sync with each other and with any future caller. The charset is really a
 * property of the GRAMMAR (see `slotGrammarValid`), so it belongs here, where it
 * can't be bypassed — the same "enforce it on the document, not on each entry
 * path" reasoning that closed the adjacency-nonsense class.
 *
 * Concretely, this keeps operators out of a grammar that cannot yet express
 * them. `slotGrammarValid` classifies items only as token-vs-structure, so a
 * stray `+` would read as "another digit of this number": `1+2` would look like
 * a single value, and the smart `/` grab (`trailingTokenRun`, which walks
 * token items) would swallow it — turning `1+2/3` into `(1+2)/3` instead of
 * `1 + 2/3`. Operators become insertable only when they're modeled as their own
 * item kind and the grammar generalizes to `value (op value)*`; see the
 * README's roadmap section.
 */
function isInsertableChar(c: string): boolean {
  return /^[0-9x]$/.test(c);
}

/**
 * THE pad grammar, as one predicate. This editor has no explicit ×/operator, so
 * any two "values" sitting side by side in a slot read as implicit multiplication
 * — i.e. nonsense the reader can't distinguish from a single number (`1`+`3²` =
 * "13²", `(1/2)`+`3` = "1/23", `(1/2)`+`3²` = "1/23²"). A slot's item list is
 * well-formed iff it encodes exactly ONE value:
 *   • all tokens        — the digits of a number (possibly empty), OR
 *   • tokens… + fraction — a MIXED NUMBER; the fraction must be LAST, only
 *     whole-number digits may precede it (`2 ½`), OR
 *   • a single power, ALONE — its base lives INSIDE it (`12³` = base "12"),
 *     never as digits beside it.
 *
 * Enforcing this as a POST-CONDITION on every op that adds an item (rather than
 * as a scatter of per-entry-path guards) is the durable fix for the whole
 * adjacency-nonsense class: no single code path can smuggle in an illegal shape,
 * and new operand-producing ops inherit the guarantee for free.
 */
function slotGrammarValid(items: Item[]): boolean {
  let structureCount = 0;
  let structureIndex = -1;
  let structureKind: Exclude<Item["kind"], "token"> | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "token") continue;
    structureCount += 1;
    structureIndex = i;
    structureKind = it.kind;
  }
  if (structureCount === 0) return true; // a bare number (or empty box)
  if (structureCount > 1) return false; // two values with no operator between them
  if (structureKind === "power") return items.length === 1; // a power stands alone
  // Fractions and roots may follow a coefficient/whole-number run, but must be
  // last so a second adjacent value cannot read as implicit multiplication.
  return structureIndex === items.length - 1;
}

export function expressionTemplateInsertToken(
  prev: ExpressionTemplateState,
  token: string,
): ExpressionTemplateState {
  if (prev.mode === "algebra") {
    let state = prev;
    for (const c of token) state = algebraInsertChar(state, c);
    return state;
  }
  const active = findSlot(prev.root, prev.activeSlotId);
  if (!active) return prev;
  // Defense-in-depth for locked scaffolds: never write a token into a container
  // slot (one that already holds a fraction/power/root), so a stray focus can never
  // corrupt the answer with a digit typed outside the fixed boxes.
  if (prev.structureLocked && !slotIsFocusable(active, true)) return prev;

  const chars = token.split("").filter(isInsertableChar);
  if (chars.length === 0) return prev;
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  if (parent?.item.kind === "root" && parent.role === "index") {
    if (!chars.every((char) => /^[0-9]$/.test(char))) return prev;
    const state = { ...prev, root: cloneSlot(prev.root) };
    state.root = mapSlot(state.root, state.activeSlotId, (slot) => ({
      ...slot,
      items: [
        ...slot.items.slice(0, prev.caretIndex),
        ...chars.map((value) => ({ kind: "token" as const, value })),
        ...slot.items.slice(prev.caretIndex),
      ],
    }));
    state.caretIndex = prev.caretIndex + chars.length;
    return state;
  }

  // Splice the digits into a CANDIDATE copy and accept only if the slot still
  // satisfies the pad grammar (`slotGrammarValid`). This single check replaces the
  // old left-/right-neighbour guards: it blocks a bare number landing adjacent to
  // a structure (`1`+`3²`, `(1/2)`+`3`) while still allowing a whole number to the
  // LEFT of a fraction (a mixed number, `2 ½`). Anything illegal is a no-op.
  const candidate = [...active.items];
  let caretIndex = prev.caretIndex;
  for (const c of chars) {
    candidate.splice(caretIndex, 0, { kind: "token", value: c });
    caretIndex += 1;
  }
  if (!slotGrammarValid(candidate)) return prev;

  let writeIndex = prev.caretIndex;
  const state = { ...prev, root: cloneSlot(prev.root) };
  state.root = mapSlot(state.root, state.activeSlotId, (slot) => {
    const items = [...slot.items];
    for (const c of chars) {
      items.splice(writeIndex, 0, { kind: "token", value: c });
      writeIndex += 1;
    }
    return { ...slot, items };
  });
  state.caretIndex = caretIndex;
  return state;
}

/** The maximal contiguous run of TOKEN items ending just left of the caret —
 *  the operand a smart `/` or `^` pulls up as the numerator / base. Returns the
 *  run's items and the index where it starts (so the caller can splice). */
function trailingTokenRun(slot: Slot, caretIndex: number): { items: Item[]; start: number } {
  let start = caretIndex;
  while (start > 0 && slot.items[start - 1].kind === "token") start -= 1;
  return { items: slot.items.slice(start, caretIndex), start };
}

/** Smart `/`: the trailing operand (the digit run left of the caret) becomes the
 *  numerator and the caret drops into the empty denominator — so typing `3 / 4`
 *  builds ¾ the way a kid reads it. An empty box just gets a bare skeleton with
 *  the caret in the numerator. */
export function expressionTemplateInsertFraction(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  if (prev.mode === "algebra") return algebraInsertFraction(prev, true);
  return insertStructure(prev, "fraction", true);
}

/** Smart `^`: mirror of the smart `/` — the trailing operand becomes the base
 *  and the caret drops into the empty exponent. But if the caret is ALREADY in a
 *  power's base (its exponent exists to the right), `^` must not nest a new power
 *  — it just hops into that existing exponent, exactly like ArrowUp. There are no
 *  power-towers in this pad: `3^2` with the caret in the base + `^` focuses the
 *  `2`, never `(3^▢)^2`. */
export function expressionTemplateInsertExponent(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  if (prev.mode === "algebra") return algebraInsertPower(prev, null);
  if (!prev.structureLocked) {
    const parent = findSlotParent(prev.root, prev.activeSlotId);
    if (parent && parent.item.kind === "power" && parent.role === "base") {
      return expressionTemplateMoveUp(prev);
    }
  }
  return insertStructure(prev, "power", true);
}

/** The GLYPH-button fraction: insert an empty ▢/▢ at the caret WITHOUT grabbing
 *  the operand to its left, then drop the caret into the (empty) numerator. This
 *  is what makes a MIXED NUMBER enterable — type the whole, tap the fraction
 *  glyph, fill the fraction: `2` ▢/▢ → `2 1/2`. (Hardware `/` still grabs.) */
export function expressionTemplateInsertEmptyFraction(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  if (prev.mode === "algebra") return algebraInsertFraction(prev, false);
  return insertStructure(prev, "fraction", false);
}

/** Insert an empty n-th root at the caret. The index receives focus first; a
 * preceding digit run remains a coefficient rather than being captured. */
export function expressionTemplateInsertRoot(prev: ExpressionTemplateState): ExpressionTemplateState {
  if (prev.mode === "algebra") return algebraInsertRoot(prev, "explicit");
  return insertStructure(prev, "root", false, "explicit");
}

/** Insert a conventional square root. Its index is implicit and never becomes a
 * focusable box, so the common path goes directly to the radicand. */
export function expressionTemplateInsertSquareRoot(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  if (prev.mode === "algebra") return algebraInsertRoot(prev, "implicit");
  return insertStructure(prev, "root", false, "implicit");
}

/** ALGEBRA: the `x²` shortcut — square the operand left of the caret and leave
 *  the caret AFTER the power, so `x`, `x²`, `+` reads exactly as it is written.
 *  With nothing to square, the base box opens with the 2 already in place. */
export function expressionTemplateInsertSquare(prev: ExpressionTemplateState): ExpressionTemplateState {
  if (prev.mode !== "algebra") return prev;
  return algebraInsertPower(prev, "2");
}

/** ALGEBRA: a logarithm. The caret lands in the base box; leaving it empty means
 *  base 10, and `→` or `(` moves on to the argument. */
export function expressionTemplateInsertLog(prev: ExpressionTemplateState): ExpressionTemplateState {
  if (prev.mode !== "algebra") return prev;
  return algebraInsertBuilt(prev, "none", (state) => {
    const base = newSlot(state);
    const argument = newSlot(state);
    return { item: { kind: "log", base, argument }, focus: base };
  });
}

/** ALGEBRA: `ln(▢)`, `|▢|` or a bracketed `(▢)` with the caret inside. */
export function expressionTemplateInsertGroup(
  prev: ExpressionTemplateState,
  fn: GroupFn,
): ExpressionTemplateState {
  if (prev.mode !== "algebra") return prev;
  return algebraInsertBuilt(prev, "none", (state) => {
    const inner = newSlot(state);
    return { item: { kind: "group", fn, inner }, focus: inner };
  });
}

function insertStructure(
  prev: ExpressionTemplateState,
  kind: "fraction" | "power" | "root",
  grab: boolean,
  rootMode: "explicit" | "implicit" = "explicit",
): ExpressionTemplateState {
  if (prev.structureLocked) return prev;
  const active = findSlot(prev.root, prev.activeSlotId);
  if (!active) return prev;
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  // Root indices are integer-only slots, not general expression slots.
  if (parent?.item.kind === "root" && parent.role === "index") return prev;

  const state = { ...prev, root: cloneSlot(prev.root) };
  const first = newSlot(state); // numerator / base / root index
  const second = newSlot(state); // denominator / exponent / radicand

  const run = grab ? trailingTokenRun(active, prev.caretIndex) : { items: [], start: prev.caretIndex };
  const grabbed = run.items.length > 0;
  first.items = grabbed ? run.items.map((it) => ({ ...(it as TokenItem) })) : [];

  const item: Item =
    kind === "fraction"
      ? { kind: "fraction", numerator: first, denominator: second! }
      : kind === "power"
        ? { kind: "power", base: first, exponent: second! }
        : { kind: "root", index: rootMode === "explicit" ? first : null, radicand: second! };

  // Grammar post-condition (same predicate as typing): the structure may only
  // land where the resulting slot still encodes ONE value. This blocks a fraction
  // built before a token (`½2`), a power built next to any value (`3²1`, `(1/2)3²`,
  // two structures in a row), etc. — the durable, entry-path-independent guard.
  const containerCandidate = [...active.items];
  containerCandidate.splice(run.start, grabbed ? run.items.length : 0, item);
  if (!slotGrammarValid(containerCandidate)) return prev;

  state.root = mapSlot(state.root, state.activeSlotId, (slot) => {
    const items = [...slot.items];
    // Remove the grabbed run (if any) and splice the structure in its place.
    items.splice(run.start, grabbed ? run.items.length : 0, item);
    return { ...slot, items };
  });

  // Grabbed operands route to the denominator/exponent. An n-th root always
  // begins at its index, making both boxes explicit before it can submit.
  const target = kind === "root" ? (rootMode === "explicit" ? first : second!) : grabbed ? second! : first;
  state.activeSlotId = target.id;
  state.caretIndex = target.items.length;
  return state;
}

export function expressionTemplateBackspace(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  const active = findSlot(prev.root, prev.activeSlotId);
  if (!active) return prev;

  // Delete the item immediately LEFT of the caret when it's a token (a char).
  if (prev.caretIndex > 0) {
    const left = active.items[prev.caretIndex - 1];
    if (left.kind === "token") {
      const state = { ...prev, root: cloneSlot(prev.root) };
      state.root = mapSlot(state.root, state.activeSlotId, (slot) => {
        const items = [...slot.items];
        items.splice(prev.caretIndex - 1, 1);
        return { ...slot, items };
      });
      state.caretIndex = prev.caretIndex - 1;
      return state;
    }
    // A structure sits to the left: step the caret INTO its last box so a further
    // backspace edits inside it (never silently nuking a whole fraction). Locked
    // scaffolds fall through to a plain step-back.
    if (!prev.structureLocked) {
      // The structure's LAST box: a fraction's denominator, a power's exponent,
      // a root's radicand, a log's argument, a group's inside.
      const boxes = itemSlots(left);
      const inner = boxes[boxes.length - 1];
      return { ...prev, activeSlotId: inner.id, caretIndex: inner.items.length };
    }
  }

  // ALGEBRA: backspace at the very start of a bracket / ln / |…| box removes the
  // delimiters and keeps what was inside, the way deleting "(" would on paper.
  if (prev.mode === "algebra" && prev.caretIndex === 0) {
    const parent = findSlotParent(prev.root, prev.activeSlotId);
    if (parent?.item.kind === "group") {
      const state = { ...prev, root: cloneSlot(prev.root) };
      state.root = spliceItemsAt(state.root, parent.container.id, parent.index, active.items.map(cloneItem));
      state.activeSlotId = parent.container.id;
      state.caretIndex = parent.index;
      return state;
    }
    if (
      parent?.item.kind === "log" &&
      parent.item.base.items.length === 0 &&
      parent.item.argument.items.length === 0
    ) {
      const state = { ...prev, root: cloneSlot(prev.root) };
      state.root = removeItemAt(state.root, parent.container.id, parent.index);
      state.activeSlotId = parent.container.id;
      state.caretIndex = parent.index;
      return state;
    }
  }

  // Caret at the START of a box. In unlocked building this UNWRAPS the
  // structure the box belongs to, so `/` and `^` are reversible with the same
  // key that built them:
  //   • empty side of an otherwise-empty fraction → delete the fraction
  //   • empty exponent of a power → "undo ^", restoring the bare base in place
  // A locked template never unwraps — its structure is fixed.
  if (!prev.structureLocked && prev.caretIndex === 0 && active.items.length === 0) {
    const parent = findSlotParent(prev.root, prev.activeSlotId);
    if (parent) {
      if (parent.item.kind === "fraction") {
        const other =
          parent.role === "numerator" ? parent.item.denominator : parent.item.numerator;
        if (other.items.length === 0) {
          const state = { ...prev, root: cloneSlot(prev.root) };
          state.root = removeItemAt(state.root, parent.container.id, parent.index);
          state.activeSlotId = parent.container.id;
          state.caretIndex = parent.index;
          return state;
        }
      } else if (parent.item.kind === "root") {
        if (
          (!parent.item.index || parent.item.index.items.length === 0) &&
          parent.item.radicand.items.length === 0
        ) {
          const state = { ...prev, root: cloneSlot(prev.root) };
          state.root = removeItemAt(state.root, parent.container.id, parent.index);
          state.activeSlotId = parent.container.id;
          state.caretIndex = parent.index;
          return state;
        }
        if (parent.role === "index" && parent.item.index?.items.length === 0) {
          const state = { ...prev, root: cloneSlot(prev.root) };
          state.root = mapSlot(state.root, parent.container.id, (slot) => ({
            ...slot,
            items: slot.items.map((item, i) =>
              i === parent.index && item.kind === "root" ? { ...item, index: null } : item,
            ),
          }));
          state.activeSlotId = parent.item.radicand.id;
          state.caretIndex = parent.item.radicand.items.length;
          return state;
        }
      } else if (parent.item.kind === "power") {
        if (parent.role === "exponent") {
          const state = { ...prev, root: cloneSlot(prev.root) };
          const baseItems = parent.item.base.items;
          state.root = spliceItemsAt(
            state.root,
            parent.container.id,
            parent.index,
            baseItems,
          );
          state.activeSlotId = parent.container.id;
          state.caretIndex = parent.index + baseItems.length;
          return state;
        }
        if (parent.item.exponent.items.length === 0) {
          const state = { ...prev, root: cloneSlot(prev.root) };
          state.root = removeItemAt(state.root, parent.container.id, parent.index);
          state.activeSlotId = parent.container.id;
          state.caretIndex = parent.index;
          return state;
        }
      }
    }
  }

  // Nothing to delete or unwrap here: step focus back to the previous FOCUSABLE
  // box (caret at its end). Skipping containers matters when locked — otherwise
  // an empty-numerator backspace would land focus on the root slot and a
  // following digit would be typed outside the scaffold.
  const order = flattenSlots(prev.root);
  const idx = order.indexOf(prev.activeSlotId);
  for (let i = idx - 1; i >= 0; i--) {
    const slot = findSlot(prev.root, order[i]);
    if (slot && slotIsFocusable(slot, prev.structureLocked)) {
      return { ...prev, activeSlotId: order[i], caretIndex: slot.items.length };
    }
  }
  return prev;
}

/** Whether appending a digit at a slot's end would preserve the pad grammar.
 *  Tab always lands at the end, so it must not target a structural container
 *  where the next digit would be rejected. */
function slotAcceptsTokenAtEnd(slot: Slot): boolean {
  return slotGrammarValid([...slot.items, { kind: "token", value: "0" }]);
}

/** Slot ids in visual (DFS) order that Tab can land in. In addition to honoring
 *  the locked-scaffold rule, each destination must accept a digit at its landed
 *  caret position; structural containers otherwise create a dead Tab stop. */
function focusableOrder(state: ExpressionTemplateState): SlotId[] {
  return flattenSlots(state.root).filter((id) => {
    const slot = findSlot(state.root, id);
    return (
      !!slot &&
      slotIsFocusable(slot, state.structureLocked) &&
      slotAcceptsTokenAtEnd(slot)
    );
  });
}

/** Step the active box forward/back through `focusableOrder`, caret at the
 *  landed box's end. `wrap` (Tab / Shift-Tab) cycles around the ends. */
function stepFocus(
  prev: ExpressionTemplateState,
  delta: 1 | -1,
  wrap: boolean,
): ExpressionTemplateState {
  const order = focusableOrder(prev);
  if (order.length === 0) return prev;
  const idx = order.indexOf(prev.activeSlotId);
  if (idx === -1) {
    const target = delta === 1 ? order[0] : order[order.length - 1];
    const slot = findSlot(prev.root, target)!;
    return { ...prev, activeSlotId: target, caretIndex: slot.items.length };
  }
  let next = idx + delta;
  if (wrap) next = ((next % order.length) + order.length) % order.length;
  else next = Math.max(0, Math.min(order.length - 1, next));
  if (order[next] === prev.activeSlotId) return prev;
  const slot = findSlot(prev.root, order[next])!;
  return { ...prev, activeSlotId: order[next], caretIndex: slot.items.length };
}

/** Tab: next fillable box, wrapping. */
export function expressionTemplateNextSlot(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  return stepFocus(prev, 1, true);
}

/** Shift-Tab: previous fillable box, wrapping. */
export function expressionTemplatePrevSlot(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  return stepFocus(prev, -1, true);
}

/** Every place the insertion bar can rest, in visual left-to-right order:
 *  positions 0..len WITHIN each focusable slot, interleaved with DESCENTS into a
 *  fraction/power/root's boxes. ←/→ just step through this list, so the caret walks
 *  characters inside a box AND crosses into/out of nested structure the way a
 *  real math cursor does. */
type CaretPos = { slotId: SlotId; index: number };

function caretPositions(state: ExpressionTemplateState): CaretPos[] {
  const out: CaretPos[] = [];
  const walk = (slot: Slot) => {
    const focusable = slotIsFocusable(slot, state.structureLocked);
    if (focusable) out.push({ slotId: slot.id, index: 0 });
    for (let i = 0; i < slot.items.length; i++) {
      for (const child of itemSlots(slot.items[i])) walk(child);
      if (focusable) out.push({ slotId: slot.id, index: i + 1 });
    }
  };
  walk(state.root);
  return out;
}

function stepCaret(prev: ExpressionTemplateState, delta: 1 | -1): ExpressionTemplateState {
  const positions = caretPositions(prev);
  if (positions.length === 0) return prev;
  const at = positions.findIndex(
    (p) => p.slotId === prev.activeSlotId && p.index === prev.caretIndex,
  );
  if (at === -1) {
    const p = positions[0];
    return { ...prev, activeSlotId: p.slotId, caretIndex: p.index };
  }
  const next = Math.max(0, Math.min(positions.length - 1, at + delta));
  const p = positions[next];
  if (p.slotId === prev.activeSlotId && p.index === prev.caretIndex) return prev;
  return { ...prev, activeSlotId: p.slotId, caretIndex: p.index };
}

/** ArrowRight: move the insertion bar one position right (into nested structure
 *  at a boundary); stops at the very end. */
export function expressionTemplateMoveRight(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  return stepCaret(prev, 1);
}

/** ArrowLeft: move the insertion bar one position left; stops at the very start. */
export function expressionTemplateMoveLeft(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  return stepCaret(prev, -1);
}

/** ArrowDown: move within vertically-related fraction, power, or root boxes. */
export function expressionTemplateMoveDown(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  if (parent && parent.item.kind === "fraction" && parent.role === "numerator") {
    return expressionTemplateSetActiveSlot(prev, parent.item.denominator.id);
  }
  if (parent && parent.item.kind === "power" && parent.role === "exponent") {
    return expressionTemplateSetActiveSlot(prev, parent.item.base.id);
  }
  if (parent && parent.item.kind === "root" && parent.role === "index") {
    return expressionTemplateSetActiveSlot(prev, parent.item.radicand.id);
  }
  // A log's base is a SUBSCRIPT: down from the argument drops into it.
  if (parent && parent.item.kind === "log" && parent.role === "argument") {
    return expressionTemplateSetActiveSlot(prev, parent.item.base.id);
  }
  return prev;
}

/** ArrowUp: move within vertically-related fraction, power, or root boxes. */
export function expressionTemplateMoveUp(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  if (parent && parent.item.kind === "log" && parent.role === "base") {
    return expressionTemplateSetActiveSlot(prev, parent.item.argument.id);
  }
  if (parent && parent.item.kind === "fraction" && parent.role === "denominator") {
    return expressionTemplateSetActiveSlot(prev, parent.item.numerator.id);
  }
  if (parent && parent.item.kind === "power" && parent.role === "base") {
    return expressionTemplateSetActiveSlot(prev, parent.item.exponent.id);
  }
  if (parent && parent.item.kind === "root" && parent.role === "radicand") {
    if (parent.item.index) {
      return expressionTemplateSetActiveSlot(prev, parent.item.index.id);
    }
    const state = { ...prev, root: cloneSlot(prev.root) };
    const index = newSlot(state);
    state.root = mapSlot(state.root, parent.container.id, (slot) => ({
      ...slot,
      items: slot.items.map((item, i) =>
        i === parent.index && item.kind === "root"
          ? { ...item, index }
          : item,
      ),
    }));
    state.activeSlotId = index.id;
    state.caretIndex = 0;
    return state;
  }
  return prev;
}

export function expressionTemplateToLatex(state: ExpressionTemplateState): string {
  return slotToLatex(state.root);
}

/**
 * Route a single keypress to the matching structural op — the SHARED key map the
 * on-screen keypad and the hardware keyboard both call, so a keystroke means the same thing
 * on every surface (parity, no per-client switch to drift):
 *   "⌫"/"Backspace" → backspace (delete char, or unwrap an empty structure) ·
 *   "/" → smart fraction (grab the trailing operand) · "^" → smart exponent ·
 *   "Tab"/"ShiftTab" → next/prev fillable box (wrapping) ·
 *   "ArrowRight"/"ArrowLeft" → move the insertion bar one position ·
 *   "ArrowDown"/"ArrowUp" → move between a fraction's numerator ↔ denominator ·
 *   anything else → insert as a token char (digits, variables).
 *
 * NOTE: the on-screen GLYPH buttons do NOT go through here. The FRACTION glyph
 * calls `expressionTemplateInsertEmptyFraction` (a tap inserts an empty ▢/▢,
 * never grabbing), which is what makes mixed numbers enterable. The EXPONENT
 * glyph calls `expressionTemplateInsertExponent` — the SAME grabbing op as the
 * hardware `^` (there is no "mixed exponent", so it grabs the operand as the
 * base). Only the hardware `/` and `^` keys route through here.
 */
export function expressionTemplateApplyKey(
  prev: ExpressionTemplateState,
  key: string,
): ExpressionTemplateState {
  switch (key) {
    case "\u232B":
    case "Backspace":
      return expressionTemplateBackspace(prev);
    case "/":
      return expressionTemplateInsertFraction(prev);
    case "÷":
      return prev.mode === "algebra" ? expressionTemplateInsertFraction(prev) : expressionTemplateInsertToken(prev, key);
    case "^":
      return expressionTemplateInsertExponent(prev);
    case "Tab":
      return expressionTemplateNextSlot(prev);
    case "ShiftTab":
      return expressionTemplatePrevSlot(prev);
    case "ArrowRight":
      return expressionTemplateMoveRight(prev);
    case "ArrowLeft":
      return expressionTemplateMoveLeft(prev);
    case "ArrowDown":
      return expressionTemplateMoveDown(prev);
    case "ArrowUp":
      return expressionTemplateMoveUp(prev);
    default:
      return expressionTemplateInsertToken(prev, key);
  }
}

export function expressionTemplateIsComplete(state: ExpressionTemplateState): boolean {
  if (state.mode === "algebra") return !algebraSlotHasHoles(state.root);
  return !slotHasHoles(state.root);
}

export function expressionTemplateToSubmission(
  state: ExpressionTemplateState,
): string {
  if (!expressionTemplateIsComplete(state)) return "";
  if (state.mode === "algebra") return algebraSlotToExpr(state.root);
  return slotToExpr(state.root);
}

/** Find a slot anywhere in the tree by id (depth-first over both fraction sides,
 *  power base + exponent). */
function findSlot(slot: Slot, id: SlotId): Slot | null {
  if (slot.id === id) return slot;
  for (const item of slot.items) {
    const found = findSlotInItem(item, id);
    if (found) return found;
  }
  return null;
}

function findSlotInItem(item: Item, id: SlotId): Slot | null {
  for (const child of itemSlots(item)) {
    const found = findSlot(child, id);
    if (found) return found;
  }
  return null;
}

/** Where a given slot sits in the tree: the structural item that owns it, the
 *  slot that holds that item, its index there, and which role the slot plays
 *  (numerator / denominator / base / exponent / root index / radicand). Powers `↑`/`↓` nav and the
 *  backspace unwrap. A power's base is now a real Slot (like its exponent), so
 *  every box — including a power base — is reachable by arrow-nav and unwrap. */
type SlotRole =
  | "numerator"
  | "denominator"
  | "exponent"
  | "base"
  | "index"
  | "radicand"
  | "argument"
  | "inner";

type SlotParentRef = {
  container: Slot;
  index: number;
  item: FractionItem | PowerItem | RootItem | LogItem | GroupItem;
  role: SlotRole;
};

/** The role each of a structure's boxes plays (a log's base shares the power
 *  base's role name; callers always check the item kind alongside the role). */
function slotRoles(item: Exclude<Item, TokenItem>): Array<[Slot, SlotRole]> {
  switch (item.kind) {
    case "fraction":
      return [[item.numerator, "numerator"], [item.denominator, "denominator"]];
    case "power":
      return [[item.base, "base"], [item.exponent, "exponent"]];
    case "root":
      return item.index ? [[item.index, "index"], [item.radicand, "radicand"]] : [[item.radicand, "radicand"]];
    case "log":
      return [[item.base, "base"], [item.argument, "argument"]];
    case "group":
      return [[item.inner, "inner"]];
  }
}

function findSlotParent(root: Slot, activeId: SlotId): SlotParentRef | null {
  const walk = (slot: Slot): SlotParentRef | null => {
    for (let i = 0; i < slot.items.length; i++) {
      const item = slot.items[i];
      if (item.kind === "token") continue;
      const roles = slotRoles(item);
      for (const [child, role] of roles) {
        if (child.id === activeId) return { container: slot, index: i, item, role };
      }
      for (const [child] of roles) {
        const r = walk(child);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(root);
}

/** Every structure enclosing `slotId`, innermost first. */
function ancestorRefs(root: Slot, slotId: SlotId): SlotParentRef[] {
  const out: SlotParentRef[] = [];
  let id = slotId;
  for (;;) {
    const ref = findSlotParent(root, id);
    if (!ref) return out;
    out.push(ref);
    id = ref.container.id;
  }
}

/** Remove the item at `index` from the slot named `containerId`. */
function removeItemAt(root: Slot, containerId: SlotId, index: number): Slot {
  return mapSlot(root, containerId, (slot) => ({
    ...slot,
    items: slot.items.filter((_, i) => i !== index),
  }));
}

/** Replace the item at `index` in the slot named `containerId` with zero or more
 *  items (splice). Used by the power "undo ^" unwrap: the power item is replaced
 *  in place by its base's contents (which may be empty, one token, or a nested
 *  structure). */
function spliceItemsAt(
  root: Slot,
  containerId: SlotId,
  index: number,
  replacement: Item[],
): Slot {
  return mapSlot(root, containerId, (slot) => ({
    ...slot,
    items: [...slot.items.slice(0, index), ...replacement, ...slot.items.slice(index + 1)],
  }));
}

/** A slot the learner may put the cursor in. In a LOCKED template only the
 *  leaf number boxes are fillable: a container/inline slot that holds a
 *  structural (fraction / power / root) item is never a valid focus target, or a stray
 *  token could be typed OUTSIDE the fixed scaffold — e.g. backspacing out of an
 *  empty numerator, or clicking the fraction bar, would otherwise land focus on
 *  the root and a following digit would append there (turning `2/3` into a
 *  complete-looking but corrupt `2/35`). Unlocked building can focus any
 *  slot. */
function slotIsFocusable(
  slot: Slot,
  structureLocked: boolean | undefined,
): boolean {
  if (!structureLocked) return true;
  return !slot.items.some(
    (it) => it.kind === "fraction" || it.kind === "power" || it.kind === "root",
  );
}

/** True when `slotId` names a real, currently-empty slot (an unfilled box). */
export function expressionTemplateSlotIsEmpty(
  state: ExpressionTemplateState,
  slotId: SlotId,
): boolean {
  const slot = findSlot(state.root, slotId);
  return !!slot && slot.items.length === 0;
}

function firstEmptySlotId(root: Slot): SlotId | null {
  for (const id of flattenSlots(root)) {
    const slot = findSlot(root, id);
    if (slot && slot.items.length === 0) return id;
  }
  return null;
}

/** Direct-manipulation focus: move the active box to `slotId`, caret at its END
 *  (so a following keystroke appends). A no-op (same reference) for an unknown id
 *  or the already-active slot. For placing the caret at a SPECIFIC gap (a click
 *  between two glyphs), use `expressionTemplateSetCaret`. */
export function expressionTemplateSetActiveSlot(
  prev: ExpressionTemplateState,
  slotId: SlotId,
): ExpressionTemplateState {
  const target = findSlot(prev.root, slotId);
  if (!target) return prev;
  // A locked scaffold only lets focus land on a fillable leaf box — clicking the
  // fraction bar / inline container is a no-op, never a way to type outside it.
  if (!slotIsFocusable(target, prev.structureLocked)) return prev;
  if (slotId === prev.activeSlotId && prev.caretIndex === target.items.length) return prev;
  return { ...prev, activeSlotId: slotId, caretIndex: target.items.length };
}

/** Click-to-place: drop the insertion bar at a precise position within `slotId`
 *  (index 0..items.length). Honors the locked-scaffold focus rule. */
export function expressionTemplateSetCaret(
  prev: ExpressionTemplateState,
  slotId: SlotId,
  index: number,
): ExpressionTemplateState {
  const target = findSlot(prev.root, slotId);
  if (!target) return prev;
  if (!slotIsFocusable(target, prev.structureLocked)) return prev;
  const clamped = clampCaret(target, index);
  if (slotId === prev.activeSlotId && clamped === prev.caretIndex) return prev;
  return { ...prev, activeSlotId: slotId, caretIndex: clamped };
}

/**
 * Build a locked template from a NON-LEAKY answer skeleton (numbers → empty
 * boxes) — typically derived on a server from the canonical answer, so the
 * shape is shown without the digits. Grammar (fractions, nestable):
 *
 *   frac := 'F(' side '/' side ')'
 *   side := '_' | frac
 *
 * e.g. `5/6` → `F(_/_)`, complex `(2/3)/4` → `F(F(_/_)/_)`. The structure is
 * FIXED (`structureLocked`) and focus starts on the leftmost empty box. Returns
 * null for a skeleton that isn't a fraction shape (fall back to an empty,
 * unlocked editor).
 */
export function expressionTemplateSeedFromSkeleton(
  skeleton: string,
): ExpressionTemplateState | null {
  const s = skeleton.replace(/\s+/g, "");
  let pos = 0;
  let nextId = 0;
  const newId = () => `slot_${nextId++}`;

  function parseSide(): Slot | null {
    if (s[pos] === "_") {
      pos++;
      return { id: newId(), items: [] };
    }
    if (s[pos] === "F") {
      const frac = parseFrac();
      if (!frac) return null;
      return { id: newId(), items: [frac] };
    }
    return null;
  }

  function parseFrac(): FractionItem | null {
    if (s[pos] !== "F" || s[pos + 1] !== "(") return null;
    pos += 2;
    const numerator = parseSide();
    if (!numerator || s[pos] !== "/") return null;
    pos++;
    const denominator = parseSide();
    if (!denominator || s[pos] !== ")") return null;
    pos++;
    return { kind: "fraction", numerator, denominator };
  }

  const top = parseFrac();
  if (!top || pos !== s.length) return null;
  const root: Slot = { id: newId(), items: [top] };
  const activeSlotId = firstEmptySlotId(root) ?? root.id;
  return {
    root,
    activeSlotId,
    caretIndex: 0,
    nextId,
    structureLocked: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ALGEBRA MODE
//
// The constrained pad above models "one number per box" and keeps operators out
// on purpose (see `isInsertableChar`). Algebra mode is the generalisation that
// note anticipated: operators are their own tokens, brackets are a structure
// (so they can never be unbalanced), and a box holds a free run of terms. The
// caller's checker owns whether the run is well formed; the editor only refuses
// input it cannot represent and reports `""` (incomplete) for an answer that is
// visibly unfinished.
// ═══════════════════════════════════════════════════════════════════════════

/** Binary/sign operators. `-` doubles as the negative sign: context decides,
 *  exactly as it does on paper, so the pad needs only one minus key. */
const ALGEBRA_OPERATORS = new Set(["+", "-", "*", "±"]);

function isOperatorItem(item: Item | undefined): boolean {
  return !!item && item.kind === "token" && ALGEBRA_OPERATORS.has(item.value);
}

/** Map a typed character onto the token vocabulary, or null to refuse it. */
function normalizeAlgebraChar(c: string): string | null {
  if (c === "−" || c === "–") return "-";
  if (c === "×" || c === "·" || c === "⋅") return "*";
  if (/^[A-Z]$/.test(c)) return c.toLowerCase();
  if (/^[0-9a-z.+\-*±π]$/.test(c)) return c;
  return null;
}

/** A "simple" exponent — `2`, `10`, `n`, `-3` — the shape after which typing an
 *  operator obviously means "and now back on the line" (x² + 3x). Anything
 *  richer stays where it is, so 2^(x+1) is still typeable (with brackets). */
function isSimpleExponent(items: Item[]): boolean {
  const text = items.map((it) => (it.kind === "token" ? it.value : "\u0000")).join("");
  return /^-?(?:[0-9.]+|[a-zπ])$/.test(text);
}

function algebraInsertChar(prev: ExpressionTemplateState, c: string): ExpressionTemplateState {
  if (c === "(") return algebraOpenParen(prev);
  if (c === ")") {
    return algebraCloseGroup(prev, (ref) =>
      ref.item.kind === "log" ? ref.role === "argument" : ref.item.kind === "group" && ref.item.fn !== "abs",
    );
  }
  if (c === "|") return algebraAbsBar(prev);
  const ch = normalizeAlgebraChar(c);
  if (!ch) return prev;
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  // A root's index stays an integer box.
  if (parent?.item.kind === "root" && parent.role === "index" && !/^[0-9]$/.test(ch)) return prev;
  let at: ExpressionTemplateState = prev;
  if (
    ALGEBRA_OPERATORS.has(ch) &&
    parent?.item.kind === "power" &&
    parent.role === "exponent" &&
    prev.caretIndex === parent.item.exponent.items.length &&
    isSimpleExponent(parent.item.exponent.items)
  ) {
    at = { ...prev, activeSlotId: parent.container.id, caretIndex: parent.index + 1 };
  }
  const state = { ...at, root: cloneSlot(at.root) };
  state.root = mapSlot(state.root, at.activeSlotId, (slot) => ({
    ...slot,
    items: [
      ...slot.items.slice(0, at.caretIndex),
      { kind: "token" as const, value: ch },
      ...slot.items.slice(at.caretIndex),
    ],
  }));
  state.caretIndex = at.caretIndex + 1;
  return state;
}

/** `(` opens a bracket — except in a log's base, where it means "base done,
 *  now the argument" (log₂(…) is typed: log key, 2, then the bracket). */
function algebraOpenParen(prev: ExpressionTemplateState): ExpressionTemplateState {
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  if (parent?.item.kind === "log" && parent.role === "base") {
    return { ...prev, activeSlotId: parent.item.argument.id, caretIndex: 0 };
  }
  return expressionTemplateInsertGroup(prev, "paren");
}

/** `)` (and a closing `|`) step the caret out past the nearest enclosing
 *  structure `matches` accepts, from however deep inside it the caret is. */
function algebraCloseGroup(
  prev: ExpressionTemplateState,
  matches: (ref: SlotParentRef) => boolean,
): ExpressionTemplateState {
  for (const ref of ancestorRefs(prev.root, prev.activeSlotId)) {
    if (matches(ref)) return { ...prev, activeSlotId: ref.container.id, caretIndex: ref.index + 1 };
  }
  return prev;
}

/** `|` closes the absolute value the caret is at the end of, else opens one. */
function algebraAbsBar(prev: ExpressionTemplateState): ExpressionTemplateState {
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  if (
    parent?.item.kind === "group" &&
    parent.item.fn === "abs" &&
    prev.caretIndex === parent.item.inner.items.length &&
    parent.item.inner.items.length > 0
  ) {
    return { ...prev, activeSlotId: parent.container.id, caretIndex: parent.index + 1 };
  }
  return expressionTemplateInsertGroup(prev, "abs");
}

/** The whole TERM left of the caret — back to the nearest + − × ± — which a
 *  typed `/` lifts into the numerator: `2x/` → 2x over ▢, `(x+1)/` → x+1 over ▢. */
function algebraTermRun(slot: Slot, caretIndex: number): { items: Item[]; start: number } {
  let start = caretIndex;
  while (start > 0 && !isOperatorItem(slot.items[start - 1])) start -= 1;
  return { items: slot.items.slice(start, caretIndex), start };
}

/** The single OPERAND left of the caret, which `^` raises: a digit run, one
 *  letter, or one structure. `2x^` raises only the x. */
function algebraAtomRun(slot: Slot, caretIndex: number): { items: Item[]; start: number } {
  const none = { items: [] as Item[], start: caretIndex };
  if (caretIndex === 0) return none;
  const left = slot.items[caretIndex - 1];
  if (left.kind !== "token") return { items: [left], start: caretIndex - 1 };
  if (/^[0-9.]$/.test(left.value)) {
    let start = caretIndex - 1;
    while (start > 0) {
      const it = slot.items[start - 1];
      if (it.kind !== "token" || !/^[0-9.]$/.test(it.value)) break;
      start -= 1;
    }
    return { items: slot.items.slice(start, caretIndex), start };
  }
  if (/^[a-zπ]$/.test(left.value)) return { items: [left], start: caretIndex - 1 };
  return none;
}

type AlgebraGrab = "none" | "term" | "atom";

/** Splice a freshly built structure in at the caret, optionally lifting the
 *  operand to its left into it, and put the caret where `build` says. */
function algebraInsertBuilt(
  prev: ExpressionTemplateState,
  grab: AlgebraGrab,
  build: (
    state: ExpressionTemplateState,
    grabbed: Item[],
  ) => { item: Item; focus: Slot | "after" },
): ExpressionTemplateState {
  const active = findSlot(prev.root, prev.activeSlotId);
  if (!active) return prev;
  const parent = findSlotParent(prev.root, prev.activeSlotId);
  if (parent?.item.kind === "root" && parent.role === "index") return prev;
  const run =
    grab === "term"
      ? algebraTermRun(active, prev.caretIndex)
      : grab === "atom"
        ? algebraAtomRun(active, prev.caretIndex)
        : { items: [] as Item[], start: prev.caretIndex };
  const state = { ...prev, root: cloneSlot(prev.root) };
  const built = build(state, run.items.map(cloneItem));
  state.root = mapSlot(state.root, prev.activeSlotId, (slot) => {
    const items = [...slot.items];
    items.splice(run.start, run.items.length, built.item);
    return { ...slot, items };
  });
  if (built.focus === "after") {
    state.activeSlotId = prev.activeSlotId;
    state.caretIndex = run.start + 1;
  } else {
    state.activeSlotId = built.focus.id;
    state.caretIndex = built.focus.items.length;
  }
  return state;
}

function algebraInsertFraction(prev: ExpressionTemplateState, grab: boolean): ExpressionTemplateState {
  return algebraInsertBuilt(prev, grab ? "term" : "none", (state, grabbed) => {
    const numerator = newSlot(state);
    const denominator = newSlot(state);
    // A bracketed term loses its brackets on the way up: the fraction bar
    // already groups it ((x+1)/ → x+1 over ▢).
    const only = grabbed.length === 1 ? grabbed[0] : null;
    numerator.items = only?.kind === "group" && only.fn === "paren" ? only.inner.items : grabbed;
    return {
      item: { kind: "fraction", numerator, denominator },
      focus: grabbed.length > 0 ? denominator : numerator,
    };
  });
}

/** `^` (exponentText = null) or `x²` (exponentText = "2"). `^` right after a
 *  power re-enters that power's exponent instead of stacking a tower. */
function algebraInsertPower(prev: ExpressionTemplateState, exponentText: string | null): ExpressionTemplateState {
  const active = findSlot(prev.root, prev.activeSlotId);
  if (exponentText === null && active && prev.caretIndex > 0) {
    const left = active.items[prev.caretIndex - 1];
    if (left.kind === "power") {
      return { ...prev, activeSlotId: left.exponent.id, caretIndex: left.exponent.items.length };
    }
  }
  return algebraInsertBuilt(prev, "atom", (state, grabbed) => {
    const base = newSlot(state);
    const exponent = newSlot(state);
    base.items = grabbed;
    if (exponentText !== null) {
      exponent.items = exponentText.split("").map((value) => ({ kind: "token" as const, value }));
    }
    const focus: Slot | "after" =
      exponentText !== null ? (grabbed.length > 0 ? "after" : base) : grabbed.length > 0 ? exponent : base;
    return { item: { kind: "power", base, exponent }, focus };
  });
}

function algebraInsertRoot(prev: ExpressionTemplateState, rootMode: "explicit" | "implicit"): ExpressionTemplateState {
  return algebraInsertBuilt(prev, "none", (state) => {
    const index = rootMode === "explicit" ? newSlot(state) : null;
    const radicand = newSlot(state);
    return { item: { kind: "root", index, radicand }, focus: index ?? radicand };
  });
}

/** Whether a box is visibly unfinished: a run that ends on an operator (`x +`),
 *  starts on a binary one (`+ x`), or has two binary operators in a row
 *  (`x + × 2`). A sign after an operator (`x × −2`, `3 ± −1`) is fine. */
function algebraRunIsUnfinished(items: Item[]): boolean {
  const first = items[0];
  if (first && first.kind === "token" && (first.value === "+" || first.value === "*")) return true;
  if (isOperatorItem(items[items.length - 1])) return true;
  for (let i = 1; i < items.length; i++) {
    const cur = items[i];
    if (isOperatorItem(items[i - 1]) && isOperatorItem(cur) && (cur as TokenItem).value !== "-") return true;
  }
  return false;
}

function algebraSlotHasHoles(slot: Slot, required = true): boolean {
  if (slot.items.length === 0) return required;
  if (algebraRunIsUnfinished(slot.items)) return true;
  for (const item of slot.items) {
    if (item.kind === "token") continue;
    if (item.kind === "root") {
      if (!rootIndexValue(item) || algebraSlotHasHoles(item.radicand)) return true;
      continue;
    }
    if (item.kind === "log") {
      // An empty base is deliberate: base 10.
      if (algebraSlotHasHoles(item.base, false) || algebraSlotHasHoles(item.argument)) return true;
      continue;
    }
    for (const child of itemSlots(item)) if (algebraSlotHasHoles(child)) return true;
  }
  return false;
}

/** A box whose serialization needs no brackets as a fraction side, a root's
 *  radicand or an exponent: one number, or one letter. */
function isBareAtom(slot: Slot): boolean {
  const text = slotText(slot);
  return /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+|[a-zπ])$/.test(text);
}

/** A fraction side, exponent or radicand the learner already bracketed. */
function isBareOperand(slot: Slot): boolean {
  if (isBareAtom(slot)) return true;
  const only = slot.items.length === 1 ? slot.items[0] : null;
  return only?.kind === "group" && only.fn === "paren";
}

/** A power's base can also stay bare when it is ONE bracket, ln or |…| group. */
function isBareBase(slot: Slot): boolean {
  if (isBareAtom(slot)) return true;
  return slot.items.length === 1 && slot.items[0].kind === "group";
}

function wrapUnless(bare: boolean, s: string): string {
  return bare ? s : `(${s})`;
}

function algebraItemToExpr(item: Exclude<Item, TokenItem>): string {
  switch (item.kind) {
    case "fraction":
      return `${wrapUnless(isBareOperand(item.numerator), algebraSlotToExpr(item.numerator))}/${wrapUnless(
        isBareOperand(item.denominator),
        algebraSlotToExpr(item.denominator),
      )}`;
    case "power":
      return `${wrapUnless(isBareBase(item.base), algebraSlotToExpr(item.base))}^${wrapUnless(
        isBareOperand(item.exponent),
        algebraSlotToExpr(item.exponent),
      )}`;
    case "root": {
      const index = rootIndexValue(item) ?? 2;
      // Only a plain number rides bare (`2√3`); every other radicand gets
      // explicit brackets, so a checker never has to guess a root's reach.
      const only = item.radicand.items.length === 1 ? item.radicand.items[0] : null;
      const radicand =
        only?.kind === "group" && only.fn === "paren"
          ? algebraSlotToExpr(only.inner)
          : algebraSlotToExpr(item.radicand);
      return `${rootSymbol(index)}${wrapUnless(/^[0-9]+(?:\.[0-9]+)?$/.test(radicand), radicand)}`;
    }
    case "log": {
      const arg = algebraSlotToExpr(item.argument);
      if (item.base.items.length === 0) return `log(${arg})`;
      return `log_${wrapUnless(isBareAtom(item.base), algebraSlotToExpr(item.base))}(${arg})`;
    }
    case "group": {
      const inner = algebraSlotToExpr(item.inner);
      if (item.fn === "ln") return `ln(${inner})`;
      if (item.fn === "abs") return `abs(${inner})`;
      return `(${inner})`;
    }
  }
}

/** A whole-number run at the start of a box followed directly by a simple
 *  numeric fraction (and then nothing, or an operator) is a MIXED NUMBER, the
 *  way it looks on screen: `2 1/2`. Anywhere else, side by side means times. */
function isAlgebraMixedNumber(items: Item[], i: number): boolean {
  const item = items[i];
  if (item.kind !== "fraction" || i === 0) return false;
  if (!/^[0-9]+$/.test(slotText(item.numerator)) || !/^[0-9]+$/.test(slotText(item.denominator))) return false;
  for (let j = 0; j < i; j++) {
    const it = items[j];
    if (it.kind !== "token" || !/^[0-9]$/.test(it.value)) return false;
  }
  const next = items[i + 1];
  return !next || isOperatorItem(next);
}

/** The text of an all-token box ("" when it holds a structure). */
function slotText(slot: Slot): string {
  return slot.items.every((it) => it.kind === "token")
    ? slot.items.map((it) => (it as TokenItem).value).join("")
    : "";
}

/**
 * Serialize an algebra box to a plain ASCII answer string (`(x+3)(x-2)`,
 * `log_2(x+1)`, `x^(2/3)`, `2√3`, `3±2i`). The output is
 * deliberately unambiguous rather than minimal: brackets appear wherever a
 * fraction, power or root meets a neighbour that could otherwise be read into
 * it, and an explicit `*` separates two numbers (`x^2*3`), two letters, a
 * letter and a following number, or anything that follows a power or root
 * (`√3*x`), so no reading of implicit multiplication can change the value the
 * learner built.
 */
function algebraSlotToExpr(slot: Slot): string {
  const items = slot.items;
  let out = "";
  let prevItem: Item | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isAlgebraMixedNumber(items, i)) {
      const frac = item as FractionItem;
      out += ` ${slotText(frac.numerator)}/${slotText(frac.denominator)}`;
      prevItem = item;
      continue;
    }
    let piece: string;
    if (item.kind === "token") {
      piece = item.value;
    } else {
      piece = algebraItemToExpr(item);
      if (item.kind === "fraction") {
        const before = items[i - 1];
        const after = items[i + 1];
        const isolated = (!before || isOperatorItem(before)) && (!after || isOperatorItem(after));
        if (!isolated) piece = `(${piece})`;
      }
    }
    out = joinAlgebra(out, piece, prevItem, item);
    prevItem = item;
  }
  return out;
}

function joinAlgebra(out: string, piece: string, prevItem: Item | undefined, item: Item): string {
  if (!out || !prevItem) return out + piece;
  if (isOperatorItem(prevItem) || isOperatorItem(item)) return out + piece;
  const l = out[out.length - 1];
  const r = piece[0];
  if (prevItem.kind === "token" && item.kind === "token") {
    // Characters of one number join (`12`, `0.5`) and a coefficient joins its
    // letter (`2x`); two letters, or a letter then a digit, get an explicit ×.
    return /[a-zπ]/.test(l) && /[0-9a-zπ]/.test(r) ? `${out}*${piece}` : out + piece;
  }
  const needsTimes =
    prevItem.kind === "power" ||
    prevItem.kind === "root" ||
    (/[0-9.]/.test(r) && /[0-9.a-zπ)]/.test(l)) ||
    (/[a-zπ]/.test(r) && /[a-zπ]/.test(l));
  return needsTimes ? `${out}*${piece}` : out + piece;
}
