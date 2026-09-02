"use client";

/**
 * Unlinked, signed-in diagnostic surface for exercising Realtime WebRTC
 * transcription and TTS inside the native app's WKWebView.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import {
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Surface } from "@/components/ui/Surface";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { getTTSEngine } from "@/hooks/useTTSQueue";

type EnvironmentReadout = {
  secureContext: boolean;
  hasRtcPeerConnection: boolean;
  hasGetUserMedia: boolean;
  userAgent: string;
};

type TimedEntry = {
  id: number;
  elapsedMs: number;
  text: string;
};

type DictationPath = "Not resolved yet" | "Streaming" | "Whisper fallback";

const TTS_TEST_SENTENCE =
  "This is a speaker and microphone echo test for streaming dictation.";

function ReadoutRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack
      direction={{ base: "column", md: "row" }}
      gap={{ base: 1, md: 4 }}
      py={2}
      borderBottomWidth="1px"
      borderColor="gray.100"
      _last={{ borderBottomWidth: 0 }}
    >
      <Text minW={{ md: "220px" }} fontWeight="semibold">
        {label}
      </Text>
      <Box minW={0}>{children}</Box>
    </Stack>
  );
}

function BooleanBadge({ value }: { value: boolean }) {
  return (
    <Badge colorPalette={value ? "green" : "red"}>
      {value ? "Yes" : "No"}
    </Badge>
  );
}

function EventList({
  entries,
  emptyText,
}: {
  entries: TimedEntry[];
  emptyText: string;
}) {
  return (
    <VStack as="ol" align="stretch" gap={2} listStyleType="none">
      {entries.length === 0 ? (
        <Text color="charcoal.400" fontSize="sm">
          {emptyText}
        </Text>
      ) : (
        entries.map((entry) => (
          <HStack as="li" key={entry.id} align="start" gap={3}>
            <Text
              as="span"
              flexShrink={0}
              color="charcoal.400"
              fontFamily="mono"
              fontSize="xs"
            >
              +{entry.elapsedMs.toFixed(1)} ms
            </Text>
            <Text as="span" fontFamily="mono" fontSize="sm" overflowWrap="anywhere">
              {entry.text}
            </Text>
          </HStack>
        ))
      )}
    </VStack>
  );
}

function VoiceSpikeDiagnostic() {
  const [environment, setEnvironment] = useState<EnvironmentReadout | null>(null);
  const [events, setEvents] = useState<TimedEntry[]>([]);
  const [transcripts, setTranscripts] = useState<TimedEntry[]>([]);
  const [path, setPath] = useState<DictationPath>("Not resolved yet");
  const nextIdRef = useRef(0);
  const turnStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setEnvironment({
        secureContext: window.isSecureContext,
        hasRtcPeerConnection: typeof RTCPeerConnection !== "undefined",
        hasGetUserMedia:
          typeof navigator.mediaDevices?.getUserMedia === "function",
        userAgent: navigator.userAgent,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const appendEntry = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<TimedEntry[]>>,
      text: string,
    ) => {
      const now = performance.now();
      const startedAt = turnStartedAtRef.current;
      setter((current) => [
        ...current,
        {
          id: nextIdRef.current++,
          elapsedMs: startedAt === null ? 0 : now - startedAt,
          text,
        },
      ]);
    },
    [],
  );

  const handleTranscript = useCallback(
    (text: string) => appendEntry(setTranscripts, text),
    [appendEntry],
  );

  const handleDiagnostic = useCallback(
    (event: string) => {
      appendEntry(setEvents, event);
      if (event === "turn-complete-streaming") setPath("Streaming");
      if (event === "fallback-whisper") setPath("Whisper fallback");
    },
    [appendEntry],
  );

  const {
    state,
    hasSpeech,
    isTooLoud,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useStreamingDictation(handleTranscript, undefined, handleDiagnostic);

  const startListening = () => {
    const startedAt = performance.now();
    turnStartedAtRef.current = startedAt;
    setPath("Not resolved yet");
    void startRecording({ latched: true });
  };

  const playTts = () => {
    const engine = getTTSEngine();
    engine?.unlock();
    engine?.speak(TTS_TEST_SENTENCE);
  };

  return (
    <Box minH="100vh" bg="gray.50" py={{ base: 4, md: 8 }}>
      <Box maxW="840px" mx="auto" px={{ base: 4, md: 8 }}>
        <VStack align="stretch" gap={6}>
          <Surface p={{ base: 4, md: 6 }}>
            <Heading as="h1" size="lg" mb={2}>
              Voice WebView spike
            </Heading>
            <Text color="charcoal.400" fontSize="sm">
              Tests browser capabilities, streaming transcription, fallback
              transcription, and TTS without sending a chat message.
            </Text>
          </Surface>

          <Surface as="section" p={{ base: 4, md: 6 }}>
            <Heading as="h2" size="md" mb={4}>
              Environment
            </Heading>
            {environment === null ? (
              <Spinner size="sm" color="violet.500" />
            ) : (
              <>
                <ReadoutRow label="Secure context">
                  <BooleanBadge value={environment.secureContext} />
                </ReadoutRow>
                <ReadoutRow label="RTCPeerConnection defined">
                  <BooleanBadge value={environment.hasRtcPeerConnection} />
                </ReadoutRow>
                <ReadoutRow label="getUserMedia defined">
                  <BooleanBadge value={environment.hasGetUserMedia} />
                </ReadoutRow>
                <ReadoutRow label="User agent">
                  <Text fontFamily="mono" fontSize="xs" overflowWrap="anywhere">
                    {environment.userAgent}
                  </Text>
                </ReadoutRow>
              </>
            )}
          </Surface>

          <Surface as="section" p={{ base: 4, md: 6 }}>
            <Heading as="h2" size="md" mb={4}>
              Dictation controls
            </Heading>
            <Flex gap={3} wrap="wrap" mb={5}>
              <Button
                colorPalette="violet"
                onClick={startListening}
                disabled={state !== "idle"}
              >
                Start listening (latched)
              </Button>
              <Button
                variant="outline"
                onClick={stopRecording}
                disabled={state !== "recording"}
              >
                Stop
              </Button>
              <Button
                variant="outline"
                onClick={cancelRecording}
                disabled={state === "idle"}
              >
                Cancel
              </Button>
              <Button variant="outline" onClick={playTts}>
                Play TTS test sentence
              </Button>
            </Flex>

            <VStack align="stretch" gap={2}>
              <ReadoutRow label="Current state">
                <Text fontFamily="mono">{state}</Text>
              </ReadoutRow>
              <ReadoutRow label="Has speech">
                <BooleanBadge value={hasSpeech} />
              </ReadoutRow>
              <ReadoutRow label="Input too loud">
                <BooleanBadge value={isTooLoud} />
              </ReadoutRow>
              <ReadoutRow label="Error">
                <Text color={error ? "red.600" : "charcoal.400"}>
                  {error ?? "None"}
                </Text>
              </ReadoutRow>
              <ReadoutRow label="Which path?">
                <Badge
                  colorPalette={
                    path === "Streaming"
                      ? "green"
                      : path === "Whisper fallback"
                        ? "orange"
                        : "gray"
                  }
                >
                  {path}
                </Badge>
              </ReadoutRow>
            </VStack>
          </Surface>

          <Surface as="section" p={{ base: 4, md: 6 }}>
            <Heading as="h2" size="md" mb={1}>
              Diagnostic events and latency
            </Heading>
            <Text color="charcoal.400" fontSize="sm" mb={4}>
              Times are relative to the most recent Start tap.
            </Text>
            <EventList entries={events} emptyText="No diagnostic events yet." />
          </Surface>

          <Surface as="section" p={{ base: 4, md: 6 }}>
            <Heading as="h2" size="md" mb={4}>
              Final transcripts
            </Heading>
            <EventList entries={transcripts} emptyText="No final transcripts yet." />
          </Surface>
        </VStack>
      </Box>
    </Box>
  );
}

export default function DevVoiceSpikePage() {
  const { isLoading, isAuthenticated } = useCurrentUser();

  if (isLoading) {
    return (
      <Flex minH="50vh" align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  if (!isAuthenticated) {
    return (
      <Flex minH="50vh" align="center" justify="center" p={4}>
        <Surface p={6} maxW="520px">
          <Heading as="h1" size="md" mb={2}>
            Sign in required
          </Heading>
          <Text color="charcoal.400" mb={4}>
            Streaming dictation needs an authenticated user to mint its Realtime
            session secret.
          </Text>
          <Button asChild colorPalette="violet">
            <NextLink href="/dev-login?u=test-scholar-001&to=/dev-voice-spike">
              Sign in as test scholar
            </NextLink>
          </Button>
        </Surface>
      </Flex>
    );
  }

  return <VoiceSpikeDiagnostic />;
}
