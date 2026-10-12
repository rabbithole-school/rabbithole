import { describe, it, expect, vi, afterEach } from "vitest";

import {
  CACHE_BYPASS_HEADER,
  CAPTIVE_PROBE_URL,
  FALLBACK_PROBE_URL,
  cacheBustedUrl,
  probeInternetReachable,
} from "../networkProbe";

type Handler = () => { status: number; body?: string } | "error" | "hang";

/** Strip the per-request `?_=<nonce>` so handlers can be keyed by base URL. */
function baseUrl(url: string): string {
  return url.replace(/[?&]_=[^&]*$/, "");
}

/**
 * A minimal XMLHttpRequest stand-in covering exactly the surface the probe
 * uses: open/setRequestHeader/timeout/send/abort + onload/onerror/ontimeout/
 * onabort. Records every request so tests can assert on URL + headers.
 */
function stubXhr(handlers: Record<string, Handler>) {
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];

  class FakeXhr {
    method = "";
    url = "";
    headers: Record<string, string> = {};
    timeout = 0;
    status = 0;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private aborted = false;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      // RN lowercases header names before handing them to native
      // (XMLHttpRequest.js `this._headers[header.toLowerCase()]`); Foundation
      // canonicalizes standard names back, so native still sees If-None-Match.
      this.headers[name.toLowerCase()] = value;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    send() {
      requests.push({ method: this.method, url: this.url, headers: this.headers });
      const handler = handlers[baseUrl(this.url)];
      // Settle asynchronously, like a real transport.
      queueMicrotask(() => {
        if (this.aborted) return;
        if (!handler) {
          this.onerror?.();
          return;
        }
        const result = handler();
        if (result === "error") {
          this.onerror?.();
          return;
        }
        if (result === "hang") return;
        this.status = result.status;
        this.responseText = result.body ?? "";
        this.onload?.();
      });
    }
  }

  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return requests;
}

const SUCCESS_PAGE =
  "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeInternetReachable", () => {
  it("uses the canonical production origin as its fallback", () => {
    expect(FALLBACK_PROBE_URL).toBe("https://rabbithole.school");
  });

  it("is online when Apple's endpoint returns its Success marker", async () => {
    const requests = stubXhr({
      [CAPTIVE_PROBE_URL]: () => ({ status: 200, body: SUCCESS_PAGE }),
    });

    await expect(probeInternetReachable()).resolves.toBe(true);
    // The fallback must not be consulted once the primary succeeds.
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
  });

  it("is OFFLINE behind a captive portal that answers 200 with a login page", async () => {
    stubXhr({
      [CAPTIVE_PROBE_URL]: () => ({
        status: 200,
        body: "<html><body><h1>Sign in to Guest Wi-Fi</h1></body></html>",
      }),
    });

    // A 200 alone is not proof — the body marker is what defeats the portal.
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  it("falls back to our prod origin when Apple's endpoint is blocked", async () => {
    const requests = stubXhr({
      [FALLBACK_PROBE_URL]: () => ({ status: 200 }),
    });

    await expect(probeInternetReachable()).resolves.toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].method).toBe("HEAD");
  });

  it("is offline when both endpoints fail", async () => {
    stubXhr({});
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  it("is offline when the fallback answers with an error status", async () => {
    stubXhr({
      [FALLBACK_PROBE_URL]: () => ({ status: 503 }),
    });
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  it("is offline when a request hangs past the deadline", async () => {
    vi.useFakeTimers();
    stubXhr({
      [CAPTIVE_PROBE_URL]: () => "hang",
      [FALLBACK_PROBE_URL]: () => "hang",
    });

    const probe = probeInternetReachable(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(probe).resolves.toBe(false);
  });

  it("never probes a dev/localhost origin", async () => {
    const requests = stubXhr({});
    await probeInternetReachable();

    const probed = requests.map((r) => r.url);
    expect(probed.every((url) => url.startsWith("https://"))).toBe(true);
    expect(probed.some((url) => /localhost|127\.0\.0\.1|192\.168\./.test(url))).toBe(false);
  });

  it("is offline, not rejected, when XHR setup throws synchronously", async () => {
    class ThrowingXhr {
      open() {
        throw new Error("open failed");
      }
    }
    vi.stubGlobal("XMLHttpRequest", ThrowingXhr);
    // A rejection here would wedge useOfflineRecovery's in-flight guard forever.
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  it("is offline when no XMLHttpRequest implementation exists", async () => {
    vi.stubGlobal("XMLHttpRequest", undefined);
    await expect(probeInternetReachable()).resolves.toBe(false);
  });

  // The iOS URL cache defeated the original fetch-based probe: Apple's page is
  // cacheable for a year, and expo/fetch drops `cache: "no-store"`, so an
  // offline iPad kept "succeeding" from cache and never left ASAM. Two
  // independent defenses, both asserted here.
  describe("cache bypass", () => {
    it("sends the If-None-Match header RN turns into ReloadIgnoringLocalCacheData", async () => {
      const requests = stubXhr({
        [FALLBACK_PROBE_URL]: () => ({ status: 200 }),
      });
      await probeInternetReachable();

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.headers[CACHE_BYPASS_HEADER.toLowerCase()]).toMatch(/^"probe-/);
        expect(request.headers["cache-control"]).toBe("no-cache");
      }
    });

    it("never reuses a URL across probes", async () => {
      const requests = stubXhr({
        [CAPTIVE_PROBE_URL]: () => ({ status: 200, body: SUCCESS_PAGE }),
      });
      await probeInternetReachable();
      await probeInternetReachable();
      await probeInternetReachable();

      const urls = requests.map((r) => r.url);
      expect(new Set(urls).size).toBe(urls.length);
      expect(urls.every((url) => baseUrl(url) === CAPTIVE_PROBE_URL)).toBe(true);
    });

    it("cacheBustedUrl appends with the right separator", () => {
      expect(cacheBustedUrl("https://a.example/x", "t1")).toBe("https://a.example/x?_=t1");
      expect(cacheBustedUrl("https://a.example/x?y=1", "t1")).toBe(
        "https://a.example/x?y=1&_=t1",
      );
    });
  });
});
