"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { firstVisibleNavHref } from "./nav";

export default function SchoolIndex() {
  const router = useRouter();
  const { user, isLoading } = useCurrentUser();
  const { scopeParam, hasSchoolOperationsAccess } = useSchoolOperationsAccess(user, !!user);

  useEffect(() => {
    if (isLoading || !user || hasSchoolOperationsAccess === undefined) return;
    const href = firstVisibleNavHref(
      user.role,
      user.hasCaptureReviewAccess,
      hasSchoolOperationsAccess === true,
      user.hasHealthManagementAccess === true,
    ) ?? "/";
    router.replace(withInstitutionScope(href, scopeParam === "all" ? "" : scopeParam));
  }, [router, user, isLoading, scopeParam, hasSchoolOperationsAccess]);

  return null;
}
