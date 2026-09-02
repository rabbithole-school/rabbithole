export const ROOM_SHARED_USER_ID = "__room_shared__";
export const ROOM_SHARED_STATE_KEY = "default";
export const ROOM_PRESENCE_KEY = "__presence__";
export const ROOM_WRITE_RATE_KEY = "__write_rate__";

export const MAX_ROOM_MEMBERS = 60;
export const MAX_SHARED_APP_STATE_DOC_BYTES = 4 * 1024;
export const MAX_SHARED_APP_STATE_STRING_CHARS = 1_000;
export const ROOM_APP_STATE_MIN_WRITE_INTERVAL_MS = 200;
export const ROOM_PRESENCE_HEARTBEAT_MS = 15_000;
export const ROOM_PRESENCE_STALE_MS = 45_000;

export type RoomAppStateRateLimitErrorData = {
  code: "ROOM_APP_STATE_RATE_LIMITED";
  message: string;
  retryAfterMs: number;
};

export type RequestedRoom<ArtifactId, RoomId> = {
  artifactId: ArtifactId;
  roomId: RoomId;
};

/**
 * A resolver is the trust boundary for WebView room IDs. A failed resolution
 * must not replace an already-connected room.
 */
export function commitResolvedRoomSelection<ArtifactId, RoomId>(
  current: RequestedRoom<ArtifactId, RoomId> | null,
  artifactId: ArtifactId,
  resolvedRoomId: RoomId | null,
): RequestedRoom<ArtifactId, RoomId> | null {
  return resolvedRoomId === null
    ? current
    : { artifactId, roomId: resolvedRoomId };
}

export function isRoomAppStateRateLimitErrorData(
  value: unknown,
): value is RoomAppStateRateLimitErrorData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoomAppStateRateLimitErrorData>;
  return (
    candidate.code === "ROOM_APP_STATE_RATE_LIMITED" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryAfterMs === "number"
  );
}
