export const MAX_APP_ACTIONS = 16;
export const MAX_APP_ACTION_NAME_CHARS = 64;
export const MAX_APP_ACTION_DESCRIPTION_CHARS = 240;
export const MAX_APP_ACTION_ARGS_BYTES = 4 * 1024;
export const MAX_APP_ACTION_RESULT_BYTES = 4 * 1024;
export const MAX_APP_ACTION_ERROR_CHARS = 300;
export const APP_ACTION_TIMEOUT_MS = 8_000;
export const APP_ACTION_POLL_INTERVAL_MS = 100;

export const APP_ACTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const FORBIDDEN_APP_ACTION_NAME_PATTERN =
  /(solve|solution|answer|submit|grade)/i;

export type AppActionRegistration = {
  name: string;
  description: string;
};

export type AppActionRequest = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  requestedAt: number;
};

export type AppActionResult = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("App action data must be JSON-serializable");
  }
  return new TextEncoder().encode(json).byteLength;
}

export function normalizeAppActionRegistry(
  value: unknown,
): AppActionRegistration[] {
  if (!Array.isArray(value)) return [];
  const byName = new Map<string, AppActionRegistration>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { name?: unknown; description?: unknown };
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.description !== "string"
    ) {
      continue;
    }
    const name = candidate.name.trim();
    const description = candidate.description.trim();
    if (
      !name ||
      !description ||
      name.length > MAX_APP_ACTION_NAME_CHARS ||
      description.length > MAX_APP_ACTION_DESCRIPTION_CHARS ||
      !APP_ACTION_NAME_PATTERN.test(name) ||
      FORBIDDEN_APP_ACTION_NAME_PATTERN.test(name)
    ) {
      continue;
    }
    byName.set(name, { name, description });
    if (byName.size >= MAX_APP_ACTIONS) break;
  }
  return [...byName.values()];
}
