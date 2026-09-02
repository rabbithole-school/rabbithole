"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { haptic } from "@/lib/native";
import {
  parseRealtimeTranscriptionEvent,
  reduceTranscriptAssembly,
  type TranscriptAssembly,
} from "@/lib/realtimeTranscriptionProtocol";
import { voiceMark } from "@/lib/voicePerf";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";

type DictationState = "idle" | "recording" | "transcribing";

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

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/calls";
const STARTUP_TIMEOUT_MS = 3_500;
const TRANSCRIPT_TIMEOUT_MS = 8_000;
const NO_SPEECH_TIMEOUT_MS = 10_000;
const SECRET_EXPIRY_SKEW_MS = 5_000;
const LOUD_THRESHOLD_DB = -10;
const SILENCE_THRESHOLD_DB = -35;

function supportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    return "audio/webm;codecs=opus";
  }
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read recorded audio."));
        return;
      }
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      channel.removeEventListener("close", onClose);
      resolve();
    };
    const onClose = () => {
      channel.removeEventListener("open", onOpen);
      reject(new Error("Realtime data channel closed during startup."));
    };
    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("close", onClose, { once: true });
  });
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

  const mintTranscriptionSecret = useAction(
    api.realtimeTranscription.mintTranscriptionSecret,
  );
  const reportTranscriptionUsage = useMutation(
    api.realtimeTranscription.recordTranscriptionUsage,
  );
  const transcribe = useAction(api.audioActions.transcribe);

  const mountedRef = useRef(true);
  const stateRef = useRef<DictationState>("idle");
  const streamingDisabledRef = useRef(false);
  const secretRef = useRef<MintedSecret | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const loudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peakDbRef = useRef(-100);
  const speechStartedRef = useRef(false);
  const speechEndMarkedRef = useRef(false);
  const turnEndedRef = useRef(false);
  const assemblyRef = useRef<TranscriptAssembly>({
    itemId: null,
    partial: "",
    final: null,
  });
  const backupRecorderRef = useRef<MediaRecorder | null>(null);
  const backupBlobPromiseRef = useRef<Promise<Blob> | null>(null);
  const failCurrentTurnRef = useRef<(cause: unknown) => Promise<void>>(
    async () => {},
  );
  const failureInProgressRef = useRef(false);
  const finishedRef = useRef(false);
  const captureStartRef = useRef<number | null>(null);

  const setDictationState = useCallback((next: DictationState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const clearTimers = useCallback(() => {
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    if (transcriptTimerRef.current) clearTimeout(transcriptTimerRef.current);
    noSpeechTimerRef.current = null;
    transcriptTimerRef.current = null;
  }, []);

  const stopLevelMonitor = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (loudTimerRef.current) clearTimeout(loudTimerRef.current);
    rafRef.current = null;
    loudTimerRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    if (mountedRef.current) setIsTooLoud(false);
  }, []);

  const stopInputCapture = useCallback(() => {
    const recorder = backupRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    // Every terminal path funnels through here, so this is the one choke
    // point that knows how long the mic actually streamed to OpenAI —
    // report it so the usage dashboard prices the primary voice path
    // (the Whisper fallback records its own separately).
    const captureStartedAt = captureStartRef.current;
    captureStartRef.current = null;
    if (captureStartedAt !== null && streamRef.current) {
      const audioSeconds = (performance.now() - captureStartedAt) / 1000;
      if (audioSeconds >= 0.5) {
        void reportTranscriptionUsage({ audioSeconds, sessionId }).catch(
          () => {},
        );
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopLevelMonitor();
  }, [stopLevelMonitor, reportTranscriptionUsage, sessionId]);

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

  const discardBackup = useCallback(() => {
    backupRecorderRef.current = null;
    backupBlobPromiseRef.current = null;
  }, []);

  const startLevelMonitor = useCallback((stream: MediaStream) => {
    try {
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      const samples = new Float32Array(analyser.fftSize);

      const checkLevel = () => {
        analyser.getFloatTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) sumSquares += sample * sample;
        const rms = Math.sqrt(sumSquares / samples.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -100;
        peakDbRef.current = Math.max(peakDbRef.current, db);
        if (db >= SILENCE_THRESHOLD_DB && mountedRef.current) {
          setHasSpeech(true);
        }
        if (db > LOUD_THRESHOLD_DB) {
          if (loudTimerRef.current) clearTimeout(loudTimerRef.current);
          loudTimerRef.current = null;
          if (mountedRef.current) setIsTooLoud(true);
        } else if (!loudTimerRef.current) {
          loudTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setIsTooLoud(false);
            loudTimerRef.current = null;
          }, 600);
        }
        rafRef.current = requestAnimationFrame(checkLevel);
      };
      rafRef.current = requestAnimationFrame(checkLevel);
    } catch {
      // Metering is optional; WebRTC transcription can continue without it.
    }
  }, []);

  const startBackupRecorder = useCallback((stream: MediaStream) => {
    const mimeType = supportedMimeType();
    if (!mimeType) return;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    backupBlobPromiseRef.current = new Promise((resolve) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });
    backupRecorderRef.current = recorder;
    recorder.start(250);
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

  const emitDiagnostic = useCallback(
    (event: string) => onDiagnostic?.(event),
    [onDiagnostic],
  );

  const transcribeBackup = useCallback(
    async (blob: Blob): Promise<string> => {
      voiceMark("micClosed");
      const audioBase64 = await blobToBase64(blob);
      const result = await transcribe({
        audioBase64,
        mimeType: blob.type,
        sessionId,
      });
      const text = result.text?.trim() ?? "";
      if (text) voiceMark("transcript");
      return text;
    },
    [transcribe, sessionId],
  );

  const startRecording = useCallback(
    async (opts?: { latched?: boolean }) => {
      if (streamingDisabledRef.current) {
        emitDiagnostic("streaming-disabled");
        await legacy.startRecording(opts);
        return;
      }
      if (stateRef.current !== "idle") return;

      const latched = !!opts?.latched;
      finishedRef.current = false;
      failureInProgressRef.current = false;
      assemblyRef.current = { itemId: null, partial: "", final: null };
      peakDbRef.current = -100;
      speechStartedRef.current = false;
      speechEndMarkedRef.current = false;
      turnEndedRef.current = false;
      setHasSpeech(false);
      setError(null);
      setDictationState("recording");

      let sessionReadyResolve: (() => void) | null = null;
      const sessionReady = new Promise<void>((resolve) => {
        sessionReadyResolve = resolve;
      });

      const finishWithTranscript = (text: string) => {
        if (finishedRef.current) return;
        const transcript = text.trim();
        if (!transcript) {
          // Mirror the legacy hook: silence isn't a failure — end the turn
          // quietly, and keep streaming enabled for the next one.
          finishedRef.current = true;
          stopInputCapture();
          closeTransport();
          discardBackup();
              setDictationState("idle");
          return;
        }
        if (stateRef.current === "recording") {
          voiceMark("speechEnd");
          speechEndMarkedRef.current = true;
        }
        turnEndedRef.current = true;
        finishedRef.current = true;
        stopInputCapture();
        closeTransport();
        discardBackup();
        voiceMark("transcript");
        setDictationState("idle");
        emitDiagnostic("turn-complete-streaming");
        onTranscript(transcript);
      };

      const failStreamingTurn = async (cause?: unknown) => {
        if (finishedRef.current || failureInProgressRef.current) return;
        failureInProgressRef.current = true;
        streamingDisabledRef.current = true;
        const message =
          cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : "Realtime transcription failed.";
        emitDiagnostic(`error: ${message}`);
        emitDiagnostic("streaming-disabled");
        setDictationState("transcribing");
        stopInputCapture();
        closeTransport();

        const backupPromise = backupBlobPromiseRef.current;
        const heardSpeech =
          peakDbRef.current >= SILENCE_THRESHOLD_DB || speechStartedRef.current;
        if (heardSpeech && !speechEndMarkedRef.current) {
          voiceMark("speechEnd");
          speechEndMarkedRef.current = true;
        }
        if (backupPromise && (heardSpeech || turnEndedRef.current)) {
          try {
            const blob = await backupPromise;
            if (blob.size > 0) {
              emitDiagnostic("fallback-whisper");
              const transcript = await transcribeBackup(blob);
              discardBackup();
              if (transcript) {
                voiceMark("transcript");
                setDictationState("idle");
                onTranscript(transcript);
                finishedRef.current = true;
                setFallbackActive(true);
                return;
              }
            }
          } catch {
            // Surface the legacy hook's normal error path below.
          }
        }

        discardBackup();
        if (turnEndedRef.current) {
          setError("Transcription failed. Please try again.");
          setDictationState("idle");
          setFallbackActive(true);
          return;
        }
        setDictationState("idle");
        failureInProgressRef.current = false;
        setFallbackActive(true);
        emitDiagnostic("fallback-whisper");
        await legacy.startRecording(opts);
      };
      failCurrentTurnRef.current = failStreamingTurn;

      try {
        if (
          typeof RTCPeerConnection === "undefined" ||
          !navigator.mediaDevices?.getUserMedia
        ) {
          throw new Error("WebRTC microphone capture is unavailable.");
        }

        // Mint and mic-open in parallel — both are on the path to the
        // listening cue, so serializing them is pure added latency. If the
        // mint (or the mic timeout) loses the race, the still-pending
        // getUserMedia can resolve a live stream later; an un-adopted
        // stream must be stopped or the kid's mic indicator stays on.
        const rawMic = navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
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
              if (!micAdopted) stream.getTracks().forEach((track) => track.stop());
            })
            .catch(() => {});
          throw cause;
        }
        if (finishedRef.current) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = mediaStream;
        captureStartRef.current = performance.now();
        startLevelMonitor(mediaStream);
        startBackupRecorder(mediaStream);
        haptic("light");

        const peer = new RTCPeerConnection();
        const channel = peer.createDataChannel("oai-events");
        peerRef.current = peer;
        channelRef.current = channel;
        peer.addTrack(mediaStream.getAudioTracks()[0], mediaStream);

        channel.addEventListener("message", (message) => {
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
                void failStreamingTurn();
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
        });
        channel.addEventListener("open", () => {
          // The minted secret already carries the full transcription config
          // (model, language, semantic VAD, noise reduction) — the only
          // client-side delta is push-to-talk turns disabling server VAD.
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
        });
        channel.addEventListener("close", () => {
          if (!finishedRef.current && stateRef.current !== "idle") {
            void failStreamingTurn();
          }
        });
        peer.addEventListener("connectionstatechange", () => {
          if (
            peer.connectionState === "failed" &&
            !finishedRef.current &&
            stateRef.current !== "idle"
          ) {
            void failStreamingTurn();
          }
        });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const controller = new AbortController();
        const abortTimer = setTimeout(
          () => controller.abort(),
          STARTUP_TIMEOUT_MS,
        );
        let response: Response;
        try {
          // Doc-verified ephemeral-token WebRTC recipe:
          // POST the browser SDP directly to /v1/realtime/calls.
          response = await fetch(OPENAI_REALTIME_URL, {
            method: "POST",
            body: offer.sdp,
            headers: {
              Authorization: `Bearer ${secret.clientSecret}`,
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
          waitForDataChannelOpen(channel),
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
            discardBackup();
            setDictationState("idle");
          }, NO_SPEECH_TIMEOUT_MS);
        }
      } catch (cause) {
        await failStreamingTurn(cause);
      }
    },
    [
      closeTransport,
      discardBackup,
      emitDiagnostic,
      getSecret,
      legacy,
      onTranscript,
      setDictationState,
      startBackupRecorder,
      startLevelMonitor,
      stopInputCapture,
      transcribeBackup,
    ],
  );

  const stopRecording = useCallback(() => {
    if (streamingDisabledRef.current) {
      legacy.stopRecording();
      return;
    }
    if (stateRef.current !== "recording") return;
    haptic("light");
    turnEndedRef.current = true;
    voiceMark("speechEnd");
    speechEndMarkedRef.current = true;
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
  }, [legacy, setDictationState, stopInputCapture]);

  const cancelRecording = useCallback(() => {
    if (streamingDisabledRef.current) {
      legacy.cancelRecording();
      return;
    }
    if (stateRef.current === "idle") return;
    finishedRef.current = true;
    stopInputCapture();
    closeTransport();
    discardBackup();
    setDictationState("idle");
  }, [
    closeTransport,
    discardBackup,
    legacy,
    setDictationState,
    stopInputCapture,
  ]);

  const toggleRecording = useCallback(async () => {
    if (streamingDisabledRef.current) {
      await legacy.toggleRecording();
      return;
    }
    if (stateRef.current === "transcribing") return;
    if (stateRef.current === "recording") stopRecording();
    else await startRecording();
  }, [legacy, startRecording, stopRecording]);

  useEffect(() => {
    // Reset on every effect run — StrictMode's dev double-mount reuses the
    // same refs, so an initializer-only `true` would stay false after the
    // probe unmount and silently suppress all setState calls.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      finishedRef.current = true;
      stopInputCapture();
      closeTransport();
    };
  }, [closeTransport, stopInputCapture]);

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
    toggleRecording,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
