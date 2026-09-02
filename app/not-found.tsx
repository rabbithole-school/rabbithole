"use client";

import Link from "next/link";
import { Flex, Heading, Text, VStack } from "@chakra-ui/react";
import { AppLogo } from "@/components/AppLogo";

export default function NotFound() {
  return (
    <Flex
      minH="100dvh"
      bg="linear-gradient(135deg, #222656 0%, #1a1d42 50%, #364153 100%)"
      align="center"
      justify="center"
      p={4}
    >
      <VStack
        gap={6}
        bg="white"
        p={{ base: 8, md: 12 }}
        borderRadius="2xl"
        shadow="2xl"
        textAlign="center"
        maxW="480px"
      >
        <AppLogo size={64} />
        <VStack gap={2}>
          <Heading
            as="h1"
            size="2xl"
            fontFamily="heading"
            color="navy.500"
            letterSpacing="tight"
          >
            Page not found
          </Heading>
          <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
            This page doesn&apos;t exist or has moved.
          </Text>
        </VStack>
        <Link href="/">
          <Text
            color="violet.500"
            fontFamily="heading"
            fontWeight="600"
            fontSize="sm"
            _hover={{ textDecoration: "underline" }}
          >
            Go home →
          </Text>
        </Link>
      </VStack>
    </Flex>
  );
}
