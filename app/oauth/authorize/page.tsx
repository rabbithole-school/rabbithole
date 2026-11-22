"use client";

// The OAuth consent page for the MCP connector. Claude (or any MCP
// client) sends the user here with PKCE params after dynamic
// registration; the user signs in with their normal Rabbithole
// credentials (round-trip through /sign-in?next=…) and approves, and we
// redirect back to the client with a one-shot authorization code bound
// to THEIR userId (mcpOauth.approve). The code-for-token exchange then
// runs as that real user — role and guardianship scoping fall out of
// their identity, not out of anything granted here.

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useListAdmissionsTools } from "./useListAdmissionsTools";
import {
  Box,
  Button,
  Checkbox,
  Container,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { humanizeToolId } from "@/lib/toolLabels";
import {
  allowedScholarReadTools,
  type ScholarReadToolName,
} from "@/convex/lib/scholarReadPolicy";
import { ROLES, type Role } from "@/convex/lib/roles";
import { describeConsentAccess } from "./consentAccess";

const TOOL_LABELS: Record<ScholarReadToolName, string> = {
  list_scholars: "List scholars",
  get_scholar_dossier: "Read scholar learning profiles (dossiers)",
  get_scholar_mastery: "Read concept mastery",
  get_scholar_interests: "Read what a scholar is into (with how we know it)",
  get_scholar_signals: "Read learning signals (persistence, self-direction, …)",
  get_scholar_seeds: "Read suggested exploration topics",
  get_scholar_observations: "Read teacher observations",
  get_scholar_sessions: "List recent learning sessions",
  get_session_transcript: "Read a session's conversation transcript",
  get_scholar_web_activity: "Read external practice results",
  get_scholar_practice: "Read practice progress (skills, frontier)",
  get_scholar_math_checkin: "Read math check-in (placement) results",
  get_scholar_documents: "Read document summaries (assessments)",
  get_scholar_work_samples: "Read scanned work samples and their observations",
  get_school_calendar: "Read the school calendar (holidays and closures)",
};

const ROLE_SCOPE_NOTE: Partial<Record<Role, string>> = {
  teacher: "for any scholar",
  platform_admin: "for any scholar",
  school_admin: "for scholars in your institution",
  staff: "(roster only — no learning measurements)",
  parent: "for your linked children only",
  scholar: "for your own learning record only",
};

function AuthorizeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";
  const scope = params.get("scope") ?? undefined;
  const responseType = params.get("response_type") ?? "";
  // The RFC 8707 `resource` parameter is NOT read here, even when it names the
  // read-only connector (/api/mcp/read): the grant isn't bound to it, so the
  // token this page approves also works on the full connector. See
  // ./consentAccess.ts (TRA-635).

  const { user, isLoading: userLoading, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id;
  const { signOut } = useAuthActions();
  const client = useQuery(
    api.mcpOauth.getClient,
    clientId ? { clientId } : "skip",
  );
  const approve = useMutation(api.mcpOauth.approve);
  const mcpIdentity = useQuery(
    api.mcp.whoami,
    isAuthenticated ? {} : "skip",
  );
  // The same three list actions /api/mcp serves tools from, so this screen
  // names exactly what the token can call (TRA-646).
  const listCurriculumTools = useAction(api.mcp.listCurriculumTools);
  const listUnitDesignerTools = useAction(api.mcp.listUnitDesignerTools);
  const listAdmissionsTools = useListAdmissionsTools();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [curriculumToolNames, setCurriculumToolNames] = useState<string[] | null>(
    null,
  );
  const [unitDesignerToolNames, setUnitDesignerToolNames] = useState<
    string[] | null
  >(null);
  const [admissionsToolNames, setAdmissionsToolNames] = useState<
    string[] | null
  >(null);
  const [toolListError, setToolListError] = useState(false);
  // "Remember this connection" — on by default, so the common case (reconnect
  // without re-clicking) just works after the first approval.
  const [remember, setRemember] = useState(true);

  // Request validation. An invalid redirect_uri must error IN-PAGE — never
  // redirect to an unvalidated URI (RFC 6749 §4.1.2.1).
  const problem = useMemo(() => {
    if (!clientId) return "Missing client_id.";
    if (responseType !== "code") return "response_type must be \"code\".";
    if (!redirectUri) return "Missing redirect_uri.";
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return "PKCE (S256) is required.";
    }
    if (client === null) return "Unknown client — try reconnecting from your MCP app.";
    if (client && !client.redirectUris.includes(redirectUri)) {
      return "redirect_uri is not registered for this client.";
    }
    return null;
  }, [clientId, responseType, redirectUri, codeChallenge, codeChallengeMethod, client]);

  // Unauthenticated → round-trip through the normal sign-in page and come
  // back here with every OAuth param intact.
  //
  // Guard against a redirect LOOP: on a fresh page load the Convex auth client
  // can briefly report {loading:false, authenticated:false} while it restores
  // and validates the stored token. Redirecting in that transient window
  // bounces an already-signed-in user to /sign-in, which — seeing the restored
  // session — forwards them straight back here (AuthForm's next-param), and the
  // consent card never paints. So wait out a short grace period and only
  // redirect if we're STILL unauthenticated when it elapses. A genuinely
  // signed-out user just sees the "Loading…" spinner for that beat first; an
  // auth state that settles to authenticated cancels the redirect.
  useEffect(() => {
    if (userLoading || isAuthenticated || problem) return;
    const here = window.location.pathname + window.location.search;
    const t = setTimeout(() => {
      router.replace(`/sign-in?next=${encodeURIComponent(here)}`);
    }, 2000);
    return () => clearTimeout(t);
  }, [userLoading, isAuthenticated, problem, router]);

  const redirectBack = useCallback(
    (extra: Record<string, string>) => {
      const url = new URL(redirectUri);
      for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
      if (state) url.searchParams.set("state", state);
      window.location.href = url.toString();
    },
    [redirectUri, state],
  );

  const doApprove = useCallback(
    async (rememberThis: boolean): Promise<boolean> => {
      setBusy(true);
      setError("");
      try {
        const { code } = await approve({
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
          scope,
          remember: rememberThis,
        });
        redirectBack({ code });
        return true;
      } catch (err) {
        console.error("MCP consent approval failed:", err);
        setError("Something went wrong approving the connection. Try again.");
        setBusy(false);
        return false;
      }
    },
    [approve, clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, redirectBack],
  );

  // Remembered consent → skip the click. Auto-approve once when a prior
  // grant exists for this (user, client). Guarded so it fires a single time
  // (the redirect leaves the page anyway). If it FAILS, fall through to the
  // manual consent screen (with the error) rather than spinning forever.
  const hasConsent = useQuery(
    api.mcpOauth.hasConsent,
    isAuthenticated && clientId && !problem ? { clientId } : "skip",
  );
  useEffect(() => {
    if (!isAuthenticated || !currentUserId || problem) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the previous request's tool state before this authenticated request starts.
    setCurriculumToolNames(null);
    setUnitDesignerToolNames(null);
    setAdmissionsToolNames(null);
    setToolListError(false);
    void Promise.all([
      listCurriculumTools({}),
      listUnitDesignerTools({}),
      listAdmissionsTools({}),
    ])
      .then(([curriculum, unitDesigner, admissions]) => {
        if (cancelled) return;
        setCurriculumToolNames(curriculum.map((entry) => entry.name));
        setUnitDesignerToolNames(unitDesigner.map((entry) => entry.name));
        setAdmissionsToolNames(admissions.map((entry) => entry.name));
      })
      .catch((err) => {
        console.error("MCP tool list failed to load:", err);
        if (!cancelled) setToolListError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isAuthenticated,
    currentUserId,
    problem,
    listCurriculumTools,
    listUnitDesignerTools,
    listAdmissionsTools,
  ]);

  const autoApproved = useRef(false);
  const [autoApproveFailed, setAutoApproveFailed] = useState(false);
  useEffect(() => {
    if (
      !problem &&
      isAuthenticated &&
      hasConsent === true &&
      !autoApproved.current
    ) {
      autoApproved.current = true;
      void doApprove(true).then((ok) => {
        if (!ok) setAutoApproveFailed(true);
      });
    }
  }, [problem, isAuthenticated, hasConsent, doApprove]);

  const handleDeny = () => {
    redirectBack({ error: "access_denied" });
  };

  const clientName = client?.clientName || "An MCP client";
  const role = (user?.role ?? null) as Role | null;
  const tools = allowedScholarReadTools(role, {
    hasSchoolOperationsAccess: mcpIdentity?.schoolOperations === true,
  });
  const scopeNote =
    role === ROLES.STAFF
      ? mcpIdentity?.schoolOperations === true
        ? "(school operations only — no learning records)"
        : "(no scholar data)"
      : role
        ? ROLE_SCOPE_NOTE[role]
        : undefined;
  const { changeToolNames, changesUnknown, summary } = describeConsentAccess({
    role,
    readTools: tools,
    curriculumToolNames,
    unitDesignerToolNames,
    admissionsToolNames,
    toolListError,
    scopeNote,
  });
  const hasMutatingTool = changeToolNames.length > 0 || changesUnknown;

  if (problem) {
    return (
      <CenteredCard>
        <Heading size="lg">Can&apos;t connect</Heading>
        <Text color="fg.muted">{problem}</Text>
      </CenteredCard>
    );
  }

  if (userLoading || !isAuthenticated || !user || client === undefined) {
    return (
      <CenteredCard>
        <Spinner />
        <Text color="fg.muted">Loading…</Text>
      </CenteredCard>
    );
  }

  // Wait on the consent check before painting the screen: undefined = still
  // loading, true = remembered → auto-approving (don't flash the consent UI).
  // If the auto-approve failed, fall through to the manual screen below.
  // A FAILED tool list does not block: the fallback below over-warns rather
  // than under-warns, and a dead end here would strand the whole connect flow
  // on any transient socket blip (observed in dev).
  if (
    (curriculumToolNames === null && !toolListError) ||
    hasConsent === undefined ||
    (hasConsent === true && !autoApproveFailed)
  ) {
    return (
      <CenteredCard>
        <Spinner />
        <Text color="fg.muted">
          {hasConsent ? "Reconnecting…" : "Loading…"}
        </Text>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <Heading size="lg">Connect to Rabbithole</Heading>
      <Text>
        <Text as="span" fontWeight="semibold">{clientName}</Text> wants to
        connect to your Rabbithole account.
      </Text>

      <Box
        w="full"
        borderWidth="1px"
        borderColor="border"
        borderRadius="md"
        p={4}
      >
        <Text fontSize="sm" color="fg.muted" mb={1}>
          Connecting as
        </Text>
        <Text fontWeight="semibold">
          {user.name ?? user.username ?? "You"}
          {role ? ` — ${role.replace("_", " ")}` : ""}
        </Text>
      </Box>

      <Box w="full">
        <Text fontSize="sm" color="fg.muted" mb={2}>
          {summary}
        </Text>
        {tools.length > 0 && (
          <>
            {hasMutatingTool && (
              <Text fontSize="sm" fontWeight="semibold" mb={1}>
                Can read
              </Text>
            )}
            <VStack align="start" gap={1}>
              {tools.map((t) => (
                <Text key={t} fontSize="sm">
                  • {TOOL_LABELS[t]}
                </Text>
              ))}
            </VStack>
          </>
        )}
        {/* Naming every change tool rather than summarising them: a warning
            about permanent changes that lists only the READS leaves the
            reader unable to see what is actually at stake. The names are
            humanised from the tool ids so this list can never drift out of
            date the way a hand-kept label map would. */}
        {changesUnknown && (
          <Text fontSize="sm" mt={3}>
            It can also change your data. Rabbithole couldn&apos;t list exactly
            which actions just now, so reload if you want to see them before
            you connect.
          </Text>
        )}
        {changeToolNames.length > 0 && (
          <Box mt={3}>
            <Text fontSize="sm" fontWeight="semibold" mb={1}>
              Can also change ({changeToolNames.length})
            </Text>
            <VStack
              align="start"
              gap={1}
              maxH="12rem"
              overflowY="auto"
              w="full"
            >
              {changeToolNames.map((t) => (
                <Text key={t} fontSize="sm">
                  • {humanizeToolId(t)}
                </Text>
              ))}
            </VStack>
          </Box>
        )}
      </Box>

      {error && (
        <Text color="red.500" fontSize="sm">
          {error}
        </Text>
      )}

      <Checkbox.Root
        checked={remember}
        onCheckedChange={(d) => setRemember(!!d.checked)}
        colorPalette="violet"
        size="sm"
      >
        <Checkbox.HiddenInput />
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        <Checkbox.Label fontSize="sm" color="fg.muted">
          Remember this connection (don&apos;t ask again)
        </Checkbox.Label>
      </Checkbox.Root>

      <HStack w="full" gap={3}>
        <Button
          flex={1}
          colorPalette="violet"
          onClick={() => void doApprove(remember)}
          loading={busy}
        >
          Approve
        </Button>
        <Button flex={1} variant="outline" onClick={handleDeny} disabled={busy}>
          Deny
        </Button>
      </HStack>

      <Button
        variant="plain"
        size="sm"
        color="fg.muted"
        onClick={() => {
          void signOut().then(() => window.location.reload());
        }}
      >
        Not you? Switch account
      </Button>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  // globals.css locks html/body to overflow:hidden for the app shell, so a
  // standalone page must own its scroll container (same as /dev-login).
  return (
    <Box h="100dvh" overflowY="auto">
      <Container maxW="md" py={16}>
        <VStack
          gap={5}
          align="start"
          borderWidth="1px"
          borderColor="border"
          borderRadius="lg"
          p={8}
        >
          {children}
        </VStack>
      </Container>
    </Box>
  );
}

export default function AuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeInner />
    </Suspense>
  );
}
