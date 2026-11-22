// One cross-surface protocol for OpenAI Realtime transcription — the web hook
// and the native hook (vendored by native/scripts/sync-vendor.js) share event
// parsing, transcript assembly, the startup readiness rule, the client-secret
// cache policy, and the copy shown while a take is starting.

/**
 * What the mic control says between the tap and the moment the microphone is
 * actually capturing. Audio is kept from that moment on and replayed to the
 * transcriber once its socket opens (RealtimeAudioRelay), so this covers only
 * the local mic start-up — never the network handshake.
 */
export const DICTATION_CONNECTING_LABEL = "Getting ready…";

export type ParsedRealtimeEvent =
  | { kind: "delta"; itemId: string; text: string }
  | { kind: "completed"; itemId: string; text: string }
  | { kind: "speechStarted" }
  | { kind: "speechStopped"; audioEndMs: number | null }
  | { kind: "committed"; itemId: string }
  | { kind: "sessionReady"; phase: "created" | "updated" }
  | { kind: "error"; message: string; code: string | null }
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
    return {
      kind: "speechStopped",
      audioEndMs:
        typeof event.audio_end_ms === "number" ? event.audio_end_ms : null,
    };
  }
  if (
    event.type === "input_audio_buffer.committed" &&
    typeof event.item_id === "string"
  ) {
    return { kind: "committed", itemId: event.item_id };
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
      code: typeof error?.code === "string" ? error.code : null,
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

// ── Audio transport ──────────────────────────────────────────────────────────
//
// Both clients capture raw PCM from the moment the mic opens and send it over
// a WebSocket as `input_audio_buffer.append` events. Audio captured before the
// socket is open waits in RealtimeAudioRelay and goes out first, so nothing
// said during the handshake is lost. Verified live against OpenAI on
// 2026-11-11: appends sent the instant the socket opens (before
// `session.created`) are kept, and a `session.update` sent ahead of them is
// applied first (a 2.5 s pause did not split a tap-to-talk turn).

/** OpenAI realtime input: 24 kHz, mono, 16-bit little-endian PCM. */
export const REALTIME_SAMPLE_RATE = 24_000;

export const REALTIME_WEBSOCKET_URL = "wss://api.openai.com/v1/realtime";

/**
 * A browser WebSocket can't set an Authorization header, so OpenAI accepts the
 * ephemeral client secret as a subprotocol. React Native uses the same form so
 * the two clients connect identically.
 */
export function realtimeWebSocketProtocols(clientSecret: string): string[] {
  return ["realtime", `openai-insecure-api-key.${clientSecret}`];
}

/** Hands-free end-of-turn for young readers: see takeSessionUpdate. */
export const PATIENT_TURN_DETECTION = {
  type: "semantic_vad",
  eagerness: "low",
} as const;

/**
 * The `session.update` a take sends before any audio. Events apply in order,
 * so it governs all of the take's audio, backlog included.
 *
 * - `handsFree: false` switches VAD off: a tap-to-talk turn ends on ✓, and a
 *   pause must not commit half a sentence.
 * - `handsFree: true` keeps semantic VAD but at `eagerness: "low"`. Every
 *   hands-free take is a young reader's (the pre-reader voice loop, the
 *   your-turn read-aloud), and the minted default (`auto` = medium, up to 4 s)
 *   cut K–2 scholars off mid-sentence ("Tornados are on land and
 *   hurricanes", TRA-706). `low` waits up to 8 s for them to go on.
 * - `rawMic: true` switches the server's noise reduction off. The minted
 *   `far_field` suits audio the OS has already processed (browser
 *   getUserMedia, WebRTC voice processing). On raw iPad mic audio it mangled
 *   transcripts: one captured take came back "Her elephant dance on Tuesday
 *   morning." with `far_field` and word-perfect with none (2026-11-11, same
 *   bytes replayed against each setting).
 */
export function takeSessionUpdate(options: {
  handsFree: boolean;
  rawMic: boolean;
}): string {
  const input: Record<string, unknown> = {
    turn_detection: options.handsFree ? PATIENT_TURN_DETECTION : null,
  };
  if (options.rawMic) input.noise_reduction = null;
  return JSON.stringify({
    type: "session.update",
    session: { type: "transcription", audio: { input } },
  });
}

/**
 * Below this much audio there is nothing to transcribe, and OpenAI rejects a
 * commit of a buffer shorter than 100 ms.
 */
export const MIN_TURN_AUDIO_MS = 100;

/** RMS level (dBFS) at which a buffer counts as someone speaking. */
export const SPEECH_LEVEL_DB = -35;
/** RMS level (dBFS) above which the mic is clipping toward distortion. */
export const LOUD_LEVEL_DB = -10;

/** RMS level of little-endian 16-bit PCM, in dBFS (-100 for silence). */
export function pcm16RmsDb(bytes: Uint8Array): number {
  const samples = Math.floor(bytes.length / 2);
  if (samples === 0) return -100;
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/** dBFS → 0..1 for the waveform: -60 dB is flat, 0 dB is full height. */
export function meterLevelFromDb(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

/** Milliseconds of audio in `byteLength` bytes of mono 16-bit PCM. */
export function pcm16DurationMs(byteLength: number, sampleRate: number): number {
  return (byteLength / 2 / sampleRate) * 1000;
}

/** Wrap 16-bit PCM chunks in a WAV file for the batch (Whisper) fallback. */
export function encodePcm16Wav(
  chunks: readonly Uint8Array[],
  sampleRate: number,
  channels = 1,
): Uint8Array {
  const dataLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const wav = new Uint8Array(44 + dataLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const chunk of chunks) {
    wav.set(chunk, offset);
    offset += chunk.length;
  }
  return wav;
}

/**
 * One take's audio, from the first captured buffer to the end of the turn.
 * Chunks pushed before the socket opens wait here; `attach` sends them in
 * order, and everything after goes out as it arrives. `commit` is held until
 * the backlog is out, so a scholar who finishes before the socket opens still
 * has every word sent. The chunks stay for the batch fallback.
 */
export class RealtimeAudioRelay {
  private readonly chunks: Uint8Array[] = [];
  private sentCount = 0;
  private sentByteLength = 0;
  private send: ((message: string) => void) | null = null;
  private commitRequested = false;
  private commitSent = false;
  private byteLength = 0;

  constructor(private readonly toBase64: (bytes: Uint8Array) => string) {}

  push(chunk: Uint8Array): void {
    if (this.commitRequested || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
    this.flush();
  }

  /** The socket is open: send the backlog, then stream live. */
  attach(send: (message: string) => void): void {
    this.send = send;
    this.flush();
  }

  /** The turn is over: commit once everything captured has been sent. */
  commit(): void {
    this.commitRequested = true;
    this.flush();
  }

  /** The socket is gone: stop sending (the chunks stay for the fallback). */
  detach(): void {
    this.send = null;
  }

  /** Whether any audio has reached the transcriber. */
  get hasSentAudio(): boolean {
    return this.sentCount > 0;
  }

  /** Bytes the transcriber was sent, for usage reporting. */
  get sentBytes(): number {
    return this.sentByteLength;
  }

  get capturedBytes(): number {
    return this.byteLength;
  }

  /** Everything captured, for the batch fallback. */
  audio(): readonly Uint8Array[] {
    return this.chunks;
  }

  private flush(): void {
    const send = this.send;
    if (!send) return;
    while (this.sentCount < this.chunks.length) {
      const chunk = this.chunks[this.sentCount];
      this.sentCount += 1;
      this.sentByteLength += chunk.length;
      send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: this.toBase64(chunk),
        }),
      );
    }
    if (this.commitRequested && !this.commitSent) {
      this.commitSent = true;
      send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  }
}

/**
 * A hands-free pause is a real end of turn only near the live edge of capture.
 * One the server finds deeper in the backlog (audio captured while the socket
 * was still opening) was followed by more speech the scholar already said, so
 * the take keeps going and that turn's text is joined with what follows.
 */
export const BACKLOG_PAUSE_MARGIN_MS = 1_000;

export function isBacklogPause(
  audioEndMs: number | null,
  capturedMs: number,
): boolean {
  return audioEndMs !== null && capturedMs - audioEndMs > BACKLOG_PAUSE_MARGIN_MS;
}

/** OpenAI's error when a commit finds no audio left to commit. */
export const EMPTY_COMMIT_ERROR_CODE = "input_audio_buffer_commit_empty";

/**
 * The transcript of one take, which hands-free can split into several
 * committed items. Events arrive in order on the socket, so commits are
 * matched up as they come: each `speech_stopped` from server VAD is followed
 * by its own commit, and any other commit is ✓'s. The take is complete when
 * nothing VAD stopped is still uncommitted, ✓'s commit (if one was sent) has
 * been acknowledged, and every item has its text. A stop after ✓'s commit
 * concerns audio that was never sent and is ignored. Verified live
 * 2026-11-11: ✓ racing VAD produces either order, and a ✓ commit VAD left
 * empty returns `input_audio_buffer_commit_empty`.
 */
export class TakeTranscript {
  private readonly order: string[] = [];
  private readonly texts = new Map<string, string>();
  private pendingVadCommits = 0;
  private manualCommit: "none" | "sent" | "acknowledged" = "none";

  speechStopped(): void {
    if (this.manualCommit === "acknowledged") return;
    this.pendingVadCommits += 1;
  }

  /** ✓: one more commit is coming, after everything already captured. */
  finalCommitRequested(): void {
    if (this.manualCommit === "none") this.manualCommit = "sent";
  }

  /** ✓'s commit found nothing left (server VAD had taken it all). */
  finalCommitWasEmpty(): void {
    if (this.manualCommit === "sent") this.manualCommit = "acknowledged";
  }

  committed(itemId: string): void {
    if (this.order.includes(itemId)) return;
    this.order.push(itemId);
    if (this.pendingVadCommits > 0) this.pendingVadCommits -= 1;
    else if (this.manualCommit === "sent") this.manualCommit = "acknowledged";
  }

  completed(itemId: string, text: string): void {
    if (!this.order.includes(itemId)) this.committed(itemId);
    this.texts.set(itemId, text);
  }

  /** The joined text once every expected item is in, else null. */
  result(): string | null {
    if (this.pendingVadCommits > 0) return null;
    if (this.manualCommit === "sent") return null;
    if (this.manualCommit === "none" && this.order.length === 0) return null;
    if (this.order.some((id) => !this.texts.has(id))) return null;
    return this.order
      .map((id) => this.texts.get(id)?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
  }
}
