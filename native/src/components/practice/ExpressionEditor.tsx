import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, useAnimatedValue, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { fonts, useColors, type Colors } from "@/theme";
import type {
  ExpressionTemplateState,
  Item,
  Slot,
  SlotId,
} from "@/lib/expressionTemplateInput";
import {
  EXPR_BOX_BORDER,
  EXPR_BOX_MARGIN_X,
  EXPR_BOX_PAD_X,
  EXPR_BOX_PAD_Y,
  EXPR_GLYPH_LINE_HEIGHT,
  expressionBoxBaselineOffset,
  expressionBoxMinSize,
  expressionRadicandFloorSize,
} from "@/lib/expressionEditorBoxMetrics";
import {
  radicalMarkGeometry,
  radicalIndexBoxSize,
  radicalMetrics,
  radicalRootPadding,
} from "@/lib/radicalGeometry";
import { rootIndexName } from "../../../vendor/shared/staticRadicals";

/**
 * The native, DIRECT-MANIPULATION expression editor — a recursive React Native
 * renderer of the `expressionTemplateInput` slot tree, the twin of the web
 * `components/practice/ExpressionEditor`.
 *
 * Why this exists (and MathView doesn't do it): SwiftMath renders a static
 * image — every empty slot is an identical `\square`, it can't show which box is
 * focused, and it can't hit-test a tap. So the INPUT surface is drawn here as
 * real RN Views with a real INSERTION BAR (caret): the model carries a
 * `caretIndex` inside the active slot, this renderer draws a blinking cyan bar
 * at that gap, and a tap places the bar at a precise position (before/after a
 * glyph by which half was tapped, or into an empty box). No "Next box", no
 * "whole fraction focused" region — focus is always a single definite point.
 *
 * Fractions stack a numerator over a denominator with a bar; powers raise the
 * exponent; the whole thing nests, and each level shrinks. MathView stays only
 * for the read-only feedback preview.
 *
 * Presentational: it owns no state. The parent passes the current template state
 * and an `onSetCaret(slotId, index)` callback; key handling (insert / backspace)
 * lives in the controls. An empty slot renders as an empty BOX — never a `□`.
 */

const FRACTION_PAD = 6;
// A fraction renders its numerator/denominator at this fraction of its own font
// size — the SAME 0.82 the web editor + stem renderer (FractionText) use, so
// each level of NESTING shrinks the boxes + text again (depth reads visually,
// not just the bar). Floored so deep nesting stays legible.
const FRAC_SCALE = 0.82;
const FRAC_MIN_FONT = 13;

function slotIsAllTokens(slot: Slot): boolean {
  return slot.items.length > 0 && slot.items.every((it) => it.kind === "token");
}

function slotText(slot: Slot): string {
  return slot.items
    .filter((it): it is Extract<Item, { kind: "token" }> => it.kind === "token")
    .map((it) => it.value)
    .join("");
}

type Ctx = {
  activeId: SlotId;
  caretIndex: number;
  onSetCaret: (id: SlotId, index: number) => void;
  colors: Colors;
  fontSize: number;
  rootPart?: "index" | "radicand";
  rootIndexValue?: string;
  /** When false (feedback / disabled), boxes are inert: no caret, no cyan focus,
   *  and taps don't move the bar — cyan must only ever mean "you can type here." */
  interactive: boolean;
};

/** The blinking insertion bar, sized to the local font. */
function Caret({ fontSize, color }: { fontSize: number; color: string }) {
  const opacity = useAnimatedValue(1);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0, duration: 0, delay: 530, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 0, delay: 530, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  const h = Math.round(fontSize * 1.15);
  // ZERO-SIZE overlay: a 0×0 wrapper with the 2px bar absolutely centered on the
  // gap (top: -h/2 off the wrapper's midline anchor), so showing/hiding/moving
  // the caret changes a slot's width AND height by nothing — the box never shifts.
  return (
    <View style={{ width: 0, height: 0 }}>
      <Animated.View
        style={{
          position: "absolute",
          left: -1,
          top: -Math.round(h / 2),
          width: 2,
          height: h,
          backgroundColor: color,
          borderRadius: 1,
          opacity,
        }}
      />
    </View>
  );
}

/** A single glyph (one character of a token run). Tapping its left/right half
 *  places the caret before/after it. */
function GlyphView({
  value,
  slotId,
  index,
  ctx,
}: {
  value: string;
  slotId: SlotId;
  index: number;
  ctx: Ctx;
}) {
  const widthRef = useRef(0);
  const text = (
    <Text
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
      style={{
        fontFamily: fonts.medium,
        fontSize: ctx.fontSize,
        lineHeight: ctx.fontSize * EXPR_GLYPH_LINE_HEIGHT,
        color: ctx.colors.charcoal,
      }}
    >
      {value}
    </Text>
  );
  if (!ctx.interactive) return text;
  return (
    <Pressable
      onPress={(e) => {
        const past = e.nativeEvent.locationX > widthRef.current / 2;
        ctx.onSetCaret(slotId, past ? index + 1 : index);
      }}
    >
      {text}
    </Pressable>
  );
}

/** Render a slot's items interleaved with the caret at the active gap. */
function slotChildren(slot: Slot, ctx: Ctx): ReactNode[] {
  const showCaret = ctx.interactive && slot.id === ctx.activeId;
  const out: ReactNode[] = [];
  for (let i = 0; i <= slot.items.length; i++) {
    if (showCaret && ctx.caretIndex === i) {
      out.push(<Caret key={`c${i}`} fontSize={ctx.fontSize} color={ctx.colors.cyan} />);
    }
    const item = slot.items[i];
    if (!item) continue;
    if (item.kind === "token") {
      out.push(<GlyphView key={`i${i}`} value={item.value} slotId={slot.id} index={i} ctx={ctx} />);
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
 *  Its whole area is a generous tap target: tapping the padding places the caret
 *  at the nearest end so a near-miss never lands in the wrong box. */
function BoxSlot({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  const active = ctx.interactive && slot.id === ctx.activeId;
  const empty = slot.items.length === 0;
  // In feedback (non-interactive) a FILLED box sheds all chrome so the answer
  // reads as a real fraction/number, not editable UI. Empty boxes keep their
  // faint outline so an incomplete answer stays legible.
  const bare = !ctx.interactive && !empty;
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
  const widthRef = useRef(0);
  return (
    <Pressable
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
      onPress={
        ctx.interactive
          ? (e) => {
              const past = e.nativeEvent.locationX > widthRef.current / 2;
              ctx.onSetCaret(slot.id, past ? slot.items.length : 0);
            }
          : undefined
      }
      disabled={!ctx.interactive}
      accessibilityRole="button"
      accessibilityLabel={`${rootLabel ? `${rootLabel}, ` : ""}${empty ? "empty answer box" : `answer box ${slotText(slot)}`}`}
      accessibilityState={{ selected: active, disabled: !ctx.interactive }}
      style={[
        styles.box,
        compact && styles.indexBox,
        {
          minWidth,
          minHeight,
          borderWidth: bw,
          borderColor: invalidRootIndex ? ctx.colors.danger : active ? ctx.colors.cyan : ctx.colors.charcoalSubtle,
          backgroundColor: invalidRootIndex ? `${ctx.colors.danger}1a` : active ? ctx.colors.cyanSubtle : "transparent",
          borderStyle: compact ? "dotted" : empty ? "dashed" : "solid",
        },
      ]}
    >
      {slotChildren(slot, ctx)}
    </Pressable>
  );
}

/** A slot carrying structure (a fraction/power/root, or a token+structure mix like a
 *  mixed number `2 ▢/▢`) — rendered inline, no box. */
function InlineSlot({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  const widthRef = useRef(0);
  return (
    <Pressable
      accessible={false}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
      onPress={
        ctx.interactive
          ? (e) => {
              const past = e.nativeEvent.locationX > widthRef.current / 2;
              ctx.onSetCaret(slot.id, past ? slot.items.length : 0);
            }
          : undefined
      }
      disabled={!ctx.interactive}
      importantForAccessibility="no"
      style={styles.inline}
    >
      {slotChildren(slot, ctx)}
    </Pressable>
  );
}

function SlotView({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  // Empty or a pure number/text leaf → one focusable box. Anything with
  // structure (a fraction / power / root, or a token+structure mix) renders inline so
  // its own inner boxes are the focus targets.
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
    <View style={styles.fraction}>
      <SlotView slot={item.numerator} ctx={inner} />
      <View
        style={[
          styles.bar,
          { backgroundColor: ctx.colors.charcoal, height: barH, borderRadius: barH / 2 },
        ]}
      />
      <SlotView slot={item.denominator} ctx={inner} />
    </View>
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
  // Raise the exponent onto the base's SHOULDER (a proportional lift that tracks
  // nesting). The base is its own slot (a fillable ▢ when empty).
  const lift = Math.round(ctx.fontSize * 0.5);
  return (
    <View style={styles.power}>
      <SlotView slot={item.base} ctx={ctx} />
      <View style={[styles.exponent, { marginTop: -lift }]}>
        <SlotView slot={item.exponent} ctx={scaled(ctx, expFont)} />
      </View>
    </View>
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
  const [radicandSize, setRadicandSize] = useState(minRadicand);
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
    <View style={styles.rootItem}>
      <View
        style={{
          paddingLeft: metrics.markWidth,
          paddingTop: rootPadding.top + indexLift,
          paddingBottom: rootPadding.bottom,
          position: "relative",
        }}
      >
        <Svg
          accessible={false}
          height={geometry.height}
          pointerEvents="none"
          style={[styles.radicandMark, { top: indexLift }]}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          width={geometry.width}
        >
          <Path
            d={geometry.path}
            fill="none"
            stroke={ctx.colors.charcoal}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={metrics.strokeWidth}
          />
        </Svg>
        {showIndex && item.index && (
          <View
            style={{
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
          </View>
        )}
        <View
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            const next = {
              minWidth: Math.ceil(width) || minRadicand.minWidth,
              minHeight: Math.ceil(height) || minRadicand.minHeight,
            };
            if (
              next.minWidth !== radicandSize.minWidth ||
              next.minHeight !== radicandSize.minHeight
            ) {
              setRadicandSize(next);
            }
          }}
        >
          <SlotView
            slot={item.radicand}
            ctx={{ ...ctx, rootPart: "radicand", rootIndexValue: indexText || "2" }}
          />
        </View>
      </View>
    </View>
  );
}

export const ExpressionEditor = memo(function ExpressionEditor({
  state,
  onSetCaret,
  fontSize = 26,
  interactive = true,
}: {
  state: ExpressionTemplateState;
  /** Tap-to-place the insertion bar at a precise gap within a slot. */
  onSetCaret: (id: SlotId, index: number) => void;
  fontSize?: number;
  /** False during feedback/disabled: render inert (no caret, no cyan, no tap). */
  interactive?: boolean;
}) {
  const colors = useColors();
  const ctx: Ctx = {
    activeId: state.activeSlotId,
    caretIndex: state.caretIndex,
    onSetCaret,
    colors,
    fontSize,
    interactive,
  };
  return (
    <View style={styles.root} accessibilityLabel="Answer builder">
      <SlotView slot={state.root} ctx={ctx} />
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 64,
    paddingVertical: 8,
  },
  box: {
    borderWidth: EXPR_BOX_BORDER,
    borderRadius: 8,
    paddingHorizontal: EXPR_BOX_PAD_X,
    paddingVertical: EXPR_BOX_PAD_Y,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: EXPR_BOX_MARGIN_X,
  },
  indexBox: {
    marginHorizontal: 0,
    paddingHorizontal: 1,
    paddingVertical: 1,
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
  },
  fraction: {
    flexDirection: "column",
    alignItems: "center",
    marginHorizontal: 3,
    paddingHorizontal: 2,
  },
  bar: {
    height: 2,
    alignSelf: "stretch",
    marginVertical: FRACTION_PAD - 3,
    borderRadius: 1,
  },
  power: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  rootItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginHorizontal: 2,
  },
  radicandMark: {
    left: 0,
    position: "absolute",
    top: 0,
  },
  exponent: {
    marginLeft: 1,
  },
});
