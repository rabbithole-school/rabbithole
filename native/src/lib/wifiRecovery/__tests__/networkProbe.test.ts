import { describe, it, expect, vi, afterEach } from "vitest";

import {
  CAPTIVE_PROBE_URL,
  FALLBACK_PROBE_URL,
  probeInternetReachable,
} from "../networkProbe";

/** A minimal Response stand-in — only the fields the probe reads. */
function res(args: { ok: boolean; body?: string }) {
  return {
    ok: args.ok,
    text: async () => args.body ?? "",
  } as unknown as Response;
}

/** Install a fetch stub that answers per-URL; unlisted URLs reject. */
function stubFetch(handlers: Record<string, () => Promise<Response>>) {
  const spy = vi.fn(async (url: string) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`network unreachable: ${url}`);
    return handler();
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeInternetReachable", () => {
  it("uses the canonical production origin as its fallback", () => {
    expect(FALLBACK_PROBE_URL).toBe("https://rabbithole.school");
  });

  it("is online when Apple's endpoint returns its Success marker", async () => {
    const fetchSpy = stubFetch({
      [CAPTIVE_PROBE_URL]: async () =>
        res({ ok: true, body: "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>" }),
    });

    await expect(probeInternetReachable()).resolves.toBe(true);
    // The fallback must not be consulted once the primary succeeds.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("is OFFLINE behind a captive portal that answers 200 with a login page", async () => {
    stubFetch({
      [CAPTIVE_PROBE_URL]: async () =>
        res({ ok: true, body: "<html><body><h1>Sign in to Guest Wi-Fi</h1></body></html>" }),
    });

    // A 200 alone is not proof — the body marker is what defeats the portal.
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  it("falls back to our prod origin when Apple's endpoint is blocked", async () => {
    const fetchSpy = stubFetch({
      [FALLBACK_PROBE_URL]: async () => res({ ok: true }),
    });

    await expect(probeInternetReachable()).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("is offline when both endpoints fail", async () => {
    stubFetch({});
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  it("is offline when the fallback answers with an error status", async () => {
    stubFetch({
      [FALLBACK_PROBE_URL]: async () => res({ ok: false }),
    });
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  it("never probes a dev/localhost origin", async () => {
    const fetchSpy = stubFetch({});
    await probeInternetReachable();

    const probed = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(probed.every((url) => url.startsWith("https://"))).toBe(true);
    expect(probed.some((url) => /localhost|127\.0\.0\.1|192\.168\./.test(url))).toBe(false);
  });

  it("does not throw when the response body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === CAPTIVE_PROBE_URL) {
          return {
            ok: true,
            text: async () => {
              throw new Error("stream closed");
            },
          } as unknown as Response;
        }
        throw new Error("unreachable");
      }),
    );

    await expect(probeInternetReachable()).resolves.toBe(false);
  });
});
