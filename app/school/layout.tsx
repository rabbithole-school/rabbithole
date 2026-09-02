"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Box, Container, Flex, Stack } from "@chakra-ui/react";
import { SchoolInstitutionSelect } from "@/components/SchoolInstitutionSelect";
import { StaffShell } from "@/components/StaffShell";
import { ShellNav } from "@/components/ui/ShellNav";
import { teacherNavKeysForRole } from "@/components/TeacherNavTabs";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { NAV, isNavItemVisible, isStaffRoleForSchool } from "./nav";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { teacherHomeHref } from "@/lib/teacherHome";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";

export default function SchoolLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AuthorizationPending />}>
      <SchoolLayoutInner>{children}</SchoolLayoutInner>
    </Suspense>
  );
}

function SchoolLayoutInner({ children }: { children: ReactNode }) {
  const { user, isLoading } = useCurrentUser();
  const pathname = usePathname();
  const authorization = useAuthorizationGuard({
    isLoading,
    hasUser: !!user,
    isAllowed: isStaffRoleForSchool(user?.role),
    unauthorizedRedirect: "/",
  });
  const { activeInstitution, scopeParam, hasSchoolOperationsAccess } =
    useSchoolOperationsAccess(user, !!user);

  if (
    authorization !== "allowed"
    || !user
    || activeInstitution === undefined
    || hasSchoolOperationsAccess === undefined
  ) {
    return <AuthorizationPending />;
  }

  const schoolScopeParam = scopeParam === "all" ? "" : scopeParam;
  const items = NAV.filter((item) =>
    isNavItemVisible(
      item,
      user.role,
      user.hasCaptureReviewAccess,
      hasSchoolOperationsAccess === true,
      user.hasHealthManagementAccess === true,
    ),
  ).map((item) => ({
    ...item,
    href: withInstitutionScope(item.href, schoolScopeParam),
  }));

  return (
    <StaffShell
      activeKey="school"
      validTabs={teacherNavKeysForRole(
        user.role,
        user.hasCurriculumAccess,
        user.hasProgramPublishingAccess,
        hasSchoolOperationsAccess === true,
      )}
      homeHref={teacherHomeHref(
        user.role,
        schoolScopeParam,
        hasSchoolOperationsAccess === true,
      )}
      role={user.role}
    >
      <Box h="full" minW={0} minH={0} overflowY="auto" p={6}>
        <Container maxW="7xl">
          <Flex
            direction={{ base: "column", lg: "row" }}
            align={{ base: "stretch", lg: "flex-start" }}
            gap={6}
          >
            <Stack w={{ base: "full", lg: "200px", xl: "220px" }} flexShrink={0} gap={3}>
              <SchoolInstitutionSelect />
              <ShellNav items={items} pathname={pathname} ariaLabel="School sections" />
            </Stack>
            <Box flex={1} minW={0} w="full">
              {children}
            </Box>
          </Flex>
        </Container>
      </Box>
    </StaffShell>
  );
}
