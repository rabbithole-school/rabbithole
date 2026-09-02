"use client";

import { useState } from "react";
import { Box, Button, HStack, IconButton, Stack, Text, VStack } from "@chakra-ui/react";
import { Sparkle, X } from "@phosphor-icons/react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function SessionRecapCard({
  sessionId,
  isComplete,
  canRequest = false,
}: {
  sessionId: Id<"sessions">;
  isComplete: boolean;
  canRequest?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [requested, setRequested] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const requestRecap = useAction(api.masteryObservations.requestRecap);
  const recap = useQuery(
    api.masteryObservations.recapForSession,
    isComplete || requested
      ? { sessionId, allowFallback: requested }
      : "skip",
  );

  const handleRequest = async () => {
    setRequesting(true);
    try {
      await requestRecap({ sessionId });
    } catch (error) {
      console.error("Could not refresh session recap", error);
    } finally {
      setRequested(true);
      setRequesting(false);
    }
  };

  if (!isComplete && !requested) {
    if (!canRequest) return null;
    return (
      <VStack align="center" gap={1} my={4}>
        <Button
          variant="outline"
          colorPalette="violet"
          fontFamily="heading"
          onClick={handleRequest}
          loading={requesting}
        >
          <Sparkle size={18} weight="fill" />
          Wrap up
        </Button>
        {requesting && (
          <Text fontSize="sm" color="charcoal.400">
            Reading back through your session…
          </Text>
        )}
      </VStack>
    );
  }

  if (dismissed || !recap?.length) return null;
  const tier = recap[0].tier;
  const title =
    tier === "growth"
      ? "Look what you figured out"
      : tier === "mirror"
        ? "A look back"
        : "Wrapped up";
  const subtitle =
    tier === "growth"
      ? "A few moments from your own thinking in this session."
      : tier === "mirror"
        ? "A true mirror of what you worked on today."
        : "You chose the stopping point.";

  return (
    <Box
      as="section"
      aria-label="What you figured out"
      alignSelf="center"
      maxW="md"
      w="full"
      my={4}
      p={5}
      bg="violet.50"
      borderWidth="1px"
      borderColor="violet.200"
      borderRadius="2xl"
      shadow="sm"
    >
      <HStack justify="space-between" align="start" gap={3} mb={4}>
        <HStack align="start" gap={3}>
          <Box color="violet.500" pt={1}>
            <Sparkle size={24} weight="fill" />
          </Box>
          <Stack gap={1}>
            <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="lg">
              {title}
            </Text>
            <Text fontSize="sm" color="charcoal.500" lineHeight="1.5">
              {subtitle}
            </Text>
          </Stack>
        </HStack>
        <IconButton
          aria-label="Hide recap"
          size="sm"
          variant="ghost"
          color="charcoal.400"
          onClick={() => setDismissed(true)}
        >
          <X size={16} />
        </IconButton>
      </HStack>

      <VStack as="ul" align="stretch" gap={3} listStyleType="none" m={0} p={0}>
        {recap.map((item) => (
          <Box
            as="li"
            key={item.key}
            bg="white"
            borderWidth="1px"
            borderColor="violet.100"
            borderRadius="lg"
            px={4}
            py={3}
          >
            <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
              {item.text}
            </Text>
            {item.excerpt && (
              <Text
                mt={2}
                color="charcoal.500"
                fontSize="sm"
                fontStyle="italic"
                lineHeight="1.5"
              >
                &ldquo;{item.excerpt}&rdquo;
              </Text>
            )}
          </Box>
        ))}
      </VStack>
    </Box>
  );
}
