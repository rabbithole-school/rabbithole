"use client";

import { Suspense, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Flex, Spinner } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewingContext } from "@/hooks/useViewingContext";
import { ROLES } from "@/convex/lib/roles";
import {
  activeTeacherNavKeyFromPathname,
  teacherNavKeysForRole,
  type TeacherNavKey,
} from "@/components/TeacherNavTabs";
import { StaffShell } from "@/components/StaffShell";
import { teacherHomeHref } from "@/lib/teacherHome";
import { isClientStaffRole, useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { signInRedirectForLocation } from "@/lib/clientAuthorization";

/**
 * Shared layout for the teacher DASHBOARD tab routes (Schedule / Quests /
 * Scholars / Curriculum / … plus the full-screen chat route, which has no tab
 * of its own). Rendered once and persists across tab navigations, so the top
 * nav + global overlays (⌘K palette) never remount and the route transition
 * only swaps the body.
 *
 * Scoped via the `(dashboard)` route group so the full-page detail surfaces
 * (`/teacher/unit/*`, `/teacher/persona/*`, …) keep their own chrome.
 *
 * Hosts the staff gate (moved from the old `app/teacher/page.tsx`) + the
 * passkey-enrollment bounce, so every teacher tab route is guarded before its
 * queries fire. A role-route guard sends a user who deep-links to a tab their
 * role can't see back to their default tab.
 */
function TeacherDashboardLoading() {
  return (
    <Flex minH="100dvh" bg="gray.50" align="center" justify="center">
      <Spinner size="xl" color="violet.500" />
    </Flex>
  );
}

export default function TeacherDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<TeacherDashboardLoading />}>
      <TeacherDashboardLayoutInner>{children}</TeacherDashboardLayoutInner>
    </Suspense>
  );
}

function TeacherDashboardLayoutInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inst = searchParams.get("inst") ?? "";

  // Only staff ever render past the gate below, so the layout's own queries are
  // staff-gated too — a parent/scholar caught here mid-redirect fires nothing
  // (preserving the old page-level gate's "non-staff fire no teacher queries"
  // property; these are harmless authedQuery metadata, but intent matters).
  const isStaff = isClientStaffRole(user?.role);
  const { hasSchoolOperationsAccess } = useSchoolOperationsAccess(user, !!user);
  const validTabs: TeacherNavKey[] = teacherNavKeysForRole(
    user?.role,
    user?.hasCurriculumAccess,
    user?.hasProgramPublishingAccess,
    hasSchoolOperationsAccess === true,
  );
  // Where the logo goes, and where a role-forbidden tab bounces to. `/teacher`
  // for an ordinary teacher (their Today inbox) — there is no Today tab, so
  // this is the single definition of "home" for both.
  const homeHref = teacherHomeHref(
    user?.role,
    inst,
    hasSchoolOperationsAccess === true,
  );

  const passkeyStatus = useQuery(api.passkeys.myStatus, isStaff ? {} : "skip");
  // Skip the passkey-enrollment bounce while impersonating (view-as) — see app/page.tsx.
  const { mode: viewingMode, viewingPending } = useViewingContext();

  // Staff gate + passkey-enrollment bounce.
  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace(signInRedirectForLocation(window.location));
      return;
    }
    if (!isClientStaffRole(user.role)) {
      router.replace(user.role === ROLES.PARENT ? "/parent" : "/scholar");
      return;
    }
    if (passkeyStatus?.mustEnroll && viewingMode !== "actAs" && !viewingPending) {
      router.replace("/setup-passkey");
    }
  }, [user, isLoading, passkeyStatus, viewingMode, viewingPending, router]);

  // Role-route guard: a tab the role can't see → bounce to its default.
  const activeKey = activeTeacherNavKeyFromPathname(pathname);
  const onForbiddenTab = !!activeKey && !validTabs.includes(activeKey);
  useEffect(() => {
    if (isLoading || !user || !isClientStaffRole(user.role)) return;
    if (hasSchoolOperationsAccess === undefined) return;
    if (activeKey && !validTabs.includes(activeKey)) {
      router.replace(homeHref);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- validTabs/homeHref derive from user.role
  }, [activeKey, isLoading, user, router, inst, hasSchoolOperationsAccess]);

  if (isLoading || !user || !isClientStaffRole(user.role)) {
    return <TeacherDashboardLoading />;
  }

  return (
    <StaffShell
      activeKey={activeKey}
      validTabs={validTabs}
      homeHref={homeHref}
      role={user.role}
    >
      {/* While the role-route guard's redirect effect runs, don't mount a
          forbidden tab's body — it would fire a role-gated query that 403s
          (e.g. an operations staffer deep-linked to /teacher/schedule) and could
          flash error.tsx before the bounce lands. */}
      {onForbiddenTab ? (
        <Flex h="full" align="center" justify="center">
          <Spinner size="xl" color="violet.500" />
        </Flex>
      ) : (
        children
      )}
    </StaffShell>
  );
}
