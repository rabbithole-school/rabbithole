import * as FileSystem from "expo-file-system/legacy";

import {
  enqueueReport,
  type LaunchJournal,
  type PendingHealthReport,
} from "@/lib/appHealth";

// Persistence for appHealth.ts: the launch journal and the report outbox, both
// small JSON files under documentDirectory (survives a crash and a relaunch).

const DIRECTORY = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}app-health/`
  : null;
const JOURNAL_PATH = DIRECTORY ? `${DIRECTORY}launch-journal.json` : null;
const OUTBOX_PATH = DIRECTORY ? `${DIRECTORY}outbox.json` : null;

// Every read-modify-write goes through one chain, so the fatal handler, the
// stall poller and the drain never interleave and drop a report.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.catch(() => undefined);
  return next;
}

async function readJson<T>(path: string | null): Promise<T | null> {
  if (!path) return null;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(path)) as T;
  } catch {
    // A torn write from a crash mid-save reads as "no record", never a throw.
    return null;
  }
}

async function writeJson(path: string | null, value: unknown): Promise<void> {
  if (!path || !DIRECTORY) return;
  await FileSystem.makeDirectoryAsync(DIRECTORY, { intermediates: true });
  await FileSystem.writeAsStringAsync(path, JSON.stringify(value));
}

function isJournal(value: unknown): value is LaunchJournal {
  const journal = value as LaunchJournal | null;
  return (
    !!journal &&
    typeof journal.launchId === "string" &&
    typeof journal.lastAliveAt === "number" &&
    typeof journal.appState === "string" &&
    typeof journal.stateSince === "number" &&
    typeof journal.build === "string"
  );
}

export function readJournal(): Promise<LaunchJournal | null> {
  return serialized(async () => {
    const value = await readJson<unknown>(JOURNAL_PATH);
    return isJournal(value) ? value : null;
  });
}

export function writeJournal(journal: LaunchJournal): Promise<void> {
  return serialized(() => writeJson(JOURNAL_PATH, journal));
}

export function readOutbox(): Promise<PendingHealthReport[]> {
  return serialized(async () => {
    const value = await readJson<unknown>(OUTBOX_PATH);
    return Array.isArray(value) ? (value as PendingHealthReport[]) : [];
  });
}

export function addToOutbox(report: PendingHealthReport): Promise<void> {
  return serialized(async () => {
    const value = await readJson<unknown>(OUTBOX_PATH);
    const queue = Array.isArray(value) ? (value as PendingHealthReport[]) : [];
    await writeJson(OUTBOX_PATH, enqueueReport(queue, report));
  });
}

/** Replace a queued report (a bumped attempt count), or drop it with null. */
export function updateInOutbox(
  id: string,
  next: PendingHealthReport | null,
): Promise<void> {
  return serialized(async () => {
    const value = await readJson<unknown>(OUTBOX_PATH);
    const queue = Array.isArray(value) ? (value as PendingHealthReport[]) : [];
    await writeJson(
      OUTBOX_PATH,
      queue.flatMap((report) =>
        report.id !== id ? [report] : next ? [next] : [],
      ),
    );
  });
}
