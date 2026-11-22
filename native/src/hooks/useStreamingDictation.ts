import { useAction, useMutation, useQuery } from "convex/react";
import {
  AudioModule,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioStream,
  type AudioStreamBuffer,
} from "expo-audio";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking } from "react-native";

import { useVoiceDictation, MAX_RECORDING_MS } from "@/hooks/useVoiceDictation";
import { api, type Id } from "@/lib/convex";
import { appStatusBus } from "@/lib/appStatusBus";
import { getNativeTTS } from "@/lib/nativeTTS";
import { bytesToBase64 } from "@/lib/ttsAudio";
import { TUTOR_ECHO_TAIL_MS } from "@/lib/voiceLoop";
import { voiceMark, voiceStartMark } from "@/lib/voicePerf";
import {
  EMPTY_COMMIT_ERROR_CODE,
  encodePcm16Wav,
  isBacklogPause,
  isSecretUsable,
  LOUD_LEVEL_DB,
  meterLevelFromDb,
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
  type ParsedRealtimeEvent,
} from "../../vendor/shared/realtimeTranscriptionProtocol";

// "connecting" is the tap → microphone-capturing window: local mic start-up
// only. From "recording" on, every buffer is kept and replayed to the
// transcriber once its socket opens, so the scholar can talk straight away.
type DictationState = "idle" | "connecting" | "recording" | "transcribing";

type MintedSecret = {
  clientSecret: string;
  expiresAtMs: number;
  model: string;
};

const STARTUP_TIMEOUT_MS = 3_500;
const TRANSCRIPT_TIMEOUT_MS = 8_000;
const NO_SPEECH_TIMEOUT_MS = 10_000;
// After ✓ the mic stays open this long, so the buffer holding the last word
// (the stream delivers 100 ms at a time) arrives before the commit.
const TAIL_CAPTURE_MS = 200;
// After a pause found in the backlog, this long without new speech means the
// scholar really had finished.
const BACKLOG_PAUSE_FOLLOWUP_MS = 3_000;

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

// AudioStream ships in expo-audio 57's native module. A binary built before it
// has no such class, and the hook falls back to the batch recorder.
function audioStreamSupported(): boolean {
  return (
    typeof (AudioModule as { AudioStream?: unknown }).AudioStream === "function"
  );
}

// Starting and stopping the microphone reconfigure the one shared iOS audio
// session, so they run one at a time across every dictation hook: a take
// cancelled mid-start finishes shutting down before the next take starts.
let micQueue: Promise<unknown> = Promise.resolve();
function onMicQueue<T>(op: () => Promise<T>): Promise<T> {
  const run = micQueue.then(op, op);
  micQueue = run.catch(() => {});
  return run;
}

// AudioStream leaves the shared session in the record-only category, which
// would silence the next read-aloud, so playback is put back after capture.
async function restorePlayback(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    allowsRecording: false,
  }).catch(() => {});
}

// The one stream capturing right now, across every hook. iOS has one audio
// session, so a second take starting anywhere ends the first (newest press
// wins) instead of two streams reconfiguring the session under each other.
let activeMic: { stream: AudioStream; preempted: () => void } | null = null;

// A preempted stream is closed by the take that preempted it and again by its
// own take's cleanup; only the first close touches it.
const closedStreams = new WeakSet<AudioStream>();

async function closeStream(stream: AudioStream): Promise<void> {
  if (closedStreams.has(stream)) return;
  closedStreams.add(stream);
  if (activeMic?.stream === stream) activeMic = null;
  try {
    stream.stop();
  } catch {
    // Already stopped.
  }
  stream.release();
  await restorePlayback();
}

// Turn one native mic stream off and give the audio session back.
function shutStream(stream: AudioStream): void {
  void onMicQueue(() => closeStream(stream));
}

function parseSocketEvent(data: unknown): ParsedRealtimeEvent {
  try {
    return parseRealtimeTranscriptionEvent(JSON.parse(String(data)));
  } catch {
    return { kind: "ignored" };
  }
}

// Start the live microphone: 24 kHz mono 16-bit PCM, buffers delivered to
// `onBuffer` from the first sample. Resolves null, with the mic closed again,
// if the take stopped wanting it before or while it started. Rejects (with
// nothing left running) if this build has no AudioStream or the mic won't start.
type MicStream = { stream: AudioStream; subscription: { remove: () => void } };

function startMicStream(
  onBuffer: (buffer: AudioStreamBuffer) => void,
  stillWanted: () => boolean,
  preempted: () => void,
): Promise<MicStream | null> {
  return onMicQueue<MicStream | null>(async () => {
    if (!stillWanted()) return null;
    const previous = activeMic;
    if (previous) {
      activeMic = null;
      await closeStream(previous.stream);
      previous.preempted();
    }
    // Closing the previous stream awaited; this take may have been cancelled.
    if (!stillWanted()) return null;
    if (!audioStreamSupported()) {
      throw new Error("This build has no live microphone stream.");
    }
    const stream = new AudioModule.AudioStream({
      sampleRate: REALTIME_SAMPLE_RATE,
      channels: 1,
      encoding: "int16",
    });
    const subscription = stream.addListener("audioStreamBuffer", onBuffer);
    const started = await stream.start().then(
      () => true,
      (cause: unknown) => cause,
    );
    if (started !== true) {
      subscription.remove();
      // start() may have switched the session to record-only before failing.
      await closeStream(stream);
      throw started;
    }
    if (!stillWanted()) {
      subscription.remove();
      await closeStream(stream);
      return null;
    }
    activeMic = { stream, preempted };
    return { stream, subscription };
  });
}

// Shown when a scholar taps the mic on a deployment with no OpenAI key (the
// public local runner). Voice is on-demand there: nothing is pre-warmed.
// Mirrors the web hook's copy.
export const VOICE_UNAVAILABLE_MESSAGE =
  "Voice needs an OpenAI key, which isn't set up here. Type instead.";

export function useStreamingDictation(
  onTranscript: (text: string) => void,
  sessionId?: Id<"sessions">,
  onDiagnostic?: (event: string) => void,
) {
  const legacy = useVoiceDictation(sessionId);
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

  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fallbackActive, setFallbackActive] = useState(false);
  const [hasSpeech, setHasSpeech] = useState(false);
  const [isTooLoud, setIsTooLoud] = useState(false);
  const [level, setLevel] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isMaxed, setIsMaxed] = useState(false);

  const mountedRef = useRef(true);
  const stateRef = useRef<DictationState>("idle");
  // Realtime transcription failed on this screen: later takes still capture
  // from the first moment, and transcribe the clip in one batch request.
  const realtimeDisabledRef = useRef(false);
  const secretRef = useRef<MintedSecret | null>(null);
  const mintInFlightRef = useRef<Promise<MintedSecret> | null>(null);
  const streamRef = useRef<AudioStream | null>(null);
  const streamSubscriptionRef = useRef<{ remove: () => void } | null>(null);
  // True from the tap until the mic is turned off; buffers outside it are
  // dropped (a late buffer after ✓ must not join the committed turn).
  const captureLiveRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const relayRef = useRef<RealtimeAudioRelay | null>(null);
  const sampleRateRef = useRef(REALTIME_SAMPLE_RATE);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const attemptRef = useRef(0);
  const micOwnerRef = useRef(
    appStatusBus.createMicOwner("streaming-dictation"),
  );
  // The current take's turn-ending handler, so the stable stop callback below
  // reaches the take's closure.
  const endTurnRef = useRef<(() => void) | null>(null);

  const emitDiagnostic = useCallback(
    (event: string) => onDiagnostic?.(event),
    [onDiagnostic],
  );

  const setDictationState = useCallback((next: DictationState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  // Turn the microphone off. Idempotent; every path out of a take runs it.
  const stopCapture = useCallback(() => {
    captureLiveRef.current = false;
    const stream = streamRef.current;
    streamRef.current = null;
    streamSubscriptionRef.current?.remove();
    streamSubscriptionRef.current = null;
    if (stream) shutStream(stream);
    appStatusBus.setMicOwned(micOwnerRef.current, false);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    maxTimerRef.current = null;
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    noSpeechTimerRef.current = null;
    if (pauseFollowupTimerRef.current) {
      clearTimeout(pauseFollowupTimerRef.current);
    }
    pauseFollowupTimerRef.current = null;
    if (mountedRef.current) {
      setLevel(0);
      setIsTooLoud(false);
    }
  }, []);

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
    // Only what the socket was sent is realtime usage; a batch fallback
    // records its own.
    if (relay?.hasSentAudio) {
      const audioSeconds =
        pcm16DurationMs(relay.sentBytes, sampleRateRef.current) / 1000;
      if (audioSeconds >= 0.5) {
        void reportTranscriptionUsage({ audioSeconds, sessionId }).catch(
          () => {},
        );
      }
    }
    setIsMaxed(false);
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
  // nothing retries: a tripped budget breaker costs one call per mount /
  // foreground / take, never a loop.
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

  const stopLegacyRecording = useCallback(() => {
    void legacy.stop().then((text) => {
      if (text) onTranscript(text);
    });
  }, [legacy, onTranscript]);

  // `auto` marks a listen nobody tapped for (pre-reader auto-listen);
  // `latched` only means "silence ends the take".
  const startRecording = useCallback(
    async (opts?: { latched?: boolean; auto?: boolean }) => {
      if (voiceAvailable === false) {
        // A hands-free listen stays silent; a tap explains.
        if (!opts?.auto) {
          setError(VOICE_UNAVAILABLE_MESSAGE);
          Alert.alert("Voice isn't set up here", VOICE_UNAVAILABLE_MESSAGE);
        }
        return;
      }
      const latched = !!opts?.latched;
      if (fallbackActive) {
        emitDiagnostic("streaming-disabled");
        // The batch recorder has no voice-activity detection, so it can't
        // honor a hands-free (latched) listen — it would hold the mic open
        // until a tap. Leave the ordinary tap-to-talk state instead.
        if (latched) return;
        await legacy.start();
        return;
      }
      // Without realtime there is no voice-activity detection either.
      if (realtimeDisabledRef.current && latched) return;
      if (stateRef.current !== "idle") return;

      // A take cancelled mid-start leaves its awaits pending; when they settle
      // they must not touch a newer take that reset finishedRef.
      const attempt = ++attemptRef.current;
      const isStale = () =>
        finishedRef.current || attemptRef.current !== attempt;
      finishedRef.current = false;
      transportFailedRef.current = realtimeDisabledRef.current;
      batchStartedRef.current = false;
      speechStartedRef.current = false;
      turnEndedRef.current = false;
      captureLiveRef.current = true;
      sampleRateRef.current = REALTIME_SAMPLE_RATE;
      setError(null);
      setHasSpeech(false);
      setIsTooLoud(false);
      setLevel(0);
      setDurationMs(0);
      setIsMaxed(false);
      voiceStartMark("micOpen");
      appStatusBus.setMicOwned(micOwnerRef.current, true);
      setDictationState("connecting");

      const relay = new RealtimeAudioRelay(bytesToBase64);
      relayRef.current = relay;
      const takeTranscript = new TakeTranscript();
      let heardSpeech = false;
      // Last time a buffer was blanked because the tutor's voice was playing
      // (TRA-706); the no-speech timeout counts from after it.
      let lastTutorAudioAtMs = 0;
      const capturedMs = () =>
        pcm16DurationMs(relay.capturedBytes, sampleRateRef.current);

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
        const onBatchFailed = (cause: unknown) => {
          if (isStale()) return;
          emitDiagnostic(
            `error: ${errorMessage(cause, "Transcription failed.")}`,
          );
          endTake();
          setError("Transcription failed. Please try again.");
          Alert.alert(
            "Transcription failed",
            "Tap the mic and try speaking again.",
          );
        };
        await Promise.resolve()
          .then(() =>
            transcribe({
              audioBase64: bytesToBase64(
                encodePcm16Wav(relay.audio(), sampleRateRef.current),
              ),
              mimeType: "audio/wav",
              sessionId,
            }),
          )
          .then((result) => deliver(result.text ?? ""), onBatchFailed);
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
      const finishTurn = () => {
        tailTimerRef.current = null;
        if (isStale()) return;
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

      // The scholar is done (✓, the mic key, Space/Return).
      const endTurn = () => {
        if (isStale() || turnEndedRef.current) return;
        turnEndedRef.current = true;
        // Declared now, not after the tail: an earlier hands-free item that
        // finishes during the tail must not end the take before this commit.
        takeTranscript.finalCommitRequested();
        voiceMark("speechEnd");
        setIsMaxed(false);
        setDictationState("transcribing");
        if (streamRef.current) {
          tailTimerRef.current = setTimeout(finishTurn, TAIL_CAPTURE_MS);
        } else {
          finishTurn();
        }
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

      const onBuffer = (buffer: AudioStreamBuffer) => {
        if (isStale() || !captureLiveRef.current) return;
        if (relay.capturedBytes === 0) {
          voiceStartMark("capture");
          if (buffer.sampleRate !== REALTIME_SAMPLE_RATE) {
            // The device couldn't resample; keep the clip for the batch path,
            // which reads the real rate from the WAV header.
            sampleRateRef.current = buffer.sampleRate;
            failTransport(
              new Error(`Microphone delivered ${buffer.sampleRate} Hz audio.`),
            );
          }
        }
        // Copy out of native memory before keeping it for the whole take.
        const bytes = new Uint8Array(buffer.data.slice(0));
        // The raw mic has no echo cancellation: while the tutor's voice plays
        // (a tap-to-hear line, a reply still being read), send silence in its
        // place so the transcriber never takes the tutor's words as the
        // child's (TRA-706). Silence keeps the take's timeline intact.
        if (getNativeTTS().audibleWithin(Date.now(), TUTOR_ECHO_TAIL_MS)) {
          bytes.fill(0);
          lastTutorAudioAtMs = Date.now();
        }
        relay.push(bytes);
        const db = pcm16RmsDb(bytes);
        if (db >= SPEECH_LEVEL_DB) heardSpeech = true;
        if (!mountedRef.current) return;
        setLevel(meterLevelFromDb(db));
        if (heardSpeech) setHasSpeech(true);
        setIsTooLoud(db > LOUD_LEVEL_DB);
        setDurationMs(Math.min(capturedMs(), MAX_RECORDING_MS));
      };

      // ── Transport: secret → socket, in parallel with the microphone. ──────
      const openTransport = async () => {
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
          // The mic is raw (no OS voice processing): server noise reduction off.
          const update = takeSessionUpdate({ handsFree: latched, rawMic: true });
          socket.send(update);
          relay.attach((message) => socket.send(message));
        };
        socket.onmessage = (message: { data: unknown }) => {
          if (isStale()) return;
          const event = parseSocketEvent(message.data);
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
      };
      if (!transportFailedRef.current) openTransport().catch(failTransport);

      // ── Microphone: capturing from the first moment. ─────────────────────
      // A promise chain rather than try/catch keeps this hook compilable by
      // the React Compiler.
      const mic = await requestRecordingPermissionsAsync()
        .then<MicStream | null | "denied">((permission) =>
          permission.granted
            ? startMicStream(
                onBuffer,
                () => !isStale() && !turnEndedRef.current,
                // Another take started elsewhere: this one is dropped.
                () => {
                  if (!isStale()) endTake();
                },
              )
            : ("denied" as const),
        )
        .then(
          (started) => ({ ok: true as const, started }),
          (failure: unknown) => ({ ok: false as const, failure }),
        );
      if (!mic.ok) {
        if (isStale()) return;
        // The live microphone stream itself failed: hand this take to the
        // batch recorder, as before.
        emitDiagnostic(
          `error: ${errorMessage(mic.failure, "Microphone failed.")}`,
        );
        endTake();
        setFallbackActive(true);
        if (latched) return;
        emitDiagnostic("fallback-whisper");
        await legacy.start();
        return;
      }
      // Cancelled or confirmed while the mic was starting: it is closed again.
      if (mic.started === null) return;
      if (mic.started === "denied") {
        if (isStale()) return;
        endTake();
        Alert.alert(
          "Microphone access needed",
          "Open Settings and turn on Microphone for Rabbithole to use your voice.",
          [
            { text: "Not now", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => void Linking.openSettings(),
            },
          ],
        );
        return;
      }
      const { stream, subscription } = mic.started;
      if (isStale() || turnEndedRef.current) {
        subscription.remove();
        shutStream(stream);
        return;
      }
      streamRef.current = stream;
      streamSubscriptionRef.current = subscription;
      setDictationState("recording");
      voiceStartMark("listening");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      maxTimerRef.current = setTimeout(() => {
        if (stateRef.current !== "recording") return;
        // Hands-free has no ✓ to wait for: the cap ends the turn.
        if (latched) {
          endTurn();
          return;
        }
        setDurationMs(MAX_RECORDING_MS);
        setIsMaxed(true);
        stopCapture();
      }, MAX_RECORDING_MS);
      if (latched && !speechStartedRef.current) {
        // A child listening to a tap-to-hear line isn't silent on purpose:
        // the wait restarts once the tutor's voice stops.
        const armNoSpeech = (delayMs: number) => {
          noSpeechTimerRef.current = setTimeout(() => {
            noSpeechTimerRef.current = null;
            if (speechStartedRef.current || isStale()) return;
            const sinceTutor = Date.now() - lastTutorAudioAtMs;
            if (sinceTutor < NO_SPEECH_TIMEOUT_MS) {
              armNoSpeech(NO_SPEECH_TIMEOUT_MS - sinceTutor);
              return;
            }
            endTake();
          }, delayMs);
        };
        armNoSpeech(NO_SPEECH_TIMEOUT_MS);
      }
    },
    [
      closeTransport,
      emitDiagnostic,
      endTake,
      fallbackActive,
      getSecret,
      legacy,
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
      void legacy.cancel();
      return;
    }
    if (stateRef.current === "idle") return;
    endTake();
    setDurationMs(0);
  }, [endTake, fallbackActive, legacy]);

  const stopRecording = useCallback(() => {
    if (fallbackActive) {
      stopLegacyRecording();
      return;
    }
    if (stateRef.current === "connecting") {
      // Still starting: send whatever the mic already delivered, or nothing.
      const relay = relayRef.current;
      if (
        relay &&
        pcm16DurationMs(relay.capturedBytes, sampleRateRef.current) >=
          MIN_TURN_AUDIO_MS
      ) {
        endTurnRef.current?.();
      } else {
        cancelRecording();
      }
      return;
    }
    if (stateRef.current !== "recording") return;
    endTurnRef.current?.();
  }, [cancelRecording, fallbackActive, stopLegacyRecording]);

  const toggleRecording = useCallback(async () => {
    if (fallbackActive) {
      if (legacy.isRecording) stopLegacyRecording();
      else await legacy.start();
      return;
    }
    if (stateRef.current === "transcribing") return;
    if (stateRef.current === "idle") await startRecording();
    else stopRecording();
  }, [
    fallbackActive,
    legacy,
    startRecording,
    stopLegacyRecording,
    stopRecording,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      endTake();
    };
  }, [endTake]);

  // Keep a usable secret ready whenever the mic is idle: on mount, after each
  // take, and on return to the foreground (an iPad that slept past the TTL).
  useEffect(() => {
    if (state === "idle") prefetchSecret();
  }, [state, prefetchSecret]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && stateRef.current === "idle") prefetchSecret();
    });
    return () => subscription.remove();
  }, [prefetchSecret]);

  if (fallbackActive) {
    const fallbackState: DictationState = legacy.isTranscribing
      ? "transcribing"
      : legacy.isRecording
        ? "recording"
        : "idle";
    return {
      state: fallbackState,
      error,
      hasSpeech: legacy.level > 0.02,
      isTooLoud: false,
      isConnecting: false,
      isRecording: legacy.isRecording,
      isTranscribing: legacy.isTranscribing,
      isMaxed: legacy.isMaxed,
      level: legacy.level,
      durationMs: legacy.durationMs,
      startRecording,
      stopRecording,
      cancelRecording,
      toggleRecording,
      start: startRecording,
      stop: stopRecording,
      cancel: cancelRecording,
    };
  }

  return {
    state,
    error,
    hasSpeech,
    isTooLoud,
    isConnecting: state === "connecting",
    isRecording: state === "recording",
    isTranscribing: state === "transcribing",
    isMaxed,
    level,
    durationMs,
    startRecording,
    stopRecording,
    cancelRecording,
    toggleRecording,
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
  };
}
