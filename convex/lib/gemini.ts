/**
 * Single entry point for the Gemini image model ("Nano Banana Pro").
 *
 * Two call sites use it: the `generate_image` tutor tool (text -> image) and
 * Magic Annotations (image + instruction -> edited image). Both build the same
 * generateContent request, parse the same response shape, and decode the same
 * inline base64 — so the endpoint, model id, request body, and parsing live
 * here once. Runtime-agnostic (fetch + atob), usable from both the default
 * Convex runtime (http.ts) and "use node" actions.
 */

import {
  GEMINI_IMAGE_MODEL,
  type GeminiImageModel,
} from "./models";
import { base64ToBytes } from "./imageBytes";

/** A content part: either a text instruction or an inline input image. */
export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

/**
 * Call Gemini with the given parts and return the first image it produced, or
 * null on any failure (no key, HTTP error, no image part). Callers decide how
 * to surface null — the tutor tool returns a friendly fallback string, the
 * Magic pipeline treats it as "no transform". Logs the cause for diagnosis.
 *
 * `opts.aspectRatio` (e.g. "1:1") pins the output shape via imageConfig; omit
 * it to keep the model's default framing (tutor illustrations / Magic edits).
 */
export async function geminiGenerateImage(
  parts: GeminiPart[],
  opts?: {
    aspectRatio?: string;
    model?: GeminiImageModel;
    quotaFallbackModel?: GeminiImageModel;
  },
): Promise<{ bytes: Uint8Array; mimeType: string; model: GeminiImageModel } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["IMAGE", "TEXT"],
  };
  if (opts?.aspectRatio) {
    generationConfig.imageConfig = { aspectRatio: opts.aspectRatio };
  }

  const request = async (
    model: GeminiImageModel,
  ): Promise<{
    image: { bytes: Uint8Array; mimeType: string; model: GeminiImageModel } | null;
    quotaExhausted: boolean;
  }> => {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        console.error("[gemini] generateContent error:", model, res.status, body);
        return {
          image: null,
          quotaExhausted:
            res.status === 429 &&
            (body.includes("RESOURCE_EXHAUSTED") ||
              body.includes("GenerateRequestsPerDayPerProjectPerModel")),
        };
      }

      const data = await res.json();
      const outParts = data?.candidates?.[0]?.content?.parts;
      const img = outParts?.find(
        (p: { inlineData?: { mimeType?: string; data?: string } }) =>
          p.inlineData?.mimeType?.startsWith("image/"),
      );
      if (!img?.inlineData?.data) return { image: null, quotaExhausted: false };
      return {
        image: {
          bytes: base64ToBytes(img.inlineData.data),
          mimeType: img.inlineData.mimeType || "image/png",
          model,
        },
        quotaExhausted: false,
      };
    } catch (err) {
      console.error("[gemini] generateContent failed:", model, err);
      return { image: null, quotaExhausted: false };
    }
  };

  const primaryModel = opts?.model ?? GEMINI_IMAGE_MODEL;
  const primary = await request(primaryModel);
  if (primary.image) return primary.image;

  const fallbackModel = opts?.quotaFallbackModel;
  if (!primary.quotaExhausted || !fallbackModel || fallbackModel === primaryModel) {
    return null;
  }
  console.warn(
    `[gemini] ${primaryModel} quota exhausted; retrying with ${fallbackModel}`,
  );
  return (await request(fallbackModel)).image;
}
