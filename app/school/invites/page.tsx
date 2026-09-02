"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { InvitesManager } from "@/components/invites/InvitesManager";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";

// School invite links — school-admin (institution leader) or platform-admin
// only. Mint join links (teacher / scholar) for THIS school; list/revoke this
// school's join invites. Registrars/teachers can enter the school shell but not
// this page (mirrors /school/settings). The scope is enforced server-side by
// the schoolAdmin* functions InvitesManager calls.
function canManage(role: Role | string | undefined): boolean {
  return role === "school_admin" || isPlatformAdminRole(role as Role | undefined);
}

export default function SchoolInvitesPage() {
  const { user, isLoading } = useCurrentUser();
  const allowed = canManage(user?.role);
  const authorization = useAuthorizationGuard({
    isLoading,
    hasUser: !!user,
    isAllowed: allowed,
    unauthorizedRedirect: "/school/directory/scholars",
  });

  if (authorization !== "allowed") return <AuthorizationPending />;

  return <InvitesManager variant="school" />;
}
