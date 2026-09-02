"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  Box,
  Button,
  Container,
  Heading,
  Input,
  Text,
  VStack,
} from "@chakra-ui/react";
import { EnvelopeSimple, CheckCircle } from "@phosphor-icons/react";
import { MAGIC_LINK_PROVIDER_ID } from "@/convex/lib/authConstants";

// The parent "claim your account" landing — where a Welcome-invite link points
// (see review/parent-account-claim-plan.html). It is deliberately NOT a magic
// link: arriving here does nothing automatically. The parent taps one button,
// which fires the SAME audited magic-link flow as /sign-in, sending a fresh,
// short-lived (15-min) sign-in link to their inbox. So the durable invite link
// is inert, and the actual login credential is always minted fresh + used at
// once. The "claim" itself is the first successful magic-link login.
function ClaimInner() {
  const params = useSearchParams();
  const { signIn } = useAuthActions();

  const [email, setEmail] = useState(params.get("email")?.trim() ?? "");
  const [status, setStatus] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState("");

  const handleSend = async () => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) {
      setError("Enter the email address on your account");
      return;
    }
    setError("");
    setStatus("busy");
    try {
      await signIn(MAGIC_LINK_PROVIDER_ID, { email: normalized });
    } catch (err) {
      // Never reveal whether an account exists — always show "check your email".
      console.error("Claim sign-in request failed:", err);
    } finally {
      setStatus("sent");
    }
  };

  return (
    <Box
      minH="100dvh"
      bg="linear-gradient(135deg, #222656 0%, #1a1d42 50%, #364153 100%)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={4}
      position="fixed"
      inset={0}
      overflowY="auto"
    >
      <Container maxW="md">
        <VStack
          gap={6}
          bg="white"
          p={{ base: 8, md: 12 }}
          borderRadius="2xl"
          shadow="2xl"
          textAlign="center"
        >
          {status === "sent" ? (
            <Box color="green.500" lineHeight="1">
              <CheckCircle size={56} />
            </Box>
          ) : (
            <Box fontSize="48px" lineHeight="1" userSelect="none">
              🐇
            </Box>
          )}

          <VStack gap={2}>
            <Heading
              as="h1"
              size="xl"
              fontFamily="heading"
              color="navy.500"
              letterSpacing="tight"
            >
              {status === "sent" ? "Check your email" : "Welcome to Rabbithole"}
            </Heading>
            <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
              {status === "sent"
                ? "We sent a secure sign-in link to your inbox. It expires in 15 minutes — open it on this device to finish."
                : "Follow your child's learning — what they're exploring and where their curiosity is pulling them next. Tap below and we'll email you a secure sign-in link. No password to create."}
            </Text>
          </VStack>

          {status !== "sent" && (
            <VStack gap={4} w="full">
              <Input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                size="lg"
                h={14}
                fontFamily="body"
              />
              {error && (
                <Text fontSize="sm" color="red.500" fontFamily="body">
                  {error}
                </Text>
              )}
              <Button
                size="lg"
                w="full"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                fontWeight="500"
                h={14}
                disabled={status === "busy"}
                onClick={handleSend}
              >
                <EnvelopeSimple size={20} weight="bold" />
                {status === "busy" ? "Sending…" : "Email me my sign-in link"}
              </Button>
            </VStack>
          )}
        </VStack>
      </Container>
    </Box>
  );
}

export default function ClaimPage() {
  return (
    <Suspense fallback={null}>
      <ClaimInner />
    </Suspense>
  );
}
