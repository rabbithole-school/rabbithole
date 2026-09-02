"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  clientAuthorization,
  signInRedirectForLocation,
} from "@/lib/clientAuthorization";

export function useAuthorizationGuard({
  isLoading,
  hasUser,
  isAllowed,
  unauthorizedRedirect,
}: {
  isLoading: boolean;
  hasUser: boolean;
  isAllowed: boolean;
  unauthorizedRedirect: string;
}) {
  const router = useRouter();
  const authorization = clientAuthorization({
    isLoading,
    hasUser,
    isAllowed,
  });
  const denialReason =
    authorization.state === "denied" ? authorization.reason : null;

  useEffect(() => {
    if (!denialReason) return;

    router.replace(
      denialReason === "signed-out"
        ? signInRedirectForLocation(window.location)
        : unauthorizedRedirect,
    );
  }, [denialReason, router, unauthorizedRedirect]);

  return authorization.state;
}
