/**
 * Root-index rules for the n-th root box (extracted from Rabbithole's
 * shared/staticRadicals.ts, which also scans prose for `√18`-style radicals;
 * only the two index helpers the editor needs came along).
 */

function ordinal(index: string): string {
  const value = Number(index);
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** A root index is a canonical base-10 safe integer no smaller than two.
 * Leading zeroes are deliberately rejected: each index has one visual,
 * spoken, and serialized representation. */
export function parseRootIndex(index: string): number | null {
  if (!/^(?:[2-9]\d*|1\d+)$/.test(index)) return null;
  const value = Number(index);
  return Number.isSafeInteger(value) ? value : null;
}

/** Human-readable root name for accessibility labels ("square", "cube",
 * "4th"), or null for an index that is not a valid integer of 2 or more. */
export function rootIndexName(index: string | null | undefined): string | null {
  if (!index || index === "2") return "square";
  if (index === "3") return "cube";
  if (parseRootIndex(index) === null) return null;
  return ordinal(index);
}
