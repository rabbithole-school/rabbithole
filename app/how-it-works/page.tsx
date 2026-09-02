"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { Box, Flex, Heading, Spinner } from "@chakra-ui/react";
import { AppHeader } from "@/components/AppHeader";
import { AppLogo } from "@/components/AppLogo";
import { AccountMenu } from "@/components/AccountMenu";
import { BehindTheCurtain } from "@/components/BehindTheCurtain";
import { api } from "@/convex/_generated/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSignOut } from "@/hooks/useSignOut";
import { ROLES, isStaffRole } from "@/convex/lib/roles";
import { teacherHomePath } from "@/lib/teacherHome";

/**
 * "How it works" — the scholar-facing transparency surface (the anti-parasocial
 * "peek behind the curtain", PR5 in review/anti-parasocial-design.md). It
 * demystifies how Rabbithole actually works: it keeps a learning record a real
 * teacher oversees, the AI has no memory of its own, it's a thinking partner
 * (not a crutch or a friend) running Rabbithole-authored instructions — and
 * that exact prompt code is public on GitHub if you want to check.
 *
 * It used to be tacked onto the bottom of /me (My Learning), but it answers a
 * different question — "what is this AI?" rather than "who am I as a learner?" —
 * so it lives on its own destination, reached from the account menu (and a quiet
 * footer on the scholar home + parent portal). Audience-aware: scholars get
 * warm second-person copy, parents/staff get an adult register (staff also get a
 * "your part in the loop" section). Any signed-in role may view it.
 *
 * Navigation: a destination, not a toggled mode — the header names it ("How it
 * works") and the logo acts as Back (to wherever they came from).
 */
export default function HowItWorksPage() {
  const { user, isLoading } = useCurrentUser();
  const [signOut] = useSignOut();
  const router = useRouter();

  const summary = useQuery(
    api.learningRecord.mySummary,
    user && user.role === ROLES.SCHOLAR ? { scholarId: user._id } : "skip",
  );

  const role = user?.role;
  const isStaff = isStaffRole(role);
  const audience: "scholar" | "parent" | "staff" =
    role === ROLES.PARENT ? "parent" : isStaff ? "staff" : "scholar";
  const isAllowed =
    role === ROLES.SCHOLAR || role === ROLES.PARENT || isStaff;

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isAllowed) {
      router.replace("/"); // unknown role → their home
    }
  }, [user, isLoading, isAllowed, router]);

  // Logo = Back to where they came from. router.back() returns to the exact
  // prior page; fall back to the viewer's home on a cold load.
  const homePath =
    role === ROLES.PARENT ? "/parent" : isStaff ? teacherHomePath(role) : "/scholar";
  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(homePath);
  };

  if (isLoading || !user || !isAllowed) {
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
          How it works
        </Heading>
        <Box flex={1} />
        <AccountMenu onSignOut={signOut} />
      </AppHeader>

      <Box flex={1} minH={0} overflow="auto">
        <Box maxW="760px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
          <BehindTheCurtain summary={summary} audience={audience} />
        </Box>
      </Box>
    </Flex>
  );
}
