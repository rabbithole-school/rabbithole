"use client";

// DEV-ONLY auth handoff + a self-describing index.
//
//   /dev-login                  → lists the users you can sign in as (this
//                                 deployment's actual devLogin-able users)
//   /dev-login?u=<username>&to=  → signs in as <username> (no password / no
//                                 passkey) and drops you on <path> (default
//                                 /teacher). Signs out any current session
//                                 first; open in incognito to avoid disturbing
//                                 your real session.
//
// The list is queried at runtime (users.listDevLoginUsers) — never a hardcoded
// roster — so it can't drift from what's actually seeded. A bad/unknown `?u=`
// fails LOUDLY (with the real list to pick from) instead of hanging.
//
// SAFETY: inert in production three ways — (1) the secret comes from
// NEXT_PUBLIC_DEV_LOGIN_SECRET, only set in local development configuration; (2) the
// `devLogin` provider + `listDevLoginUsers` refuse on the prod deployment +
// require DEV_TEST_LOGIN_SECRET (never set on prod); (3) this page shows
// "unavailable" without a secret.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { clearCachedQueries } from "@/hooks/useCachedQuery";
import { Box, Button, Flex, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";

const DEV_SECRET = process.env.NEXT_PUBLIC_DEV_LOGIN_SECRET;

// How long to wait before assuming sign-in has stalled and offering a retry.
// This is purely a UX fallback for a cold-start dev server still compiling the
// destination route — generous so a slow first compile doesn't look like a
// failure.
const STALL_TIMEOUT_MS = 30_000;

type DevUser = { username: string; name: string | null; role: string };

// Where each role should land after signing in.
const ROLE_HOME: Record<string, string> = {
  platform_admin: "/teacher",
  school_admin: "/teacher",
  teacher: "/teacher",
  curriculum_designer: "/teacher",
  staff: "/teacher",
  parent: "/parent",
  scholar: "/scholar",
};
const ROLE_ORDER = ["platform_admin", "school_admin", "teacher", "curriculum_designer", "staff", "parent", "scholar"];
const ROLE_LABEL: Record<string, string> = {
  staff: "Staff",
};
const homeFor = (role: string) => ROLE_HOME[role] ?? "/scholar";
// Display rank for grouping; unknown roles sort last.
const roleRank = (role: string) => {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
};

// Open-redirect guard: same-origin relative paths only. Rejects `//evil` and
// `/\evil` (browsers normalize `\`→`/`, so both become protocol-relative).
// First strip ASCII tab/newline/CR, which the WHATWG URL parser silently
// removes from anywhere in the input — without this, `/\t//evil.com` slips past
// the regex yet resolves cross-origin once handed to window.location.replace.
const safeTo = (raw: string) => {
  const s = raw.replace(/[\t\n\r]/g, "");
  return s === "/" || /^\/[^/\\]/.test(s) ? s : "/teacher";
};

/** Clickable list of users, grouped by role. Powers the index + error views. */
function UserPicker({ users }: { users: DevUser[] }) {
  const byRole = useMemo(() => {
    const m = new Map<string, DevUser[]>();
    for (const u of users) {
      const groupRole = u.role;
      const arr = m.get(groupRole) ?? [];
      arr.push(u);
      m.set(groupRole, arr);
    }
    return m;
  }, [users]);

  const roles = [...byRole.keys()].sort((a, b) => roleRank(a) - roleRank(b));

  if (users.length === 0) {
    return (
      <Text fontFamily="body" fontSize="sm" color="charcoal.400">
        No users with a username on this deployment. Run <code>pnpm db:seed</code>.
      </Text>
    );
  }

  return (
    <VStack align="stretch" gap={4} w="full">
      {roles.map((role) => (
        <Box key={role}>
          <Text
            fontFamily="heading"
            fontSize="2xs"
            fontWeight="700"
            color="violet.600"
            textTransform="uppercase"
            letterSpacing="0.06em"
            mb={1.5}
          >
            {ROLE_LABEL[role] ?? role.replace(/_/g, " ")}
          </Text>
          <VStack align="stretch" gap={1.5}>
            {byRole.get(role)!.map((u) => (
              // Plain <a>, NOT next/link: the sign-in flow runs in mount
              // effects with run-once refs, so picking a user must load a
              // fresh document. Client-side nav to the same route keeps the
              // stale component (and its stalled/started state) mounted —
              // the retry would silently do nothing.
              <a
                key={u.username}
                href={`/dev-login?u=${encodeURIComponent(u.username)}&to=${encodeURIComponent(homeFor(u.role))}`}
                style={{ textDecoration: "none" }}
                aria-label={`Dev login as ${u.username}`}
              >
                <HStack
                  justify="space-between"
                  px={3}
                  py={2}
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="lg"
                  bg="white"
                  _hover={{ borderColor: "violet.300", bg: "violet.50" }}
                >
                  <Text fontFamily="body" fontSize="sm" color="charcoal.600">
                    {u.name ?? u.username}
                  </Text>
                  <Text fontFamily="mono" fontSize="xs" color="charcoal.400">
                    @{u.username}
                  </Text>
                </HStack>
              </a>
            ))}
          </VStack>
        </Box>
      ))}
    </VStack>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  // The app shell locks body scrolling (globals.css: html/body overflow:hidden),
  // so this page must be its own scroll container. Centering comes from auto
  // margins on the child, not align/justify on the Flex — auto margins collapse
  // to 0 when the user list overflows, keeping the top reachable while scrolling.
  return (
    <Flex h="100dvh" bg="gray.50" overflowY="auto" p={6}>
      <VStack gap={5} maxW="420px" w="full" textAlign="center" m="auto">
        <Text fontFamily="heading" fontSize="xl" fontWeight="700" color="navy.500">
          {title}
        </Text>
        {children}
      </VStack>
    </Flex>
  );
}

function DevLogin() {
  const params = useSearchParams();
  const router = useRouter();
  const { signIn, signOut } = useAuthActions();
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const { user, isLoading: userLoading } = useCurrentUser();

  const username = params.get("u") ?? "";
  const to = safeTo(params.get("to") ?? "/teacher");
  const secret = DEV_SECRET ?? "";

  const users = useQuery(api.users.listDevLoginUsers, secret ? { secret } : "skip");
  const known = users === undefined ? undefined : users.some((u) => u.username === username);

  const [status, setStatus] = useState("Starting…");
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  // Phase 1 has fully settled on the requested user — the gate Phase 2 waits on.
  const [signedIn, setSignedIn] = useState(false);
  const started = useRef(false);
  const redirected = useRef(false);

  // Phase 1: establish the requested session. Waits until the username is
  // confirmed real on THIS deployment (never hang on a phantom user) AND auth
  // has definitively settled (authLoading/userLoading false) — so we can tell
  // whether a prior session actually needs replacing.
  useEffect(() => {
    if (started.current || authLoading || userLoading) return;
    if (!username || !secret) return; // index / unavailable handled in render
    if (known === undefined) return; // wait for the user list
    if (known === false) return; // bad-username error handled in render
    started.current = true;
    void (async () => {
      try {
        // Already signed in as exactly this user (e.g. clicking a dev-login
        // deep link in a tab that's already this user): skip the
        // sign-out→sign-in churn entirely. Re-authing here would briefly drop
        // the token, letting the destination's own mount-redirects fire
        // against a signed-out app and clobber the requested `to`.
        if (!(isAuthenticated && user?.username === username)) {
          if (isAuthenticated) {
            setStatus("Signing out the current session…");
            await signOut();
          }
          // Switching users: drop perceived-speed snapshots so the previous
          // user's cached data can't flash for the next one (useSignOut does
          // this on the normal sign-out path; dev-login bypasses it).
          clearCachedQueries();
          setStatus(`Signing in as ${username}…`);
          await signIn("devLogin", { username, secret });
        }
        setSignedIn(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [authLoading, userLoading, isAuthenticated, user, username, secret, known, signIn, signOut]);

  // Safety net: if sign-in started but we never land (auth stuck), surface it
  // instead of spinning forever.
  useEffect(() => {
    if (known !== true) return;
    const t = setTimeout(() => {
      if (!redirected.current) setStalled(true);
    }, STALL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [known]);

  // Phase 2: hand off only once Phase 1 has fully settled AND auth is the
  // REQUESTED user (so the destination loads already-authenticated — no query
  // racing auth into an ErrorBoundary). This gate (signedIn + auth settled to
  // the requested user) is what guarantees the destination mounts with the
  // right session, so a CLIENT navigation (router.replace) is safe — downstream
  // mount-redirects see the correct auth and can't clobber `to`. We use
  // router.replace rather than a full-document `window.location.replace`
  // specifically to AVOID the browser's "Leave site? Changes you made may not
  // be saved." prompt: a full-document unload runs @convex-dev/auth's and the
  // Convex client's `beforeunload` handlers (token refresh / in-flight
  // requests), which trip that dialog. The `redirected` ref (never reset) fires
  // it exactly once.
  useEffect(() => {
    if (redirected.current || error) return;
    if (!signedIn || authLoading || userLoading) return;
    if (isAuthenticated && user && user.username === username) {
      redirected.current = true;
      router.replace(to);
    }
  }, [signedIn, authLoading, userLoading, isAuthenticated, user, username, error, to, router]);

  // ── Render states ──────────────────────────────────────────────────────
  if (!secret) {
    return (
      <Shell title="dev-login unavailable">
        <Text fontFamily="body" fontSize="sm" color="charcoal.500">
          This page only works on a dev deployment (NEXT_PUBLIC_DEV_LOGIN_SECRET
          unset). Configure a development login secret.
        </Text>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell title="dev-login failed">
        <Text fontFamily="body" fontSize="sm" color="red.500">{error}</Text>
        {users && <UserPicker users={users} />}
      </Shell>
    );
  }

  // Index: no ?u= → show who you can sign in as.
  if (!username) {
    return (
      <Shell title="Dev login">
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Sign in as any user on this dev deployment — no password, no passkey.
        </Text>
        {users === undefined ? <Spinner color="violet.500" /> : <UserPicker users={users} />}
      </Shell>
    );
  }

  // Bad username → fail loudly with the real list (this is the whole point).
  if (known === false) {
    return (
      <Shell title="No such dev user">
        <Text fontFamily="body" fontSize="sm" color="charcoal.500">
          There&apos;s no user <strong>@{username}</strong> on this deployment.
          The seed may be stale (<code>pnpm db:seed</code>). Pick one that exists:
        </Text>
        {users && <UserPicker users={users} />}
      </Shell>
    );
  }

  if (stalled) {
    return (
      <Shell title="Sign-in didn’t complete">
        <Text fontFamily="body" fontSize="sm" color="charcoal.500">
          Signing in as <strong>@{username}</strong> stalled — usually the dev
          server compiling on a cold start. Try again, or pick another user:
        </Text>
        <Button
          size="sm"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          // Full reload: the sign-in runs in mount effects, so retrying
          // requires a fresh document, not client-side nav.
          onClick={() => window.location.reload()}
        >
          Try again as @{username}
        </Button>
        {users && <UserPicker users={users} />}
      </Shell>
    );
  }

  // Working: signing in.
  return (
    <Shell title="Dev login">
      <Spinner color="violet.500" size="lg" />
      <Text fontFamily="body" fontSize="sm" color="charcoal.500">{status}</Text>
    </Shell>
  );
}

export default function DevLoginPage() {
  return (
    <Suspense>
      <DevLogin />
    </Suspense>
  );
}
