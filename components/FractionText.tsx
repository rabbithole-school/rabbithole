"use client";

/**
 * FractionText (web) — renders a plain-ASCII string with any fractions in it as
 * stacked fractions (numerator over a vinculum over denominator). The DOM twin of
 * native/src/components/FractionText.tsx; both consume the SHARED direct parser
 * (shared/fractions) so web and iPad stay in visual sync.
 *
 * Fractions use flexbox; static radical roots use `MathText` / KaTeX. Pass a raw
 * stem / choice / inline snippet ("9 4/9", "2/8 + 1/8 = ?", "?/9"); ordinary
 * text renders verbatim.
 *
 * LAYOUT: the container is ordinary INLINE FLOW (a `span`), not a wrapping flex
 * row, and each fraction is an atomic `inline-flex` box aligned on the text's
 * middle. This matters for any stem long enough to wrap: a flex item is placed
 * on a flex line whole, so with `flexWrap` a run of prose between two fractions
 * could not break at its own word boundaries — it jumped to the next line
 * entirely, orphaning its leading punctuation ("Decompose 5/8 as 3/8 + 2/8" /
 * ": shade the first disc to 3/8" — Andy, 2026-08-06). Inline flow breaks at
 * word boundaries like any other prose, and UAX#14 forbids a break *before*
 * `:` / `.` / `,`, so punctuation stays welded to the fraction it follows.
 * This is also how the tutor-prose KaTeX path (components/MathText.tsx) already
 * flows, so the two math renderers now wrap identically.
 */

import { Fragment, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import {
  parsePracticeText,
  fractionsToSpeech,
  hasPracticeMath,
  type FracPart,
  type StaticRadicalNode,
} from "@/shared/fractions";
import { MathText } from "@/components/MathText";

const FRAC_SCALE = 0.82;

export function FractionText({
  value,
  fontSize = 28,
  color = "charcoal.500",
  align = "center",
  ariaLabel,
  inline = false,
  fontWeight = 600,
  lineHeight = 1.3,
}: {
  /** A plain-ASCII string, e.g. "Write 9 4/9 as ?/9". */
  value: string;
  fontSize?: number;
  color?: string;
  align?: "center" | "left";
  /** Glyph weight; defaults to the stem's 600. Table header cells pass 400. */
  fontWeight?: number;
  /** Spoken label; defaults to a "3 over 4"-style reading so a screen reader
   *  never announces the stacked glyphs as "3 slash 4". */
  ariaLabel?: string;
  /** Flow inline within surrounding prose (tutor markdown) instead of as a
   *  centered block. */
  inline?: boolean;
  /** Block line-height (unitless). Defaults to the stem's compact 1.3; the
   *  block call sites that used a plain <Text> pass their original value. */
  lineHeight?: number;
}) {
  // Only claim image semantics when the rendering actually diverges from the
  // text — i.e. there is a stacked fraction whose spoken form ("3 over 4")
  // differs from the raw glyphs. For ordinary text, fractionsToSpeech(value)
  // equals the text, so role="img" would only strip normal text semantics for
  // no gain. An explicit ariaLabel always wins (a composite caller may need it).
  const label = ariaLabel ?? (hasPracticeMath(value) ? fractionsToSpeech(value) : undefined);
  return (
    <chakra.span
      // `pre-wrap` keeps each parsed run's own leading/trailing spaces (the
      // parser hands back " as " / ": shade the first disc to ") while still
      // offering a break at every one of them; a space the line breaks at hangs
      // at the end of the line rather than indenting the next one.
      whiteSpace="pre-wrap"
      display={inline ? "inline" : "block"}
      width={inline ? undefined : "100%"}
      textAlign={inline ? undefined : align}
      color={color}
      fontWeight={fontWeight}
      role={label !== undefined ? "img" : undefined}
      aria-label={label}
      style={{ fontSize, ...(inline ? null : { lineHeight }) }}
    >
      {renderNodes(value, fontSize)}
    </chakra.span>
  );
}

/**
 * Parsed nodes → elements. The one non-obvious step: a mixed number ("9 4/9")
 * arrives as a bare-digits text node followed by its fraction, so the two are
 * handed to ONE `Frac` box — otherwise a line break could land between the
 * whole part and its stack and split the number in half.
 */
function renderNodes(value: string, fontSize: number): ReactNode[] {
  const nodes = parsePracticeText(value);
  const out: ReactNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === "frac") {
      out.push(<Frac key={i} num={n.num} den={n.den} fontSize={fontSize} />);
    } else if (n.type === "radical") {
      out.push(<Radical key={i} node={n} fontSize={fontSize} />);
    } else if (n.type === "blank") {
      out.push(<BlankSlot key={i} fontSize={fontSize} />);
    } else {
      const next = nodes[i + 1];
      if (next?.type === "frac" && /^\d+$/.test(n.value)) {
        out.push(<Frac key={i} whole={n.value} num={next.num} den={next.den} fontSize={fontSize} />);
        i++;
      } else {
        out.push(<Fragment key={i}>{n.value}</Fragment>);
      }
    }
  }
  return out;
}

/** KaTeX receives only the root; sentence punctuation remains ordinary Hanken
 * prose. Unlike native, web inline flow may break after that punctuation. */
function Radical({
  node,
  fontSize,
}: {
  node: StaticRadicalNode;
  fontSize: number;
}) {
  return (
    <>
      <MathText latex={node.latex} fontSize={fontSize} ariaLabel={node.speech} />
      {node.trailingPunctuation}
    </>
  );
}

function Frac({
  whole,
  num,
  den,
  fontSize,
}: {
  /** A mixed number's whole part, set full-size beside the stack ("9¾"). */
  whole?: string;
  num: FracPart;
  den: FracPart;
  fontSize: number;
}) {
  const inner = Math.max(12, Math.round(fontSize * FRAC_SCALE));
  const bar = Math.max(1.5, Math.round(fontSize * 0.07));
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      // `middle` puts the box's centre — the vinculum — on the parent's math
      // axis (baseline + half an x-height), the typographic home for a fraction.
      verticalAlign="middle"
      mx="2px"
    >
      {whole ? <chakra.span style={{ lineHeight: 1.15 }}>{whole}</chakra.span> : null}
      <chakra.span
        display="inline-flex"
        flexDirection="column"
        alignItems="center"
        px="3px"
        style={{ fontSize: inner, lineHeight: 1.15 }}
      >
        <chakra.span display="flex" alignItems="center" justifyContent="center" px="3px">
          <Part part={num} />
        </chakra.span>
        <chakra.span alignSelf="stretch" my="3px" bg="currentColor" style={{ height: bar, borderRadius: bar / 2 }} />
        <chakra.span display="flex" alignItems="center" justifyContent="center" px="3px">
          <Part part={den} />
        </chakra.span>
      </chakra.span>
    </chakra.span>
  );
}

function Part({ part }: { part: FracPart }) {
  if (part.blank) return <Blank />;
  return <chakra.span>{part.value}</chakra.span>;
}

/** The fill-in slot inside a fraction — sized in `em` so it tracks whatever
 *  numerator/denominator size the surrounding `Frac` established. */
function Blank() {
  return (
    <chakra.span
      display="inline-block"
      borderWidth="2px"
      borderStyle="dashed"
      borderColor="cyan.500"
      bg="cyan.50"
      mx="2px"
      aria-label="blank to fill in"
      style={{ minWidth: "1.05em", height: "1.05em", borderRadius: "0.18em" }}
    />
  );
}

/**
 * A standalone inline fill-in blank ("___" in a stem, e.g. "754 = ___ + 50 + 4").
 * Rendered as a roomy rounded fill-in slot — wider than the square fraction-part
 * Blank so it reads as an answer space in the flow of an equation. Shares the
 * dashed-cyan visual language so a blank looks the same everywhere.
 */
function BlankSlot({ fontSize }: { fontSize: number }) {
  return (
    <chakra.span
      display="inline-block"
      verticalAlign="middle"
      borderWidth="2px"
      borderStyle="dashed"
      borderColor="cyan.500"
      bg="cyan.50"
      mx="4px"
      aria-label="blank to fill in"
      style={{
        width: Math.round(fontSize * 1.9),
        height: Math.round(fontSize * 0.92),
        borderRadius: Math.round(fontSize * 0.28),
      }}
    />
  );
}
