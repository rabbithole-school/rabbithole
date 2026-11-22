/**
 * One retrying POST for OpenAI's REST API, shared by the charm layer's two
 * OpenAI callers: the image model (lib/openaiImage.ts) and the 3D model writer
 * (lib/openaiResponses.ts).
 *
 * Two failures are RETRYABLE and routine, so a single attempt would leave
 * charm art unnecessarily unmade:
 *
 *  • 429. The org's gpt-image images-per-minute allowance is small (measured:
 *    "Limit 5" on 2026-09-15), so several labels resolving at once will trip it.
 *    The body names its own cooldown ("Please try again in 12s"), so honor that.
 *  • 5xx. Observed live on 2026-09-15: every request, including trivial ones,
 *    returned `server_error` for several minutes and then recovered on its own.
 *    Nothing in the request was at fault, so failing the row would have been
 *    pure collateral damage. There is no Retry-After on these; back off.
 *
 * A thrown fetch (connection reset, DNS, timeout) is the same transient class
 * as a 5xx and gets the same patience.
 */

const RETRY_ATTEMPTS = 4;
const RATE_LIMIT_FALLBACK_DELAY_MS = 15_000;
const RETRY_MAX_DELAY_MS = 60_000;
const SERVER_ERROR_BASE_DELAY_MS = 2_000;

/** Pull the server's own "try again in 12s" hint out of a 429 body. */
function rateLimitDelayMs(body: string): number {
  const match = body.match(/try again in ([\d.]+)\s*(ms|s)\b/i);
  if (!match) return RATE_LIMIT_FALLBACK_DELAY_MS;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return RATE_LIMIT_FALLBACK_DELAY_MS;
  const ms = match[2].toLowerCase() === "ms" ? value : value * 1000;
  // Add a second of slack so we don't land on the boundary of the same window.
  return Math.min(Math.ceil(ms) + 1_000, RETRY_MAX_DELAY_MS);
}

/** Exponential backoff for a 5xx, which carries no cooldown hint. */
function serverErrorDelayMs(attempt: number): number {
  return Math.min(SERVER_ERROR_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST `body` to `url` with the retry policy above. Returns the parsed JSON of
 * a 2xx response, or null on any terminal failure (logged under `tag`).
 */
export async function postOpenAIWithRetry(
  url: string,
  apiKey: string,
  body: string,
  tag: string,
): Promise<unknown | null> {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text();
        const what = res.status === 429 ? "rate limited" : `server error ${res.status}`;
        if (attempt === RETRY_ATTEMPTS) {
          console.error(`[${tag}] ${what}, retries exhausted:`, text.slice(0, 300));
          return null;
        }
        const delay =
          res.status === 429 ? rateLimitDelayMs(text) : serverErrorDelayMs(attempt);
        console.warn(
          `[${tag}] ${what} (attempt ${attempt}/${RETRY_ATTEMPTS}); retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        console.error(`[${tag}] error:`, res.status, (await res.text()).slice(0, 500));
        return null;
      }
      return await res.json();
    } catch (err) {
      if (attempt === RETRY_ATTEMPTS) {
        console.error(`[${tag}] request failed, retries exhausted:`, err);
        return null;
      }
      const delay = serverErrorDelayMs(attempt);
      console.warn(
        `[${tag}] request failed (attempt ${attempt}/${RETRY_ATTEMPTS}); retrying in ${delay}ms`,
        err,
      );
      await sleep(delay);
    }
  }
  return null;
}
