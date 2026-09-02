"use client";

/**
 * Lane 3 — the SCOPED web canvas for a manipulative rendered as a first-class
 * native practice item (review/native-manipulative-plan). Loads ONLY the one
 * manipulative for `?itemId=` — no site nav, no session chrome — so a native
 * `react-native-webview` host (the reusable host from PR #435) can embed it
 * inline inside native practice UI. Also renders standalone in a plain
 * browser tab (this route needs no auth — see `getManipulativeItem`).
 *
 * Grading happens HERE (reusing lane 2's grade path, `submitAnswer`) rather
 * than being forwarded to native to call. Once graded, the page posts the
 * SERVER verdict up as `RH_MANIPULATIVE_DONE` (`solved` = the real grade, not
 * just the optimistic self-check) so the native host has nothing left to
 * compute — it only reflects the message into practice chrome.
 *
 * Auth: the WebView carries no Convex Auth session of its own (native's own
 * session lives in AsyncStorage, not a shared cookie). The PROD handoff is a
 * one-shot embed token: the native host mints it for its OWN identity
 * (`api.embedAuth.issueEmbedToken`) and passes it in the URL FRAGMENT
 * (`#et=...`). We read it CLIENT-SIDE only (a fragment never reaches the
 * server / its logs), strip it from the URL immediately, and redeem it via
 * `signIn("embedToken", { token })` before rendering — which mints this
 * page's own session so it can call the `authedMutation` grader. This
 * replaces the dev-only `/dev-login` redirect. If a browser tab already has a
 * session (standalone use), that works too and no token is needed. On sign-in
 * failure we show a plain, kid-safe message and do NOT retry-loop (a burnt or
 * expired one-shot token can never succeed on retry). See convex/embedAuth.ts.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Box, Center, Spinner, Text, VStack } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { Manipulative } from "@/components/manipulative/Manipulative";
import { parseManipulativeSpec } from "@/lib/manipulative/grade";
import {
  computeTiming,
  payloadClientEventReceipt,
  type PayloadClientEventReceipt,
} from "@/shared/practiceLoop";
import {
  RH_MANIPULATIVE_DONE,
  type ManipulativeDoneMessage,
} from "@/lib/manipulative/practiceContract";

// Posts to whichever host is listening — the RN WebView bridge
// (`window.ReactNativeWebView`, injected by react-native-webview) when
// embedded natively, or the parent frame for a browser-preview iframe. Always
// logs too, so a bare standalone tab (no listener at all) still lets you
// verify the message fired.
function postDone(msg: ManipulativeDoneMessage) {
  console.log("[embed/manipulative] posting", msg);
  const rn = (window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } })
    .ReactNativeWebView;
  if (rn) {
    rn.postMessage(JSON.stringify(msg));
    return;
  }
  if (window.parent !== window) {
    window.parent.postMessage(msg, "*");
  }
}

// Read the one-shot embed token from the URL FRAGMENT (never the query string,
// so it can't reach server logs / the referer). Matches `#et=...` or
// `#...&et=...`. Returns null when absent.
function readEmbedTokenFromHash(hash: string): string | null {
  const match = /(?:^#|[#&])et=([^&]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
}

function ManipulativeEmbed() {
  const params = useSearchParams();
  const itemId = params.get("itemId");
  const scholarId = params.get("scholarId"); // required by submitAnswer's args
  const [done, setDone] = useState<{ solved: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { signIn } = useAuthActions();

  // Embed-token handoff state. Initialize to "pending" synchronously when a
  // token is present in the fragment, so we render a spinner (not the
  // signed-out message) from the very first paint — no flash before the
  // sign-in effect runs. "idle" = no handoff in flight (standalone tab or
  // already redeemed); "error" = the one-shot token couldn't be redeemed.
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
    // re-readable, bookmarkable, or survive a reload/back. `handoff` is
    // already "pending" from the lazy initializer (a token was in the hash),
    // so the sign-in just resolves it to "idle" (success) or "error".
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
    // @convex-dev/auth's `signIn` does NOT reject on a failed credential — a
    // burnt/expired/garbage embed token resolves `auth:signIn` with null tokens,
    // which the client surfaces as `{ signingIn: false }` (never a throw). So we
    // must inspect the result, not rely on `.catch`: `signingIn === true` means
    // a session was minted (success → "idle"); `false` means the one-shot token
    // couldn't be redeemed (→ the kid-safe "error" copy). The `.catch` still
    // covers genuine network failures.
    void signIn("embedToken", { token })
      .then((result) => setHandoff(result.signingIn ? "idle" : "error"))
      .catch(() => setHandoff("error"));
  }, [signIn]);

  const item = useQuery(api.practiceSkills.getManipulativeItem, itemId ? { itemId } : "skip");
  const submitAnswer = useMutation(api.practiceSkills.submitAnswer);

  const spec = useMemo(
    () => (item?.manipulativeSpec ? parseManipulativeSpec(item.manipulativeSpec) : null),
    [item],
  );
  const itemRenderAtRef = useRef<number | null>(null);
  const clientEventReceiptRef = useRef<PayloadClientEventReceipt | null>(null);

  useEffect(() => {
    if (spec && itemRenderAtRef.current === null) {
      itemRenderAtRef.current = Date.now();
    }
  }, [spec]);

  const onCommit = useCallback(
    async (stateJson: string) => {
      if (!itemId || !scholarId) {
        setError("Missing itemId/scholarId — can't grade.");
        return;
      }
      try {
        const timing =
          itemRenderAtRef.current === null
            ? {}
            : computeTiming({
                firstAttempt: true,
                nowMs: Date.now(),
                renderAtMs: itemRenderAtRef.current,
                firstKeyAtMs: null,
              });
        const payloadKey = JSON.stringify({ itemId, answer: stateJson });
        const receipt = payloadClientEventReceipt(
          clientEventReceiptRef.current,
          payloadKey,
          "practice-answer",
        );
        clientEventReceiptRef.current = receipt;
        const result = await submitAnswer({
          scholarId: scholarId as Parameters<typeof submitAnswer>[0]["scholarId"],
          itemId,
          answer: stateJson,
          clientEventId: receipt.clientEventId,
          ...timing,
        });
        clientEventReceiptRef.current = null;
        const solved = result.correct;
        setDone({ solved });
        postDone({ type: RH_MANIPULATIVE_DONE, itemId, solved, stateJson });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Grading failed.");
      }
    },
    [itemId, scholarId, submitAnswer],
  );

  if (!itemId) {
    return (
      <Center h="100dvh">
        <Text color="fg.muted">Missing ?itemId=.</Text>
      </Center>
    );
  }
  if (handoff === "error") {
    return (
      <Center h="100dvh" p={6}>
        <Text color="fg.muted" textAlign="center">
          We couldn&apos;t open this activity. Head back and tap it again to try
          once more.
        </Text>
      </Center>
    );
  }
  if (handoff === "pending" || authLoading || item === undefined) {
    return (
      <Center h="100dvh">
        <Spinner />
      </Center>
    );
  }
  if (!isAuthenticated) {
    return (
      <Center h="100dvh" p={6}>
        <Text color="fg.muted" textAlign="center">
          Open this activity from the Rabbithole app, or sign in to this browser
          tab first.
        </Text>
      </Center>
    );
  }
  if (!item || !spec) {
    return (
      <Center h="100dvh">
        <Text color="fg.muted">This manipulative item couldn&apos;t be found.</Text>
      </Center>
    );
  }

  return (
    <Center h="100dvh" bg="bg.subtle" p={{ base: 3, md: 6 }}>
      <VStack gap={3}>
        <Manipulative spec={spec} onCommit={onCommit} />
        {error && (
          <Text fontSize="13px" color="red.600" fontWeight="600">
            {error}
          </Text>
        )}
        {done && (
          <Text
            fontSize="13px"
            fontWeight="700"
            color={done.solved ? "green.600" : "orange.600"}
          >
            {done.solved ? "Graded correct — posted to host." : "Graded incorrect — posted to host."}
          </Text>
        )}
      </VStack>
    </Center>
  );
}

export default function ManipulativeEmbedPage() {
  return (
    <Suspense
      fallback={
        <Center h="100dvh">
          <Spinner />
        </Center>
      }
    >
      <Box h="100dvh" overflow="hidden">
        <ManipulativeEmbed />
      </Box>
    </Suspense>
  );
}
