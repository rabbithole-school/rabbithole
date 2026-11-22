import { ConvexReactClient, type AuthTokenFetcher } from "convex/react";

/**
 * Keeps the Convex connection from dying for good when a sign-in renewal fails.
 *
 * When the server rejects an expired token, Convex stops its websocket, asks
 * `fetchToken` for a new one, and restarts the socket only after that call
 * RETURNS (`tryToReauthenticate` in
 * `convex/dist/esm/browser/sync/authentication_manager.js`, the same in 1.42.0
 * and 1.49.0). Its contract is a token or null. Nothing there catches a throw,
 * and nothing else restarts a stopped socket.
 *
 * @convex-dev/auth's fetcher does throw: it tries the refresh twice over about
 * 2.5 seconds, then rethrows the network error. A renewal that lands in a bad
 * moment, such as the first seconds after a BunnyPad wakes, leaves the app with
 * no connection until it is relaunched. What is already on screen stays, what
 * opens next never loads (an Apps tab with an empty grid), mutations queue
 * forever, and the renewal never reaches the server. One BunnyPad sat like that
 * for over twelve hours on 2026-11-05 while SimpleMDM could still reach it.
 *
 * Retrying here turns that into a wait. The call returns as soon as a renewal
 * gets through, and Convex restarts the socket as it always has. An answer from
 * the server, a token or null when the session is gone, comes straight back.
 * Timers stop while the app is in the background, so a sleeping iPad does not
 * keep retrying.
 */

/** Waits between failed attempts. The last one repeats until a call succeeds. */
export const AUTH_TOKEN_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

export function retryAuthTokenFetch(
  fetchToken: AuthTokenFetcher,
  {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isCurrent = () => true,
  }: {
    sleep?: (ms: number) => Promise<void>;
    /**
     * False once the client has signed out or signed in again. The loop then
     * stops and rethrows, as the fetcher always did, so a late reply for the
     * old session can't land on top of the new one. (@convex-dev/auth keeps
     * no guard against a stale refresh result. The scheduled early renewal
     * leaves the socket up, so it is the renewal a hand-over can overlap.)
     */
    isCurrent?: () => boolean;
  } = {},
): AuthTokenFetcher {
  return async (args) => {
    for (let failures = 0; ; failures++) {
      try {
        return await fetchToken(args);
      } catch (error) {
        if (!isCurrent()) throw error;
        const delay =
          AUTH_TOKEN_RETRY_DELAYS_MS[
            Math.min(failures, AUTH_TOKEN_RETRY_DELAYS_MS.length - 1)
          ];
        console.warn(
          `[auth] sign-in renewal failed, trying again in ${delay / 1000}s`,
          error,
        );
        await sleep(delay);
        if (!isCurrent()) throw error;
      }
    }
  };
}

/**
 * A ConvexReactClient whose token fetchers retry instead of throwing. Every
 * fetcher reaches it through `setAuth` (ConvexAuthProvider's, by way of
 * ConvexProviderWithAuth), and every sign-out through `clearAuth`, so counting
 * both tells a retry loop when the sign-in it is renewing has gone.
 */
export class RetryingAuthConvexReactClient extends ConvexReactClient {
  private authGeneration = 0;

  override setAuth(
    ...[fetchToken, ...rest]: Parameters<ConvexReactClient["setAuth"]>
  ) {
    const generation = ++this.authGeneration;
    super.setAuth(
      retryAuthTokenFetch(fetchToken, {
        isCurrent: () => generation === this.authGeneration,
      }),
      ...rest,
    );
  }

  override clearAuth() {
    this.authGeneration++;
    super.clearAuth();
  }
}
