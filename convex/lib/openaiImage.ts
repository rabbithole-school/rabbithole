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
import { postOpenAIWithRetry } from "./openaiRetry";

export type OpenAIImageQuality = "low" | "medium" | "high";

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

  // 429/5xx/transport failures retry inside postOpenAIWithRetry (see there).
  const data = (await postOpenAIWithRetry(
    "https://api.openai.com/v1/images/generations",
    apiKey,
    body,
    "openaiImage",
  )) as { data?: Array<{ b64_json?: unknown }> } | null;
  if (!data) return null;
  const b64 = data?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) {
    console.error("[openaiImage] response carried no image");
    return null;
  }
  return { bytes: base64ToBytes(b64), mimeType: "image/png", model, quality };
}
