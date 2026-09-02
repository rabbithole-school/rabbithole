"use client";

import { useCallback, useState } from "react";
import { Box, Button, Flex, Heading, Text, VStack } from "@chakra-ui/react";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { LaunchpadAtoms } from "@/components/practice/LaunchpadContent";

export type InstructionChatPayload = NonNullable<
  Doc<"messages">["instruction"]
>;
export type InstructionHandbackStart = {
  sessionId: Id<"sessions">;
  streamId: string;
  assistantMsgId: Id<"messages">;
};

export function InstructionChatCard({
  messageId,
  sessionId,
  scholarId,
  instruction,
  onHandback,
  interactive = true,
}: {
  messageId: Id<"messages">;
  sessionId: Id<"sessions">;
  scholarId: Id<"users">;
  instruction: InstructionChatPayload;
  onHandback: (handback: InstructionHandbackStart) => Promise<void>;
  interactive?: boolean;
}) {
  const completeInstruction = useMutation(
    api.chatInstruction.completeChatInstruction,
  );
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onComplete = useCallback(async () => {
    if (busy || completed) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await completeInstruction({
        scholarId,
        sessionId,
        messageId,
        key: instruction.key,
      });
    } catch (completionError) {
      console.error("Could not complete chat instruction", completionError);
      setError("Couldn't mark this done — try again.");
      setBusy(false);
      return;
    }
    setCompleted(true);
    if (result.handback) {
      try {
        await onHandback(result.handback);
      } catch (handbackError) {
        console.error("Could not resume tutor after instruction", handbackError);
        setError("You're done. Send your next thought to return to the problem.");
      }
    }
    setBusy(false);
  }, [
    busy,
    completeInstruction,
    completed,
    instruction.key,
    messageId,
    onHandback,
    scholarId,
    sessionId,
  ]);

  return (
    <Flex justify="flex-start" py={1}>
      <Box
        w="full"
        maxW="640px"
        bg="#fffdfa"
        borderWidth="1px"
        borderColor="#ded8cb"
        borderRadius="18px"
        px={{ base: 4, md: 5 }}
        py={{ base: 4, md: 5 }}
      >
        <VStack align="stretch" gap={4}>
          <Box>
            <Text
              fontSize="xs"
              textTransform="uppercase"
              letterSpacing="wide"
              color="charcoal.400"
              fontFamily="heading"
              fontWeight="600"
              mb={1}
            >
              Quick show-and-do
            </Text>
            <Heading as="h3" size="md" color="charcoal.700">
              {instruction.title}
            </Heading>
            {instruction.subtitle ? (
              <Text mt={1} color="charcoal.500" fontSize="sm">
                {instruction.subtitle}
              </Text>
            ) : null}
          </Box>

          <LaunchpadAtoms atoms={instruction.atoms} />

          {interactive ? (
            completed ? (
              <Text color="teal.700" fontWeight="600">
                Done — back to your problem.
              </Text>
            ) : (
              <Button
                alignSelf="flex-start"
                colorPalette="teal"
                loading={busy}
                onClick={() => void onComplete()}
              >
                Done — back to my problem
              </Button>
            )
          ) : null}
          {error ? (
            <Text color="red.600" fontSize="sm">
              {error}
            </Text>
          ) : null}
        </VStack>
      </Box>
    </Flex>
  );
}
