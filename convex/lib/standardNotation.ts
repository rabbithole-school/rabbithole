/**
 * Normalize CCSS notation only where a parent-grain crosswalk is intended.
 *
 * Raw notation remains the source-of-truth tag: component rows such as
 * "3.NF.3a" and "3.NF.3b" are distinct standards. This helper is for
 * comparisons against parent-grain tags, such as curated Knowledge Tree nodes.
 */
export function canonicalNotation(notation?: string): string {
  if (!notation) return "";
  return notation
    .split(".")
    .filter((seg, i) => !(i >= 2 && /^[A-Z]$/.test(seg)))
    .map((seg) => seg.replace(/^(\d+)[a-z]+$/, "$1"))
    .join(".");
}
