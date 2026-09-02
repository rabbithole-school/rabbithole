import { useCallback, useEffect, useRef, useState } from "react";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex, useMutation } from "convex/react";
import { AppState } from "react-native";

import { api } from "@/lib/convex";
import {
  assertManagedClaimSignInStarted,
  isManagedClaimAttemptLatched,
  isManagedClaimHandover,
  managedClaimAttemptReducer,
  reconcileManagedClaim,
  resolveManagedClaimAction,
  type ManagedClaimAttemptState,
  type ManagedClaimSubject,
} from "@/lib/managedClaimReconcile";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import {
  isManagedClaimSuppressed,
  readManagedClaim,
} from "@/lib/managedClaim";

const LAST_EXCHANGED_CLAIM_KEY =
  "rabbithole.managedClaim.lastExchangedToken";
const SIGNED_OUT_RECONCILE_INTERVAL_MS = 5_000;

type BootstrapPhase =
  | "idle"
  | "checking"
  | "exchanging"
  | "switching"
  | "failed";

export function useManagedClaimBootstrap({
  isAuthenticated,
  isAuthLoading,
}: {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
}) {
  const [initialHasManagedClaim] = useState(
    () => readManagedClaim() !== null,
  );
  const [phase, setPhase] = useState<BootstrapPhase>(
    initialHasManagedClaim ? "checking" : "idle",
  );
  const [hasManagedClaim, setHasManagedClaim] = useState(
    initialHasManagedClaim,
  );

  const [switchingToName, setSwitchingToName] = useState<string | null>(null);

  const { signIn, signOut } = useAuthActions();
  const convex = useConvex();
  const attachDeviceSession = useMutation(
    api.devicePairing.attachDeviceSession,
  );

  const authRef = useRef(isAuthenticated);
  const authLoadingRef = useRef(isAuthLoading);
  useEffect(() => {
    authRef.current = isAuthenticated;
    authLoadingRef.current = isAuthLoading;
  }, [isAuthenticated, isAuthLoading]);

  const lastExchangedRef = useRef<string | null>(null);
  const lastExchangedLoadedRef = useRef(false);
  const attemptStateRef = useRef<ManagedClaimAttemptState>({
    failedClaimToken: null,
  });
  const expectedAuthDropRef = useRef(false);
  const wasAuthenticatedRef = useRef<boolean | null>(null);
  const runningRef = useRef(false);
  const pendingRef = useRef(false);
  const pendingInvalidationRef = useRef(false);
  const attachingSessionRef = useRef(false);
  const mountedRef = useRef(true);

  const attachManagedDeviceSession = useCallback(async () => {
    if (
      attachingSessionRef.current ||
      !authRef.current ||
      readManagedClaim() === null
    ) {
      return;
    }
    attachingSessionRef.current = true;
    try {
      const deviceId = await getStableDeviceId();
      const result = await attachDeviceSession({ deviceId });
      if (!result.attached) {
        console.warn("[managedClaim] device session binding was not found");
      }
    } catch (error) {
      console.warn("[managedClaim] failed to attach device session", error);
    } finally {
      attachingSessionRef.current = false;
    }
  }, [attachDeviceSession]);

  const requestReconcile = useCallback(
    async (sessionInvalidated = false) => {
      if (authLoadingRef.current) return;
      if (runningRef.current) {
        pendingRef.current = true;
        pendingInvalidationRef.current =
          pendingInvalidationRef.current || sessionInvalidated;
        return;
      }

      runningRef.current = true;
      let nextInvalidated = sessionInvalidated;
      const takePendingRequest = () => {
        const hasPendingRequest =
          pendingRef.current || pendingInvalidationRef.current;
        nextInvalidated = pendingInvalidationRef.current;
        return hasPendingRequest;
      };
      try {
        do {
          pendingRef.current = false;
          pendingInvalidationRef.current = false;

          const claim = readManagedClaim();
          if (mountedRef.current) setHasManagedClaim(claim !== null);
          if (!claim) {
            attemptStateRef.current = managedClaimAttemptReducer(
              attemptStateRef.current,
              { type: "claim-removed" },
            );
            if (mountedRef.current) setPhase("idle");
            continue;
          }
          if (await isManagedClaimSuppressed(claim.claimToken)) {
            if (mountedRef.current) {
              setHasManagedClaim(false);
              setPhase("idle");
            }
            continue;
          }

          if (
            isManagedClaimAttemptLatched(
              attemptStateRef.current,
              claim.claimToken,
            ) &&
            !nextInvalidated
          ) {
            if (mountedRef.current) {
              setPhase(authRef.current ? "idle" : "failed");
            }
            continue;
          }

          if (mountedRef.current) setPhase("checking");
          const resolved = await resolveManagedClaimAction({
            claimToken: claim.claimToken,
            isAuthenticated: authRef.current,
            sessionInvalidated: nextInvalidated,
            lastExchangedClaimToken: lastExchangedRef.current,
            lastExchangedLoaded: lastExchangedLoadedRef.current,
            loadLastExchangedClaimToken: () =>
              SecureStore.getItemAsync(LAST_EXCHANGED_CLAIM_KEY),
          });
          lastExchangedRef.current = resolved.lastExchangedClaimToken;
          lastExchangedLoadedRef.current = true;

          if (!resolved.needsAttention) {
            if (mountedRef.current) setPhase("idle");
            continue;
          }

          // The token is opaque to the device, so only the server can tell a
          // same-scholar ROTATION from a hand-over to a DIFFERENT scholar. Ask
          // once, and only when a live session is about to be replaced.
          let subject: ManagedClaimSubject = "unknown";
          let incomingScholarName: string | null = null;
          if (
            authRef.current &&
            claim.claimToken !== resolved.lastExchangedClaimToken
          ) {
            try {
              const resolvedSubject = await convex.query(
                api.managedDeviceClaims.claimSubjectForDevice,
                { claimToken: claim.claimToken },
              );
              subject = resolvedSubject.subject;
              incomingScholarName = resolvedSubject.scholarName;
            } catch (error) {
              // Offline or a transient failure. Stay conservative: an unproven
              // reassignment must not sign a working iPad out. The exchange
              // below needs the server anyway, so nothing is lost by waiting.
              console.warn("[managedClaim] couldn't resolve claim subject", error);
            }
          }

          const isHandover = isManagedClaimHandover({
            claimToken: claim.claimToken,
            isAuthenticated: authRef.current,
            lastExchangedClaimToken: resolved.lastExchangedClaimToken,
            subject,
          });

          // In-flight work needs no guard here. Everything a scholar does is
          // server-held, so a hand-over costs at most an unsent composer draft —
          // exactly what the manual sign-out staff perform today already costs.
          // A capture station's shot-but-unuploaded media is the one durable
          // LOCAL artifact, and it survives a swap on its own: the persisted
          // record carries its own station `sessionToken`, and the mutation that
          // drains it (`captureStations.recordUploadedBlob`) is token-gated, not
          // scholar-auth-gated. An earlier revision deferred hand-overs while an
          // upload was pending; that guarded a dependency that does not exist,
          // and because nothing retries the drain once the capture screen
          // unmounts, a stale flag could pin the iPad to the WRONG scholar
          // forever. Serving the wrong child is the failure that outranks
          // everything here.
          const reconcileInput = {
            claimToken: claim.claimToken,
            isAuthenticated: authRef.current,
            lastExchangedClaimToken: resolved.lastExchangedClaimToken,
            sessionInvalidated: nextInvalidated,
            subject,
          };

          if (mountedRef.current) {
            setSwitchingToName(isHandover ? incomingScholarName : null);
            setPhase(isHandover ? "switching" : "exchanging");
          }
          let exchangedDeviceId: string | null = null;
          const result = await reconcileManagedClaim(reconcileInput, {
            clearSession: async () => {
              if (authRef.current) expectedAuthDropRef.current = true;
              await signOut();
            },
            exchange: async () => {
              exchangedDeviceId = await getStableDeviceId();
              const signInResult = await signIn("deviceClaim", {
                claimToken: claim.claimToken,
                deviceId: exchangedDeviceId,
                ...(Device.modelName ? { deviceLabel: Device.modelName } : {}),
                ...(claim.claimSerial ? { serial: claim.claimSerial } : {}),
              });
              assertManagedClaimSignInStarted(signInResult);
            },
            rememberExchange: async () => {
              await SecureStore.setItemAsync(
                LAST_EXCHANGED_CLAIM_KEY,
                claim.claimToken,
              );
              lastExchangedRef.current = claim.claimToken;
            },
          });

          if (result.showFallback) {
            attemptStateRef.current = managedClaimAttemptReducer(
              attemptStateRef.current,
              {
                type: "exchange-failed",
                claimToken: claim.claimToken,
                at: Date.now(),
              },
            );
            console.warn("[managedClaim] automatic sign-in failed", result.error);
            if (mountedRef.current) setPhase("failed");
          } else if (authRef.current) {
            expectedAuthDropRef.current = false;
            if (mountedRef.current) setPhase("idle");
          }
          if (mountedRef.current) setSwitchingToName(null);
          nextInvalidated = false;
        } while (takePendingRequest());
      } catch (error) {
        const failedClaimToken = readManagedClaim()?.claimToken ?? null;
        attemptStateRef.current = failedClaimToken
          ? managedClaimAttemptReducer(attemptStateRef.current, {
              type: "exchange-failed",
              claimToken: failedClaimToken,
              at: Date.now(),
            })
          : attemptStateRef.current;
        console.warn("[managedClaim] bootstrap failed", error);
        if (mountedRef.current) setPhase("failed");
      } finally {
        runningRef.current = false;
      }
    },
    [convex, signIn, signOut],
  );

  useEffect(() => {
    if (isAuthLoading) return;
    const wasAuthenticated = wasAuthenticatedRef.current;
    wasAuthenticatedRef.current = isAuthenticated;

    if (isAuthenticated && attemptStateRef.current.failedClaimToken) {
      setPhase("idle");
      return;
    }

    let sessionInvalidated = wasAuthenticated === true && !isAuthenticated;
    if (sessionInvalidated && expectedAuthDropRef.current) {
      expectedAuthDropRef.current = false;
      sessionInvalidated = false;
    }
    void requestReconcile(sessionInvalidated);
  }, [isAuthenticated, isAuthLoading, requestReconcile]);

  useEffect(() => {
    if (!isAuthLoading && isAuthenticated && phase === "idle") {
      void attachManagedDeviceSession();
    }
  }, [attachManagedDeviceSession, isAuthenticated, isAuthLoading, phase]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && !authLoadingRef.current) {
        attemptStateRef.current = managedClaimAttemptReducer(
          attemptStateRef.current,
          { type: "foreground" },
        );
        void requestReconcile();
      }
    });
    return () => subscription.remove();
  }, [requestReconcile]);

  useEffect(() => {
    if (isAuthLoading || isAuthenticated) return;
    // Managed configuration has no iOS change event. Poll only at the sign-in
    // wall so a remotely rotated claim is exchanged without a relaunch.
    const timer = setInterval(() => {
      if (AppState.currentState === "active") {
        void requestReconcile();
      }
    }, SIGNED_OUT_RECONCILE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isAuthenticated, isAuthLoading, requestReconcile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return {
    hasManagedClaim,
    isReconciling: phase === "checking" || phase === "exchanging",
    /** A live session is being replaced by a different scholar's claim. */
    isSwitchingScholar: phase === "switching",
    switchingToName,
    showFallbackNotice: phase === "failed",
  };
}
