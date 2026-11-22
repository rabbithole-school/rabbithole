/**
 * Italics in a scholar's writing.
 *
 * A text artifact stays plain text; an italic span is Markdown's `*word*`. The
 * tutor already reads and writes Markdown, the portrait deliverable card and
 * the Slack/aide surfaces already render it, and a plain `.txt` download keeps
 * the convention legible. Italics only, on purpose: writers need them for
 * titles, foreign words, species names and emphasis. Bold, underline and font
 * choice were declined (Andy, 2026-11-19, on a scholar's request).
 *
 * One parser for every surface that draws the writing: the iPad editor, the
 * web editor's backdrop, and the teacher and parent previews. Segments always
 * concatenate back to the exact input, so an editor can style text without
 * moving a single character under the caret.
 */

export type WritingSegment = {
  kind: "text" | "marker" | "italic";
  text: string;
};

// A single `*` opens a span when it is not part of `**`, sits at a word's
// start (no letter or digit right before it) and is followed by a non-space;
// it closes after a non-space and before a non-word character. These are
// CommonMark's flanking rules, narrowed so arithmetic like "5*3*2" or
// "2 * 3 * 4" never turns italic. Spans never cross a line.
const ITALIC =
  /(?<![*\\\p{L}\p{N}])\*(?![\s*])([^*\n]*?[^\s*\\])\*(?![*\p{L}\p{N}])/gu;

export function splitWritingItalics(content: string): WritingSegment[] {
  const segments: WritingSegment[] = [];
  let last = 0;
  for (const match of content.matchAll(ITALIC)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: content.slice(last, start) });
    segments.push({ kind: "marker", text: "*" });
    segments.push({ kind: "italic", text: match[1] });
    segments.push({ kind: "marker", text: "*" });
    last = start + match[0].length;
  }
  if (last < content.length) segments.push({ kind: "text", text: content.slice(last) });
  return segments;
}

/**
 * The visible words of the first `maxChars` characters, markers dropped, as
 * segments: what a read-only preview shows. Parses before cutting, so a span
 * cut short still reads as italic instead of leaving a stray `*`.
 */
export function previewWritingItalics(
  content: string,
  maxChars: number,
): WritingSegment[] {
  const out: WritingSegment[] = [];
  let left = maxChars;
  for (const seg of splitWritingItalics(content)) {
    if (seg.kind === "marker") continue;
    if (left <= 0) break;
    out.push({ kind: seg.kind, text: seg.text.slice(0, left) });
    left -= seg.text.length;
  }
  return out;
}

export type Selection = { start: number; end: number };

type Span = { open: number; close: number }; // offsets of the two markers

function spansOf(content: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  const segments = splitWritingItalics(content);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "marker" && segments[i + 1]?.kind === "italic") {
      spans.push({ open: offset, close: offset + 1 + segments[i + 1].text.length });
    }
    offset += seg.text.length;
  }
  return spans;
}

const WORD = /[\p{L}\p{N}'’]/u;

/**
 * The Italic button (and ⌘I on the web).
 *
 * - A selection inside one span (or covering it, markers included) unwraps it.
 * - Any other selection becomes italic: spans it overlaps are folded in, its
 *   edges grow to whole words, edge spaces and a list bullet stay outside the
 *   markers, and each line gets its own span (a span cannot cross a line).
 * - With nothing selected: inside a span's words, unwrap it; at the end of its
 *   words, step past the closing `*` so typing carries on in plain text; in an
 *   empty `**`, remove it; touching a span from outside, do nothing; anywhere
 *   else, drop an empty `**` and park the caret between them.
 */
export function toggleWritingItalics(
  content: string,
  selection: Selection,
): { content: string; selection: Selection } {
  const lo = clamp(Math.min(selection.start, selection.end), content.length);
  const hi = clamp(Math.max(selection.start, selection.end), content.length);
  const spans = spansOf(content);

  if (lo === hi) {
    const caret = lo;
    if (content.slice(caret - 1, caret + 1) === "**" && content[caret - 2] !== "*" && content[caret + 1] !== "*") {
      return {
        content: content.slice(0, caret - 1) + content.slice(caret + 1),
        selection: { start: caret - 1, end: caret - 1 },
      };
    }
    for (const s of spans) {
      if (caret === s.close) return { content, selection: { start: s.close + 1, end: s.close + 1 } };
      if (caret > s.open && caret < s.close) return unwrap(content, s);
      if (caret === s.open || caret === s.close + 1) return { content, selection };
    }
    return {
      content: `${content.slice(0, caret)}**${content.slice(caret)}`,
      selection: { start: caret + 1, end: caret + 1 },
    };
  }

  const inside = spans.find((s) => lo >= s.open && hi <= s.close + 1 && lo <= s.close && hi > s.open);
  if (inside && lo >= inside.open && hi <= inside.close + 1) return unwrap(content, inside);

  // Fold in every span the selection touches, then widen to whole words.
  let start = lo;
  let end = hi;
  for (const s of spans) {
    if (s.close + 1 > start && s.open < end) {
      start = Math.min(start, s.open);
      end = Math.max(end, s.close + 1);
    }
  }
  while (start > 0 && WORD.test(content[start - 1]) && WORD.test(content[start])) start--;
  while (end < content.length && WORD.test(content[end]) && WORD.test(content[end - 1])) end++;

  const removed = new Set<number>();
  for (const s of spans) {
    if (s.open >= start && s.close < end) {
      removed.add(s.open);
      removed.add(s.close);
    }
  }
  let plain = "";
  for (let i = start; i < end; i++) if (!removed.has(i)) plain += content[i];

  const wrapped = plain
    .split("\n")
    .map((line) => {
      const m = /^(\s*(?:[*\-+]\s+|\d+[.)]\s+)?)(.*?)(\s*)$/.exec(line);
      if (!m || m[2] === "") return line;
      return `${m[1]}*${m[2]}*${m[3]}`;
    })
    .join("\n");
  return {
    content: content.slice(0, start) + wrapped + content.slice(end),
    selection: { start, end: start + wrapped.length },
  };
}

function unwrap(content: string, s: Span) {
  return {
    content:
      content.slice(0, s.open) +
      content.slice(s.open + 1, s.close) +
      content.slice(s.close + 1),
    selection: { start: s.open, end: s.close - 1 },
  };
}

function clamp(n: number, max: number) {
  return Math.max(0, Math.min(n, max));
}
