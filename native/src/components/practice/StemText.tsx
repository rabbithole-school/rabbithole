/**
 * StemText — the native (RN) twin of components/practice/StemText.tsx. Renders a
 * practice stem, lifting any embedded pipe table (vendor/shared/practiceStemBlocks)
 * out of the prose into a real hairline table. A drop-in for the
 * `<FractionText value={stem} …>` stem render; a stem with no table renders
 * byte-identically through FractionText. Must look indistinguishable from web.
 *
 * Prose blocks (and every table CELL) render through FractionText, so fractions
 * and "?" keep their existing stacked visual language. The FULL stem's spoken
 * reading is set once on the wrapper (stemToSpeech) — never per block — so
 * VoiceOver / the K tap-to-hear path hear one coherent question.
 */

import { StyleSheet, View } from "react-native";

import { FractionText } from "@/components/FractionText";
import {
  splitStemBlocks,
  stemToSpeech,
  stemTableColumnWidths,
  type StemBlock,
} from "../../../vendor/shared/practiceStemBlocks";

// The card palette (matches components/practice/PromptVisual.tsx + the web twin).
const RULE = "#ded8cb";
const HEADER_TEXT = "#8a7f6d";
const BODY_TEXT = "#3f3528";

// Cell font 22 when the stem is 28; scale proportionally for other sizes.
const CELL_SCALE = 22 / 28;

type Props = {
  /** A plain-ASCII stem, possibly with an embedded pipe table. */
  value: string;
  fontSize?: number;
  align?: "center" | "left";
  color?: string;
  accessibilityLabel?: string;
  /** Glyph weight for the no-table fast path; forwarded to FractionText. Omit to
   *  keep FractionText's default (the scholar-card stem weight, "semibold"). */
  weight?: "regular" | "semibold";
  /** Top-level line-height (unitless multiple) for the no-table fast path;
   *  forwarded to FractionText. Omit to keep FractionText's default. */
  lineHeight?: number;
};

export function StemText({ value, fontSize = 28, align = "center", color, accessibilityLabel, weight, lineHeight }: Props) {
  const blocks = splitStemBlocks(value);

  // Fast path: no table ⇒ exactly the old FractionText render.
  if (blocks.length === 1 && blocks[0].kind === "text") {
    return (
      <FractionText
        value={value}
        fontSize={fontSize}
        align={align}
        color={color}
        accessibilityLabel={accessibilityLabel}
        weight={weight}
        lineHeight={lineHeight}
      />
    );
  }

  const cellFont = Math.round(fontSize * CELL_SCALE);
  const label = accessibilityLabel ?? stemToSpeech(value);
  return (
    <View
      style={[styles.wrap, align === "center" ? styles.center : styles.left]}
      accessible
      accessibilityLabel={label}
    >
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          <FractionText key={i} value={block.text} fontSize={fontSize} align={align} color={color} />
        ) : (
          <StemTable key={i} block={block} cellFont={cellFont} />
        ),
      )}
    </View>
  );
}

function StemTable({ block, cellFont }: { block: Extract<StemBlock, { kind: "table" }>; cellFont: number }) {
  const colWidths = stemTableColumnWidths(block.header, block.rows, cellFont);
  // Ideal total is a MAXIMUM only: fill the container up to it (a narrow table
  // hugs its content), shrink below it on a narrow card (cells flex + wrap
  // instead of overflowing the card and clipping). Each cell flexes
  // proportionally to ITS OWN column's ideal width, so under constraint all
  // columns shrink together instead of the label column wrapping alone. The
  // wrapper's alignItems centres it when it is narrower than the card.
  const idealTotal = colWidths.reduce((sum, w) => sum + w, 0);
  return (
    <View style={[styles.table, { maxWidth: idealTotal }]}>
      {block.header ? (
        <View style={[styles.tRow, styles.headerRule]}>
          {block.header.map((cell, ci) => (
            <Cell key={ci} text={cell} font={cellFont} width={colWidths[ci]} header />
          ))}
        </View>
      ) : null}
      {block.rows.map((row, ri) => (
        <View key={ri} style={[styles.tRow, ri > 0 ? styles.bodyRule : null]}>
          {row.map((cell, ci) => (
            <Cell key={ci} text={cell} font={cellFont} width={colWidths[ci]} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Cell({
  text,
  font,
  width,
  header = false,
}: {
  text: string;
  font: number;
  width: number;
  header?: boolean;
}) {
  return (
    <View style={[styles.cell, { flexGrow: width, flexBasis: width }]}>
      <FractionText
        value={text}
        inline
        fontSize={font}
        color={header ? HEADER_TEXT : BODY_TEXT}
        weight={header ? "regular" : "semibold"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch" },
  center: { alignItems: "center" },
  left: { alignItems: "flex-start" },
  // A column of rows. width:100% + maxWidth lets it fill the card up to its
  // ideal width and shrink below it, so it never overflows and clips.
  table: { marginVertical: 10, width: "100%" },
  tRow: { flexDirection: "row" },
  headerRule: { borderBottomWidth: 1, borderColor: RULE },
  bodyRule: { borderTopWidth: 1, borderColor: RULE },
  // Columns flex proportionally to their own ideal width (flexGrow/flexBasis set
  // inline per column) and can shrink below content so a wide table's text wraps
  // rather than clipping. alignItems:stretch lets the inner FractionText fill the
  // cell and wrap; it centres its own content.
  cell: {
    flexShrink: 1,
    minWidth: 0,
    paddingVertical: 6,
    paddingHorizontal: 14,
    alignItems: "stretch",
    justifyContent: "center",
  },
});
