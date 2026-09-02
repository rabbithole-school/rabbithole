"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Box, Button, Flex } from "@chakra-ui/react";
import { AppHeader } from "./AppHeader";
import { AppLogo } from "./AppLogo";
import { AccountMenu } from "./AccountMenu";
import { BackgroundTasksIndicator } from "./BackgroundTasksIndicator";
import { TeacherNavTabs, teacherNavHref, useTeacherTabPrefetch, type TeacherNavKey } from "./TeacherNavTabs";
import { TEACHER_CHAT_PATH } from "@/lib/teacherChat";
import { useSignOut } from "@/hooks/useSignOut";

/**
 * The shared Rabbithole top nav (logo + the staff sections + account) for
 * teacher SUBROUTES — the unit designer and other full-page
 * surfaces that aren't the dashboard itself. Without it those routes drop the
 * main chrome and read as their own island; rendering it on top gives them
 * the same two-bar structure as the dashboard's scholar view (global nav +
 * a surface sub-bar), so the robot pane and everything else is reached the
 * same way everywhere.
 *
 * The tab strip is the shared `TeacherNavTabs` (same component + styling as the
 * dashboard's nav — so the header weight doesn't change between surfaces).
 * Here a click `router.push`es to the target route (`/teacher/<tab>`).
 * `activeKey` highlights the surface you came from.
 */
export function TeacherTopNav({ activeKey }: { activeKey?: TeacherNavKey }) {
  const [signOut] = useSignOut();
  const router = useRouter();
  const prefetchTab = useTeacherTabPrefetch();
  return (
    <AppHeader>
      <Box mr={6} display={{ base: "none", lg: "block" }}>
        {/* Home. These subroutes don't know the viewer's role, so they go
            through `/`, which resolves it. */}
        <Link href="/" aria-label="Home" style={{ display: "inline-flex", alignItems: "center" }}>
          <AppLogo variant="dark" size={28} />
        </Link>
      </Box>

      <TeacherNavTabs
        activeKey={activeKey}
        onNavigate={(key) => router.push(teacherNavHref(key))}
        onPrefetch={prefetchTab}
        homeHref="/"
        onHomeNavigate={() => router.push("/")}
      />

      <Flex ml="auto" align="center" gap={1}>
        {/* These two detail routes sit OUTSIDE the dashboard shell, so they
            host no <AideDockProvider> and therefore no Robot — the strip's
            former Chat tab was their only chat door. Keep that door, with the
            dock's own label and destination, rather than stranding chat here or
            forking a second dock into a surface that has never had one. A real
            link (Next handles the soft-nav), same as every other link here —
            and like the rest of this header's links it carries no `?inst=`,
            because these routes don't resolve an institution lens. */}
        <Button
          asChild
          size="sm"
          px={2}
          variant="ghost"
          fontFamily="heading"
          fontWeight="600"
          fontSize="xs"
          color="charcoal.400"
          _hover={{ color: "violet.500", bg: "violet.50" }}
          whiteSpace="nowrap"
        >
          <Link href={TEACHER_CHAT_PATH}>All chats</Link>
        </Button>
        <BackgroundTasksIndicator />
        <AccountMenu onSignOut={signOut} />
      </Flex>
    </AppHeader>
  );
}
