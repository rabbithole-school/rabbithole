"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Heading, Spinner } from "@chakra-ui/react";
import { AppHeader } from "@/components/AppHeader";
import { AppLogo } from "@/components/AppLogo";
import { AccountMenu } from "@/components/AccountMenu";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSignOut } from "@/hooks/useSignOut";
import { useScholarFont } from "@/hooks/useScholarFont";
import { ROLES } from "@/convex/lib/roles";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

/**
 * Shared chrome for the three Scholar's-Prep surfaces (the chooser, the
 * reflection chat, the Workshop board). Mirrors /me: the logo acts as Back, the
 * header names the section, the account menu sits on the right. Scholars only;
 * everyone else is routed to their home. Honors the scholar's accessible font
 * exactly as the tutor view does (no remote mode here).
 */
export function ScholarPrepShell({
  title,
  backHref = "/scholar",
  preferBackHref = false,
  children,
}: {
  title: string;
  /** Where Back goes when there's no history to pop (deep-linked open). */
  backHref?: string;
  /** Use the destination even when browser history exists. */
  preferBackHref?: boolean;
  children: ReactNode;
}) {
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

  useScholarFont(
    user?.preferredFont as "andika" | "opendyslexic" | undefined,
    false,
  );

  const goBack = () => {
    if (preferBackHref) router.push(backHref);
    else if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(backHref);
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
          {title}
        </Heading>
        <Box flex={1} />
        <AccountMenu onSignOut={signOut} />
      </AppHeader>

      <Box flex={1} minH={0}>
        {children}
      </Box>
    </Flex>
  );
}
