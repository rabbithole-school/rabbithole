/**
 * The shared SimpleMDM HTTP client (convex/lib/simpleMdmClient.ts): the one
 * place every SimpleMDM call goes through. These tests pin the behaviors
 * the console and the reconcilers depend on — retry on 429 honoring
 * Retry-After, legible ConvexError codes, an opt-out of transport retries
 * for ambiguous writes, and the exact-serial `?search` lookup.
 */
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  SIMPLEMDM_API_BASE,
  fetchSimpleMdmDevice,
  findSimpleMdmDeviceBySerial,
  isSimpleMdmApiError,
  isSimpleMdmNotFound,
  parseSimpleMdmDevice,
  simpleMdmErrorMessage,
  simpleMdmJson,
  simpleMdmRequest,
  simpleMdmRetryPolicy,
} from "../lib/simpleMdmClient";

const API_KEY = "test-key";

type Call = { url: string; init: RequestInit };

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Queue canned responses; each fetch pops the next one and records the call. */
function stubFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}

function deviceRecord(id: number, serial: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    attributes: {
      name: `iPad ${id}`,
      serial_number: serial,
      battery_level: "72%",
      last_seen_at: "2026-09-01T10:00:00Z",
      is_supervised: true,
      lost_mode_enabled: false,
      ...extra,
    },
  };
}

beforeAll(() => {
  simpleMdmRetryPolicy.baseDelayMs = 0;
  simpleMdmRetryPolicy.maxDelayMs = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("simpleMdmRequest", () => {
  test("builds the URL from a relative path and sends Basic auth", async () => {
    const { calls } = stubFetch([json({ ok: true })]);
    await simpleMdmRequest(API_KEY, "devices/42", { method: "GET" }, { what: "reading a device" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SIMPLEMDM_API_BASE}/devices/42`);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${API_KEY}:`)}`);
  });

  test("retries a 429 and succeeds, then reports rate-limited after the last attempt", async () => {
    const { calls } = stubFetch([
      new Response("slow down", { status: 429 }),
      json({ data: [] }),
    ]);
    const response = await simpleMdmRequest(API_KEY, "devices", {}, { what: "listing devices" });
    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(2);

    stubFetch([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ]);
    const failure = await simpleMdmRequest(API_KEY, "devices", {}, { what: "listing devices" }).catch(
      (error: unknown) => error,
    );
    expect(isSimpleMdmApiError(failure)).toBe(true);
    expect(failure).toBeInstanceOf(ConvexError);
    if (!isSimpleMdmApiError(failure)) throw new Error("expected SimpleMdmApiError");
    expect(failure.data.code).toBe("rate-limited");
    expect(failure.data.status).toBe(429);
    // The message is written for the console, and names the operation.
    expect(simpleMdmErrorMessage(failure, "fallback")).toMatch(/rate-limiting.*listing devices/);
  });

  test("stops retrying when Retry-After asks for longer than the cap", async () => {
    simpleMdmRetryPolicy.maxDelayMs = 5_000;
    try {
      const { calls } = stubFetch([
        new Response("", { status: 429, headers: { "retry-after": "60" } }),
        json({ data: [] }),
      ]);
      const failure = await simpleMdmRequest(API_KEY, "devices", {}, { what: "listing devices" }).catch(
        (error: unknown) => error,
      );
      // Retrying at the cap would ignore the server's cooldown and extend it.
      expect(calls).toHaveLength(1);
      if (!isSimpleMdmApiError(failure)) throw new Error("expected SimpleMdmApiError");
      expect(failure.data.code).toBe("rate-limited");
    } finally {
      simpleMdmRetryPolicy.maxDelayMs = 0;
    }
  });

  test("honors an HTTP-date Retry-After", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-01T10:00:00Z") });
    simpleMdmRetryPolicy.maxDelayMs = 5_000;
    try {
      const { calls } = stubFetch([
        new Response("", {
          status: 429,
          headers: { "retry-after": new Date(Date.now() + 3_000).toUTCString() },
        }),
        json({ data: [] }),
      ]);
      const pending = simpleMdmRequest(API_KEY, "devices", {}, { what: "listing devices" });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toHaveLength(2);
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      simpleMdmRetryPolicy.maxDelayMs = 0;
    }
  });

  test("honors a delay-seconds Retry-After within the cap", async () => {
    vi.useFakeTimers();
    simpleMdmRetryPolicy.maxDelayMs = 5_000;
    try {
      const { calls } = stubFetch([
        new Response("", { status: 429, headers: { "retry-after": "2" } }),
        json({ data: [] }),
      ]);
      const pending = simpleMdmRequest(API_KEY, "devices", {}, { what: "listing devices" });
      // Let the first fetch settle; the retry must now be waiting on the timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      simpleMdmRetryPolicy.maxDelayMs = 0;
    }
  });

  test("does not retry non-retryable statuses and maps 404 to not-found", async () => {
    const { calls } = stubFetch([new Response("", { status: 404 })]);
    const failure = await simpleMdmRequest(API_KEY, "devices/9", {}, { what: "reading a device" }).catch(
      (error: unknown) => error,
    );
    expect(calls).toHaveLength(1);
    expect(isSimpleMdmNotFound(failure)).toBe(true);

    stubFetch([new Response("<html>oops</html>", { status: 500 })]);
    const server = await simpleMdmRequest(API_KEY, "devices/9", {}, { what: "reading a device" }).catch(
      (error: unknown) => error,
    );
    if (!isSimpleMdmApiError(server)) throw new Error("expected SimpleMdmApiError");
    expect(server.data.code).toBe("http");
    expect(server.data.status).toBe(500);
    // Never echoes the body (an error page could contain a claim token).
    expect(server.data.message).not.toContain("oops");
  });

  test("retries transport errors by default, and not when a caller opts out", async () => {
    const { calls } = stubFetch([new TypeError("fetch failed"), json({ ok: true })]);
    await expect(
      simpleMdmRequest(API_KEY, "devices", {}, { what: "listing devices" }),
    ).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);

    const ambiguous = stubFetch([new TypeError("socket hang up"), json({ ok: true })]);
    const failure = await simpleMdmRequest(
      API_KEY,
      "custom_configuration_profiles/1",
      { method: "PATCH" },
      { what: "updating the profile", retryOnTransportError: false },
    ).catch((error: unknown) => error);
    expect(ambiguous.calls).toHaveLength(1);
    if (!isSimpleMdmApiError(failure)) throw new Error("expected SimpleMdmApiError");
    expect(failure.data.code).toBe("unreachable");
    expect(failure.data.message).toContain("socket hang up");
  });

  test("a per-call retryStatuses set narrows what is retried", async () => {
    const { calls } = stubFetch([new Response("", { status: 503 })]);
    const failure = await simpleMdmRequest(
      API_KEY,
      "custom_configuration_profiles/1",
      { method: "PATCH" },
      { what: "updating the profile", attempts: 2, retryStatuses: new Set([429]) },
    ).catch((error: unknown) => error);
    expect(calls).toHaveLength(1);
    if (!isSimpleMdmApiError(failure)) throw new Error("expected SimpleMdmApiError");
    expect(failure.data.status).toBe(503);
  });
});

describe("simpleMdmJson", () => {
  test("reports an unreadable body as its own code", async () => {
    stubFetch([new Response("not json", { status: 200 })]);
    const failure = await simpleMdmJson(API_KEY, "devices", { what: "listing devices" }).catch(
      (error: unknown) => error,
    );
    if (!isSimpleMdmApiError(failure)) throw new Error("expected SimpleMdmApiError");
    expect(failure.data.code).toBe("unreadable");
  });
});

describe("device lookup", () => {
  test("findSimpleMdmDeviceBySerial uses ?search and matches the exact serial only", async () => {
    const { calls } = stubFetch([
      json({
        data: [
          deviceRecord(1, "DMPABC123"),
          // SimpleMDM's search is a substring match; a longer serial that
          // contains the target must not be mistaken for it.
          deviceRecord(2, "XDMPABC1234"),
        ],
      }),
    ]);
    const device = await findSimpleMdmDeviceBySerial(API_KEY, " dmpabc123 ");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/devices");
    expect(url.searchParams.get("search")).toBe("DMPABC123");
    expect(url.searchParams.get("include_awaiting_enrollment")).toBe("true");
    expect(device).toMatchObject({
      id: "1",
      serial: "DMPABC123",
      name: "iPad 1",
      batteryLevel: 72,
      isSupervised: true,
      lostModeEnabled: false,
    });
    expect(device?.lastSeenAt).toBe(Date.parse("2026-09-01T10:00:00Z"));
  });

  test("findSimpleMdmDeviceBySerial returns null when nothing matches", async () => {
    stubFetch([json({ data: [deviceRecord(7, "OTHER")] })]);
    await expect(findSimpleMdmDeviceBySerial(API_KEY, "DMPABC123")).resolves.toBeNull();
  });

  test("fetchSimpleMdmDevice returns null on 404 and fills a missing serial from the caller", async () => {
    stubFetch([new Response("", { status: 404 })]);
    await expect(fetchSimpleMdmDevice(API_KEY, "42", "DMPABC123")).resolves.toBeNull();

    const detail = deviceRecord(42, "DMPABC123");
    delete (detail.attributes as { serial_number?: string }).serial_number;
    stubFetch([json({ data: detail })]);
    const device = await fetchSimpleMdmDevice(API_KEY, "42", "DMPABC123");
    expect(device).toMatchObject({ id: "42", serial: "DMPABC123" });
  });

  test("parseSimpleMdmDevice rejects a roster entry with no serial and no fallback", () => {
    const detail = deviceRecord(3, "X");
    delete (detail.attributes as { serial_number?: string }).serial_number;
    expect(parseSimpleMdmDevice(detail)).toBeNull();
    expect(parseSimpleMdmDevice({ id: "nope" })).toBeNull();
  });
});
