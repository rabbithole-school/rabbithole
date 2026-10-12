import { useEffect, useReducer } from "react";
import { Linking } from "react-native";
import { useRouter, useSitemap, useUnstableGlobalHref } from "expo-router";
import { useConvexAuth } from "@convex-dev/auth/react";

import {
  decideUniversalLinkNavigation,
  initialPendingLinkState,
  reducePendingLink,
} from "@/lib/universalLinks";

/**
 * Navigate the app in response to an Apple universal link
 * (an https /open/<native-route> link on a claimed host — see
 * UNIVERSAL_LINK_HOSTS), for both cold start
 * (Linking.getInitialURL) and warm delivery (the "url" event).
 *
 * The incoming URL is untrusted; resolveUniversalLink validates host, prefix,
 * scheme, traversal, and — against the live Expo Router sitemap — that the
 * route actually exists before we navigate. A link to the route already on
 * screen is a no-op (navigationHrefMatches), so it never pushes a duplicate.
 *
 * Delivery ordering: a warm "url" event and the async getInitialURL() promise
 * can resolve in either order, so the pending-link reducer never lets a
 * late-resolving cold-start URL overwrite a newer warm link.
 *
 * AUTH: we hold a link until `useConvexAuth()` reports `isAuthenticated`, then
 * apply it. This does NOT separately wait on AuthGate's other sub-states (the
 * initial auth-token load, managed-claim reconciliation/switching, or dev-login
 * readiness); expo-router simply defers the push until the authenticated stack
 * is mounted. The guarantee is only "never navigate while signed out", not
 * "wait for every AuthGate transition to settle".
 */
export function useUniversalLinkNavigation(): void {
  const router = useRouter();
  const sitemap = useSitemap();
  const currentHref = useUnstableGlobalHref();
  const { isAuthenticated } = useConvexAuth();
  const [pending, dispatch] = useReducer(reducePendingLink, initialPendingLinkState);

  useEffect(() => {
    Linking.getInitialURL()
      .then((url) => dispatch({ type: "cold", url }))
      .catch(() => {});
    const subscription = Linking.addEventListener("url", ({ url }) => {
      dispatch({ type: "warm", url });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const decision = decideUniversalLinkNavigation({
      pendingUrl: pending.url,
      isAuthenticated,
      sitemap,
      currentHref,
    });
    if (decision.action === "wait") return;

    // From here the link is being consumed (navigated, skipped, or rejected);
    // clear it so it can't re-fire and so a superseding warm link is respected.
    dispatch({ type: "consume" });
    if (decision.action === "reject") {
      console.warn(`[universal-links] ignoring "${pending.url}": ${decision.reason}`);
      return;
    }
    if (decision.action === "navigate") {
      router.push(decision.route as never);
    }
    // "skip": already on the resolved route — nothing to do.
  }, [pending.url, isAuthenticated, sitemap, currentHref, router]);
}
