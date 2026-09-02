// Pure decision logic + copy for DYNAMIC APP UNLOCKING — the gate that runs
// BEFORE the existing ASAM release / openURL handoff in nativeAppLaunch.ts.
//
// The problem it solves: Google Sheets and LEGO SPIKE stay INSTALLED on a
// managed iPad but are normally hidden and blocked by MDM, so a scholar tapping
// their Rabbithole tile would hit a refused openURL. The launcher first asks the
// backend to lift that restriction for THIS iPad and THIS app, waits for MDM to
// accept the change, and only then does the existing handoff run.
//
// NO React / React-Native / Convex imports — plain functions, unit-tested the
// same way asamDecision.ts and nativeAppLaunch.ts are.
//
// Two properties this file exists to keep honest:
//   • The gate NEVER reports "ready" on a guess. Readiness requires both the
//     backend's accepted status and a positive `Linking.canOpenURL` result.
//     Both managed schemes are declared in `LSApplicationQueriesSchemes`, so a
//     false result keeps the app locked and the handoff fails closed.
//   • The progress copy never invents a percentage. The modal's visual estimate
//     tracks elapsed time against the normal MDM wait, not hidden MDM stages,
//     and the copy says plainly when the estimate runs long.

/**
 * The MDM control-plane state of one app on one managed iPad, mirroring the
 * backend's `deviceAppUnlock` status contract exactly:
 *
 *  - `locked` — hidden/blocked, or no request has been made. COLD path.
 *  - `expired-awaiting-reconcile` — the lease ran out; the relock backstop has
 *    not caught up yet. Treated as cold, and never as ready.
 *  - `mdm-error` — the last PATCH did not land. Retryable.
 *  - `mdm-patch-in-flight` / `awaiting-mdm-acceptance` — a PATCH is already
 *    moving. Wait on it; do NOT issue a second one.
 *  - `mdm-accepted-propagating` — SimpleMDM accepted the PATCH but the
 *    propagation estimate has not elapsed. Still waiting.
 *  - `expected-from-mdm-acceptance` — accepted AND the propagation estimate
 *    elapsed. This is the ONLY value the client treats as ready, and even it is
 *    a control-plane expectation, not proof that iOS will honour the launch.
 *  - `not-configured` — this iPad has no dedicated profile, so the unlock system
 *    does not mediate its launches AT ALL. Not a lease state; the absence of the
 *    whole mechanism. See `decideUnlockEntry`.
 */
export type AppUnlockAvailability =
  | "locked"
  | "expired-awaiting-reconcile"
  | "mdm-error"
  | "mdm-patch-in-flight"
  | "awaiting-mdm-acceptance"
  | "expected-from-mdm-acceptance"
  | "mdm-accepted-propagating"
  | "not-configured";

/** One status reading from the backend. */
export type AppUnlockStatus = {
  desiredState: "locked" | "unlocked";
  availability: AppUnlockAvailability;
  /**
   * Epoch ms at which the current unlock lease expires, or null when there is
   * none. The backend owns expiry (the one-hour lease plus its relock cron);
   * the client only reads it so it never launches into an imminent relock.
   */
  expiresAt: number | null;
  mdmAcceptedAt: number | null;
  expectedAvailableAt: number | null;
};

/** What the launcher should do given a status reading. */
export type UnlockEntryDecision =
  | "launch-now" // a warm lease with room to spare
  | "request-unlock" // cold (or a previous failure worth retrying)
  | "await-unlock" // a PATCH is already moving — wait, don't re-PATCH
  | "launch-unmediated"; // no unlock system on this iPad — just launch it

/**
 * A lease with less than this left is treated as cold. Launching on the last
 * second of a lease risks the relock backstop pulling the app while the scholar
 * is mid-switch, which reads as "the app closed itself".
 */
export const LEASE_SAFETY_MARGIN_MS = 20_000;

/** True when a lease is live enough to launch straight into. */
export function isLeaseWarm(
  status: Pick<AppUnlockStatus, "desiredState" | "availability" | "expiresAt">,
  now: number,
): boolean {
  if (status.desiredState !== "unlocked") return false;
  // Anything short of `expected-from-mdm-acceptance` is still in flight — a
  // lease exists but the change is not expected on the device yet.
  if (status.availability !== "expected-from-mdm-acceptance") return false;
  if (status.expiresAt === null) return false;
  return status.expiresAt - now > LEASE_SAFETY_MARGIN_MS;
}

/**
 * True while a PATCH this client should wait on is already moving.
 *
 * `expected-from-mdm-acceptance` is deliberately absent: it is the terminal
 * state, so a reading that lands there is either warm (handled above) or a
 * lease too close to expiry to launch into — and the latter wants a refresh,
 * not a wait.
 */
function isUnlockInFlight(status: AppUnlockStatus): boolean {
  if (status.availability === "mdm-patch-in-flight") return true;
  if (status.desiredState !== "unlocked") return false;
  return (
    status.availability === "awaiting-mdm-acceptance" ||
    status.availability === "mdm-accepted-propagating"
  );
}

/**
 * True when this iPad's launches are not mediated by the unlock system at all.
 *
 * Distinct from every other reading, which describes the state of an unlock ON a
 * mediated device. Here there is no dedicated profile: the iPad's allowlist comes
 * from the group MDM profile, which permanently allows these apps, so a launch
 * needs nothing from this system and must not be gated on it. Deliberately NOT
 * "warm": there is no lease, nothing to hand back, and nothing to relock.
 */
export function isUnmediatedDevice(
  status: Pick<AppUnlockStatus, "availability">,
): boolean {
  return status.availability === "not-configured";
}

/**
 * Decide the entry path from the first status reading. Pure: same inputs → same
 * output.
 *
 * `launch-unmediated` is checked FIRST and reads only `availability`: the
 * backend sends a neutral `desiredState: "locked"` alongside it, and treating
 * that as lease state would misclassify the whole fleet as cold and send every
 * launch through an unlock that cannot exist.
 *
 * An unlock whose lease is nearly spent falls through to `request-unlock`,
 * which is also the refresh path.
 */
export function decideUnlockEntry(
  status: AppUnlockStatus,
  now: number,
): UnlockEntryDecision {
  if (isUnmediatedDevice(status)) return "launch-unmediated";
  if (isLeaseWarm(status, now)) return "launch-now";
  if (isUnlockInFlight(status)) return "await-unlock";
  return "request-unlock";
}

/** The outcome of one poll of the backend while the modal is up. */
export type UnlockPollOutcome = "ready" | "waiting" | "failed" | "timeout";

/**
 * Decide whether the wait is over.
 *
 * `ready` is granted ONLY for the backend's own terminal unlocked value, never
 * inferred from elapsed time. `timeout` wins over `waiting` so a PATCH that
 * never lands still resolves the modal instead of spinning forever.
 *
 * `not-configured` is NOT this function's to judge, and the caller must not let
 * it get here: a `not-configured` reading is `desiredState: "locked"` with no
 * in-flight PATCH, which the rules below would classify as a retryable FAILURE.
 * That would put a failure modal in front of a launch that needs no unlock and
 * make the scholar press Try again to reach a bypass. `runAppUnlockGate` checks
 * `isUnmediatedDevice` on every reading, before calling this, for exactly that
 * reason.
 */
export function decideUnlockPoll(
  status: AppUnlockStatus,
  args: { elapsedMs: number; budgetMs: number },
): UnlockPollOutcome {
  if (
    status.desiredState === "unlocked" &&
    status.availability === "expected-from-mdm-acceptance"
  ) {
    return "ready";
  }
  if (status.availability === "mdm-error") return "failed";
  // Our unlock was superseded (another app took the single per-device slot) or
  // the lease lapsed underneath us. Retryable, but not something to wait out.
  if (status.desiredState === "locked" && status.availability !== "mdm-patch-in-flight") {
    return "failed";
  }
  if (args.elapsedMs >= args.budgetMs) return "timeout";
  return "waiting";
}

/**
 * Poll spacing. Starts tight (the PATCH itself is often accepted in a couple of
 * seconds) and eases off so the propagation wait does not hammer the backend.
 * The backend's propagation estimate is ~15s, which this schedule covers in
 * about 14 reads.
 */
export function nextUnlockPollDelayMs(attempt: number): number {
  if (attempt <= 0) return 400;
  if (attempt <= 2) return 700;
  if (attempt <= 5) return 1_000;
  return 1_500;
}

/**
 * Total time the modal will wait on the BACKEND before offering a retry.
 *
 * Honest accounting: this is deliberately SHORTER than the backend's own
 * operation lease (`OPERATION_TIMEOUT_MS`, 120s). Holding a child at a spinner
 * for two minutes is not acceptable, and giving up early is safe because it
 * abandons the wait, not the work — the PATCH keeps running server-side, and a
 * retry re-reads the status and takes the `await-unlock` path, joining the
 * in-flight operation instead of stacking a second PATCH.
 *
 * Worst-case total time behind the modal is this plus `OS_READY_BUDGET_MS`,
 * since OS readiness is confirmed after the backend reports ready.
 */
export const UNLOCK_BUDGET_MS = 50_000;

/**
 * How long the copy waits before admitting this is taking a while — set past
 * the normal propagation estimate so the ordinary case never says "longer than
 * usual" while it is, in fact, usual.
 */
export const UNLOCK_SLOW_AFTER_MS = 20_000;

/**
 * The visual wait estimate shown in the modal.
 *
 * SimpleMDM exposes no fraction-complete, so this is explicitly elapsed time,
 * calibrated one second beyond the backend's normal 15-second propagation
 * estimate. It never participates in readiness; the fail-closed status and
 * `Linking.canOpenURL` checks remain the only launch gate.
 */
export const UNLOCK_PROGRESS_ESTIMATE_MS = 16_000;

/** Elapsed share of the normal wait estimate, clamped for rendering. */
export function unlockEstimatedProgress(elapsedMs: number): number {
  return Math.min(1, Math.max(0, elapsedMs) / UNLOCK_PROGRESS_ESTIMATE_MS);
}

/** Which sentence the modal is currently telling the truth with. */
export type UnlockPhase =
  | "preparing"
  | "asking"
  | "waiting"
  | "confirming"
  | "opening";

/** Modal headline. Sentence case; the app's real name, never "the app". */
export function unlockHeadline(appName: string, phase: UnlockPhase): string {
  return phase === "preparing" || phase === "opening"
    ? `Opening ${appName}…`
    : `Unlocking ${appName}…`;
}

/**
 * The one honest progress line. No percentage, no fake stages — an MDM round
 * trip exposes no fraction-complete, so this says what is actually happening
 * and, past `UNLOCK_SLOW_AFTER_MS`, says that it is running long.
 */
export function unlockProgressCopy(phase: UnlockPhase, elapsedMs: number): string {
  if (phase === "preparing") return "Getting things ready…";
  if (phase === "opening") return "Almost there — opening it now.";
  if (elapsedMs >= UNLOCK_SLOW_AFTER_MS) {
    return "This is taking longer than usual. Still working…";
  }
  if (phase === "confirming") return "Almost ready — checking this iPad…";
  return phase === "asking"
    ? "Asking this iPad for permission…"
    : "Waiting for this iPad to allow it…";
}

/**
 * Screen-reader label for the busy region. Carries the app name and the same
 * status the sighted copy does, so nothing is conveyed by the spinner alone.
 */
export function unlockAccessibilityLabel(
  appName: string,
  phase: UnlockPhase,
  elapsedMs: number,
): string {
  const headline = unlockHeadline(appName, phase).replace(/…$/, "");
  return `${headline}. ${unlockProgressCopy(phase, elapsedMs)}`;
}

/** Failure headline, matching the existing open-failed copy's shape. */
export function unlockFailedTitle(appName: string): string {
  return `Couldn't open ${appName}`;
}

/** Why an unlock attempt ended without the app being open-able. */
export type UnlockFailureReason = "failed" | "timeout" | "os-unavailable";

/** How a managed launch attempt ended, from the unlock lease's point of view. */
export type UnlockExit =
  /** The app was actually handed off to. The lease is in use — leave it alone. */
  | "launched"
  /** The scholar backed out, the OS never agreed, or a newer tap superseded this one. */
  | "abandoned";

/**
 * Should this launch hand its unlock lease back to the idle clock?
 *
 * The hazard this closes: `requestUnlock` arms a lease for the full
 * active-session failsafe (hours), on the assumption a scholar is about to use
 * the app. If the launch then ends without ever reaching the app — Cancel, the
 * OS never confirming, a newer tap superseding this one — nothing on the device
 * is using Sheets, yet it stays de-allowlisted until that long cap expires. The
 * backend's relock reconciler reads `expiresAt` only, so nothing else shortens
 * it.
 *
 * Handing back means the fire-and-forget return signal (one hour of idle lease,
 * no MDM PATCH), never a synchronous lock: locking here would PATCH the profile,
 * stall the Cancel tap, and cost the scholar a full cold unlock on their next
 * attempt seconds later.
 *
 * Only worth doing when this launch actually asked for an unlock. A tap that
 * never got that far has no lease of its own to give back.
 */
export function shouldHandBackUnlockLease(input: {
  /** True once `requestUnlock` was issued for this launch. */
  unlockRequested: boolean;
  exit: UnlockExit;
}): boolean {
  return input.unlockRequested && input.exit === "abandoned";
}

/**
 * The iPad that has handed off (or is about to hand off) to a managed app,
 * remembered until the scholar comes back.
 *
 * `launchGen` is the launch that recorded it, so a superseded flow cleaning up
 * after itself cannot swallow a NEWER launch's pending return.
 */
export type PendingUnlockHandoff = {
  deviceId: string;
  leaseToken: string;
  launchGen: number;
};

/**
 * Take the pending handoff, if it is ours to take.
 *
 * Timing is the whole point. The record must be written BEFORE the app switch
 * is requested, not after `openURL` resolves: iOS can background and re-activate
 * Rabbithole faster than that promise settles, and the re-entry path restores
 * ASAM and reads this record synchronously. A record written afterwards is not
 * there yet when that happens, the return signal is silently skipped, and the
 * app stays de-allowlisted for the full active-session failsafe with nobody
 * using it. Recording early is safe in the other direction because every path
 * that ends without a switch claims it back (see the `onlyLaunchGen` guard).
 *
 * Returns the lease identity to signal (or null) and the record to keep.
 */
export function claimUnlockHandoff(
  pending: PendingUnlockHandoff | null,
  options: { onlyLaunchGen?: number } = {},
): {
  target: Pick<PendingUnlockHandoff, "deviceId" | "leaseToken"> | null;
  next: PendingUnlockHandoff | null;
} {
  if (!pending) return { target: null, next: null };
  if (
    options.onlyLaunchGen !== undefined &&
    options.onlyLaunchGen !== pending.launchGen
  ) {
    // A newer launch owns this record. Leave it exactly where it is.
    return { target: null, next: pending };
  }
  return {
    target: { deviceId: pending.deviceId, leaseToken: pending.leaseToken },
    next: null,
  };
}

/**
 * Failure body. Prefers the backend's scholar-safe message; otherwise says only
 * what is known — the iPad did not unlock — and never that the app is missing
 * or that it opened.
 */
export function unlockFailedMessage(
  appName: string,
  reason: UnlockFailureReason,
  backendMessage?: string | null,
): string {
  const trimmed = backendMessage?.trim();
  if (trimmed) return trimmed;
  if (reason === "os-unavailable") {
    // The control plane accepted the change but this iPad has not applied it.
    // Say exactly that, and do not imply the app is gone or that it opened.
    return `This iPad hasn't finished unlocking ${appName}. Try again in a moment, or ask a teacher.`;
  }
  return reason === "timeout"
    ? `This iPad hasn't unlocked ${appName} yet. Try again, or ask a teacher.`
    : `This iPad couldn't unlock ${appName}. Try again, or ask a teacher.`;
}

/**
 * How long to wait for iOS itself to report the app launchable, once the
 * backend says the MDM change landed.
 *
 * FAIL-CLOSED, and that is the point. MDM acceptance is a control-plane fact:
 * SimpleMDM took the profile and the propagation estimate elapsed. It is not
 * proof that THIS iPad applied it. `Linking.canOpenURL` is the device's own
 * answer, and for these two schemes it is trustworthy in both directions
 * because both are declared in `LSApplicationQueriesSchemes` (see
 * managedAppSchemes.ts, guarded by its test) — iOS only refuses to answer for
 * schemes missing from that allowlist. So a `false` here means the app really
 * is not open-able yet, and the launch must NOT proceed.
 *
 * On expiry the scholar gets Try again / Cancel; ASAM stays armed and nothing
 * is opened.
 */
export const OS_READY_BUDGET_MS = 10_000;
export const OS_READY_INTERVAL_MS = 250;
