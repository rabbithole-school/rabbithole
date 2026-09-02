import { parseRootIndex } from "./staticRadicals";

export type SlotId = string;

export type TokenItem = { kind: "token"; value: string };
export type FractionItem = { kind: "fraction"; numerator: Slot; denominator: Slot };
export type PowerItem = { kind: "power"; base: Slot; exponent: Slot };
/** An implicit square root has no index slot; an indexed root has an editable
 * integer index slot whose blank value deliberately means 2. */
export type RootItem = { kind: "root"; index: Slot | null; radicand: Slot };
export type Item = TokenItem | FractionItem | PowerItem | RootItem;
export type Slot = { id: SlotId; items: Item[] };

export type ExpressionTemplateState = {
  root: Slot;
  activeSlotId: SlotId;
  /** The insertion bar's position WITHIN the active slot's item list: 0..items.length.
   *  A digit is inserted here (pushing later items right), backspace deletes the
   *  item to its left, and ←/→ walk it one position (descending into / ascending
   *  out of a fraction/power/root at slot boundaries). Every op keeps this in sync with
   *  `activeSlotId` so "focus" is always a definite POINT, never a whole region. */
  caretIndex: number;
  nextId: number;
  /** L1 scaffold: the answer's structure was pre-built from a server skeleton and
   *  is FIXED. The scholar only fills the empty number boxes; the structural keys
   *  (fraction / power / root) are hidden and backspace never deletes a template box. */
  structureLocked?: boolean;
};

const EMPTY_BOX = "\\square";

function newSlot(state: ExpressionTemplateState): Slot {
  const id = `slot_${state.nextId}`;
  state.nextId += 1;
  return { id, items: [] };
}

function cloneSlot(slot: Slot): Slot {
  return {
    id: slot.id,
    items: slot.items.map((item) => {
      if (item.kind === "token") return { ...item };
      if (item.kind === "fraction") {
        return {
          kind: "fraction",
          numerator: cloneSlot(item.numerator),
          denominator: cloneSlot(item.denominator),
        };
      }
      if (item.kind === "root") {
        return {
          kind: "root",
          index: item.index ? cloneSlot(item.index) : null,
          radicand: cloneSlot(item.radicand),
        };
      }
      return {
        kind: "power",
        base: cloneSlot(item.base),
        exponent: cloneSlot(item.exponent),
      };
    }),
  };
}

function mapSlot(slot: Slot, slotId: string, updater: (slot: Slot) => Slot): Slot {
  if (slot.id === slotId) return updater(slot);
  return {
    ...slot,
    items: slot.items.map((item) => {
      if (item.kind === "token") return item;
      if (item.kind === "fraction") {
        return {
          kind: "fraction",
          numerator: mapSlot(item.numerator, slotId, updater),
          denominator: mapSlot(item.denominator, slotId, updater),
        };
      }
      if (item.kind === "root") {
        return {
          kind: "root",
          index: item.index ? mapSlot(item.index, slotId, updater) : null,
          radicand: mapSlot(item.radicand, slotId, updater),
        };
      }
      return {
        kind: "power",
        base: mapSlot(item.base, slotId, updater),
        exponent: mapSlot(item.exponent, slotId, updater),
      };
    }),
  };
}

function flattenSlots(slot: Slot): SlotId[] {
  const out: SlotId[] = [slot.id];
  for (const item of slot.items) {
    if (item.kind === "fraction") {
      out.push(...flattenSlots(item.numerator), ...flattenSlots(item.denominator));
    } else if (item.kind === "root") {
      if (item.index) out.push(...flattenSlots(item.index));
      out.push(...flattenSlots(item.radicand));
    } else if (item.kind === "power") {
      out.push(...flattenSlots(item.base), ...flattenSlots(item.exponent));
    }
  }
  return out;
}

// A submitted operand needs wrapping parens only when it is COMPOUND — it
// contains a nested `/` or `^`. A plain digit-run (`12`) or single variable
// stays bare, so a simple single fraction submits as `2/3` (which the strict
// `answerType: "fraction"` grader accepts — it wants exactly `n/d`, no parens),
// while a nested operand keeps the parens the expression grader needs for
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
    // (nothing between them) serializes with a SPACE — `2 1/2`, the codebase's
    // mixed convention (shared/fractions.ts, shared/mathLatex.ts) — NOT `2(1/2)`
    // (which the arithmetic grader would read as 2×½). The fraction stays bare
    // (no wrapping parens) so the mixed reads cleanly and the grader can parse it.
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

function itemToLatex(item: Item): string {
  if (item.kind === "token") return escapeLatexText(item.value);
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
 * Why the model and not just the UI: both key surfaces (web
 * `useExpressionTemplateKeyboard`, native `NativePracticeControls`) already
 * filter to this same set, but that's two hand-maintained lists that must stay
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
 * item kind and the grammar generalizes to `value (op value)*`; see
 * review/expression-editor-invariants.html §7.
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
  let structureKind: "fraction" | "power" | "root" | null = null;
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
  return insertStructure(prev, "fraction", false);
}

/** Insert an empty n-th root at the caret. The index receives focus first; a
 * preceding digit run remains a coefficient rather than being captured. */
export function expressionTemplateInsertRoot(prev: ExpressionTemplateState): ExpressionTemplateState {
  return insertStructure(prev, "root", false, "explicit");
}

/** Insert a conventional square root. Its index is implicit and never becomes a
 * focusable box, so the common path goes directly to the radicand. */
export function expressionTemplateInsertSquareRoot(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  return insertStructure(prev, "root", false, "implicit");
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
      const inner =
        left.kind === "fraction"
          ? left.denominator
          : left.kind === "root"
            ? left.radicand
            : (left as PowerItem).exponent;
      return { ...prev, activeSlotId: inner.id, caretIndex: inner.items.length };
    }
  }

  // Caret at the START of a box. In unlocked (L3) building this UNWRAPS the
  // structure the box belongs to, so `/` and `^` are reversible with the same
  // key that built them:
  //   • empty side of an otherwise-empty fraction → delete the fraction
  //   • empty exponent of a power → "undo ^", restoring the bare base in place
  // A locked (L1) scaffold never unwraps — its structure is fixed.
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
      const item = slot.items[i];
      if (item.kind === "fraction") {
        walk(item.numerator);
        walk(item.denominator);
      } else if (item.kind === "root") {
        if (item.index) walk(item.index);
        walk(item.radicand);
      } else if (item.kind === "power") {
        walk(item.base);
        walk(item.exponent);
      }
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
  return prev;
}

/** ArrowUp: move within vertically-related fraction, power, or root boxes. */
export function expressionTemplateMoveUp(
  prev: ExpressionTemplateState,
): ExpressionTemplateState {
  const parent = findSlotParent(prev.root, prev.activeSlotId);
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
 * web keypad and the iPad keypad both call, so a keystroke means the same thing
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
  return !slotHasHoles(state.root);
}

export function expressionTemplateToSubmission(
  state: ExpressionTemplateState,
): string {
  if (!expressionTemplateIsComplete(state)) return "";
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
  if (item.kind === "token") return null;
  if (item.kind === "fraction") {
    return findSlot(item.numerator, id) ?? findSlot(item.denominator, id);
  }
  if (item.kind === "root") {
    return (item.index ? findSlot(item.index, id) : null) ?? findSlot(item.radicand, id);
  }
  return findSlot(item.base, id) ?? findSlot(item.exponent, id);
}

/** Where a given slot sits in the tree: the structural item that owns it, the
 *  slot that holds that item, its index there, and which role the slot plays
 *  (numerator / denominator / base / exponent / root index / radicand). Powers `↑`/`↓` nav and the
 *  backspace unwrap. A power's base is now a real Slot (like its exponent), so
 *  every box — including a power base — is reachable by arrow-nav and unwrap. */
type SlotParentRef = {
  container: Slot;
  index: number;
  item: FractionItem | PowerItem | RootItem;
  role: "numerator" | "denominator" | "exponent" | "base" | "index" | "radicand";
};

function findSlotParent(root: Slot, activeId: SlotId): SlotParentRef | null {
  const walk = (slot: Slot): SlotParentRef | null => {
    for (let i = 0; i < slot.items.length; i++) {
      const item = slot.items[i];
      if (item.kind === "fraction") {
        if (item.numerator.id === activeId) {
          return { container: slot, index: i, item, role: "numerator" };
        }
        if (item.denominator.id === activeId) {
          return { container: slot, index: i, item, role: "denominator" };
        }
        const r = walk(item.numerator) ?? walk(item.denominator);
        if (r) return r;
      } else if (item.kind === "root") {
        if (item.index?.id === activeId) {
          return { container: slot, index: i, item, role: "index" };
        }
        if (item.radicand.id === activeId) {
          return { container: slot, index: i, item, role: "radicand" };
        }
        const r = (item.index ? walk(item.index) : null) ?? walk(item.radicand);
        if (r) return r;
      } else if (item.kind === "power") {
        if (item.base.id === activeId) {
          return { container: slot, index: i, item, role: "base" };
        }
        if (item.exponent.id === activeId) {
          return { container: slot, index: i, item, role: "exponent" };
        }
        const r = walk(item.base) ?? walk(item.exponent);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(root);
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

/** A slot the scholar may put the cursor in. In a LOCKED L1 scaffold only the
 *  leaf number boxes are fillable: a container/inline slot that holds a
 *  structural (fraction / power / root) item is never a valid focus target, or a stray
 *  token could be typed OUTSIDE the fixed scaffold — e.g. backspacing out of an
 *  empty numerator, or clicking the fraction bar, would otherwise land focus on
 *  the root and a following digit would append there (turning `2/3` into a
 *  complete-looking but corrupt `2/35`). Unlocked (L3) building can focus any
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
 * Build an L1 scaffold from a NON-LEAKY answer skeleton the server derived from
 * the canonical answer (numbers → empty boxes). Grammar (fractions, nestable):
 *
 *   frac := 'F(' side '/' side ')'
 *   side := '_' | frac
 *
 * e.g. `5/6` → `F(_/_)`, complex `(2/3)/4` → `F(F(_/_)/_)`. The structure is
 * FIXED (`structureLocked`) and focus starts on the leftmost empty box. Returns
 * null for a skeleton that isn't a fraction shape (caller falls back to L3).
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
