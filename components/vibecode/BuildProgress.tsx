"use client";

/**
 * Honest build progress for the Vibecode Workshop.
 *
 * A first app build takes 1–3.5 minutes and, until now, the workshop said
 * nothing legible while it ran: the preview pane still showed the "Describe the
 * app you want to build / Start building" empty state even though the kickoff
 * had already fired, and the chat showed "…" then a raw tool label. Teachers
 * read that as "wedged". This card names the stage the build is actually in —
 * derived from the tutor stream (see `shared/buildStage.ts`) — with a running
 * clock and a Stop button.
 *
 * One canonical rendering per signal: the preview `variant="card"` and the chat
 * `variant="line"` both read the SAME derived stage, so the surfaces never
 * disagree.
 */

import { Box, Button, Flex, Spinner, Text, VStack } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import {
  BUILD_STAGE_ORDER,
  buildStageIndex,
  type BuildStage,
} from "@/shared/buildStage";

const STAGE_META: Record<
  BuildStage,
  { label: string; subtitle?: string }
> = {
  planning: { label: "Planning the app", subtitle: "usually a minute or two" },
  writing: { label: "Writing the app" },
  looking: { label: "Looking at what it built" },
  fixing: { label: "Fixing what it saw" },
};

/** m:ss elapsed since `startedAt`, ticking once a second. */
function useElapsedLabel(startedAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function BuildProgress({
  variant,
  stage,
  startedAt,
  onStop,
}: {
  variant: "card" | "line";
  stage: BuildStage;
  startedAt: number;
  onStop?: () => void;
}) {
  const elapsed = useElapsedLabel(startedAt);
  const activeIndex = buildStageIndex(stage);
  const meta = STAGE_META[stage];

  if (variant === "line") {
    return (
      <Flex align="center" gap={2} alignSelf="flex-start" role="status">
        <Spinner size="xs" color="violet.500" />
        <Text fontSize="sm" fontFamily="heading" fontWeight="600" color="charcoal.500">
          {meta.label}
        </Text>
        <Text fontSize="xs" fontFamily="heading" color="charcoal.300">
          {elapsed}
        </Text>
      </Flex>
    );
  }

  return (
    <Box
      role="status"
      aria-label={`Building the app — ${meta.label}`}
      w="100%"
      maxW="360px"
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      shadow="sm"
      px={5}
      py={5}
    >
      <VStack align="stretch" gap={3}>
        {BUILD_STAGE_ORDER.map((s, index) => {
          const isComplete = index < activeIndex;
          const isActive = index === activeIndex;
          const stageMeta = STAGE_META[s];
          return (
            <Flex key={s} align="flex-start" gap={3}>
              <Flex
                align="center"
                justify="center"
                w="20px"
                h="20px"
                mt="1px"
                flexShrink={0}
              >
                {isComplete ? (
                  <Check
                    size={16}
                    weight="bold"
                    color="var(--chakra-colors-violet-500)"
                  />
                ) : isActive ? (
                  <Spinner size="xs" color="violet.500" />
                ) : (
                  <Box
                    w="8px"
                    h="8px"
                    borderRadius="full"
                    borderWidth="1.5px"
                    borderColor="gray.300"
                  />
                )}
              </Flex>
              <Box>
                <Text
                  fontSize="sm"
                  fontFamily="heading"
                  fontWeight={isActive ? "700" : "500"}
                  color={
                    isActive
                      ? "charcoal.600"
                      : isComplete
                        ? "charcoal.400"
                        : "charcoal.300"
                  }
                >
                  {stageMeta.label}
                </Text>
                {isActive && stageMeta.subtitle && (
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.300">
                    {stageMeta.subtitle}
                  </Text>
                )}
              </Box>
            </Flex>
          );
        })}

        <Flex
          align="center"
          justify="space-between"
          borderTopWidth="1px"
          borderColor="gray.100"
          pt={3}
          mt={1}
        >
          <Text fontSize="xs" fontFamily="heading" color="charcoal.300">
            {elapsed}
          </Text>
          {onStop && (
            <Button size="xs" variant="ghost" color="charcoal.400" onClick={onStop}>
              Stop
            </Button>
          )}
        </Flex>
      </VStack>
    </Box>
  );
}

/**
 * The settled recovery card shown when a build stream ends with NO app —
 * a Stop, a rejected fetch, an SSE error, or `done` with no code artifact.
 * It replaces the ticking progress card so the surface stops advancing and
 * offers an honest way forward.
 */
export function BuildStopped({ onRetry }: { onRetry?: () => void }) {
  return (
    <Box
      role="status"
      aria-label="The build stopped before an app appeared"
      w="100%"
      maxW="360px"
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      shadow="sm"
      px={5}
      py={5}
    >
      <VStack align="stretch" gap={2}>
        <Text
          fontSize="sm"
          fontFamily="heading"
          fontWeight="700"
          color="charcoal.600"
        >
          The build stopped before an app appeared
        </Text>
        <Text fontSize="xs" fontFamily="heading" color="charcoal.400">
          Try again, or describe what to build.
        </Text>
        {onRetry && (
          <Flex justify="flex-start" pt={2}>
            <Button size="xs" colorPalette="violet" onClick={onRetry}>
              Try again
            </Button>
          </Flex>
        )}
      </VStack>
    </Box>
  );
}
