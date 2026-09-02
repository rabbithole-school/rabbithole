"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Heading, Spinner, Text } from "@chakra-ui/react";
import { AppHeader } from "@/components/AppHeader";
import { AppLogo } from "@/components/AppLogo";
import { AccountMenu } from "@/components/AccountMenu";
import { MyLearningView } from "@/components/MyLearningView";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSignOut } from "@/hooks/useSignOut";
import { ROLES } from "@/convex/lib/roles";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

/**
 * "My Learning" — the scholar's own learning portrait: badges + the work
 * they've made, how they work, how they've grown, and where they're pulled
 * next. Purpose-built learner view (MyLearningView) — second person, no
 * levels/grades — per review/learner-parent-pedagogy.md. Only scholars land
 * here; everyone else is routed home.
 *
 * Navigation: this is a *destination*, not a toggled mode — the header names
 * it ("My Learning") and the logo acts as Back (to wherever they came from),
 * rather than a mirror "Back to lessons" item in the account menu.
 */
export default function MyLearningPage() {
  const { user, isLoading } = useCurrentUser();
  const [signOut] = useSignOut();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (user.role !== ROLES.SCHOLAR) {
      router.replace("/"); // teachers/parents/etc. get routed to their home
    }
  }, [user, isLoading, router]);

  // Logo = Back to where they came from (usually their lessons). router.back()
  // returns to the exact prior page; fall back to /scholar on a cold load.
  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/scholar");
  };

  if (isLoading || !user || user.role !== ROLES.SCHOLAR) {
    return (
      <Flex minH="100vh" bg="gray.50" align="center" justify="center">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  return (
    <Flex h={VIEWPORT_SHELL_HEIGHT} bg="gray.50" flexDir="column">
      <AppHeader>
        <Box
          as="button"
          onClick={goBack}
          aria-label="Back to lessons"
          title="Back to lessons"
          display="flex"
          alignItems="center"
          cursor="pointer"
        >
          <AppLogo variant="dark" size={28} />
        </Box>
        <Box w="1px" h="20px" bg="gray.200" mx={3} />
        <Heading size="sm" fontFamily="heading" color="navy.500">
          My Learning
        </Heading>
        <Box flex={1} />
        <AccountMenu onSignOut={signOut} />
      </AppHeader>

      <Box flex={1} minH={0} overflow="auto">
        <Box maxW="760px" mx="auto" px={{ base: 4, md: 6 }} pt={6}>
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            Your learning, in one place: how you work, how you&apos;ve grown,
            and where you might go next.
          </Text>
        </Box>
        <MyLearningView scholarId={user._id} />
      </Box>
    </Flex>
  );
}
