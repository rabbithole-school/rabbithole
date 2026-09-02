export type ExactTextMatchResult =
  | { kind: "one"; index: number }
  | { kind: "none" }
  | { kind: "many"; count: number }
  | { kind: "invalid"; reason: "empty_needle" };

/**
 * Finds one case-sensitive, non-overlapping literal occurrence. Callers may
 * exclude ranges that are not writable in their own representation.
 */
export function findExactlyOneLiteral(
  text: string,
  needle: string,
  isAllowed: (index: number, end: number) => boolean = () => true,
): ExactTextMatchResult {
  if (needle.length === 0) {
    return { kind: "invalid", reason: "empty_needle" };
  }

  let count = 0;
  let firstIndex = -1;
  let fromIndex = 0;
  while (fromIndex <= text.length - needle.length) {
    const index = text.indexOf(needle, fromIndex);
    if (index < 0) break;
    const end = index + needle.length;
    if (isAllowed(index, end)) {
      if (count === 0) firstIndex = index;
      count += 1;
    }
    fromIndex = end;
  }

  if (count === 0) return { kind: "none" };
  if (count === 1) return { kind: "one", index: firstIndex };
  return { kind: "many", count };
}
