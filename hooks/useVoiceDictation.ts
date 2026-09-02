"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { haptic } from "@/lib/native";
import { voiceMark } from "@/lib/voicePerf";

type DictationState = "idle" | "recording" | "transcribing";

/** RMS dB threshold for "too loud" warning. -10 dBFS = noticeably loud / near-shouting. */
const LOUD_THRESHOLD_DB = -10;

/** RMS dB threshold below which audio is considered silence/background noise. */
const SILENCE_THRESHOLD_DB = -35;

/**
 * In latched (tap-to-start) mode: once the speaker has said something, this
 * much sustained silence auto-stops the recording and sends it. Long enough
 * for a kid to pause mid-thought, short enough to feel hands-free.
 */
const SILENCE_HANG_MS = 1800;

/**
 * In latched mode: if NO speech is ever detected within this window, the
 * take cancels itself (discard, no transcription). This is what keeps the
 * hands-free loop from running forever when the student walks away or just
 * doesn't answer — one silent turn ends the loop, and they re-engage with
 * Tab or the mic button (Andy, on-device 2026-06-10).
 */
const NO_SPEECH_TIMEOUT_MS = 10_000;

function getSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // Strip the data:audio/...;base64, prefix
      resolve(dataUrl.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function useVoiceDictation(
  onTranscript: (text: string) => void,
  sessionId?: Id<"sessions">,
) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isTooLoud, setIsTooLoud] = useState(false);
  const [hasSpeech, setHasSpeech] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const loudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peakDbRef = useRef<number>(-100);
  // Latched mode (tap-to-start): auto-stop after the speaker goes quiet.
  // Hold modes (Tab / hold-the-mic) keep manual stop semantics.
  const latchedRef = useRef(false);
  const spokeRef = useRef(false);
  const lastLoudTsRef = useRef(0);
  const autoStoppedRef = useRef(false);
  // False once the consumer unmounts (e.g. the bug-report dialog closes
  // mid-dictation). The async onstop/transcription path checks this before
  // touching state or emitting a transcript.
  const mountedRef = useRef(true);

  const transcribe = useAction(api.audioActions.transcribe);

  // Clean up on unmount. Closing the surface while recording MUST release the
  // mic synchronously here — an active recorder's tracks are otherwise stopped
  // only by its async `onstop`, which may never run post-unmount, leaving the
  // microphone live with no UI left to stop it.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.stream.getTracks().forEach((t) => t.stop());
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // already stopped/inactive — nothing to do
          }
        }
        recorderRef.current = null;
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (loudTimerRef.current) clearTimeout(loudTimerRef.current);
      audioContextRef.current?.close().catch(() => {});
    };
  }, []);

  /** Start monitoring audio levels via AnalyserNode. */
  const startLevelMonitor = useCallback((stream: MediaStream) => {
    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;

      const dataArray = new Float32Array(analyser.fftSize);

      const checkLevel = () => {
        analyser.getFloatTimeDomainData(dataArray);
        // Calculate RMS
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sumSquares += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -100;

        if (db > peakDbRef.current) {
          peakDbRef.current = db;
          if (db >= SILENCE_THRESHOLD_DB) setHasSpeech(true);
        }

        // Latched-mode VAD: after speech, sustained silence stops the take;
        // if speech NEVER comes, the take cancels itself entirely (no
        // transcription, no re-listen) so the hands-free loop can't spin
        // forever on an unanswered turn.
        const now = performance.now();
        if (db >= SILENCE_THRESHOLD_DB) {
          lastLoudTsRef.current = now;
          spokeRef.current = true;
        } else if (latchedRef.current && !autoStoppedRef.current) {
          if (
            spokeRef.current &&
            now - lastLoudTsRef.current > SILENCE_HANG_MS
          ) {
            autoStoppedRef.current = true;
            haptic("light");
            recorderRef.current?.stop(); // same path as stopRecording()
          } else if (
            !spokeRef.current &&
            // lastLoudTs is initialized at recording start, so with zero
            // speech it measures time-since-start.
            now - lastLoudTsRef.current > NO_SPEECH_TIMEOUT_MS
          ) {
            autoStoppedRef.current = true;
            cancelledRef.current = true; // discard — nothing worth transcribing
            recorderRef.current?.stop();
          }
        }

        if (db > LOUD_THRESHOLD_DB) {
          setIsTooLoud(true);
          // Clear any existing hide timer
          if (loudTimerRef.current) {
            clearTimeout(loudTimerRef.current);
            loudTimerRef.current = null;
          }
        } else {
          // Delay hiding the warning so it doesn't flicker
          if (!loudTimerRef.current) {
            loudTimerRef.current = setTimeout(() => {
              setIsTooLoud(false);
              loudTimerRef.current = null;
            }, 600);
          }
        }

        rafRef.current = requestAnimationFrame(checkLevel);
      };
      rafRef.current = requestAnimationFrame(checkLevel);
    } catch {
      // AudioContext not supported — silently skip monitoring
    }
  }, []);

  /** Stop monitoring audio levels. */
  const stopLevelMonitor = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (loudTimerRef.current) {
      clearTimeout(loudTimerRef.current);
      loudTimerRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setIsTooLoud(false);
  }, []);

  const startRecording = useCallback(async (opts?: { latched?: boolean }) => {
    if (state !== "idle") return;

    latchedRef.current = !!opts?.latched;
    spokeRef.current = false;
    autoStoppedRef.current = false;
    lastLoudTsRef.current = performance.now();
    setError(null);
    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      setError("Your browser does not support audio recording.");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access denied.");
      return;
    }

    // Start volume level monitoring
    peakDbRef.current = -100;
    setHasSpeech(false);
    startLevelMonitor(stream);

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      voiceMark("micClosed");
      // Release mic + stop monitoring (idempotent — unmount cleanup may have
      // already stopped the tracks).
      stream.getTracks().forEach((t) => t.stop());
      stopLevelMonitor();

      // Unmounted mid-recording (surface closed): the mic is already released;
      // never set state or emit a transcript for a gone component.
      if (!mountedRef.current) {
        cancelledRef.current = false;
        return;
      }

      // If cancelled, discard audio and return to idle
      if (cancelledRef.current) {
        cancelledRef.current = false;
        setState("idle");
        return;
      }

      const blob = new Blob(chunksRef.current, { type: mimeType });
      if (blob.size === 0) {
        setState("idle");
        return;
      }

      // Skip transcription if the recording was mostly silence/background noise
      if (peakDbRef.current < SILENCE_THRESHOLD_DB) {
        setState("idle");
        return;
      }

      setState("transcribing");
      try {
        const audioBase64 = await blobToBase64(blob);
        const result = await transcribe({ audioBase64, mimeType, sessionId });
        // The transcribe round-trip is async — the consumer may have unmounted
        // while it was in flight; don't emit into a gone input.
        if (result.text && mountedRef.current) {
          voiceMark("transcript");
          onTranscript(result.text);
        }
      } catch {
        if (mountedRef.current) setError("Transcription failed. Please try again.");
      } finally {
        if (mountedRef.current) setState("idle");
      }
    };

    recorderRef.current = recorder;
    cancelledRef.current = false;
    recorder.start();
    setState("recording");
    haptic("light"); // recording started — matters most eyes-free (Tab-to-talk)
  }, [state, onTranscript, transcribe, sessionId, startLevelMonitor, stopLevelMonitor]);

  const stopRecording = useCallback(() => {
    if (state === "recording" && recorderRef.current) {
      haptic("light");
      recorderRef.current.stop();
    }
  }, [state]);

  /** Stop recording and discard audio without transcribing. */
  const cancelRecording = useCallback(() => {
    if (state === "recording" && recorderRef.current) {
      cancelledRef.current = true;
      recorderRef.current.stop();
    }
  }, [state]);

  const toggleRecording = useCallback(async () => {
    if (state === "transcribing") return;
    if (state === "recording") {
      stopRecording();
    } else {
      // Tap-to-start / tap-to-stop: an OPEN recording that only ends when the
      // kid taps again (or cancels) — no silence auto-stop, no countdown. Kids
      // pause a lot mid-thought, so nothing fires until they decide they're
      // done. (Voice mode's hands-free loop drives startRecording({ latched })
      // directly for its VAD auto-stop — this manual path stays unlatched.)
      await startRecording();
    }
  }, [state, startRecording, stopRecording]);

  return { state, error, isTooLoud, hasSpeech, toggleRecording, startRecording, stopRecording, cancelRecording };
}
