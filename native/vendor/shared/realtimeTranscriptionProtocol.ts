// One cross-surface protocol for OpenAI Realtime transcription — the web hook
// and the native hook (vendored by native/scripts/sync-vendor.js) share event
// parsing, transcript assembly, the startup readiness rule, the client-secret
// cache policy, and the copy shown while a take is starting.

/**
 * What the mic control says between the tap and the moment audio actually
 * reaches the transcriber. The UI used to say "listening" the instant the mic
 * was tapped, so anything said during the ~1–2 s WebRTC handshake never left
 * the device and the first words of the turn were silently lost.
 */
export const DICTATION_CONNECTING_LABEL = "Getting ready…";

export type ParsedRealtimeEvent =
  | { kind: "delta"; itemId: string; text: string }
  | { kind: "completed"; itemId: string; text: string }
  | { kind: "speechStarted" }
  | { kind: "speechStopped" }
  | { kind: "sessionReady"; phase: "created" | "updated" }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

export type TranscriptAssembly = {
  itemId: string | null;
  partial: string;
  final: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRealtimeTranscriptionEvent(
  value: unknown,
): ParsedRealtimeEvent {
  const event = asRecord(value);
  if (!event || typeof event.type !== "string") return { kind: "ignored" };

  if (
    event.type === "conversation.item.input_audio_transcription.delta" &&
    typeof event.item_id === "string" &&
    typeof event.delta === "string"
  ) {
    return { kind: "delta", itemId: event.item_id, text: event.delta };
  }
  if (
    event.type === "conversation.item.input_audio_transcription.completed" &&
    typeof event.item_id === "string" &&
    typeof event.transcript === "string"
  ) {
    return {
      kind: "completed",
      itemId: event.item_id,
      text: event.transcript,
    };
  }
  if (event.type === "input_audio_buffer.speech_started") {
    return { kind: "speechStarted" };
  }
  if (event.type === "input_audio_buffer.speech_stopped") {
    return { kind: "speechStopped" };
  }
  if (event.type === "session.created") {
    return { kind: "sessionReady", phase: "created" };
  }
  if (event.type === "session.updated") {
    return { kind: "sessionReady", phase: "updated" };
  }
  if (
    event.type === "error" ||
    event.type === "conversation.item.input_audio_transcription.failed"
  ) {
    const error = asRecord(event.error);
    return {
      kind: "error",
      message:
        (typeof error?.message === "string" && error.message) ||
        "Realtime transcription failed.",
    };
  }
  return { kind: "ignored" };
}

export function reduceTranscriptAssembly(
  current: TranscriptAssembly,
  event: ParsedRealtimeEvent,
): TranscriptAssembly {
  if (event.kind === "delta") {
    return {
      itemId: event.itemId,
      partial:
        current.itemId === event.itemId
          ? current.partial + event.text
          : event.text,
      final: null,
    };
  }
  if (event.kind === "completed") {
    return {
      itemId: event.itemId,
      partial: event.text,
      final: event.text,
    };
  }
  return current;
}

/**
 * True when this session event means audio from here on is transcribed under
 * the turn's real configuration — the moment the UI may say "listening".
 *
 * The minted secret configures semantic VAD. A tap-to-talk turn switches VAD
 * off with a `session.update` as soon as the data channel opens, so it is
 * ready only at the `session.updated` acknowledging that; before it, a pause
 * could auto-commit half a sentence as the whole turn. A hands-free (latched)
 * turn keeps the minted VAD config and is ready at the first session event.
 */
export function isSessionReadyForTurn(
  event: ParsedRealtimeEvent,
  latched: boolean,
): boolean {
  if (event.kind !== "sessionReady") return false;
  return latched || event.phase === "updated";
}

export type CachedRealtimeSecret = { expiresAtMs: number };

/**
 * A cached secret must outlive the handshake it is about to start (secret →
 * SDP POST can take a few seconds on a slow network), so it stops counting as
 * usable this long before OpenAI's expiry.
 */
export const SECRET_USABLE_MARGIN_MS = 30_000;

/**
 * A background prefetch replaces a secret once it is this close to expiry, so
 * the next tap still finds a usable one. The TTL is 10 minutes
 * (convex/realtimeTranscription.ts), and prefetches run only on mount, after a
 * take, and on return to the foreground — never on a timer — so an open
 * screen mints at most about once per 8 minutes of actual use.
 */
export const SECRET_REFRESH_AHEAD_MS = 120_000;

/** Whether a cached secret may start a session right now. */
export function isSecretUsable(
  secret: CachedRealtimeSecret | null,
  nowMs: number,
): boolean {
  return (
    secret !== null && secret.expiresAtMs - SECRET_USABLE_MARGIN_MS > nowMs
  );
}

/** Whether a background prefetch should mint a replacement secret. */
export function shouldPrefetchSecret(
  secret: CachedRealtimeSecret | null,
  nowMs: number,
): boolean {
  return (
    secret === null || secret.expiresAtMs - SECRET_REFRESH_AHEAD_MS <= nowMs
  );
}
