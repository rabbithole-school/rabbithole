"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { AdminParentsManager } from "@/components/AdminParentsManager";

// Guardians lens of the School Directory — guardian contact info, child links,
// copy-emails. Open to operations staff + school admins (and platform admins).
// Self-guards against a deep link (a curriculum designer can enter the shell
// but not this scholar-admin surface), matching the sibling Staff/Devices tabs;
// AdminParentsManager's queries are scholar-admin gated too. The sibling
// Scholars lens lives at /school/directory/scholars.
export default function SchoolGuardiansPage() {
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
  return <AdminParentsManager view="guardians" />;
}
