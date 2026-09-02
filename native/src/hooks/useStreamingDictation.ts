import { useAction, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  mediaDevices,
  MediaStream,
  RTCPeerConnection,
} from "react-native-webrtc";

import { useVoiceDictation, MAX_RECORDING_MS } from "@/hooks/useVoiceDictation";
import { api, type Id } from "@/lib/convex";
import { appStatusBus } from "@/lib/appStatusBus";
import { voiceMark } from "@/lib/voicePerf";
import {
  parseRealtimeTranscriptionEvent,
  reduceTranscriptAssembly,
  type TranscriptAssembly,
} from "../../vendor/shared/realtimeTranscriptionProtocol";

type DictationState = "idle" | "recording" | "transcribing";

type MintedSecret = {
  clientSecret: string;
  expiresAtMs: number;
  model: string;
};

type DataChannel = ReturnType<RTCPeerConnection["createDataChannel"]>;

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/calls";
const STARTUP_TIMEOUT_MS = 3_500;
const TRANSCRIPT_TIMEOUT_MS = 8_000;
const NO_SPEECH_TIMEOUT_MS = 10_000;
const SECRET_EXPIRY_SKEW_MS = 5_000;
const LEVEL_POLL_MS = 100;
const PLACEHOLDER_LEVEL_DELAY_MS = 700;

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

function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
  stream.release();
}

function audioLevelFromStats(stats: unknown): number | null {
  if (!(stats instanceof Map)) return null;
  let level: number | null = null;
  for (const report of stats.values()) {
    if (typeof report !== "object" || report === null) continue;
    const value = (report as Record<string, unknown>).audioLevel;
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;
    if (Number.isFinite(numeric)) {
      level = Math.max(level ?? 0, Math.min(1, Math.max(0, numeric)));
    }
  }
  return level;
}

export function useStreamingDictation(
  onTranscript: (text: string) => void,
  sessionId?: Id<"sessions">,
  onDiagnostic?: (event: string) => void,
) {
  const legacy = useVoiceDictation(sessionId);
  const mintTranscriptionSecret = useAction(
    api.realtimeTranscription.mintTranscriptionSecret,
  );
  const reportTranscriptionUsage = useMutation(
    api.realtimeTranscription.recordTranscriptionUsage,
  );

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
  const streamingDisabledRef = useRef(false);
  const secretRef = useRef<MintedSecret | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<DataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureStartRef = useRef<number | null>(null);
  const statsSeenRef = useRef(false);
  const speechStartedRef = useRef(false);
  const speechEndMarkedRef = useRef(false);
  const turnEndedRef = useRef(false);
  const finishedRef = useRef(false);
  const failureInProgressRef = useRef(false);
  const micOwnerRef = useRef(
    appStatusBus.createMicOwner("streaming-dictation"),
  );
  const assemblyRef = useRef<TranscriptAssembly>({
    itemId: null,
    partial: "",
    final: null,
  });
  const failCurrentTurnRef = useRef<(cause?: unknown) => Promise<void>>(
    async () => {},
  );

  const emitDiagnostic = useCallback(
    (event: string) => onDiagnostic?.(event),
    [onDiagnostic],
  );

  const setDictationState = useCallback((next: DictationState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const clearTimers = useCallback(() => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);
    maxTimerRef.current = null;
    noSpeechTimerRef.current = null;
    transcriptTimerRef.current = null;
  }, []);

  const stopLevelMonitor = useCallback(() => {
    if (meterRef.current) clearInterval(meterRef.current);
    meterRef.current = null;
    if (mountedRef.current) {
      setLevel(0);
      setIsTooLoud(false);
    }
  }, []);

  const stopInputCapture = useCallback(() => {
    appStatusBus.setMicOwned(micOwnerRef.current, false);
    const stream = streamRef.current;
    const captureStartedAt = captureStartRef.current;
    streamRef.current = null;
    captureStartRef.current = null;
    if (stream) stopMediaStream(stream);
    stopLevelMonitor();

    if (captureStartedAt !== null) {
      const audioSeconds = (Date.now() - captureStartedAt) / 1000;
      if (audioSeconds >= 0.5) {
        void reportTranscriptionUsage({ audioSeconds, sessionId }).catch(
          () => {},
        );
      }
    }
  }, [reportTranscriptionUsage, sessionId, stopLevelMonitor]);

  const closeTransport = useCallback(() => {
    clearTimers();
    try {
      channelRef.current?.close();
    } catch {
      // Already closed.
    }
    peerRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;
  }, [clearTimers]);

  const startLevelMonitor = useCallback((peer: RTCPeerConnection) => {
    statsSeenRef.current = false;
    meterRef.current = setInterval(() => {
      const startedAt = captureStartRef.current;
      if (startedAt === null) return;
      const elapsed = Date.now() - startedAt;
      if (mountedRef.current) setDurationMs(Math.min(elapsed, MAX_RECORDING_MS));

      void peer
        .getStats()
        .then((stats) => {
          const next = audioLevelFromStats(stats);
          if (next !== null) {
            statsSeenRef.current = true;
            if (!mountedRef.current) return;
            setLevel(next);
            setHasSpeech((current) => current || next > 0.02);
            setIsTooLoud(next > 0.85);
            return;
          }
          if (
            !statsSeenRef.current &&
            elapsed >= PLACEHOLDER_LEVEL_DELAY_MS &&
            mountedRef.current
          ) {
            // react-native-webrtc does not expose an analyser. Some iOS builds
            // omit audioLevel stats, so keep the waveform visibly alive.
            setLevel(0.16 + 0.08 * Math.abs(Math.sin(elapsed / 220)));
          }
        })
        .catch(() => {
          // Metering is optional; transcription continues without stats.
        });
    }, LEVEL_POLL_MS);
  }, []);

  const getSecret = useCallback(async () => {
    const cached = secretRef.current;
    if (cached && cached.expiresAtMs - SECRET_EXPIRY_SKEW_MS > Date.now()) {
      return cached;
    }
    const minted = await withTimeout(
      mintTranscriptionSecret({}),
      STARTUP_TIMEOUT_MS,
      "Realtime secret mint timed out.",
    );
    secretRef.current = minted;
    return minted;
  }, [mintTranscriptionSecret]);

  const stopLegacyRecording = useCallback(() => {
    void legacy.stop().then((text) => {
      if (text) onTranscript(text);
    });
  }, [legacy, onTranscript]);

  const startRecording = useCallback(
    async (opts?: { latched?: boolean }) => {
      if (streamingDisabledRef.current) {
        emitDiagnostic("streaming-disabled");
        await legacy.start();
        return;
      }
      if (stateRef.current !== "idle") return;

      const latched = !!opts?.latched;
      finishedRef.current = false;
      failureInProgressRef.current = false;
      speechStartedRef.current = false;
      speechEndMarkedRef.current = false;
      turnEndedRef.current = false;
      assemblyRef.current = { itemId: null, partial: "", final: null };
      setError(null);
      setHasSpeech(false);
      setIsTooLoud(false);
      setLevel(0);
      setDurationMs(0);
      setIsMaxed(false);
      appStatusBus.setMicOwned(micOwnerRef.current, true);
      setDictationState("recording");

      let sessionReadyResolve: (() => void) | null = null;
      const sessionReady = new Promise<void>((resolve) => {
        sessionReadyResolve = resolve;
      });

      const finishWithTranscript = (rawText: string) => {
        if (finishedRef.current) return;
        const transcript = rawText.trim();
        finishedRef.current = true;
        stopInputCapture();
        closeTransport();
        setIsMaxed(false);
        setDictationState("idle");
        if (!transcript) return;

        if (!speechEndMarkedRef.current) {
          voiceMark("speechEnd");
          speechEndMarkedRef.current = true;
        }
        turnEndedRef.current = true;
        voiceMark("transcript");
        emitDiagnostic("turn-complete-streaming");
        onTranscript(transcript);
      };

      const failStreamingTurn = async (cause?: unknown) => {
        if (finishedRef.current || failureInProgressRef.current) return;
        failureInProgressRef.current = true;
        streamingDisabledRef.current = true;
        finishedRef.current = true;
        const message =
          cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : "Realtime transcription failed.";
        emitDiagnostic(`error: ${message}`);
        emitDiagnostic("streaming-disabled");
        stopInputCapture();
        closeTransport();
        setIsMaxed(false);
        setFallbackActive(true);

        if (turnEndedRef.current) {
          setError("Transcription failed. Please try again.");
          setDictationState("idle");
          Alert.alert(
            "Transcription failed",
            "Tap the mic and try speaking again.",
          );
          return;
        }

        // A browser MediaRecorder can reuse its WebRTC MediaStream. expo-audio
        // cannot consume this native stream, and opening a second recorder would
        // compete for iOS audio-session ownership. Preserve reliability by
        // latching to a fresh legacy recording instead of promising replay.
        emitDiagnostic("fallback-whisper");
        setDictationState("idle");
        await legacy.start();
      };
      failCurrentTurnRef.current = failStreamingTurn;

      try {
        const rawMic = mediaDevices.getUserMedia({ audio: true });
        let micAdopted = false;
        let secret: MintedSecret;
        let mediaStream: MediaStream;
        try {
          [secret, mediaStream] = await Promise.all([
            getSecret().then((minted) => {
              emitDiagnostic("mint-ok");
              return minted;
            }),
            withTimeout(
              rawMic,
              STARTUP_TIMEOUT_MS,
              "Microphone startup timed out.",
            ),
          ]);
          micAdopted = true;
        } catch (cause) {
          rawMic
            .then((stream) => {
              if (!micAdopted) stopMediaStream(stream);
            })
            .catch(() => {});
          throw cause;
        }
        if (finishedRef.current) {
          stopMediaStream(mediaStream);
          return;
        }

        const audioTrack = mediaStream.getAudioTracks()[0];
        if (!audioTrack) {
          stopMediaStream(mediaStream);
          throw new Error("Microphone did not provide an audio track.");
        }

        streamRef.current = mediaStream;
        captureStartRef.current = Date.now();

        const peer = new RTCPeerConnection();
        const channel = peer.createDataChannel("oai-events");
        peerRef.current = peer;
        channelRef.current = channel;
        peer.addTrack(audioTrack, mediaStream);
        startLevelMonitor(peer);
        maxTimerRef.current = setTimeout(() => {
          if (stateRef.current !== "recording") return;
          setDurationMs(MAX_RECORDING_MS);
          setIsMaxed(true);
          stopInputCapture();
        }, MAX_RECORDING_MS);

        const channelOpen = new Promise<void>((resolve, reject) => {
          channel.onopen = () => {
            if (!latched) {
              channel.send(
                JSON.stringify({
                  type: "session.update",
                  session: {
                    type: "transcription",
                    audio: { input: { turn_detection: null } },
                  },
                }),
              );
            }
            resolve();
          };
          channel.onclose = () => {
            reject(new Error("Realtime data channel closed during startup."));
            if (!finishedRef.current && stateRef.current !== "idle") {
              void failStreamingTurn();
            }
          };
        });

        channel.onmessage = (message: { data: unknown }) => {
          let value: unknown;
          try {
            value = JSON.parse(String(message.data));
          } catch {
            return;
          }
          const event = parseRealtimeTranscriptionEvent(value);
          if (event.kind === "sessionReady") {
            sessionReadyResolve?.();
            return;
          }
          if (event.kind === "speechStarted") {
            emitDiagnostic("speech-started");
            speechStartedRef.current = true;
            if (mountedRef.current) setHasSpeech(true);
            if (noSpeechTimerRef.current) {
              clearTimeout(noSpeechTimerRef.current);
              noSpeechTimerRef.current = null;
            }
            return;
          }
          if (event.kind === "speechStopped") {
            if (latched && stateRef.current === "recording") {
              turnEndedRef.current = true;
              voiceMark("speechEnd");
              speechEndMarkedRef.current = true;
              setDictationState("transcribing");
              stopInputCapture();
              transcriptTimerRef.current = setTimeout(() => {
                void failStreamingTurn(
                  new Error("Realtime transcript completion timed out."),
                );
              }, TRANSCRIPT_TIMEOUT_MS);
            }
            return;
          }
          if (event.kind === "delta" || event.kind === "completed") {
            assemblyRef.current = reduceTranscriptAssembly(
              assemblyRef.current,
              event,
            );
            if (event.kind === "completed") finishWithTranscript(event.text);
            return;
          }
          if (event.kind === "error") {
            void failStreamingTurn(new Error(event.message));
          }
        };

        peer.onconnectionstatechange = () => {
          if (
            peer.connectionState === "failed" &&
            !finishedRef.current &&
            stateRef.current !== "idle"
          ) {
            void failStreamingTurn();
          }
        };

        const offer = await peer.createOffer();
        if (typeof offer.sdp !== "string") {
          throw new Error("Realtime offer did not contain SDP.");
        }
        await peer.setLocalDescription(offer);
        const controller = new AbortController();
        const abortTimer = setTimeout(
          () => controller.abort(),
          STARTUP_TIMEOUT_MS,
        );
        let response: Response;
        try {
          response = await fetch(OPENAI_REALTIME_URL, {
            method: "POST",
            body: offer.sdp,
            headers: {
              Authorization: "Bearer " + secret.clientSecret,
              "Content-Type": "application/sdp",
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(abortTimer);
        }
        if (!response.ok) {
          throw new Error(`Realtime SDP exchange failed (${response.status}).`);
        }
        await peer.setRemoteDescription({
          type: "answer",
          sdp: await response.text(),
        });
        await withTimeout(
          channelOpen,
          STARTUP_TIMEOUT_MS,
          "Realtime data channel startup timed out.",
        );
        emitDiagnostic("webrtc-connected");
        await withTimeout(
          sessionReady,
          STARTUP_TIMEOUT_MS,
          "Realtime session handshake timed out.",
        );
        emitDiagnostic("session-ready");

        if (latched && !speechStartedRef.current) {
          noSpeechTimerRef.current = setTimeout(() => {
            finishedRef.current = true;
            stopInputCapture();
            closeTransport();
            setDictationState("idle");
          }, NO_SPEECH_TIMEOUT_MS);
        }
      } catch (cause) {
        await failStreamingTurn(cause);
      }
    },
    [
      closeTransport,
      emitDiagnostic,
      getSecret,
      legacy,
      onTranscript,
      setDictationState,
      startLevelMonitor,
      stopInputCapture,
    ],
  );

  const stopRecording = useCallback(() => {
    if (streamingDisabledRef.current) {
      stopLegacyRecording();
      return;
    }
    if (stateRef.current !== "recording") return;
    turnEndedRef.current = true;
    voiceMark("speechEnd");
    speechEndMarkedRef.current = true;
    setIsMaxed(false);
    setDictationState("transcribing");
    stopInputCapture();

    const channel = channelRef.current;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      transcriptTimerRef.current = setTimeout(() => {
        void failCurrentTurnRef.current(
          new Error("Realtime transcript completion timed out."),
        );
      }, TRANSCRIPT_TIMEOUT_MS);
    } else {
      void failCurrentTurnRef.current(
        new Error("Realtime data channel was not ready."),
      );
    }
  }, [setDictationState, stopInputCapture, stopLegacyRecording]);

  const cancelRecording = useCallback(() => {
    if (streamingDisabledRef.current) {
      void legacy.cancel();
      return;
    }
    if (stateRef.current === "idle") return;
    finishedRef.current = true;
    stopInputCapture();
    closeTransport();
    setIsMaxed(false);
    setDurationMs(0);
    setDictationState("idle");
  }, [closeTransport, legacy, setDictationState, stopInputCapture]);

  const toggleRecording = useCallback(async () => {
    if (streamingDisabledRef.current) {
      if (legacy.isRecording) stopLegacyRecording();
      else await legacy.start();
      return;
    }
    if (stateRef.current === "transcribing") return;
    if (stateRef.current === "recording") stopRecording();
    else await startRecording();
  }, [legacy, startRecording, stopLegacyRecording, stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      finishedRef.current = true;
      stopInputCapture();
      closeTransport();
    };
  }, [closeTransport, stopInputCapture]);

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
