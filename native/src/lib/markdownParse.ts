// Pure markdown parsing for the tutor's replies — no React, no RN, so it's
// unit-testable in isolation (see scripts/test-markdown.mjs). The brand-styled
// renderer lives in components/Markdown.tsx and consumes these.

// ── Types ─────────────────────────────────────────────────────────────────────

export type ListItem = {
  text: string;
  /** Optional sub-list attached to this item (one level of nesting supported). */
  children?: ListBlock;
};

export type ListBlock =
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; items: ListItem[] };

export type BlockNode =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "quote"; text: string }
  | ListBlock
  | {
      kind: "table";
      headers: string[];
      /** Per-column text alignment (defaults to "left"). */
      aligns: ("left" | "center" | "right")[];
      rows: string[][];
    };

export type SpanStyle = {
  bold: boolean;
  italic: boolean;
  code: boolean;
  muted?: boolean;
};

export type Span =
  | ({ type: "text"; text: string } & { style: SpanStyle })
  | ({ type: "link"; text: string; href: string } & { style: SpanStyle });

// ── Block-level helpers ───────────────────────────────────────────────────────

const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** Indentation of the bullet/number marker (leading spaces; tabs = 4). */
function listItemIndent(line: string): number | null {
  const m = line.match(/^(\s*)(?:[-*]|\d+\.)\s/);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n += ch === "\t" ? 4 : 1;
  return n;
}

/** "ul" for -/* bullets, "ol" for numbered items, null otherwise. */
function listItemKind(line: string): "ul" | "ol" | null {
  if (/^\s*[-*]\s+/.test(line)) return "ul";
  if (/^\s*\d+\.\s+/.test(line)) return "ol";
  return null;
}

/**
 * Recursive list collector. Reads all items whose bullet indent === baseIndent
 * as siblings; immediately-following lines indented deeper become children.
 */
function collectList(
  lines: string[],
  startI: number,
  baseIndent: number,
): { items: ListItem[]; kind: "ul" | "ol"; nextI: number } {
  const items: ListItem[] = [];
  const kind = listItemKind(lines[startI]) ?? "ul";
  let i = startI;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") break; // blank line ends list

    const ind = listItemIndent(line);
    const lk = listItemKind(line);

    if (ind === null || lk === null) break; // non-list line
    if (ind < baseIndent) break; // dedent — return to caller
    if (ind > baseIndent) {
      // Orphaned deeper line without a parent item — skip gracefully.
      i++;
      continue;
    }

    // Extract item text (strip leading whitespace + marker)
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    const text = m?.[1] ?? "";
    i++;

    // Peek: next line deeper-indented and a list item → child list
    let children: ListBlock | undefined;
    if (i < lines.length && lines[i].trim() !== "") {
      const childInd = listItemIndent(lines[i]);
      const childKind = listItemKind(lines[i]);
      if (childInd !== null && childKind !== null && childInd > baseIndent) {
        const child = collectList(lines, i, childInd);
        children = { kind: child.kind, items: child.items } as ListBlock;
        i = child.nextI;
      }
    }

    items.push(children ? { text, children } : { text });
  }

  return { items, kind, nextI: i };
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function isTableRow(line: string): boolean {
  return line.includes("|");
}

/** Each pipe-delimited cell must be only dashes + optional leading/trailing colons. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseAlignCell(cell: string): "left" | "center" | "right" {
  const t = cell.trim();
  const hasLeft = t.startsWith(":");
  const hasRight = t.endsWith(":");
  if (hasLeft && hasRight) return "center";
  if (hasRight) return "right";
  return "left";
}

// ── Block parser ──────────────────────────────────────────────────────────────

export function parseBlocks(src: string): BlockNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: BlockNode[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push({ kind: "p", text: para.join(" ").trim() });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block — capture optional language label after opening ```
    if (/^\s*```/.test(line)) {
      flushPara();
      const langMatch = line.match(/^\s*```(\w+)?/);
      const lang = langMatch?.[1] || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      out.push({ kind: "code", text: code.join("\n"), ...(lang ? { lang } : {}) });
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushPara();
      out.push({ kind: "h", level: heading[1].length, text: heading[2] });
      continue;
    }

    // GitHub pipe table: header line followed by a separator line
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const headers = parseTableRow(line);
      i++; // advance to separator
      const aligns = parseTableRow(lines[i]).map(parseAlignCell);
      i++; // advance to first data row
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      out.push({ kind: "table", headers, aligns, rows });
      i--; // for-loop will i++
      continue;
    }

    // Bullet or ordered list (recursive, supports nesting via collectList)
    const lk = listItemKind(line);
    if (lk !== null) {
      flushPara();
      const baseIndent = listItemIndent(line)!;
      const result = collectList(lines, i, baseIndent);
      out.push({ kind: result.kind, items: result.items });
      i = result.nextI - 1; // for-loop will i++
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote) {
      flushPara();
      out.push({ kind: "quote", text: quote[1] });
      continue;
    }

    para.push(line);
  }
  flushPara();
  return out;
}

// ── Inline tokenizer ──────────────────────────────────────────────────────────

// Walks the string emitting styled spans. Handles bold, italic, bold+italic
// (***...*** or **_..._**), inline code, and [label](url) links.
export function parseInline(input: string, base: SpanStyle): Span[] {
  const spans: Span[] = [];
  let i = 0;
  let buf = "";
  const push = () => {
    if (buf) spans.push({ type: "text", text: buf, style: { ...base } });
    buf = "";
  };

  while (i < input.length) {
    const rest = input.slice(i);

    // inline code
    if (input[i] === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) {
        push();
        spans.push({
          type: "text",
          text: input.slice(i + 1, end),
          style: { ...base, code: true },
        });
        i = end + 1;
        continue;
      }
    }

    // link [label](url)
    const link = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (link) {
      push();
      spans.push({ type: "link", text: link[1], href: link[2], style: { ...base } });
      i += link[0].length;
      continue;
    }

    // bold+italic combined: ***...*** (check before ** and * to avoid partial match)
    const tripleM = rest.match(/^\*\*\*([^\s][\s\S]*?)\*\*\*/);
    if (tripleM) {
      push();
      spans.push(...parseInline(tripleM[1], { ...base, bold: true, italic: true }));
      i += tripleM[0].length;
      continue;
    }

    // bold ** ** or __ __ (opener must not be followed by whitespace —
    // CommonMark left-flanking rule, so "x ** y" isn't emphasis)
    const boldM = rest.match(/^(\*\*|__)([^\s][\s\S]*?)\1/);
    if (boldM) {
      push();
      spans.push(...parseInline(boldM[2], { ...base, bold: true }));
      i += boldM[0].length;
      continue;
    }

    // italic * * or _ _ (opener must not be followed by whitespace, so plain
    // multiplication like "3 * 4 = 12" stays literal)
    const italM = rest.match(/^(\*|_)([^\s*_][\s\S]*?)\1/);
    if (italM) {
      push();
      const inner = italM[2];
      // web tweak: *[stage direction]* renders muted grey
      const muted = inner.startsWith("[") && inner.endsWith("]");
      spans.push(
        ...parseInline(inner, { ...base, italic: true, muted: muted || base.muted }),
      );
      i += italM[0].length;
      continue;
    }

    buf += input[i];
    i++;
  }
  push();
  return spans;
}
