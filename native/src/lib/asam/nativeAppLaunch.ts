// Pure decision logic for opening an INSTALLED native iOS app from an Apps
// launcher tile (an `externalApps` row with `nativeUrlScheme`). NO React or
// React-Native imports, so it unit-tests as plain functions — mirroring the
// asamDecision.ts + __tests__ style.
//
// The flow the hook drives with these decisions:
//   1. releaseForSystemUI() so iOS permits the app switch, then openURL(scheme).
//   2. openURL failed (app not installed) → restoreAfterSystemUI() + Alert.
//      Both failure shapes are handled: a rejected promise (caught in the hook)
//      AND a resolved-`false` value (interpretNativeOpenResult below).
//   3. On return to Rabbithole (a real background → active re-entry) →
//      restoreAfterSystemUI() so the normal lock policy re-arms.
//   4. Fallback timer: restore ONLY if the app never actually backgrounded
//      (openURL silently did nothing). NEVER restore on the timer while the
//      scholar is inside the other app — clearing the release flag from the
//      background would let the controller re-enter ASAM and yank them back.

import { isAppReentry, type AppLifecycleState } from "./asamDecision";

/**
 * Interpret an `Linking.openURL` RESOLVED value. openURL usually resolves
 * `undefined` on success and rejects on failure, but some platform/return
 * shapes resolve a boolean instead. Treat an explicit `false` as "did not
 * open" (app not installed); anything else resolved counts as opened. A
 * rejected promise is handled separately by the caller's try/catch.
 */
export function interpretNativeOpenResult(result: unknown): boolean {
  return result !== false;
}

/**
 * Whether a launch is currently being watched. `idle` = no launch in flight, so
 * a persistent AppState listener (one per NativeAppLaunchProvider lifetime)
 * ignores every transition. This is what lets ONE long-lived listener serve
 * every launch without a per-launch attach/detach race, and what makes a stale
 * timer or a superseded flow a no-op: once a flow restores it returns to `idle`.
 */
export type NativeLaunchMode = "idle" | "watching";

/** The watch's running state between AppState transitions. */
export type NativeLaunchWatchState = {
  mode: NativeLaunchMode;
  /** True once a REAL background transition has been observed this launch. */
  sawBackground: boolean;
};

/** An event the watch reacts to: an AppState change, or the fallback timer. */
export type NativeLaunchWatchEvent =
  | { kind: "appstate"; previous: AppLifecycleState; next: AppLifecycleState }
  | { kind: "timer" };

/** The action to apply, plus the next watch state. */
export type NativeLaunchWatchResult = {
  action: "restore" | "none";
  mode: NativeLaunchMode;
  sawBackground: boolean;
};

const IDLE_RESULT: NativeLaunchWatchResult = {
  action: "none",
  mode: "idle",
  sawBackground: false,
};

/**
 * Decide whether, after launching a native app, the controller should restore
 * the normal ASAM policy now. Pure: same inputs → same output.
 *
 *   - `idle` → ignore everything. No launch is in flight (or the launch already
 *     restored / was superseded), so a leftover timer or an unrelated app
 *     background/return must NOT restore. This is the stale-generation guard at
 *     the pure level: a superseded flow is left in `idle`.
 *   - A real "background" transition means the switch happened; remember it and
 *     keep watching. ("inactive" is only a screen interruption — a notification
 *     banner or Control Center peek — and never counts as leaving, matching
 *     `isAppReentry`'s contract.)
 *   - Returning to "active" after a real background is the re-entry → restore,
 *     and back to `idle`. This fires on ANY observed background→active re-entry
 *     regardless of which launch marked the background (the continuous listener
 *     tracks `previous` across launches), so a re-entry restores exactly once.
 *   - The fallback timer restores ONLY when no background was ever seen (openURL
 *     silently did nothing). If a background WAS seen, the scholar is inside the
 *     other app and the re-entry path owns the restore — restoring here could
 *     re-enter ASAM from the background.
 */
export function decideNativeLaunchWatch(
  state: NativeLaunchWatchState,
  event: NativeLaunchWatchEvent,
): NativeLaunchWatchResult {
  if (state.mode === "idle") return IDLE_RESULT;
  if (event.kind === "timer") {
    return state.sawBackground
      ? { action: "none", mode: "watching", sawBackground: true }
      : { action: "restore", mode: "idle", sawBackground: false };
  }
  const { previous, next } = event;
  if (next === "background") {
    return { action: "none", mode: "watching", sawBackground: true };
  }
  // A direct background→active re-entry, OR a return to active after a
  // background that iOS routed through an intermediate "inactive".
  if (
    isAppReentry(previous, next) ||
    (next === "active" && state.sawBackground)
  ) {
    return { action: "restore", mode: "idle", sawBackground: false };
  }
  return {
    action: "none",
    mode: "watching",
    sawBackground: state.sawBackground,
  };
}

/** Alert title when the app switch failed, naming the app. Sentence case. */
export function openFailedTitle(appName: string): string {
  return `Couldn't open ${appName}`;
}

/**
 * Body when openURL refused. An openURL rejection is NOT proof the app is
 * missing — MDM policy can refuse the same way — so the copy says "may".
 */
export function notInstalledMessage(): string {
  return "It may not be installed on this iPad yet.";
}

/** Body when the Single App Mode exit itself failed, so no switch was tried. */
export function stillLockedMessage(): string {
  return "This iPad's lock didn't release. Try again, or ask a teacher.";
}
