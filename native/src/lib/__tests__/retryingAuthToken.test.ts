import { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_TOKEN_RETRY_DELAYS_MS,
  RetryingAuthConvexReactClient,
  retryAuthTokenFetch,
} from "../retryingAuthToken";

const noSleep = (_ms: number) => Promise.resolve();
const networkError = () => new TypeError("Network request failed");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retryAuthTokenFetch", () => {
  it("passes the args through and returns the token on the first try", async () => {
    const fetchToken = vi.fn().mockResolvedValue("token");
    const sleep = vi.fn(noSleep);

    await expect(
      retryAuthTokenFetch(fetchToken, { sleep })({ forceRefreshToken: true }),
    ).resolves.toBe("token");
    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: true });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns null without retrying, so a session that is gone still signs out", async () => {
    const fetchToken = vi.fn().mockResolvedValue(null);

    await expect(
      retryAuthTokenFetch(fetchToken, { sleep: noSleep })({ forceRefreshToken: true }),
    ).resolves.toBeNull();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("returns a null that arrives after a failure", async () => {
    const fetchToken = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(null);

    await expect(
      retryAuthTokenFetch(fetchToken, { sleep: noSleep })({ forceRefreshToken: true }),
    ).resolves.toBeNull();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying a throwing renewal past the end of the backoff list", async () => {
    const failures = AUTH_TOKEN_RETRY_DELAYS_MS.length + 3;
    let calls = 0;
    const fetchToken = vi.fn(async () => {
      calls += 1;
      if (calls <= failures) throw networkError();
      return "fresh-token";
    });
    const sleep = vi.fn(noSleep);

    await expect(
      retryAuthTokenFetch(fetchToken, { sleep })({ forceRefreshToken: true }),
    ).resolves.toBe("fresh-token");
    expect(fetchToken).toHaveBeenCalledTimes(failures + 1);
    expect(sleep).toHaveBeenCalledTimes(failures);
    // Never a tight loop: every wait is at least the first delay, and the
    // later ones hold at the last.
    const waits = sleep.mock.calls.map(([ms]) => ms);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(AUTH_TOKEN_RETRY_DELAYS_MS[0]);
    expect(waits.slice(-3)).toEqual(
      Array(3).fill(AUTH_TOKEN_RETRY_DELAYS_MS.at(-1)),
    );
  });

  it("stops and rethrows once the sign-in it is renewing has gone", async () => {
    let current = true;
    const error = networkError();
    const fetchToken = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {
      current = false; // a sign-out lands while the loop waits
    });

    await expect(
      retryAuthTokenFetch(fetchToken, { sleep, isCurrent: () => current })({
        forceRefreshToken: true,
      }),
    ).rejects.toBe(error);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});

describe("RetryingAuthConvexReactClient", () => {
  // `setAuth` and `clearAuth` reach the socket through `sync`, which the base
  // client builds lazily; stubbing them on the prototype keeps this offline.
  function client() {
    const setAuth = vi
      .spyOn(ConvexReactClient.prototype, "setAuth")
      .mockImplementation(() => {});
    const clearAuth = vi
      .spyOn(ConvexReactClient.prototype, "clearAuth")
      .mockImplementation(() => {});
    return {
      client: new RetryingAuthConvexReactClient("https://example.convex.cloud"),
      setAuth,
      clearAuth,
    };
  }

  it("hands Convex a retrying fetcher and keeps both callbacks", async () => {
    const { client: convex, setAuth } = client();
    const fetchToken = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce("fresh-token");
    const onChange = vi.fn();
    const onRefreshChange = vi.fn();

    convex.setAuth(fetchToken, onChange, onRefreshChange);

    expect(setAuth).toHaveBeenCalledTimes(1);
    const [wrapped, passedOnChange, passedOnRefreshChange] = setAuth.mock.calls[0];
    expect(wrapped).not.toBe(fetchToken);
    expect(passedOnChange).toBe(onChange);
    expect(passedOnRefreshChange).toBe(onRefreshChange);

    vi.useFakeTimers();
    try {
      const token = wrapped({ forceRefreshToken: true });
      await vi.runAllTimersAsync();
      await expect(token).resolves.toBe("fresh-token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an older fetcher's retries after a sign-out", async () => {
    const { client: convex, setAuth, clearAuth } = client();
    const error = networkError();
    const fetchToken = vi.fn().mockRejectedValue(error);

    convex.setAuth(fetchToken);
    const [wrapped] = setAuth.mock.calls[0];

    vi.useFakeTimers();
    try {
      const token = wrapped({ forceRefreshToken: true });
      const settled = expect(token).rejects.toBe(error);
      convex.clearAuth();
      await vi.runAllTimersAsync();
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});
