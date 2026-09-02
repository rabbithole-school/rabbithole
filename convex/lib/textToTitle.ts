// Shared pure helper — distill free text into a short, human "title-ish"
// phrase: the first sentence/line, trimmed, with a trailing period stripped
// and capped at ~80 chars (ellipsized when longer). Two callers today:
//   - introspectionTools.briefToTitle (a proposal's redacted brief → a
//     one-line status label), and
//   - scholarSuggestions.createMine (a scholar's filed idea → its display
//     title in "My ideas").
// Lives here (Convex-free, dependency-free) so both share ONE implementation
// rather than each mirroring the regex.

export function firstLineToTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const trimmed = firstSentence.trim().replace(/[.]+$/, "");
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77).trimEnd()}…`;
}
