/**
 * Single entry point for OpenAI's GPT-Image-2.5 models — the charm layer's
 * image generator (manipulative theme icons, world species sprites, earned
 * flair, quest badges).
 *
 * WHY this exists beside lib/gemini.ts: every one of those four pipelines needs
 * a TRANSPARENT sprite, and Gemini's image models cannot emit alpha. So they all
 * used to render the subject on a flat chroma screen and key it out afterwards
 * (the now-deleted lib/chromaImage.ts) — a second lossy step that fringed soft
 * edges, forced a dozen words of "perfectly flat uniform green, no shadow" into
 * every prompt, and still failed on the exact art that needs alpha most (an
 * embroidered patch's merrowed border, a medallion's specular falloff).
 * `background: "transparent"` removes the whole apparatus: the model returns
 * real alpha, antialiased, with no key to tune.
 *
 * Runtime-agnostic (fetch + base64 only), same return shape as
 * `geminiGenerateImage` so call sites differ by one line.
 *
 * Measured against this org 2026-09-15 (1024x1024, background transparent):
 * background pixels come back at alpha 0 with clean corners, subject pixels at
 * alpha 251-254 (visually opaque), and ~1% of pixels carry a genuine
 * antialiased edge ramp. Latency 9-19s; quality "low" = 196 output image
 * tokens, "medium" = 439.
 */

import { OPENAI_IMAGE_MODEL, type OpenAIImageModel } from "./models";
import { base64ToBytes } from "./imageBytes";

export type OpenAIImageQuality = "low" | "medium" | "high";

/**
 * Two failures here are RETRYABLE and routine, so a single attempt would leave
 * art unnecessarily unmade — and a failed sprite means a label sits on its
 * plain-shape fallback until someone re-runs it by hand.
 *
 *  • 429. The org's gpt-image images-per-minute allowance is small (measured:
 *    "Limit 5" on 2026-09-15), so several labels resolving at once will trip it.
 *    The body names its own cooldown ("Please try again in 12s"), so honor that.
 *  • 5xx. Observed live on 2026-09-15: every request, including trivial ones,
 *    returned `server_error` for several minutes and then recovered on its own.
 *    Nothing in the request was at fault, so failing the row would have been
 *    pure collateral damage. There is no Retry-After on these; back off.
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
 * Generate one image and return its bytes, or null on any failure (no key,
 * HTTP error, exhausted retries, no image in the response). Callers decide how
 * to surface null — every charm pipeline marks its row failed and leaves the
 * previous art live.
 *
 * `quality` is the cost/fidelity dial and should match the DISPLAY size:
 * "low" for art that tiles at 32-64px, "medium" for art shown large.
 */
export async function openaiGenerateImage(
  prompt: string,
  opts?: {
    quality?: OpenAIImageQuality;
    size?: string;
    model?: OpenAIImageModel;
  },
): Promise<{
  bytes: Uint8Array;
  mimeType: string;
  model: OpenAIImageModel;
  quality: OpenAIImageQuality;
} | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[openaiImage] OPENAI_API_KEY is not set");
    return null;
  }

  const model = opts?.model ?? OPENAI_IMAGE_MODEL;
  const quality = opts?.quality ?? "medium";
  const body = JSON.stringify({
    model,
    prompt,
    size: opts?.size ?? "1024x1024",
    quality,
    // The two that matter: real alpha, in a format that can carry it.
    background: "transparent",
    output_format: "png",
    n: 1,
  });

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
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
          console.error(`[openaiImage] ${what}, retries exhausted:`, text.slice(0, 300));
          return null;
        }
        const delay =
          res.status === 429 ? rateLimitDelayMs(text) : serverErrorDelayMs(attempt);
        console.warn(
          `[openaiImage] ${what} (attempt ${attempt}/${RETRY_ATTEMPTS}); retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        console.error("[openaiImage] error:", model, res.status, (await res.text()).slice(0, 500));
        return null;
      }

      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || !b64) {
        console.error("[openaiImage] response carried no image");
        return null;
      }
      return { bytes: base64ToBytes(b64), mimeType: "image/png", model, quality };
    } catch (err) {
      // A thrown fetch is a transport failure (connection reset, DNS, timeout).
      // That is the same transient class as the 5xx above and deserves the same
      // patience — retrying only the HTTP-level failure would be arbitrary.
      if (attempt === RETRY_ATTEMPTS) {
        console.error("[openaiImage] request failed, retries exhausted:", model, err);
        return null;
      }
      const delay = serverErrorDelayMs(attempt);
      console.warn(
        `[openaiImage] request failed (attempt ${attempt}/${RETRY_ATTEMPTS}); retrying in ${delay}ms`,
        err,
      );
      await sleep(delay);
    }
  }
  return null;
}
