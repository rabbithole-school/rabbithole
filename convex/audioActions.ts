"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { recordUnitUsage } from "./usage";

async function transcribeBlob(
  ctx: Pick<ActionCtx, "runMutation">,
  blob: Blob,
  mimeType: string,
  sessionId?: Id<"sessions">,
) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // iOS records AAC in an .m4a container but labels it audio/mp4. Whisper
  // decodes those bytes correctly when the filename ends in .m4a.
  const ext = mimeType.includes("webm") ? "webm" : "m4a";

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([bytes as unknown as BlobPart], { type: mimeType }),
    `recording.${ext}`,
  );
  formData.append("model", "whisper-1");
  formData.append("language", "en");
  formData.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Whisper API error:", err);
    throw new Error("Transcription failed");
  }

  const data = (await res.json()) as { text: string; duration?: number };
  // MediaRecorder and the native high-quality AAC preset are typically near
  // 128 kbps. OpenAI's verbose duration is authoritative; this estimate is
  // only for an unexpectedly incomplete response.
  const estimatedSeconds = (bytes.byteLength * 8) / 128_000;
  const audioSeconds =
    typeof data.duration === "number" &&
    Number.isFinite(data.duration) &&
    data.duration > 0
      ? data.duration
      : estimatedSeconds;
  await recordUnitUsage(ctx, {
    source: "whisper-transcription",
    model: "whisper-1",
    audioSeconds,
    sessionId,
  });
  return { text: data.text };
}

/**
 * Transcribe audio using OpenAI Whisper API.
 * Called from the frontend via useAction.
 */
export const transcribe = action({
  args: {
    // Audio data as base64-encoded string
    audioBase64: v.string(),
    mimeType: v.optional(v.string()),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args) => {
    const audioBuffer = Buffer.from(args.audioBase64, "base64");
    const mimeType = args.mimeType || "audio/webm";
    return await transcribeBlob(
      ctx,
      new Blob([audioBuffer], { type: mimeType }),
      mimeType,
      args.sessionId,
    );
  },
});

/**
 * Pipeline-only Whisper path for a file already accepted into Convex storage.
 */
export const transcribeStored = internalAction({
  args: {
    storageId: v.id("_storage"),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args) => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("Stored audio is unavailable");
    const mimeType = blob.type || "audio/mp4";
    return await transcribeBlob(ctx, blob, mimeType, args.sessionId);
  },
});
