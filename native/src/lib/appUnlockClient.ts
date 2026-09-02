// Typed CLIENT ADAPTER for the per-device app-unlock backend surface
// (`convex/deviceAppUnlock.ts`).
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
// It is also the ONE place a backend rename has to be reconciled: everything
// else in the native app talks only to `AppUnlockGateway`.
//
// Backend contract this binds to (convex/deviceAppUnlock.ts):
//   deviceAppUnlock:status        authedQuery    {deviceId, externalAppId, nowMs}
//   deviceAppUnlock:requestUnlock action         {deviceId, externalAppId}
//   deviceAppUnlock:markReturned  authedMutation {deviceId}
// The first two resolve to the status shape in appUnlockPolicy.ts.
// `requestUnlock` is an ACTION (it PATCHes SimpleMDM), so it is called with
// `client.action`, and it is idempotent: with a live lease for the same app it
// extends the lease and returns the current status without a second PATCH.

import { makeFunctionReference } from "convex/server";
import type { ConvexReactClient } from "convex/react";
import type { Id } from "@/lib/convex";
import type {
  AppUnlockGateway,
  AppUnlockTargetRef,
} from "@/lib/asam/appUnlockGate";
import type { AppUnlockStatus } from "@/lib/asam/appUnlockPolicy";

/** The target as the backend names it. */
export type ExternalAppUnlockTarget = AppUnlockTargetRef<Id<"externalApps">>;

type StatusArgs = {
  deviceId: string;
  externalAppId: Id<"externalApps">;
  /**
   * The client's clock. The backend compares it with its own and REJECTS a
   * wildly skewed reading rather than trusting it, so this must be a real
   * `Date.now()` from the same tick the request is made.
   */
  nowMs: number;
};

type RequestArgs = {
  deviceId: string;
  externalAppId: Id<"externalApps">;
  leaseToken: string;
};

const statusRef = makeFunctionReference<"query", StatusArgs, AppUnlockStatus>(
  "deviceAppUnlock:status",
);

/** An action, not a mutation: it performs the SimpleMDM profile PATCH. */
const requestUnlockRef = makeFunctionReference<
  "action",
  RequestArgs,
  AppUnlockStatus & { idempotent: boolean }
>("deviceAppUnlock:requestUnlock");

/**
 * ── THE SINGLE RENAME POINT ────────────────────────────────────────────────
 * The backend's return/idle signal. It is `markReturned` today; `markIdle` has
 * been floated. Changing this one string is the entire client-side cost of a
 * rename — nothing else in the native app names a backend function.
 */
const RETURN_SIGNAL_FUNCTION = "deviceAppUnlock:markReturned";

/**
 * Told when Rabbithole comes back to the foreground after a handoff. It does
 * NOT touch MDM: the app stays available so the next tap is instant, but the
 * server-side clock switches from the long active-session failsafe to the
 * one-hour idle lease, after which the backend's own reconcile cron relocks.
 */
const markReturnedRef = makeFunctionReference<
  "mutation",
  { deviceId: string; leaseToken: string },
  { marked: boolean; expiresAt: number | null }
>(RETURN_SIGNAL_FUNCTION);

/** Only the client methods the gateway needs — trivially fakeable in tests. */
export type AppUnlockConvexClient = Pick<
  ConvexReactClient,
  "query" | "action" | "mutation"
>;

function toStatusArgs(target: ExternalAppUnlockTarget): Omit<StatusArgs, "nowMs"> {
  return { deviceId: target.deviceId, externalAppId: target.externalAppId };
}

/** Bind the gateway to a live Convex client. */
export function convexAppUnlockGateway(
  client: AppUnlockConvexClient,
): AppUnlockGateway<Id<"externalApps">> {
  return {
    readStatus: (target, nowMs) =>
      client.query(statusRef, { ...toStatusArgs(target), nowMs }),
    requestUnlock: async (target) => {
      const status = await client.action(requestUnlockRef, target);
      return status;
    },
  };
}

/**
 * Report that the scholar is back in Rabbithole, starting the idle lease.
 *
 * Deliberately fire-and-forget and deliberately OUTSIDE `AppUnlockGateway`: the
 * gate must have no way to change device state, and the return path must never
 * make a scholar wait on a round trip. A stale lease token is an ordinary
 * outcome here, so the backend returns `marked: false` and the client does not
 * surface anything.
 */
export async function reportReturnedToRabbithole(
  client: Pick<AppUnlockConvexClient, "mutation">,
  target: Pick<ExternalAppUnlockTarget, "deviceId" | "leaseToken">,
): Promise<boolean> {
  try {
    const result = await client.mutation(markReturnedRef, {
      deviceId: target.deviceId,
      leaseToken: target.leaseToken,
    });
    return result.marked;
  } catch (error) {
    warnIfFunctionMissing(error);
    return false;
  }
}

/**
 * The failure above is swallowed because "no active session to return from" is
 * an ordinary outcome — but that also means a RENAMED backend function would
 * fail silently forever, quietly disabling the one-hour idle lease and leaving
 * an app unlocked for the full active-session failsafe instead. Convex names
 * that specific case, so surface it loudly in development only.
 */
function warnIfFunctionMissing(error: unknown): void {
  if (typeof __DEV__ === "undefined" || !__DEV__) return;
  const message = error instanceof Error ? error.message : String(error);
  if (!/could not find public function/i.test(message)) return;
  console.warn(
    `[appUnlock] ${RETURN_SIGNAL_FUNCTION} is missing from the backend. ` +
      "The idle lease is not starting — update RETURN_SIGNAL_FUNCTION in " +
      "native/src/lib/appUnlockClient.ts to the backend's current name.",
  );
}
