"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createClipRecorder,
  type ClipKind,
  type ClipRecorder,
} from "@/lib/mediaRecording";

export type ClipRecorderPhase = "idle" | "recording" | "recorded";

/**
 * Drives one clip recording over a caller-owned MediaStream: elapsed readout,
 * hard auto-stop at `maxMs`, and the recorded blob (+ a revocable preview URL)
 * and its measured duration. The caller owns the stream (starting/stopping
 * tracks); this hook only owns the MediaRecorder. Shared by the Capture Video
 * and Record Audio dialogs.
 */
export function useClipRecorder({
  kind,
  maxMs,
  bitsPerSecond,
}: {
  kind: ClipKind;
  maxMs: number;
  bitsPerSecond: number;
}) {
  const [phase, setPhase] = useState<ClipRecorderPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<ClipRecorder | null>(null);
  const startTsRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<() => void>(() => {});
  // Authoritative hard cap: a background tab suspends rAF, so the ticker's cap
  // check can never fire and the MediaRecorder would run past maxMs. A plain
  // setTimeout keeps running in a hidden tab, so it — not rAF — enforces the
  // cap; rAF only paints the visible counter.
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every start/reset/unmount. A recorder's `onstop` fires
  // asynchronously; if the dialog closed (reset) and a NEW recording started
  // before the OLD recorder's delayed onstop ran (common with Safari mp4), the
  // stale callback must not reset the new recording's phase. Each onStop
  // captures the generation it was armed in and bails if it has moved on.
  const recorderGenRef = useRef(0);
  const recordedUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const stopTicker = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const clearCap = useCallback(() => {
    if (capTimerRef.current !== null) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  }, []);

  const revokeUrl = useCallback(() => {
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current);
      recordedUrlRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    clearCap();
    recorderRef.current?.stop();
    stopTicker();
  }, [clearCap, stopTicker]);

  // The elapsed ticker recurses through a ref so it can reference itself
  // without being read before its own declaration. It only paints the counter
  // (clamped to maxMs); the authoritative stop is the capTimer above.
  const tick = useCallback(() => {
    const elapsed = Date.now() - startTsRef.current;
    setElapsedMs(Math.min(elapsed, maxMs));
    if (elapsed < maxMs) {
      rafRef.current = requestAnimationFrame(() => tickRef.current());
    }
  }, [maxMs]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const startRecording = useCallback(
    (stream: MediaStream): boolean => {
      const myGen = ++recorderGenRef.current;
      setError(null);
      const recorder = createClipRecorder(stream, {
        kind,
        bitsPerSecond,
        onError: () => {
          if (myGen !== recorderGenRef.current || !mountedRef.current) return;
          clearCap();
          stopTicker();
          setError(
            "Recording stopped unexpectedly. Check the microphone/camera and try again.",
          );
          setPhase("idle");
          setElapsedMs(0);
        },
        onStop: (blob) => {
          // A stale recorder (dialog closed then reopened before this fired)
          // must not touch the new recording's state.
          if (myGen !== recorderGenRef.current) return;
          stopTicker();
          clearCap();
          if (!mountedRef.current) return;
          if (!blob || blob.size === 0) {
            setPhase("idle");
            setElapsedMs(0);
            return;
          }
          revokeUrl();
          const url = URL.createObjectURL(blob);
          recordedUrlRef.current = url;
          // Report the ACTUAL recorded length, not clamped to maxMs, so an
          // over-long clip (cap fired a beat late) is reported honestly.
          setDurationMs(Date.now() - startTsRef.current);
          setRecordedBlob(blob);
          setRecordedUrl(url);
          setPhase("recorded");
        },
      });
      if (!recorder) {
        setError("Recording isn't supported in this browser.");
        return false;
      }
      recorderRef.current = recorder;
      revokeUrl();
      setMimeType(recorder.mimeType);
      setRecordedBlob(null);
      setRecordedUrl(null);
      setElapsedMs(0);
      startTsRef.current = Date.now();
      if (!recorder.start()) {
        // Synchronous start() throw — onError already surfaced the message.
        recorderRef.current = null;
        return false;
      }
      setPhase("recording");
      capTimerRef.current = setTimeout(() => stopRecording(), maxMs);
      rafRef.current = requestAnimationFrame(() => tickRef.current());
      return true;
    },
    [kind, bitsPerSecond, maxMs, stopTicker, clearCap, revokeUrl, stopRecording],
  );

  /** Back to idle, discarding any recording in flight or held. */
  const reset = useCallback(() => {
    recorderGenRef.current++;
    stopTicker();
    clearCap();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    revokeUrl();
    setPhase("idle");
    setElapsedMs(0);
    setDurationMs(0);
    setRecordedBlob(null);
    setRecordedUrl(null);
    setError(null);
  }, [stopTicker, clearCap, revokeUrl]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalidate any in-flight recorder generation so a delayed onStop after
      // unmount can't act. This is a plain counter, not a rendered-node ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      recorderGenRef.current++;
      stopTicker();
      clearCap();
      recorderRef.current?.cancel();
      recorderRef.current = null;
      revokeUrl();
    };
  }, [stopTicker, clearCap, revokeUrl]);

  return {
    phase,
    elapsedMs,
    durationMs,
    recordedBlob,
    recordedUrl,
    mimeType,
    error,
    startRecording,
    stopRecording,
    reset,
  };
}
