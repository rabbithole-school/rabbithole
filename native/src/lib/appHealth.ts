/**
 * Automatic crash / freeze / quit detection for the iPad app (pure logic).
 *
 * The app cannot report its own death, so it keeps a small launch journal on
 * disk and judges the PREVIOUS launch on the next one:
 *
 * - js_crash      — a fatal JS error: the global handler (timers, events,
 *                   module code) or the root error boundary (render errors,
 *                   which React Native routes around the global handler).
 *                   Written to the outbox before React Native aborts.
 * - unclean_exit  — the previous launch ended while the app was on screen
 *                   with no fatal recorded: a native crash, a watchdog or
 *                   memory kill, or a restart of a frozen iPad. A quit from
 *                   the app switcher passes through inactive/background
 *                   first, so it does not count — unless the app sat in
 *                   `inactive` for STUCK_INACTIVE_MS, the signature of the
 *                   stuck launch-zoom veil (TRA-331).
 * - stall         — the JS thread stopped ticking for STALL_THRESHOLD_MS while
 *                   the app stayed in the foreground, then recovered.
 *
 * A freeze that never recovers surfaces as an unclean_exit on the next launch;
 * `lastAliveAt` (refreshed every JOURNAL_TICK_MS) says when the JS thread last
 * ran, so a long gap before the app died means JS hung. Device uptime tells a
 * reboot apart from an app relaunch.
 *
 * Reports go to `bugReports.submit` with a `trigger`, which posts them to the
 * bug-report Slack channel. Storage and wiring: appHealthStore.ts,
 * appHealthMonitor.ts and components/AppHealthReporter.tsx.
 */

export type AppHealthTrigger = "js_crash" | "unclean_exit" | "stall";
export type JournalAppState = "active" | "inactive" | "background";

export type LaunchJournal = {
  launchId: string;
  startedAt: number;
  /** Last time the JS thread wrote the journal (while not in background). */
  lastAliveAt: number;
  appState: JournalAppState;
  /** When appState last changed. */
  stateSince: number;
  route: string;
  sessionId?: string;
  build: string;
  /**
   * Device uptime when lastAliveAt was written. Uptime only grows until a
   * reboot (sleep included), so a smaller uptime on the next launch is exact
   * proof the iPad restarted.
   */
  uptimeAtLastAliveMs?: number;
  /** Whether this launch ever reached `active` (on screen). */
  everActive?: boolean;
  /** Set when a js_crash was already filed for this launch. */
  fatalAt?: number;
};

export type PendingHealthReport = {
  /** Stable per incident, so a retried submit is deduplicated server-side. */
  id: string;
  trigger: AppHealthTrigger;
  createdAt: number;
  route: string;
  sessionId?: string;
  description: string;
  /** Failed send attempts so far. */
  attempts?: number;
  /** Backoff: don't retry before this. */
  nextAttemptAt?: number;
};

export const JOURNAL_TICK_MS = 5_000;
export const STALL_POLL_MS = 1_000;
/** A kid notices a 2s hitch; 5s is unambiguous "the app froze". */
export const STALL_THRESHOLD_MS = 5_000;
/** Cold start (bundle eval, first render) happens behind the splash screen. */
export const STALL_GRACE_AFTER_LAUNCH_MS = 10_000;
/** One bad session should not flood the channel. */
export const MAX_STALL_REPORTS_PER_LAUNCH = 3;
export const MAX_PENDING_REPORTS = 5;
/** A report older than this is dropped unsent (age, not attempt count, so a
 * late backend deploy or a long outage does not lose reports). */
export const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;
/**
 * `inactive` is a transition state (app switcher, Control Center, a launch
 * zoom). Held this long it is stuck; in Single App Mode there is no app
 * switcher or Control Center to explain it.
 */
export const STUCK_INACTIVE_MS = 15_000;
const MAX_STACK_CHARS = 3_000;
/** The app died this long after the last JS tick, so the JS thread had hung. */
const JS_HUNG_GAP_MS = 60_000;

// Hawaii has no DST, so a fixed offset is exact. The readers are the primary
// school's operators in the triage channel.
const HST_OFFSET_MS = 10 * 60 * 60 * 1000;

export function formatHst(at: number): string {
  const shifted = new Date(at - HST_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} HST`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

function contextLines(
  journal: Pick<LaunchJournal, "route" | "build" | "startedAt">,
): string[] {
  return [
    `Screen: ${journal.route}`,
    `Build: ${journal.build}`,
    `Launch started: ${formatHst(journal.startedAt)}`,
  ];
}

/**
 * Judge the previous launch. Returns the report to file, or null when it ended
 * cleanly, was already reported as a JS crash, or was replaced by an update.
 * `currentUptimeMs` is the device uptime now (null if unknown).
 */
export function classifyPreviousLaunch(
  previous: LaunchJournal | null,
  now: number,
  currentBuild: string,
  currentUptimeMs: number | null,
): PendingHealthReport | null {
  if (!previous || previous.fatalAt) return null;
  // An MDM install of a new build kills the running app; that is not a crash.
  if (previous.build !== currentBuild) return null;
  if (previous.appState === "background") return null;
  const inactiveFor =
    previous.appState === "inactive"
      ? Math.max(0, previous.lastAliveAt - previous.stateSince)
      : 0;
  // Died during launch, before ever reaching the screen: a launch crash loop.
  const diedLaunching =
    previous.appState === "inactive" && previous.everActive === false;
  if (
    previous.appState === "inactive" &&
    inactiveFor < STUCK_INACTIVE_MS &&
    !diedLaunching
  ) {
    return null;
  }

  const rebooted =
    currentUptimeMs !== null &&
    previous.uptimeAtLastAliveMs !== undefined &&
    currentUptimeMs < previous.uptimeAtLastAliveMs;
  // After a reboot the relaunch time includes the boot; the boot itself is
  // the best estimate of when the app died.
  const diedBy = rebooted ? now - (currentUptimeMs ?? 0) : now;
  const gap = Math.max(0, diedBy - previous.lastAliveAt);

  const lines = [
    diedLaunching
      ? "Rabbithole died while launching, before its first screen appeared."
      : rebooted
        ? "The iPad restarted (or lost power) while Rabbithole was on screen."
        : "Rabbithole quit unexpectedly while it was on screen.",
    rebooted
      ? "Typical causes: someone restarted a frozen iPad (including an MDM restart), or the battery died."
      : "Cause unknown from inside the app: a native crash, or a memory or watchdog kill.",
    "",
    `JS last responded: ${formatHst(previous.lastAliveAt)}`,
    rebooted
      ? `iPad booted again: ${formatHst(diedBy)}; app relaunched: ${formatHst(now)}`
      : `App relaunched: ${formatHst(now)} (${formatDuration(gap)} later)`,
  ];
  if (gap >= JS_HUNG_GAP_MS) {
    lines.push(
      rebooted
        ? `JS last ran about ${formatDuration(gap)} before the iPad booted again: either the app was frozen until someone restarted it, or the iPad was off (a dead battery) that long.`
        : `The JS thread stopped about ${formatDuration(gap)} before the relaunch, so the app was most likely frozen (JS hung) until it was restarted.`,
    );
  }
  if (inactiveFor >= STUCK_INACTIVE_MS && !diedLaunching) {
    lines.push(
      `The app had been in iOS's "inactive" state for ${formatDuration(inactiveFor)} with JS still running: a system overlay or alert left up, or the frozen launch-zoom veil (TRA-331), where the screen looks alive but swallows touches.`,
    );
  }
  lines.push("", ...contextLines(previous));
  return {
    id: `${previous.launchId}:unclean_exit`,
    trigger: "unclean_exit",
    createdAt: now,
    route: previous.route,
    sessionId: previous.sessionId,
    description: lines.join("\n"),
  };
}

/**
 * The JS-thread gap since the last poll (monotonic clock), if it counts as a
 * stall. Gaps that span a trip to the background are timer suspension, not a
 * freeze, and the cold start is ignored.
 */
export function stallGapMs(
  previousTickAt: number,
  now: number,
  stayedForeground: boolean,
  sinceLaunchMs: number,
): number | null {
  if (!stayedForeground || sinceLaunchMs < STALL_GRACE_AFTER_LAUNCH_MS) {
    return null;
  }
  const gap = now - previousTickAt;
  return gap >= STALL_THRESHOLD_MS ? gap : null;
}

export function stallReport(
  journal: LaunchJournal,
  gapMs: number,
  now: number,
  index: number,
): PendingHealthReport {
  return {
    id: `${journal.launchId}:stall:${index}`,
    trigger: "stall",
    createdAt: now,
    route: journal.route,
    sessionId: journal.sessionId,
    description: [
      `Rabbithole froze for ${formatDuration(gapMs)} (the JS thread was blocked), then recovered.`,
      "",
      `Freeze ended: ${formatHst(now)}`,
      ...contextLines(journal),
    ].join("\n"),
  };
}

function errorParts(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  try {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack };
    }
    return { name: "Non-Error throw", message: String(error) };
  } catch {
    return { name: "Unprintable throw", message: "(could not stringify)" };
  }
}

export function jsCrashReport(
  journal: LaunchJournal,
  error: unknown,
  now: number,
  componentStack?: string,
): PendingHealthReport {
  const { name, message, stack } = errorParts(error);
  const lines = [
    componentStack
      ? "Rabbithole crashed: a screen threw while rendering."
      : "Rabbithole crashed with a fatal JavaScript error.",
    "",
    `${name}: ${message}`,
    "",
    `Crashed: ${formatHst(now)}`,
    ...contextLines(journal),
  ];
  if (componentStack) {
    lines.push("", "Component stack:", componentStack.trim().slice(0, 1_500));
  }
  if (stack) {
    lines.push("", "Stack:", stack.slice(0, MAX_STACK_CHARS));
  }
  return {
    id: `${journal.launchId}:js_crash`,
    trigger: "js_crash",
    createdAt: now,
    route: journal.route,
    sessionId: journal.sessionId,
    description: lines.join("\n"),
  };
}

/** Append, dropping the oldest past the cap and any same-id duplicate. */
export function enqueueReport(
  queue: PendingHealthReport[],
  report: PendingHealthReport,
): PendingHealthReport[] {
  const rest = queue.filter((item) => item.id !== report.id);
  return [...rest, report].slice(-MAX_PENDING_REPORTS);
}

/** Whether a queued report is due for a send attempt. */
export function isDue(report: PendingHealthReport, now: number): boolean {
  return (report.nextAttemptAt ?? 0) <= now;
}

/**
 * Count a failed send and back off (1, 2, 4… min, capped at an hour); null
 * once the report is too old to be worth sending.
 */
export function recordFailedAttempt(
  report: PendingHealthReport,
  now: number,
): PendingHealthReport | null {
  if (now - report.createdAt >= REPORT_MAX_AGE_MS) return null;
  const attempts = (report.attempts ?? 0) + 1;
  const backoff = Math.min(60_000 * 2 ** (attempts - 1), MAX_RETRY_BACKOFF_MS);
  return { ...report, attempts, nextAttemptAt: now + backoff };
}
