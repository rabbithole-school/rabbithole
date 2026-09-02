/**
 * Pure derivation of the Feed tab's Reading tile caption (TRIAGE L4). With no
 * reading level and no reading history, the caption used to unconditionally
 * read "current" — captioning a blank value ("—") and reading as a stray
 * word next to the Engagement tile's clearer "No observer readings yet"
 * empty state. This branches on whether there's any reading data at all.
 */
export function readingTileCaption({
  readingLevel,
  historyLength,
}: {
  readingLevel: string | null | undefined;
  historyLength: number;
}): "trending" | "current" | "Not set yet" {
  if (historyLength >= 2) return "trending";
  if (readingLevel || historyLength > 0) return "current";
  return "Not set yet";
}
