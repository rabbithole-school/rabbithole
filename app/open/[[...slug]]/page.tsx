"use client";

import Link from "next/link";
import { Flex, Heading, Text, VStack } from "@chakra-ui/react";
import { AppLogo } from "@/components/AppLogo";

/**
 * Web fallback for /open/* universal links. On an iPad with the Rabbithole app
 * installed, iOS opens the app directly and this page never renders. It exists
 * so the same link still resolves to a real page everywhere else — desktop, a
 * non-iPad browser, or an iPad without the app — instead of a 404. Static, no
 * auth, no data; it renders for any /open/<anything>.
 */
export default function OpenLinkFallback() {
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
            Open in the Rabbithole app
          </Heading>
          <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
            This link opens the Rabbithole iPad app. Open it on your school iPad,
            or head to the site to keep going here.
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
            Go to Rabbithole →
          </Text>
        </Link>
      </VStack>
    </Flex>
  );
}
