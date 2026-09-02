const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 1_000;
const MIN_RETRY_DELAY_MS = 100;

/**
 * Uses a server-calculated duration, rather than comparing clocks across the
 * browser and action runtime. The positive minimum prevents a client with a
 * stale response from hot-looping the action once the claim has expired.
 */
export function pendingPreviewRetryDelay(
  retryAfterMs: number,
  retryDelay: number,
): number {
  return Math.max(MIN_RETRY_DELAY_MS, Math.min(retryDelay, retryAfterMs));
}

export function nextPendingPreviewRetryDelay(retryDelay: number): number {
  return Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
}

export { INITIAL_RETRY_DELAY_MS };
