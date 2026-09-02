"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { withInstitutionScope } from "@/lib/institutionLinks";

export function useActiveInstitution(enabled = true) {
  const searchParams = useSearchParams();
  const requestedScope = searchParams.get("inst") ?? "";
  const activeInstitution = useQuery(
    api.memberships.resolveActiveInstitution,
    enabled ? { scope: requestedScope || undefined } : "skip",
  );
  const scopeParam = activeInstitution?.scopeParam ?? requestedScope;
  const hrefWithActiveInstitution = useCallback(
    (href: string) => withInstitutionScope(href, scopeParam),
    [scopeParam],
  );

  return {
    requestedScope,
    activeInstitution,
    scopeParam,
    hrefWithActiveInstitution,
  };
}
