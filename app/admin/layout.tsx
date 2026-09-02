"use client";

// Platform-admin shell — the header, role gate, and the tab NAV
// (/admin/accounts · /admin/drive-sync). PLATFORM ADMINS ONLY: global users,
// roles, passkeys, and the global Drive-sync integration. The school-scoped
// School Directory moved OUT of this shell to /school/directory (operations staff +
// school admins) so a school admin never enters a platform surface. Each page
// also self-guards against a deep link. See app/admin/*/page.tsx.

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSignOut } from "@/hooks/useSignOut";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { Box, Container, Flex } from "@chakra-ui/react";
import { Users, Tray, ChartBar, Coins, UserSwitch, Buildings, EnvelopeSimple } from "@phosphor-icons/react";
import { AppHeader } from "@/components/AppHeader";
import { AppLogo } from "@/components/AppLogo";
import { AccountMenu } from "@/components/AccountMenu";
import { ShellNav } from "@/components/ui/ShellNav";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

type NavItem = { href: string; label: string; icon: ReactNode };
const NAV: NavItem[] = [
  { href: "/admin/accounts", label: "Accounts", icon: <Users /> },
  { href: "/admin/usage", label: "AI usage", icon: <Coins /> },
  { href: "/admin/institutions", label: "Institutions", icon: <Buildings /> },
  { href: "/admin/waitlist", label: "Waitlist", icon: <EnvelopeSimple /> },
  { href: "/admin/drive-sync", label: "Drive sync", icon: <Tray /> },
  { href: "/admin/practice-instruments", label: "Practice instruments", icon: <ChartBar /> },
];
const IMPERSONATE_NAV: NavItem = {
  href: "/admin/impersonate",
  label: "View as",
  icon: <UserSwitch />,
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user, isLoading } = useCurrentUser();
  const [signOut] = useSignOut();
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin = isPlatformAdminRole(user?.role as Role | undefined);
  const impersonationEnabled = useQuery(
    api.impersonation.isEnabled,
    isAdmin ? {} : "skip",
  );

  useEffect(() => {
    if (isLoading) return;
    if (!isAdmin) {
      router.replace("/");
    }
  }, [isAdmin, isLoading, router]);

  if (isLoading || !user || !isAdmin) {
    return null;
  }

  const items = impersonationEnabled ? [...NAV, IMPERSONATE_NAV] : NAV;

  return (
    <Box h={VIEWPORT_SHELL_HEIGHT} bg="gray.50" display="flex" flexDirection="column">
      <AppHeader>
        <Link href="/" aria-label="Home" style={{ display: "inline-flex", alignItems: "center" }}>
          <AppLogo variant="dark" size={28} />
        </Link>
        <Box flex={1} />
        <AccountMenu onSignOut={signOut} />
      </AppHeader>

      <Box flex={1} overflowY="auto" p={6}>
        <Container maxW="7xl">
          <Flex
            direction={{ base: "column", lg: "row" }}
            align={{ base: "stretch", lg: "flex-start" }}
            gap={6}
          >
            <ShellNav items={items} pathname={pathname} ariaLabel="Admin sections" />
            <Box flex={1} minW={0} w="full">
              {children}
            </Box>
          </Flex>
        </Container>
      </Box>
    </Box>
  );
}
