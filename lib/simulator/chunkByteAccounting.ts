/**
 * Tracks the UTF-8 size of a canonical JSON array without rebuilding its
 * already-accounted-for prefix.
 */
export function appendCanonicalJsonArrayByteLength(
  currentArrayByteLength: number,
  canonicalItemJson: string,
): number {
  return (
    currentArrayByteLength +
    new TextEncoder().encode(canonicalItemJson).length +
    (currentArrayByteLength === 2 ? 0 : 1)
  );
}
