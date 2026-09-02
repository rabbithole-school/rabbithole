"use client";

import { Box, Flex, Heading, Text } from "@chakra-ui/react";
import { LockSimple } from "@phosphor-icons/react";

/**
 * A frosted "in development" lock over a feature that exists but isn't live
 * yet. Renders the real surface beneath (dimmed, non-interactive) so it's clear
 * WHAT is coming, with a centered card explaining it's disabled — so a user is
 * never misled into thinking an action (e.g. sending a parent message) worked.
 */
export function ComingSoonLock({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children: React.ReactNode;
}) {
  return (
    <Box position="relative" h="full" w="full">
      <Box
        h="full"
        w="full"
        opacity={0.35}
        filter="grayscale(0.4)"
        pointerEvents="none"
        userSelect="none"
        aria-hidden
      >
        {children}
      </Box>
      <Flex
        position="absolute"
        inset={0}
        align="center"
        justify="center"
        bg="whiteAlpha.600"
        backdropFilter="blur(2px)"
        zIndex={10}
        p={6}
      >
        <Flex
          direction="column"
          align="center"
          textAlign="center"
          gap={3}
          maxW="420px"
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="2xl"
          shadow="md"
          px={8}
          py={7}
        >
          <Flex
            align="center"
            justify="center"
            w="48px"
            h="48px"
            borderRadius="full"
            bg="violet.50"
            color="violet.500"
          >
            <LockSimple size={24} weight="fill" />
          </Flex>
          <Heading fontFamily="heading" fontSize="lg" color="navy.500">
            {title}
          </Heading>
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            {message}
          </Text>
        </Flex>
      </Flex>
    </Box>
  );
}
