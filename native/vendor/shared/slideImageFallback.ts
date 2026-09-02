/**
 * A resolved storage URL may still fail to load. Keep the retry decision shared
 * so web and native return to their existing labelled placeholder together.
 */
export function shouldRenderSlideImage(
  source: string | null,
  failedSource: string | null,
): source is string {
  return source !== null && source !== failedSource;
}
