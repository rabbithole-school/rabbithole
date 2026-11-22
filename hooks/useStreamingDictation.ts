"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { haptic } from "@/lib/native";
import {
  EMPTY_COMMIT_ERROR_CODE,
  encodePcm16Wav,
  isBacklogPause,
  isSecretUsable,
  LOUD_LEVEL_DB,
  MIN_TURN_AUDIO_MS,
  parseRealtimeTranscriptionEvent,
  pcm16DurationMs,
  pcm16RmsDb,
  REALTIME_SAMPLE_RATE,
  REALTIME_WEBSOCKET_URL,
  RealtimeAudioRelay,
  realtimeWebSocketProtocols,
  shouldPrefetchSecret,
  SPEECH_LEVEL_DB,
  takeSessionUpdate,
  TakeTranscript,
} from "@/lib/realtimeTranscriptionProtocol";
import { voiceMark, voiceStartMark } from "@/lib/voicePerf";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import { claimMic, releaseMic, useIsMicBusy } from "@/hooks/micOwner";

// "connecting" is the tap → microphone-capturing window: local mic start-up
// only. From "recording" on, every buffer is kept and replayed to the
// transcriber once its socket opens, so the scholar can talk straight away.
export type DictationState = "idle" | "connecting" | "recording" | "transcribing";

type MintedSecret = {
  clientSecret: string;
  expiresAtMs: number;
  model: string;
};

export {
  parseRealtimeTranscriptionEvent,
  reduceTranscriptAssembly,
  type ParsedRealtimeEvent,
  type TranscriptAssembly,
} from "@/lib/realtimeTranscriptionProtocol";

// Shown when a scholar taps the mic on a deployment with no OpenAI key (the
// public local runner). Voice is on-demand there: nothing is pre-warmed.
export const VOICE_UNAVAILABLE_MESSAGE =
  "Voice needs an OpenAI key, which isn't set up here. Type instead.";

const STARTUP_TIMEOUT_MS = 3_500;
const TRANSCRIPT_TIMEOUT_MS = 8_000;
const NO_SPEECH_TIMEOUT_MS = 10_000;
// After ✓ the mic stays open this long, so the chunk holding the last word
// (the worklet posts 100 ms at a time) arrives before the commit.
const TAIL_CAPTURE_MS = 200;
// How long to wait for the worklet to hand over its last partial chunk.
const FLUSH_TIMEOUT_MS = 300;
// After a pause found in the backlog, this long without new speech means the
// scholar really had finished.
const BACKLOG_PAUSE_FOLLOWUP_MS = 3_000;

// Runs on the audio thread: resample the mic to 24 kHz mono 16-bit PCM and
// post ~100 ms chunks. Downsampling averages the input samples that fall in
// each output sample (a box low-pass, enough for speech from 44.1 or 48 kHz);
// a context slower than 24 kHz (some headsets) is upsampled by interpolation.
const PCM_WORKLET_SOURCE = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.step = sampleRate / options.processorOptions.targetRate;
    this.size = Math.round(options.processorOptions.targetRate / 10);
    this.chunk = new Int16Array(this.size);
    this.filled = 0;
    this.sum = 0;
    this.count = 0;
    this.position = 0;
    this.previous = 0;
    // ✓ asks for the partial chunk; "flushed" follows it on the same port,
    // so every sample captured before the request is delivered first.
    this.port.onmessage = () => {
      if (this.filled > 0) {
        this.port.postMessage(this.chunk.slice(0, this.filled).buffer);
        this.filled = 0;
      }
      this.port.postMessage("flushed");
    };
  }
  emit(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.chunk[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.filled === this.size) {
      // Transferring detaches the buffer, so the next chunk is sized from
      // this.size, never from the detached array.
      this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
      this.chunk = new Int16Array(this.size);
      this.filled = 0;
    }
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i];
      if (this.step >= 1) {
        this.sum += sample;
        this.count += 1;
        this.position += 1;
        if (this.position >= this.step) {
          this.position -= this.step;
          this.emit(this.sum / this.count);
          this.sum = 0;
          this.count = 0;
        }
      } else {
        while (this.position < 1) {
          this.emit(this.previous + (sample - this.previous) * this.position);
          this.position += this.step;
        }
        this.position -= 1;
        this.previous = sample;
      }
    }
    return true;
  }
}
registerProcessor("pcm16-capture", Pcm16Capture);
`;

let workletUrl: string | null = null;
function pcmWorkletUrl(): string {
  workletUrl ??= URL.createObjectURL(
    new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }),
  );
  return workletUrl;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return fallback;
}

export function useStreamingDictation(
  onTranscript: (text: string) => void,
  sessionId?: Id<"sessions">,
  onDiagnostic?: (event: string) => void,
) {
  const legacy = useVoiceDictation(onTranscript, sessionId);
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isTooLoud, setIsTooLoud] = useState(false);
  const [hasSpeech, setHasSpeech] = useState(false);
  const [fallbackActive, setFallbackActive] = useState(false);
  // Stable per-instance token for the shared single-owner mic registry. The
  // embedded `legacy` hook carries its OWN token; the streaming path releases
  // this one before handing off so the legacy claim can succeed.
  const [micToken] = useState<symbol>(() => Symbol("streamingDictation"));
  // True only when a token from ANOTHER surface (writing box / handoff) holds
  // the mic. In fallback mode we surface `legacy.isMicBusy` via the spread.
  const streamingMicBusy = useIsMicBusy(micToken);

  // undefined while loading: pre-warm waits for `true`, a tap proceeds as
  // before, so a deployment WITH the key behaves exactly as it always did.
  const voiceAvailable = useQuery(
    api.realtimeTranscription.voiceInputAvailable,
  );
  const mintTranscriptionSecret = useAction(
    api.realtimeTranscription.mintTranscriptionSecret,
  );
  const reportTranscriptionUsage = useMutation(
    api.realtimeTranscription.recordTranscriptionUsage,
  );
  const transcribe = useAction(api.audioActions.transcribe);

  const mountedRef = useRef(true);
  const stateRef = useRef<DictationState>("idle");
  // Realtime transcription failed on this page: later takes still capture
  // from the first moment, and transcribe the clip in one batch request.
  const realtimeDisabledRef = useRef(false);
  const secretRef = useRef<MintedSecret | null>(null);
  const mintInFlightRef = useRef<Promise<MintedSecret> | null>(null);
  const attemptRef = useRef(0);
  // One AudioContext per hook, kept (suspended) between takes: a context
  // first resumed inside a tap stays unlocked, so a later hands-free listen
  // with no gesture behind it can still capture.
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletReadyRef = useRef<Promise<void> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureNodesRef = useRef<{
    source: MediaStreamAudioSourceNode;
    worklet: AudioWorkletNode;
  } | null>(null);
  const captureLiveRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const relayRef = useRef<RealtimeAudioRelay | null>(null);
  const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseFollowupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const speechStartedRef = useRef(false);
  const turnEndedRef = useRef(false);
  const finishedRef = useRef(false);
  const transportFailedRef = useRef(false);
  const batchStartedRef = useRef(false);
  const endTurnRef = useRef<(() => void) | null>(null);

  const emitDiagnostic = useCallback(
    (event: string) => onDiagnostic?.(event),
    [onDiagnostic],
  );

  const setDictationState = useCallback((next: DictationState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  // Turn the microphone off. Idempotent; every path out of a take runs it,
  // and it is the one place the single-owner mic claim is dropped.
  const stopCapture = useCallback(() => {
    captureLiveRef.current = false;
    const nodes = captureNodesRef.current;
    captureNodesRef.current = null;
    if (nodes) {
      nodes.worklet.port.onmessage = null;
      nodes.source.disconnect();
      nodes.worklet.disconnect();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.suspend().catch(() => {});
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    noSpeechTimerRef.current = null;
    if (pauseFollowupTimerRef.current) {
      clearTimeout(pauseFollowupTimerRef.current);
    }
    pauseFollowupTimerRef.current = null;
    if (mountedRef.current) setIsTooLoud(false);
    releaseMic(micToken);
  }, [micToken]);

  const closeTransport = useCallback(() => {
    if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
    if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);
    startupTimerRef.current = null;
    transcriptTimerRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }, []);

  // The one way a take ends: microphone off, socket closed, back to idle.
  // Dropping the relay discards any audio the socket never got.
  const endTake = useCallback(() => {
    finishedRef.current = true;
    endTurnRef.current = null;
    if (tailTimerRef.current) clearTimeout(tailTimerRef.current);
    tailTimerRef.current = null;
    stopCapture();
    closeTransport();
    const relay = relayRef.current;
    relayRef.current = null;
    // Report how long the realtime path heard, so the usage dashboard prices
    // it (the Whisper fallback records its own usage separately).
    if (relay?.hasSentAudio) {
      const audioSeconds =
        pcm16DurationMs(relay.sentBytes, REALTIME_SAMPLE_RATE) / 1000;
      if (audioSeconds >= 0.5) {
        void reportTranscriptionUsage({ audioSeconds, sessionId }).catch(
          () => {},
        );
      }
    }
    setDictationState("idle");
  }, [
    closeTransport,
    reportTranscriptionUsage,
    sessionId,
    setDictationState,
    stopCapture,
  ]);

  // One mint at a time per screen; a tap that lands mid-prefetch awaits it.
  const mintSecret = useCallback((): Promise<MintedSecret> => {
    const inFlight = mintInFlightRef.current;
    if (inFlight) return inFlight;
    const pending = mintTranscriptionSecret({}).then((minted) => {
      secretRef.current = minted;
      return minted;
    });
    mintInFlightRef.current = pending;
    const settle = () => {
      if (mintInFlightRef.current === pending) mintInFlightRef.current = null;
    };
    pending.then(settle, settle);
    return pending;
  }, [mintTranscriptionSecret]);

  // Mint ahead of the tap so the socket can open as soon as the mic does.
  // Failures are silent (the tap path mints again and reports them), and
  // nothing retries: a tripped budget breaker costs one call per
  // mount / tab-visible / take, never a loop.
  const prefetchSecret = useCallback(() => {
    if (voiceAvailable !== true) return;
    if (realtimeDisabledRef.current) return;
    if (!shouldPrefetchSecret(secretRef.current, Date.now())) return;
    mintSecret().catch(() => {});
  }, [mintSecret, voiceAvailable]);

  const getSecret = useCallback(async (): Promise<MintedSecret> => {
    const cached = secretRef.current;
    if (cached && isSecretUsable(cached, Date.now())) {
      prefetchSecret();
      return cached;
    }
    return withTimeout(
      mintSecret(),
      STARTUP_TIMEOUT_MS,
      "Realtime secret mint timed out.",
    );
  }, [mintSecret, prefetchSecret]);

  // `auto` marks a listen nobody tapped for (voice-mode auto-listen); `latched`
  // only means "silence ends the take", which a tap can also ask for.
  const startRecording = useCallback(
    async (opts?: { latched?: boolean; auto?: boolean }) => {
      if (voiceAvailable === false) {
        // A hands-free listen stays silent; a tap explains.
        if (!opts?.auto) setError(VOICE_UNAVAILABLE_MESSAGE);
        return;
      }
      if (fallbackActive) {
        emitDiagnostic("streaming-disabled");
        await legacy.startRecording(opts);
        return;
      }
      if (stateRef.current !== "idle") return;
      // Realtime failed earlier on this page: later takes go to the batch
      // recorder, which has its own silence detection for hands-free takes.
      if (realtimeDisabledRef.current) {
        setFallbackActive(true);
        emitDiagnostic("streaming-disabled");
        await legacy.startRecording(opts);
        return;
      }
      const latched = !!opts?.latched;
      // Single-owner mic: if another surface's recorder holds it, bail
      // silently (no error) — same posture as the legacy path.
      if (!claimMic(micToken)) return;

      // A take cancelled mid-start leaves its awaits pending; when they settle
      // they must not touch a newer take that reset finishedRef.
      const attempt = ++attemptRef.current;
      const isStale = () =>
        finishedRef.current || attemptRef.current !== attempt;
      finishedRef.current = false;
      transportFailedRef.current = false;
      batchStartedRef.current = false;
      speechStartedRef.current = false;
      turnEndedRef.current = false;
      captureLiveRef.current = true;
      setHasSpeech(false);
      setError(null);
      voiceStartMark("micOpen");
      setDictationState("connecting");

      // Created and resumed before the first await, while a tap's user
      // activation still counts.
      let audioContext = audioContextRef.current;
      try {
        if (!audioContext || audioContext.state === "closed") {
          audioContext = new AudioContext();
          audioContextRef.current = audioContext;
          workletReadyRef.current = audioContext.audioWorklet.addModule(
            pcmWorkletUrl(),
          );
        }
        void audioContext.resume().catch(() => {});
      } catch {
        audioContext = null;
      }

      const relay = new RealtimeAudioRelay(bytesToBase64);
      relayRef.current = relay;
      const takeTranscript = new TakeTranscript();
      let heardSpeech = false;
      const capturedMs = () =>
        pcm16DurationMs(relay.capturedBytes, REALTIME_SAMPLE_RATE);

      const deliver = (rawText: string) => {
        if (isStale()) return;
        const transcript = rawText.trim();
        endTake();
        if (!transcript) return;
        voiceMark("transcript");
        onTranscript(transcript);
      };

      // Realtime is gone: transcribe everything captured in one request.
      const transcribeCaptured = async () => {
        if (isStale() || batchStartedRef.current) return;
        batchStartedRef.current = true;
        closeTransport();
        if (capturedMs() < MIN_TURN_AUDIO_MS) {
          endTake();
          return;
        }
        emitDiagnostic("fallback-whisper");
        voiceMark("micClosed");
        try {
          const wav = encodePcm16Wav(relay.audio(), REALTIME_SAMPLE_RATE);
          const result = await transcribe({
            audioBase64: bytesToBase64(wav),
            mimeType: "audio/wav",
            sessionId,
          });
          deliver(result.text ?? "");
        } catch (cause) {
          if (isStale()) return;
          emitDiagnostic(
            `error: ${errorMessage(cause, "Transcription failed.")}`,
          );
          endTake();
          setError("Transcription failed. Please try again.");
        }
      };

      // The socket failed. The microphone keeps going: the take finishes as a
      // batch transcription of everything captured, so no words are lost.
      const failTransport = (cause?: unknown) => {
        if (isStale() || transportFailedRef.current) return;
        transportFailedRef.current = true;
        realtimeDisabledRef.current = true;
        emitDiagnostic(
          `error: ${errorMessage(cause, "Realtime transcription failed.")}`,
        );
        emitDiagnostic("streaming-disabled");
        relay.detach();
        closeTransport();
        if (turnEndedRef.current) {
          // A turn still collecting its tail goes to the batch path when the
          // tail is in (finishTurn sees the failed transport).
          if (!tailTimerRef.current) void transcribeCaptured();
          return;
        }
        if (latched) {
          // Nothing can hear the pause that ends a hands-free take now.
          if (heardSpeech || speechStartedRef.current) endTurn();
          else endTake();
        }
      };

      // The turn is over: mic off, then commit everything captured.
      let turnFinished = false;
      const finishTurn = () => {
        if (tailTimerRef.current) clearTimeout(tailTimerRef.current);
        tailTimerRef.current = null;
        if (isStale() || turnFinished) return;
        turnFinished = true;
        stopCapture();
        if (capturedMs() < MIN_TURN_AUDIO_MS) {
          // Nothing was said; there is no turn to send.
          endTake();
          return;
        }
        if (transportFailedRef.current) {
          void transcribeCaptured();
          return;
        }
        relay.commit();
        // A commit still waiting on the secret or the socket gets the startup
        // budget too; both of those fail into the batch path on their own.
        transcriptTimerRef.current = setTimeout(
          () => failTransport(new Error("Realtime transcript timed out.")),
          TRANSCRIPT_TIMEOUT_MS + (relay.hasSentAudio ? 0 : STARTUP_TIMEOUT_MS),
        );
      };

      // The scholar is done (✓, push-to-talk release, Space/Return).
      const endTurn = () => {
        if (isStale() || turnEndedRef.current) return;
        turnEndedRef.current = true;
        // Declared now, not after the tail: an earlier hands-free item that
        // finishes during the tail must not end the take before this commit.
        takeTranscript.finalCommitRequested();
        voiceMark("speechEnd");
        setDictationState("transcribing");
        if (!captureNodesRef.current) {
          finishTurn();
          return;
        }
        // Keep capturing a moment, then have the worklet hand over its last
        // partial chunk; its "flushed" reply runs finishTurn (or the timeout).
        tailTimerRef.current = setTimeout(() => {
          const nodes = captureNodesRef.current;
          if (!nodes) {
            finishTurn();
            return;
          }
          tailTimerRef.current = setTimeout(finishTurn, FLUSH_TIMEOUT_MS);
          nodes.worklet.port.postMessage("flush");
        }, TAIL_CAPTURE_MS);
      };
      endTurnRef.current = endTurn;

      // Every committed item is transcribed and the turn is over.
      const deliverIfComplete = () => {
        if (!turnEndedRef.current) return;
        const text = takeTranscript.result();
        if (text === null) return;
        emitDiagnostic("turn-complete-streaming");
        deliver(text);
      };

      // ── Transport: secret → socket, in parallel with the microphone. ──────
      const openTransport = async () => {
        try {
          const secret = await getSecret();
          if (isStale() || transportFailedRef.current) return;
          voiceStartMark("secret");
          emitDiagnostic("mint-ok");
          const socket = new WebSocket(
            REALTIME_WEBSOCKET_URL,
            realtimeWebSocketProtocols(secret.clientSecret),
          );
          socketRef.current = socket;
          startupTimerRef.current = setTimeout(
            () => failTransport(new Error("Realtime socket startup timed out.")),
            STARTUP_TIMEOUT_MS,
          );
          socket.onopen = () => {
            if (isStale()) return;
            voiceStartMark("transport");
            emitDiagnostic("socket-open");
            // Events apply in order, so this config governs all of the audio.
            // The browser already processes the mic (noise suppression), so
            // the minted server noise reduction stays.
            const update = takeSessionUpdate({
              handsFree: latched,
              rawMic: false,
            });
            socket.send(update);
            relay.attach((message) => socket.send(message));
          };
          socket.onmessage = (message) => {
            if (isStale()) return;
            let value: unknown;
            try {
              value = JSON.parse(String(message.data));
            } catch {
              return;
            }
            const event = parseRealtimeTranscriptionEvent(value);
            if (event.kind === "sessionReady") {
              if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
              startupTimerRef.current = null;
              if (event.phase === "created") {
                voiceStartMark("sessionReady");
                emitDiagnostic("session-ready");
              }
              return;
            }
            if (event.kind === "speechStarted") {
              emitDiagnostic("speech-started");
              speechStartedRef.current = true;
              if (noSpeechTimerRef.current) {
                clearTimeout(noSpeechTimerRef.current);
                noSpeechTimerRef.current = null;
              }
              if (pauseFollowupTimerRef.current) {
                clearTimeout(pauseFollowupTimerRef.current);
                pauseFollowupTimerRef.current = null;
              }
              if (mountedRef.current) setHasSpeech(true);
              return;
            }
            if (event.kind === "committed") {
              takeTranscript.committed(event.itemId);
              return;
            }
            if (event.kind === "speechStopped") {
              // Server VAD commits after every pause; the take waits for it.
              takeTranscript.speechStopped();
              // A pause the server found deep in the backlog came before
              // words the scholar has already said: keep the take going.
              if (latched && isBacklogPause(event.audioEndMs, capturedMs())) {
                emitDiagnostic("backlog-pause");
                // speechStarted clears this; silence after it ends the turn.
                if (pauseFollowupTimerRef.current) {
                  clearTimeout(pauseFollowupTimerRef.current);
                }
                pauseFollowupTimerRef.current = setTimeout(
                  endTurn,
                  BACKLOG_PAUSE_FOLLOWUP_MS,
                );
                return;
              }
              // Hands-free: the server heard the pause and its VAD committed
              // the turn, so only the microphone needs to stop.
              if (latched && !turnEndedRef.current) {
                turnEndedRef.current = true;
                voiceMark("speechEnd");
                stopCapture();
                setDictationState("transcribing");
                transcriptTimerRef.current = setTimeout(
                  () =>
                    failTransport(new Error("Realtime transcript timed out.")),
                  TRANSCRIPT_TIMEOUT_MS,
                );
              }
              return;
            }
            if (event.kind === "completed") {
              takeTranscript.completed(event.itemId, event.text);
              deliverIfComplete();
              return;
            }
            if (event.kind === "error") {
              // Server VAD took the last of the audio before ✓'s commit did.
              if (
                event.code === EMPTY_COMMIT_ERROR_CODE &&
                turnEndedRef.current
              ) {
                takeTranscript.finalCommitWasEmpty();
                deliverIfComplete();
                return;
              }
              failTransport(new Error(event.message));
            }
          };
          socket.onerror = () =>
            failTransport(new Error("Realtime socket error."));
          socket.onclose = () =>
            failTransport(new Error("Realtime socket closed."));
        } catch (cause) {
          failTransport(cause);
        }
      };
      void openTransport();

      // ── Microphone: capturing from the first moment. ─────────────────────
      try {
        if (!audioContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone capture is unavailable.");
        }
        // The stream is adopted the moment it arrives, so every exit path
        // (a failed worklet load, cancel, unmount) stops it; one that arrives
        // after the take ended is stopped on the spot.
        const streamReady = navigator.mediaDevices
          .getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          })
          .then((stream) => {
            if (isStale() || turnEndedRef.current) {
              stream.getTracks().forEach((track) => track.stop());
            } else {
              streamRef.current = stream;
            }
            return stream;
          });
        const [stream] = await Promise.all([
          streamReady,
          workletReadyRef.current,
        ]);
        if (isStale() || turnEndedRef.current) {
          // Confirmed while starting: finishTurn already ran; just close up.
          if (streamRef.current === stream) stopCapture();
          return;
        }
        const source = audioContext.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(audioContext, "pcm16-capture", {
          processorOptions: { targetRate: REALTIME_SAMPLE_RATE },
        });
        captureNodesRef.current = { source, worklet };
        worklet.port.onmessage = (
          message: MessageEvent<ArrayBuffer | string>,
        ) => {
          if (isStale() || !captureLiveRef.current) return;
          if (typeof message.data === "string") {
            if (turnEndedRef.current) finishTurn();
            return;
          }
          const bytes = new Uint8Array(message.data);
          if (relay.capturedBytes === 0) voiceStartMark("capture");
          relay.push(bytes);
          const db = pcm16RmsDb(bytes);
          if (db >= SPEECH_LEVEL_DB) heardSpeech = true;
          if (!mountedRef.current) return;
          if (heardSpeech) setHasSpeech(true);
          setIsTooLoud(db > LOUD_LEVEL_DB);
        };
        source.connect(worklet);
        // A node with no path to the destination stops being rendered after
        // its first quantum. The worklet writes no output, so this is silent.
        worklet.connect(audioContext.destination);
        await audioContext.resume();
        if (isStale() || turnEndedRef.current) return;
        setDictationState("recording");
        voiceStartMark("listening");
        haptic("light");
        if (latched && !speechStartedRef.current) {
          noSpeechTimerRef.current = setTimeout(() => {
            if (!speechStartedRef.current && !isStale()) endTake();
          }, NO_SPEECH_TIMEOUT_MS);
        }
      } catch (cause) {
        if (isStale()) return;
        // The microphone itself failed: hand this take to the batch recorder,
        // as before. Its own mic claim needs ours released first.
        emitDiagnostic(`error: ${errorMessage(cause, "Microphone failed.")}`);
        endTake();
        setFallbackActive(true);
        emitDiagnostic("fallback-whisper");
        await legacy.startRecording(opts);
      }
    },
    [
      closeTransport,
      emitDiagnostic,
      endTake,
      fallbackActive,
      getSecret,
      legacy,
      micToken,
      onTranscript,
      sessionId,
      setDictationState,
      stopCapture,
      transcribe,
      voiceAvailable,
    ],
  );

  const cancelRecording = useCallback(() => {
    if (fallbackActive) {
      legacy.cancelRecording();
      return;
    }
    if (stateRef.current === "idle") return;
    endTake();
  }, [endTake, fallbackActive, legacy]);

  const stopRecording = useCallback(() => {
    if (fallbackActive) {
      legacy.stopRecording();
      return;
    }
    if (stateRef.current === "connecting") {
      // Still starting: send whatever the mic already delivered, or nothing
      // (a push-to-talk hold released during "Getting ready…" lands here).
      const relay = relayRef.current;
      if (
        relay &&
        pcm16DurationMs(relay.capturedBytes, REALTIME_SAMPLE_RATE) >=
          MIN_TURN_AUDIO_MS
      ) {
        endTurnRef.current?.();
      } else {
        cancelRecording();
      }
      return;
    }
    if (stateRef.current !== "recording") return;
    haptic("light");
    endTurnRef.current?.();
  }, [cancelRecording, fallbackActive, legacy]);

  const toggleRecording = useCallback(async () => {
    if (fallbackActive) {
      await legacy.toggleRecording();
      return;
    }
    if (stateRef.current === "transcribing") return;
    if (stateRef.current === "idle") await startRecording();
    else stopRecording();
  }, [fallbackActive, legacy, startRecording, stopRecording]);

  useEffect(() => {
    // Reset on every effect run — StrictMode's dev double-mount reuses the
    // same refs, so an initializer-only `true` would stay false after the
    // probe unmount and silently suppress all setState calls.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      endTake();
      const audioContext = audioContextRef.current;
      audioContextRef.current = null;
      workletReadyRef.current = null;
      void audioContext?.close().catch(() => {});
    };
  }, [endTake]);

  // Keep a usable secret ready whenever the mic is idle: on mount, after each
  // take, and when the tab becomes visible again (a sleeping iPad outlives
  // the TTL).
  useEffect(() => {
    if (state === "idle") prefetchSecret();
  }, [state, prefetchSecret]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && stateRef.current === "idle") {
        prefetchSecret();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [prefetchSecret]);

  if (fallbackActive) {
    return {
      ...legacy,
      error: legacy.error ?? error,
    };
  }
  return {
    state,
    error,
    isTooLoud,
    hasSpeech,
    isMicBusy: streamingMicBusy,
    toggleRecording,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
