"use client";

// Institutions — the platform-admin surface for the whole institution lifecycle
// on ONE screen: the schools that EXIST (InstitutionsList: mark · kind · size ·
// active/paused status, with pause/resume + cascading delete per row) and,
// below, the create-institution invites that bring new ones INTO being
// (InvitesManager). The two are one story — a create-institution invite exists
// only to produce an institution, and a redeemed one now records
// `createdInstitutionId`, so its row names the school it produced. This replaces
// the old "Invites" subtab (invites are folded in, nothing regresses) rather
// than adding a second tab beside it.
//
// PLATFORM ADMINS ONLY. Three-state guard (loading / denied / allowed) via
// useAuthorizationGuard so a mid-load render is never treated as "denied" — the
// per-page belt to the layout's braces. The real enforcement is server-side:
// every function these components call is a platformAdmin* (list/lifecycle/
// invites) — the button state is never the only guard.

import { VStack } from "@chakra-ui/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { InstitutionsList } from "@/components/institutions/InstitutionsList";
import { InvitesManager } from "@/components/invites/InvitesManager";

export default function AdminInstitutionsPage() {
  const { user, isLoading } = useCurrentUser();
  const isAdmin = isPlatformAdminRole(user?.role as Role | undefined);
  const authorization = useAuthorizationGuard({
    isLoading,
    hasUser: !!user,
    isAllowed: isAdmin,
    unauthorizedRedirect: "/",
  });

  if (authorization !== "allowed") {
    return <AuthorizationPending />;
  }

  return (
    <VStack align="stretch" gap={10}>
      <InstitutionsList />
      <InvitesManager variant="admin" />
    </VStack>
  );
}
