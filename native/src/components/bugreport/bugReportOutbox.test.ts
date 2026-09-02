import { beforeEach, describe, expect, it, vi } from "vitest";
import * as FileSystem from "expo-file-system/legacy";

const fileSystem = vi.hoisted(() => {
  const files = new Map<string, string>();
  return { files };
});

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  makeDirectoryAsync: vi.fn(async () => {}),
  getInfoAsync: vi.fn(async (path: string) => ({
    exists: fileSystem.files.has(path),
  })),
  readAsStringAsync: vi.fn(async (path: string) => {
    const value = fileSystem.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }),
  writeAsStringAsync: vi.fn(async (path: string, value: string) => {
    fileSystem.files.set(path, value);
  }),
  copyAsync: vi.fn(
    async ({ from, to }: { from: string; to: string }) => {
      fileSystem.files.set(to, `copy:${from}`);
    },
  ),
  deleteAsync: vi.fn(async (path: string) => {
    fileSystem.files.delete(path);
  }),
}));

import {
  attachPendingAudio,
  clearPendingBugReport,
  loadPendingBugReport,
  retryPendingBugReport,
  savePendingBugReport,
  stageBugReportFile,
  type PendingBugReport,
} from "./bugReportOutbox";

function report(id: string, screenshotUri?: string): PendingBugReport {
  return {
    id,
    createdAt: 1,
    context: { surface: "native", url: "/session/test" },
    screenshotUri,
  };
}

beforeEach(() => {
  fileSystem.files.clear();
  vi.clearAllMocks();
});

describe("bug-report outbox", () => {
  it("persists files and one pending report, then clears both", async () => {
    const screenshotUri = await stageBugReportFile(
      "one",
      "screenshot",
      "file:///tmp/capture.png",
    );
    const pending = report("one", screenshotUri);
    await savePendingBugReport(pending);

    expect(screenshotUri).toContain("one-screenshot.jpg");
    expect(await loadPendingBugReport()).toEqual(pending);
    expect(fileSystem.files.get(screenshotUri)).toBe(
      "copy:file:///tmp/capture.png",
    );

    await clearPendingBugReport(pending);
    await clearPendingBugReport(pending);
    expect(await loadPendingBugReport()).toBeNull();
    expect(fileSystem.files.has(screenshotUri)).toBe(false);
  });

  it("removes the source file after staging succeeds", async () => {
    const sourceUri = "file:///tmp/capture.png";
    fileSystem.files.set(sourceUri, "capture");

    await stageBugReportFile("one", "screenshot", sourceUri);

    expect(fileSystem.files.has(sourceUri)).toBe(false);
  });

  it("stages the copy even when deleting the source rejects", async () => {
    const sourceUri = "file:///tmp/ReactNative/capture.jpg";
    fileSystem.files.set(sourceUri, "capture");
    // The pre-copy destination cleanup succeeds; the tmp source deletion throws
    // the FileNotWritableException expo-file-system raises for tmp/ paths.
    vi.mocked(FileSystem.deleteAsync)
      .mockImplementationOnce(async (path: string) => {
        fileSystem.files.delete(path);
      })
      .mockImplementationOnce(async () => {
        throw new Error("Calling the 'deleteAsync' function has failed");
      });

    const destination = await stageBugReportFile(
      "one",
      "screenshot",
      sourceUri,
    );

    expect(destination).toContain("one-screenshot.jpg");
    expect(fileSystem.files.get(destination)).toBe(`copy:${sourceUri}`);
  });

  it("retains the source file when staging copy fails", async () => {
    const sourceUri = "file:///tmp/capture.png";
    fileSystem.files.set(sourceUri, "capture");
    vi.mocked(FileSystem.copyAsync).mockRejectedValueOnce(
      new Error("copy failed"),
    );

    await expect(
      stageBugReportFile("one", "screenshot", sourceUri),
    ).rejects.toThrow("copy failed");

    expect(fileSystem.files.has(sourceUri)).toBe(true);
  });

  it("adds a persistent M4A to the live pending report", async () => {
    const pending = report("audio");
    await savePendingBugReport(pending);

    const updated = await attachPendingAudio(
      pending,
      "file:///tmp/report.m4a",
    );

    expect(updated.audioUri).toContain("audio-audio.m4a");
    expect(await loadPendingBugReport()).toEqual(updated);
  });

  it("keeps a failed retry and clears a successful retry", async () => {
    const pending = report("retry");
    await savePendingBugReport(pending);

    await expect(
      retryPendingBugReport(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(await loadPendingBugReport()).toEqual(pending);

    const submit = vi.fn(async () => {});
    await expect(retryPendingBugReport(submit)).resolves.toEqual(pending);
    expect(submit).toHaveBeenCalledWith(pending);
    expect(await loadPendingBugReport()).toBeNull();
  });

  it("deletes the displaced single-slot report files", async () => {
    const oldScreenshot = await stageBugReportFile(
      "old",
      "screenshot",
      "file:///tmp/old.png",
    );
    await savePendingBugReport(report("old", oldScreenshot));

    await savePendingBugReport(report("new"));

    expect((await loadPendingBugReport())?.id).toBe("new");
    expect(fileSystem.files.has(oldScreenshot)).toBe(false);
  });
});
