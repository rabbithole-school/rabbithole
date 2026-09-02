"use client";

/**
 * `/` — two pages in one, chosen by whether you're signed in.
 *
 * SIGNED IN: unchanged. This is still the post-login router that sends each
 * role to its home (parents → /parent, staff → their dashboard after the
 * passkey-enrollment gate, everyone else → /scholar).
 *
 * SIGNED OUT: the public landing page. It used to bounce straight to
 * /sign-in, which meant the only front door Rabbithole had said nothing about
 * what Rabbithole is — a problem now that people arrive from public writing
 * rather than a school-issued device. The sign-in card on the right is the
 * SAME `AuthCard` /sign-in renders, not a second login form.
 */

import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewingContext } from "@/hooks/useViewingContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";
import {
  Box,
  Button,
  Container,
  Grid,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { ROLES } from "@/convex/lib/roles";
import { isClientStaffRole } from "@/hooks/useSchoolOperationsAccess";
import { teacherHomePath } from "@/lib/teacherHome";
import { AuthCard } from "@/components/AuthForm";
import { useDarkShellChrome } from "@/lib/native";

const SHELL_BG = "linear-gradient(135deg, #222656 0%, #1a1d42 50%, #364153 100%)";
let learnMoreUrl = "https://github.com/rabbithole-school/rabbithole";
let promptsSourceUrl =
  "https://github.com/rabbithole-school/rabbithole/blob/main/convex/prompts.ts";


function LoadingShell() {
  return (
    <Box
      minH="100vh"
      bg={SHELL_BG}
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      <VStack gap={4}>
        <Spinner size="xl" color="violet.500" borderWidth="4px" />
        <Text color="white" fontFamily="heading" fontSize="lg">
          Loading...
        </Text>
      </VStack>
    </Box>
  );
}

function Landing() {
  useDarkShellChrome();

  return (
    // `body` is height-locked with overflow hidden (globals.css), so a
    // full-bleed page has to own its own scroll or tall content is clipped
    // rather than scrollable — same idiom as AuthForm's screen.
    <Box
      position="fixed"
      inset={0}
      overflowY="auto"
      bg={SHELL_BG}
      py={{ base: 10, lg: 16 }}
      px={4}
    >
      {/* Hero art behind a navy scrim heavy enough to keep body text at full contrast. Fixed and
          pointer-events-none so it stays put while the page scrolls and never
          eats a click. */}
      <Box
        position="fixed"
        inset={0}
        zIndex={0}
        pointerEvents="none"
        backgroundImage="url('/astronaut-rabbit-hero.png')"
        backgroundSize="cover"
        backgroundPosition="center"
        _after={{
          content: '""',
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(100deg, rgba(26,29,66,0.94) 0%, rgba(26,29,66,0.86) 45%, rgba(34,38,86,0.55) 100%)",
        }}
      />

      <Container maxW="6xl" position="relative" zIndex={1}>
        <Grid
          templateColumns={{ base: "1fr", lg: "1fr 420px" }}
          gap={{ base: 10, lg: 16 }}
          alignItems="center"
        >
          <VStack align="stretch" gap={5} maxW="600px">
            <HStack gap={2} userSelect="none">
              <Text
                as="span"
                fontSize="40px"
                lineHeight="1"
                transform="scaleX(-1)"
                display="inline-block"
                aria-hidden
              >
                🐇
              </Text>
              <Text as="span" fontSize="40px" lineHeight="1" aria-hidden>
                🕳️
              </Text>
            </HStack>

            <VStack align="stretch" gap={2}>
              <Heading
                as="h1"
                fontSize={{ base: "4xl", lg: "5xl" }}
                fontFamily="heading"
                color="white"
                letterSpacing="tight"
              >
                Rabbithole
              </Heading>
              <Text
                fontFamily="heading"
                fontSize={{ base: "lg", lg: "xl" }}
                color="violet.200"
              >
                AI that makes you think harder.
              </Text>
            </VStack>

            <Text
              fontFamily="body"
              fontSize={{ base: "md", lg: "lg" }}
              lineHeight="1.7"
              color="whiteAlpha.900"
              pt={2}
            >
              Rabbithole is an open-source learning platform built by a school
              rather than a software company. The AI asks questions instead of
              handing over answers — a Socratic thought partner for each
              learner, while the teacher writes the prompts and stays in the
              loop.
            </Text>

            {/* The one CTA for a stranger. It lives here, in the content, not
                inside the sign-in card — that panel is for people who already
                have an account. */}
            <Box pt={1}>
              <Button
                asChild
                size="lg"
                h={14}
                px={8}
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                fontWeight="500"
              >
                <Link href="/waitlist">Request an invite</Link>
              </Button>
            </Box>

            <HStack
              gap={5}
              pt={2}
              flexWrap="wrap"
              fontFamily="heading"
              fontSize="sm"
            >
              <Text color="whiteAlpha.600">
                Built for curious learners
              </Text>
              <Link
                href={learnMoreUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Text
                  color="violet.200"
                  _hover={{ textDecoration: "underline" }}
                >
                  Read more about Rabbithole
                </Text>
              </Link>
              {/* Straight to the tutor's actual instructions — the "you can
                  read what it's following" claim, made checkable. */}
              <Link
                href={promptsSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Text
                  color="violet.200"
                  _hover={{ textDecoration: "underline" }}
                >
                  See the prompts
                </Text>
              </Link>
            </HStack>
          </VStack>

          <Box w="full">
            {/* No "need an account?" link inside the card here — the CTA in
                the left column is that path, and one page shouldn't offer it
                twice. /sign-in still shows it (it has no other route). */}
            <AuthCard mode="signIn" showAccountLink={false} />
          </Box>
        </Grid>
      </Container>
    </Box>
  );
}

export default function Home() {
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const { user, isLoading: userLoading } = useCurrentUser();
  const { signOut } = useAuthActions();
  const router = useRouter();
  const passkeyStatus = useQuery(
    api.passkeys.myStatus,
    isAuthenticated ? {} : "skip",
  );
  // If this session is impersonating ("view as"), skip the passkey-enrollment
  // bounce entirely: enrollment is about the REAL owner and an impersonated
  // view must never be pushed to /setup-passkey (that dead-ended/looped before).
  const { mode: viewingMode, viewingPending } = useViewingContext();

  useEffect(() => {
    if (authLoading) return;

    // Signed out: stay here and show the landing page (no redirect).
    if (!isAuthenticated) return;

    if (userLoading) return;

    if (!user) {
      // Authenticated but no user doc — stale session. Sign out to break loop.
      void signOut();
      return;
    }

    // Parents are non-staff and must NOT fall through to /scholar — they
    // get their own portal. (mustEnroll is staff-only, so a parent is never
    // forced into passkey setup; magic-link is their everyday path.)
    if (user.role === ROLES.PARENT) {
      router.replace("/parent");
      return;
    }

    // Use the shared STAFF_ROLES list so new staff capabilities (e.g. school:operations)
    // route to /teacher automatically instead of falling through to /scholar.
    const isStaff = isClientStaffRole(user.role);

    // Staff without a passkey must enroll before entering the app. Wait for
    // the status query so we don't bounce them in/out.
    if (isStaff) {
      if (passkeyStatus === undefined || viewingPending) return;
      if (passkeyStatus.mustEnroll && viewingMode !== "actAs") {
        router.replace("/setup-passkey");
        return;
      }
      router.replace(
        teacherHomePath(user.role, user.hasSchoolOperationsAccess),
      );
    } else {
      router.replace("/scholar");
    }
  }, [authLoading, isAuthenticated, user, userLoading, passkeyStatus, viewingMode, viewingPending, router, signOut]);

  if (authLoading) return <LoadingShell />;
  if (!isAuthenticated) return <Landing />;
  // Authenticated — the effect above is routing them to their home.
  return <LoadingShell />;
}
