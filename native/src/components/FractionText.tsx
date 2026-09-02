/**
 * FractionText — the native (RN) stacked-fraction renderer, the twin of
 * components/FractionText.tsx.
 *
 * Takes a plain-ASCII string, parses it with the SHARED direct parser
 * (vendor/shared/fractions), and lays it out as a wrapping row of text runs and
 * **stacked fractions** (numerator over a horizontal bar / vinculum over
 * denominator) — the elementary-friendly form. A "?" fill-in slot renders as a
 * rounded dashed box.
 *
 * Dependency-free: plain View + Text + the brand font (Hanken Grotesk) + theme
 * colors — no SVG, no webview, no MathJax. Cross-platform (iOS / Android / Expo
 * Go) and fully unit-testable with no native toolchain.
 *
 * WRAPPING: prose runs are emitted one WORD per <Text> (see `wrapTokens`). RN
 * cannot break a single <Text> across flex lines, so a whole run between two
 * fractions used to jump to the next line intact, orphaning its leading
 * punctuation ("Decompose 5/8 as 3/8 + 2/8" / ": shade the first disc to 3/8" —
 * Andy, 2026-08-06, on the web twin). Word tokens let the row wrap where prose
 * should. Same trick MathFlow (components/Markdown.tsx) uses for the tutor's
 * inline math; the web twin gets there by using real inline flow instead.
 */

import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";

import { fonts, useColors } from "@/theme";
import {
  parsePracticeText,
  fractionsToSpeech,
  hasPracticeMath,
  type FracPart,
  type StaticRadicalNode,
} from "../../vendor/shared/fractions";
import { MathView } from "../../modules/expo-math-view";

type Props = {
  /** A plain-ASCII string, e.g. "Write 9 4/9 as ?/9". */
  value: string;
  /** Base glyph size in points. Numerator/denominator scale down from this. */
  fontSize?: number;
  /** Base text color; defaults to the theme foreground. */
  color?: string;
  /** Horizontal alignment of the whole line. Defaults to center (stem style). */
  align?: "center" | "left";
  /** Spoken label; defaults to a "3 over 4"-style reading so VoiceOver never
   *  announces the stacked glyphs as "3 slash 4". */
  accessibilityLabel?: string;
  /** Flow inline within surrounding prose (tutor markdown) instead of as a
   *  standalone line. Inline hugs its content; block stretches to fill its
   *  parent so a long stem wraps. */
  inline?: boolean;
  /** Glyph weight for top-level prose tokens. Defaults to semibold (stem
   *  style); table header cells pass "regular". */
  weight?: "regular" | "semibold";
  /** Top-level line-height (unitless multiple of fontSize). Omit to keep the
   *  default roomy 1.45; block call sites that used a plain <Text> pass their
   *  original value. */
  lineHeight?: number;
};

// Numerator/denominator sit a step smaller than the base — the standard display
// proportion (keeps a mixed number's whole part visually dominant).
const FRAC_SCALE = 0.82;

export function FractionText({ value, fontSize = 28, color, align = "center", accessibilityLabel, inline = false, weight = "semibold", lineHeight }: Props) {
  const colors = useColors();
  const resolved = color ?? colors.fg;
  const tokenFont = weight === "regular" ? fonts.regular : fonts.semibold;
  const nodes = useMemo(() => parsePracticeText(value), [value]);
  // Only claim image/collapsed semantics when the rendering actually diverges
  // from the text — i.e. a stacked fraction whose spoken form ("3 over 4")
  // differs from the raw glyphs. For ordinary text the label adds nothing and
  // `accessible` would only strip the individual Text nodes' navigability. An
  // explicit accessibilityLabel always wins (a composite caller may need it).
  const label = useMemo(
    () => accessibilityLabel ?? (hasPracticeMath(value) ? fractionsToSpeech(value) : undefined),
    [accessibilityLabel, value],
  );
  return (
    <View
      style={[styles.row, align === "center" ? styles.center : styles.left, inline ? null : styles.block]}
      {...(label != null ? { accessible: true, accessibilityLabel: label } : null)}
    >
      {renderNodes(nodes, fontSize, resolved, colors.cyanSubtle, colors.cyan, tokenFont, lineHeight)}
    </View>
  );
}

/**
 * Parsed nodes → row children. The one non-obvious step: a mixed number
 * ("9 4/9") arrives as a bare-digits text node followed by its fraction, so the
 * two are handed to ONE `Frac` — otherwise the wrapping row could break between
 * the whole part and its stack and split the number in half.
 */
function renderNodes(
  nodes: ReturnType<typeof parsePracticeText>,
  fontSize: number,
  color: string,
  blankBg: string,
  blankBorder: string,
  tokenFont: string,
  lineHeight?: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === "frac") {
      out.push(
        <Frac
          key={i}
          num={n.num}
          den={n.den}
          fontSize={fontSize}
          color={color}
          borderColor={color}
          blankBg={blankBg}
          blankBorder={blankBorder}
          family={tokenFont}
        />,
      );
    } else if (n.type === "radical") {
      out.push(
        <Radical
          key={i}
          node={n}
          fontSize={fontSize}
          color={color}
          family={tokenFont}
          lineHeight={lineHeight}
        />,
      );
    } else if (n.type === "blank") {
      out.push(<BlankSlot key={i} fontSize={fontSize} bg={blankBg} border={blankBorder} />);
    } else {
      const next = nodes[i + 1];
      if (next?.type === "frac" && /^\d+$/.test(n.value)) {
        out.push(
          <Frac
            key={i}
            whole={n.value}
            num={next.num}
            den={next.den}
            fontSize={fontSize}
            color={color}
            borderColor={color}
            blankBg={blankBg}
            blankBorder={blankBorder}
            family={tokenFont}
          />,
        );
        i++;
      } else {
        for (const [ti, tok] of wrapTokens(n.value).entries()) {
          if (tok.type === "break") {
            // A newline is a HARD break: a full-width, zero-height item fills
            // the current flex line so the following token starts a new one.
            // (Without this, a "2\n" welded token rendered TWO lines tall and,
            // with the row's alignItems:center, staggered the digits — the
            // scrambled-table bug.)
            out.push(<View key={`${i}-${ti}`} style={styles.lineBreak} />);
          } else {
            out.push(
              <Text key={`${i}-${ti}`} style={[textStyle(fontSize, true, tokenFont, lineHeight), { color }]}>
                {tok.value}
              </Text>,
            );
          }
        }
      }
    }
  }
  return out;
}

/** The measured SwiftMath view and any trailing sentence punctuation form ONE
 * flex item, so the punctuation cannot wrap away from the root. The punctuation
 * remains a Hanken <Text>; only the radical goes through Fira Math. */
function Radical({
  node,
  fontSize,
  color,
  family,
  lineHeight,
}: {
  node: StaticRadicalNode;
  fontSize: number;
  color: string;
  family: string;
  lineHeight?: number;
}) {
  return (
    <View style={styles.radical}>
      <MathView latex={node.latex} fontSize={fontSize} color={color} typesettingStyle="text" />
      {node.trailingPunctuation ? (
        <Text style={[textStyle(fontSize, true, family, lineHeight), { color }]}>{node.trailingPunctuation}</Text>
      ) : null}
    </View>
  );
}

function Frac({
  whole,
  num,
  den,
  fontSize,
  color,
  borderColor,
  blankBg,
  blankBorder,
  family,
}: {
  /** A mixed number's whole part, set full-size beside the stack ("9¾"). */
  whole?: string;
  num: FracPart;
  den: FracPart;
  fontSize: number;
  color: string;
  borderColor: string;
  blankBg: string;
  blankBorder: string;
  /** Glyph family (weight) inherited from the enclosing run, so a regular-weight
   *  header cell renders its fraction digits at 400 too, matching web. */
  family: string;
}) {
  const inner = Math.max(12, Math.round(fontSize * FRAC_SCALE));
  const barThickness = Math.max(1.5, Math.round(fontSize * 0.07));
  return (
    <View style={styles.mixed}>
      {whole ? <Text style={[textStyle(fontSize, false, family), { color }]}>{whole}</Text> : null}
      <View style={styles.frac}>
        <View style={styles.fracPart}>
          <Part part={num} fontSize={inner} color={color} blankBg={blankBg} blankBorder={blankBorder} family={family} />
        </View>
        <View style={[styles.vinculum, { height: barThickness, backgroundColor: borderColor, borderRadius: barThickness / 2 }]} />
        <View style={styles.fracPart}>
          <Part part={den} fontSize={inner} color={color} blankBg={blankBg} blankBorder={blankBorder} family={family} />
        </View>
      </View>
    </View>
  );
}

function Part({
  part,
  fontSize,
  color,
  blankBg,
  blankBorder,
  family,
}: {
  part: FracPart;
  fontSize: number;
  color: string;
  blankBg: string;
  blankBorder: string;
  family: string;
}) {
  if (part.blank) return <Blank fontSize={fontSize} bg={blankBg} border={blankBorder} />;
  return <Text style={[textStyle(fontSize, false, family), { color }]}>{part.value}</Text>;
}

function Blank({ fontSize, bg, border }: { fontSize: number; bg: string; border: string }) {
  const size = Math.round(fontSize * 1.05);
  return (
    <View
      style={[
        styles.blank,
        { minWidth: size, height: size, borderColor: border, backgroundColor: bg, borderRadius: Math.round(fontSize * 0.18) },
      ]}
      accessibilityLabel="blank to fill in"
    />
  );
}

/**
 * A standalone inline fill-in blank ("___" in a stem, e.g. "754 = ___ + 50 + 4").
 * A roomy rounded slot — wider than the square fraction-part Blank so it reads as
 * an answer space in the flow of an equation. Same dashed-cyan visual language as
 * the fraction blank, so a blank looks identical everywhere (web twin: BlankSlot
 * in components/FractionText.tsx).
 */
function BlankSlot({ fontSize, bg, border }: { fontSize: number; bg: string; border: string }) {
  return (
    <View
      style={[
        styles.blankSlot,
        {
          width: Math.round(fontSize * 1.9),
          height: Math.round(fontSize * 0.92),
          borderColor: border,
          backgroundColor: bg,
          borderRadius: Math.round(fontSize * 0.28),
        },
      ]}
      accessibilityLabel="blank to fill in"
    />
  );
}

/**
 * A token in a wrapped prose run: either a word (plus any trailing NON-newline
 * whitespace welded on, so a wrapped line never starts indented) or a hard
 * `break` produced by a newline. Splitting newlines OUT as breaks — instead of
 * welding them onto a word token — is what stops a "2\n" token from rendering
 * two lines tall and staggering the row (the scrambled-table bug).
 */
export type WrapToken = { type: "text"; value: string } | { type: "break" };

export function wrapTokens(text: string): WrapToken[] {
  const out: WrapToken[] = [];
  // Normalise CRLF / lone CR to a single "\n" FIRST, so a "\r" never welds onto
  // a word token (RN then renders it as its own break, doubling an explicit
  // newline: "first\r\nsecond" showed a blank line on native but one on web).
  const normalized = text.replace(/\r\n?/g, "\n");
  // `\n` (one hard break) | non-newline whitespace run | word.
  for (const piece of normalized.match(/\n|[^\S\n]+|\S+/g) ?? []) {
    if (piece === "\n") {
      out.push({ type: "break" });
      continue;
    }
    if (/^\s+$/.test(piece)) {
      const last = out[out.length - 1];
      if (last && last.type === "text") last.value += piece;
      else out.push({ type: "text", value: piece });
      continue;
    }
    out.push({ type: "text", value: piece });
  }
  return out;
}

function textStyle(fontSize: number, roomy = false, family: string = fonts.semibold, lineHeightMultiple?: number): TextStyle {
  // Top-level runs get a roomier line box: a Unicode superscript exponent
  // (`2^3` → `2³`, via superscriptExponents) rises above the cap height, and
  // iOS CLIPS the top of any glyph that overflows a tight `lineHeight` (Andy's
  // "the exponent 3 is cut off at the top"). Fraction num/den parts keep the
  // compact 1.15 — they're single digits with no superscript, so their stacking
  // rhythm is unchanged. The taller box is invisible: the row centers each run,
  // so the glyph position doesn't move — only the clip headroom grows. A caller
  // may override the multiple (a block stem restoring its plain-<Text> spacing).
  const multiple = lineHeightMultiple ?? (roomy ? 1.45 : 1.15);
  return { fontFamily: family, fontSize, lineHeight: Math.round(fontSize * multiple) };
}

const styles = StyleSheet.create({
  // Only a ROW gap: a column gap would insert 2px between every word token now
  // that prose is split per word. Inter-word spacing comes from the tokens'
  // own trailing spaces; fractions and blanks carry their own margins.
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 2 },
  // A hard newline break inside a prose run: full width so it fills the current
  // flex line and forces the next token to wrap onto a fresh line. The -1
  // vertical margins cancel the row's `rowGap: 2` that would otherwise apply on
  // BOTH sides of this zero-height sentinel (~4px), leaving one normal 2px
  // inter-line gap that matches web.
  lineBreak: { width: "100%", height: 0, marginVertical: -1 },
  center: { justifyContent: "center" },
  left: { justifyContent: "flex-start" },
  block: { alignSelf: "stretch" },
  // A mixed number: the whole part set full-size beside its stack, as ONE
  // unbreakable box so a wrap can never land between "9" and its "4/9".
  mixed: { flexDirection: "row", alignItems: "center", marginHorizontal: 2 },
  radical: { flexDirection: "row", alignItems: "center", marginHorizontal: 1 },
  // A stacked fraction: a centered column, num / bar / den. Small horizontal
  // padding so the vinculum slightly overhangs the digits (typographic norm).
  frac: { flexDirection: "column", alignItems: "center", paddingHorizontal: 3 },
  fracPart: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  vinculum: { alignSelf: "stretch", marginVertical: 3 },
  blank: {
    borderWidth: 2,
    borderStyle: "dashed",
    marginHorizontal: 2,
  },
  blankSlot: {
    borderWidth: 2,
    borderStyle: "dashed",
    marginHorizontal: 4,
  },
});
