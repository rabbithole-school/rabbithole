/**
 * Practice stems and worked explanations are plain text on both scholar
 * surfaces. Unwrap paired Markdown formatting without touching unmatched
 * mathematical operators such as `2 **3`.
 */
const BOLD_RE =
  /(^|[\s([{"'“‘])\*\*(?=\S)((?:(?!\*\*|\n).)*?\S)\*\*(?=$|[\s.,!?;:)\]}"'”’])/gm;
const ITALIC_RE =
  /(^|[\s([{"'“‘])\*(?!\*)(?=\S)([^*\n]*?\S)\*(?=$|[\s.,!?;:)\]}"'”’])/gm;
const HEADING_RE = /^#{1,6}\s+/gm;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(LINK_RE, "$1")
    .replace(HEADING_RE, "")
    .replace(INLINE_CODE_RE, "$1")
    .replace(BOLD_RE, "$1$2")
    .replace(ITALIC_RE, "$1$2");
}

export function hasMarkdownFormatting(text: string): boolean {
  return stripMarkdownFormatting(text) !== text;
}
