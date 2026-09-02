"use client";

import { type ComponentProps } from "react";
import { IconButton, Spinner, Text, VStack } from "@chakra-ui/react";
import { Microphone, Square } from "@phosphor-icons/react";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";

interface DictationMicButtonProps {
  /** Called with the transcribed text when recording stops. Whisper's
   *  leading/trailing whitespace is stripped before this fires; the caller
   *  decides whether to append to an existing input value or replace it. */
  onTranscript: (text: string) => void;
  /** Disable starting a new recording (e.g. while a stream is in flight).
   *  An in-flight recording is NOT disabled — the user can still click to
   *  stop+send what they've already spoken. */
  disabled?: boolean;
  /** Chakra IconButton size. Defaults to "sm" to match teacher chat inputs. */
  size?: "xs" | "sm" | "md";
  /** Border radius for the button. Defaults to "lg". */
  borderRadius?: ComponentProps<typeof IconButton>["borderRadius"];
  /** ARIA label for the idle state. Defaults to "Start voice dictation". */
  ariaLabel?: string;
}

/**
 * Single-button voice dictation control. Click to record, click again to
 * stop + transcribe + emit text via `onTranscript`. While recording the
 * button pulses red; while transcribing it shows a spinner. Surfaces error
 * and "too loud" warnings inline below the button.
 *
 * Encapsulates `useVoiceDictation` so callers don't need to manage state.
 * Pair with any text input by passing a callback that appends to its value.
 */
export function DictationMicButton({
  onTranscript,
  disabled = false,
  size = "sm",
  borderRadius = "lg",
  ariaLabel = "Start voice dictation",
}: DictationMicButtonProps) {
  const { state, error, isTooLoud, toggleRecording } = useVoiceDictation((text) => {
    const trimmed = text.trim();
    if (trimmed) onTranscript(trimmed);
  });

  const isRecording = state === "recording";
  const isTranscribing = state === "transcribing";

  return (
    <VStack gap={1} align="stretch">
      <IconButton
        aria-label={isRecording ? "Stop and send recording" : ariaLabel}
        size={size}
        variant={isRecording ? "solid" : "ghost"}
        bg={isRecording ? "red.500" : undefined}
        color={isRecording ? "white" : "charcoal.400"}
        _hover={{ bg: isRecording ? "red.600" : "gray.100" }}
        _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
        borderRadius={borderRadius}
        onClick={toggleRecording}
        disabled={(disabled && !isRecording) || isTranscribing}
        className={isRecording ? "animate-pulse-soft" : undefined}
      >
        {isTranscribing ? <Spinner size="sm" /> : isRecording ? <Square /> : <Microphone />}
      </IconButton>
      {(error || (isRecording && isTooLoud)) && (
        <Text
          fontSize="2xs"
          color="red.500"
          fontFamily="heading"
          textAlign="center"
          lineHeight="1.2"
        >
          {error ?? "Too loud!"}
        </Text>
      )}
    </VStack>
  );
}
