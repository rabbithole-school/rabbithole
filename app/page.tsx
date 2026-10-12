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
  chakra,
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
// One quiet purple→black wash + a barely-there starfield. The hero
// illustration that used to sit behind this had the same rabbit as the logo and
// competed with the copy and the card for attention, so the artwork now appears
// once, as the mark.
import {
  SHELL_BG,
  StarfieldBackground,
} from "@/components/StarfieldBackground";

/** The flat ground the mid-page content sits on — the starry sky is reserved
 *  for the header and footer bands, so long-form copy is never read against
 *  moving pinpricks. */
const CONTENT_BG = "#15112E";
import { useDarkShellChrome } from "@/lib/native";

let learnMoreUrl = "https://github.com/rabbithole-school/rabbithole";
const promptsSourceUrl =
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
      <StarfieldBackground position="fixed" />
      <VStack gap={4} position="relative" zIndex={1}>
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
    >
      {/* ONE sky for the whole page, pinned to the viewport. The shell is the
          scroll container, so neither its own gradient nor a fixed child moves
          while the content scrolls over them — the stars read as very far
          away. The bands below decide where that sky shows: the two ends are
          transparent, the middle is opaque and covers it, so long-form copy is
          never read against moving pinpricks. */}
      <StarfieldBackground position="fixed" />

      {/* HEADER BAND — sky */}
      <Box
        position="relative"
        zIndex={1}
        py={{ base: 10, lg: 16 }}
        px={4}
      >
        <Container maxW="6xl">
        <Grid
          templateColumns={{ base: "1fr", lg: "1fr 440px" }}
          gap={{ base: 10, lg: 16 }}
          alignItems="center"
        >
          <VStack align="stretch" gap={5} maxW="600px">

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
                AI that makes you think harder
              </Text>
            </VStack>

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

          </VStack>

          {/* The card has two states of different heights (password vs email
              link). With the grid centering both columns against the tallest
              cell, flipping the card resized the row and slid the copy on the
              left. Reserving the taller state's height here keeps the row a
              fixed size, so each column now lays out against that fixed height
              independently and only the card itself changes. */}
          <Box
            w="full"
            minH={{ lg: "660px" }}
            display="flex"
            flexDirection="column"
            justifyContent="center"
            alignItems="stretch"
          >
            {/* No "need an account?" link inside the card here — the CTA in
                the left column is that path, and one page shouldn't offer it
                twice. /sign-in still shows it (it has no other route). The
                wordmark is likewise already in the left column. */}
            <AuthCard mode="signIn" showAccountLink={false} showLogo={false} />
          </Box>
        </Grid>
        </Container>
      </Box>

      {/* CONTENT BAND — opaque, so it slides over the fixed sky */}
      <Box
        position="relative"
        zIndex={1}
        bg={CONTENT_BG}
        px={4}
        py={{ base: 12, lg: 20 }}
      >
        <Container maxW="6xl">

        {/* Below the fold: where Rabbithole comes from and who is behind it.
            A cold arrival deserves to know it is used daily with real children
            at a real school, and by whom, before being asked for an invite.
            Written as "we" — more than one person stands behind it, so the
            first person singular read as though the page had an unnamed
            author. The bios are deliberately bios and not testimonials: every
            claim is checkable on the public school site. */}
        <VStack
          align="stretch"
          gap={6}
        >
          <SectionHead>What is Rabbithole?</SectionHead>
          <VStack align="stretch" gap={5}>
            <Text
              fontFamily="body"
              fontSize="lg"
              lineHeight="1.75"
              color="whiteAlpha.900"
            >
              When a scholar sits down with Rabbithole, they get a Socratic
              dialogue partner. It does not hand over answers. It asks
              questions, offers another angle, and adapts to how they respond
              — while their teacher writes the prompts, sets the checkpoints
              along the way, and stays in the loop.
            </Text>
            <Text
              fontFamily="body"
              fontSize="lg"
              lineHeight="1.75"
              color="whiteAlpha.900"
            >
              It is used for real work in real classes rather than as a demo.
              Scholars take on quests, practice what they are actually ready
              for, and come back to it after a lab or a maker session to
              reflect on what they built — so the on-screen and off-screen
              halves of the day feed each other.
            </Text>
          </VStack>


        </VStack>
        </Container>
      </Box>

      {/* FOOTER BAND — the sky returns, and every call to action on the page
          is gathered here rather than scattered through the copy. */}
      <Box position="relative" zIndex={1} px={4} py={{ base: 14, lg: 20 }}>
        <Container maxW="6xl">
          <VStack align="stretch" gap={6} maxW="3xl">
            <Heading
              as="h2"
              fontSize={{ base: "2xl", lg: "3xl" }}
              fontFamily="heading"
              fontWeight="600"
              color="white"
              letterSpacing="tight"
            >
              Come see what your child asks it
            </Heading>
            <Text
              fontFamily="body"
              fontSize="lg"
              lineHeight="1.75"
              color="whiteAlpha.900"
            >
              Rabbithole is invite-only while we keep the group small enough to
              learn from. Tell us a little about your school or your family and
              a real person will read it and write back.
            </Text>

            <HStack gap={3} flexWrap="wrap" pt={1}>
              <Button
                asChild
                size="lg"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                fontWeight="500"
                h={14}
                px={7}
              >
                <Link href="/waitlist">Request an invite</Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                borderColor="whiteAlpha.400"
                color="white"
                _hover={{ bg: "whiteAlpha.100" }}
                fontFamily="heading"
                fontWeight="500"
                h={14}
                px={7}
              >
                <chakra.a
                  href={promptsSourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  See the prompts
                </chakra.a>
              </Button>
              <Button
                size="lg"
                variant="outline"
                borderColor="whiteAlpha.400"
                color="white"
                _hover={{ bg: "whiteAlpha.100" }}
                fontFamily="heading"
                fontWeight="500"
                h={14}
                px={7}
              >
                <chakra.a
                  href={learnMoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Read more about Rabbithole
                </chakra.a>
              </Button>
            </HStack>

            <Text
              fontFamily="heading"
              fontSize="sm"
              color="whiteAlpha.600"
              pt={2}
            >
              Built for curious learners
            </Text>
          </VStack>
        </Container>
      </Box>
    </Box>
  );
}

/** A section title inside the long-form part of the page. */
function SectionHead({
  children,
  mt,
}: {
  children: React.ReactNode;
  mt?: number;
}) {
  return (
    <Heading
      as="h2"
      fontSize={{ base: "xl", lg: "2xl" }}
      fontFamily="heading"
      fontWeight="600"
      color="white"
      letterSpacing="tight"
      mt={mt}
    >
      {children}
    </Heading>
  );
}

/** One person: photo, name, role, and a checkable bio. Deliberately no panel
 *  — the section already sits on its own, and boxing each person turned a
 *  short page into a stack of competing containers. */
function PersonCard({
  photo,
  name,
  role,
  bio,
}: {
  photo: string;
  name: string;
  role: string;
  bio: string;
}) {
  return (
    <Box>
      <VStack align="stretch" gap={3}>
        {/* One image treatment for all three cells. A circular avatar suits a
            headshot but reduces the six-person staff photo to somebody's
            shoulder, and giving that one cell its own shape put the visual
            inconsistency back. `center 30%` keeps faces in frame in both. */}
        <chakra.img
          src={photo}
          alt={name}
          w="full"
          h="150px"
          objectFit="cover"
          objectPosition="center 30%"
          borderRadius="xl"
          borderWidth="1px"
          borderColor="whiteAlpha.300"
        />
        <Box>
            <Text
              fontFamily="heading"
              fontSize="md"
              fontWeight="600"
              color="white"
            >
              {name}
            </Text>
          <Text fontFamily="heading" fontSize="sm" color="whiteAlpha.700">
            {role}
          </Text>
        </Box>
        <Text
          fontFamily="body"
          fontSize="md"
          lineHeight="1.8"
          color="whiteAlpha.800"
        >
          {bio}
        </Text>
      </VStack>
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
        teacherHomePath(
          user.role,
          user.hasSchoolOperationsAccess,
          user.hasCurriculumAccess,
        ),
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
