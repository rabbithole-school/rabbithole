// Mints short-lived OpenAI Realtime credentials for authenticated browser
// transcription sessions without exposing Rabbithole's OpenAI API key.

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { authedAction, authedMutation } from "./lib/customFunctions";
import { llmBudgetExceeded, llmBudgetMessage } from "./llmBudget";

const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
// Long enough that a multi-turn voice conversation reuses one secret
// (turn gaps easily exceed a minute while the tutor speaks) instead of
// paying a mint round-trip before every listen.
const CLIENT_SECRET_TTL_SECONDS = 600;

type ClientSecretResponse = {
  value?: unknown;
  expires_at?: unknown;
};

export const mintTranscriptionSecret = authedAction({
  args: {},
  returns: v.object({
    clientSecret: v.string(),
    expiresAtMs: v.number(),
    model: v.string(),
  }),
  handler: async (ctx): Promise<{
    clientSecret: string;
    expiresAtMs: number;
    model: string;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not configured; cannot start realtime transcription.",
      );
    }

    // Same daily-USD breaker the LLM entry points honor — a minted secret
    // is a spend credential, so it goes behind the same gate.
    const cap = await llmBudgetExceeded(ctx);
    if (cap !== null) throw new Error(llmBudgetMessage(cap));

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expires_after: {
            anchor: "created_at",
            seconds: CLIENT_SECRET_TTL_SECONDS,
          },
          session: {
            type: "transcription",
            audio: {
              input: {
                transcription: {
                  model: TRANSCRIPTION_MODEL,
                  language: "en",
                },
                turn_detection: {
                  type: "semantic_vad",
                },
                noise_reduction: {
                  type: "far_field",
                },
              },
            },
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `OpenAI realtime client-secret request failed with status ${response.status}.`,
      );
    }

    const payload = (await response.json()) as ClientSecretResponse;
    if (
      typeof payload.value !== "string" ||
      typeof payload.expires_at !== "number"
    ) {
      throw new Error(
        "OpenAI realtime client-secret response was missing required fields.",
      );
    }

    return {
      clientSecret: payload.value,
      expiresAtMs: payload.expires_at * 1000,
      model: TRANSCRIPTION_MODEL,
    };
  },
});

// Streaming transcription happens client↔OpenAI, so the backend never sees
// the audio; the client reports how long the mic streamed so the usage
// report prices the primary voice-input path, not just the Whisper
// fallback. Client-reported and clamped — cost telemetry, not billing.
const MAX_REPORTED_AUDIO_SECONDS = 900;

export const recordTranscriptionUsage = authedMutation({
  args: {
    audioSeconds: v.number(),
    sessionId: v.optional(v.id("sessions")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const audioSeconds = Math.min(
      Math.max(0, args.audioSeconds),
      MAX_REPORTED_AUDIO_SECONDS,
    );
    if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return null;
    await ctx.db.insert("usageEvents", {
      source: "realtime-transcription",
      model: TRANSCRIPTION_MODEL,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      audioSeconds,
      sessionId: args.sessionId,
      createdAt: Date.now(),
    });
    return null;
  },
});
