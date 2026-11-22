import type { ConnectionState } from "convex/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECONNECT_GRACE_MS,
  connectionLooksStuck,
  convexServerReachable,
  waitForReconnect,
} from "../stuckConnection";

/** A stand-in for the Convex client's connection state, flipped by `connect`. */
function fakeClient(connected: boolean) {
  let state = { isWebSocketConnected: connected } as ConnectionState;
  const listeners = new Set<(state: ConnectionState) => void>();
  return {
    connectionState: () => state,
    subscribeToConnectionState: (listener: (state: ConnectionState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect() {
      state = { isWebSocketConnected: true } as ConnectionState;
      listeners.forEach((listener) => listener(state));
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("connectionLooksStuck", () => {
  it("is stuck when the server answers and the socket stays down through the grace", async () => {
    vi.useFakeTimers();
    const client = fakeClient(false);
    const stuck = connectionLooksStuck(client, async () => true);
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    await expect(stuck).resolves.toBe(true);
    expect(client.listenerCount()).toBe(0);
  });

  it("is not stuck when Convex reconnects on its own during the grace", async () => {
    vi.useFakeTimers();
    const client = fakeClient(false);
    const stuck = connectionLooksStuck(client, async () => true);
    await vi.advanceTimersByTimeAsync(20_000); // a long backoff, still in the grace
    client.connect();
    await expect(stuck).resolves.toBe(false);
  });

  it("is offline, not stuck, and doesn't wait, when the server doesn't answer", async () => {
    const client = fakeClient(false);
    const subscribe = vi.spyOn(client, "subscribeToConnectionState");
    await expect(connectionLooksStuck(client, async () => false)).resolves.toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("doesn't probe the server while the socket is connected", async () => {
    const probe = vi.fn(async () => true);
    await expect(connectionLooksStuck(fakeClient(true), probe)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("waitForReconnect", () => {
  it("answers at once for a connected socket", async () => {
    await expect(waitForReconnect(fakeClient(true), 1_000)).resolves.toBe(true);
  });
});

describe("convexServerReachable", () => {
  const url = "https://example.convex.cloud";

  it("asks the deployment's /version with a fresh nonce and trusts a 2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("1.0", { status: 200 }));
    await expect(
      convexServerReachable(url, { fetchImpl: fetchImpl as typeof fetch }),
    ).resolves.toBe(true);
    const [requested] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(requested).toMatch(new RegExp(`^${url}/version\\?probe=\\d+$`));
  });

  it("is unreachable on an error status or a network failure", async () => {
    const down = vi.fn(async () => new Response("", { status: 503 }));
    const failing = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(
      convexServerReachable(url, { fetchImpl: down as typeof fetch }),
    ).resolves.toBe(false);
    await expect(
      convexServerReachable(url, { fetchImpl: failing as typeof fetch }),
    ).resolves.toBe(false);
  });

  it("gives up on a request that never answers", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const reachable = convexServerReachable(url, {
      timeoutMs: 5_000,
      fetchImpl: hanging as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(reachable).resolves.toBe(false);
  });
});
