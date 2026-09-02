"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { useSignOut } from "@/hooks/useSignOut";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Box, Flex, HStack, Spinner } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { AppLogo } from "@/components/AppLogo";
import { AppHeader } from "@/components/AppHeader";
import { AccountMenu } from "@/components/AccountMenu";
import { BotIconButton } from "@/components/BotIconButton";
import { ParentDashboard } from "@/components/ParentDashboard";
import { ParentAideDock } from "@/components/parent/ParentAideDock";
import {
  ParentChildSwitcher,
  ParentNavTabs,
} from "@/components/parent/ParentNav";
import { parentTabFromPath } from "@/components/parent/parentTabs";
import {
  AideDockProvider,
  useAideDock,
} from "@/components/aide/AideDockProvider";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

export default function ParentPage() {
  return (
    <Suspense
      fallback={
        <Flex minH="100vh" bg="gray.50" align="center" justify="center">
          <Spinner size="xl" color="violet.500" />
        </Flex>
      }
    >
      <ParentView />
    </Suspense>
  );
}

/**
 * The parent portal — for any GUARDIAN (the parent CONTEXT), not just
 * `parent`-role accounts. A staff/admin user who is also a guardian of their
 * own child reaches this via the account menu's "Parent view"; parent-role
 * accounts land here by default. Access is gated on having a parent context
 * (≥1 guardianship), so a non-guardian is bounced to their own home.
 */
function ParentView() {
  const { user, isLoading } = useCurrentUser();
  const [signOut] = useSignOut();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hasParentContext = useQuery(
    api.parents.hasParentContext,
    user ? {} : "skip",
  );
  const children = useQuery(api.parents.listMyChildren, user ? {} : "skip");
  const threads = useQuery(
    api.parentMessages.listMyGuardianThreads,
    user ? {} : "skip",
  );
  const currentQuery = searchParams.toString();
  const currentPath = `${pathname}${currentQuery ? `?${currentQuery}` : ""}`;
  const requestedChild = searchParams.get("child");
  const activeChildRecord =
    children?.find((child) => child._id === requestedChild) ??
    children?.[0] ??
    null;
  const activeChild = activeChildRecord?._id ?? null;
  const programGuest =
    activeChildRecord?.enrollmentStanding === "program_guest";
  const activeTab = parentTabFromPath(pathname, programGuest);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace(`/sign-in?next=${encodeURIComponent(currentPath)}`);
      return;
    }
    // Wait for the guardianship check before deciding.
    if (hasParentContext === false) {
      router.replace("/"); // not a guardian → their own home
    }
  }, [user, isLoading, hasParentContext, router, currentPath]);

  if (
    isLoading ||
    !user ||
    hasParentContext === undefined ||
    hasParentContext === false ||
    children === undefined
  ) {
    return (
      <Flex minH="100vh" bg="gray.50" align="center" justify="center">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  return (
    <AideDockProvider>
      <Flex h={VIEWPORT_SHELL_HEIGHT} bg="gray.50" flexDir="column">
        <AppHeader>
          <Box mr={6} display={{ base: "none", lg: "block" }}>
            <Link
              href="/parent"
              aria-label="Home"
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <AppLogo variant="dark" size={28} />
            </Link>
          </Box>
          <ParentNavTabs
            activeKey={activeTab}
            messagesUnread={(threads ?? []).some((thread) => thread.hasUnread)}
            programGuest={programGuest}
            childId={activeChild}
            onNavigate={(tab) =>
              router.push(
                `/parent/${tab}${activeChild ? `?child=${activeChild}` : ""}`,
                { scroll: false },
              )
            }
            onHomeNavigate={() => router.push("/parent")}
          />
          <HStack ml="auto" gap={1}>
            {!programGuest && <ParentAideToggle />}
            <ParentChildSwitcher
              childOptions={children}
              activeChild={activeChild}
              onSelect={(childId) =>
                router.replace(`${pathname}?child=${childId}`, {
                  scroll: false,
                })
              }
            />
            <AccountMenu onSignOut={signOut} />
          </HStack>
        </AppHeader>
        {/* Body + docked aide as a flex row (the teacher dashboard's idiom):
            opening the aide PUSHES the body rather than covering it; closed,
            the dock renders nothing and the body takes the full width. The
            body keeps definite height + minH={0} so it stays the scroll
            container (minH=100vh would grow with content and never scroll). */}
        <Flex flex={1} minH={0} overflow="hidden">
          <Box
            flex={1}
            minW={0}
            overflow={activeTab === "messages" ? "hidden" : "auto"}
          >
            <ParentDashboard
              childOptions={children}
              activeChild={activeChild}
              tab={activeTab}
            />
          </Box>
          {!programGuest && <ParentAideDock />}
        </Flex>
      </Flex>
    </AideDockProvider>
  );
}

/** The header Robot — the single toggle for the parent's docked aide, the
 *  same affordance (and canonical <BotIconButton>) as the teacher header. */
function ParentAideToggle() {
  const { open, toggle } = useAideDock();
  return (
    <BotIconButton
      onClick={toggle}
      active={open}
      ariaLabel="Chat"
      tooltipText={open ? "Hide chat" : "Ask about your child's learning"}
    />
  );
}
