export const CAPTURE_STATION_PENDING_UPLOAD_KEY =
  "rabbithole.captureStation.pendingUpload";

export type CaptureStationState<T extends string = string> = {
  mediaUri: string | null;
  mediaType: "image" | "video" | null;
  mimeType: string | null;
  sizeBytes: number | null;
  selectedScholarIds: T[];
};

export const emptyCaptureStationState: CaptureStationState = {
  mediaUri: null,
  mediaType: null,
  mimeType: null,
  sizeBytes: null,
  selectedScholarIds: [],
};

export function toggleRosterSelection<T extends string>(
  ids: T[],
  scholarId: T,
): T[] {
  const unique = [...new Set(ids)];
  return unique.includes(scholarId)
    ? unique.filter((id) => id !== scholarId)
    : [...unique, scholarId];
}

export function resetCaptureStationState<T extends string = string>(): CaptureStationState<T> {
  return { ...emptyCaptureStationState, selectedScholarIds: [] };
}

export function captureSessionIsReusable(
  expiresAt: number,
  now: number,
  hasPendingUpload: boolean,
): boolean {
  return expiresAt > now + (hasPendingUpload ? 0 : 60_000);
}

function captureErrorKind(error: unknown): string | null {
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? (error as { data?: unknown }).data
      : null;
  return typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    typeof (data as { kind?: unknown }).kind === "string"
    ? (data as { kind: string }).kind
    : null;
}

export function pendingUploadCannotRetry(error: unknown): boolean {
  const kind = captureErrorKind(error);
  if (kind === "capture_count_quota" || kind === "capture_storage_quota") {
    return true;
  }
  if (error instanceof SyntaxError) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "data" in error
        ? String((error as { data?: unknown }).data)
        : String(error);
  return [
    "reservation expired",
    "reservation is already in use",
    "upload is already registered",
    "capture session expired",
    "capture station is unavailable",
    "assigned capture mode has ended",
  ].some((reason) => message.toLowerCase().includes(reason));
}

export { captureErrorKind };

/**
 * Restores a persisted station "team" selection, dropping any ids that are no
 * longer in the current roster (a scholar was unenrolled, moved cohorts, …).
 * Order-stable relative to the stored list.
 */
export function restoreTeamSelection(
  storedIds: string[],
  rosterIds: string[],
): string[] {
  const roster = new Set(rosterIds);
  return storedIds.filter((id) => roster.has(id));
}

/** Device-scoped SecureStore key for the persisted station "team". */
export function captureStationTeamKey(deviceId: string): string {
  return `rabbithole.captureStation.team.${deviceId}`;
}
