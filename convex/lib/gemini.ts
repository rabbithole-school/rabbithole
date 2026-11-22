/**
 * Single entry point for the Gemini image model ("Nano Banana Pro").
 *
 * Shared callers build the same generateContent request, parse the same
 * response shape, and decode the same inline base64, so the endpoint, model id,
 * request body, and parsing live here once. Runtime-agnostic (fetch + atob),
 * usable from both the default Convex runtime and "use node" actions.
 */

import {
  GEMINI_IMAGE_MODEL,
  type GeminiImageModel,
} from "./models";
import { base64ToBytes } from "./imageBytes";

/**
 * Request timeout for a single Gemini generateContent call. Since PR #3962
 * every tutor turn heartbeats for its whole life, so a hung tool call no
 * longer surfaces as a Convex action timeout — it reads as "pending" in the
 * composer until something here gives up, which without a timeout was
 * "forever". Sized comfortably above measured image-generation latency: the
 * comparable OpenAI image model (lib/openaiImage.ts) measured 9-19s
 * end-to-end on 2026-09-15; Gemini has no equivalent measurement on file, so
 * this triples that ceiling rather than assuming parity.
 */
export const GEMINI_FETCH_TIMEOUT_MS = 60_000;

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
 *
 * `opts.onFailure` receives a short reason for each failed request (HTTP
 * status, thrown error, or why a 200 carried no image), for callers that keep
 * a durable record: Convex log history only reaches back about an hour.
 */
export async function geminiGenerateImage(
  parts: GeminiPart[],
  opts?: {
    aspectRatio?: string;
    model?: GeminiImageModel;
    quotaFallbackModel?: GeminiImageModel;
    onFailure?: (reason: string) => void;
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
    // AbortController + timer rather than AbortSignal.timeout: this runs in
    // the Convex default runtime (the tutor's generate_image tool in http.ts),
    // where only the controller pattern is used elsewhere in the repo. The
    // timer is cleared after the body is read, so a stalled body aborts too.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept-Encoding": "identity" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const body = await res.text();
        console.error("[gemini] generateContent error:", model, res.status, body);
        opts?.onFailure?.(`${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
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
      if (!img?.inlineData?.data) {
        // A 200 with no image is a safety block, a text-only reply, or an
        // empty candidate. Say which, or the failure is undiagnosable later.
        const reason = describeMissingImage(data);
        console.error("[gemini] generateContent returned no image:", model, reason);
        opts?.onFailure?.(`${model} returned no image: ${reason}`);
        return { image: null, quotaExhausted: false };
      }
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
      opts?.onFailure?.(
        `${model} request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { image: null, quotaExhausted: false };
    } finally {
      clearTimeout(timeout);
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

/**
 * Why a successful generateContent response carried no image: the prompt's
 * block reason, the candidate's finish reason, and the start of any text the
 * model returned instead.
 */
export function describeMissingImage(data: unknown): string {
  // Untrusted JSON: check every field's type so a malformed body still yields
  // a reason instead of a TypeError from the formatter.
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const obj = (v: unknown) =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  const d = obj(data);
  const bits: string[] = [];
  const block = str(obj(d?.promptFeedback)?.blockReason);
  if (block) bits.push(`blockReason=${block}`);
  const candidates = Array.isArray(d?.candidates) ? d.candidates : [];
  const candidate = obj(candidates[0]);
  if (!candidate) bits.push("no candidates");
  const finish = str(candidate?.finishReason);
  if (finish) bits.push(`finishReason=${finish}`);
  const finishMessage = str(candidate?.finishMessage);
  if (finishMessage) bits.push(`finishMessage=${finishMessage.slice(0, 160)}`);
  const parts = obj(candidate?.content)?.parts;
  const text = (Array.isArray(parts) ? parts : [])
    .map((p) => str(obj(p)?.text))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) bits.push(`text="${text.slice(0, 160)}"`);
  return bits.length > 0 ? bits.join(", ") : "empty response";
}
