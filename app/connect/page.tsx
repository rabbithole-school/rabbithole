"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { AppHeader } from "@/components/AppHeader";
import { AppLogo } from "@/components/AppLogo";
import { AccountMenu } from "@/components/AccountMenu";
import { McpConnectorUrl, McpConnectionsList } from "@/components/McpConnections";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSignOut } from "@/hooks/useSignOut";
import { teacherHomePath } from "@/lib/teacherHome";
import { isClientStaffRole } from "@/hooks/useSchoolOperationsAccess";

/**
 * "Connect an AI assistant" — the discoverable home for the remote MCP
 * connector. Staff paste the connector URL into Claude or ChatGPT and sign in
 * as themselves, so the assistant reads exactly what they can see.
 *
 * This used to live inside the Account Details modal (components/McpConnections),
 * but the ~332px column could not hold the ChatGPT explanation, so the product
 * decision was to move it to its own page. Staff-only, gated the same way the
 * old modal row was (isStaffRole). Non-staff and signed-out users are routed
 * home / to sign-in, matching the /how-it-works and /school-space idiom.
 */
export default function ConnectPage() {
  const { user, isLoading } = useCurrentUser();
  const [signOut] = useSignOut();
  const router = useRouter();

  const role = user?.role;
  const isStaff = isClientStaffRole(role);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isStaff) {
      router.replace("/");
    }
  }, [user, isStaff, isLoading, router]);

  // Logo = Back to where they came from. router.back() returns to the exact
  // prior page; fall back to the viewer's home on a cold load.
  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else
      router.push(
        teacherHomePath(role, user?.hasSchoolOperationsAccess),
      );
  };

  if (isLoading || !user || !isStaff) {
    return (
      <Flex minH="100vh" bg="gray.50" align="center" justify="center">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  return (
    <Flex h="100dvh" bg="gray.50" flexDir="column">
      <AppHeader>
        <Box
          as="button"
          onClick={goBack}
          aria-label="Back"
          title="Back"
          display="flex"
          alignItems="center"
          cursor="pointer"
        >
          <AppLogo variant="dark" size={28} />
        </Box>
        <Box w="1px" h="20px" bg="gray.200" mx={3} />
        <Heading size="sm" fontFamily="heading" color="navy.500">
          Connect an AI assistant
        </Heading>
        <Box flex={1} />
        <AccountMenu onSignOut={signOut} />
      </AppHeader>

      <Box flex={1} minH={0} overflow="auto">
        <Box maxW="760px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="xl"
            shadow="xs"
            p={{ base: 5, md: 7 }}
          >
            <Heading
              as="h1"
              size="lg"
              fontFamily="heading"
              color="navy.500"
              mb={3}
            >
              Connect an AI assistant
            </Heading>

            <Text fontFamily="body" fontSize="sm" color="charcoal.500" mb={6}>
              Connect Rabbithole to Claude or ChatGPT so you can ask about your
              scholars in the assistant you already use. You sign in as
              yourself, so it sees what you can see.
            </Text>

            <Box mb={6}>
              <McpConnectorUrl />
            </Box>

            <Box mb={7}>
              <Heading
                as="h2"
                size="sm"
                fontFamily="heading"
                color="navy.500"
                mb={2}
              >
                What it can do
              </Heading>
              <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                A staff connection can read your scholars&rsquo; records and make
                changes you could make yourself, like creating activities,
                updating reports, and sending messages. Only connect an
                assistant you trust, and remove it here when you&rsquo;re done.
              </Text>
            </Box>

            <VStack align="stretch" gap={7}>
              <Box>
                <Heading
                  as="h2"
                  size="sm"
                  fontFamily="heading"
                  color="navy.500"
                  mb={3}
                >
                  Claude
                </Heading>
                <Box
                  as="ol"
                  listStyleType="decimal"
                  listStylePosition="outside"
                  ps={5}
                  fontFamily="body"
                  fontSize="sm"
                  color="charcoal.500"
                >
                  <Box as="li" mb={2}>
                    Open Settings, then Connectors.
                  </Box>
                  <Box as="li" mb={2}>
                    Click &ldquo;Add custom connector&rdquo;.
                  </Box>
                  <Box as="li" mb={2}>
                    Paste the link above, then click Add.
                  </Box>
                  <Box as="li">Sign in when Claude asks.</Box>
                </Box>
                <Text
                  fontFamily="body"
                  fontSize="sm"
                  color="charcoal.400"
                  mt={3}
                >
                  In a chat, use the + button to turn the connector on.
                </Text>
                <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={1}>
                  On a Team or Enterprise plan, your admin may need to add it for
                  you.
                </Text>
              </Box>

              <Box>
                <Heading
                  as="h2"
                  size="sm"
                  fontFamily="heading"
                  color="navy.500"
                  mb={2}
                >
                  ChatGPT
                </Heading>
                <Text
                  fontFamily="body"
                  fontSize="sm"
                  color="charcoal.400"
                  mb={3}
                >
                  Needs a paid plan. Plus, Pro, Business, and Enterprise can do
                  this; the free plan cannot.
                </Text>
                <Box
                  as="ol"
                  listStyleType="decimal"
                  listStylePosition="outside"
                  ps={5}
                  fontFamily="body"
                  fontSize="sm"
                  color="charcoal.500"
                >
                  <Box as="li" mb={2}>
                    In ChatGPT settings, turn on Developer mode.
                  </Box>
                  <Box as="li" mb={2}>
                    Go to Apps, click +, and paste the link above.
                  </Box>
                  <Box as="li">In a chat, pick the app from the + menu.</Box>
                </Box>
                <Text
                  fontFamily="body"
                  fontSize="sm"
                  color="charcoal.400"
                  mt={3}
                >
                  ChatGPT warns that developer connectors are powerful. That is
                  expected.
                </Text>
              </Box>

              <Box borderTopWidth="1px" borderColor="gray.100" pt={6}>
                <McpConnectionsList />
              </Box>
            </VStack>
          </Box>
        </Box>
      </Box>
    </Flex>
  );
}
