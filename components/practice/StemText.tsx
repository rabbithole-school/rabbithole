"use client";

/**
 * StemText (web) — renders a practice stem, lifting any embedded pipe table
 * (see shared/practiceStemBlocks) out of the prose into a real hairline table.
 * A drop-in for the `<FractionText value={stem} …>` stem render; a stem with no
 * table renders byte-identically through FractionText. The DOM twin of
 * native/src/components/practice/StemText.tsx — they must look indistinguishable.
 *
 * Prose blocks (and every table CELL) render through FractionText, so fractions
 * and "?" keep their existing stacked visual language. The FULL stem's spoken
 * reading is computed once on the wrapper (stemToSpeech) — never per block — so
 * a screen reader hears one coherent question, tables read as "Columns …. Row …".
 */

import { chakra } from "@chakra-ui/react";
import { FractionText } from "@/components/FractionText";
import {
  splitStemBlocks,
  stemToSpeech,
  stemTableColumnWidths,
  type StemBlock,
} from "@/shared/practiceStemBlocks";

// The card palette (components/practice/PromptVisual.tsx).
const RULE = "#ded8cb";
const HEADER_TEXT = "#8a7f6d";
const BODY_TEXT = "#3f3528";

// Cell font 22 when the stem is 28; scale proportionally for other sizes.
const CELL_SCALE = 22 / 28;

export function StemText({
  value,
  fontSize = 28,
  align = "center",
  color,
  ariaLabel,
  weight,
  lineHeight,
}: {
  /** A plain-ASCII stem, possibly with an embedded pipe table. */
  value: string;
  fontSize?: number;
  align?: "center" | "left";
  color?: string;
  ariaLabel?: string;
  /** Glyph weight for the no-table fast path; forwarded to FractionText. Omit to
   *  keep FractionText's default (the scholar-card stem weight). Block call sites
   *  that previously used a plain <Text> pass regular (400). */
  weight?: number;
  /** Block line-height for the no-table fast path; forwarded to FractionText.
   *  Omit to keep FractionText's default (1.3). */
  lineHeight?: number;
}) {
  const blocks = splitStemBlocks(value);

  // Fast path: no table ⇒ exactly the old FractionText render.
  if (blocks.length === 1 && blocks[0].kind === "text") {
    return (
      <FractionText
        value={value}
        fontSize={fontSize}
        align={align}
        color={color}
        ariaLabel={ariaLabel}
        fontWeight={weight}
        lineHeight={lineHeight}
      />
    );
  }

  const cellFont = Math.round(fontSize * CELL_SCALE);
  return (
    <chakra.div
      // role="img" + a single label collapses the subtree for AT, so the stem
      // is announced once — not fragmented block by block.
      role="img"
      aria-label={ariaLabel ?? stemToSpeech(value)}
      display="block"
      width="100%"
      textAlign={align}
    >
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          <FractionText key={i} value={block.text} fontSize={fontSize} align={align} color={color} />
        ) : (
          <StemTable key={i} block={block} cellFont={cellFont} align={align} />
        ),
      )}
    </chakra.div>
  );
}

function StemTable({
  block,
  cellFont,
  align,
}: {
  block: Extract<StemBlock, { kind: "table" }>;
  cellFont: number;
  align: "center" | "left";
}) {
  const colWidths = stemTableColumnWidths(block.header, block.rows, cellFont);
  // The ideal total is only a MAXIMUM: the table fills its container up to this
  // width (so a narrow table hugs its content instead of stretching full-bleed)
  // and shrinks below it when the card is narrower (so it never overflows and
  // clips). Each cell flexes proportionally to ITS OWN column's ideal width, so
  // under constraint all columns shrink together instead of the label column
  // wrapping alone.
  const idealTotal = colWidths.reduce((sum, w) => sum + w, 0);
  return (
    <chakra.div
      display="flex"
      flexDirection="column"
      width="100%"
      my="10px"
      marginInline={align === "center" ? "auto" : "0"}
      style={{ maxWidth: idealTotal }}
    >
      {block.header ? (
        <chakra.div display="flex" borderBottomWidth="1px" borderColor={RULE}>
          {block.header.map((cell, ci) => (
            <Cell key={ci} text={cell} font={cellFont} width={colWidths[ci]} header />
          ))}
        </chakra.div>
      ) : null}
      {block.rows.map((row, ri) => (
        <chakra.div
          key={ri}
          display="flex"
          borderTopWidth={ri > 0 ? "1px" : undefined}
          borderColor={ri > 0 ? RULE : undefined}
        >
          {row.map((cell, ci) => (
            <Cell key={ci} text={cell} font={cellFont} width={colWidths[ci]} />
          ))}
        </chakra.div>
      ))}
    </chakra.div>
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
    <chakra.div
      display="flex"
      alignItems="center"
      justifyContent="center"
      px="14px"
      py="6px"
      // Flex proportionally to this column's own ideal width, and allow shrink
      // below content (minWidth:0) so a wide table wraps to fit the card instead
      // of clipping.
      style={{ flexGrow: width, flexShrink: 1, flexBasis: width, minWidth: 0, boxSizing: "border-box" }}
    >
      <FractionText
        value={text}
        inline
        fontSize={font}
        color={header ? HEADER_TEXT : BODY_TEXT}
        fontWeight={header ? 400 : 600}
      />
    </chakra.div>
  );
}
