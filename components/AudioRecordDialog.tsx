"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Flex, IconButton, Text, Button } from "@chakra-ui/react";
import { Stop, X } from "@phosphor-icons/react";
import { useClipRecorder } from "@/hooks/useClipRecorder";
import { clipFileName, containerMimeType } from "@/lib/mediaRecording";
import {
  MESSAGE_AUDIO_BITS_PER_SECOND,
  MESSAGE_AUDIO_MAX_MS,
} from "@/shared/messageAttachments";
import { formatCaptureDuration } from "@/shared/captureMedia";

export type RecordedAudio = { file: File; durationMs: number };

const METER_BARS = 28;

/**
 * In-composer voice-memo recorder. Shares the overlay-styling family and the
 * secure-context wording with CameraCaptureDialog, and the same
 * `useClipRecorder` engine as the dialog's video mode. Records a mic-only clip,
 * shows a live level meter while recording and an in-dialog playback preview
 * after Stop, and hands the clip back via onCapture (the caller uploads,
 * transcribes, and stages it).
 */
export function AudioRecordDialog({
  open,
  onClose,
  onCapture,
  overlayPosition = "absolute",
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (audio: RecordedAudio) => void;
  overlayPosition?: "absolute" | "fixed";
}) {
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  // Record stays disabled until the mic stream is live, so it can't fire
  // before getUserMedia resolves.
  const [streamReady, setStreamReady] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const genRef = useRef(0);

  const {
    phase,
    elapsedMs,
    durationMs,
    recordedUrl,
    mimeType,
    recordedBlob,
    error: recorderError,
    startRecording,
    stopRecording,
    reset: resetRecording,
  } = useClipRecorder({
    kind: "audio",
    maxMs: MESSAGE_AUDIO_MAX_MS,
    bitsPerSecond: MESSAGE_AUDIO_BITS_PER_SECOND,
  });

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  const stopStream = useCallback(() => {
    genRef.current++;
    setStreamReady(false);
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, [stopMeter]);

  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      const data = new Float32Array(analyser.fftSize);
      const loop = () => {
        analyser.getFloatTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
        const rms = Math.sqrt(sumSquares / data.length);
        // Map RMS (~0..0.5 in practice) to a lively 0..1 meter.
        setLevel(Math.min(1, rms * 3));
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch {
      // AudioContext unsupported — skip the meter, recording still works.
    }
  }, []);

  const startStream = useCallback(async () => {
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(
        "The microphone needs a secure (https) connection. It works in the Rabbithole app and on the website — but not on a plain-http dev build.",
      );
      return;
    }
    try {
      stopStream();
      const gen = genRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (gen !== genRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setStreamReady(true);
      startMeter(stream);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone permission was denied. Allow microphone access for Rabbithole, then try again."
          : name === "NotFoundError"
            ? "No microphone was found on this device."
            : "Couldn't access the microphone. Try again.",
      );
    }
  }, [stopStream, startMeter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the dialog acquires the mic (a side effect), which is the point
    if (open) void startStream();
    return () => stopStream();
  }, [open, startStream, stopStream]);

  const handleClose = useCallback(() => {
    stopStream();
    resetRecording();
    onClose();
  }, [stopStream, resetRecording, onClose]);

  const beginRecording = useCallback(() => {
    if (streamRef.current) startRecording(streamRef.current);
  }, [startRecording]);

  const handleUseRecording = useCallback(() => {
    if (!recordedBlob) return;
    const fullMime = mimeType ?? recordedBlob.type ?? "audio/webm";
    // File `type` becomes the upload Content-Type — strip the codecs parameter
    // (its comma is an invalid header; Convex storage 400s on it).
    const file = new File([recordedBlob], clipFileName("audio", fullMime), {
      type: containerMimeType(fullMime),
    });
    onCapture({ file, durationMs });
    resetRecording();
    handleClose();
  }, [recordedBlob, mimeType, durationMs, onCapture, resetRecording, handleClose]);

  if (!open) return null;

  const recording = phase === "recording";
  const reviewing = phase === "recorded";
  const litBars = Math.round(level * METER_BARS);
  const shownError = error ?? recorderError;

  return (
    <Flex
      position={overlayPosition}
      inset={0}
      zIndex={10000}
      bg="charcoal.900"
      flexDir="column"
      align="center"
      justify="center"
      gap={8}
      px={8}
    >
      {shownError ? (
        <Flex flexDir="column" align="center" gap={5} maxW="md" textAlign="center">
          <Text color="white" fontFamily="heading" fontSize="md" lineHeight="1.5">
            {shownError}
          </Text>
          <Button
            onClick={handleClose}
            bg="whiteAlpha.200"
            color="white"
            _hover={{ bg: "whiteAlpha.400" }}
            borderRadius="full"
            fontFamily="heading"
          >
            Close
          </Button>
        </Flex>
      ) : (
        <>
          {reviewing && recordedUrl ? (
            <Flex flexDir="column" align="center" gap={3} w="100%" maxW="sm">
              <Text color="whiteAlpha.700" fontFamily="heading" fontSize="sm">
                {formatCaptureDuration(durationMs)}
              </Text>
              <audio src={recordedUrl} controls style={{ width: "100%" }} />
            </Flex>
          ) : (
            <Flex flexDir="column" align="center" gap={5}>
              <Flex align="flex-end" gap="3px" h="72px">
                {Array.from({ length: METER_BARS }).map((_, i) => (
                  <Box
                    key={i}
                    w="4px"
                    borderRadius="full"
                    bg={i < litBars ? "violet.400" : "whiteAlpha.300"}
                    h={`${20 + Math.round((i / METER_BARS) * 52)}%`}
                    opacity={i < litBars ? 1 : 0.5}
                    transition="background 60ms linear"
                  />
                ))}
              </Flex>
              <Text
                color="white"
                fontFamily="heading"
                fontSize="lg"
                css={{ fontVariantNumeric: "tabular-nums" }}
              >
                {recording
                  ? `${formatCaptureDuration(elapsedMs)} / ${formatCaptureDuration(MESSAGE_AUDIO_MAX_MS)}`
                  : "Ready to record"}
              </Text>
            </Flex>
          )}

          {reviewing ? (
            <Flex gap={4} align="center">
              <Button
                onClick={resetRecording}
                bg="whiteAlpha.200"
                color="white"
                _hover={{ bg: "whiteAlpha.400" }}
                borderRadius="full"
                fontFamily="heading"
                fontSize="sm"
                size="lg"
                px={7}
                h={14}
              >
                Retake
              </Button>
              <Button
                onClick={handleUseRecording}
                bg="white"
                color="gray.800"
                _hover={{ bg: "gray.200" }}
                borderRadius="full"
                fontFamily="heading"
                fontSize="sm"
                size="lg"
                px={7}
                h={14}
              >
                Use recording
              </Button>
            </Flex>
          ) : (
            <Flex gap={4} align="center">
              <IconButton
                aria-label="Cancel"
                onClick={handleClose}
                bg="whiteAlpha.200"
                color="white"
                _hover={{ bg: "whiteAlpha.400" }}
                borderRadius="full"
                size="lg"
                w={14}
                h={14}
              >
                <X size={24} />
              </IconButton>
              {recording ? (
                <IconButton
                  aria-label="Stop recording"
                  onClick={stopRecording}
                  bg="white"
                  color="red.500"
                  _hover={{ bg: "gray.200" }}
                  borderRadius="full"
                  size="lg"
                  w={16}
                  h={16}
                >
                  <Stop size={28} weight="fill" />
                </IconButton>
              ) : (
                <IconButton
                  aria-label="Record audio"
                  onClick={beginRecording}
                  disabled={!streamReady}
                  bg="white"
                  _hover={{ bg: "gray.200" }}
                  _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
                  borderRadius="full"
                  size="lg"
                  w={16}
                  h={16}
                >
                  <Box w="26px" h="26px" borderRadius="full" bg="red.500" />
                </IconButton>
              )}
              {/* Spacer to keep the record button centered opposite Cancel. */}
              <Box w={14} h={14} />
            </Flex>
          )}
        </>
      )}
    </Flex>
  );
}
