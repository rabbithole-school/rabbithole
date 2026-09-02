import React, { useMemo } from "react";
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { fonts, useColors } from "@/theme";
import {
  parseBlocks,
  parseInline,
  type BlockNode,
  type ListItem,
  type SpanStyle,
} from "@/lib/markdownParse";
import { splitMathSegments, hasInlineMath, latexToSpeech } from "../../vendor/shared/mathLatex";
import { MathView } from "../../modules/expo-math-view";

// Body prose typography. Shared between the plain-<Text> paragraph path and the
// MathFlow row so a paragraph that contains inline math renders its words at the
// SAME size as a paragraph without math (MathFlow's <Text> runs are standalone —
// they don't inherit a parent <Text> size, so they must set it explicitly).
const BODY_FONT_SIZE = 18;
const BODY_LINE_HEIGHT = 26;

/**
 * A small, dependency-free Markdown renderer for the tutor's replies.
 *
 * The web app uses react-markdown + remark-gfm (see SessionInterface.tsx). On
 * the bleeding-edge RN/React versions the native app runs, we keep markdown as
 * pure JS — no native module, fully brand-styled (Hanken Grotesk + palette),
 * and matching the one web tweak that matters pedagogically: a *[stage
 * direction]* (italic text wrapped in brackets) renders muted grey.
 *
 * Supported: #/##/### headings, - / * / 1. lists (nested), > blockquotes,
 * ``` fenced code (with optional language label, horizontally scrollable),
 * GitHub pipe tables (aligned columns, horizontally scrollable), and inline
 * **bold**, ***bold+italic***, *italic*, `code`, [links](url). Parsing lives
 * in lib/markdownParse.ts (unit-tested); this file is the brand-styled view.
 */

type Props = {
  content: string;
  /** Base text color (assistant = charcoal, user = white). */
  color?: string;
};

// Line box for fenced code — a comfortable mono line height for wrapped code.
const CODE_LINE_HEIGHT = 21;

export function Markdown({ content, color }: Props) {
  const colors = useColors();
  const resolvedColor = color ?? colors.charcoal;
  const blocks = parseBlocks(content);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} color={resolvedColor} first={i === 0} styles={styles} colors={colors} />
      ))}
    </View>
  );
}

function Block({
  block,
  color,
  first,
  styles,
  colors,
}: {
  block: BlockNode;
  color: string;
  first: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
}) {
  const topMargin = first ? 0 : 10;
  switch (block.kind) {
    case "h":
      return (
        <Text
          style={[
            block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3,
            { color, marginTop: first ? 0 : 14 },
          ]}
        >
          <Inline text={block.text} color={color} bold linkColor={colors.violet} mutedColor={colors.charcoalSubtle} />
        </Text>
      );
    case "code":
      // Long code lines WRAP within the block rather than horizontal-scrolling.
      // Chosen over a horizontal scroll because these readers are kids: wrapping
      // keeps every character visible with no hidden content and no scroll
      // gesture to discover. Wrapping also bounds the text width, so the block
      // measures == paints and hugs its height (no ScrollView height quirk).
      return (
        <View style={[styles.codeBlock, { marginTop: topMargin }]}>
          {block.lang ? <Text style={styles.codeLang}>{block.lang}</Text> : null}
          <Text style={styles.codeText}>{block.text}</Text>
        </View>
      );
    case "quote":
      return (
        <View style={[styles.quote, { marginTop: topMargin }]}>
          {hasInlineMath(block.text) ? (
            <MathFlow text={block.text} color={colors.charcoalSubtle} linkColor={colors.violet} mutedColor={colors.charcoalSubtle} />
          ) : (
            <Text style={[styles.body, { color: colors.charcoalSubtle }]}>
              <Inline text={block.text} color={colors.charcoalSubtle} linkColor={colors.violet} mutedColor={colors.charcoalSubtle} />
            </Text>
          )}
        </View>
      );
    case "ul":
      return (
        <View style={{ marginTop: topMargin }}>
          <ListItems items={block.items} ordered={false} color={color} depth={0} styles={styles} colors={colors} />
        </View>
      );
    case "ol":
      return (
        <View style={{ marginTop: topMargin }}>
          <ListItems items={block.items} ordered={true} color={color} depth={0} styles={styles} colors={colors} />
        </View>
      );
    case "table": {
      const { headers, aligns, rows } = block;
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: topMargin }}
        >
          <View>
            {/* Header row */}
            <View style={[styles.tableRow, styles.tableHeaderRow]}>
              {headers.map((h, ci) => (
                <View key={ci} style={styles.tableCell}>
                  <Text
                    style={[styles.body, { color, textAlign: aligns[ci] ?? "left" }]}
                  >
                    <Inline text={h} color={color} bold linkColor={colors.violet} mutedColor={colors.charcoalSubtle} />
                  </Text>
                </View>
              ))}
            </View>
            {/* Data rows */}
            {rows.map((row, ri) => (
              <View
                key={ri}
                style={[styles.tableRow, ri % 2 === 1 ? styles.tableRowAlt : null]}
              >
                {row.map((cell, ci) => (
                  <View key={ci} style={styles.tableCell}>
                    <Text
                      style={[
                        styles.body,
                        { color, textAlign: aligns[ci] ?? "left" },
                      ]}
                    >
                      <Inline text={cell} color={color} linkColor={colors.violet} mutedColor={colors.charcoalSubtle} />
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    default:
      return hasInlineMath(block.text) ? (
        <MathFlow
          text={block.text}
          color={color}
          linkColor={colors.violet}
          mutedColor={colors.charcoalSubtle}
          style={{ marginTop: topMargin }}
        />
      ) : (
        <Text style={[styles.body, { color, marginTop: topMargin }]}>
          <Inline text={block.text} color={color} linkColor={colors.violet} mutedColor={colors.charcoalSubtle} />
        </Text>
      );
  }
}

/** Recursive list renderer — handles nested sub-lists via item.children. */
function ListItems({
  items,
  ordered,
  color,
  depth,
  styles,
  colors,
}: {
  items: ListItem[];
  ordered: boolean;
  color: string;
  depth: number;
  styles: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <>
      {items.map((item, i) => (
        <View key={i}>
          <View style={styles.li}>
            <Text style={[styles.body, styles.bullet, { color }]}>
              {ordered ? `${i + 1}.` : "\u2022"}
            </Text>
            {hasInlineMath(item.text) ? (
              <MathFlow text={item.text} color={color} linkColor={colors.violet} mutedColor={colors.charcoalSubtle} style={styles.liText} />
            ) : (
              <Text style={[styles.body, styles.liText, { color }]}>
                <Inline text={item.text} color={color} linkColor={colors.violet} mutedColor={colors.charcoalSubtle} />
              </Text>
            )}
          </View>
          {item.children ? (
            <View style={styles.liChildrenIndent}>
              <ListItems
                items={item.children.items}
                ordered={item.children.kind === "ol"}
                color={color}
                depth={depth + 1}
                styles={styles}
                colors={colors}
              />
            </View>
          ) : null}
        </View>
      ))}
    </>
  );
}

// Inline tokenizer: walks the string emitting styled <Text> spans.
function Inline({
  text,
  color,
  bold,
  linkColor,
  mutedColor,
}: {
  text: string;
  color: string;
  bold?: boolean;
  linkColor: string;
  mutedColor: string;
}) {
  const nodes = parseInline(text, { bold: !!bold, italic: false, code: false });
  return (
    <>
      {nodes.map((n, i) => {
        if (n.type === "link") {
          return (
            <Text
              key={i}
              style={[inlineStyle(n.style, color, mutedColor), { textDecorationLine: "underline", color: linkColor }]}
              onPress={() => Linking.openURL(n.href).catch(() => {})}
            >
              {n.text}
            </Text>
          );
        }
        return (
          <Text key={i} style={inlineStyle(n.style, color, mutedColor)}>
            {n.text}
          </Text>
        );
      })}
    </>
  );
}

/**
 * A prose line that contains inline math (`$...$` / `$$...$$`). RN <Text> can't
 * hold a <View>, and a native math view is a View — so a math-bearing line
 * becomes a flex-wrap row of word-level <Text> runs and <MathView> math,
 * flowing/wrapping like inline text. Whitespace is preserved as its own token so
 * words keep their spacing. Guard with hasInlineMath so the common no-math line
 * keeps the cheap single-<Text> path.
 *
 * Math renders full-power via SwiftMath (MTMathUILabel, Fira Math) — the SAME
 * constrained-LaTeX string the web KaTeX path consumes (splitMathSegments is the
 * shared splitter with the currency guard). We split the raw text into
 * text/math segments FIRST, then parse inline markdown within each text segment,
 * mirroring the web remarkInlineMath plugin. VoiceOver reads each math run via
 * latexToSpeech ("3 over 4"), never the raw glyphs.
 */
function MathFlow({
  text,
  color,
  bold,
  linkColor,
  mutedColor,
  style,
}: {
  text: string;
  color: string;
  bold?: boolean;
  linkColor: string;
  mutedColor: string;
  style?: ViewStyle | ViewStyle[];
}) {
  const segments = splitMathSegments(text);
  return (
    <View style={[flowStyles.flow, style]}>
      {segments.map((seg, si) => {
        if (seg.type === "math") {
          return (
            <View
              key={`m${si}`}
              accessible
              accessibilityLabel={latexToSpeech(seg.latex)}
              style={flowStyles.mathBox}
            >
              <MathView
                latex={seg.latex}
                fontSize={seg.display ? 22 : BODY_FONT_SIZE}
                color={color}
                typesettingStyle={seg.display ? "display" : "text"}
              />
            </View>
          );
        }
        const spans = parseInline(seg.value, { bold: !!bold, italic: false, code: false });
        return spans.map((sp, spi) =>
          splitTokens(sp.text).map((tok, ti) => {
            const key = `t${si}-${spi}-${ti}`;
            if (sp.type === "link") {
              return (
                <Text
                  key={key}
                  style={[inlineStyle(sp.style, color, mutedColor, BODY_FONT_SIZE), { textDecorationLine: "underline", color: linkColor }]}
                  onPress={() => Linking.openURL(sp.href).catch(() => {})}
                >
                  {tok}
                </Text>
              );
            }
            return (
              <Text key={key} style={inlineStyle(sp.style, color, mutedColor, BODY_FONT_SIZE)}>
                {tok}
              </Text>
            );
          }),
        );
      })}
    </View>
  );
}

/** Split into word / whitespace tokens, keeping the whitespace so a flex-wrap
 *  row reproduces natural inter-word spacing. */
function splitTokens(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

const flowStyles = StyleSheet.create({
  flow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 2 },
  mathBox: { alignSelf: "center", marginHorizontal: 1 },
});

function inlineStyle(s: SpanStyle, color: string, mutedColor: string, baseFontSize?: number): TextStyle {
  return {
    fontFamily: s.code ? fonts.mono : s.bold ? fonts.bold : fonts.regular,
    fontStyle: s.italic ? "italic" : "normal",
    color: s.muted ? mutedColor : color,
    // baseFontSize is only supplied by MathFlow, whose text runs are standalone
    // <Text> nodes (they don't inherit a parent <Text>'s size). Nested callers
    // (headings via h1/h2/h3, plain paragraphs via styles.body) must NOT force a
    // size here or they'd override their parent — e.g. headings would shrink.
    ...(baseFontSize != null ? { fontSize: baseFontSize, lineHeight: BODY_LINE_HEIGHT } : null),
    ...(s.code
      ? { borderRadius: 5, fontSize: 16 }
      : null),
  };
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { width: "100%" },
    body: { fontSize: BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT, fontFamily: fonts.regular },
    h1: { fontSize: 24, lineHeight: 30, fontFamily: fonts.bold },
    h2: { fontSize: 21, lineHeight: 27, fontFamily: fonts.bold },
    h3: { fontSize: 19, lineHeight: 25, fontFamily: fonts.semibold },
    li: { flexDirection: "row", marginTop: 4, paddingRight: 4 },
    bullet: { width: 22 },
    liText: { flex: 1 },
    liChildrenIndent: { marginLeft: 22 },
    link: { textDecorationLine: "underline", color: c.violet },
    inlineCode: {
      backgroundColor: c.gray100,
      borderRadius: 5,
      fontSize: 16,
    },
    codeBlock: {
      backgroundColor: c.gray100,
      borderRadius: 12,
      padding: 12,
    },
    codeLang: {
      fontFamily: fonts.mono,
      fontSize: 12,
      color: c.charcoalSubtle,
      marginBottom: 6,
      textTransform: "lowercase",
    },
    codeText: { fontFamily: fonts.mono, fontSize: 15, lineHeight: CODE_LINE_HEIGHT, color: c.charcoal },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: c.gray300,
      paddingLeft: 12,
      paddingVertical: 2,
    },
    // Tables
    tableRow: { flexDirection: "row" },
    tableHeaderRow: {
      borderBottomWidth: 2,
      borderBottomColor: c.gray200,
      paddingBottom: 6,
      marginBottom: 2,
    },
    tableCell: {
      minWidth: 90,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    tableRowAlt: { backgroundColor: c.gray50 },
  });
}
