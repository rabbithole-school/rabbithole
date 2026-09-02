"use client";

// SCHOOL DELETED — the calm, unauthenticated destination a school admin lands on
// after deleting their own school (which also deleted their own account). It
// mounts NO Convex queries, so it renders for a signed-out visitor without
// racing a vanished session. The admin is sent here by DeleteSchoolDialog via
// useSignOut (see lib/deleteSchoolNav.ts). The deletion runs server-side and is
// uninterruptible, so this page states plainly that it is done — no spinner, no
// "you must wait", no browser "Leave site?" prompt.

import Link from "next/link";
import { Box, Button, Container, Heading, HStack, Text, VStack } from "@chakra-ui/react";
import { CheckCircle } from "@phosphor-icons/react";

export default function SchoolDeletedPage() {
  return (
    <Box
      minH="100dvh"
      bg="linear-gradient(135deg, #222656 0%, #1a1d42 50%, #364153 100%)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      p={4}
      position="fixed"
      inset={0}
      overflowY="auto"
    >
      <Container maxW="lg">
        <VStack
          gap={6}
          bg="white"
          p={{ base: 8, md: 12 }}
          borderRadius="2xl"
          shadow="2xl"
          textAlign="center"
        >
          <Box color="green.500">
            <CheckCircle size={48} weight="fill" />
          </Box>

          <VStack gap={3}>
            <Heading
              as="h1"
              size="xl"
              fontFamily="heading"
              color="navy.500"
              fontWeight="700"
            >
              Your school has been deleted
            </Heading>
            <Text fontFamily="body" color="charcoal.500" lineHeight="1.6">
              The school and your account, along with everything scoped to them,
              have been permanently deleted. This is done and cannot be undone.
            </Text>
            <Text fontFamily="body" fontSize="sm" color="charcoal.400" lineHeight="1.6">
              The deletion runs on our servers and finishes even if you close
              this page — nothing here can interrupt it. You have been signed
              out.
            </Text>
          </VStack>

          <HStack gap={3} pt={2} flexWrap="wrap" justify="center">
            <Button
              asChild
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
            >
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button asChild variant="ghost" fontFamily="heading" color="charcoal.500">
              <Link href="/">Go to homepage</Link>
            </Button>
          </HStack>
        </VStack>
      </Container>
    </Box>
  );
}
