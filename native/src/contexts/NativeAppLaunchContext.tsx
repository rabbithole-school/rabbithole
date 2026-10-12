// NativeAppLaunchProvider — the single, app-lifetime owner of the machinery that
// opens an INSTALLED native iOS app from an Apps launcher tile (an `externalApps`
// row with `nativeUrlScheme`). It releases ASAM so iOS permits the app switch,
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
// ── THE CEREMONY IS RETIRED ────────────────────────────────────────────────
// This provider used to DRIVE a launch-time unlock ceremony: read a lease
// status, ask the backend to PATCH this iPad's MDM profile, poll a seven-state
// availability mirror, remember a handoff, and hand the lease back on abandon.
// Under the allowlist PROJECTION (convex/lib/deviceAppProjection.ts) the
// teacher's grant is the one authority and the backend reconciler converges each
// bound device on its own, so there is nothing to ask for and nothing to give
// back. What remains is a readiness check the DEVICE answers:
//
//     canOpenURL → true  ⇒ ASAM release → openURL      (warm; no backend call)
//     canOpenURL → false ⇒ cold sheet + one reconcile nudge, re-ask until true
//
// ORDERING IS THE SAFETY PROPERTY, and it survives the retirement unchanged:
//
//     ready gate  →  COMMIT (sheet dismissed, cancel latched)  →  ASAM release
//                 →  openURL  →  re-entry restore
//
// The gate runs entirely BEFORE the release, so a cancel or a timeout
// structurally cannot strand Single App Mode or open anything early.
//
// The second half is subtler and is the round-one blocker on this feature.
// Dismissing the sheet before the release is only a QUEUED unmount: React may
// commit it after the synchronous release, so a live Cancel can briefly outlive
// the release. A cancel there bumps the launch generation, and every
// post-release path bails early on `isStale()` — skipping the ASAM restore and
// leaving the iPad unlocked with nothing opened. So the invariant is enforced
// by a LATCH, not by render order: past the commit point `handleCancel` refuses
// to bump the generation at all. Pinned by
// __tests__/NativeAppLaunchContext.test.ts.
//
// Only a managed device (one with an MDM-pushed serial) tapping a tile with a
// managed scheme takes the ready path. Every other launch — a personal install,
// an unmanaged app — behaves exactly as it always has: no sheet, no round trip.
//
// Scholars WITHOUT ASAM still use this provider, so managed app visibility
// cannot bypass the readiness check. The presentation-ASAM controller is a
// no-op there; personal installs take the plain Linking.openURL path.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import { nudgeDeviceAppProjection } from "@/lib/appUnlockClient";
import { runAppReadyGate } from "@/lib/asam/appUnlockGate";
import { isUnlockManagedApp } from "@/lib/asam/managedAppSchemes";
import {
  unlockFailedMessage,
  unlockFailedTitle,
} from "@/lib/asam/appUnlockPolicy";
import {
  decideNativeLaunchWatch,
  interpretNativeOpenResult,
  notInstalledMessage,
  handoffMessage,
  handoffTitle,
  openFailedTitle,
  stillLockedMessage,
  type NativeLaunchWatchState,
} from "@/lib/asam/nativeAppLaunch";
import {
  recordAsamTransition,
  recordExternalAppLaunch,
} from "@/lib/deviceActivityQueue";
import { getStableDeviceId } from "@/lib/deviceIdentity";
import { readManagedSerial } from "@/lib/managedClaim";
import {
  exitSingleAppMode,
  isSingleAppModeActive,
} from "@/lib/singleAppMode";

// The app never actually left the foreground within this window → the handoff
// did not happen, so re-arm. Only fires when no background was observed.
//
// ONE policy and one state machine (`decideNativeLaunchWatch` is untouched and
// identical for both), parameterized by how the handoff actually completes.
// These are not two policies: it is the same rule — "wait until leaving could
// plausibly have happened, then re-arm" — given a correct input.
//
// They are not one NUMBER because the direct path would inherit a kiosk window
// it does not need: openURL either switches apps in milliseconds or never
// happened, so 90s there just leaves ASAM released for 80 extra seconds after
// a silent failure, during which the scholar can wander out of the kiosk.
const HANDOFF_FALLBACK_MS = {
  /** openURL: iOS switches apps in milliseconds or it never happened. */
  direct: 10_000,
  /** The scholar has to swipe up and tap an icon; a six-year-old is not fast. */
  handoff: 90_000,
} as const;

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
 * rather than refuse, and a `false` genuinely means this iPad's allowlist has
 * not caught up with the grant yet. The gate will not report ready without a
 * `true`, so ASAM stays armed and nothing is opened on a `false`.
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
  /**
   * How the app is opened, when it can be. `null` for a managed app that
   * registers no URL scheme (Mentava Reading): the tile still does all the
   * readiness and ASAM work, then hands off to the Home Screen.
   */
  nativeUrlScheme: string | null;
  /** Identity for a scheme-less managed app. See managedAppSchemes.ts. */
  nativeBundleId?: string | null;
  appName: string;
  /**
   * The `externalApps` row this tile came from, carried so screen-time
   * telemetry can attribute the minutes to the app by name rather than by URL
   * scheme. Optional: a launch with no id is still recorded, it just lands in
   * the unattributed column.
   */
  externalAppId?: string;
  /** Canonical tile mark + tint, reused by the cold-path sheet. */
  iconUrl?: string | null;
  iconEmoji?: string | null;
  color?: string | null;
};

export type LaunchNativeApp = (request: NativeLaunchRequest) => Promise<void>;

// Default (no provider mounted): a device with no ASAM to release/restore, so
// just open the scheme. Swallow a rejection so a missing app is a silent no-op.
const DEFAULT_LAUNCH: LaunchNativeApp = async ({ nativeUrlScheme }) => {
  // No scheme → nothing to open, and with no provider there is no ASAM to
  // release either, so the Home-Screen handoff is a no-op rather than a lie.
  if (!nativeUrlScheme) return;
  await Linking.openURL(nativeUrlScheme).catch(() => {});
};

const NativeAppLaunchContext = createContext<LaunchNativeApp>(DEFAULT_LAUNCH);

export function useNativeAppLauncher(): LaunchNativeApp {
  return useContext(NativeAppLaunchContext);
}

/**
 * The cold-path sheet's whole state. Null — the common case — means no sheet:
 * the warm path never mounts one, because there is nothing to wait for and a
 * modal that appears for a frame is worse than no modal at all.
 */
type ReadyUiState = {
  app: UnlockingApp;
  startedAt: number;
  failure: UnlockFailure | null;
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

  // ── Cold-path sheet plumbing ───────────────────────────────────────────────
  const [readyUi, setReadyUi] = useState<ReadyUiState | null>(null);
  // Set by Cancel; read at every gate await point so the gate unwinds without
  // touching ASAM or opening anything.
  const cancelRef = useRef(false);
  // Resolves the "Try again / Cancel" choice while the sheet sits in failure.
  const decisionRef = useRef<((choice: "retry" | "cancel") => void) | null>(null);
  // The generation of the launch that has COMMITTED to the handoff — set the
  // instant before Single App Mode is released, and never cleared (the next
  // launch's own generation supersedes it). See `handleCancel`.
  const committedGenRef = useRef(-1);

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
   * Arm the restore fallback for whatever release is currently outstanding.
   *
   * Guarded by the WATCH STATE, never by the launch generation. A generation
   * guard looks equivalent and is not: a second tap bumps `genRef`, and if that
   * second launch then aborts BEFORE its commit point (readiness fails, or the
   * scholar cancels the sheet), the first launch's timer wakes up stale, exits
   * without restoring, and nothing else is left to re-arm ASAM — the iPad stays
   * out of the kiosk until some unrelated background→active cycle. That hole
   * was unreachable while every committed launch immediately left the app;
   * the Home Screen handoff keeps the scholar INSIDE Rabbithole, free to tap
   * again, which is what made it reachable.
   *
   * `decideNativeLaunchWatch` already guarantees exactly-once (it moves to
   * `idle` on restore and answers `none` from there), so dropping the
   * generation guard cannot double-restore.
   */
  const armRestoreFallback = useCallback(
    (timeoutMs: number) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        const decision = decideNativeLaunchWatch(stateRef.current, {
          kind: "timer",
        });
        stateRef.current = {
          mode: decision.mode,
          sawBackground: decision.sawBackground,
        };
        if (decision.action === "restore") applyRestore();
      }, timeoutMs);
    },
    [applyRestore, clearTimer],
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
        setReadyUi(null);
        // ASAM re-arms NOW and synchronously — the scholar is looking at
        // Rabbithole again, and that must never wait on anything. There is
        // nothing else to do on return any more: the app's place in this iPad's
        // allowlist belongs to the teacher's grant, not to this launch, so
        // there is no lease whose clock needs starting.
        restoreAfterSystemUI();
      }
    });
    return () => subscription.remove();
  }, [clearTimer, restoreAfterSystemUI]);

  const closeReadyUi = useCallback(() => setReadyUi(null), []);

  /**
   * Cancel: never releases ASAM, never opens anything.
   *
   * PAST THE COMMIT POINT IT IS A NO-OP, and that is the structural half of the
   * ordering invariant. Dismissing the sheet before the release only queues an
   * unmount — React is free to commit it after `releaseForSystemUI()` has
   * already run, so for a beat the old sheet is still on screen with a live
   * Cancel. If that Cancel bumped the generation, every post-release path below
   * would read `isStale()` and bail EARLY — skipping the ASAM restore and
   * leaving the iPad unlocked with nothing opened. That is the round-one
   * blocker, and no amount of render ordering can rule it out; refusing the
   * generation bump can.
   */
  const handleCancel = useCallback(() => {
    if (committedGenRef.current === genRef.current) {
      // This launch already released Single App Mode. There is nothing left to
      // cancel — just make sure the stale sheet is gone.
      closeReadyUi();
      return;
    }
    cancelRef.current = true;
    // Supersede the in-flight gate so its continuations are stale, and free the
    // tile immediately — the scholar should not have to wait out a probe sleep
    // before their next tap is accepted.
    genRef.current += 1;
    busyRef.current = false;
    // This tap superseded an EARLIER launch that had already released ASAM and
    // was still waiting to restore. Cancelling this one must not silently
    // inherit — and drop — that obligation.
    // A release is outstanding and nobody else owns restoring it.
    if (stateRef.current.mode === "watching")
      armRestoreFallback(HANDOFF_FALLBACK_MS.handoff);
    decisionRef.current?.("cancel");
    decisionRef.current = null;
    closeReadyUi();
  }, [armRestoreFallback, closeReadyUi]);

  const handleRetry = useCallback(() => {
    decisionRef.current?.("retry");
    decisionRef.current = null;
  }, []);

  /**
   * Wait until iOS says this managed app is open-able, retrying as long as the
   * scholar asks. Resolves "ready" or "aborted"; ASAM is untouched either way.
   */
  const ensureAppReady = useCallback(
    async (
      app: UnlockingApp,
      nativeUrlScheme: string,
      isStale: () => boolean,
    ): Promise<"ready" | "aborted"> => {
      while (true) {
        cancelRef.current = false;
        const startedAt = Date.now();
        // NOTHING is shown yet. A warm tap resolves on one local `canOpenURL`,
        // so mounting an acknowledgment here would flash a modal for a frame on
        // the overwhelming majority of launches. The sheet appears only when
        // the gate says iOS refused — and on a retry, that first probe also
        // clears the failure the sheet was holding.
        setReadyUi(null);

        const result = await runAppReadyGate({
          canOpen: () => canOpenManagedApp(nativeUrlScheme),
          nudge: async () => {
            // Resolved lazily and best-effort: the warm path never gets here,
            // and a device id we cannot read costs the cold path only the
            // reconciler's own cron interval, never the launch.
            const deviceId = await getStableDeviceId().catch(() => null);
            if (!deviceId) return;
            await nudgeDeviceAppProjection(convex, deviceId);
          },
          now: () => Date.now(),
          sleep,
          onWaiting: () => {
            if (isStale()) return;
            setReadyUi({ app, startedAt, failure: null });
          },
          isCancelled: () => cancelRef.current || isStale(),
        });

        // A newer tap owns the screen and the sheet — leave both to it.
        if (isStale()) return "aborted";
        if (result.outcome === "ready") return "ready";
        if (result.outcome === "cancelled") {
          closeReadyUi();
          return "aborted";
        }

        // Timed out: hold the sheet, say only what is known, and wait for the
        // scholar. ASAM is untouched and nothing has been opened. Giving up on
        // the wait does not give up on the work — the reconciler keeps
        // converging, so Try again usually resolves warm.
        setReadyUi({
          app,
          startedAt,
          failure: {
            title: unlockFailedTitle(app.name),
            message: unlockFailedMessage(app.name),
          },
        });
        const choice = await new Promise<"retry" | "cancel">((resolve) => {
          decisionRef.current = resolve;
        });
        if (isStale()) return "aborted";
        if (choice === "cancel") {
          closeReadyUi();
          return "aborted";
        }
      }
    },
    [closeReadyUi, convex],
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

      // ── Phase 0: readiness. Runs BEFORE any ASAM release, so a cancel or a
      // timeout here cannot strand Single App Mode.
      //
      // Only an MDM-claimed install tapping a managed scheme takes this path:
      // for anything else `canOpenURL` returning false means the app simply is
      // not installed, and waiting 75 seconds to say so would be worse than the
      // immediate "not installed" alert below.
      const managed = !!readManagedSerial() && isUnlockManagedApp(request);

      // PRE-FLIGHT REFUSAL — and it has to be here, in Phase 0, not later.
      // Without a scheme the ONLY thing this flow can offer is the Home Screen
      // handoff, and that is meaningless unless the backend manages the app
      // (nothing guarantees it is installed, allowlisted or tiled) or the
      // device is managed at all. Refusing AFTER the commit point would
      // release ASAM and then bail without restoring it — a stranded kiosk,
      // which is the very bug this branch exists to prevent. Nothing has been
      // released yet at this point, so returning here is genuinely fail-closed.
      if (!nativeUrlScheme && !managed) {
        busyRef.current = false;
        Alert.alert(openFailedTitle(appName), notInstalledMessage());
        return;
      }
      // The readiness gate probes `canOpenURL`, which only exists for an app
      // with a scheme. A scheme-less managed app therefore has NO local
      // readiness signal: nudge the projection best-effort and proceed. Its
      // tile is only on screen because the grant is live, and that same grant
      // drives the allowlist, so the sole gap is reconciler lag — which costs
      // a message naming an icon that lands moments later, not a failed
      // launch.
      if (managed && !nativeUrlScheme) {
        void getStableDeviceId()
          .then((deviceId) =>
            deviceId ? nudgeDeviceAppProjection(convex, deviceId) : undefined,
          )
          .catch(() => {});
      }
      if (managed && nativeUrlScheme) {
        const outcome = await ensureAppReady(
          {
            name: appName,
            iconUrl: request.iconUrl ?? null,
            iconEmoji: request.iconEmoji ?? null,
            color: request.color ?? null,
          },
          nativeUrlScheme,
          isStale,
        );
        // Superseded: the newer launch owns `busyRef` now, so do not clear it.
        if (isStale()) return;
        if (outcome !== "ready") {
          busyRef.current = false;
          return;
        }
      }

      // THE COMMIT POINT. Two steps, and the order between them is not the
      // guarantee — the latch is.
      //
      // `closeReadyUi()` queues the sheet's unmount so the scholar stops seeing
      // it, but React may commit that after the synchronous release below; a
      // rendered sheet can therefore outlive the release by a beat. The latch
      // is what makes that harmless: from here on `handleCancel` refuses to
      // bump the generation, so a late tap cannot send the post-release paths
      // down their early-bail branches and strand ASAM. See `handleCancel`.
      committedGenRef.current = gen;
      closeReadyUi();

      // Tear down the previous launch's timer and start a fresh watch. Do NOT
      // restore here even if the previous launch had sawBackground: the
      // continuous listener still holds `previous`, so that flow's own
      // background→active re-entry will restore exactly once.
      clearTimer();
      // Seed from the REAL AppState rather than hardcoding false. A cold
      // readiness gate can resolve after the scholar has already left (a
      // previous handoff released ASAM, they swiped Home, and JS kept running
      // in the background), and hardcoding false there erases that observed
      // background — after which this launch's fallback would see
      // `sawBackground: false` and re-enter ASAM while they are inside another
      // app. Reading the current state cannot be wrong in the ordinary
      // foreground case, where it is "active".
      const startedInBackground = AppState.currentState === "background";
      stateRef.current = { mode: "watching", sawBackground: startedInBackground };
      appStateRef.current = AppState.currentState;
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
          return;
        }
        if (!released) {
          const exited = await exitSingleAppMode();
          recordAsamTransition("asam_exit", "system_ui_release", exited);
          if (isStale()) {
            busyRef.current = false;
            return;
          }
          if (!exited && isSingleAppModeActive()) {
            busyRef.current = false;
            applyRestore();
            Alert.alert(openFailedTitle(appName), stillLockedMessage());
            return;
          }
        }
      }

      const failOpen = () => {
        busyRef.current = false;
        applyRestore();
        Alert.alert(openFailedTitle(appName), notInstalledMessage());
      };

      if (!nativeUrlScheme) {
        // Nothing to open; the remaining step is the scholar's.
        //
        // Deliberately NO `recordExternalAppLaunch` here. The openURL path
        // emits it on a CONFIRMED switch; this path has no such signal, and
        // the rollup pairs a launch with the immediately ADJACENT event. So a
        // speculative launch is not merely imprecise, it is wrong in both
        // directions: stay in Rabbithole and Rabbithole's minutes are booked
        // to this app, leave and the adjacent event is `app_background` rather
        // than `external_return`, which books the fixed unreturned-session
        // estimate instead of the real interval. Missing minutes beat
        // fabricated ones; attributing this handoff needs a launch signal
        // derived from the following background, which is its own change.
        busyRef.current = false;
        Alert.alert(handoffTitle(appName), handoffMessage(appName));
        armRestoreFallback(HANDOFF_FALLBACK_MS.handoff);
        return;
      }

      try {
        const result = await Linking.openURL(nativeUrlScheme);
        if (!interpretNativeOpenResult(result)) {
          if (isStale()) {
            busyRef.current = false;
            return;
          }
          failOpen();
          return;
        }
        // Opened. Record the handoff for screen-time telemetry — synchronous,
        // non-throwing, and never awaited, so it cannot delay the app switch.
        // Emitted only on a CONFIRMED open: a refused or failed launch is not
        // time in another app. The matching external_return is emitted by the
        // queue on the next foreground.
        recordExternalAppLaunch(request.externalAppId);
        if (isStale()) {
          busyRef.current = false;
          return;
        }
      } catch {
        if (isStale()) {
          busyRef.current = false;
          return;
        }
        failOpen();
        return;
      }

      busyRef.current = false;
      // Arm the fallback ONLY for the silent case (never backgrounded).
      armRestoreFallback(HANDOFF_FALLBACK_MS.direct);
    },
    [
      applyRestore,
      armRestoreFallback,
      clearTimer,
      convex,
      closeReadyUi,
      ensureAppReady,
      releaseForSystemUI,
    ],
  );

  return (
    <NativeAppLaunchContext.Provider value={launchNativeApp}>
      {children}
      <AppUnlockingOverlay
        app={readyUi?.app ?? null}
        startedAt={readyUi?.startedAt ?? 0}
        failure={readyUi?.failure ?? null}
        onCancel={handleCancel}
        onRetry={handleRetry}
      />
    </NativeAppLaunchContext.Provider>
  );
}
