/**
 * Thin retry wrapper for transient Anthropic API errors. The SDK retries twice
 * by default; this adds a couple more with backoff since a full run makes many
 * calls.
 */

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const backoffMs = 1000 * 2 ** i;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}
