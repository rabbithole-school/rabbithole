"use client";

/**
 * SUSPENDED-INSTITUTION GATE — the app-wide paused screen.
 *
 * When a member's school is temporarily disabled (institutions.disabledAt set),
 * the server refuses every authed read/write at the requireUser chokepoint. This
 * gate reads the NON-throwing `users.currentUser` bootstrap flag
 * (`institutionSuspended`) and, when set, renders a short, non-alarming
 * "access is paused" screen INSTEAD of the app — so the child pages (whose
 * authed queries would otherwise throw into the error boundary) never mount.
 *
 * Platform admins are never suspended, so they pass straight through and retain
 * full access to inspect and re-enable. Signed-out visitors have no user, so
 * unauthenticated pages (sign-in, join, dev-login) are unaffected.
 */
import { Box, Button, Heading, Text, VStack } from "@chakra-ui/react";
import { PauseCircle } from "@phosphor-icons/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSignOut } from "@/hooks/useSignOut";

export function SuspendedInstitutionGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useCurrentUser();
  const [signOut, isSigningOut] = useSignOut();

  const suspended = Boolean(
    user && (user as { institutionSuspended?: boolean }).institutionSuspended,
  );
  if (!suspended) return <>{children}</>;

  const schoolName =
    (user as { institutionSuspendedName?: string | null })
      ?.institutionSuspendedName ?? null;

  return (
    <Box
      position="fixed"
      inset={0}
      bg="paper.50"
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={6}
      zIndex={2000}
    >
      <VStack
        gap={5}
        maxW="md"
        textAlign="center"
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="2xl"
        shadow="sm"
        px={{ base: 6, md: 10 }}
        py={{ base: 8, md: 10 }}
      >
        <Box color="amber.500">
          <PauseCircle size={44} weight="fill" />
        </Box>
        <Heading size="lg" fontFamily="heading" color="navy.500">
          Access is paused
        </Heading>
        <Text fontFamily="body" color="charcoal.500">
          {schoolName ? (
            <>
              Rabbithole access for <b>{schoolName}</b> is paused. Please contact
              your school administrator.
            </>
          ) : (
            <>
              Your school&apos;s Rabbithole access is paused. Please contact your
              school administrator.
            </>
          )}
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Your work is safe and unchanged — nothing has been deleted.
        </Text>
        <Button
          variant="outline"
          fontFamily="heading"
          onClick={() => void signOut()}
          loading={isSigningOut}
          loadingText="Signing out…"
        >
          Sign out
        </Button>
      </VStack>
    </Box>
  );
}
