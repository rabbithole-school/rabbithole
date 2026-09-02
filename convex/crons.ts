import { cronJobs } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Scheduled jobs.
 *
 * Drive push channels expire (Drive caps them at 7 days), and a push ping can
 * occasionally be dropped. Two jobs keep the portfolio ingestion healthy:
 *
 *  - renewDriveWatch (daily): re-registers the changes.watch channel well
 *    before its 7-day expiry, so the printer→portfolio pipe never goes silent.
 *    Iterates every configured institution row (no-op when none).
 *  - driveSafetyNetSync (every 30 min): re-lists each institution's folder and
 *    ingests anything a missed ping left behind. Cheap — it only downloads
 *    files it hasn't already seen (dedupe on driveFileId).
 */
const crons = cronJobs();
const scanDailyRotationAndNotifyRef = makeFunctionReference<
  "action",
  Record<string, never>
>("improvementLoopNotifications:scanDailyRotationAndNotify");
const dispatchRoundsRemindersRef = makeFunctionReference<
  "action",
  Record<string, never>
>("improvementLoopNotifications:dispatchRoundsReminders");
const reconcileActiveAppUnlocksRef = makeFunctionReference<
  "action",
  { nowMs?: number },
  { considered: number; locked: number; authorized: number; failed: number }
>("deviceAppUnlock:reconcileActiveUnlocks");

// Slack gets generic pointers only. The daily action performs the rotating
// Coherence scan before posting, avoiding two independent, race-prone crons.
crons.daily(
  "scan coherence and notify improvement loop",
  { hourUTC: 16, minuteUTC: 15 },
  scanDailyRotationAndNotifyRef,
  {},
);

// Each hourly tick resolves institution-local configured meeting days. Durable
// per-institution + cadence + week markers make each reminder fire once.
crons.hourly(
  "dispatch Rounds reminders",
  { minuteUTC: 0 },
  dispatchRoundsRemindersRef,
  {},
);

// Weekly SEL synthesis batch. Each hourly tick resolves institution-local SEL
// meeting mornings and writes every enrolled scholar's synthesis a few hours
// ahead of the anchor, so the Thursday board reads fresh write-ups. Durable
// per-(institution, week) markers make it fire once per SEL week, for EVERY
// institution with an explicitly configured SEL cadence (multi-tenant). Offset
// off the reminder minute so the two hourly Rounds jobs never tick together.
crons.hourly(
  "dispatch SEL syntheses",
  { minuteUTC: 30 },
  internal.selSynthesisCron.dispatchSelSyntheses,
  {},
);


crons.daily(
  "renew drive watch",
  { hourUTC: 9, minuteUTC: 0 }, // ~23:00 HST
  internal.driveSync.renewAllWatches,
  {}
);

crons.interval(
  "drive safety-net sync",
  { minutes: 30 },
  internal.driveSync.syncAllFolders,
  {}
);

crons.interval(
  "renew Google Docs comment subscriptions",
  { minutes: 15 },
  internal.googleDocsEventsActions.renewExpiringSubscriptions,
  {},
);

/**
 * Auto-materialize the master schedule's CURRENT week into the live push layer.
 * There is no manual "Publish"/"Stamp week" step: a placed grid cell that links
 * an assignment + activity is planned into activitySchedule (setAt null, so it
 * stays invisible to scholars) and the shipped activation job flips it live at
 * its block start time. Write-time reconcile handles every grid edit; this tick
 * is the safety net that rolls the horizon forward as the wall-clock crosses
 * into a new week and self-heals any drift. Idempotent — 15 min is ample.
 */
crons.interval(
  "auto-materialize master schedule week",
  { minutes: 15 },
  internal.masterSchedule.autoMaterializeTick,
  {}
);


/**
 * Mark portfolioItems stuck in pending/extracting/matching past 10 min as
 * `error`. The live feed already hides them after _creationTime > 10min;
 * this just keeps the DB matching what the user sees so the status indexes
 * don't accumulate ghosts from crashed ingest actions.
 */
crons.interval(
  "sweep stale portfolio ingest",
  { minutes: 5 },
  internal.portfolio.sweepStaleProcessing,
  {}
);

/**
 * Post queued activity into each channel's institution-local, current-day EOD
 * thread. Runs ten minutes after the EOD cron's minute so initial finalization
 * wins cleanly; empty intervals and channels without a completed thread no-op.
 */
crons.hourly(
  "flush slack activity updates",
  { minuteUTC: 15 },
  internal.slackNotifications.flushActivityUpdates,
  {}
);

/**
 * End-of-day Slack check-in — one generated hook per group-linked channel,
 * with the AI wrap-up + record-completing questions in its thread. Teacher
 * replies route through slackThreads into the aide tool loop, so answers are
 * recorded, not just read. 00:05 UTC = 2:05 PM HST, the end of the school day.
 * Weekends + zero-activity days skip inside.
 */
crons.daily(
  "end of day slack check-in",
  { hourUTC: 0, minuteUTC: 5 },
  internal.eodCheckin.runDaily,
  {}
);

// Reconcile and retry prior EOD writes independently of today's date key. Slack
// can accept a post while its response is lost, so this worker is deliberately
// paced and lets each check-in's persisted retryAt control the next attempt.
crons.interval(
  "retry end of day slack check-ins",
  { minutes: 5 },
  internal.eodCheckin.runDaily,
  { sweepOnly: true },
);

/**
 * Sweep hour-old Slack event-dedupe rows. Lives on a cron instead of
 * inside claimEvent: the inline sweep's table-head read made concurrent
 * event claims OCC-conflict with each other (the 2026-06-13 prod
 * "too many system operations" storm).
 */
crons.hourly(
  "sweep slack event dedupe rows",
  { minuteUTC: 35 },
  internal.slackBot.sweepEvents,
  {}
);

/**
 * Re-drive bug reports whose at-most-once pipeline action stopped between
 * receipts, and flag exhausted non-terminal reports for platform operators.
 */
crons.interval(
  "sweep stuck bug reports",
  { minutes: 15 },
  internal.bugReports.sweepStuckReports,
  {},
);


/**
 * Sweep abandoned WebAuthn challenge rows (5-min TTL). Challenges are
 * normally consumed one-shot on use, but a dismissed/closed ceremony leaves
 * its row behind — hourly cleanup keeps `webauthnChallenges` bounded.
 */
/**
 * Class Digest auto-generation safety net. Every 5 min, sweep active
 * assignments and (re)generate any per-activity or per-cohort digest
 * that's earned one — catches every completion path (manual mark, AI
 * rubric pass, scanned work, web sessions) without hooking each call
 * site. Threshold + debounce live in maybeAutoGenerate; capped per run.
 */
crons.interval(
  "sweep class digest auto-generation",
  { minutes: 5 },
  internal.classDigests.sweepAutoGenerate,
  {}
);

crons.hourly(
  "sweep expired webauthn challenges",
  { minuteUTC: 50 },
  internal.passkeys.sweepExpiredChallenges,
  {}
);

/**
 * Sweep used/expired passkey enrollment tokens (7-day TTL). Consumed tokens
 * and expired-unused tokens otherwise linger indefinitely.
 */
crons.daily(
  "sweep stale enrollment tokens",
  { hourUTC: 9, minuteUTC: 30 }, // ~23:30 HST
  internal.enrollment.sweepStaleTokens,
  {}
);

/**
 * Sweep stale admin "view-as" overlays. Each overlay carries a hard TTL and is
 * already inert past it (getActiveOverlay ignores expired rows); this hourly
 * tick flips `active`→false + audits any expired OR orphaned (anchor session
 * gone) overlay so an unexited/closed tab can't leave a lingering `active` row.
 * No-op when none — impersonation is rare.
 */
crons.hourly(
  "sweep stale impersonation overlays",
  { minuteUTC: 25 },
  internal.impersonation.sweepStaleOverlays,
  {}
);

/**
 * Sweep used/expired embed-session handoff tokens (≤120s TTL). A redeemed
 * token (`usedAt` set) and an issued-but-never-loaded token both linger until
 * swept; hourly is ample for such a tiny, short-lived table. See
 * convex/embedAuth.ts.
 */
crons.hourly(
  "sweep stale embed session tokens",
  { minuteUTC: 20 },
  internal.embedAuth.sweepStaleEmbedTokens,
  {}
);

/**
 * Sweep dead iPad-pairing requests — exchanged (terminal) or past their ~5-min
 * TTL. The durable pairedDevices bindings are never touched. Hourly is ample
 * for such a tiny, short-lived table. See convex/devicePairing.ts.
 */
crons.hourly(
  "sweep stale device pairing requests",
  { minuteUTC: 25 },
  internal.devicePairing.sweepStalePairingRequests,
  {}
);



/**
 * Weekly AI usage & cost report — a deterministic $ + token roll-up (by source
 * bucket and model, with week-over-week deltas) posted as a Slack canvas to
 * #rabbithole-alerts. Zero model calls. Offset 30 min after the Quality Pulse
 * (Sat 02:40 UTC = Fri 16:40 HST) so the two weekly notes don't post at once.
 */

/**
 * Weekly Practice Portrait digest — a deterministic teacher-facing roll-up of
 * standing-practice cohorts (skills confirmed fluent, frontier moves, due/rusty
 * reviews, misconception flags, practice days, and not-yet-placed scholars)
 * posted to #rabbithole-alerts. Zero model calls. Offset 30 min after the usage
 * report (Sat 03:10 UTC = Fri 17:10 HST) so the weekly notes don't post at once.
 */

/**
 * Trim usageEvents past the retention window (~13 weeks). The table is one row
 * per model call, so it's swept daily; the mutation deletes one batch and, if
 * that batch was full, re-schedules itself to drain the rest — so a single
 * daily tick clears any backlog on its own.
 */

// Reception review is deliberately bounded: unknown, visitor, and rejected
// events expire after 14 days; an operations staffer-confirmed scholar attendance row
// expires after 180 days. The attendance table contains metadata only.


/**
 * Re-check curated instructional YouTube clips daily so removed, private, or
 * non-embeddable videos disappear before a scholar sees a dead player frame.
 * Transient network/YouTube failures preserve the last known availability.
 */
crons.daily(
  "check instructional video health",
  { hourUTC: 15, minuteUTC: 30 }, // ~05:30 HST — before the school day
  internal.instructionVideoHealth.checkInstructionVideos,
  {},
);


// The ONE authoritative correctness mechanism for managed-native app access.
// Every 5 minutes it does two things, in that order:
//
//   1. LEASE revocation — re-derive fresh authorization for each currently
//      unlocked device (claim/owner-generation, scholar, catalog mapping,
//      audience/archive/scheme conditions, expiry) and force-relock any row
//      that is no longer valid;
//   2. ALLOWLIST projection — re-derive every BOUND device's whole desired
//      allowlist from grants and live pushes, and PATCH the ones that have
//      drifted. This is the app-access inversion: the teacher's grant is the
//      authority, and the MDM allowlist is a projection of it, so a granted
//      tile opens without any launch-time ceremony.
//
// Every mutation-site "hook" elsewhere only marks a row due sooner and kicks
// this same action out of band — it never decides what the allowlist should
// contain, so a missing/bypassed hook can only delay convergence to (at most)
// this cron's own interval, never leave a device wrong forever. See
// deviceAppUnlock.ts's prepareReconcileLock / prepareProjectionPatch /
// reconcileActiveUnlocks, and review/app-access-unification-plan.html.
crons.interval(
  "reconcile active managed-native app unlocks",
  { minutes: 5 },
  reconcileActiveAppUnlocksRef,
  {},
);

export default crons;
