/**
 * Retry timing and the submit deadline for the practice outbox — the two pieces
 * of the drain loop that are pure arithmetic rather than orchestration. Imports
 * nothing, so it vendors into the native bundle standalone alongside
 * `practiceOutboxContract.ts` (which owns the ordering/durability semantics).
 *
 * Deliberately NOT here: a "can the scholar advance from a queued answer"
 * helper. An earlier draft of this module exported
 * `queuedFeedbackCanAdvance(phase: string, busy: boolean)`, which encoded that
 * decision as a comparison against one surface's stringly-typed phase name. In
 * the practice machine "queued, and nothing is in flight for this item" is a
 * property of the typed item state itself, so a caller reads it from the state
 * it already holds instead of re-deriving it from a string that only one
 * component ever produced.
 */

const INITIAL_RETRY_DELAY_MS = 1_000;

/** The ceiling on drain backoff. A queued answer is never dropped, so the only
 *  cost of a long outage is that retries space out to this interval. */
export const MAX_OUTBOX_RETRY_DELAY_MS = 30_000;

/** How long one live submit may hang before it is treated as an ambiguous
 *  failure and routed to the outbox. A request that is still open after this
 *  may still land server-side, which is exactly why the queued replay carries
 *  the SAME `clientEventId` — the server's dedup makes the double safe. */
export const PRACTICE_SUBMIT_TIMEOUT_MS = 10_000;

/**
 * Exponential backoff for repeated drain failures, capped. `failureCount` is
 * the number of consecutive failed drain passes: the first failure waits
 * `INITIAL_RETRY_DELAY_MS`, and each subsequent one doubles up to the cap.
 * Values below 1 are clamped, so a caller that passes 0 still gets a real
 * delay rather than an immediate hot loop.
 */
export function outboxRetryDelayMs(failureCount: number): number {
  const exponent = Math.max(0, Math.floor(failureCount) - 1);
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** exponent, MAX_OUTBOX_RETRY_DELAY_MS);
}

/**
 * Bound a submit so an indefinitely-hanging request becomes an ambiguous
 * failure the caller can queue, rather than a spinner the scholar is stuck
 * behind. The timer is always cleared, including on the success path, so a
 * resolved submit never leaves a pending timeout holding the event loop.
 */
export async function withPracticeSubmitTimeout<T>(
  submission: Promise<T>,
  timeoutMs = PRACTICE_SUBMIT_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      submission,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Practice submission timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
