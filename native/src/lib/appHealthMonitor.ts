import * as Device from "expo-device";
import { AppState, type AppStateStatus } from "react-native";

import {
  classifyPreviousLaunch,
  jsCrashReport,
  JOURNAL_TICK_MS,
  MAX_STALL_REPORTS_PER_LAUNCH,
  stallGapMs,
  stallReport,
  STALL_POLL_MS,
  type JournalAppState,
  type LaunchJournal,
  type PendingHealthReport,
} from "@/lib/appHealth";
import {
  addToOutbox,
  readJournal,
  writeJournal,
} from "@/lib/appHealthStore";
import { appStatusBus } from "@/lib/appStatusBus";
import { nativeClientBuildInfo } from "@/lib/nativeClientBuildInfo";

// The side-effecting half of appHealth.ts: keeps the launch journal current,
// files fatal JS errors, polls for JS stalls, and tells the reporter when the
// outbox gained a report. Started once at module load of the root layout, so
// it is in place before the first screen renders.

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsShape = {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
  reportFatalError(error: unknown): void;
};

/** How long a fatal waits for the outbox write before RN aborts the app. */
const FATAL_PERSIST_TIMEOUT_MS = 1_500;

const outboxListeners = new Set<() => void>();
let journal: LaunchJournal | null = null;
let started = false;
/** The one in-flight (or finished) fatal persist for this launch. */
let fatalPersist: Promise<void> | null = null;

function errorUtils(): ErrorUtilsShape | undefined {
  return (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
}

function notifyOutbox() {
  outboxListeners.forEach((listener) => listener());
}

/** The reporter drains the outbox when this fires. */
export function onAppHealthOutbox(listener: () => void): () => void {
  outboxListeners.add(listener);
  return () => outboxListeners.delete(listener);
}

async function file(report: PendingHealthReport) {
  await addToOutbox(report);
  notifyOutbox();
}

function newLaunchId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function journalState(state: AppStateStatus): JournalAppState {
  return state === "active" || state === "inactive" ? state : "background";
}

/**
 * Only Stable and Canary report — a Metro dev client reloads JS constantly,
 * and every reload would read as a quit. EXPO_PUBLIC_APP_HEALTH_DEV=1 turns it
 * on in a dev build for verifying this pipeline.
 */
function reportingEnabled(): boolean {
  return (
    nativeClientBuildInfo.channel !== null ||
    process.env.EXPO_PUBLIC_APP_HEALTH_DEV === "1"
  );
}

function buildLabel(): string {
  const { channel, appVersion, buildNumber, gitSha } = nativeClientBuildInfo;
  return `${channel ?? "dev"} ${appVersion} (${buildNumber}) ${gitSha.slice(0, 9)}`;
}

/**
 * Persist a js_crash for this launch, bounded in time. Resolves when the
 * report and the journal's fatal mark are on disk (or the wait ran out). Only
 * the first fatal of a launch is recorded; every later caller gets the same
 * promise, so a cascade of fatals never aborts the app before the first one is
 * on disk.
 */
function persistFatal(error: unknown, componentStack?: string): Promise<void> {
  if (fatalPersist) return fatalPersist;
  if (!journal) return Promise.resolve();
  const now = Date.now();
  journal = { ...journal, fatalAt: now };
  let report: PendingHealthReport | null = null;
  try {
    report = jsCrashReport(journal, error, now, componentStack);
  } catch {
    report = null;
  }
  // Notify too: in a dev build (and if RN ever stops aborting) the app keeps
  // running, and the reporter can send right away.
  const persisted = Promise.all([
    writeJournal(journal),
    report ? addToOutbox(report) : Promise.resolve(),
  ])
    .then(() => notifyOutbox())
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, FATAL_PERSIST_TIMEOUT_MS),
  );
  fatalPersist = Promise.race([persisted, timeout]);
  return fatalPersist;
}

/**
 * Called by the root error boundary. React Native sends render errors straight
 * to its native fatal path, around the global handler, so the boundary files
 * the crash (with the component stack) and then re-raises it as a fatal.
 */
export function reportRenderCrash(error: unknown, componentStack?: string) {
  void persistFatal(error, componentStack).finally(() => {
    const utils = errorUtils();
    if (utils) utils.reportFatalError(error);
    else throw error;
  });
}

function installFatalHook() {
  const utils = errorUtils();
  if (!utils) return;
  const original = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    if (!isFatal || !journal) {
      original(error, isFatal);
      return;
    }
    // The first fatal (from here or the boundary) starts the persist; every
    // fatal waits for it before RN's handler aborts the app.
    void persistFatal(error).finally(() => original(error, isFatal));
  });
}

export function startAppHealthMonitor(): void {
  if (started || !reportingEnabled()) return;
  started = true;

  const build = buildLabel();
  const startedAt = Date.now();
  const startedMono = performance.now();
  const route = appStatusBus.getRoute();
  const initialState = journalState(AppState.currentState);
  journal = {
    launchId: newLaunchId(),
    startedAt,
    lastAliveAt: startedAt,
    appState: initialState,
    stateSince: startedAt,
    route: route.route,
    sessionId: route.sessionId,
    build,
    everActive: initialState === "active",
  };

  installFatalHook();

  // Read the previous launch's journal BEFORE anything overwrites it; the
  // store serializes, so every later write queues behind this read.
  const previousJournal = readJournal();
  void Promise.all([
    previousJournal,
    Device.getUptimeAsync().catch(() => null),
  ])
    .then(async ([previous, uptimeMs]) => {
      if (journal && uptimeMs !== null) {
        journal = { ...journal, uptimeAtLastAliveMs: uptimeMs };
      }
      const report = classifyPreviousLaunch(previous, startedAt, build, uptimeMs);
      if (journal) await writeJournal(journal);
      if (report) await file(report);
    })
    .catch((error: unknown) => {
      console.warn("[app-health] previous launch check failed", error);
    });

  let lastPollMono = startedMono;
  let lastPersistAt = startedAt;
  let leftForegroundSincePoll = initialState !== "active";
  let stallReports = 0;

  const persist = (now: number) => {
    if (!journal) return;
    lastPersistAt = now;
    // Write at once (iOS may suspend the app right after a state change),
    // then refresh uptime for the next write: uptime alongside lastAliveAt is
    // the exact reboot test next launch, and a few seconds' lag is harmless.
    void writeJournal(journal).catch(() => undefined);
    void Device.getUptimeAsync()
      .then((uptimeMs) => {
        if (journal) journal = { ...journal, uptimeAtLastAliveMs: uptimeMs };
      })
      .catch(() => undefined);
  };

  appStatusBus.subscribe(() => {
    if (!journal) return;
    const next = appStatusBus.getRoute();
    journal = { ...journal, route: next.route, sessionId: next.sessionId };
  });

  AppState.addEventListener("change", (state: AppStateStatus) => {
    if (!journal) return;
    const now = Date.now();
    const appState = journalState(state);
    if (appState !== "active") leftForegroundSincePoll = true;
    // Timers pause off-screen; restart the stall clock on return.
    if (appState === "active") lastPollMono = performance.now();
    journal = {
      ...journal,
      appState,
      stateSince: appState === journal.appState ? journal.stateSince : now,
      lastAliveAt: now,
      everActive: journal.everActive || appState === "active",
    };
    // Written immediately: iOS may suspend or kill the app right after this.
    persist(now);
  });

  setInterval(() => {
    if (!journal) return;
    const now = Date.now();
    const mono = performance.now();
    const gap = stallGapMs(
      lastPollMono,
      mono,
      journal.appState === "active" && !leftForegroundSincePoll,
      mono - startedMono,
    );
    lastPollMono = mono;
    leftForegroundSincePoll = false;
    if (gap !== null && stallReports < MAX_STALL_REPORTS_PER_LAUNCH) {
      stallReports += 1;
      void file(stallReport(journal, gap, now, stallReports)).catch(
        () => undefined,
      );
    }
    // Inactive ticks too: how long it lasted is the stuck-veil evidence.
    if (journal.appState !== "background") {
      journal = { ...journal, lastAliveAt: now };
      if (now - lastPersistAt >= JOURNAL_TICK_MS) persist(now);
    }
  }, STALL_POLL_MS);
}
