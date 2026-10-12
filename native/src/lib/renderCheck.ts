import type { Id } from "@/lib/convex";
import {
  uploadChangedAppSnapshot,
  type AppSnapshotCaptureUploadResult,
  type AppSnapshotLoadBoundary,
  type CaptureAppSnapshot,
} from "@/lib/appSnapshot";

export const RENDER_CHECK_CLIENT_BUDGET_MS = 6_500;
export const RENDER_CHECK_ARTIFACT_WAIT_MS = 2_000;

export type RenderCheckRequest = {
  checkId: string;
  artifactId: string;
};

export function renderCheckLoadBoundary(
  baseline: {
    id: string;
    loadBoundary?: AppSnapshotLoadBoundary | null;
  } | null,
  artifactId: string,
): AppSnapshotLoadBoundary | undefined {
  return baseline?.id === artifactId
    ? baseline.loadBoundary ?? undefined
    : undefined;
}

type AnswerRenderCheckArgs = {
  sessionId: Id<"sessions">;
  streamId: string;
  checkId: string;
  snapshotStorageId?: Id<"_storage">;
  consoleLines: string[];
  stateJson: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function answerNativeRenderCheck({
  sessionId,
  streamId,
  checkId,
  captureSnapshot,
  afterLoad,
  lastSentHash,
  generateUploadUrl,
  uploadDataUrl,
  answerRenderCheck,
  isStillActive,
  deadlineAt,
  onCaptureError,
}: {
  sessionId: Id<"sessions">;
  streamId: string;
  checkId: string;
  captureSnapshot: CaptureAppSnapshot | null;
  afterLoad?: AppSnapshotLoadBoundary;
  lastSentHash: string | null;
  generateUploadUrl: () => Promise<string>;
  uploadDataUrl: (
    uploadUrl: string,
    dataUrl: string,
  ) => Promise<Id<"_storage">>;
  answerRenderCheck: (args: AnswerRenderCheckArgs) => Promise<unknown>;
  isStillActive: () => boolean;
  deadlineAt: number;
  onCaptureError?: (error: unknown) => void;
}): Promise<AppSnapshotCaptureUploadResult | null> {
  let capture: AppSnapshotCaptureUploadResult | null = null;
  let captureFailure: string | null = null;
  try {
    capture = await uploadChangedAppSnapshot({
      captureSnapshot,
      lastSentHash,
      generateUploadUrl,
      uploadDataUrl,
      force: true,
      afterLoad,
      deadlineAt,
      returnCaptureOnUploadSkip: true,
    });
  } catch (error) {
    onCaptureError?.(error);
    captureFailure = `capture-error:${errorMessage(error)}`;
  }

  if (!isStillActive()) return null;

  const missingImageReason =
    capture?.storageId === null
      ? capture.missingImageReason ?? "bridge-unavailable"
      : captureFailure;
  const consoleLines = capture?.consoleLines ?? [];
  if (missingImageReason) {
    const line = `[render-check] no image: ${missingImageReason}`.slice(0, 500);
    console.warn(line);
    consoleLines.push(line);
  }

  await answerRenderCheck({
    sessionId,
    streamId,
    checkId,
    snapshotStorageId: capture?.storageId ?? undefined,
    consoleLines: consoleLines.slice(-40),
    stateJson: capture?.stateJson ?? "{}",
  });
  return capture;
}
