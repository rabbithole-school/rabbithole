export type ManagedClaimReconcileAction =
  | "none"
  | "exchange"
  | "clear-and-exchange";

/**
 * Who the delivered claim belongs to, as resolved by the server BEFORE the
 * exchange. `unknown` covers "we could not ask" (offline, query failed) and is
 * deliberately treated as the conservative case: never strand a device on an
 * unproven suspicion of reassignment.
 */
export type ManagedClaimSubject = "self" | "other" | "unknown";

export type ManagedClaimReconcileInput = {
  claimToken: string | null;
  isAuthenticated: boolean;
  lastExchangedClaimToken: string | null;
  sessionInvalidated?: boolean;
  /** Who the server says the delivered claim names. Only consulted while a live
   *  session is being replaced; see decideManagedClaimAction. */
  subject?: ManagedClaimSubject;
};

export type ManagedClaimReconcileResult = {
  action: ManagedClaimReconcileAction;
  didExchange: boolean;
  showFallback: boolean;
  error?: unknown;
};

export type ManagedClaimReconcileEffects = {
  clearSession: () => Promise<void>;
  exchange: () => Promise<void>;
  attachSession?: () => Promise<void>;
  onAttachError?: (error: unknown) => void;
  rememberExchange: () => Promise<void>;
};

export type ManagedClaimAttemptState = {
  failedClaimToken: string | null;
  /** When the latch was set, so it can expire on its own. */
  failedAt?: number;
};

/**
 * How long a failed exchange stays latched. The latch exists to stop a hot
 * retry loop against a claim the server keeps rejecting; it must NOT be
 * permanent, or one transient network error during a hand-over strands the iPad
 * on the fallback notice until somebody relaunches the app. Expiring it bounds
 * retries to one a minute, which a poll interval measured in seconds cannot.
 */
export const MANAGED_CLAIM_RETRY_COOLDOWN_MS = 60_000;

/**
 * True when a live session is about to be replaced by a claim belonging to
 * somebody else — the classroom hand-over. Callers use this to show the
 * "Switching to <name>" screen instead of swapping identity under a child's
 * hands, and to decide the failure mode below.
 */
export function isManagedClaimHandover({
  claimToken,
  isAuthenticated,
  lastExchangedClaimToken,
  subject,
}: {
  claimToken: string | null;
  isAuthenticated: boolean;
  lastExchangedClaimToken: string | null;
  subject: ManagedClaimSubject;
}): boolean {
  if (!claimToken || !isAuthenticated) return false;
  if (claimToken === lastExchangedClaimToken) return false;
  return subject === "other";
}

export type ManagedClaimAttemptEvent =
  | { type: "exchange-failed"; claimToken: string; at?: number }
  | { type: "foreground" }
  | { type: "claim-removed" };

export function managedClaimAttemptReducer(
  state: ManagedClaimAttemptState,
  event: ManagedClaimAttemptEvent,
): ManagedClaimAttemptState {
  switch (event.type) {
    case "exchange-failed":
      return { failedClaimToken: event.claimToken, failedAt: event.at };
    case "foreground":
    case "claim-removed":
      return { failedClaimToken: null };
  }
}

export function isManagedClaimAttemptLatched(
  state: ManagedClaimAttemptState,
  claimToken: string,
  now: number = Date.now(),
): boolean {
  if (state.failedClaimToken !== claimToken) return false;
  if (state.failedAt === undefined) return true;
  return now - state.failedAt < MANAGED_CLAIM_RETRY_COOLDOWN_MS;
}

export function assertManagedClaimSignInStarted(result: {
  signingIn: boolean;
}): void {
  if (!result.signingIn) {
    throw new Error("Managed claim was rejected");
  }
}

export async function resolveManagedClaimAction({
  claimToken,
  isAuthenticated,
  sessionInvalidated = false,
  lastExchangedClaimToken,
  lastExchangedLoaded,
  loadLastExchangedClaimToken,
}: {
  claimToken: string | null;
  isAuthenticated: boolean;
  sessionInvalidated?: boolean;
  lastExchangedClaimToken: string | null;
  lastExchangedLoaded: boolean;
  loadLastExchangedClaimToken: () => Promise<string | null>;
}): Promise<{
  /**
   * Whether anything might need doing — the cheap gate that runs BEFORE we
   * spend a round-trip asking the server who the claim names.
   *
   * Deliberately not the final action: the final decision needs `subject`,
   * which is not known yet at this point. Returning an action here and
   * short-circuiting on "none" would defer every hand-over forever, because an
   * unattributed claim correctly decides "none" (see decideManagedClaimAction).
   */
  needsAttention: boolean;
  lastExchangedClaimToken: string | null;
}> {
  const restoredLastExchangedClaimToken = lastExchangedLoaded
    ? lastExchangedClaimToken
    : await loadLastExchangedClaimToken();
  return {
    needsAttention: managedClaimNeedsAttention({
      claimToken,
      isAuthenticated,
      lastExchangedClaimToken: restoredLastExchangedClaimToken,
      sessionInvalidated,
    }),
    lastExchangedClaimToken: restoredLastExchangedClaimToken,
  };
}

/**
 * "Is there anything here worth looking into?" — true when a claim is present
 * and either there is no session to serve it, the session was invalidated, or
 * the delivered token differs from the one this device last exchanged.
 */
export function managedClaimNeedsAttention({
  claimToken,
  isAuthenticated,
  lastExchangedClaimToken,
  sessionInvalidated = false,
}: ManagedClaimReconcileInput): boolean {
  if (!claimToken) return false;
  if (sessionInvalidated || !isAuthenticated) return true;
  return claimToken !== lastExchangedClaimToken;
}

export function decideManagedClaimAction({
  claimToken,
  isAuthenticated,
  lastExchangedClaimToken,
  sessionInvalidated = false,
  subject = "unknown",
}: ManagedClaimReconcileInput): ManagedClaimReconcileAction {
  if (!claimToken) return "none";
  if (sessionInvalidated) return "clear-and-exchange";
  if (!isAuthenticated) return "exchange";
  if (claimToken === lastExchangedClaimToken) return "none";
  // A hand-over MUST clear the session before exchanging, and not because it is
  // tidier: signing in over a live session does not actually change identity.
  // `@convex-dev/auth`'s setToken only calls its `onChange` hook — the thing
  // that re-authenticates the Convex WebSocket — when the *authenticated
  // boolean* flips. Signing in as a different user while already signed in
  // keeps it `true`, so the new JWT lands in storage while the open connection
  // keeps serving the PREVIOUS scholar until the app is relaunched. Verified on
  // a leased simulator 2026-08-19: the server exchanged the claim and minted
  // the new session, and the iPad still rendered the old scholar's home screen.
  // Clearing first crosses the boundary twice (true→false→true), which is what
  // makes the swap real.
  //
  // A same-scholar ROTATION deliberately stays a plain exchange: the identity
  // is already correct, so a stale connection is harmless, and not signing out
  // preserves the staged-replacement guarantee that a failed rotation can never
  // strand a working iPad.
  if (subject === "other") return "clear-and-exchange";
  if (subject === "self") return "exchange";

  // subject === "unknown" — we could not ask the server who this claim names.
  // DEFER rather than exchange, because a plain exchange here is a trap: it
  // succeeds server-side and persists the new token as `lastExchanged`, while
  // the live connection keeps serving the previous scholar (the onChange
  // boundary above). The delivered token then equals `lastExchanged` forever,
  // so every later reconcile returns "none" and the iPad serves the WRONG
  // scholar permanently — the exact defect this file exists to prevent, walked
  // in through a single failed query. Deferring costs one wake; the old claim
  // is still valid either way (a reassignment's old token is dead, and a
  // rotation's is kept alive by the staged-replacement guarantee).
  return "none";
}

export async function reconcileManagedClaim(
  input: ManagedClaimReconcileInput,
  effects: ManagedClaimReconcileEffects,
): Promise<ManagedClaimReconcileResult> {
  const action = decideManagedClaimAction(input);
  if (action === "none") {
    return { action, didExchange: false, showFallback: false };
  }

  try {
    if (action === "clear-and-exchange") {
      await effects.clearSession();
    }
    await effects.exchange();
    if (effects.attachSession) {
      try {
        await effects.attachSession();
      } catch (attachError) {
        effects.onAttachError?.(attachError);
      }
    }
    await effects.rememberExchange();
    return { action, didExchange: true, showFallback: false };
  } catch (error) {
    return { action, didExchange: false, showFallback: true, error };
  }
}
