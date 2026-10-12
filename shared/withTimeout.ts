/**
 * A client-side deadline for a promise the caller cannot otherwise bound.
 *
 * The Convex client queues mutations/actions while its socket is down (or
 * paused for an auth refresh) and never rejects them on its own, so an awaited
 * call can hang indefinitely (e.g. the bake-path picker sitting on loading
 * placeholders). This turns "never" into a rejection the UI can render — the
 * picker shows its fallback paths.
 *
 * It does NOT cancel the underlying work, so it suits reads/suggestions, not
 * non-idempotent writes: a queued write can still commit after the deadline,
 * and a retry would then duplicate it.
 *
 * Source of truth: shared/withTimeout.ts (vendored into native/ by `native/scripts/sync-vendor.js`).
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
