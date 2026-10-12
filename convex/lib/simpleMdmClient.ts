/**
 * The ONE SimpleMDM HTTP client.
 *
 * Every SimpleMDM request in the codebase goes through `simpleMdmRequest` so
 * that three properties hold everywhere, not just in whichever file was fixed
 * last:
 *
 *   1. A bounded deadline per attempt (no request hangs an action forever).
 *   2. Backoff with jitter on 429 / 5xx / transport failure, honoring
 *      `Retry-After` when SimpleMDM sends one. SimpleMDM does not document its
 *      rate limit; in practice a handful of roster walks in one minute trips
 *      it, and a 429 treated as a crash is what turned "push one claim" into
 *      an opaque "Server Error" for a staff member (2026-09-02).
 *   3. Failures are `ConvexError`s with a legible message and a machine-readable
 *      `code`, so the console can say "SimpleMDM is rate-limiting us; try again
 *      in a minute" instead of the redacted message Convex substitutes for a
 *      plain `Error` in prod.
 *
 * It also owns device LOOKUP. A device is found by serial with
 * `GET /devices?search=<serial>` — one request — never by paging the whole
 * roster. The roster walk (`listSimpleMdmDevices`) still exists for the bulk
 * callers that genuinely need every device (verify-all, the battery cron), and
 * those callers share ONE walk per invocation.
 */
import { ConvexError } from "convex/values";

export const SIMPLEMDM_API_BASE = "https://a.simplemdm.com/api/v1";

export type SimpleMdmErrorCode =
  | "unreachable"
  | "rate-limited"
  | "not-found"
  | "http"
  | "unreadable"
  | "pagination";

export type SimpleMdmRetryTimingSource =
  | "retry-after"
  | "x-ratelimit-reset"
  | "retry-after+x-ratelimit-reset"
  | "fallback";

export type SimpleMdmErrorData = {
  kind: "simplemdm";
  code: SimpleMdmErrorCode;
  /** The HTTP status when one was received. */
  status?: number;
  /** Server-requested delay, even when too long to await in this action. */
  retryAfterMs?: number;
  /** Which response header(s) supplied retryAfterMs. */
  retryTimingSource?: SimpleMdmRetryTimingSource;
  /** What the request was for — a short human phrase like "listing devices". */
  what: string;
  message: string;
};

/**
 * A SimpleMDM failure the console can render. `ConvexError` survives the
 * action → client boundary with its `data` intact; a plain `Error` does not.
 */
export class SimpleMdmApiError extends ConvexError<SimpleMdmErrorData> {
  constructor(data: Omit<SimpleMdmErrorData, "kind">) {
    super({ kind: "simplemdm", ...data });
    // ConvexError's own message is the JSON of `data`; a human reads this one.
    this.message = data.message;
  }
  get code(): SimpleMdmErrorCode {
    return this.data.code;
  }
  get status(): number | undefined {
    return this.data.status;
  }
}

export function isSimpleMdmApiError(error: unknown): error is SimpleMdmApiError {
  return (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    (error.data as { kind?: unknown }).kind === "simplemdm"
  );
}

export function isSimpleMdmNotFound(error: unknown): boolean {
  return isSimpleMdmApiError(error) && error.data.code === "not-found";
}

/**
 * Turn any thrown value from a SimpleMDM call into a sentence for a human.
 * SimpleMDM errors already carry one; anything else is reported plainly.
 */
export function simpleMdmErrorMessage(error: unknown, fallback: string): string {
  if (isSimpleMdmApiError(error)) return error.data.message;
  if (error instanceof ConvexError) {
    const data = error.data as unknown;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
      return (data as { message: string }).message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Cap on a stored refusal message, so one bad throw cannot bloat a document. */
const MAX_STORED_FAILURE_DETAIL = 180;

/**
 * A short, storable classifier for a failed MDM write.
 *
 * Every writer used to record the single string "request-failed", which made a
 * rate limit, a timeout, a 500 and one of our own safety refusals indis-
 * tinguishable in the record — precisely when the distinction is the whole
 * question. This preserves it.
 *
 * SAFETY: the two sources are both authored in this repo — `SimpleMdmApiError`
 * messages are built from a status and a fixed `what` phrase and deliberately
 * never echo a response body (see `simpleMdmRequest`), and every other throw on
 * a write path is a literal refusal string. Nothing here may interpolate a
 * remote body, a claim token, or scholar data.
 */
export function mdmFailureCode(error: unknown): string {
  if (isSimpleMdmApiError(error)) {
    const { code, status } = error.data;
    return code === "http" && status !== undefined ? `mdm-http-${status}` : `mdm-${code}`;
  }
  if (error instanceof Error && error.message.trim()) {
    return `refused: ${error.message.trim().slice(0, MAX_STORED_FAILURE_DETAIL)}`;
  }
  return "request-failed";
}

export function authorizationHeader(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

/**
 * Retry policy. Mutable so tests can zero the delays; production never
 * touches it. Three attempts total: the first, then two retries at roughly
 * 0.5 s and 1 s (plus jitter), capped at 8 s each. When `Retry-After` asks
 * for longer than the cap we do NOT retry early (that would extend the rate
 * limit) — we stop and surface `rate-limited` so the caller can come back.
 */
export const simpleMdmRetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  timeoutMs: 12_000,
};

export type SimpleMdmRequestOptions = {
  /** Short phrase for error messages: "listing devices", "updating the claim". */
  what: string;
  /** Override `simpleMdmRetryPolicy.attempts` for this call (min 1). */
  attempts?: number;
  /**
   * Whether a transport failure (timeout, connection reset) is retried.
   * Default true — right for reads and for writes whose repeat is harmless.
   * A write whose outcome is AMBIGUOUS after a timeout, and which has its own
   * reconciliation (deviceAppUnlock's whole-profile PATCH), sets this false so
   * the ambiguity is handed to that reconciler instead of papered over.
   */
  retryOnTransportError?: boolean;
  /** HTTP statuses that trigger a retry. Default 429/502/503/504. */
  retryStatuses?: ReadonlySet<number>;
};

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

type RetryTiming = {
  delayMs: number;
  source: SimpleMdmRetryTimingSource;
};

const EPOCH_SECONDS_FLOOR = 1_000_000_000;
const EPOCH_MILLISECONDS_FLOOR = 1_000_000_000_000;
const MAX_RETRY_ADVISORY_MS = 60 * 60 * 1_000;

function boundedDelayMs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(value, MAX_RETRY_ADVISORY_MS);
}

function absoluteDelayMs(resetAt: number, clockMs: number): number | null {
  if (!Number.isFinite(resetAt) || resetAt <= clockMs) return null;
  return boundedDelayMs(resetAt - clockMs);
}

function responseClockMs(response: Response, nowMs: number): number {
  const serverDate = response.headers.get("date");
  if (!serverDate) return nowMs;
  const parsed = Date.parse(serverDate);
  return Number.isFinite(parsed) ? parsed : nowMs;
}

function retryAfterDelayMs(response: Response, clockMs: number): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return boundedDelayMs(Number(raw) * 1_000);
  }
  const at = Date.parse(raw);
  return absoluteDelayMs(at, clockMs);
}

function rateLimitResetDelayMs(response: Response, clockMs: number): number | null {
  const raw = response.headers.get("x-ratelimit-reset")?.trim();
  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    const resetAt =
      value >= EPOCH_MILLISECONDS_FLOOR
        ? value
        : value >= EPOCH_SECONDS_FLOOR
          ? value * 1_000
          : null;
    return resetAt === null
      ? boundedDelayMs(value * 1_000)
      : absoluteDelayMs(resetAt, clockMs);
  }

  const resetAt = Date.parse(raw);
  return absoluteDelayMs(resetAt, clockMs);
}

/**
 * Conservative rate-limit timing from SimpleMDM's two advisory headers.
 *
 * `Retry-After` follows the HTTP delay-seconds / HTTP-date forms.
 * `X-RateLimit-Reset` is normally an epoch timestamp in seconds; milliseconds
 * and relative seconds are accepted defensively because SimpleMDM does not
 * publish the wire format. Absolute values use the response's `Date` clock
 * when available, avoiding an early retry when the Convex and server clocks
 * differ. When both headers are valid, the later advisory wins.
 */
export function simpleMdmRetryTiming(
  response: Response | null,
  nowMs = Date.now(),
): RetryTiming | null {
  if (!response) return null;
  const clockMs = responseClockMs(response, nowMs);
  const retryAfter = retryAfterDelayMs(response, clockMs);
  const reset = rateLimitResetDelayMs(response, clockMs);
  if (retryAfter === null && reset === null) return null;
  if (retryAfter !== null && reset !== null) {
    if (retryAfter > reset) {
      return { delayMs: retryAfter, source: "retry-after" };
    }
    if (reset > retryAfter) {
      return { delayMs: reset, source: "x-ratelimit-reset" };
    }
    return {
      delayMs: retryAfter,
      source: "retry-after+x-ratelimit-reset",
    };
  }
  if (retryAfter !== null) {
    return { delayMs: retryAfter, source: "retry-after" };
  }
  return reset !== null
    ? { delayMs: reset, source: "x-ratelimit-reset" }
    : null;
}

/**
 * How long to wait before the next attempt, or null when the server asked
 * for a wait longer than we are willing to hold an action open.
 */
function retryDelayMs(attempt: number, response: Response | null): number | null {
  const { baseDelayMs, maxDelayMs } = simpleMdmRetryPolicy;
  const timing = simpleMdmRetryTiming(response);
  if (timing !== null) {
    return timing.delayMs > maxDelayMs ? null : timing.delayMs;
  }
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), simpleMdmRetryPolicy.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Perform one SimpleMDM request with deadline, retry, and legible failure.
 * Resolves only with a 2xx response; everything else throws `SimpleMdmApiError`.
 *
 * `pathOrUrl` is either a path relative to the API base (`devices/42`) or a
 * full URL (for callers that build one with `URL`).
 */
export async function simpleMdmRequest(
  apiKey: string,
  pathOrUrl: string | URL,
  init: RequestInit,
  options: SimpleMdmRequestOptions,
): Promise<Response> {
  const url =
    pathOrUrl instanceof URL
      ? pathOrUrl.toString()
      : pathOrUrl.startsWith("http")
        ? pathOrUrl
        : `${SIMPLEMDM_API_BASE}/${pathOrUrl.replace(/^\//, "")}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", authorizationHeader(apiKey));

  const attempts = Math.max(1, options.attempts ?? simpleMdmRetryPolicy.attempts);
  const retryStatuses = options.retryStatuses ?? RETRYABLE_STATUSES;
  const retryOnTransportError = options.retryOnTransportError ?? true;

  let lastResponse: Response | null = null;
  let lastTransportError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const delay = retryDelayMs(attempt - 1, lastResponse);
      if (delay === null) break;
      await sleep(delay);
    }
    lastResponse = null;
    try {
      lastResponse = await fetchWithDeadline(url, { ...init, headers });
    } catch (error) {
      lastTransportError = error;
      if (!retryOnTransportError) break;
      continue;
    }
    if (lastResponse.ok) return lastResponse;
    if (!retryStatuses.has(lastResponse.status)) break;
  }

  if (lastResponse === null) {
    const detail =
      lastTransportError instanceof Error && lastTransportError.name === "AbortError"
        ? "the request timed out"
        : lastTransportError instanceof Error && lastTransportError.message
          ? lastTransportError.message
          : "network request failed";
    throw new SimpleMdmApiError({
      code: "unreachable",
      what: options.what,
      message: `Could not reach SimpleMDM while ${options.what} (${detail}). Try again in a moment.`,
    });
  }
  if (lastResponse.status === 429) {
    const retryTiming = simpleMdmRetryTiming(lastResponse);
    throw new SimpleMdmApiError({
      code: "rate-limited",
      status: 429,
      ...(retryTiming === null
        ? {}
        : {
            retryAfterMs: retryTiming.delayMs,
            retryTimingSource: retryTiming.source,
          }),
      what: options.what,
      message: `SimpleMDM is rate-limiting requests while ${options.what}. Wait a minute, then try again.`,
    });
  }
  // A distinct code: callers that cache a SimpleMDM device id use it to know
  // the cache is stale (`isSimpleMdmNotFound`).
  if (lastResponse.status === 404) {
    throw new SimpleMdmApiError({
      code: "not-found",
      status: 404,
      what: options.what,
      message: `SimpleMDM has no record for that while ${options.what} (HTTP 404).`,
    });
  }
  // Never include the body: an error page could echo a claim token.
  throw new SimpleMdmApiError({
    code: "http",
    status: lastResponse.status,
    what: options.what,
    message: `SimpleMDM returned HTTP ${lastResponse.status} while ${options.what}.`,
  });
}

/** `simpleMdmRequest` + JSON parse. The parsed body is returned untyped. */
export async function simpleMdmJson(
  apiKey: string,
  pathOrUrl: string | URL,
  options: SimpleMdmRequestOptions,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await simpleMdmRequest(
    apiKey,
    pathOrUrl,
    { ...init, headers: { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) } },
    options,
  );
  try {
    return await response.json();
  } catch {
    throw new SimpleMdmApiError({
      code: "unreadable",
      status: response.status,
      what: options.what,
      message: `SimpleMDM returned an unreadable response while ${options.what}.`,
    });
  }
}

// ── Devices ──────────────────────────────────────────────────────────────

export type SimpleMdmDeviceDetails = {
  id: string;
  serial: string;
  name: string | null;
  batteryLevel: number | null;
  lastSeenAt: number | null;
  isSupervised: boolean | null;
  lostModeEnabled: boolean | null;
  /**
   * SimpleMDM's enrollment status, lowercased ("enrolled", "awaiting enrollment",
   * "unenrolled", …), or null when it wasn't reported. The roster walk asks for
   * `include_awaiting_enrollment=true`, so "SimpleMDM knows this serial" and
   * "this device is actually managed right now" are different questions.
   */
  status: string | null;
};

type RawDevice = {
  id?: unknown;
  attributes?: {
    serial_number?: unknown;
    name?: unknown;
    battery_level?: unknown;
    last_seen_at?: unknown;
    is_supervised?: unknown;
    lost_mode_enabled?: unknown;
    status?: unknown;
  };
};

/**
 * Is this SimpleMDM status an ACTIVELY enrolled device? A boxed / ADE-pending
 * iPad (`awaiting enrollment`) and a retired one (`unenrolled`) are both in the
 * roster the walk returns, and neither is a device an operator could sensibly
 * act on as "managed right now".
 *
 * Deliberately mirrors `isEnrolledStatus` in `scripts/lib/ipadRelease.mjs`,
 * which draws the same line for Ad Hoc device coverage. The two are kept as a
 * mirrored pair rather than one import: that file is a plain-Node `.mjs` CLI
 * library outside the Convex bundle. Change one, change the other.
 */
export function isEnrolledSimpleMdmStatus(
  status: string | null | undefined,
): boolean {
  return String(status ?? "").trim().toLowerCase() === "enrolled";
}

export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Parse one device record from any SimpleMDM device response. Missing or
 * non-conforming attributes become `null` ("not reported"), never a guess.
 */
/**
 * Parse one SimpleMDM device record. Roster entries must carry a serial (the
 * roster is keyed by it); a detail read (`GET /devices/{id}`) may pass
 * `knownSerial` so a record that omits `serial_number` still parses.
 */
export function parseSimpleMdmDevice(
  raw: unknown,
  knownSerial?: string,
): SimpleMdmDeviceDetails | null {
  if (!raw || typeof raw !== "object") return null;
  const device = raw as RawDevice;
  const id = idOf(device.id);
  const serialRaw = device.attributes?.serial_number;
  if (!id) return null;
  const serial =
    typeof serialRaw === "string" && normalizeSerial(serialRaw)
      ? normalizeSerial(serialRaw)
      : knownSerial
        ? normalizeSerial(knownSerial)
        : "";
  if (!serial) return null;
  const attributes = device.attributes ?? {};
  const batteryMatch =
    typeof attributes.battery_level === "string"
      ? attributes.battery_level.trim().match(/^(\d{1,3})%$/)
      : null;
  const batteryLevel = batteryMatch ? Number(batteryMatch[1]) : null;
  const parsedLastSeen =
    typeof attributes.last_seen_at === "string"
      ? Date.parse(attributes.last_seen_at)
      : Number.NaN;
  return {
    id,
    serial,
    name: typeof attributes.name === "string" ? attributes.name.trim() || null : null,
    batteryLevel: batteryLevel !== null && batteryLevel <= 100 ? batteryLevel : null,
    lastSeenAt: Number.isFinite(parsedLastSeen) ? parsedLastSeen : null,
    isSupervised:
      typeof attributes.is_supervised === "boolean" ? attributes.is_supervised : null,
    lostModeEnabled:
      typeof attributes.lost_mode_enabled === "boolean"
        ? attributes.lost_mode_enabled
        : null,
    status:
      typeof attributes.status === "string"
        ? attributes.status.trim().toLowerCase() || null
        : null,
  };
}

type ListResponse = { data?: unknown; has_more?: unknown; next?: unknown };

function deviceArray(payload: unknown, what: string): unknown[] {
  const data = (payload as ListResponse | null)?.data;
  if (!Array.isArray(data)) {
    throw new SimpleMdmApiError({
      code: "unreadable",
      what,
      message: `SimpleMDM returned an invalid device list while ${what}.`,
    });
  }
  return data;
}

/**
 * Find ONE device by serial with `GET /devices?search=`. SimpleMDM's search
 * matches name / UDID / serial / IMEI / MAC / phone, so the result is filtered
 * to an exact serial match before it is trusted. One request, no paging.
 *
 * `include_awaiting_enrollment=true` is load-bearing: an ADE-assigned iPad that
 * has not finished Setup Assistant is exactly the one whose claim we most want
 * to stage, and SimpleMDM omits it from the list otherwise.
 */
export async function findSimpleMdmDeviceBySerial(
  apiKey: string,
  serial: string,
): Promise<SimpleMdmDeviceDetails | null> {
  const target = normalizeSerial(serial);
  if (!target) return null;
  const url = new URL(`${SIMPLEMDM_API_BASE}/devices`);
  url.searchParams.set("search", target);
  url.searchParams.set("include_awaiting_enrollment", "true");
  url.searchParams.set("limit", "100");
  const what = `looking up device ${target}`;
  const payload = await simpleMdmJson(apiKey, url, { what });
  const matches = deviceArray(payload, what)
    .map((raw) => parseSimpleMdmDevice(raw))
    .filter((device): device is SimpleMdmDeviceDetails => device?.serial === target);
  return matches[0] ?? null;
}

/**
 * `GET /devices/{id}` — returns `null` when SimpleMDM no longer knows the id
 * (the cached-id-is-stale signal), throws on every other failure.
 */
export async function fetchSimpleMdmDevice(
  apiKey: string,
  simpleMdmDeviceId: string,
  knownSerial?: string,
): Promise<SimpleMdmDeviceDetails | null> {
  const what = "reading the device";
  let payload: unknown;
  try {
    payload = await simpleMdmJson(
      apiKey,
      `devices/${encodeURIComponent(simpleMdmDeviceId)}`,
      { what },
    );
  } catch (error) {
    if (isSimpleMdmNotFound(error)) return null;
    throw error;
  }
  const data = (payload as { data?: unknown } | null)?.data;
  const parsed = parseSimpleMdmDevice(data, knownSerial);
  if (!parsed) {
    throw new SimpleMdmApiError({
      code: "unreadable",
      what,
      message: `SimpleMDM returned an invalid device record while ${what}.`,
    });
  }
  return parsed;
}

/**
 * Page through the whole roster, calling `onPage` per page (return `true` to
 * stop early). BULK callers only — anything that needs one device uses
 * `findSimpleMdmDeviceBySerial`. Callers that need many serials share one walk.
 */
export async function walkSimpleMdmDevicePages(
  apiKey: string,
  onPage: (devices: SimpleMdmDeviceDetails[]) => boolean | void,
): Promise<void> {
  const what = "listing devices";
  let startingAfter: string | null = null;
  const seenCursors = new Set<string>();

  for (let page = 0; page < 500; page += 1) {
    const url = new URL(`${SIMPLEMDM_API_BASE}/devices`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("include_awaiting_enrollment", "true");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const payload = (await simpleMdmJson(apiKey, url, { what })) as ListResponse;
    const raw = deviceArray(payload, what);
    const devices = raw
      .map((raw) => parseSimpleMdmDevice(raw))
      .filter((device): device is SimpleMdmDeviceDetails => device !== null);
    if (onPage(devices) === true) return;
    if (payload.has_more !== true) return;

    const lastId = idOf((raw.at(-1) as RawDevice | undefined)?.id);
    const next =
      typeof payload.next === "string" || typeof payload.next === "number"
        ? String(payload.next)
        : lastId;
    if (!next || seenCursors.has(next)) {
      throw new SimpleMdmApiError({
        code: "pagination",
        what,
        message: "SimpleMDM device pagination stopped before the roster was complete.",
      });
    }
    seenCursors.add(next);
    startingAfter = next;
  }

  throw new SimpleMdmApiError({
    code: "pagination",
    what,
    message: "SimpleMDM device pagination exceeded the safety limit.",
  });
}

/** The whole roster keyed by normalized serial. First record wins on a dup. */
export async function listSimpleMdmDevices(
  apiKey: string,
): Promise<Map<string, SimpleMdmDeviceDetails>> {
  const bySerial = new Map<string, SimpleMdmDeviceDetails>();
  await walkSimpleMdmDevicePages(apiKey, (devices) => {
    for (const device of devices) {
      if (!bySerial.has(device.serial)) bySerial.set(device.serial, device);
    }
  });
  return bySerial;
}

// ── Installed apps (device truth panel, TRA-241 step 1) ───────────────────

type RawInstalledApp = { attributes?: { identifier?: unknown } };

function installedAppArray(payload: unknown, what: string): unknown[] {
  const data = (payload as ListResponse | null)?.data;
  if (!Array.isArray(data)) {
    throw new SimpleMdmApiError({
      code: "unreadable",
      what,
      message: `SimpleMDM returned an invalid installed-apps list while ${what}.`,
    });
  }
  return data;
}

/**
 * `GET /devices/{id}/installed_apps`, paginated exactly like
 * `walkSimpleMdmDevicePages` — same `limit=100`/`starting_after` cursor idiom,
 * same "cursor repeated" pagination-safety guard. Every reported bundle id
 * (`attributes.identifier`) is returned, not just the catalog's managed apps —
 * storing the full read-back means a later question about any app never needs
 * a second SimpleMDM call for the same device. Throws exactly like the other
 * per-device client calls (`fetchSimpleMdmDevice`); the caller
 * (`refreshSnapshotsForInstitution`) decides whether one device's failure
 * should stop the batch.
 */
export async function fetchInstalledAppBundleIds(
  apiKey: string,
  simpleMdmDeviceId: string,
): Promise<string[]> {
  const what = "reading installed apps";
  const bundleIds: string[] = [];
  let startingAfter: string | null = null;
  const seenCursors = new Set<string>();

  for (let page = 0; page < 500; page += 1) {
    const url = new URL(
      `${SIMPLEMDM_API_BASE}/devices/${encodeURIComponent(simpleMdmDeviceId)}/installed_apps`,
    );
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const payload = (await simpleMdmJson(apiKey, url, { what })) as ListResponse;
    const raw = installedAppArray(payload, what);
    for (const entry of raw) {
      const identifier = (entry as RawInstalledApp)?.attributes?.identifier;
      if (typeof identifier === "string" && identifier.trim()) {
        bundleIds.push(identifier.trim());
      }
    }
    if (payload.has_more !== true) return bundleIds;

    const lastId = idOf((raw.at(-1) as { id?: unknown } | undefined)?.id);
    const next =
      typeof payload.next === "string" || typeof payload.next === "number"
        ? String(payload.next)
        : lastId;
    if (!next || seenCursors.has(next)) {
      throw new SimpleMdmApiError({
        code: "pagination",
        what,
        message: "SimpleMDM installed-apps pagination stopped before the list was complete.",
      });
    }
    seenCursors.add(next);
    startingAfter = next;
  }

  throw new SimpleMdmApiError({
    code: "pagination",
    what,
    message: "SimpleMDM installed-apps pagination exceeded the safety limit.",
  });
}
