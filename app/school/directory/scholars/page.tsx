"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { AdminParentsManager } from "@/components/AdminParentsManager";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";

// Scholars lens of the School Directory — a scholar roster with linked
// guardians + per-scholar emergency one-pagers. Sibling of
// /school/directory/guardians (the Guardians lens); same scholar-admin gating,
// surfaced as a top-level tab. Self-guards against a deep link (a
// curriculum designer can enter the shell but not this scholar-admin surface),
// matching the sibling Staff/Devices tabs; the backend queries are
// scholar-admin gated too.
export default function SchoolScholarsPage() {
  const { user, isLoading } = useCurrentUser();
  const { activeInstitution, hasSchoolOperationsAccess } = useSchoolOperationsAccess(user, !!user);
  const authorization = useAuthorizationGuard({
    isLoading: isLoading || activeInstitution === undefined,
    hasUser: !!user,
    isAllowed: hasSchoolOperationsAccess === true,
    unauthorizedRedirect: "/",
  });
  if (authorization !== "allowed" || !user) {
    return <AuthorizationPending />;
  }
  return <AdminParentsManager view="scholars" />;
}
