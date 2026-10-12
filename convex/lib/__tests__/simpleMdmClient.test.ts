import { describe, expect, test } from "vitest";
import {
  mdmFailureCode,
  simpleMdmRequest,
  simpleMdmRetryTiming,
  SimpleMdmApiError,
} from "../simpleMdmClient";

describe("mdmFailureCode", () => {
  test("an HTTP failure carries its status, so a rate limit is legible as one", () => {
    expect(
      mdmFailureCode(
        new SimpleMdmApiError({
          code: "http",
          status: 429,
          what: "patching a profile",
          message: "SimpleMDM request failed",
        }),
      ),
    ).toBe("mdm-http-429");
    expect(
      mdmFailureCode(
        new SimpleMdmApiError({
          code: "http",
          status: 500,
          what: "patching a profile",
          message: "SimpleMDM request failed",
        }),
      ),
    ).toBe("mdm-http-500");
  });

  test("a non-HTTP SimpleMDM failure keeps its own code", () => {
    expect(
      mdmFailureCode(
        new SimpleMdmApiError({
          code: "unreachable",
          what: "patching a profile",
          message: "SimpleMDM unreachable",
        }),
      ),
    ).toBe("mdm-unreachable");
    expect(
      mdmFailureCode(
        new SimpleMdmApiError({
          code: "not-found",
          status: 404,
          what: "reading a profile",
          message: "SimpleMDM profile not found",
        }),
      ),
    ).toBe("mdm-not-found");
  });

  test("an in-repo refusal is recorded verbatim, because that message IS the diagnosis", () => {
    expect(
      mdmFailureCode(
        new Error("The dedicated app-access profile is not installed on this iPad."),
      ),
    ).toBe("refused: The dedicated app-access profile is not installed on this iPad.");
  });

  test("a long refusal is truncated, so one failure cannot bloat the row", () => {
    const code = mdmFailureCode(new Error("x".repeat(500)));
    expect(code.length).toBeLessThanOrEqual("refused: ".length + 180);
    expect(code.startsWith("refused: xxx")).toBe(true);
  });

  test("anything that is not an Error falls back to the legacy code", () => {
    expect(mdmFailureCode("boom")).toBe("request-failed");
    expect(mdmFailureCode(undefined)).toBe("request-failed");
    expect(mdmFailureCode({ message: "not an Error" })).toBe("request-failed");
  });
});

describe("simpleMdmRequest", () => {
  test("surfaces a long Retry-After without holding the action open or changing the failure code", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("remote response body must stay opaque", {
        status: 429,
        headers: { "Retry-After": "30" },
      });
    }) as typeof fetch;

    try {
      const error = await simpleMdmRequest(
        "test-key",
        "devices",
        { method: "GET" },
        { what: "listing devices" },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SimpleMdmApiError);
      expect((error as SimpleMdmApiError).data.retryAfterMs).toBe(30_000);
      expect((error as SimpleMdmApiError).data.retryTimingSource).toBe(
        "retry-after",
      );
      expect(mdmFailureCode(error)).toBe("mdm-rate-limited");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("uses the server clock for an epoch-seconds X-RateLimit-Reset", () => {
    const serverNow = Date.parse("Sat, 05 Sep 2026 06:00:00 GMT");
    const response = new Response(null, {
      status: 429,
      headers: {
        Date: new Date(serverNow).toUTCString(),
        "X-RateLimit-Reset": String((serverNow + 45_000) / 1_000),
      },
    });

    expect(simpleMdmRetryTiming(response, serverNow + 5 * 60_000)).toEqual({
      delayMs: 45_000,
      source: "x-ratelimit-reset",
    });
  });

  test("accepts epoch-millisecond and relative reset values defensively", () => {
    const serverNow = Date.parse("Sat, 05 Sep 2026 06:00:00 GMT");
    const absolute = new Response(null, {
      headers: {
        Date: new Date(serverNow).toUTCString(),
        "X-RateLimit-Reset": String(serverNow + 12_000),
      },
    });
    const relative = new Response(null, {
      headers: { "X-RateLimit-Reset": "12" },
    });

    expect(simpleMdmRetryTiming(absolute)).toEqual({
      delayMs: 12_000,
      source: "x-ratelimit-reset",
    });
    expect(simpleMdmRetryTiming(relative)).toEqual({
      delayMs: 12_000,
      source: "x-ratelimit-reset",
    });
  });

  test("waits for the later valid advisory when both headers are present", () => {
    const serverNow = Date.parse("Sat, 05 Sep 2026 06:00:00 GMT");
    const laterReset = new Response(null, {
      status: 429,
      headers: {
        Date: new Date(serverNow).toUTCString(),
        "Retry-After": "30",
        "X-RateLimit-Reset": String((serverNow + 90_000) / 1_000),
      },
    });
    const laterRetryAfter = new Response(null, {
      status: 429,
      headers: {
        Date: new Date(serverNow).toUTCString(),
        "Retry-After": "120",
        "X-RateLimit-Reset": String((serverNow + 90_000) / 1_000),
      },
    });

    expect(simpleMdmRetryTiming(laterReset)).toEqual({
      delayMs: 90_000,
      source: "x-ratelimit-reset",
    });
    expect(simpleMdmRetryTiming(laterRetryAfter)).toEqual({
      delayMs: 120_000,
      source: "retry-after",
    });
    expect(
      simpleMdmRetryTiming(
        new Response(null, {
          status: 429,
          headers: {
            Date: new Date(serverNow).toUTCString(),
            "Retry-After": "90",
            "X-RateLimit-Reset": String((serverNow + 90_000) / 1_000),
          },
        }),
      ),
    ).toEqual({
      delayMs: 90_000,
      source: "retry-after+x-ratelimit-reset",
    });
  });

  test("ignores stale or malformed advisories and caps implausible futures", async () => {
    const serverNow = Date.parse("Sat, 05 Sep 2026 06:00:00 GMT");
    expect(
      simpleMdmRetryTiming(
        new Response(null, {
          headers: {
            Date: "not-a-date",
            "Retry-After": "tomorrow-ish",
            "X-RateLimit-Reset": "not-a-timestamp",
          },
        }),
      ),
    ).toBeNull();
    expect(simpleMdmRetryTiming(new Response(null))).toBeNull();
    expect(
      simpleMdmRetryTiming(
        new Response(null, {
          headers: {
            Date: new Date(serverNow).toUTCString(),
            "X-RateLimit-Reset": String((serverNow - 1_000) / 1_000),
          },
        }),
      ),
    ).toBeNull();
    expect(
      simpleMdmRetryTiming(
        new Response(null, {
          headers: {
            Date: new Date(serverNow).toUTCString(),
            "X-RateLimit-Reset": "9999999999999999",
          },
        }),
      ),
    ).toEqual({
      delayMs: 60 * 60 * 1_000,
      source: "x-ratelimit-reset",
    });

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 429,
        headers: {
          "Retry-After": "not-a-delay",
          "X-RateLimit-Reset": "not-a-timestamp",
        },
      })) as typeof fetch;
    try {
      const error = await simpleMdmRequest(
        "test-key",
        "devices",
        { method: "GET" },
        { what: "listing devices", attempts: 1 },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SimpleMdmApiError);
      expect((error as SimpleMdmApiError).data.retryAfterMs).toBeUndefined();
      expect(
        (error as SimpleMdmApiError).data.retryTimingSource,
      ).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
