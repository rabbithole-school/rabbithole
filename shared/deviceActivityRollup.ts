// Pure roll-up of `deviceActivityEvents` rows into one scholar-day of screen
// time. No Convex or DOM imports (see shared/deviceActivityRollup.test.ts).
//
// ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
// Until now the only usage figure Rabbithole could produce was reconstructed
// from message timestamps — which counts a scholar who is thinking as absent
// and a scholar who left the iPad open as present. This roll-up consumes real
// lifecycle events instead, and its whole job is to be HONEST about the
// difference between a minute it measured and a minute it inferred.
//
// ── THE ESTIMATE RULE (the founder's data-cleaning rule) ───────────────────
// Rabbithole is the launcher for teacher-authorized external apps. It emits an
// `external_launch` the instant it hands the iPad to another app, and an
// `external_return` on the first foreground after that. When both exist and are
// close enough together, the gap between them is MEASURED time in that app.
//
// But an iPad that goes from an external app straight to locked — the ordinary
// end of a school day — produces a launch with no return until the next
// morning. Attributing that whole gap would book fourteen hours of "LEGO SPIKE"
// against a nine-year-old, which is not a rounding error; it is a fabricated
// claim in a report that parents may eventually read.
//
// So: an `external_launch` whose return does not arrive within
// EXTERNAL_RETURN_WINDOW_MS contributes a CAPPED
// UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS instead of the real gap, and the
// interval is counted in `estimatedIntervals`. Estimated milliseconds are
// tracked in their own fields at every level of the output, never summed into
// the measured ones, so any surface built on this can say "38 minutes measured,
// 10 estimated" rather than implying it knows 48.
//
// ── THE THREE CONSTANTS ────────────────────────────────────────────────────
// Each is a single documented constant precisely so the estimate stays
// auditable — change it here and every number moves together.

/**
 * How long after an `external_launch` a return still counts as measuring that
 * app's session. Three hours comfortably covers the longest plausible single
 * stretch in a teacher-authorized app during a school day, while excluding the
 * overnight and weekend gaps that the rule exists to catch.
 */
export const EXTERNAL_RETURN_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * What an unreturned `external_launch` is worth. Ten minutes: enough to
 * acknowledge that the scholar really did open the app and did something in it,
 * small enough that a day full of unreturned launches cannot masquerade as a
 * day of measured work. ALWAYS booked as estimated, never as measured.
 */
export const UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS = 10 * 60 * 1000;

/**
 * The most time one foreground event may vouch for. The client heartbeats every
 * 60 seconds while foregrounded, so a gap larger than this means heartbeats
 * were lost (offline, killed, battery) and the intervening minutes are NOT
 * evidence of presence. The excess falls into the unattributed background
 * bucket rather than being invented as foreground or as an estimate.
 */
export const FOREGROUND_PRESENCE_GAP_MS = 5 * 60 * 1000;

export type DeviceActivityKind =
  | "app_foreground"
  | "app_background"
  | "heartbeat"
  | "external_launch"
  | "external_return"
  // Diagnostics, not usage (TRA-331): see USAGE_KINDS below.
  | "app_stuck_inactive"
  | "app_stuck_inactive_end"
  | "asam_enter"
  | "asam_exit";

/**
 * The kinds that describe WHERE THE SCHOLAR'S TIME WENT. Everything else in
 * the table is a diagnostic (a stuck-inactive report, a Rabbithole Lock
 * transition) and is dropped before pairing: the roll-up books every gap by
 * the kind of the event that opens it, so a diagnostic row landing between a
 * foreground and its heartbeat would otherwise split a measured span and move
 * the day's numbers.
 */
const USAGE_KINDS: ReadonlySet<DeviceActivityKind> = new Set([
  "app_foreground",
  "app_background",
  "heartbeat",
  "external_launch",
  "external_return",
]);

/** The minimal event shape the roll-up needs (a subset of the stored row). */
export type RollupEvent = {
  kind: DeviceActivityKind;
  clientAt: number;
  /** Set on `external_launch` (and echoed on its `external_return`). */
  externalAppId?: string | null;
  /** Server-derived tag; see shared/deviceActivityContext.ts. */
  context: string;
};

export type MeasuredEstimated = { measuredMs: number; estimatedMs: number };

export type AppRollup = MeasuredEstimated & {
  externalAppId: string;
  /** How many launches in this app were capped rather than measured. */
  estimatedIntervals: number;
};

export type DeviceActivityDayRollup = {
  /** Rabbithole itself in the foreground. Always measured. */
  foregroundMs: number;
  /** Per external app, ordered by total attributed time descending. */
  apps: AppRollup[];
  /**
   * Time inside the day's span that we decline to attribute to anything:
   * observed backgrounded stretches, plus the portion of a heartbeat gap or an
   * unreturned launch that the caps refuse to claim.
   */
  unattributedBackgroundMs: number;
  /** Totals across foreground + every app. */
  totals: MeasuredEstimated;
  /** Totals split by the server-derived context tag. */
  byContext: Record<string, MeasuredEstimated>;
  /** Total capped intervals across every app — the "data not available" count. */
  estimatedIntervals: number;
  eventCount: number;
};

function emptyBucket(): MeasuredEstimated {
  return { measuredMs: 0, estimatedMs: 0 };
}

const FOREGROUND_KINDS: ReadonlySet<DeviceActivityKind> = new Set([
  "app_foreground",
  "heartbeat",
  "external_return",
]);

/**
 * Roll one scholar-day of events into measured/estimated screen time.
 *
 * Pair-based rather than a long-lived state machine: every span of time is the
 * gap between two ADJACENT events, and the earlier event's kind alone decides
 * what that span means. That keeps a lost or duplicated event local — it can
 * mis-classify one gap, never desynchronize the rest of the day.
 *
 * Events may arrive in any order (the client batches, and batches can retry);
 * they are sorted here. Duplicate rows for the same instant are harmless: a
 * zero-length gap contributes nothing.
 */
export function rollupDeviceActivityDay(
  events: readonly RollupEvent[],
): DeviceActivityDayRollup {
  const ordered = events
    .filter((event) => USAGE_KINDS.has(event.kind))
    .sort((a, b) => a.clientAt - b.clientAt);
  const byContext: Record<string, MeasuredEstimated> = {};
  const apps = new Map<string, AppRollup>();
  let foregroundMs = 0;
  let unattributedBackgroundMs = 0;
  let estimatedIntervals = 0;

  const contextBucket = (context: string): MeasuredEstimated => {
    let bucket = byContext[context];
    if (!bucket) {
      bucket = emptyBucket();
      byContext[context] = bucket;
    }
    return bucket;
  };

  const appBucket = (externalAppId: string): AppRollup => {
    let bucket = apps.get(externalAppId);
    if (!bucket) {
      bucket = {
        externalAppId,
        measuredMs: 0,
        estimatedMs: 0,
        estimatedIntervals: 0,
      };
      apps.set(externalAppId, bucket);
    }
    return bucket;
  };

  /** Book one unreturned launch: a capped estimate, plus the honest residual. */
  const bookUnreturnedLaunch = (
    event: RollupEvent,
    observedGapMs: number | null,
  ) => {
    estimatedIntervals += 1;
    contextBucket(event.context).estimatedMs +=
      UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS;
    if (event.externalAppId) {
      const bucket = appBucket(event.externalAppId);
      bucket.estimatedMs += UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS;
      bucket.estimatedIntervals += 1;
    }
    // The rest of the gap is time we watched pass and refuse to claim. An
    // open-ended launch (no successor at all) has no measured residual.
    if (observedGapMs !== null) {
      unattributedBackgroundMs += Math.max(
        0,
        observedGapMs - UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
      );
    }
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index];
    const next = index + 1 < ordered.length ? ordered[index + 1] : null;
    const gapMs = next ? Math.max(0, next.clientAt - event.clientAt) : null;

    if (event.kind === "external_launch") {
      // Measured only when the scholar came back, and came back soon enough.
      const returned =
        next !== null &&
        gapMs !== null &&
        gapMs <= EXTERNAL_RETURN_WINDOW_MS &&
        (next.kind === "external_return" || FOREGROUND_KINDS.has(next.kind));
      if (returned && gapMs !== null) {
        contextBucket(event.context).measuredMs += gapMs;
        if (event.externalAppId) appBucket(event.externalAppId).measuredMs += gapMs;
      } else {
        bookUnreturnedLaunch(event, gapMs);
      }
      continue;
    }

    if (gapMs === null) continue; // trailing non-launch event closes the day

    if (FOREGROUND_KINDS.has(event.kind)) {
      const measured = Math.min(gapMs, FOREGROUND_PRESENCE_GAP_MS);
      foregroundMs += measured;
      contextBucket(event.context).measuredMs += measured;
      unattributedBackgroundMs += gapMs - measured;
      continue;
    }

    // app_background: the whole span is off-task-or-elsewhere, unattributed.
    unattributedBackgroundMs += gapMs;
  }

  const appList = [...apps.values()].sort(
    (a, b) =>
      b.measuredMs + b.estimatedMs - (a.measuredMs + a.estimatedMs) ||
      a.externalAppId.localeCompare(b.externalAppId),
  );

  const totals = Object.values(byContext).reduce<MeasuredEstimated>(
    (acc, bucket) => ({
      measuredMs: acc.measuredMs + bucket.measuredMs,
      estimatedMs: acc.estimatedMs + bucket.estimatedMs,
    }),
    emptyBucket(),
  );

  return {
    foregroundMs,
    apps: appList,
    unattributedBackgroundMs,
    totals,
    byContext,
    estimatedIntervals,
    eventCount: ordered.length,
  };
}

/** Milliseconds → minutes, one decimal place. The reporting unit. */
export function msToMinutes(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10;
}
