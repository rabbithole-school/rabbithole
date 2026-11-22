// Typed CLIENT ADAPTER for the two backend calls the native launcher makes:
// the cold-path projection nudge and, for an app with no URL scheme, the
// installed-app read (both in `convex/deviceAppUnlock.ts`).
//
// It used to bind three functions — `status`, `requestUnlock`, `markReturned` —
// because the client DROVE the launch-time unlock ceremony. Under the allowlist
// projection the teacher's grant is the authority and the backend reconciler
// converges each bound device on its own, so the client neither asks for access
// nor reports handing it back. All that is left is a latency hint.
//
// Why this is its own seam rather than `api.deviceAppUnlock.*`:
//   • TS resolves `@convex/api` to the repo's generated API, but METRO resolves
//     it to the vendored snapshot in native/vendor/convex_generated. A brand-new
//     backend module is in neither until codegen and the vendor refresh run, so
//     referencing it through `api` would break the Release bundle.
//   • `makeFunctionReference` — the same pattern convex/http.ts, convex/crons.ts
//     and deviceAppUnlock.ts itself already use — is name-based at runtime and
//     fully typed at compile time, with no cast and no generated file.
//
// It is also the ONE place a backend rename has to be reconciled: nothing else
// in the native app names a backend function for this feature.
//
// Backend contract this binds to (convex/deviceAppUnlock.ts):
//   deviceAppUnlock:nudgeProjection          authedMutation  {deviceId} → {nudged}
//   deviceAppUnlock:managedAppInstallState   authedQuery     {deviceId, externalAppId}
//                                             → "installed" | "missing" | "unknown"
// The server owns app identity, so there is no app argument: the nudge says
// "converge THIS iPad now", and the projection decides what that means.

import { makeFunctionReference } from "convex/server";
import type { ConvexReactClient } from "convex/react";

/**
 * ── THE SINGLE RENAME POINT ────────────────────────────────────────────────
 * Changing this one string is the entire client-side cost of a backend rename.
 */
const NUDGE_FUNCTION = "deviceAppUnlock:nudgeProjection";
const INSTALL_STATE_FUNCTION = "deviceAppUnlock:managedAppInstallState";

const nudgeProjectionRef = makeFunctionReference<
  "mutation",
  { deviceId: string },
  { nudged: boolean }
>(NUDGE_FUNCTION);

export type ManagedAppInstallState = "installed" | "missing" | "unknown";

const installStateRef = makeFunctionReference<
  "query",
  { deviceId: string; externalAppId: string },
  ManagedAppInstallState
>(INSTALL_STATE_FUNCTION);

/** Only the client method the nudge needs — trivially fakeable in tests. */
export type AppUnlockConvexClient = Pick<ConvexReactClient, "mutation">;

/** Only the client method the install read needs. */
export type AppInstallConvexClient = Pick<ConvexReactClient, "query">;

/**
 * How long a tap waits for the install read before giving up on it. The read
 * only ever REFUSES a launch, so a slow network must cost the scholar nothing
 * beyond this: on timeout the tile hands off exactly as it did before.
 */
export const INSTALL_STATE_TIMEOUT_MS = 2_500;

/**
 * Is this scheme-less managed app installed on this iPad, as SimpleMDM last
 * saw it? Any failure (no claim, an old backend, a timeout) is "unknown", and
 * "unknown" keeps today's Home Screen handoff, so this can only ever stop a
 * scholar from being sent to look for an icon that isn't there.
 */
export async function readManagedAppInstallState(
  client: AppInstallConvexClient,
  deviceId: string,
  externalAppId: string,
  timeoutMs: number = INSTALL_STATE_TIMEOUT_MS,
): Promise<ManagedAppInstallState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ManagedAppInstallState>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), timeoutMs);
    });
    const result = await Promise.race([
      client.query(installStateRef, { deviceId, externalAppId }),
      timeout,
    ]);
    return result === "installed" || result === "missing" ? result : "unknown";
  } catch {
    return "unknown";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ask the backend to converge this iPad's managed-app allowlist NOW, because a
 * scholar just tapped a tile whose app iOS says is not open-able yet.
 *
 * Additive and latency-only: it decides nothing, grants nothing, and the
 * reconciler's cron converges the device regardless. An iPad the projection
 * does not cover answers `{ nudged: false }` rather than throwing, and a
 * genuine transport failure is swallowed — neither is worth failing a launch
 * the device's own `canOpenURL` is the real gate on.
 *
 * Returns whether the backend accepted the nudge, for tests and logging only;
 * the launch never branches on it.
 */
export async function nudgeDeviceAppProjection(
  client: AppUnlockConvexClient,
  deviceId: string,
): Promise<boolean> {
  try {
    const result = await client.mutation(nudgeProjectionRef, { deviceId });
    return result.nudged;
  } catch (error) {
    warnIfFunctionMissing(error);
    return false;
  }
}

/**
 * The failure above is swallowed because an unconvergeable iPad is an ordinary
 * outcome — but that also means a RENAMED backend function would fail silently
 * forever, quietly costing every cold launch the reconciler's full cron
 * interval instead of a round trip. Convex names that specific case, so surface
 * it loudly in development only.
 */
function warnIfFunctionMissing(error: unknown): void {
  if (typeof __DEV__ === "undefined" || !__DEV__) return;
  const message = error instanceof Error ? error.message : String(error);
  if (!/could not find public function/i.test(message)) return;
  console.warn(
    `[appUnlock] ${NUDGE_FUNCTION} is missing from the backend. ` +
      "Cold launches now wait for the reconciler's own cron — update " +
      "NUDGE_FUNCTION in native/src/lib/appUnlockClient.ts to the backend's " +
      "current name.",
  );
}
