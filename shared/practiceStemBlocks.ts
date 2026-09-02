/**
 * practiceStemBlocks — split a practice stem into ordinary text and TABLE blocks.
 *
 * Some practice templates (convex/lib/practice/templates.ts) embed a small
 * data table INSIDE the stem prose as newline-delimited, pipe-separated rows,
 * e.g.
 *
 *     "Every row follows the same input-output rule.\ninput | output\n1 | 2\n3 | 6\n5 | ?\n8 | 16\nWhat output replaces ?"
 *
 * Rendered as a flat string those pipes and newlines are garbage — the iPad
 * `FractionText` row staggers them into one scrambled paragraph, and the web
 * twin shows ragged centred lines full of raw `|`. This parser lifts the pipe
 * table out so the stem renderer (`StemText`, web + native) can draw a real
 * table while leaving every other stem byte-for-byte unchanged.
 *
 * PURE + dependency-free apart from the sibling `fractions` module (also shared
 * + vendored). No Convex imports — it vendors into the native app.
 */

import { fractionsToSpeech, hasPracticeMath } from "./fractions";

export type StemBlock =
  /** A run of ordinary prose; internal newlines are preserved. */
  | { kind: "text"; text: string }
  /** A lifted pipe table. `header` is present only when the first row is a
   *  label row (see the header rule below); otherwise all lines are `rows`. */
  | { kind: "table"; header?: string[]; rows: string[][] };

// A cell "parses as a number" if, trimmed, it is a plain (optionally signed /
// decimal) numeral OR contains a fraction. Used ONLY for the header rule below.
// A fraction-valued first row ("1/2 | 3/4") is data, not a heading, so it must
// count as numeric. "?" and words are not numbers; an empty cell is not a number.
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

function isNumericCell(cell: string): boolean {
  const trimmed = cell.trim();
  return NUMERIC.test(trimmed) || hasPracticeMath(trimmed);
}

function splitCells(line: string): string[] {
  return line.split("|").map((c) => c.trim());
}

/**
 * Split a stem into text and table blocks.
 *
 * A **table run** is 2+ CONSECUTIVE lines that each contain `|`, where every
 * line splits (on `|`, cells trimmed) into the SAME number of cells and that
 * count is >= 2. A group of consecutive pipe-lines that fails any of those
 * stays ordinary text.
 *
 * A run's first row is treated as a **header** iff no cell in it parses as a
 * number ("input | output", "x | y" → header; "Meters: 0 | 5 | 10 | 15" → not,
 * because "5" is numeric).
 *
 * Prose above, between, and below table runs is preserved as `text` blocks with
 * their internal newlines intact. A stem with no table run returns exactly one
 * `text` block holding the original string, byte-identical.
 */
export function splitStemBlocks(stem: string): StemBlock[] {
  const lines = stem.split("\n");
  const blocks: StemBlock[] = [];
  let textBuf: string[] = [];
  let sawTable = false;

  const flushText = () => {
    if (textBuf.length > 0) {
      blocks.push({ kind: "text", text: textBuf.join("\n") });
      textBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes("|")) {
      // Gather the maximal run of consecutive lines that all contain "|".
      let j = i;
      while (j < lines.length && lines[j].includes("|")) j++;
      const runLines = lines.slice(i, j);
      const cellRows = runLines.map(splitCells);
      const count = cellRows[0].length;
      const uniform =
        runLines.length >= 2 && count >= 2 && cellRows.every((r) => r.length === count);
      if (uniform) {
        flushText();
        const firstIsHeader = cellRows[0].every((c) => !isNumericCell(c));
        if (firstIsHeader) {
          blocks.push({ kind: "table", header: cellRows[0], rows: cellRows.slice(1) });
        } else {
          blocks.push({ kind: "table", rows: cellRows });
        }
        sawTable = true;
        i = j;
        continue;
      }
      // Not a uniform table: per this function's contract, a group of
      // consecutive pipe-lines that fails any check stays ORDINARY TEXT in its
      // entirety. Emit the whole rejected run and advance past all of it — never
      // just its first line, which would let the suffix be re-parsed as a table.
      for (const runLine of runLines) textBuf.push(runLine);
      i = j;
      continue;
    }
    textBuf.push(lines[i]);
    i++;
  }
  flushText();

  // No table anywhere ⇒ hand back the original string untouched, so a non-table
  // stem renders exactly as it did before this parser existed.
  if (!sawTable) return [{ kind: "text", text: stem }];
  return blocks;
}

// ─── Accessibility ───────────────────────────────────────────────────────────

function speakTable(block: Extract<StemBlock, { kind: "table" }>): string {
  const parts: string[] = [];
  if (block.header) {
    parts.push(`Columns ${block.header.map((c) => fractionsToSpeech(c)).join(", ")}.`);
  }
  for (const row of block.rows) {
    parts.push(`Row: ${row.map((c) => fractionsToSpeech(c)).join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * A single coherent spoken reading of a whole stem, for the wrapper's aria /
 * accessibility label (never per block — fragments confuse a screen reader).
 * Prose is read via `fractionsToSpeech`; a table is read as
 * "Columns input, output. Row: 1, 2. Row: 3, 6." For a stem with no table this
 * is exactly `fractionsToSpeech(stem)`.
 */
export function stemToSpeech(stem: string): string {
  const blocks = splitStemBlocks(stem);
  const spoken = blocks.map((b) =>
    b.kind === "text" ? fractionsToSpeech(b.text) : speakTable(b),
  );
  return spoken.join(" ").replace(/\s+/g, " ").trim();
}

// ─── Layout helper ───────────────────────────────────────────────────────────

/** The ideal width (points/px, padding included) for ONE column, sized to the
 *  widest cell IN THAT COLUMN so the web and native renderers draw
 *  indistinguishable columns without measuring text. */
function columnWidth(cells: string[], cellFont: number): number {
  const maxLen = cells.reduce((m, c) => Math.max(m, c.length), 1);
  const content = maxLen * cellFont * 0.62;
  const horizontalPadding = 28; // ~14px each side
  return Math.ceil(Math.max(cellFont * 2.2, content + horizontalPadding));
}

/**
 * One ideal width per column, each sized to the widest cell IN THAT COLUMN
 * (header included). Sizing per-column instead of one uniform width keeps a
 * label column (e.g. "Meters: 0") from forcing its short numeric siblings into
 * oceans of empty space — and, under constraint, lets every column shrink
 * proportionally instead of the label column wrapping alone.
 *
 * The renderer uses the SUM of these as the table's `maxWidth` cap (so the
 * table still hugs its content and can never exceed its container) and each
 * width as that column's flex-basis (so columns share space proportionally).
 */
export function stemTableColumnWidths(
  header: string[] | undefined,
  rows: string[][],
  cellFont: number,
): number[] {
  // The column count is the MAXIMUM observed across the header and every row —
  // never just the header's or the first row's length. A ragged input (a short
  // header, or rows of differing lengths) must not silently drop the columns
  // that only appear in a longer row. (splitStemBlocks only emits uniform tables
  // today, but this helper is exported with permissive types.)
  const numCols = rows.reduce((m, r) => Math.max(m, r.length), header?.length ?? 0);
  const widths: number[] = [];
  for (let c = 0; c < numCols; c++) {
    const columnCells: string[] = [];
    if (header) columnCells.push(header[c] ?? "");
    for (const row of rows) columnCells.push(row[c] ?? "");
    widths.push(columnWidth(columnCells, cellFont));
  }
  return widths;
}

// ─── Compact preview ─────────────────────────────────────────────────────────

/**
 * A stem flattened to a single scannable line for dense index/list rows: prose
 * kept as-is, any table run collapsed to "a, b · c, d" (cells joined with ", ",
 * rows joined with " · "), the whole thing whitespace-collapsed to one line. A
 * stem with NO table run comes back byte-identical (no collapsing), so a plain
 * list row reads exactly as it did before. Reuses `splitStemBlocks` — never a
 * second parser.
 */
export function stemPreviewText(stem: string): string {
  const blocks = splitStemBlocks(stem);
  // No table ⇒ hand back the original untouched (splitStemBlocks guarantees a
  // single byte-identical text block in that case).
  if (blocks.length === 1 && blocks[0].kind === "text") return stem;
  const parts = blocks.map((b) => {
    if (b.kind === "text") return b.text;
    const rows = b.header ? [b.header, ...b.rows] : b.rows;
    return rows.map((row) => row.join(", ")).join(" · ");
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
