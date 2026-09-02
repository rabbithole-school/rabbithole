// NativeAppLaunchProvider — the single, app-lifetime owner of the machinery that
// opens an INSTALLED native iOS app from an Apps launcher tile (an `externalApps`
// row with `nativeUrlScheme`). It asks the backend to lift any MDM restriction on
// the app for THIS managed iPad, releases ASAM so iOS permits the app switch,
// opens the scheme, and re-arms the normal lock policy on return / on failure.
//
// Why a provider and not a per-tile hook:
//   • Single-flight. Every tile shares ONE launch function, ONE AppState
//     listener, ONE timer, and ONE watch state, so two rapid taps cannot spin up
//     two independent restore paths that re-arm ASAM while the scholar is inside
//     another app. A generation token + a busy flag cancel stale continuations.
//   • App lifetime. Mounted around the full app subtree (inside AsamHybridHost
//     when ASAM is enabled), so the re-entry restore path can never die with a
//     tile/tab unmount.
//
// DYNAMIC UNLOCKING (Google Sheets, LEGO SPIKE): those apps stay installed but
// are normally hidden and blocked by MDM, so the launch runs an unlock GATE
// first — see lib/asam/appUnlockGate.ts. Ordering is the safety property:
//
//     unlock gate  →  ASAM release  →  openURL  →  re-entry restore
//
// The gate runs entirely BEFORE the release, so a cancel, a timeout, or an MDM
// failure structurally cannot strand Single App Mode or open anything early.
// Only a managed device (one with an MDM-pushed serial) and a tile carrying its
// catalog `appId` take that path; every other launch behaves exactly as before.
//
// AND the gate can decline to apply. Dynamic unlocking only governs iPads with a
// per-device dedicated profile; the rest of the fleet is allowlisted permanently
// by the GROUP profile, so their launches need nothing from it. The backend says
// so with a typed `not-configured` status, the gate resolves `not-configured`
// without requesting, polling, or probing, and this provider dissolves its
// acknowledgment and falls through to the same plain ASAM-release → openURL path
// an unmanaged app takes — no lease and no return handoff.
//
// THE MODAL'S TWO INVARIANTS, since every launch outcome has to keep both:
//   1. A managed-scheme tap is acknowledged at once, in the NEUTRAL `preparing`
//      phase ("Opening <app>…"), and stays cancellable for as long as the gate
//      is safe to abandon. Unlock wording only ever comes from a gate-reported
//      phase, which the gate withholds until it knows the iPad is mediated.
//   2. Nothing that proceeds to the ASAM release leaves a LIVE Cancel behind.
//      Ready sets `canCancel: false` for the handoff; unmediated closes the
//      modal outright; every abandonment closes it. A Cancel arriving after the
//      release bumps the generation and unwinds through the stale paths with
//      Single App Mode already gone.
//
// Scholars WITHOUT ASAM still use this provider so managed app visibility cannot
// bypass the unlock gate. The presentation-ASAM controller is a no-op there;
// personal installs take the plain Linking.openURL path.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AppState, Linking, type AppStateStatus } from "react-native";
import { useConvex } from "convex/react";

import {
  AppUnlockingOverlay,
  type UnlockFailure,
  type UnlockingApp,
} from "@/components/AppUnlockingOverlay";
import { usePresentationAsam } from "@/contexts/AsamControllerContext";
import {
  convexAppUnlockGateway,
  reportReturnedToRabbithole,
  type ExternalAppUnlockTarget,
} from "@/lib/appUnlockClient";
import { runAppUnlockGate } from "@/lib/asam/appUnlockGate";
import { isUnlockManagedScheme } from "@/lib/asam/managedAppSchemes";
import {
  claimUnlockHandoff,
  shouldHandBackUnlockLease,
  unlockFailedMessage,
  unlockFailedTitle,
  type PendingUnlockHandoff,
  type UnlockPhase,
} from "@/lib/asam/appUnlockPolicy";
import {
  decideNativeLaunchWatch,
  interpretNativeOpenResult,
  notInstalledMessage,
  openFailedTitle,
  stillLockedMessage,
  type NativeLaunchWatchState,
} from "@/lib/asam/nativeAppLaunch";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import { readManagedSerial } from "@/lib/managedClaim";
import type { Id } from "@/lib/convex";
import {
  exitSingleAppMode,
  isSingleAppModeActive,
} from "@/lib/singleAppMode";

// The app never actually left the foreground within this window → openURL
// silently did nothing, so re-arm. Only fires when no background was observed.
const SILENT_RETURN_FALLBACK_MS = 10_000;

// How long to wait for the controller's in-flight Single App Mode exit to land
// before retrying it ourselves. Guided Access transitions complete well under a
// second in practice; 4s is generous without stranding the tap.
const EXIT_POLL_TOTAL_MS = 4_000;
const EXIT_POLL_INTERVAL_MS = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until Single App Mode reports inactive, or the budget runs out. */
async function waitForSingleAppModeExit(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (isSingleAppModeActive()) {
    if (Date.now() >= deadline) return false;
    await sleep(EXIT_POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * The device's own answer to "can this app be opened right now".
 *
 * FAIL-CLOSED: a throw resolves `false`, never "assume yes". Both managed
 * schemes are declared in `LSApplicationQueriesSchemes`, so iOS will answer
 * rather than refuse, and a `false` genuinely means the MDM change has not been
 * applied on this iPad yet. The gate polls this and will not report ready
 * without a `true`, so ASAM stays armed and nothing is opened on a `false`.
 */
async function canOpenManagedApp(scheme: string): Promise<boolean> {
  try {
    return await Linking.canOpenURL(scheme);
  } catch {
    return false;
  }
}

/** Everything a tile knows about the app it is opening. */
export type NativeLaunchRequest = {
  nativeUrlScheme: string;
  appName: string;
  /**
   * Catalog app id. Required for the unlock gate — without it (or on an
   * unmanaged device, or for an app the backend does not manage) the launch
   * takes the plain, pre-existing path.
   */
  appId?: Id<"externalApps">;
  /** Canonical tile mark + tint, reused by the unlock modal. */
  iconUrl?: string | null;
  iconEmoji?: string | null;
  color?: string | null;
};

export type LaunchNativeApp = (request: NativeLaunchRequest) => Promise<void>;

// Default (no provider mounted): a device with no ASAM to release/restore, so
// just open the scheme. Swallow a rejection so a missing app is a silent no-op.
const DEFAULT_LAUNCH: LaunchNativeApp = async ({ nativeUrlScheme }) => {
  await Linking.openURL(nativeUrlScheme).catch(() => {});
};

const NativeAppLaunchContext = createContext<LaunchNativeApp>(DEFAULT_LAUNCH);

export function useNativeAppLauncher(): LaunchNativeApp {
  return useContext(NativeAppLaunchContext);
}

type UnlockUiState = {
  app: UnlockingApp;
  phase: UnlockPhase;
  startedAt: number;
  failure: UnlockFailure | null;
  canCancel: boolean;
};

export function NativeAppLaunchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { releaseForSystemUI, restoreAfterSystemUI } = usePresentationAsam();
  const convex = useConvex();

  // Watch state for the CURRENT launch (idle when none in flight). `previous`
  // is tracked continuously across launches so a background→active re-entry is
  // detected even when a newer launch reset the per-launch flags.
  const stateRef = useRef<NativeLaunchWatchState>({
    mode: "idle",
    sawBackground: false,
  });
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped every launch; a captured `gen` that no longer matches means a newer
  // launch superseded this one, so its post-await continuations bail.
  const genRef = useRef(0);
  // True only between a launch's start and its openURL settling — a double-tap
  // in that window is ignored so it can't start two openURLs.
  const busyRef = useRef(false);
  const gateway = useMemo(() => convexAppUnlockGateway(convex), [convex]);

  // ── Unlock-gate plumbing ───────────────────────────────────────────────────
  const [unlockUi, setUnlockUi] = useState<UnlockUiState | null>(null);
  // Set by Cancel; read at every gate await point so the gate unwinds without
  // touching ASAM or opening anything.
  const cancelRef = useRef(false);
  // Resolves the "Try again / Cancel" choice while the modal sits in failure.
  const decisionRef = useRef<((choice: "retry" | "cancel") => void) | null>(null);
  // The iPad that handed off to an unlock-managed app, remembered only until the
  // scholar comes back, so the return can start the backend's idle lease.
  // Written BEFORE the switch is requested — see `claimUnlockHandoff`.
  const returnHandoffRef = useRef<PendingUnlockHandoff | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const applyRestore = useCallback(() => {
    clearTimer();
    stateRef.current = { mode: "idle", sawBackground: false };
    restoreAfterSystemUI();
  }, [clearTimer, restoreAfterSystemUI]);

  /**
   * Fire-and-forget: start the backend's idle lease for the iPad that just
   * handed off. Never awaited by the UI and never surfaced — the mutation
   * legitimately rejects when there is no session to return from.
   */
  const reportReturn = useCallback(() => {
    const { target, next } = claimUnlockHandoff(returnHandoffRef.current);
    returnHandoffRef.current = next;
    if (!target) return;
    void reportReturnedToRabbithole(convex, target);
  }, [convex]);

  /**
   * A launch that armed the handoff but never reached the app — the ASAM exit
   * refused, `openURL` was refused or threw, or a newer tap superseded it. Take
   * the record back and start the idle lease, since nothing is using the app.
   * Scoped to the launch that wrote it, so a superseded flow cannot swallow a
   * newer launch's pending return.
   */
  const abandonHandoff = useCallback(
    (launchGen: number) => {
      const { target, next } = claimUnlockHandoff(returnHandoffRef.current, {
        onlyLaunchGen: launchGen,
      });
      returnHandoffRef.current = next;
      if (!target) return;
      void reportReturnedToRabbithole(convex, target);
    },
    [convex],
  );

  // ONE persistent AppState listener for the provider's whole life. It reads the
  // CURRENT watch state, so it needs no captured generation — an idle state (a
  // completed or superseded launch) makes every transition a no-op.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const decision = decideNativeLaunchWatch(stateRef.current, {
        kind: "appstate",
        previous: appStateRef.current,
        next,
      });
      appStateRef.current = next;
      stateRef.current = {
        mode: decision.mode,
        sawBackground: decision.sawBackground,
      };
      if (decision.action === "restore") {
        clearTimer();
        setUnlockUi(null);
        // ASAM re-arms NOW and synchronously — the scholar is looking at
        // Rabbithole again, and that must never wait on a network round trip.
        restoreAfterSystemUI();
        // Then, off the critical path and without a relock: tell the backend
        // the scholar is back. The app STAYS unlocked so hopping straight back
        // into it is instant (a return is usually the middle of the work, not
        // the end of it); what changes server-side is only the clock — the long
        // active-session failsafe becomes the one-hour idle lease, and the
        // backend's reconcile cron closes the app after that. Nothing here is
        // awaited, and a rejection (no session to return from) is not an error.
        reportReturn();
      }
    });
    return () => subscription.remove();
  }, [clearTimer, reportReturn, restoreAfterSystemUI]);

  const closeUnlockUi = useCallback(() => setUnlockUi(null), []);

  /** Cancel: never releases ASAM, never opens anything. */
  const handleUnlockCancel = useCallback(() => {
    cancelRef.current = true;
    // Supersede the in-flight gate so its continuations are stale, and free the
    // tile immediately — the scholar should not have to wait out a poll sleep
    // before their next tap is accepted.
    genRef.current += 1;
    busyRef.current = false;
    decisionRef.current?.("cancel");
    decisionRef.current = null;
    closeUnlockUi();
  }, [closeUnlockUi]);

  const handleUnlockRetry = useCallback(() => {
    decisionRef.current?.("retry");
    decisionRef.current = null;
  }, []);

  /**
   * Best-effort: hand an armed-but-abandoned unlock back to the one-hour idle
   * lease. Without this, an unlock the backend already accepted stays armed for
   * the full active-session failsafe (hours) whenever the scholar cancels, the
   * OS check times out, or a newer tap supersedes this launch — leaving the app
   * de-allowlisted with nobody using it.
   *
   * Fire-and-forget, and deliberately NOT `requestLock`: locking synchronously
   * would PATCH the profile, block cancel, and destroy the warm path for the
   * scholar's very next tap.
   */
  const abandonUnlock = useCallback(
    (target: ExternalAppUnlockTarget, unlockRequested: boolean) => {
      if (!shouldHandBackUnlockLease({ unlockRequested, exit: "abandoned" })) return;
      void reportReturnedToRabbithole(convex, target);
    },
    [convex],
  );

  /**
   * Run the unlock gate behind its modal, retrying as long as the scholar asks.
   * Resolves how the app became available, or "aborted" when it did not.
   */
  const runUnlockWithUi = useCallback(
    async (
      target: ExternalAppUnlockTarget,
      app: UnlockingApp,
      nativeUrlScheme: string,
      isStale: () => boolean,
    ): Promise<"warm" | "cold" | "unmediated" | "aborted"> => {
      // True once THIS launch has actually asked for an unlock, so an abort can
      // tell whether there is a lease of ours to hand back.
      let requested = false;
      const abort = (): "aborted" => {
        if (!isStale()) closeUnlockUi();
        abandonUnlock(target, requested);
        return "aborted";
      };
      while (true) {
        cancelRef.current = false;
        const startedAt = Date.now();
        // The tap's acknowledgment, and on a retry the reset of the failure it
        // was holding. `preparing` renders as "Opening <app>… / Getting things
        // ready…" — deliberately NEUTRAL: it makes no unlock claim, so it is
        // honest on an iPad this system turns out not to mediate, and the gate
        // reports no phase until it knows.
        setUnlockUi({
          app,
          phase: "preparing",
          startedAt,
          failure: null,
          canCancel: true,
        });

        const result = await runAppUnlockGate(target, {
          gateway: {
            ...gateway,
            requestUnlock: (unlockTarget) => {
              requested = true;
              return gateway.requestUnlock(unlockTarget);
            },
          },
          now: () => Date.now(),
          sleep,
          onPhase: (phase) => {
            if (isStale()) return;
            setUnlockUi((prev) =>
              prev && prev.failure === null
                ? { ...prev, phase }
                : { app, phase, startedAt, failure: null, canCancel: true },
            );
          },
          isCancelled: () => cancelRef.current || isStale(),
          canOpen: () => canOpenManagedApp(nativeUrlScheme),
        });

        if (isStale()) return abort();
        if (result.outcome === "not-configured") {
          // This iPad's allowlist is group-managed; the unlock system does not
          // mediate it. DISSOLVE the acknowledgment before handing back, on this
          // one exit that every unmediated reading funnels through — entry read
          // or mid-poll, first attempt or a retry after a failure. Leaving it
          // mounted would carry a LIVE Cancel into the ASAM release and openURL
          // below, where a cancel bumps the generation and unwinds through the
          // stale paths with Single App Mode already released.
          closeUnlockUi();
          return "unmediated";
        }
        if (result.outcome === "ready") {
          setUnlockUi((prev) =>
            prev
              ? {
                  ...prev,
                  phase: "opening",
                  failure: null,
                  canCancel: false,
                }
              : null,
          );
          return result.warm ? "warm" : "cold";
        }
        if (result.outcome === "cancelled") {
          return abort();
        }

        // Failure: hold the modal, say only what is known, and wait for the
        // scholar. ASAM is untouched and nothing has been opened.
        setUnlockUi({
          app,
          phase: "waiting",
          startedAt,
          failure: {
            title: unlockFailedTitle(app.name),
            message: unlockFailedMessage(app.name, result.reason, result.message),
          },
          canCancel: true,
        });
        const choice = await new Promise<"retry" | "cancel">((resolve) => {
          decisionRef.current = resolve;
        });
        if (isStale() || choice === "cancel") {
          return abort();
        }
      }
    },
    [abandonUnlock, closeUnlockUi, gateway],
  );

  const launchNativeApp = useCallback<LaunchNativeApp>(
    async (request) => {
      const { nativeUrlScheme, appName } = request;
      // Ignore taps while a launch is still setting up (pre-openURL). A double
      // tap must not start two openURLs.
      if (busyRef.current) return;
      busyRef.current = true;
      const gen = ++genRef.current;
      const isStale = () => gen !== genRef.current;

      // ── Phase 0: unlock. Runs BEFORE any ASAM release, so a cancel, timeout,
      // or MDM failure here cannot strand Single App Mode.
      //
      // A supported managed scheme on an MDM-claimed install must never fall
      // through to the plain launcher. Missing tile/device identity fails closed;
      // other apps and personal installs retain the zero-round-trip path.
      const appId = request.appId;
      const managed =
        !!readManagedSerial() && isUnlockManagedScheme(nativeUrlScheme);
      const unlockingApp: UnlockingApp = {
        name: appName,
        iconUrl: request.iconUrl ?? null,
        iconEmoji: request.iconEmoji ?? null,
        color: request.color ?? null,
      };
      // Acknowledge the tap IMMEDIATELY, before the device-id read and the
      // status round trip that follow — otherwise a slow query looks like an
      // ignored tap with no Cancel, while `busyRef` silently swallows the
      // repeat taps that produces. `preparing` is the neutral phase ("Opening
      // <app>… / Getting things ready…"), so this says nothing that would be
      // untrue on an iPad this system turns out not to mediate; the unlock
      // wording only ever arrives from a gate-reported phase. Cancel is live
      // throughout, and dissolving this is the unmediated path's job.
      if (managed) {
        setUnlockUi({
          app: unlockingApp,
          phase: "preparing",
          startedAt: Date.now(),
          failure: null,
          canCancel: true,
        });
      }
      const deviceId = managed ? await getStableDeviceId().catch(() => null) : null;
      if (isStale()) return;
      if (managed && (!appId || !deviceId)) {
        busyRef.current = false;
        closeUnlockUi();
        Alert.alert(
          unlockFailedTitle(appName),
          unlockFailedMessage(appName, "failed"),
        );
        return;
      }
      const unlockTarget =
        appId && deviceId
          ? {
              externalAppId: appId,
              deviceId,
              leaseToken:
                typeof globalThis.crypto?.randomUUID === "function"
                  ? globalThis.crypto.randomUUID()
                  : `${Date.now()}-${gen}-${Math.random()}`,
            }
          : null;
      // True only once the gate has actually armed an unlock lease for this
      // launch. An unmediated iPad never takes one, so it must not be given a
      // return handoff to signal or a lease to hand back — there is nothing on
      // the server to hand back, and `markReturned` would answer `marked: false`
      // for a device the unlock system does not track at all.
      let leased = false;
      if (unlockTarget) {
        const unlocked = await runUnlockWithUi(
          unlockTarget,
          unlockingApp,
          nativeUrlScheme,
          isStale,
        );
        leased = unlocked === "warm" || unlocked === "cold";
        if (isStale()) {
          // Superseded between the gate resolving and the handoff. If the gate
          // got as far as "ready", a lease is armed for the full active-session
          // failsafe (hours) and nothing is going to use it — the newer tap owns
          // the screen. Hand it back to the idle clock. `unlocked === "aborted"`
          // already handed itself back inside runUnlockWithUi, and an unmediated
          // iPad has nothing to hand back.
          abandonUnlock(unlockTarget, leased);
          return;
        }
        if (unlocked === "aborted") {
          busyRef.current = false;
          return;
        }
        // Either readiness is settled — the gate required BOTH the backend's
        // accepted status AND this iPad's own `canOpenURL` — or this iPad is
        // unmediated and falls through to the plain launch below, exactly as a
        // non-managed scheme does. ASAM has still not been touched.
      }

      // Tear down the previous launch's timer and start a fresh watch. Do NOT
      // restore here even if the previous launch had sawBackground: the
      // continuous listener still holds `previous`, so that flow's own
      // background→active re-entry will restore exactly once.
      clearTimer();
      stateRef.current = { mode: "watching", sawBackground: false };
      appStateRef.current = AppState.currentState;
      // Record the handoff BEFORE asking for the switch. The AppState listener
      // restores ASAM and reads this synchronously, and a background→active
      // round trip can complete before `openURL` below even resolves — writing
      // it afterwards loses that race and silently skips the return signal,
      // leaving the app unlocked for the full active-session failsafe. Every
      // path that ends without a switch claims it back.
      reportReturn();
      returnHandoffRef.current =
        unlockTarget && leased
          ? {
              deviceId: unlockTarget.deviceId,
              leaseToken: unlockTarget.leaseToken,
              launchGen: gen,
            }
          : null;
      releaseForSystemUI();

      // releaseForSystemUI() fires the Single App Mode exit WITHOUT awaiting it
      // (fine for the slides flow, where a human swipe follows seconds later).
      // Apple's guidance (WWDC22 "Create accessible Single App Mode
      // experiences") is to confirm the exit BEFORE asking iOS to switch apps —
      // otherwise openURL can race the still-locked state and a refused switch
      // masquerades as "app not installed". CRITICAL: wait, don't re-request —
      // issuing a second requestGuidedAccessSession while the controller's own
      // exit is mid-transition makes iOS report failure for the second request
      // while isSingleAppModeActive() still reads true, which surfaced on the
      // pilot iPad (2026-08-26) as a spurious "lock didn't release" alert. So:
      // poll for the in-flight exit to land; only on timeout issue ONE explicit
      // retry, and only then give up.
      if (isSingleAppModeActive()) {
        const released = await waitForSingleAppModeExit(EXIT_POLL_TOTAL_MS);
        if (isStale()) {
          busyRef.current = false;
          abandonHandoff(gen);
          return;
        }
        if (!released) {
          const exited = await exitSingleAppMode();
          if (isStale()) {
            busyRef.current = false;
            abandonHandoff(gen);
            return;
          }
          if (!exited && isSingleAppModeActive()) {
            busyRef.current = false;
            abandonHandoff(gen);
            applyRestore();
            closeUnlockUi();
            Alert.alert(openFailedTitle(appName), stillLockedMessage());
            return;
          }
        }
      }

      const failOpen = () => {
        busyRef.current = false;
        closeUnlockUi();
        // No switch happened, so nothing is using the app — put the lease back
        // on the idle clock instead of holding it for hours.
        abandonHandoff(gen);
        applyRestore();
        Alert.alert(openFailedTitle(appName), notInstalledMessage());
      };

      try {
        const result = await Linking.openURL(nativeUrlScheme);
        if (!interpretNativeOpenResult(result)) {
          if (isStale()) {
            busyRef.current = false;
            abandonHandoff(gen);
            return;
          }
          failOpen();
          return;
        }
        closeUnlockUi();
        // Opened. The handoff record stays armed even if this launch is now
        // stale — the scholar is in the other app, and their return still has
        // to start the idle lease.
        if (isStale()) {
          busyRef.current = false;
          return;
        }
      } catch {
        if (isStale()) {
          busyRef.current = false;
          abandonHandoff(gen);
          return;
        }
        failOpen();
        return;
      }

      busyRef.current = false;
      // Arm the fallback ONLY for the silent case (never backgrounded). The
      // handoff record was armed before the switch was requested.
      timerRef.current = setTimeout(() => {
        if (gen !== genRef.current) return; // stale generation → no restore
        const decision = decideNativeLaunchWatch(stateRef.current, {
          kind: "timer",
        });
        stateRef.current = {
          mode: decision.mode,
          sawBackground: decision.sawBackground,
        };
        if (decision.action === "restore") {
          clearTimer();
          restoreAfterSystemUI();
          // The switch never visibly happened. Start the idle lease anyway —
          // the conservative direction, since nothing is being used.
          reportReturn();
        }
      }, SILENT_RETURN_FALLBACK_MS);
    },
    [
      abandonHandoff,
      abandonUnlock,
      applyRestore,
      clearTimer,
      releaseForSystemUI,
      reportReturn,
      restoreAfterSystemUI,
      runUnlockWithUi,
      closeUnlockUi,
    ],
  );

  return (
    <NativeAppLaunchContext.Provider value={launchNativeApp}>
      {children}
      <AppUnlockingOverlay
        app={unlockUi?.app ?? null}
        phase={unlockUi?.phase ?? "asking"}
        startedAt={unlockUi?.startedAt ?? 0}
        failure={unlockUi?.failure ?? null}
        canCancel={unlockUi?.canCancel ?? true}
        onCancel={handleUnlockCancel}
        onRetry={handleUnlockRetry}
      />
    </NativeAppLaunchContext.Provider>
  );
}
