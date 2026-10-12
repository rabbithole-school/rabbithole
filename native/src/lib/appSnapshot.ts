import type { Id } from "@/lib/convex";

export type AppSnapshotImageCapture = {
  dataUrl: string;
  hash: string;
};

export type AppSnapshotCapture = {
  image: AppSnapshotImageCapture | null;
  imageError?: string;
  consoleLines: string[];
  stateJson: string;
};

export type AppSnapshotLoadBoundary = {
  loadVersion: number;
  nonce: string | null;
};

export type CaptureAppSnapshot = (
  afterLoad?: AppSnapshotLoadBoundary,
  deadlineAt?: number,
) => Promise<AppSnapshotCapture>;

export const APP_SNAPSHOT_UPLOAD_MAX_BYTES = 400 * 1024;

type AppSnapshotConsoleEntry = {
  level: "log" | "warn" | "error";
  message: string;
};

const SNAPSHOT_CAPTURE_CONSOLE_NOISE =
  /Error while reading CSS rules from/;

export function collectAppSnapshotConsoleLines(
  logs: readonly AppSnapshotConsoleEntry[],
): string[] {
  const latestLogs = logs
    .filter(
      (entry) => !SNAPSHOT_CAPTURE_CONSOLE_NOISE.test(entry.message),
    )
    .slice(-40);
  return [
    ...latestLogs.filter((entry) => entry.level === "error"),
    ...latestLogs.filter((entry) => entry.level === "warn"),
    ...latestLogs.filter((entry) => entry.level === "log"),
  ].map((entry) => `[${entry.level}] ${entry.message}`.slice(0, 500));
}

function appSnapshotDataUrlByteLength(dataUrl: string): number {
  const match = /^data:image\/(?:jpeg|png);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("App snapshot was not a JPEG or PNG data URL");
  const padding = match[1].endsWith("==")
    ? 2
    : match[1].endsWith("=")
      ? 1
      : 0;
  return (match[1].length / 4) * 3 - padding;
}

type UploadAppSnapshotArgs = {
  captureSnapshot: CaptureAppSnapshot | null;
  lastSentHash: string | null;
  generateUploadUrl: () => Promise<string>;
  uploadDataUrl: (
    uploadUrl: string,
    dataUrl: string,
  ) => Promise<Id<"_storage">>;
  force?: boolean;
  afterLoad?: AppSnapshotLoadBoundary;
  deadlineAt?: number;
};

type UploadedAppSnapshot = {
  storageId: Id<"_storage">;
  hash: string;
};

export type AppSnapshotCaptureUploadResult = {
  storageId: Id<"_storage"> | null;
  hash: string | null;
  missingImageReason?: string;
  consoleLines: string[];
  stateJson: string;
};

function skippedCapture(
  capture: AppSnapshotCapture,
  missingImageReason: string,
): AppSnapshotCaptureUploadResult {
  return {
    storageId: null,
    hash: capture.image?.hash ?? null,
    missingImageReason,
    consoleLines: capture.consoleLines,
    stateJson: capture.stateJson,
  };
}

export function uploadChangedAppSnapshot(
  args: UploadAppSnapshotArgs & { returnCaptureOnUploadSkip: true },
): Promise<AppSnapshotCaptureUploadResult | null>;
export function uploadChangedAppSnapshot(
  args: UploadAppSnapshotArgs & { returnCaptureOnUploadSkip?: false },
): Promise<UploadedAppSnapshot | null>;
export async function uploadChangedAppSnapshot({
  captureSnapshot,
  lastSentHash,
  generateUploadUrl,
  uploadDataUrl,
  force = false,
  afterLoad,
  deadlineAt,
  returnCaptureOnUploadSkip = false,
}: UploadAppSnapshotArgs & {
  returnCaptureOnUploadSkip?: boolean;
}): Promise<
  AppSnapshotCaptureUploadResult | UploadedAppSnapshot | null
> {
  if (!captureSnapshot) {
    return returnCaptureOnUploadSkip
      ? {
          storageId: null,
          hash: null,
          missingImageReason: "bridge-unavailable",
          consoleLines: [],
          stateJson: "{}",
        }
      : null;
  }
  const capture = await captureSnapshot(afterLoad, deadlineAt);
  if (!capture.image) {
    return returnCaptureOnUploadSkip
      ? skippedCapture(
          capture,
          capture.imageError ?? "bridge-unavailable",
        )
      : null;
  }
  if (!force && capture.image.hash === lastSentHash) return null;

  const imageBytes = appSnapshotDataUrlByteLength(capture.image.dataUrl);
  if (imageBytes > APP_SNAPSHOT_UPLOAD_MAX_BYTES) {
    console.warn(
      `[rabbithole] app snapshot is ${imageBytes} bytes; sending without it`,
    );
    return returnCaptureOnUploadSkip
      ? skippedCapture(capture, "capture-error:image-too-large")
      : null;
  }
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    return returnCaptureOnUploadSkip
      ? skippedCapture(capture, "timeout")
      : null;
  }

  let uploadUrl: string;
  try {
    uploadUrl = await generateUploadUrl();
  } catch (error) {
    if (!returnCaptureOnUploadSkip) throw error;
    console.warn("[rabbithole] app snapshot upload URL failed:", error);
    return skippedCapture(capture, "upload-error:url");
  }
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    return returnCaptureOnUploadSkip
      ? skippedCapture(capture, "timeout")
      : null;
  }

  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const storageId = await Promise.race([
      uploadDataUrl(uploadUrl, capture.image.dataUrl),
      ...(deadlineAt === undefined
        ? []
        : [
            new Promise<never>((_, reject) => {
              uploadTimer = setTimeout(
                () => reject(new Error("timeout")),
                Math.max(0, deadlineAt - performance.now()),
              );
            }),
          ]),
    ]);
    return {
      storageId,
      hash: capture.image.hash,
      ...(returnCaptureOnUploadSkip
        ? {
            consoleLines: capture.consoleLines,
            stateJson: capture.stateJson,
          }
        : {}),
    };
  } catch (error) {
    if (!returnCaptureOnUploadSkip) throw error;
    console.warn("[rabbithole] app snapshot upload failed:", error);
    const status =
      error instanceof Error
        ? /\((\d{3})\)/.exec(error.message)?.[1]
        : undefined;
    return skippedCapture(
      capture,
      error instanceof Error && error.message === "timeout"
        ? "timeout"
        : `upload-error:${status ?? "network"}`,
    );
  } finally {
    if (uploadTimer) clearTimeout(uploadTimer);
  }
}
