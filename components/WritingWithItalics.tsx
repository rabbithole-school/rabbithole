import {
  previewWritingItalics,
  splitWritingItalics,
  type WritingSegment,
} from "@/shared/writingItalics";

/**
 * A scholar's writing with its `*…*` spans drawn in italics (see
 * shared/writingItalics). Inline: it renders text and `<em>`s only, so it
 * drops into whatever `<Text>` or block the caller already styles.
 *
 * Two modes:
 * - `markerColor` (the editor's backdrop) keeps every character, asterisks
 *   included and faint, so the textarea's caret lines up over it.
 * - Otherwise it is a read-only view: markers dropped, and `maxChars` cuts
 *   the visible words after parsing, so a span cut short stays italic.
 */
export function WritingWithItalics({
  content,
  markerColor,
  maxChars,
}: {
  content: string;
  markerColor?: string;
  maxChars?: number;
}) {
  const segments: WritingSegment[] = markerColor
    ? splitWritingItalics(content)
    : previewWritingItalics(content, maxChars ?? Number.POSITIVE_INFINITY);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") return seg.text;
        // Chakra's reset makes <em> upright, so the slant is set explicitly.
        if (seg.kind === "italic") {
          return (
            <em key={i} style={{ fontStyle: "italic" }}>
              {seg.text}
            </em>
          );
        }
        return (
          <span key={i} style={{ color: `var(--chakra-colors-${markerColor!.replace(".", "-")})` }}>
            {seg.text}
          </span>
        );
      })}
    </>
  );
}
