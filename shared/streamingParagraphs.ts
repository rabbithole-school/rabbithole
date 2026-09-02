// Pure paragraph segmentation for the streaming tutor reply — no React, no RN,
// no DOM, so it's unit-testable in isolation (see streamingParagraphs.test.ts)
// and shared verbatim by BOTH surfaces: the web wet-ink renderer
// (components/StreamingText.tsx) and the native one
// (native/src/components/StreamingText.tsx, via native/vendor/shared/). The
// renderer consumes this to lay the live reply out as paragraph BLOCKS with a
// stable margin, instead of rendering literal `\n\n` blank lines whose height
// snaps in as the next paragraph starts and reflows again when the settled
// <Markdown/> takes over.

/** One paragraph, tagged with its GLOBAL char offset in the source string. */
export type Seg = { start: number; text: string };

/**
 * Split `content` into paragraph segments separated by blank-line runs
 * (`\n{2,}`). Each segment keeps its global `start` offset so a caller whose
 * reveal timeline counts raw characters (separators included) can map straight
 * onto it — the separator chars are consumed by that timeline but never drawn.
 * Leading/trailing blank runs collapse away, matching the settled block parser.
 */
export function segmentParagraphs(content: string): Seg[] {
  const segs: Seg[] = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) segs.push({ start: last, text: content.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  if (last < content.length) segs.push({ start: last, text: content.slice(last) });
  return segs;
}
