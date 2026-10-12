/**
 * The SSE `error` body the server sends with a 429 when the tutor's LLM limiter
 * refuses a turn. It is a PROTOCOL SENTINEL as much as copy: web and native
 * clients (including installed iPads on older builds) detect a busy refusal by
 * comparing against this exact string, so it must not change. What a person
 * sees is `busyRetryCopy` below, built from the response's `Retry-After`.
 */
export const LLM_BUSY_MESSAGE =
  "Rabbithole is busy right now. Give it a few seconds and try again.";

/**
 * What a scholar sees when a busy refusal ends a turn: honest about the wait
 * the server asked for (`Retry-After`, seconds), in words a young child gets.
 * A 3-minute wait must not say "a few seconds".
 */
export function busyRetryCopy(retryAfterSec: number | null | undefined): string {
  const base = "Lots of people are using Rabbithole right now.";
  if (retryAfterSec == null || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
    return `${base} Try again in a little while.`;
  }
  if (retryAfterSec <= 20) return `${base} Try again in a few seconds.`;
  if (retryAfterSec < 90) return `${base} Try again in about a minute.`;
  const minutes = Math.round(retryAfterSec / 60);
  return `${base} Try again in about ${minutes} minutes.`;
}
