// The dynamic-unlock GATE: ask the backend to lift this managed iPad's MDM
// restriction on one app, then wait for it to report the change accepted.
//
// Deliberately free of React / React-Native / Convex imports — every dependency
// (the backend gateway, the clock, sleeping, cancellation, progress reporting)
// is injected, so the cold / warm / failure / cancel paths are unit-testable as
// plain async functions and the provider stays a thin wiring layer.
//
// The gate NEVER touches ASAM and NEVER opens a URL. It runs entirely before
// the existing handoff, so a cancel, a timeout, or a failure structurally
// cannot release Single App Mode or launch anything early.

import {
  decideUnlockEntry,
  decideUnlockPoll,
  isUnmediatedDevice,
  nextUnlockPollDelayMs,
  OS_READY_BUDGET_MS,
  OS_READY_INTERVAL_MS,
  UNLOCK_BUDGET_MS,
  type AppUnlockStatus,
  type UnlockFailureReason,
  type UnlockPhase,
} from "./appUnlockPolicy";

/**
 * Identifies one app on one managed iPad. Both halves are server-verified: the
 * backend resolves the device claim from `deviceId` and the app key from
 * `externalAppId`, so the client can never name a bundle id, a profile, or
 * another scholar's device.
 */
export type AppUnlockTargetRef<AppId extends string = string> = {
  /** Catalog app (`externalApps`) the tile launches. */
  externalAppId: AppId;
  /** This install's stable device id, matched against the scholar's claim. */
  deviceId: string;
  /** Identifies this launch so stale return signals cannot alter a newer lease. */
  leaseToken: string;
};

/**
 * The narrow backend surface the gate needs. Implemented over Convex in
 * `native/src/lib/appUnlockClient.ts`; faked directly in tests.
 */
export type AppUnlockGateway<AppId extends string = string> = {
  /**
   * Current MDM state for this app on this iPad. Never mutates. `nowMs` is the
   * client clock the backend validates against its own (it rejects a reading
   * that is wildly skewed rather than trusting it).
   */
  readStatus(
    target: AppUnlockTargetRef<AppId>,
    nowMs: number,
  ): Promise<AppUnlockStatus>;
  /**
   * Ask for an unlock. Idempotent by contract: with a live lease for the same
   * app it returns the current status without issuing a second PATCH.
   */
  requestUnlock(target: AppUnlockTargetRef<AppId>): Promise<AppUnlockStatus>;
};

/** Everything the gate needs from the outside world. */
export type AppUnlockGateDeps<AppId extends string = string> = {
  gateway: AppUnlockGateway<AppId>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Called whenever the modal's honest progress line should change.
   *
   * Load-bearing for the unmediated path: the gate reports NO phase before it
   * has decided this iPad is unlock-mediated, so the caller's neutral "Opening
   * <app>…" acknowledgment is never upgraded to "Unlocking…" language on an
   * iPad this system does not govern.
   */
  onPhase: (phase: UnlockPhase) => void;
  /** Polled at every await point; true tears the gate down without side effects. */
  isCancelled: () => boolean;
  /**
   * The DEVICE's own answer to "can this app be opened right now" —
   * `Linking.canOpenURL` for the tile's scheme. Authoritative and fail-closed:
   * the gate will not report ready until this returns true, because MDM
   * acceptance is a control-plane fact and this is the only signal that the
   * iPad itself applied the change. Must resolve false rather than throw.
   */
  canOpen: () => Promise<boolean>;
  /** Override for tests. */
  budgetMs?: number;
  /** Override for tests. */
  osReadyBudgetMs?: number;
};

export type AppUnlockGateResult =
  | { outcome: "ready"; warm: boolean }
  /**
   * This iPad has no dedicated profile, so nothing here mediates its launches:
   * the caller must fall straight through to the ORDINARY launch path it uses
   * for any unmanaged app. Not a success and not a failure — the gate simply
   * does not apply. No lease was taken, so there is nothing to hand back.
   */
  | { outcome: "not-configured" }
  | { outcome: "cancelled" }
  | { outcome: "failed"; reason: UnlockFailureReason; message: string | null };

/**
 * Run the gate.
 *
 *  - UNMEDIATED (this iPad has no dedicated profile) resolves with
 *    `not-configured` and touches nothing further: no request, no poll, no OS
 *    probe, and NO phase reported. The caller launches exactly as it would an
 *    unmanaged app. Any reading can reach this — the entry read or a later poll
 *    — and all of them take the same single exit, so an unmediated iPad can
 *    never be routed through a failure modal to get there.
 *  - WARM (a live lease the backend already expects on the device) skips the
 *    unlock PATCH and the propagation wait, but STILL has to clear the OS
 *    readiness check. When `canOpen` is immediately true — the ordinary warm
 *    case — no unlock phase is reported; the caller keeps its short "Opening…"
 *    acknowledgment until the app handoff begins.
 *  - COLD requests an unlock, then polls until the backend reports the MDM
 *    change accepted and propagated, the attempt failed, or the budget runs out.
 *  - An in-flight PATCH is joined WITHOUT requesting, so a double tap or a
 *    second tile cannot stack redundant PATCHes on the same device.
 *
 * Both paths end at the same fail-closed gate: `ready` requires the backend to
 * say the change landed AND the device to say the app is open-able. Anything
 * else resolves as a retryable failure.
 *
 * A thrown backend error is reported as a retryable failure rather than
 * escaping: the caller's contract is that the gate resolves, so the modal can
 * always offer Try again / Cancel instead of stranding the scholar.
 */
export async function runAppUnlockGate<AppId extends string>(
  target: AppUnlockTargetRef<AppId>,
  deps: AppUnlockGateDeps<AppId>,
): Promise<AppUnlockGateResult> {
  const budgetMs = deps.budgetMs ?? UNLOCK_BUDGET_MS;
  const startedAt = deps.now();
  const elapsed = () => deps.now() - startedAt;

  let status: AppUnlockStatus;
  try {
    status = await deps.gateway.readStatus(target, deps.now());
  } catch (error) {
    return failure("failed", error);
  }
  if (deps.isCancelled()) return { outcome: "cancelled" };

  const entry = decideUnlockEntry(status, deps.now());
  // Fleet iPads carry the GROUP MDM profile, which allowlists these apps
  // permanently — the launch was never restricted, so there is nothing to
  // unlock, nothing to wait for, and no lease to take. Bail out BEFORE any
  // request, any poll, and the OS readiness gate: `canOpenURL` here would only
  // re-ask a question the ordinary launch path already handles, and a `false`
  // would turn a working launch into a failure modal.
  if (entry === "launch-unmediated") return { outcome: "not-configured" };
  if (entry === "launch-now") {
    const confirmed = await confirmOsReady(deps, true);
    return confirmed.outcome === "ready"
      ? await claimReadyLease(target, deps, confirmed)
      : confirmed;
  }

  let leaseClaimed = false;
  if (entry === "request-unlock") {
    deps.onPhase("asking");
    try {
      status = await deps.gateway.requestUnlock(target);
      leaseClaimed = true;
    } catch (error) {
      return failure("failed", error);
    }
    if (deps.isCancelled()) return { outcome: "cancelled" };
  } else {
    // Already in flight — join the existing PATCH instead of issuing another.
    deps.onPhase("waiting");
  }

  for (let attempt = 0; ; attempt++) {
    // The same bypass, re-asked on every reading. A binding can disappear
    // underneath a launch (an operator reconfiguring the profile, a claim being
    // removed), and the reading that reports it is indistinguishable from a
    // plain relock to `decideUnlockPoll` — it would resolve `failed`, show a
    // failure modal, and make the scholar press Try again to reach a bypass the
    // gate can take right here. Resolving directly keeps ONE exit for the
    // unmediated case, whichever reading discovers it.
    if (isUnmediatedDevice(status)) return { outcome: "not-configured" };
    const verdict = decideUnlockPoll(status, { elapsedMs: elapsed(), budgetMs });
    if (verdict === "ready") {
      const confirmed = await confirmOsReady(deps, false);
      if (confirmed.outcome !== "ready" || leaseClaimed) return confirmed;
      return await claimReadyLease(target, deps, confirmed);
    }
    if (verdict === "failed") return { outcome: "failed", reason: "failed", message: null };
    if (verdict === "timeout") return { outcome: "failed", reason: "timeout", message: null };

    deps.onPhase("waiting");
    await deps.sleep(nextUnlockPollDelayMs(attempt));
    if (deps.isCancelled()) return { outcome: "cancelled" };

    try {
      status = await deps.gateway.readStatus(target, deps.now());
    } catch (error) {
      return failure("failed", error);
    }

    if (deps.isCancelled()) return { outcome: "cancelled" };
  }
}

/**
 * Warm and joined launches did not issue the original profile PATCH. Claim the
 * live lease for this exact handoff before ASAM can be released. The backend
 * refresh is idempotent and does not PATCH MDM for the same active app.
 */
async function claimReadyLease<AppId extends string>(
  target: AppUnlockTargetRef<AppId>,
  deps: AppUnlockGateDeps<AppId>,
  ready: Extract<AppUnlockGateResult, { outcome: "ready" }>,
): Promise<AppUnlockGateResult> {
  let status: AppUnlockStatus;
  try {
    status = await deps.gateway.requestUnlock(target);
  } catch (error) {
    return failure("failed", error);
  }
  if (deps.isCancelled()) return { outcome: "cancelled" };
  return decideUnlockPoll(status, { elapsedMs: 0, budgetMs: 1 }) === "ready"
    ? ready
    : { outcome: "failed", reason: "failed", message: null };
}

/**
 * The fail-closed OS check. The backend has said the MDM change landed; this
 * asks the iPad whether it agrees, and only a `true` produces `ready`.
 *
 * The first attempt runs BEFORE any unlock phase is reported. The caller may
 * still show a short "Opening…" acknowledgment for the whole handoff. Only once
 * the device says "not yet" does the gate announce that it is waiting.
 */
async function confirmOsReady<AppId extends string>(
  deps: AppUnlockGateDeps<AppId>,
  warm: boolean,
): Promise<AppUnlockGateResult> {
  const budgetMs = deps.osReadyBudgetMs ?? OS_READY_BUDGET_MS;
  const deadline = deps.now() + budgetMs;
  for (;;) {
    if (deps.isCancelled()) return { outcome: "cancelled" };
    let open: boolean;
    try {
      open = await deps.canOpen();
    } catch (error) {
      // A dependency that throws is treated as "not open-able" — fail-closed,
      // never as permission to launch.
      void error;
      open = false;
    }
    if (open) return { outcome: "ready", warm };
    if (deps.isCancelled()) return { outcome: "cancelled" };
    if (deps.now() >= deadline) {
      return { outcome: "failed", reason: "os-unavailable", message: null };
    }
    deps.onPhase("confirming");
    await deps.sleep(OS_READY_INTERVAL_MS);
  }
}

/**
 * A thrown transport/backend error becomes a retryable failure with NO message.
 * A raw `Error.message` can carry internal or stack-shaped text, which is not
 * something to put in front of a child, so the caller falls back to
 * `unlockFailedMessage()`'s honest default instead.
 */
function failure(reason: UnlockFailureReason, error: unknown): AppUnlockGateResult {
  void error;
  return { outcome: "failed", reason, message: null };
}
