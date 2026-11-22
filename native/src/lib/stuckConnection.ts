import type { ConvexReactClient } from "convex/react";

type ConnectionClient = Pick<
  ConvexReactClient,
  "connectionState" | "subscribeToConnectionState"
>;

/**
 * How long a reachable server gets for Convex's own reconnect before the
 * connection counts as stuck. Convex retries on a timer only (its "online"
 * listener needs `window`, which React Native lacks), backing off to 16 s with
 * ±50% jitter, so up to 24 s (`maxBackoff` and `nextBackoff` in
 * `convex/dist/esm/browser/sync/web_socket_manager.js`, 1.42.0). The sign-in
 * retry waits at most 10 s (`retryingAuthToken.ts`). 30 s covers both.
 */
export const RECONNECT_GRACE_MS = 30_000;

/**
 * Is the Convex connection stuck rather than offline or still reconnecting?
 *
 * Once Convex stops its websocket to fetch a sign-in token, nothing in its
 * public API starts it again, so a refresh can only recover by reloading the
 * app (`retryingAuthToken.ts` keeps the known cause from leaving it stopped).
 * A stopped socket and one waiting out a reconnect look the same at any one
 * moment, and a needless reload throws away mutations still queued to send.
 * So this says "stuck" only when the server answers over plain HTTP AND the
 * socket then stays down through a full reconnect wait. Really offline, it
 * answers "not stuck" as soon as the server check fails.
 */
export async function connectionLooksStuck(
  client: ConnectionClient,
  serverReachable: () => Promise<boolean>,
  graceMs = RECONNECT_GRACE_MS,
): Promise<boolean> {
  if (client.connectionState().isWebSocketConnected) return false;
  if (!(await serverReachable())) return false;
  return !(await waitForReconnect(client, graceMs));
}

/** Resolves true as soon as the socket connects, or false after `timeoutMs`. */
export function waitForReconnect(
  client: ConnectionClient,
  timeoutMs: number,
): Promise<boolean> {
  if (client.connectionState().isWebSocketConnected) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    unsubscribe = client.subscribeToConnectionState((state) => {
      if (!state.isWebSocketConnected) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/**
 * Does the Convex deployment answer at all? `/version` needs no sign-in. The
 * nonce keeps a cached answer from standing in for a live one (an earlier
 * probe of captive.apple.com was served from the iOS cache for a year).
 */
export async function convexServerReachable(
  deploymentUrl: string,
  { timeoutMs = 5_000, fetchImpl = fetch }: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${deploymentUrl}/version?probe=${Date.now()}`,
      { signal: controller.signal },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
