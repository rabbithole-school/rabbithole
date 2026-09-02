"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { Box, Flex, Stack, Text, chakra } from "@chakra-ui/react";
import {
  CaretRight,
  SunHorizon,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { ReflectionIcon, WorkshopIcon } from "@/lib/activityMode";
import { Surface } from "@/components/ui/Surface";
import { useRemote } from "@/hooks/useRemote";

const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "2px",
} as const;

/**
 * The one Now-tab doorway into Scholar's Prep. Its warm sunset treatment
 * communicates the real current state: the Prep window is open.
 */
export function PrepEntryCard({ onOpen }: { onOpen: () => void }) {
  return (
    <chakra.button
      type="button"
      onClick={onOpen}
      aria-label="Open Scholar’s Prep"
      display="flex"
      alignItems="center"
      gap={{ base: 3, md: 4 }}
      w="full"
      minH="104px"
      p={{ base: 4, md: 5 }}
      textAlign="left"
      bg="orange.100"
      borderWidth="1px"
      borderColor="orange.300"
      borderRadius="xl"
      shadow="sm"
      cursor="pointer"
      transition="background 0.12s, transform 0.12s"
      _hover={{ bg: "orange.200", transform: "translateY(-1px)" }}
      _active={{ transform: "translateY(0)" }}
      _focusVisible={FOCUS_RING}
    >
      <Flex
        aria-hidden="true"
        align="center"
        justify="center"
        w={{ base: "52px", md: "60px" }}
        h={{ base: "52px", md: "60px" }}
        flexShrink={0}
        borderRadius="full"
        bg="orange.300"
        color="orange.900"
      >
        <SunHorizon size={32} weight="duotone" />
      </Flex>
      <Box flex={1} minW={0}>
        <Text
          fontFamily="heading"
          fontWeight="800"
          fontSize={{ base: "lg", md: "xl" }}
          color="navy.600"
          lineHeight="1.2"
        >
          Time for Scholar&rsquo;s Prep
        </Text>
        <Text mt={1} fontSize="sm" color="charcoal.600" lineHeight="1.45">
          Make your take-home plan, reflect on today, or visit The Workshop.
        </Text>
      </Box>
      <Flex
        align="center"
        gap={1}
        flexShrink={0}
        fontFamily="heading"
        fontWeight="700"
        fontSize="sm"
        color="navy.600"
      >
        <Text display={{ base: "none", sm: "block" }}>Open</Text>
        <CaretRight aria-hidden="true" size={20} weight="bold" />
      </Flex>
    </chakra.button>
  );
}

/** Reflection and The Workshop are separate Prep choices, not one workflow. */
export function PrepActivityCards() {
  const router = useRouter();
  const { stamp } = useRemote();
  const reflectionSnippet = useQuery(api.metaChat.myReflectionSnippet, {});

  return (
    <Stack gap={3}>
      <PrepActivityCard
        icon={<ReflectionIcon size={28} weight="regular" />}
        title="Today's reflection"
        subtitle={
          reflectionSnippet?.subtitle ??
          "How did today actually go? Take a quick look back."
        }
        onOpen={() => router.push(stamp("/scholar/reflection?from=prep"))}
      />
      <PrepActivityCard
        icon={<WorkshopIcon size={28} weight="regular" />}
        title="The Workshop"
        subtitle="Got an idea for Rabbithole? See what's new and how it works."
        onOpen={() => router.push(stamp("/scholar/workshop?from=prep"))}
      />
    </Stack>
  );
}

function PrepActivityCard({
  icon,
  title,
  subtitle,
  onOpen,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onOpen: () => void;
}) {
  return (
    <Surface p={0} overflow="hidden">
      <chakra.button
        type="button"
        onClick={onOpen}
        aria-label={title}
        display="flex"
        alignItems="center"
        gap={3.5}
        w="full"
        minH="88px"
        px={4}
        py={3.5}
        textAlign="left"
        cursor="pointer"
        transition="background 0.12s"
        _hover={{ bg: "gray.50" }}
        _focusVisible={FOCUS_RING}
      >
        <Flex
          aria-hidden="true"
          align="center"
          justify="center"
          w="44px"
          h="44px"
          flexShrink={0}
          borderRadius="lg"
          bg="violet.50"
          color="navy.500"
        >
          {icon}
        </Flex>
        <Box flex={1} minW={0}>
          <Text
            fontFamily="heading"
            fontWeight="700"
            fontSize="md"
            color="charcoal.600"
            lineHeight="1.3"
          >
            {title}
          </Text>
          <Text mt={0.5} fontSize="sm" color="charcoal.400" lineHeight="1.45">
            {subtitle}
          </Text>
        </Box>
        <Box aria-hidden="true" color="gray.400" flexShrink={0}>
          <CaretRight size={19} weight="bold" />
        </Box>
      </chakra.button>
    </Surface>
  );
}
