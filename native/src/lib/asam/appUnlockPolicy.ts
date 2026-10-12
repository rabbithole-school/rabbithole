// Copy + thresholds for the COLD-PATH READY SHEET — the only thing that now
// stands between a managed tile tap and the app opening.
//
// ── What this file used to be, and why it shrank ───────────────────────────
// It mirrored the backend's seven-state unlock CEREMONY — a lease the client
// asked for, a warmth margin, a hand-back on abandon, a poll budget — because
// the client DROVE that ceremony: a tap asked the backend to lift this iPad's
// MDM restriction and then waited on the lease it was granted.
//
// Under the allowlist PROJECTION (convex/lib/deviceAppProjection.ts) the
// teacher's grant is the one authority and the reconciler converges each bound
// device on its own, so there is no lease to ask for, hold, or hand back. The
// client's whole remaining job is:
//
//     ask iOS whether the app opens yet → if not, ask the backend to converge
//     sooner, and keep asking iOS until it says yes.
//
// NO React / React-Native / Convex imports — plain functions, unit-tested the
// same way asamDecision.ts and nativeAppLaunch.ts are.
//
// The one property this file still exists to keep honest: the sheet never
// invents a percentage. Its visual estimate tracks elapsed time against the
// backend's normal MDM propagation window, never a hidden MDM stage, and the
// copy says plainly once that estimate has run long.

// ── WHY THERE IS NO LONGER A PHASE ENUM ────────────────────────────────────
// The ceremony's five phases (`preparing`, `asking`, `waiting`, `confirming`,
// `opening`) narrated a multi-step lease negotiation. Four of those steps no
// longer happen, and the fifth — an acknowledgment shown before iOS had been
// asked anything — bought nothing once the first question became a local
// `canOpenURL` rather than a network round trip: rendering it would flash a
// modal for a frame on every warm tap. So the sheet has exactly two states,
// waiting and failed, and it is not mounted at all until iOS has actually said
// "not yet".

/**
 * Total time the sheet waits for this iPad to catch up before offering a retry.
 *
 * Honest accounting, and deliberately generous. The floor is the backend's own
 * `EXPECTED_MDM_PROPAGATION_MS` (15s in convex/deviceAppUnlock.ts) plus the
 * reconciler round trip the tap's nudge kicks off; the ceiling is the backend's
 * `OPERATION_TIMEOUT_MS` (120s), which is far too long to hold a child at a
 * sheet. 75s sits at five propagation windows and half the server's own
 * operation lease — long enough that a converging device is never abandoned one
 * second early, short enough that a genuinely stuck one says so.
 *
 * Giving up here abandons the WAIT, not the work: the projection reconciler
 * keeps converging server-side, so Try again usually resolves warm.
 */
export const READY_BUDGET_MS = 75_000;

/**
 * How often to re-ask iOS. `Linking.canOpenURL` is a local IPC, not a network
 * call, so this is a perceived-latency knob rather than a load one — a quarter
 * second is below the threshold at which the launch reads as laggy, and costs
 * nothing to spend.
 */
export const OS_READY_INTERVAL_MS = 250;

/**
 * How long the copy waits before admitting this is taking a while — set past
 * the normal propagation estimate so the ordinary case never says "longer than
 * usual" while it is, in fact, usual.
 */
export const UNLOCK_SLOW_AFTER_MS = 20_000;

/**
 * The visual wait estimate shown in the sheet.
 *
 * SimpleMDM exposes no fraction-complete, so this is explicitly elapsed time,
 * calibrated one second beyond the backend's `EXPECTED_MDM_PROPAGATION_MS`
 * (15s). It never participates in readiness; this iPad's own `canOpenURL` is
 * the only launch gate.
 */
export const UNLOCK_PROGRESS_ESTIMATE_MS = 16_000;

/** Elapsed share of the normal wait estimate, clamped for rendering. */
export function unlockEstimatedProgress(elapsedMs: number): number {
  return Math.min(1, Math.max(0, elapsedMs) / UNLOCK_PROGRESS_ESTIMATE_MS);
}

/**
 * Sheet headline. Sentence case; the app's real name, never "the app".
 *
 * Neutral by construction: "Getting X ready" describes the outcome the scholar
 * cares about without naming a mechanism — no "unlocking", which would describe
 * a ceremony that no longer runs, and nothing that has to be walked back if the
 * iPad turns out to have been ready all along.
 */
export function unlockHeadline(appName: string): string {
  return `Getting ${appName} ready…`;
}

/**
 * The one honest progress line. No percentage, no invented stages — the wait is
 * an MDM round trip that exposes no fraction-complete, so this says what is
 * actually happening and, past `UNLOCK_SLOW_AFTER_MS`, says it is running long.
 */
export function unlockProgressCopy(elapsedMs: number): string {
  return elapsedMs >= UNLOCK_SLOW_AFTER_MS
    ? "This is taking longer than usual. Still working…"
    : "Waiting for this iPad to allow it…";
}

/**
 * Screen-reader label for the busy region. Carries the app name and the same
 * status the sighted copy does, so nothing is conveyed by the bar alone.
 */
export function unlockAccessibilityLabel(
  appName: string,
  elapsedMs: number,
): string {
  const headline = unlockHeadline(appName).replace(/…$/, "");
  return `${headline}. ${unlockProgressCopy(elapsedMs)}`;
}

/** Failure headline, matching the existing open-failed copy's shape. */
export function unlockFailedTitle(appName: string): string {
  return `Couldn't open ${appName}`;
}

/**
 * Failure body.
 *
 * There is exactly ONE failure now — the budget ran out with iOS still saying
 * no — so there is no reason to discriminate and no backend message to prefer.
 * It says only what is known (this iPad has not caught up yet) and never that
 * the app is missing or that it opened.
 */
export function unlockFailedMessage(appName: string): string {
  return `This iPad hasn't finished getting ${appName} ready. Try again in a moment, or ask a teacher.`;
}
