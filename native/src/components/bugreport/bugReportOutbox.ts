import * as FileSystem from "expo-file-system/legacy";

import type { Id } from "@/lib/convex";

export const BUG_REPORT_SCREENSHOT = {
  format: "jpg",
  mime: "image/jpeg",
  extension: "jpg",
  quality: 0.85,
} as const;

export type BugReportSubmitContext = {
  surface: "native";
  url: string;
  sessionId?: Id<"sessions">;
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
  appBuild?: string;
  description?: string;
};

export type PendingBugReport = {
  id: string;
  createdAt: number;
  context: BugReportSubmitContext;
  screenshotUri?: string;
  audioUri?: string;
};

const DOCUMENT_DIRECTORY = FileSystem.documentDirectory;
const OUTBOX_DIRECTORY = DOCUMENT_DIRECTORY
  ? `${DOCUMENT_DIRECTORY}bug-report-outbox/`
  : null;
const PENDING_PATH = OUTBOX_DIRECTORY
  ? `${OUTBOX_DIRECTORY}pending-report.json`
  : null;

function requireOutboxPath(path: string | null): string {
  if (!path) {
    throw new Error("Persistent app storage is unavailable");
  }
  return path;
}

async function ensureOutboxDirectory() {
  await FileSystem.makeDirectoryAsync(requireOutboxPath(OUTBOX_DIRECTORY), {
    intermediates: true,
  });
}

function validatePendingReport(value: unknown): PendingBugReport {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as PendingBugReport).id !== "string" ||
    typeof (value as PendingBugReport).createdAt !== "number" ||
    typeof (value as PendingBugReport).context !== "object" ||
    (value as PendingBugReport).context === null ||
    (value as PendingBugReport).context.surface !== "native" ||
    typeof (value as PendingBugReport).context.url !== "string"
  ) {
    throw new Error("The saved bug report is invalid");
  }
  return value as PendingBugReport;
}

export async function loadPendingBugReport(): Promise<PendingBugReport | null> {
  const path = requireOutboxPath(PENDING_PATH);
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return null;
  const raw = await FileSystem.readAsStringAsync(path);
  return validatePendingReport(JSON.parse(raw) as unknown);
}

export async function stageBugReportFile(
  reportId: string,
  kind: "screenshot" | "audio",
  sourceUri: string,
): Promise<string> {
  await ensureOutboxDirectory();
  const extension =
    kind === "screenshot" ? BUG_REPORT_SCREENSHOT.extension : "m4a";
  const destination = `${requireOutboxPath(OUTBOX_DIRECTORY)}${reportId}-${kind}.${extension}`;
  await FileSystem.deleteAsync(destination, { idempotent: true });
  await FileSystem.copyAsync({ from: sourceUri, to: destination });
  // The copy above is the operation that must succeed. Deleting the original is
  // opportunistic housekeeping (iOS reclaims tmp/ on its own), so a failure must
  // not lose the staged report. expo-file-system's legacy deleteAsync cannot
  // delete outside its scoped dirs (documentDirectory / cacheDirectory), and
  // react-native-view-shot writes the capture into tmp/ReactNative/, so this
  // call throws a FileNotWritableException there. Swallow it — do NOT turn this
  // back into a hard failure. (The destination deleteAsync above is safe: it
  // targets the scoped, writable outbox directory.)
  try {
    await FileSystem.deleteAsync(sourceUri, { idempotent: true });
  } catch (error) {
    console.warn("[bug-report] source cleanup failed", error);
  }
  return destination;
}

export async function savePendingBugReport(
  report: PendingBugReport,
): Promise<void> {
  await ensureOutboxDirectory();
  const replaced = await loadPendingBugReport();
  // The outbox intentionally has one slot. BugReportGate retries the existing
  // report once when a new gesture arms; the new capture may then replace it.
  await FileSystem.writeAsStringAsync(
    requireOutboxPath(PENDING_PATH),
    JSON.stringify(report),
  );
  if (replaced && replaced.id !== report.id) {
    await deleteBugReportFiles(replaced);
  }
}

export async function attachPendingAudio(
  report: PendingBugReport,
  sourceUri: string,
): Promise<PendingBugReport> {
  const audioUri = await stageBugReportFile(report.id, "audio", sourceUri);
  const current = await loadPendingBugReport();
  if (!current || current.id !== report.id) {
    await FileSystem.deleteAsync(audioUri, { idempotent: true });
    throw new Error("The pending bug report changed before audio was saved");
  }
  const updated = { ...current, audioUri };
  await savePendingBugReport(updated);
  return updated;
}

export async function deleteBugReportFiles(
  report: Pick<PendingBugReport, "screenshotUri" | "audioUri">,
): Promise<void> {
  await Promise.all(
    [report.screenshotUri, report.audioUri]
      .filter((uri): uri is string => !!uri)
      .map((uri) => FileSystem.deleteAsync(uri, { idempotent: true })),
  );
}

export async function clearPendingBugReport(
  report: PendingBugReport,
): Promise<void> {
  const current = await loadPendingBugReport();
  if (current?.id === report.id) {
    await FileSystem.deleteAsync(requireOutboxPath(PENDING_PATH), {
      idempotent: true,
    });
  }
  await deleteBugReportFiles(report);
}

export async function retryPendingBugReport(
  submit: (report: PendingBugReport) => Promise<void>,
): Promise<PendingBugReport | null> {
  const pending = await loadPendingBugReport();
  if (!pending) return null;
  try {
    await submit(pending);
    await clearPendingBugReport(pending);
    return pending;
  } finally {
    const current = await loadPendingBugReport();
    if (current && current.id !== pending.id) {
      await deleteBugReportFiles(pending);
    }
  }
}
