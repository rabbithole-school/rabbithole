/**
 * How long an app-access change actually takes to reach an iPad, and how far
 * along the one currently in flight is.
 *
 * The "On this iPad" verdict sits at `landing` for a while, and staff had no
 * way to tell a normal wait from a stuck one. These are the real clocks an
 * allowlist change passes through, in order:
 *
 *   1. QUEUED      — the change is recorded but the projector has not PATCHed
 *      the device's dedicated profile yet. Bounded by the 5-minute reconciler
 *      sweep (`PROJECTION_SWEEP_MS`). Prod rows confirm the cadence:
 *      `projectionDueAt - projectionAppliedAt` is exactly 300000 on freshly
 *      applied rows.
 *   2. SENDING     — a PATCH is in flight. SimpleMDM accepts durably and
 *      effectively instantly; prod rows stamp acceptance in the same
 *      millisecond it is requested. The only real bound is the projector's own
 *      operation lease.
 *   3. PROPAGATING — SimpleMDM pushes the profile to the iPad, about
 *      `EXPECTED_MDM_PROPAGATION_MS`.
 *   4. CONFIRMING  — the slow one, and the reason "landing" lingers. The panel
 *      can only PROVE the app is installed from a SimpleMDM inventory
 *      read-back, and that runs on an hourly cron at `:17` UTC
 *      (convex/crons.ts, "refresh SimpleMDM device snapshots"). Verified
 *      against prod on 2026-09-03: every device shared one `installedAppsAt`
 *      of 19:17:39Z — one fleet-wide batch, 52 minutes stale at the time.
 *      So the iPad is usually right long before this panel can say so, and
 *      "Check now" is what ends the wait.
 *
 * Every input is a PROJECTION fact. The device's unlock lease carries its own
 * `mdmAcceptedAt` / `expectedAvailableAt` pair, but the projection deliberately
 * never writes those (see `recordProjectionPatch`), so a leftover lease
 * timestamp would describe an unrelated ceremony rather than the allowlist
 * change being waited on.
 *
 * Pure and dependency-free so the backend, the web console, and any future
 * native surface quote the same numbers instead of each hardcoding a guess.
 */

/** SimpleMDM's push-to-device window, as estimated by the projector. This is
 *  the single definition; `convex/deviceAppUnlock.ts` stamps
 *  `expectedAvailableAt = mdmAcceptedAt + this`. */
export const EXPECTED_MDM_PROPAGATION_MS = 15 * 1_000;

/** The reconciler's sweep interval (convex/crons.ts). A missed hook can only
 *  ever delay convergence by this much. */
export const PROJECTION_SWEEP_MS = 5 * 60 * 1_000;

/** The projector's operation lease: how long one in-flight PATCH may own the
 *  profile before recovery may take it over (convex/deviceAppUnlock.ts). */
export const PROJECTION_OPERATION_TIMEOUT_MS = 120 * 1_000;

/** Minute past the hour, UTC, at which the ONE scheduled SimpleMDM inventory
 *  read-back runs (convex/crons.ts). */
export const INVENTORY_CRON_MINUTE_UTC = 17;

const HOUR_MS = 60 * 60 * 1_000;

/** The next moment the hourly inventory cron will run at or after `now`. */
export function nextInventoryCheckAt(now: number): number {
  const at = new Date(now);
  at.setUTCMinutes(INVENTORY_CRON_MINUTE_UTC, 0, 0);
  const candidate = at.getTime();
  return candidate > now ? candidate : candidate + HOUR_MS;
}

export type LandingPhase = "queued" | "sending" | "propagating" | "confirming";

export type LandingProgress = {
  phase: LandingPhase;
  /** What is happening right now, in one clause. */
  label: string;
  /** How long this step usually takes, stated from the real cadence. */
  typical: string;
  /** 0-100, how far through this step's expected window we are. */
  pct: number;
  /** Milliseconds until this step's expected end; null once it is overdue. */
  etaMs: number | null;
  /** Past its own expected window — the wait is no longer normal. */
  overdue: boolean;
};

export type LandingInput = {
  /**
   * Whether this app's own allowlist entry has reached the live profile yet.
   * `"pending"` is the projector's own word for "desired and applied still
   * disagree", which is precisely what distinguishes a change still waiting to
   * be pushed from one waiting only to be confirmed.
   */
  allowed: "pending" | "settled";
  /** When the in-flight profile operation started, if one is running. */
  operationStartedAt: number | null;
  /**
   * What that operation is. An unlock ceremony and the allowlist projector
   * share one operation clock, so only a `"projection"` token means the
   * allowlist itself is being sent; a ceremony holding the profile leaves the
   * allowlist change queued behind it.
   */
  operationKind: "projection" | "ceremony" | null;
  /** When the projector last successfully PATCHed the profile. */
  projectionAppliedAt: number | null;
  /**
   * When the projector will next reconcile this device. The backend uses `0`
   * as "run immediately", not as a 1970 deadline.
   */
  projectionDueAt: number | null;
  /** When SimpleMDM last inventoried this iPad's installed apps. */
  installedCheckedAt: number | null;
  now: number;
};

function clampPct(elapsed: number, total: number): number {
  if (!Number.isFinite(elapsed) || !Number.isFinite(total) || total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
}

/**
 * Which clock the in-flight change is on, and how far through it is.
 *
 * Deliberately never reports "done": this describes a change the caller has
 * already decided is still landing. The verdict itself stays derived from the
 * four stored facts, not from a countdown.
 */
export function landingProgress(input: LandingInput): LandingProgress {
  const {
    allowed,
    operationStartedAt,
    operationKind,
    projectionAppliedAt,
    projectionDueAt,
    installedCheckedAt,
    now,
  } = input;

  // 1. A projection PATCH is in flight right now. Its only real bound is the
  //    lease. A ceremony token is someone else holding the profile, which
  //    leaves this change queued rather than sending.
  if (operationStartedAt !== null && operationKind === "projection") {
    const total = PROJECTION_OPERATION_TIMEOUT_MS;
    const elapsed = Math.max(0, now - operationStartedAt);
    const overdue = elapsed >= total;
    return {
      phase: "sending",
      label: "Sending the new allowlist to SimpleMDM",
      typical: "SimpleMDM normally accepts this within a second.",
      pct: clampPct(elapsed, total),
      etaMs: overdue ? null : total - elapsed,
      overdue,
    };
  }

  // 2. Recorded, but this app is not in the live profile yet: the projector has
  //    not run. The sweep is the backstop, so that is the honest bound.
  if (allowed === "pending") {
    // `0` (or any nonpositive value) is the backend's "run immediately" kick,
    // set the instant a change is recorded — not a deadline already missed.
    const kickedNow = projectionDueAt === null || projectionDueAt <= 0;
    const dueAt = kickedNow ? now + PROJECTION_SWEEP_MS : projectionDueAt;
    const startedAt = kickedNow
      ? now
      : Math.min(projectionAppliedAt ?? dueAt - PROJECTION_SWEEP_MS, now);
    const total = Math.max(1, dueAt - startedAt);
    const elapsed = Math.max(0, now - startedAt);
    const overdue = now >= dueAt;
    return {
      phase: "queued",
      label: "Waiting for the projector to push the new allowlist",
      typical: `The projector reconciles every ${Math.round(PROJECTION_SWEEP_MS / 60_000)} minutes.`,
      pct: clampPct(elapsed, total),
      etaMs: overdue ? null : dueAt - now,
      overdue,
    };
  }

  // 3. In the live profile; SimpleMDM is pushing it to the iPad.
  if (projectionAppliedAt !== null && now < projectionAppliedAt + EXPECTED_MDM_PROPAGATION_MS) {
    const total = EXPECTED_MDM_PROPAGATION_MS;
    const elapsed = Math.max(0, now - projectionAppliedAt);
    return {
      phase: "propagating",
      label: "SimpleMDM is pushing the profile to the iPad",
      typical: `This usually takes about ${Math.round(EXPECTED_MDM_PROPAGATION_MS / 1_000)} seconds.`,
      pct: clampPct(elapsed, total),
      etaMs: total - elapsed,
      overdue: false,
    };
  }

  // 4. The iPad should have it; we are waiting for proof. This is the long one.
  const nextCheck = nextInventoryCheckAt(now);
  const since = installedCheckedAt ?? nextCheck - HOUR_MS;
  const total = Math.max(1, nextCheck - since);
  const elapsed = Math.max(0, now - since);
  return {
    phase: "confirming",
    label: "The iPad should have it — waiting for SimpleMDM to confirm",
    typical:
      "Installed apps are only re-read once an hour, so this panel can lag the iPad. Check now asks immediately.",
    pct: clampPct(elapsed, total),
    etaMs: nextCheck - now,
    overdue: false,
  };
}

/** "in about 4 minutes" / "in under a minute" — a short, honest ETA. */
export function etaLabel(etaMs: number | null): string {
  if (etaMs === null) return "overdue";
  if (etaMs < 60_000) return `in ${Math.max(1, Math.round(etaMs / 1_000))}s`;
  const minutes = Math.round(etaMs / 60_000);
  if (minutes < 60) return `in about ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hr`;
}
