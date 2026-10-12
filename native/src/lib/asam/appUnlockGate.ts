// The READY GATE: is this managed app open-able on this iPad right now, and if
// not, wait (while asking the backend to hurry) until it is.
//
// It replaces the launch-time unlock CEREMONY the client used to drive — read
// the lease status, PATCH an unlock, poll the seven-state availability mirror,
// hand the lease back on abandon. Under the allowlist projection
// (convex/lib/deviceAppProjection.ts) the teacher's grant is the authority and
// the backend reconciler converges each bound device on its own, so the client
// asks for nothing and owns nothing. What is left is one question, asked of the
// device rather than the control plane:
//
//     canOpenURL → true  ⇒ go (warm; the overwhelming majority of taps)
//     canOpenURL → false ⇒ nudge the reconciler, re-ask until true or budget
//
// Deliberately free of React / React-Native / Convex imports — every dependency
// (the OS probe, the nudge, the clock, sleeping, cancellation, progress
// reporting) is injected, so warm / cold / cancel / timeout are unit-testable as
// plain async functions and the provider stays a thin wiring layer.
//
// The gate NEVER touches ASAM and NEVER opens a URL. It runs entirely before
// the handoff, so a cancel or a timeout structurally cannot release Single App
// Mode or launch anything early.

import { OS_READY_INTERVAL_MS, READY_BUDGET_MS } from "./appUnlockPolicy";

/** Everything the gate needs from the outside world. */
export type AppReadyGateDeps = {
  /**
   * The DEVICE's own answer to "can this app be opened right now" —
   * `Linking.canOpenURL` for the tile's scheme. Authoritative and fail-closed:
   * the gate will not report ready until this returns true, because a converged
   * projection is a control-plane fact and this is the only signal that the
   * iPad itself applied the change. Both managed schemes are declared in
   * `LSApplicationQueriesSchemes` (see managedAppSchemes.ts, guarded by its
   * test), so iOS answers rather than refusing, and a `false` genuinely means
   * the app is not open-able yet. Must resolve false rather than throw; a throw
   * is treated as false anyway.
   */
  canOpen: () => Promise<boolean>;
  /**
   * "I just tapped a tile — converge my iPad now"
   * (`deviceAppUnlock:nudgeProjection`). LATENCY ONLY: it decides nothing and
   * grants nothing, and the reconciler's cron would get there without it.
   *
   * Called exactly once and NEVER awaited — see the call site. A rejection is
   * swallowed, and so is a promise that simply never settles, which is the case
   * that matters: a Convex mutation issued while the socket is down stays
   * pending rather than rejecting.
   */
  nudge: () => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Called at most ONCE, the moment iOS says "not yet" — i.e. exactly when this
   * launch becomes a wait the scholar should be told about.
   *
   * Load-bearing for the warm path: the gate says nothing before it has asked,
   * so a tap that opens immediately never mounts a sheet at all. That is the
   * whole difference between a warm launch and a flashed modal.
   */
  onWaiting: () => void;
  /** Polled at every await point; true tears the gate down without side effects. */
  isCancelled: () => boolean;
  /** Override for tests. */
  budgetMs?: number;
  /** Override for tests. */
  probeIntervalMs?: number;
};

export type AppReadyGateResult =
  | { outcome: "ready" }
  | { outcome: "cancelled" }
  /** The budget ran out with iOS still refusing. Retryable. */
  | { outcome: "timeout" };

/**
 * Run the gate.
 *
 *  - WARM: `canOpen` is true on the first ask. No backend call, no sheet, no
 *    sleep — the caller proceeds straight to the handoff.
 *  - COLD: `canOpen` is false, so this iPad's allowlist has not caught up with
 *    the grant. Announce the wait, fire ONE nudge (best-effort), then re-ask on
 *    a fixed short interval and return `ready` the instant it flips.
 *
 * There is one exit condition and it is the device's own: `ready` requires iOS
 * to say the app is open-able. A converged backend that the device has not
 * applied yet keeps waiting, which is the fail-closed direction.
 *
 * The gate's own failure surface: `nudge` rejecting is swallowed by design (see the dep's
 * comment) and `canOpen` throwing is read as "not open-able", so the caller's
 * contract holds for those two: the gate resolves rather than stranding the
 * scholar. The presentation deps (`onWaiting`, `sleep`, `now`) are NOT
 * guarded — they are the caller's own plumbing, and a throw there is a
 * caller bug that should surface loudly, not be swallowed here.
 */
export async function runAppReadyGate(
  deps: AppReadyGateDeps,
): Promise<AppReadyGateResult> {
  const budgetMs = deps.budgetMs ?? READY_BUDGET_MS;
  const intervalMs = deps.probeIntervalMs ?? OS_READY_INTERVAL_MS;
  const deadline = deps.now() + budgetMs;

  if (deps.isCancelled()) return { outcome: "cancelled" };
  if (await probe(deps)) return { outcome: "ready" };
  if (deps.isCancelled()) return { outcome: "cancelled" };

  // Only now is this a wait, and only now does the scholar get told so.
  deps.onWaiting();
  // FIRE AND FORGET — never awaited. A Convex mutation does not always reject
  // when the backend is unreachable: it can sit PENDING while the client
  // reconnects its socket. Awaiting it would therefore stall the probe loop AND
  // the deadline clock below for as long as the connection is wedged, so an
  // iPad that became ready five seconds in would never launch and the retry
  // dialog would never appear. The nudge decides nothing (the reconciler's cron
  // converges this device regardless), so it must not be able to hold up the
  // one thing that does decide: asking iOS.
  void Promise.resolve(deps.nudge()).catch(() => {});

  for (;;) {
    await deps.sleep(intervalMs);
    if (deps.isCancelled()) return { outcome: "cancelled" };
    if (await probe(deps)) return { outcome: "ready" };
    if (deps.isCancelled()) return { outcome: "cancelled" };
    if (deps.now() >= deadline) return { outcome: "timeout" };
  }
}

/** Fail-closed: a probe that throws is "not open-able", never permission to launch. */
async function probe(deps: Pick<AppReadyGateDeps, "canOpen">): Promise<boolean> {
  try {
    return await deps.canOpen();
  } catch {
    return false;
  }
}
