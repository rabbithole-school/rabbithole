"use client";

/**
 * ExpressionEditor (web) — the DOM/Chakra twin of
 * native/src/components/practice/ExpressionEditor.tsx. A recursive renderer of
 * the SHARED `expressionTemplateInput` slot tree (shared/expressionTemplateInput.ts),
 * so the web practice surface's 2-D fraction/power/root answer editor and the iPad's
 * run the EXACT same state machine.
 *
 * Direct manipulation via a real INSERTION BAR (caret). The model carries a
 * `caretIndex` inside the active slot; this renderer draws a blinking cyan bar
 * at that gap, and a click places the bar at a precise position — before a
 * glyph, after it, or into an empty box — computed from where in the cell the
 * click landed (its horizontal midpoint). There is no "whole fraction focused"
 * region and no "Next box": focus is always a single definite point.
 *
 * Fractions stack a numerator over a denominator with a bar; powers raise the
 * exponent; the whole thing nests, and each level shrinks. An empty slot renders
 * as an empty BOX (never a literal `□` glyph) that shows the caret when active.
 *
 * Presentational: it owns no state. The parent passes the current template state
 * and an `onSetCaret(slotId, index)` callback; key handling (insert / backspace /
 * navigate) lives in the parent (PracticeSession / Placement).
 *
 * Text uses `color="inherit"` so the answer field's verdict tint (correct/miss)
 * flows through in feedback; the fraction bar uses `currentColor` to match.
 */

import { Box, chakra } from "@chakra-ui/react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import type {
  ExpressionTemplateState,
  Item,
  Slot,
  SlotId,
} from "@/shared/expressionTemplateInput";
import {
  EXPR_BOX_BORDER,
  EXPR_BOX_MARGIN_X,
  EXPR_BOX_PAD_X,
  EXPR_BOX_PAD_Y,
  expressionBoxBaselineOffset,
  expressionBoxMinSize,
  expressionRadicandFloorSize,
} from "@/shared/expressionEditorBoxMetrics";
import {
  radicalMarkGeometry,
  radicalIndexBoxSize,
  radicalMetrics,
  radicalRootPadding,
} from "@/shared/radicalGeometry";
import { rootIndexName } from "@/shared/staticRadicals";

// A faint charcoal for an inert box outline (empty/filled) — matches the warm
// neutral palette of the practice surface, distinct from the cyan focus.
const OUTLINE = "#b9b3a4";
const CYAN = "var(--chakra-colors-cyan-500, #16707e)";
const CYAN_BAR = "var(--chakra-colors-cyan-600, #0e5a66)";
const CYAN_TINT = "var(--chakra-colors-cyan-50, #e6f7f9)";
const INVALID = "var(--chakra-colors-red-500, #c53030)";
const INVALID_TINT = "var(--chakra-colors-red-50, #fff5f5)";
// A fraction renders its numerator/denominator at this fraction of its own font
// size — the SAME 0.82 the stem renderer (components/FractionText) uses, so a
// fraction reads identically whether it's in the prompt or the answer box, and
// each level of NESTING shrinks the boxes + text again (depth reads visually,
// not just the bar). Floored so deep nesting stays legible.
const FRAC_SCALE = 0.82;
const FRAC_MIN_FONT = 13;

// One injected keyframe drives every caret's blink (identical <style> content is
// deduped by the browser, so multiple editors on a page cost nothing extra).
const CARET_BLINK_CSS =
  "@keyframes rh-expr-caret{0%,49%{opacity:1}50%,100%{opacity:0}}";

function slotIsAllTokens(slot: Slot): boolean {
  return slot.items.length > 0 && slot.items.every((it) => it.kind === "token");
}

type Ctx = {
  activeId: SlotId;
  caretIndex: number;
  onSetCaret: (id: SlotId, index: number) => void;
  fontSize: number;
  /** The n-th-root sub-box this slot represents, for unambiguous assistive speech. */
  rootPart?: "index" | "radicand";
  rootIndexValue?: string;
  /** When false (feedback / disabled), boxes are inert: no caret, no cyan, and
   *  clicks don't move the bar — cyan must only ever mean "you can type here." */
  interactive: boolean;
};

/** The blinking insertion bar, sized to the local font. Rendered as a ZERO-SIZE
 *  overlay (a 0×0 wrapper with the 2px bar absolutely centered on the gap), so
 *  showing/hiding/moving the caret changes a slot's width AND height by nothing —
 *  the box never shifts (horizontally or vertically) when it becomes active. */
function Caret({ fontSize }: { fontSize: number }) {
  const h = Math.round(fontSize * 1.15);
  return (
    <chakra.span
      aria-hidden
      style={{
        position: "relative",
        display: "inline-block",
        width: 0,
        height: 0,
        flex: "0 0 0",
        alignSelf: "center",
      }}
    >
      <chakra.span
        style={{
          position: "absolute",
          left: -1,
          top: 0,
          transform: "translateY(-50%)",
          width: 2,
          height: h,
          background: CYAN_BAR,
          borderRadius: 1,
          animation: "rh-expr-caret 1.05s step-end infinite",
        }}
      />
    </chakra.span>
  );
}

/** A single glyph (one character of a token run), clickable to place the caret
 *  before or after it depending on which half of the glyph was clicked. */
function Glyph({
  value,
  slotId,
  index,
  fontSize,
  interactive,
  onSetCaret,
}: {
  value: string;
  slotId: SlotId;
  index: number;
  fontSize: number;
  interactive: boolean;
  onSetCaret: (id: SlotId, index: number) => void;
}) {
  return (
    <chakra.span
      color="inherit"
      onClick={
        interactive
          ? (e) => {
              e.stopPropagation();
              const el = e.currentTarget as HTMLElement;
              const past = e.nativeEvent.offsetX > el.offsetWidth / 2;
              onSetCaret(slotId, past ? index + 1 : index);
            }
          : undefined
      }
      style={{
        fontSize,
        fontWeight: 600,
        lineHeight: 1.1,
        cursor: interactive ? "text" : "default",
        whiteSpace: "pre",
      }}
    >
      {value}
    </chakra.span>
  );
}

/** Render a slot's items interleaved with the caret at the active gap. Tokens
 *  become per-glyph click targets; structural items own their own clicks. */
function slotChildren(slot: Slot, ctx: Ctx): React.ReactNode[] {
  const showCaret = ctx.interactive && slot.id === ctx.activeId;
  const out: React.ReactNode[] = [];
  for (let i = 0; i <= slot.items.length; i++) {
    if (showCaret && ctx.caretIndex === i) {
      out.push(<Caret key={`c${i}`} fontSize={ctx.fontSize} />);
    }
    const item = slot.items[i];
    if (!item) continue;
    if (item.kind === "token") {
      out.push(
        <Glyph
          key={`i${i}`}
          value={item.value}
          slotId={slot.id}
          index={i}
          fontSize={ctx.fontSize}
          interactive={ctx.interactive}
          onSetCaret={ctx.onSetCaret}
        />,
      );
    } else if (item.kind === "fraction") {
      out.push(<FractionView key={`i${i}`} item={item} ctx={ctx} />);
    } else if (item.kind === "root") {
      out.push(<RootView key={`i${i}`} item={item} ctx={ctx} />);
    } else {
      out.push(<PowerView key={`i${i}`} item={item} ctx={ctx} />);
    }
  }
  return out;
}

/** A leaf slot (empty, or a pure number/text run) — the bordered ANSWER BOX.
 *  Its whole area is a generous click target: clicking the padding places the
 *  caret at the nearest end so a near-miss never lands in the wrong box. */
function BoxSlot({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  const active = ctx.interactive && slot.id === ctx.activeId;
  const empty = slot.items.length === 0;
  // In feedback (non-interactive) a FILLED box sheds all chrome so the answer
  // reads as a real fraction/number, not editable UI. Empty boxes keep their
  // faint outline so an incomplete answer stays legible.
  const bare = !ctx.interactive && !empty;
  const onClick = ctx.interactive
    ? (e: React.MouseEvent) => {
        e.stopPropagation();
        // Background / padding click → nearest end by horizontal midpoint.
        const el = e.currentTarget as HTMLElement;
        const rect = el.getBoundingClientRect();
        const past = e.clientX > rect.left + rect.width / 2;
        ctx.onSetCaret(slot.id, past ? slot.items.length : 0);
      }
    : undefined;
  const bw = bare ? 0 : EXPR_BOX_BORDER;
  const compact = ctx.rootPart === "index";
  const invalidRootIndex =
    compact &&
    !empty &&
    rootIndexName(ctx.rootIndexValue) === null;
  const { minWidth, minHeight } = compact
    ? radicalIndexBoxSize(ctx.fontSize, Math.max(1, ctx.rootIndexValue?.length ?? 0))
    : expressionBoxMinSize(ctx.fontSize, bw);
  const rootLabel =
    ctx.rootPart === "index"
      ? empty
        ? "root index, blank means square root; enter an integer of 2 or greater, then select the radicand"
        : invalidRootIndex
          ? "invalid root index; enter an integer of 2 or greater"
          : "root index"
      : ctx.rootPart === "radicand"
        ? rootIndexName(ctx.rootIndexValue)
          ? `${rootIndexName(ctx.rootIndexValue)}-root radicand`
          : "root radicand"
        : "";
  return (
    <Box
      as="span"
      role="button"
      data-exprbox="1"
      aria-label={
        empty
         ? `${rootLabel ? `${rootLabel}, ` : ""}empty answer box`
         : `${rootLabel ? `${rootLabel}, ` : ""}answer box ${slot.items.map((it) => (it.kind === "token" ? it.value : "")).join("")}`
      }
      aria-pressed={active}
      onClick={onClick}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      mx={compact ? "0" : `${EXPR_BOX_MARGIN_X}px`}
      px={compact ? "1px" : `${EXPR_BOX_PAD_X}px`}
      py={compact ? "1px" : `${EXPR_BOX_PAD_Y}px`}
      color="inherit"
      style={{
        minWidth,
        minHeight,
        borderWidth: bw,
        borderStyle: compact ? "dotted" : empty ? "dashed" : "solid",
        borderColor: invalidRootIndex ? INVALID : active ? CYAN : OUTLINE,
        background: invalidRootIndex ? INVALID_TINT : active ? CYAN_TINT : "transparent",
        borderRadius: compact ? 4 : 8,
        cursor: ctx.interactive ? "text" : "default",
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      {slotChildren(slot, ctx)}
    </Box>
  );
}

/** A slot carrying structure (a fraction/power/root, or a token+structure mix like a
 *  mixed number `2 ▢/▢`) — rendered inline, no box. Its glyphs and sub-boxes are
 *  the click targets; the row itself places the caret at the nearest end. */
function InlineSlot({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  const onClick = ctx.interactive
    ? (e: React.MouseEvent) => {
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        const rect = el.getBoundingClientRect();
        const past = e.clientX > rect.left + rect.width / 2;
        ctx.onSetCaret(slot.id, past ? slot.items.length : 0);
      }
    : undefined;
  return (
    <Box
      as="span"
      onClick={onClick}
      display="inline-flex"
      alignItems="center"
      style={{ cursor: ctx.interactive ? "text" : "default" }}
    >
      {slotChildren(slot, ctx)}
    </Box>
  );
}

function SlotView({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  if (slot.items.length === 0 || slotIsAllTokens(slot)) {
    return <BoxSlot slot={slot} ctx={ctx} />;
  }
  return <InlineSlot slot={slot} ctx={ctx} />;
}

function scaled(ctx: Ctx, fontSize: number): Ctx {
  return { ...ctx, fontSize };
}

function FractionView({
  item,
  ctx,
}: {
  item: Extract<Item, { kind: "fraction" }>;
  ctx: Ctx;
}) {
  // Shrink the numerator/denominator (and everything nested inside them) one
  // step; the bar tracks the fraction's OWN size so it stays proportional.
  const innerFont = Math.max(FRAC_MIN_FONT, Math.round(ctx.fontSize * FRAC_SCALE));
  const barH = Math.max(1.5, Math.round(ctx.fontSize * 0.08));
  const inner = scaled(ctx, innerFont);
  return (
    <Box
      as="span"
      display="inline-flex"
      flexDirection="column"
      alignItems="center"
      mx="3px"
      px="2px"
    >
      <SlotView slot={item.numerator} ctx={inner} />
      <Box
        as="span"
        alignSelf="stretch"
        my="3px"
        bg="currentColor"
        style={{ height: barH, borderRadius: barH / 2 }}
      />
      <SlotView slot={item.denominator} ctx={inner} />
    </Box>
  );
}

function PowerView({
  item,
  ctx,
}: {
  item: Extract<Item, { kind: "power" }>;
  ctx: Ctx;
}) {
  const expFont = Math.max(12, Math.round(ctx.fontSize * 0.7));
  // Raise the exponent so it sits on the base's SHOULDER, reading as a power and
  // not as "base ×10". The base is its own slot (fillable ▢ when empty).
  const lift = Math.round(ctx.fontSize * 0.5);
  return (
    <Box as="span" display="inline-flex" alignItems="flex-start">
      <SlotView slot={item.base} ctx={ctx} />
      <Box as="span" style={{ marginTop: -lift, marginLeft: 1 }}>
        <SlotView slot={item.exponent} ctx={scaled(ctx, expFont)} />
      </Box>
    </Box>
  );
}

function RootView({
  item,
  ctx,
}: {
  item: Extract<Item, { kind: "root" }>;
  ctx: Ctx;
}) {
  // A blank editable index is a square root. While answering it remains visible
  // as the optional n-root control; in read-only feedback it collapses to the
  // conventional compact square-root form rather than looking incomplete.
  const showIndex = item.index !== null && (ctx.interactive || item.index.items.length > 0);
  const indexText = item.index?.items
    .filter((entry) => entry.kind === "token")
    .map((entry) => entry.value)
    .join("") ?? "";
  const metrics = radicalMetrics(ctx.fontSize, showIndex, Math.max(1, indexText.length));
  const indexFont = Math.max(11, metrics.indexFontSize);
  const rootPadding = radicalRootPadding(metrics.barInset);
  const indexLift = showIndex ? Math.round(metrics.indexBoxHeight * 0.55) : 0;
  const radicandRef = useRef<HTMLSpanElement>(null);
  const minRadicand = expressionRadicandFloorSize(ctx.fontSize);
  const leafRadicand =
    item.radicand.items.length === 0 || slotIsAllTokens(item.radicand);
  const radicandBorderWidth =
    !ctx.interactive && item.radicand.items.length > 0 ? 0 : EXPR_BOX_BORDER;
  const [radicandSize, setRadicandSize] = useState(minRadicand);
  useLayoutEffect(() => {
    const measure = () => {
      const rect = radicandRef.current?.getBoundingClientRect();
      if (rect) {
        setRadicandSize({
          minWidth: Math.ceil(rect.width) || minRadicand.minWidth,
          minHeight: Math.ceil(rect.height) || minRadicand.minHeight,
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (radicandRef.current) observer.observe(radicandRef.current);
    return () => observer.disconnect();
  }, [ctx.fontSize, item.radicand, minRadicand.minHeight, minRadicand.minWidth]);
  const geometry = radicalMarkGeometry({
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
  return (
    <Box as="span" display="inline-flex" alignItems="flex-start" mx="2px">
      <Box
        as="span"
        style={{
          display: "inline-flex",
          alignItems: "flex-start",
          paddingLeft: metrics.markWidth,
          paddingTop: rootPadding.top + indexLift,
          paddingBottom: rootPadding.bottom,
          position: "relative",
        }}
      >
        <svg
          aria-hidden
          focusable="false"
          height={geometry.height}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          width={geometry.width}
          style={{ display: "block", left: 0, pointerEvents: "none", position: "absolute", top: indexLift }}
        >
          <path
            d={geometry.path}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={metrics.strokeWidth}
          />
        </svg>
        {showIndex && item.index && (
          <chakra.span
            style={{
              display: "flex",
              left: geometry.indexAnchor.x,
              position: "absolute",
              top: geometry.indexAnchor.y,
              zIndex: 1,
            }}
          >
            <SlotView
              slot={item.index}
              ctx={{ ...ctx, fontSize: indexFont, rootPart: "index", rootIndexValue: indexText }}
            />
          </chakra.span>
        )}
        <chakra.span ref={radicandRef} style={{ display: "flex" }}>
          <SlotView
            slot={item.radicand}
            ctx={{ ...ctx, rootPart: "radicand", rootIndexValue: indexText || "2" }}
          />
        </chakra.span>
      </Box>
    </Box>
  );
}

export const ExpressionEditor = memo(function ExpressionEditor({
  state,
  onSetCaret,
  fontSize = 26,
  interactive = true,
}: {
  state: ExpressionTemplateState;
  /** Click-to-place the insertion bar at a precise gap within a slot. */
  onSetCaret: (id: SlotId, index: number) => void;
  fontSize?: number;
  /** False during feedback/disabled: render inert (no caret, no cyan, no click). */
  interactive?: boolean;
}) {
  const ctx: Ctx = {
    activeId: state.activeSlotId,
    caretIndex: state.caretIndex,
    onSetCaret,
    fontSize,
    interactive,
  };
  // Clicking the field's own padding (outside every box) drops the caret at the
  // nearest end of the ROOT slot — so "click anywhere in the field" always does
  // something sensible, never nothing.
  const onFieldClick = interactive
    ? (e: React.MouseEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const past = e.clientX > rect.left + rect.width / 2;
        onSetCaret(state.root.id, past ? state.root.items.length : 0);
      }
    : undefined;
  return (
    <Box
      display="flex"
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      minH="64px"
      py="8px"
      color="inherit"
      aria-label="Answer builder"
      onClick={onFieldClick}
      style={{ cursor: interactive ? "text" : "default" }}
    >
      <style>{CARET_BLINK_CSS}</style>
      <SlotView slot={state.root} ctx={ctx} />
    </Box>
  );
});
