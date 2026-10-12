/**
 * The vanilla-DOM renderer of the SHARED expression-template slot tree
 * (shared/expressionTemplateInput.ts) — the THIRD renderer of that one state
 * machine, alongside the web React `components/practice/ExpressionEditor` and
 * the native `native/src/components/practice/ExpressionEditor`. No React, no
 * Chakra: it builds plain DOM nodes so it can live inside a sandboxed app under
 * the strict, network-less custom-app CSP.
 *
 * Behaviour is identical to its twins by construction — it imports the same
 * slot/caret model and the same box/radical geometry helpers rather than
 * re-deriving any of it, so a fraction/power/root reads and measures the same
 * wherever a scholar meets it.
 */

import type {
  ExpressionTemplateState,
  Item,
  Slot,
  SlotId,
} from "../../expressionTemplateInput";
import {
  EXPR_BOX_BORDER,
  EXPR_BOX_MARGIN_X,
  EXPR_BOX_PAD_X,
  EXPR_BOX_PAD_Y,
  expressionBoxBaselineOffset,
  expressionBoxMinSize,
  expressionRadicandFloorSize,
} from "../../expressionEditorBoxMetrics";
import {
  radicalIndexBoxSize,
  radicalMarkGeometry,
  radicalMetrics,
  radicalRootPadding,
} from "../../radicalGeometry";
import { rootIndexName } from "../../staticRadicals";

const SVG_NS = "http://www.w3.org/2000/svg";
// Same 0.82 shrink-per-nesting-level the web + native editors use.
const FRAC_SCALE = 0.82;
const FRAC_MIN_FONT = 13;

export type RenderCtx = {
  activeId: SlotId;
  caretIndex: number;
  onSetCaret: (id: SlotId, index: number) => void;
  fontSize: number;
  interactive: boolean;
  rootPart?: "index" | "radicand";
  rootIndexValue?: string;
  /** Deferred measurements (radicands) run once the tree is attached + laid out. */
  fixups: Array<() => void>;
};

function slotIsAllTokens(slot: Slot): boolean {
  return slot.items.length > 0 && slot.items.every((it) => it.kind === "token");
}

function slotText(slot: Slot): string {
  return slot.items
    .filter((it): it is Extract<Item, { kind: "token" }> => it.kind === "token")
    .map((it) => it.value)
    .join("");
}

function px(value: number): string {
  return `${value}px`;
}

/** The blinking insertion bar — a zero-size overlay so it never shifts a box. */
function caret(fontSize: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "rh-expr-caret";
  wrap.setAttribute("aria-hidden", "true");
  const bar = document.createElement("i");
  bar.style.height = px(Math.round(fontSize * 1.15));
  wrap.appendChild(bar);
  return wrap;
}

function glyph(value: string, slotId: SlotId, index: number, ctx: RenderCtx): HTMLElement {
  const span = document.createElement("span");
  span.className = "rh-expr-glyph";
  span.style.fontSize = px(ctx.fontSize);
  span.textContent = value;
  if (ctx.interactive) {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const past = (e as MouseEvent).offsetX > el.offsetWidth / 2;
      ctx.onSetCaret(slotId, past ? index + 1 : index);
    });
  } else {
    span.style.cursor = "default";
  }
  return span;
}

function slotChildren(slot: Slot, ctx: RenderCtx): Node[] {
  const showCaret = ctx.interactive && slot.id === ctx.activeId;
  const out: Node[] = [];
  for (let i = 0; i <= slot.items.length; i++) {
    if (showCaret && ctx.caretIndex === i) out.push(caret(ctx.fontSize));
    const item = slot.items[i];
    if (!item) continue;
    if (item.kind === "token") out.push(glyph(item.value, slot.id, i, ctx));
    else if (item.kind === "fraction") out.push(fractionView(item, ctx));
    else if (item.kind === "root") out.push(rootView(item, ctx));
    else out.push(powerView(item, ctx));
  }
  return out;
}

function boxSlot(slot: Slot, ctx: RenderCtx): HTMLElement {
  const active = ctx.interactive && slot.id === ctx.activeId;
  const empty = slot.items.length === 0;
  const bare = !ctx.interactive && !empty; // filled feedback box sheds chrome
  const bw = bare ? 0 : EXPR_BOX_BORDER;
  const compact = ctx.rootPart === "index";
  const invalidRootIndex =
    compact && !empty && rootIndexName(ctx.rootIndexValue) === null;
  const { minWidth, minHeight } = compact
    ? radicalIndexBoxSize(ctx.fontSize, Math.max(1, ctx.rootIndexValue?.length ?? 0))
    : expressionBoxMinSize(ctx.fontSize, bw);

  const box = document.createElement("span");
  box.className = "rh-expr-box";
  box.setAttribute("data-exprbox", "1");
  box.setAttribute("role", "button");
  if (!empty) box.classList.add("is-filled");
  if (active) box.classList.add("is-active");
  if (compact) box.classList.add("is-index");
  if (invalidRootIndex) box.classList.add("is-invalid");
  box.setAttribute("aria-pressed", active ? "true" : "false");
  box.setAttribute(
    "aria-label",
    empty ? "empty answer box" : `answer box ${slotText(slot)}`,
  );
  Object.assign(box.style, {
    minWidth: px(minWidth),
    minHeight: px(minHeight),
    borderWidth: px(bw),
    marginLeft: compact ? "0" : px(EXPR_BOX_MARGIN_X),
    marginRight: compact ? "0" : px(EXPR_BOX_MARGIN_X),
    paddingLeft: compact ? "1px" : px(EXPR_BOX_PAD_X),
    paddingRight: compact ? "1px" : px(EXPR_BOX_PAD_X),
    paddingTop: compact ? "1px" : px(EXPR_BOX_PAD_Y),
    paddingBottom: compact ? "1px" : px(EXPR_BOX_PAD_Y),
    cursor: ctx.interactive ? "text" : "default",
  });
  if (ctx.interactive) {
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const past = (e as MouseEvent).clientX > rect.left + rect.width / 2;
      ctx.onSetCaret(slot.id, past ? slot.items.length : 0);
    });
  }
  for (const child of slotChildren(slot, ctx)) box.appendChild(child);
  return box;
}

function inlineSlot(slot: Slot, ctx: RenderCtx): HTMLElement {
  const row = document.createElement("span");
  row.className = "rh-expr-inline";
  if (ctx.interactive) {
    row.style.cursor = "text";
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const past = (e as MouseEvent).clientX > rect.left + rect.width / 2;
      ctx.onSetCaret(slot.id, past ? slot.items.length : 0);
    });
  } else {
    row.style.cursor = "default";
  }
  for (const child of slotChildren(slot, ctx)) row.appendChild(child);
  return row;
}

function slotView(slot: Slot, ctx: RenderCtx): HTMLElement {
  if (slot.items.length === 0 || slotIsAllTokens(slot)) return boxSlot(slot, ctx);
  return inlineSlot(slot, ctx);
}

function scaled(ctx: RenderCtx, fontSize: number): RenderCtx {
  return { ...ctx, fontSize };
}

function fractionView(item: Extract<Item, { kind: "fraction" }>, ctx: RenderCtx): HTMLElement {
  const innerFont = Math.max(FRAC_MIN_FONT, Math.round(ctx.fontSize * FRAC_SCALE));
  const barH = Math.max(1.5, Math.round(ctx.fontSize * 0.08));
  const inner = scaled(ctx, innerFont);
  const wrap = document.createElement("span");
  wrap.className = "rh-expr-fraction";
  wrap.appendChild(slotView(item.numerator, inner));
  const bar = document.createElement("span");
  bar.className = "rh-expr-frac-bar";
  bar.style.height = px(barH);
  bar.style.borderRadius = px(barH / 2);
  wrap.appendChild(bar);
  wrap.appendChild(slotView(item.denominator, inner));
  return wrap;
}

function powerView(item: Extract<Item, { kind: "power" }>, ctx: RenderCtx): HTMLElement {
  const expFont = Math.max(12, Math.round(ctx.fontSize * 0.7));
  const lift = Math.round(ctx.fontSize * 0.5);
  const wrap = document.createElement("span");
  wrap.className = "rh-expr-power";
  wrap.appendChild(slotView(item.base, ctx));
  const exp = document.createElement("span");
  exp.className = "rh-expr-exp";
  exp.style.marginTop = px(-lift);
  exp.appendChild(slotView(item.exponent, scaled(ctx, expFont)));
  wrap.appendChild(exp);
  return wrap;
}

function rootView(item: Extract<Item, { kind: "root" }>, ctx: RenderCtx): HTMLElement {
  const showIndex =
    item.index !== null && (ctx.interactive || item.index.items.length > 0);
  const indexText = item.index ? slotText(item.index) : "";
  const metrics = radicalMetrics(ctx.fontSize, showIndex, Math.max(1, indexText.length));
  const indexFont = Math.max(11, metrics.indexFontSize);
  const rootPadding = radicalRootPadding(metrics.barInset);
  const indexLift = showIndex ? Math.round(metrics.indexBoxHeight * 0.55) : 0;
  const minRadicand = expressionRadicandFloorSize(ctx.fontSize);
  const leafRadicand =
    item.radicand.items.length === 0 || slotIsAllTokens(item.radicand);
  const radicandBorderWidth =
    !ctx.interactive && item.radicand.items.length > 0 ? 0 : EXPR_BOX_BORDER;

  const outer = document.createElement("span");
  outer.className = "rh-expr-root";
  const inner = document.createElement("span");
  inner.className = "rh-expr-root-inner";
  Object.assign(inner.style, {
    paddingLeft: px(metrics.markWidth),
    paddingTop: px(rootPadding.top + indexLift),
    paddingBottom: px(rootPadding.bottom),
  });

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "rh-expr-root-mark");
  svg.style.top = px(indexLift);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", String(metrics.strokeWidth));
  svg.appendChild(path);
  inner.appendChild(svg);

  if (showIndex && item.index) {
    const indexWrap = document.createElement("span");
    indexWrap.className = "rh-expr-root-index";
    indexWrap.appendChild(
      slotView(item.index, {
        ...ctx,
        fontSize: indexFont,
        rootPart: "index",
        rootIndexValue: indexText,
      }),
    );
    inner.appendChild(indexWrap);
    // The anchor depends on the geometry computed in the fixup below.
    ctx.fixups.push(() => {
      indexWrap.style.left = px(rootGeometry().indexAnchor.x);
      indexWrap.style.top = px(rootGeometry().indexAnchor.y);
    });
  }

  const radicandWrap = document.createElement("span");
  radicandWrap.className = "rh-expr-root-radicand";
  radicandWrap.appendChild(
    slotView(item.radicand, {
      ...ctx,
      rootPart: "radicand",
      rootIndexValue: indexText || "2",
    }),
  );
  inner.appendChild(radicandWrap);
  outer.appendChild(inner);

  let cachedGeometry: ReturnType<typeof radicalMarkGeometry> | null = null;
  function rootGeometry(): ReturnType<typeof radicalMarkGeometry> {
    if (cachedGeometry) return cachedGeometry;
    const rect = radicandWrap.getBoundingClientRect();
    const radicandSize = {
      minWidth: Math.ceil(rect.width) || minRadicand.minWidth,
      minHeight: Math.ceil(rect.height) || minRadicand.minHeight,
    };
    cachedGeometry = radicalMarkGeometry({
      markWidth: metrics.markWidth,
      radicandWidth: radicandSize.minWidth,
      radicandHeight: radicandSize.minHeight,
      barHeight: metrics.barHeight,
      strokeWidth: metrics.strokeWidth,
      indexGutterWidth: metrics.indexGutterWidth,
      indexBoxWidth: metrics.indexBoxWidth,
      ...(leafRadicand
        ? {
            leafBaseline: {
              y:
                metrics.barInset +
                expressionBoxBaselineOffset(ctx.fontSize, radicandBorderWidth),
              fontSize: ctx.fontSize,
            },
          }
        : {}),
    });
    return cachedGeometry;
  }

  ctx.fixups.push(() => {
    const geometry = rootGeometry();
    svg.setAttribute("width", String(geometry.width));
    svg.setAttribute("height", String(geometry.height));
    svg.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
    path.setAttribute("d", geometry.path);
  });
  return outer;
}

/** Build the whole field for a state. `fixups` must run after the returned node
 *  is attached to the document (radicands need layout to measure). */
export function renderExpression(
  state: ExpressionTemplateState,
  onSetCaret: (id: SlotId, index: number) => void,
  options: { fontSize?: number; interactive?: boolean } = {},
): { node: HTMLElement; fixups: Array<() => void> } {
  const fixups: Array<() => void> = [];
  const ctx: RenderCtx = {
    activeId: state.activeSlotId,
    caretIndex: state.caretIndex,
    onSetCaret,
    fontSize: options.fontSize ?? 26,
    interactive: options.interactive ?? true,
    fixups,
  };
  const field = document.createElement("div");
  field.className = "rh-expr-field";
  field.setAttribute("aria-label", "Answer builder");
  field.style.cursor = ctx.interactive ? "text" : "default";
  if (ctx.interactive) {
    field.addEventListener("click", (e) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const past = (e as MouseEvent).clientX > rect.left + rect.width / 2;
      onSetCaret(state.root.id, past ? state.root.items.length : 0);
    });
  }
  field.appendChild(slotView(state.root, ctx));
  return { node: field, fixups };
}
