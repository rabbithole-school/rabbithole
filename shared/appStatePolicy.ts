export const MAX_CUSTOM_APP_STATE_ROWS = 200;
export const CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS = 500;
export const MAX_CUSTOM_APP_STATE_USER_ID_CHARS = 100;
export const MAX_CUSTOM_APP_STATE_KEY_CHARS = 64;

export type CustomAppStateRateLimitErrorData = {
  code: "CUSTOM_APP_STATE_RATE_LIMITED";
  message: string;
  retryAfterMs: number;
};

export function isCustomAppStateRateLimitErrorData(
  value: unknown,
): value is CustomAppStateRateLimitErrorData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CustomAppStateRateLimitErrorData>;
  return (
    candidate.code === "CUSTOM_APP_STATE_RATE_LIMITED" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryAfterMs === "number"
  );
}
