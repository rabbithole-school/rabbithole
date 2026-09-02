export type AssignedDeviceCaptureState = {
  captureStationId: string;
  expiresAt: number;
  updatedAt: number;
};

export type CaptureStationGateMode = "app" | "static" | "assigned";

export function captureStationGateMode({
  hasStaticToken,
  assignment,
  isConnected,
  now,
}: {
  hasStaticToken: boolean;
  assignment: AssignedDeviceCaptureState | null | undefined;
  isConnected: boolean;
  now: number;
}): CaptureStationGateMode {
  if (hasStaticToken) return "static";
  if (!isConnected || !assignment || assignment.expiresAt <= now) return "app";
  return "assigned";
}

export function assignedSessionIsCurrent({
  assignment,
  sessionRevision,
  sessionExpiresAt,
  now,
}: {
  assignment: AssignedDeviceCaptureState | null | undefined;
  sessionRevision: number | null;
  sessionExpiresAt: number | null;
  now: number;
}): boolean {
  return Boolean(
    assignment &&
      assignment.expiresAt > now &&
      sessionRevision === assignment.updatedAt &&
      sessionExpiresAt !== null &&
      sessionExpiresAt > now,
  );
}

/**
 * Compact, scholar-facing expiry for the capture-station header:
 *   same day → "ends 4:40pm"
 *   next day → "ends tomorrow 4:40pm"
 *   later    → "ends Tue 4:40pm"  (short-weekday fallback; a temporary station
 *                                  rarely spans more than a day)
 * Day boundaries and wall time both resolve in `timeZone` (default the device's,
 * which on a school iPad is the school's timezone).
 */
export function formatCaptureStationExpiryShort(
  expiresAt: number,
  now: number = Date.now(),
  timeZone?: string,
): string {
  const dayKey = (ts: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ts);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(expiresAt)
    .replace(/\s+/g, "")
    .toLowerCase(); // "4:40pm"

  const expiryKey = dayKey(expiresAt);
  if (expiryKey === dayKey(now)) return `ends ${time}`;
  if (expiryKey === dayKey(now + 24 * 60 * 60 * 1000)) {
    return `ends tomorrow ${time}`;
  }
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(expiresAt);
  return `ends ${weekday} ${time}`;
}
