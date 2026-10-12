"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  messageAttachmentMediaKind,
} from "../shared/messageAttachments";
import { staffAction } from "./lib/customFunctions";
import { recordUnitUsage } from "./usage";

function transcriptionFileExtension(mimeType: string): string {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (mime) {
    case "video/mp4":
      return "mp4";
    // Whisper does not list .mov; QuickTime is an MP4-family container and
    // decodes under the .mp4 hint.
    case "video/quicktime":
      return "mp4";
    case "video/webm":
    case "audio/webm":
      return "webm";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    default:
      return mime?.startsWith("video/") ? "mp4" : "m4a";
  }
}

async function transcribeBlob(
  ctx: Pick<ActionCtx, "runMutation">,
  blob: Blob,
  mimeType: string,
  sessionId?: Id<"sessions">,
) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // iOS records AAC in an .m4a container but labels it audio/mp4. Whisper
  // decodes those bytes correctly when the filename ends in .m4a.
  const ext = transcriptionFileExtension(mimeType);

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

  const data = (await res.json()) as { text?: string; duration?: unknown };
  const durationSeconds =
    typeof data.duration === "number" &&
    Number.isFinite(data.duration) &&
    data.duration > 0
      ? data.duration
      : undefined;
  // MediaRecorder and the native high-quality AAC preset are typically near
  // 128 kbps. OpenAI's verbose duration is authoritative; this estimate is
  // only for an unexpectedly incomplete response.
  const estimatedSeconds = (bytes.byteLength * 8) / 128_000;
  const audioSeconds = durationSeconds ?? estimatedSeconds;
  await recordUnitUsage(ctx, {
    source: "whisper-transcription",
    model: "whisper-1",
    audioSeconds,
    sessionId,
  });
  return {
    text: data.text,
    durationSeconds,
  };
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
    const result = await transcribeBlob(
      ctx,
      new Blob([audioBuffer], { type: mimeType }),
      mimeType,
      args.sessionId,
    );
    return { text: result.text };
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
    const result = await transcribeBlob(ctx, blob, mimeType, args.sessionId);
    return { text: result.text };
  },
});

/**
 * Staff-only Whisper path for a recorded chat-composer attachment.
 */
export const transcribeAttachment = staffAction({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.object({
    transcript: v.string(),
    durationSeconds: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("Stored attachment is unavailable");
    if (blob.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `Attachment exceeds Whisper's ${
          MESSAGE_ATTACHMENT_MAX_BYTES / (1024 * 1024)
        } MB limit`,
      );
    }
    if (!messageAttachmentMediaKind(blob.type)) {
      throw new Error("Attachment must be an audio or video recording");
    }

    const result = await transcribeBlob(ctx, blob, blob.type);
    return {
      transcript: result.text ?? "",
      ...(result.durationSeconds !== undefined
        ? { durationSeconds: result.durationSeconds }
        : {}),
    };
  },
});
