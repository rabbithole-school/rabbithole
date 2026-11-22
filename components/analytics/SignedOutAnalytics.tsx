"use client";

import { useConvexAuth } from "convex/react";
import { PublicAnalytics } from "./PublicAnalytics";

/**
 * PublicAnalytics for a public page that runs inside the app's providers and
 * that a signed-in scholar, teacher or parent can also open (/how-it-works,
 * /waitlist, /davidson). It loads only once sign-in has resolved to
 * signed out, so nobody with an account is counted there.
 */
export function SignedOutAnalytics() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading || isAuthenticated) return null;
  return <PublicAnalytics />;
}
