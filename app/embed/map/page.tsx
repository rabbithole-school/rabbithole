"use client";

/**
 * The SCOPED web canvas for the scholar's knowledge Tree — the audience/
 * redaction view-model + the paper-plane canvas with mastery dials and glowing
 * frontier lines, with no site nav and no app chrome.
 *
 * NO LONGER EMBEDDED BY NATIVE. This route was built as a first-class native
 * surface: the Sky screen's TREE toggle hosted it in a `react-native-webview`
 * via `MapTreeWebView`, so the real web Tree shipped to iPad verbatim. That
 * component is gone — native tree mode is now the fully-native `TreeMapNative`
 * (native/src/components/tree/TreeMapNative.tsx), and the helper that built this
 * URL (`mapEmbedUrl`) was deleted with it. The route SURVIVES for its other
 * audience: it still renders standalone in a plain browser tab (when that tab
 * already has a Convex Auth session), which is why it was kept rather than
 * deleted alongside the native path.
 *
 * The Tree is pinned to TREE mode with the tree⟷sky toggle hidden (`<Map
 * mode="tree" showToggle={false} fill />`) — the native pill owns the mode, this
 * page just renders the one skin full-bleed.
 *
 * Auth: the WebView carries no Convex Auth session of its own (native's session
 * lives in AsyncStorage, not a shared cookie). The PROD handoff is a one-shot
 * embed token: the native host mints it for its OWN identity
 * (`api.embedAuth.issueEmbedToken`) and passes it in the URL FRAGMENT (`#et=...`).
 * We read it CLIENT-SIDE only (a fragment never reaches the server / its logs),
 * strip it from the URL immediately, and redeem it via `signIn("embedToken",
 * { token })` before rendering — which mints this page's own session. Identity
 * is NOT taken from the URL: once signed in we resolve the scholar from
 * `users.currentUser` and pass their own id to <Map audience="scholar">, so the
 * teacher-or-self gate on `treeForScholar` always sees self (no spoofable arg).
 * On sign-in failure we show a plain, kid-safe message and do NOT retry-loop (a
 * burnt/expired one-shot token can never succeed on retry). See
 * convex/embedAuth.ts + app/embed/manipulative/page.tsx.
 */

import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Box, Center, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { Map } from "@/components/Map";

// The tree's concept/domain labels render at a FIXED on-screen size (a
// screen-space overlay, deliberately constant so labels don't balloon under the
// camera's pinch-zoom). On iPad that fixed size reads too small. We enlarge just
// the LABEL TEXT — a plain CSS font-size bump (px), which WKWebView renders
// reliably — via a `labelScale` prop threaded Map → MapTreeView → MapTreeCanvas.
// This is native-embed-only: the prop defaults to 1 everywhere else, so the
// desktop web tree is unchanged. (A CSS `zoom` wrapper was tried and removed:
// it scaled the dots/lines but NOT the fixed-size label overlay.) Single named
// constant so it's trivially tunable.
const TREE_LABEL_SCALE = 1.6;

// Read the one-shot embed token from the URL FRAGMENT (never the query string,
// so it can't reach server logs / the referer). Matches `#et=...` or
// `#...&et=...`. Returns null when absent.
function readEmbedTokenFromHash(hash: string): string | null {
  const match = /(?:^#|[#&])et=([^&]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
}

function MapEmbed() {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { signIn } = useAuthActions();

  // Embed-token handoff state. Initialize to "pending" synchronously when a
  // token is present in the fragment, so we render a spinner (not the signed-out
  // message) from the very first paint — no flash before the sign-in effect
  // runs. "idle" = no handoff in flight (standalone tab or already redeemed);
  // "error" = the one-shot token couldn't be redeemed.
  const [handoff, setHandoff] = useState<"idle" | "pending" | "error">(() =>
    typeof window !== "undefined" && readEmbedTokenFromHash(window.location.hash)
      ? "pending"
      : "idle",
  );
  const handoffStarted = useRef(false);

  useEffect(() => {
    if (handoffStarted.current) return;
    const token =
      typeof window !== "undefined"
        ? readEmbedTokenFromHash(window.location.hash)
        : null;
    if (!token) return;
    handoffStarted.current = true;
    // Strip the token from the visible URL immediately — it must not be
    // re-readable, bookmarkable, or survive a reload/back. `handoff` is already
    // "pending" from the lazy initializer, so the sign-in just resolves it to
    // "idle" (success) or "error".
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
    // @convex-dev/auth's `signIn` does NOT reject on a failed credential — a
    // burnt/expired/garbage embed token resolves with `{ signingIn: false }`
    // (never a throw). So inspect the result: `signingIn === true` means a
    // session was minted (→ "idle"); `false` means the one-shot token couldn't
    // be redeemed (→ the kid-safe "error"). The `.catch` covers genuine network
    // failures.
    void signIn("embedToken", { token })
      .then((result) => setHandoff(result.signingIn ? "idle" : "error"))
      .catch(() => setHandoff("error"));
  }, [signIn]);

  const me = useQuery(api.users.currentUser, isAuthenticated ? {} : "skip");

  if (handoff === "error") {
    return (
      <Center h="100dvh" p={6} bg="#0d0f22">
        <Text color="#cdbef2" textAlign="center">
          We couldn&apos;t open your map. Head back and tap Tree again to try once
          more.
        </Text>
      </Center>
    );
  }
  if (handoff === "pending" || authLoading || (isAuthenticated && me === undefined)) {
    return (
      <Center h="100dvh" bg="#0d0f22">
        <Spinner color="violet.400" />
      </Center>
    );
  }
  if (!isAuthenticated) {
    return (
      <Center h="100dvh" p={6} bg="#0d0f22">
        <Text color="#cdbef2" textAlign="center">
          Open your map from the Rabbithole app, or sign in to this browser tab
          first.
        </Text>
      </Center>
    );
  }
  if (!me) {
    return (
      <Center h="100dvh" p={6} bg="#0d0f22">
        <Text color="#cdbef2" textAlign="center">
          We couldn&apos;t find your account.
        </Text>
      </Center>
    );
  }

  // Full-bleed Map, clipped to the viewport (no scrollbars). `labelScale` bumps
  // only the tree's label TEXT for iPad legibility; everything else renders at 1x.
  return (
    <Box h="100dvh" w="100dvw" overflow="hidden" bg="#0d0f22">
      <Map scholarId={me._id} audience="scholar" mode="tree" showToggle={false} fill labelScale={TREE_LABEL_SCALE} />
    </Box>
  );
}

export default function MapEmbedPage() {
  return (
    <Box h="100dvh" w="100dvw" overflow="hidden" bg="#0d0f22">
      <MapEmbed />
    </Box>
  );
}
