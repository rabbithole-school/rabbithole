"use client";

import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import {
  Box,
  Flex,
  IconButton,
  Portal,
  Tooltip,
} from "@chakra-ui/react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { isTeacherRole, type Role } from "@/convex/lib/roles";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSignOut } from "@/hooks/useSignOut";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { messagingSchoolSlug } from "@/lib/messagingScope";
import { AppHeader } from "@/components/AppHeader";
import { AppLogo } from "@/components/AppLogo";
import { AccountMenu } from "@/components/AccountMenu";
import { BackgroundTasksIndicator } from "@/components/BackgroundTasksIndicator";
import { ScannerPanel } from "@/components/ScannerPanel";
import {
  TeacherNavTabs,
  teacherNavHrefWithScope,
  useTeacherTabPrefetch,
  type TeacherNavKey,
} from "@/components/TeacherNavTabs";
import { AideDockProvider } from "@/components/aide/AideDockProvider";
import { AideDock } from "@/components/aide/AideDock";
import { AideToggleButton } from "@/components/aide/AideToggleButton";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

const CommandPalette = dynamic(
  () =>
    import("@/components/CommandPalette").then((mod) => mod.CommandPalette),
  { ssr: false },
);

/**
 * The canonical staff chrome shared by the teacher dashboard and School.
 * Route layouts own authorization and their body; this shell owns everything
 * that must remain identical when a staff member crosses between them.
 */
export function StaffShell({
  activeKey,
  validTabs,
  homeHref,
  role,
  children,
}: {
  activeKey?: TeacherNavKey;
  validTabs: readonly TeacherNavKey[];
  homeHref: string;
  role?: Role | "staff";
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useCurrentUser();
  const prefetchTab = useTeacherTabPrefetch();
  const [signOut] = useSignOut();
  const { activeInstitution, scopeParam, requestedScope } = useActiveInstitution();
  // On Messages the nav keeps the messaging school in view (see
  // messagingSchoolSlug); elsewhere the generic lens.
  const navScope =
    messagingSchoolSlug(pathname, requestedScope) ?? scopeParam;
  const { hasSchoolOperationsAccess } = useSchoolOperationsAccess(user, !!user);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Search is gated on what it can actually search. Its scholar directory
  // (`users.listDirectoryScholars`) is scholar-admin gated and throws for
  // anyone else — a mentor, or a staffer whose only grants are unrelated
  // (health, publishing) — so it follows the server's own answer,
  // `staffAccess().canSearchScholars` (no scholar search until it arrives).
  const messagingAccess = useQuery(api.scholarMessages.staffAccess, {});
  const canSearchScholars = messagingAccess?.canSearchScholars === true;
  const canSearchSkills = isTeacherRole(role);
  const canSearchCurriculum = user?.hasCurriculumAccess === true;
  const canSearch = canSearchScholars || canSearchSkills || canSearchCurriculum;

  const units =
    useQuery(
      api.units.list,
      canSearch ? { scope: scopeParam || undefined } : "skip",
    ) ?? [];
  const perspectives =
    useQuery(api.perspectives.list, canSearch ? {} : "skip") ?? [];
  const processes =
    useQuery(api.processes.list, canSearch ? {} : "skip") ?? [];

  useEffect(() => {
    if (!canSearch) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSearch]);

  const navigateFromPalette = useCallback(
    (href: string) => {
      router.push(withInstitutionScope(href, scopeParam));
      setCommandPaletteOpen(false);
    },
    [router, scopeParam],
  );

  return (
    <AideDockProvider>
      <Flex h={VIEWPORT_SHELL_HEIGHT} bg="gray.50" direction="column">
        <AppHeader>
          <Box
            mr={6}
            flexShrink={0}
            display={{ base: "none", lg: "block" }}
          >
            <Link
              href={homeHref}
              aria-label="Home"
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  event.button !== 0
                ) {
                  return;
                }
                event.preventDefault();
                router.push(homeHref);
              }}
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <AppLogo variant="dark" size={28} />
            </Link>
          </Box>

          <TeacherNavTabs
            activeKey={activeKey}
            keys={validTabs}
            onNavigate={(key) =>
              router.push(teacherNavHrefWithScope(key, navScope))
            }
            onPrefetch={prefetchTab}
            hrefForKey={(key) => teacherNavHrefWithScope(key, navScope)}
            homeHref={homeHref}
            onHomeNavigate={() => router.push(homeHref)}
          />

          <Box flex={1} minW={0} />

          {canSearch && (
            <Tooltip.Root openDelay={400} closeDelay={0}>
              <Tooltip.Trigger asChild>
                <IconButton
                  aria-label="Search"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ color: "navy.500", bg: "gray.100" }}
                  onClick={() => setCommandPaletteOpen(true)}
                >
                  <MagnifyingGlass size={16} />
                </IconButton>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content fontFamily="heading" fontSize="xs">
                    {typeof navigator !== "undefined" &&
                    /Mac|iPhone|iPad/.test(navigator.platform)
                      ? "⌘K"
                      : "Ctrl+K"}{" "}
                    to search
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          )}

          {(hasSchoolOperationsAccess === true || user?.hasCaptureReviewAccess) && (
            <ScannerPanel scope={scopeParam || undefined} />
          )}
          <AideToggleButton />
          <BackgroundTasksIndicator />
          <AccountMenu onSignOut={signOut} />
        </AppHeader>

        <Flex flex={1} overflow="hidden" minH={0}>
          <Box flex={1} minW={0} overflow="hidden">
            {children}
          </Box>
          <AideDock />
        </Flex>

        {canSearch && (
          <CommandPalette
            units={units}
            perspectives={perspectives}
            processes={processes}
            isOpen={commandPaletteOpen}
            onClose={() => setCommandPaletteOpen(false)}
            onNavigate={navigateFromPalette}
            institutionName={activeInstitution?.institutionName ?? null}
            institutionSearchScope={activeInstitution?.scope ?? "all"}
            institutionScope={scopeParam}
            canSearchScholars={canSearchScholars}
            canSearchSkills={canSearchSkills}
            canSearchCurriculum={canSearchCurriculum}
          />
        )}
      </Flex>
    </AideDockProvider>
  );
}
