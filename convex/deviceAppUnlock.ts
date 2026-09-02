/**
 * Per-device app access for managed scholar iPads.
 *
 * A binding names one pre-created, dedicated SimpleMDM custom profile and its
 * complete locked baseline. Requests only select a server-owned app key; they
 * can never supply a bundle id, profile document, serial, group, or device id
 * outside the caller's current claimed installation.
 *
 * ── TWO MODELS, ONE PROFILE (app-access unification, lane C) ──────────────
 *
 * This file now holds both halves of a deliberate transition:
 *
 *   • the LEASE ceremony — `status` / `requestUnlock` / `requestLock` /
 *     `markReturned` and the relock gate. The shipped iPad build drives it on
 *     every managed-app launch, so it keeps working UNCHANGED until its
 *     retirement lane ships a new build. Nothing about its contract moves
 *     here.
 *   • the GRANT PROJECTION — `projectionCandidates` /
 *     `prepareProjectionPatch` / `recordProjectionPatch`, converged by the
 *     same reconciler cron. A bound device's allowlist becomes an
 *     eventually-consistent projection of what its scholar is granted-or-
 *     pushed, so a granted tile opens with no launch-time ceremony at all.
 *
 * They share ONE dedicated profile, so they must never want different things
 * from it. They don't: both compute the same target set through
 * `projectedBundleIdsForClaim` (lib/deviceAppProjection.ts), where the live
 * lease is a guaranteed superset member and "relock" means "converge to the
 * projection" rather than "return to bare baseline". Mutual exclusion is the
 * pre-existing per-row `operationToken`, acquired immediately before each
 * PATCH and never reserved across a batch.
 *
 * The profile-safety core is untouched: `verifyDedicatedProfileScope`,
 * `assertLiveTemplate`, `validateBaseline`, the durable-before-network
 * ordering, the batch caps and the self-drain all behave exactly as before.
 * The one generalization the set model required is that a PATCH may now carry
 * "baseline ∪ any subset of the managed bundles" rather than "baseline + at
 * most one" — see `patchProfile` and `assertLiveTemplate`.
 *
 * See review/app-access-unification-plan.html.
 */
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { requireUser, assertNotImpersonating } from "./lib/auth";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import { hasSchoolOperationsAccessAtInstitution } from "./lib/staffCapabilities";
import { ROLES } from "./lib/roles";
import { launcherShowsApp, scholarHasGrantForApp } from "./lib/appAudiences";
import {
  MANAGED_NATIVE_APPS,
  managedNativeAppKeyForScheme,
  type ManagedNativeAppKey,
} from "./lib/managedNativeApps";
import {
  freshDeviceOwner,
  grantedManagedAppKeysForScholar,
  resolveProjectionTrust,
  uncertainProjectionWrite,
  livePushShowsAppToScholar,
  projectedBundleIdsForClaim,
  projectionHasDrifted,
  pushedManagedAppKeysForScholar,
} from "./lib/deviceAppProjection";

export {
  scheduleClaimDecommissionLock,
  scheduleClaimDecommissionLocksForScholar,
  scheduleUnlockRevocationCheck,
  scheduleUnlockRevocationCheckForKey,
  schedulePushProjectionRefresh,
  type RevocationSchedulerCtx,
} from "./lib/deviceAppUnlockScheduling";

const SIMPLEMDM_API_BASE = "https://a.simplemdm.com/api/v1";
const IDLE_LEASE_DURATION_MS = 60 * 60 * 1_000;
// An active native-app session cannot report a heartbeat, so it gets a longer
// hard cap. Returning to Rabbithole switches back to the one-hour idle lease.
const ACTIVE_SESSION_FAILSAFE_MS = 8 * 60 * 60 * 1_000;
const EXPECTED_MDM_PROPAGATION_MS = 15 * 1_000;
const MDM_FETCH_TIMEOUT_MS = 12 * 1_000;
// Keep the operation lease beyond the bounded request deadline. This prevents
// a transport that times out locally from being immediately overtaken by a
// second whole-profile PATCH; a stale completion also cannot update database
// state because `recordMdmPatch` requires this token.
const OPERATION_TIMEOUT_MS = 120 * 1_000;
const LOCK_RETRY_DELAY_MS = 5 * 60 * 1_000;
const STATUS_CLOCK_SKEW_MS = 5 * 60 * 1_000;
// The bounded per-tick scan size for the active-unlock reconciler's due-row
// query — a cheap read/gate-check per row, not a network call, so this can
// comfortably be larger than the network-operation cap below.
const MAX_RECONCILE_BATCH = 25;
// The one authoritative correctness mechanism (see prepareReconcileLock /
// reconcileActiveUnlocks below): every currently-unlocked device is
// periodically re-derived from scratch — claim/owner-generation, scholar,
// catalog mapping, audience/archive/scheme conditions, and expiry — rather
// than trusted from whatever verdict was true when it was unlocked. This is
// also the cadence a fresh unlock's `nextRecheckAt` is stamped at, and what a
// still-authorized row is pushed forward by after each recheck. Matches the
// cron interval in convex/crons.ts, so a row that no hook ever nudged is
// still corrected within one tick.
const RECHECK_INTERVAL_MS = 5 * 60 * 1_000;
// A revoke/decommission that races an in-flight unlock/lock operation cannot
// safely act on it (recordMdmPatch requires the operation's own token).
// Rather than treat that as "nothing to do," the gate advances the row's
// nextRecheckAt to once the operation's own timeout window has definitely
// closed — long enough that either it finished (and, if it was an unlock,
// authorization gets re-verified before the device is trusted to stay open)
// or it's genuinely stuck (in which case the pendingLocks backstop below
// also applies).
const RECHECK_AFTER_INFLIGHT_MS = OPERATION_TIMEOUT_MS + 5_000;
// The active-unlock reconciler makes a real SimpleMDM network call per
// device it decides to relock — bound how many of THOSE per invocation
// (distinct from MAX_RECONCILE_BATCH, which only bounds how many rows are
// gate-checked, a cheap DB-only operation). Small on purpose: patchProfile
// can make up to 2 PATCH attempts per claim (a 429 retries once, each
// attempt bounded by MDM_FETCH_TIMEOUT_MS, plus the retry-after delay) on
// top of its 2 read-only verify/download fetches — so this cap bounds
// actual MDM attempts/time per invocation, not just a row count that could
// each independently balloon under sustained rate-limiting. Any row the
// gate already locked but this budget didn't reach patching is safe to defer
// — the gate's own lockedStatePatch already ran BEFORE any network call
// (durable-before-network), so it is picked up by the pendingLocks sweep
// (same invocation's second phase, or the very next one) with no bespoke
// continuation bookkeeping required.
const MAX_REVOCATION_BATCH = 6;
// How often a bound device's allowlist projection is re-derived from scratch
// when nothing nudged it. Same cadence and same reasoning as
// RECHECK_INTERVAL_MS: the cron is the correctness authority, so this is the
// worst-case time for a grant change no hook reached to reach the device.
const PROJECTION_INTERVAL_MS = 5 * 60 * 1_000;
// The bounded per-tick DB-only scan of BOUND devices whose projection is due.
// Mirrors MAX_RECONCILE_BATCH: a cheap read + diff per device, no network.
const MAX_PROJECTION_BATCH = 25;
// Hard ceiling on how many dedicated-profile bindings a single projection
// scan will enumerate. `deviceAppUnlockBindings` holds exactly one row per
// physically provisioned school iPad — a fleet is tens of devices, bounded by
// hardware rather than by user activity — so enumerating it is the honest
// way to find bound devices that have no state row yet (an index over the
// state table can only ever see devices that already have one). Candidates
// are then ordered MOST-DUE-FIRST and capped at MAX_PROJECTION_BATCH, so
// every device makes progress across ticks even if a fleet ever exceeds the
// per-tick cap. If a deployment genuinely passes this ceiling, this scan
// needs a durable cursor rather than a bigger number.
const MAX_BINDINGS_ENUMERATED = 512;
// When a whole projection page is waiting on other writers' operation tokens,
// the self-continuation waits this long at most before looking again. Long
// enough that a token-held page cannot spin, short enough that convergence
// still follows a token's release closely.
const PROJECTION_STALL_BACKOFF_MAX_MS = 30 * 1_000;
const PROJECTION_STALL_BACKOFF_MIN_MS = 1_000;
// How long a `projectionVerifiedAt` stamp keeps the stored `appliedBundleIds`
// usable as a drift baseline. Past it, the next projection pass re-reads the
// LIVE profile before deciding there is nothing to do — so console-side edits,
// a stale write that landed late, and any other divergence the stored hint
// cannot see are bounded by this rather than living forever. Deliberately a
// multiple of the projection interval: a verify costs FOUR read-only SimpleMDM
// GETs (device inventory, profile inventory, this device's installed profiles,
// then the profile download — see `verifyDedicatedProfileScope` +
// `downloadProfileTemplate`), and the write path performs them anyway every
// time it runs, so this interval only prices the case where nothing changed.
//
// Accepted tradeoff: a console-side edit that nothing else disturbs can stand
// for up to this long. Every edge Rabbithole itself can see — a grant, a push,
// a rebind, an uncertain write — invalidates trust immediately and does not
// wait for it.
const PROJECTION_VERIFY_INTERVAL_MS = 60 * 60 * 1_000;

type AppKey = ManagedNativeAppKey;
type DesiredState = "locked" | "unlocked";
type AppUnlockStatus = {
  desiredState: "locked" | "unlocked";
  // The MDM control-plane state, not a device-observed launch result. In
  // particular, `expected-from-mdm-acceptance` means SimpleMDM accepted the
  // profile PATCH and the propagation estimate elapsed; it never proves iOS
  // accepted a URL-scheme launch.
  availability:
    | "locked"
    | "expired-awaiting-reconcile"
    | "mdm-error"
    | "mdm-patch-in-flight"
    | "awaiting-mdm-acceptance"
    | "expected-from-mdm-acceptance"
    | "mdm-accepted-propagating"
    // This iPad's launches are not mediated by the unlock system AT ALL — see
    // NOT_CONFIGURED_STATUS. Not a state of an unlock; the absence of one.
    | "not-configured";
  expiresAt: number | null;
  mdmAcceptedAt: number | null;
  expectedAvailableAt: number | null;
};

/**
 * The typed "this iPad has no dedicated profile" reading.
 *
 * WHY THIS IS FAIL-OPEN, AND WHY THAT IS THE SAFE DIRECTION. Dynamic unlocking
 * only exists for iPads whose allowlist is driven by a per-device dedicated
 * profile (`deviceAppUnlockBindings`). Every other managed iPad in the fleet
 * carries the GROUP MDM profile, which allowlists Sheets and LEGO SPIKE
 * permanently — those launches were never restricted, so there is nothing to
 * unlock and the plain `openURL` handoff simply works. Reporting that as an
 * ERROR is what shipped the prod defect: a scholar tapped a granted LEGO SPIKE
 * tile and got "This iPad couldn't unlock LEGO SPIKE" for a launch that would
 * have succeeded untouched.
 *
 * Fail-open grants NOTHING. It skips ASKING for an unlock; it never performs
 * one. MDM remains the sole authority on what this iPad may open, so a device
 * that genuinely IS restricted and somehow lost its binding still cannot launch
 * the app — it gets the ordinary "couldn't open" alert instead of a misleading
 * unlock failure.
 *
 * `desiredState` is "locked" because there is no lease, not because anything is
 * locked. Clients key on `availability` FIRST (see `decideUnlockEntry` in
 * native/src/lib/asam/appUnlockPolicy.ts) and must never read lease semantics
 * off this reading.
 */
const NOT_CONFIGURED_STATUS: AppUnlockStatus = {
  desiredState: "locked",
  availability: "not-configured",
  expiresAt: null,
  mdmAcceptedAt: null,
  expectedAvailableAt: null,
};

const SUPPORTED_APPS = MANAGED_NATIVE_APPS;

// These are the only Rabbithole identities a dedicated profile may name. The
// profile's exact baseline still comes from the operator; this only ensures a
// future binding cannot strand its iPad away from Rabbithole or Wi-Fi recovery.
let RABBITHOLE_BUNDLE_IDS = new Set([
  "org.rabbithole.app",
  "org.rabbithole.app.dev",
  "org.rabbithole.app.metro",
]);
const SETTINGS_BUNDLE_ID = "com.apple.Preferences";
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const SIMPLEMDM_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

type DbCtx = QueryCtx | MutationCtx;

function apiKey(): string {
  const key = process.env.SIMPLEMDM_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "SimpleMDM API key not configured — set SIMPLEMDM_API_KEY in the Convex deployment",
    );
  }
  return key;
}

function authorizationHeader(key: string): string {
  return `Basic ${btoa(`${key}:`)}`;
}

function profileXml(template: string, bundleIds: string[]): string {
  const strings = bundleIds.map((bundleId) => `        <string>${bundleId}</string>`).join("\n");
  const matches = [...template.matchAll(
    /(<key>allowListedAppBundleIDs<\/key>\s*<array>)([\s\S]*?)(<\/array>)/g,
  )];
  if (matches.length !== 1 || matches[0].index === undefined) {
    throw new Error("The stored dedicated profile template is invalid.");
  }
  const match = matches[0];
  return template.slice(0, match.index) +
    match[1] + `\n${strings}\n      ` + match[3] +
    template.slice(match.index + match[0].length);
}

/** Validate a requested allowlist against this binding's safety envelope. */
function assertRequestedAllowlist(
  binding: Doc<"deviceAppUnlockBindings">,
  bundleIds: string[],
): void {
  const baseline = validateBaseline(binding.baselineBundleIds);
  const managed = Object.values(SUPPORTED_APPS).map(({ bundleId }) => bundleId);
  const permitted = new Set([...baseline, ...managed]);
  // The ONE generalization the projection needs from this safety core:
  // "baseline + at most one leased app" becomes "baseline ∪ any subset of the
  // server-owned managed bundles". A projected allowlist can legitimately hold
  // several at once (a scholar granted both Sheets and SPIKE), which the lease
  // model could never express. `validateBaseline` guarantees the baseline
  // contains no managed bundle, so the arithmetic cap stays exact. Every other
  // clause below — no duplicates, nothing outside the permitted set, and the
  // whole baseline always present — is unchanged and still the thing that
  // makes a projection writer safe.
  if (
    bundleIds.length < baseline.length ||
    bundleIds.length > baseline.length + managed.length ||
    new Set(bundleIds).size !== bundleIds.length ||
    bundleIds.some((bundleId) => !permitted.has(bundleId)) ||
    baseline.some((bundleId) => !bundleIds.includes(bundleId))
  ) {
    throw new Error("The stored dedicated profile binding is invalid.");
  }
}

/**
 * Read the device's REAL current allowlist, through the full safety core.
 *
 * This is the sequence every write already performed — prove the profile is
 * still dedicated to this one serial, download it, prove nothing outside its
 * allowlist changed — extracted verbatim so the projector can also use it as a
 * READ. That read is what makes the live profile the drift authority rather
 * than the stored `appliedBundleIds` hint (see the schema comment on
 * `projectionVerifiedAt`).
 */
async function readLiveProfile(
  key: string,
  binding: Doc<"deviceAppUnlockBindings">,
): Promise<{ template: string; bundleIds: string[] }> {
  await verifyDedicatedProfileScope(key, binding);
  const template = await downloadProfileTemplate(key, binding.simpleMdmProfileId);
  assertLiveTemplate(binding, template);
  return { template, bundleIds: allowlistOf(template) };
}

/**
 * Converge the device's allowlist to `bundleIds`, and report what the profile
 * ACTUALLY held first.
 *
 * The projector calls this instead of `patchProfile` so a "no drift" decision
 * is always backed by a live read rather than by the stored hint: if the live
 * allowlist already equals the target, no PATCH is spent and the hint is
 * re-verified; if it does not — including because a stale write landed late
 * and resurrected a revoked app — the difference is corrected on the spot.
 */
async function verifyAndApplyProfile(
  key: string,
  binding: Doc<"deviceAppUnlockBindings">,
  bundleIds: string[],
): Promise<{ patched: boolean; liveBundleIds: string[] }> {
  assertRequestedAllowlist(binding, bundleIds);
  const live = await readLiveProfile(key, binding);
  const target = [...bundleIds].sort();
  const current = [...live.bundleIds].sort();
  if (
    current.length === target.length &&
    current.every((bundleId, i) => bundleId === target[i])
  ) {
    return { patched: false, liveBundleIds: current };
  }
  await patchLiveProfile(key, binding, live.template, bundleIds);
  return { patched: true, liveBundleIds: target };
}

async function patchProfile(
  key: string,
  binding: Doc<"deviceAppUnlockBindings">,
  bundleIds: string[],
): Promise<void> {
  assertRequestedAllowlist(binding, bundleIds);
  const live = await readLiveProfile(key, binding);
  await patchLiveProfile(key, binding, live.template, bundleIds);
}

async function patchLiveProfile(
  key: string,
  binding: Doc<"deviceAppUnlockBindings">,
  liveTemplate: string,
  bundleIds: string[],
): Promise<void> {
  const update = async (): Promise<Response> => {
    const form = new FormData();
    form.append(
      "mobileconfig",
      new Blob([profileXml(liveTemplate, bundleIds)], {
        type: "application/x-apple-aspen-config",
      }),
      "rabbithole-temporary-app-access.mobileconfig",
    );
    try {
      return await simpleMdmFetch(
        `${SIMPLEMDM_API_BASE}/custom_configuration_profiles/${encodeURIComponent(
          binding.simpleMdmProfileId,
        )}`,
        {
          method: "PATCH",
          headers: { Authorization: authorizationHeader(key) },
          body: form,
        },
      );
    } catch {
      throw new Error("Could not reach SimpleMDM to update the app-access profile.");
    }
  };

  let response = await update();
  // SimpleMDM rate limits are transient. Retry once, bounded by its explicit
  // advice, only for this idempotent whole-profile PATCH.
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter)
      ? Math.min(Math.max(retryAfter, 0), 5) * 1_000
      : 1_000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await update();
  }
  if (!response.ok) {
    throw new Error(
      `SimpleMDM returned HTTP ${response.status} while updating the app-access profile.`,
    );
  }
}

async function simpleMdmFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MDM_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new Error("Could not reach SimpleMDM.");
  } finally {
    clearTimeout(timeout);
  }
}

async function simpleMdmJson(key: string, path: string): Promise<unknown> {
  const response = await simpleMdmFetch(`${SIMPLEMDM_API_BASE}/${path}`, {
    headers: { Authorization: authorizationHeader(key), Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not verify the dedicated app-access profile.");
  try {
    return await response.json();
  } catch {
    throw new Error("SimpleMDM returned an unreadable inventory response.");
  }
}

function records(payload: unknown): Record<string, unknown>[] {
  const data = (payload as { data?: unknown })?.data;
  return Array.isArray(data) ? data.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
  ) : [];
}

function hasMore(payload: unknown): boolean {
  const result = payload as {
    meta?: { has_more?: unknown; next_page?: unknown; next?: unknown };
    links?: { next?: unknown };
  };
  return result?.meta?.has_more === true ||
    result?.meta?.next_page != null ||
    result?.meta?.next != null ||
    result?.links?.next != null;
}

function deviceSerial(device: Record<string, unknown>): string | null {
  const attributes = device.attributes as Record<string, unknown> | undefined;
  const value = attributes?.serial_number ?? attributes?.serial ?? device.serial_number;
  return typeof value === "string" ? value : null;
}

function simpleMdmId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Every write re-proves the stored custom profile is directly scoped to this
 * one claimed serial. Inventory pagination/shape ambiguity fails closed.
 */
async function verifyDedicatedProfileScope(
  key: string,
  binding: Pick<Doc<"deviceAppUnlockBindings">, "simpleMdmProfileId" | "serial">,
): Promise<void> {
  const devicesPayload = await simpleMdmJson(key, "devices?limit=100");
  if (hasMore(devicesPayload)) throw new Error("SimpleMDM device inventory is paginated; refusing profile update.");
  const matches = records(devicesPayload).filter((device) => deviceSerial(device) === binding.serial);
  const deviceId = matches.length === 1 ? simpleMdmId(matches[0].id) : null;
  if (!deviceId) {
    throw new Error("Could not resolve this claimed iPad in SimpleMDM.");
  }
  const profilesPayload = await simpleMdmJson(key, "profiles?limit=100");
  if (hasMore(profilesPayload)) throw new Error("SimpleMDM profile inventory is paginated; refusing profile update.");
  const profiles = records(profilesPayload).filter(
    (profile) => simpleMdmId(profile.id) === binding.simpleMdmProfileId,
  );
  if (profiles.length !== 1) {
    throw new Error("Could not verify the dedicated app-access profile.");
  }
  const attributes = profiles[0].attributes as Record<string, unknown> | undefined;
  if (
    attributes?.group_count !== 0 ||
    attributes?.device_count !== 1
  ) {
    throw new Error("The app-access profile is not dedicated to this iPad.");
  }
  const installedPayload = await simpleMdmJson(
    key,
    `devices/${encodeURIComponent(deviceId)}/profiles?limit=100`,
  );
  if (hasMore(installedPayload)) {
    throw new Error("SimpleMDM profile inventory is paginated; refusing profile update.");
  }
  if (!records(installedPayload).some(
    (profileRow) => simpleMdmId(profileRow.id) === binding.simpleMdmProfileId,
  )) {
    throw new Error("The dedicated app-access profile is not installed on this iPad.");
  }
}

async function downloadProfileTemplate(key: string, profileId: string): Promise<string> {
  const response = await simpleMdmFetch(
    `${SIMPLEMDM_API_BASE}/custom_configuration_profiles/${encodeURIComponent(profileId)}/download`,
    { headers: { Authorization: authorizationHeader(key) } },
  );
  if (!response.ok) throw new Error("Could not download the dedicated app-access profile.");
  const responseBody = await response.text();
  let body = responseBody;
  if (!body.includes("<plist")) {
    try {
      const parsed = JSON.parse(responseBody) as { body?: unknown };
      if (typeof parsed.body === "string") body = parsed.body;
    } catch {
      // The raw mobileconfig form is the expected response.
    }
  }
  if (!body.includes("<plist") || !body.includes("</plist>")) {
    throw new Error("SimpleMDM returned an unreadable dedicated app-access profile.");
  }
  return body;
}

function assertTemplateBaseline(profile: string, expectedBaseline: string[]): void {
  const matches = [...profile.matchAll(
    /<key>allowListedAppBundleIDs<\/key>\s*<array>([\s\S]*?)<\/array>/g,
  )];
  if (matches.length !== 1) {
    throw new Error("The dedicated profile must contain exactly one app allowlist.");
  }
  const actual = [...matches[0][1].matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  const baseline = validateBaseline(expectedBaseline);
  if (
    actual.length !== baseline.length ||
    new Set(actual).size !== actual.length ||
    actual.some((id) => !baseline.includes(id))
  ) {
    throw new Error("The supplied baseline does not exactly match the dedicated profile.");
  }
}

function parseDedicatedProfileTemplate(profile: string): {
  baselineBundleIds: string[];
  profilePayloadIdentifier: string;
  profilePayloadUuid: string;
  profileUuid: string;
} {
  const allowlists = [...profile.matchAll(
    /<key>allowListedAppBundleIDs<\/key>\s*<array>([\s\S]*?)<\/array>/g,
  )];
  const identifiers = [...profile.matchAll(
    /<key>PayloadIdentifier<\/key>\s*<string>([^<]+)<\/string>/g,
  )].map((match) => match[1]);
  const uuids = [...profile.matchAll(
    /<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g,
  )].map((match) => match[1]);
  if (allowlists.length !== 1 || identifiers.length !== 2 || uuids.length !== 2) {
    throw new Error("The dedicated profile has an ambiguous payload identity.");
  }
  const baselineBundleIds = [...allowlists[0][1].matchAll(/<string>([^<]*)<\/string>/g)]
    .map((match) => match[1]);
  validateBaseline(baselineBundleIds);
  return {
    baselineBundleIds,
    // The application-access payload is first in a standard mobileconfig;
    // the root Configuration payload follows it.
    profilePayloadIdentifier: identifiers[1],
    profilePayloadUuid: uuids[0],
    profileUuid: uuids[1],
  };
}

function normalizedTemplateShell(profile: string): string {
  const matches = [...profile.matchAll(
    /(<key>allowListedAppBundleIDs<\/key>\s*<array>)([\s\S]*?)(<\/array>)/g,
  )];
  if (matches.length !== 1 || matches[0].index === undefined) {
    throw new Error("The dedicated profile must contain exactly one app allowlist.");
  }
  return (profile.slice(0, matches[0].index) + matches[0][1] + "<APP_LIST>" +
    matches[0][3] + profile.slice(matches[0].index + matches[0][0].length))
    .replace(/\s+/g, "");
}

/** The bundle ids in a profile's single app allowlist, in document order. */
function allowlistOf(profile: string): string[] {
  const matches = [...profile.matchAll(
    /<key>allowListedAppBundleIDs<\/key>\s*<array>([\s\S]*?)<\/array>/g,
  )];
  if (matches.length !== 1) {
    throw new Error("The dedicated profile must contain exactly one app allowlist.");
  }
  return [...matches[0][1].matchAll(/<string>([^<]*)<\/string>/g)].map((entry) => entry[1]);
}

function assertLiveTemplate(
  binding: Doc<"deviceAppUnlockBindings">,
  liveTemplate: string,
): void {
  if (normalizedTemplateShell(liveTemplate) !== normalizedTemplateShell(binding.baselineProfileXml)) {
    throw new Error("The dedicated profile changed outside its app allowlist.");
  }
  const current = allowlistOf(liveTemplate);
  const baseline = validateBaseline(binding.baselineBundleIds);
  const temporary = Object.values(SUPPORTED_APPS).map((app) => app.bundleId);
  // The live profile must still be "baseline ∪ some subset of the managed
  // bundles" — no duplicates, nothing unknown, and never missing a baseline
  // entry. The lease model additionally required at most ONE managed bundle;
  // that clause is dropped because a projected allowlist legitimately holds
  // every managed app its scholar is granted (see patchProfile). Nothing else
  // relaxes: an operator edit that adds an unrelated bundle, drops a baseline
  // app, or duplicates an entry still fails closed before any PATCH.
  if (
    new Set(current).size !== current.length ||
    baseline.some((bundleId) => !current.includes(bundleId)) ||
    current.some((bundleId) => !baseline.includes(bundleId) && !temporary.includes(bundleId))
  ) {
    throw new Error("The dedicated profile allowlist has an unsafe unexpected change.");
  }
}

function validateBaseline(bundleIds: string[]): string[] {
  const normalized = [...new Set(bundleIds.map((id) => id.trim()))];
  if (
    normalized.length === 0 ||
    normalized.length !== bundleIds.length ||
    normalized.some((id) => !BUNDLE_ID_PATTERN.test(id))
  ) {
    throw new Error("The dedicated profile baseline must contain unique valid bundle IDs.");
  }
  if (!normalized.includes(SETTINGS_BUNDLE_ID)) {
    throw new Error("The dedicated profile baseline must include Settings for Wi-Fi recovery.");
  }
  if (!normalized.some((id) => RABBITHOLE_BUNDLE_IDS.has(id))) {
    throw new Error("The dedicated profile baseline must include a Rabbithole app identity.");
  }
  if (Object.values(SUPPORTED_APPS).some(({ bundleId }) => normalized.includes(bundleId))) {
    throw new Error("The dedicated profile baseline must keep temporary apps blocked.");
  }
  return normalized;
}

/**
 * Resolve the caller's claim on this device, and the dedicated-profile binding
 * that makes its launches unlock-mediated.
 *
 * The split matters. Everything up to the binding lookup is an IDENTITY /
 * AUTHORIZATION question — is this really your currently claimed managed iPad —
 * and every failure of it still THROWS, because the honest answer is "I cannot
 * prove this device is yours", never "your device is unconfigured". That keeps
 * the cross-institution isolation boundary exactly where it was.
 *
 * The binding is a CONFIGURATION question, asked only once identity is proven:
 * this really is the caller's claimed iPad, and an operator simply never gave it
 * a dedicated profile. That case is returned as `binding: null` so read paths can
 * report it as the typed `not-configured` status instead of an error — see
 * NOT_CONFIGURED_STATUS for why fail-open is the safe direction there.
 */
async function resolveClaimedDevice(
  ctx: DbCtx,
  user: Doc<"users">,
  deviceId: string,
): Promise<{
  claim: Doc<"managedDeviceClaims">;
  binding: Doc<"deviceAppUnlockBindings"> | null;
}> {
  if (user.role !== ROLES.SCHOLAR || !user.institutionId) {
    throw new Error("Temporary app access is available only from a signed-in scholar iPad.");
  }
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId || normalizedDeviceId.length > 200) {
    throw new Error("This iPad's device identity is unavailable. Reopen Rabbithole and try again.");
  }
  const paired = await ctx.db
    .query("pairedDevices")
    .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
    .collect();
  const pairedDevice = paired.find(
    (row) =>
      row.deviceId === normalizedDeviceId &&
      row.institutionId === user.institutionId &&
      row.managedDeviceClaimId,
  );
  if (!pairedDevice?.managedDeviceClaimId) {
    throw new Error("This iPad is not the currently claimed managed device for this account.");
  }
  const claim = await ctx.db.get(pairedDevice.managedDeviceClaimId);
  if (
    !claim ||
    claim.institutionId !== user.institutionId ||
    claim.scholarId !== user._id ||
    claim.claimState !== "claimed" ||
    claim.lastDeviceId !== normalizedDeviceId
  ) {
    throw new Error("This iPad's managed claim is no longer current. Reopen Rabbithole and try again.");
  }
  const binding = await ctx.db
    .query("deviceAppUnlockBindings")
    .withIndex("by_managed_device", (q) =>
      q.eq("managedDeviceClaimId", claim._id),
    )
    .unique();
  if (
    !binding ||
    binding.institutionId !== user.institutionId ||
    binding.serial !== claim.serial
  ) {
    // A binding belonging to another institution or a stale serial is treated
    // the same as none: this claim has no dedicated profile the unlock system
    // may act through, and it must never act through somebody else's.
    return { claim, binding: null };
  }
  // Bindings are written through configureDedicatedProfile, but validate again
  // before building XML so a malformed legacy/manual row can never widen a
  // device's allowlist.
  validateBaseline(binding.baselineBundleIds);
  return { claim, binding };
}

/**
 * The WRITE-path wrapper: every caller that is about to move MDM state needs a
 * real binding, so an unconfigured device is a legible error here rather than a
 * soft signal. There is no unlock to fail open TO on a write — the plain launch
 * is the client's job, and it takes that path off the `status` reading above
 * without ever calling in here.
 */
async function requireClaimedDevice(
  ctx: DbCtx,
  user: Doc<"users">,
  deviceId: string,
): Promise<{
  claim: Doc<"managedDeviceClaims">;
  binding: Doc<"deviceAppUnlockBindings">;
}> {
  const { claim, binding } = await resolveClaimedDevice(ctx, user, deviceId);
  if (!binding) {
    throw new Error(
      "Temporary app access is not configured for this iPad. Ask a teacher to configure its dedicated profile.",
    );
  }
  return { claim, binding };
}

/**
 * The launch gate. Its invariant is NOT "a grant covers this app" — it is
 * "some scholar-visible surface legitimately shows this app to this scholar
 * right now."
 *
 * Two surfaces do: the launcher TILE (`launcherShowsApp` — a direct
 * `scholarApps` row or an audience grant) and a live PUSH CARD (FocusStrip
 * renders an app-target push as a tappable "Right now" card, and that tap
 * lands in this same launch path). Both must be accepted, because a tap this
 * gate refuses on a card Rabbithole itself just rendered is a re-run of the
 * 2026-08-31 incident — a visible affordance failing closed against a door
 * MDM had already opened. `lib/deviceAppProjection.ts`'s doctrine is that "I
 * can see it" and "the bundle is in my allowlist" cannot drift apart; a
 * grants-only gate on a mediated device is exactly that drift.
 *
 * (This is a different question from what belongs in the ALLOWLIST. There,
 * widening past what a surface can reach is harmless — the allowlist is a
 * ceiling, not an invitation. Here we are deciding whether to refuse a tap,
 * so the ceiling argument does not apply.)
 *
 * Push visibility takes no clock: whether a card is on screen is a pure
 * function of `setAt` / `clearedAt` (lib/pushes.ts's showing-vs-blocking
 * split), so there is no expiry boundary for the reactive `status` query to
 * go stale across.
 */
async function requireAuthorizedNativeTile(
  ctx: DbCtx,
  user: Doc<"users">,
  externalAppId: Id<"externalApps">,
): Promise<AppKey> {
  const app = await ctx.db.get(externalAppId);
  if (!app || app.archived) {
    throw new Error("This app is no longer available.");
  }
  const appKey = managedNativeAppKeyForScheme(app.nativeUrlScheme);
  if (!appKey) {
    throw new Error("This app does not support temporary native access.");
  }
  const link = await ctx.db
    .query("scholarApps")
    .withIndex("by_scholar_app", (q) => q.eq("scholarId", user._id).eq("appId", externalAppId))
    .first();
  const granted = await scholarHasGrantForApp(ctx as QueryCtx, user, externalAppId);
  const visible =
    launcherShowsApp({ link, granted }) ||
    (await livePushShowsAppToScholar(ctx, user, externalAppId));
  if (!visible) {
    throw new Error("This app is not available to this scholar.");
  }
  return appKey;
}

function statusNow(nowMs: number | undefined): number {
  const now = Date.now();
  if (
    nowMs === undefined ||
    !Number.isFinite(nowMs) ||
    Math.abs(nowMs - now) > STATUS_CLOCK_SKEW_MS
  ) {
    throw new Error("Status time is invalid; refresh Rabbithole and try again.");
  }
  return nowMs;
}

/**
 * Is a whole-profile PATCH genuinely in flight for this row, and who holds it?
 *
 * `operationToken` serializes the two writers, but it is also CLIENT-VISIBLE
 * through `statusFor`. A background projection holding it must therefore not
 * look like a ceremony operation to the iPad: that is what made a cold tap sit
 * on `mdm-patch-in-flight` and then fail, and made `requestUnlock` throw "an
 * update is already in progress" — on exactly the teacher-just-granted moment
 * the projection exists to serve.
 *
 * Absent `tokenKind` means "ceremony", so every row written before the
 * projection existed keeps its old meaning.
 */
function operationHolder(
  state: Doc<"deviceAppUnlockStates">,
  nowMs: number,
): "ceremony" | "projection" | null {
  if (
    state.operationToken === undefined ||
    state.operationStartedAt === undefined ||
    state.operationStartedAt + OPERATION_TIMEOUT_MS <= nowMs
  ) {
    return null;
  }
  return state.tokenKind === "projection" ? "projection" : "ceremony";
}

/**
 * The fields that release a PREEMPTED projection operation.
 *
 * A projection-held token may be taken by the ceremony or by the revocation
 * gate at any time — neither should wait on a background job. The preempted
 * PATCH may still land afterwards, and the preemptor cannot know whether it
 * did, so it stamps `projectionVerifyNeeded`: the next projection pass must
 * re-read the LIVE profile rather than trust the stored hint. That is what
 * makes preemption safe rather than merely convenient.
 */
function preemptProjectionPatch(
  state: Doc<"deviceAppUnlockStates">,
  nowMs: number,
) {
  return {
    projectionError: undefined,
    ...uncertainProjectionWrite(state, state.operationStartedAt ?? nowMs),
  };
}

function statusFor(
  state: Doc<"deviceAppUnlockStates"> | null,
  now: number,
  requestedAppKey?: AppKey,
): AppUnlockStatus {
  if (!state) {
    return {
      desiredState: "locked" as const,
      availability: "locked" as const,
      expiresAt: null,
      mdmAcceptedAt: null,
      expectedAvailableAt: null,
    };
  }
  // A settled transport failure is user-actionable immediately, even though
  // its operation lease remains held to prevent an overlapping profile PATCH.
  if (state.lastMdmError && state.mdmAcceptedAt === undefined) {
    return {
      desiredState: state.desiredState,
      availability: "mdm-error",
      expiresAt: state.expiresAt ?? null,
      mdmAcceptedAt: null,
      expectedAvailableAt: null,
    };
  }
  // Only a CEREMONY operation is a client-visible in-flight state. A
  // projection PATCH is background work on the same profile; reporting it here
  // would make a scholar wait on — and then fail against — a job they never
  // started. The row's underlying lease state is reported instead, which is
  // exactly what the client would have seen a moment before the projector
  // picked the row up.
  if (operationHolder(state, now) === "ceremony") {
    return {
      desiredState: state.desiredState,
      availability: "mdm-patch-in-flight",
      expiresAt: state.expiresAt ?? null,
      mdmAcceptedAt: state.mdmAcceptedAt ?? null,
      expectedAvailableAt: state.expectedAvailableAt ?? null,
    };
  }
  if (
    requestedAppKey &&
    state.desiredState === "unlocked" &&
    state.appKey !== requestedAppKey
  ) {
    return {
      desiredState: "locked",
      availability: "locked",
      expiresAt: null,
      mdmAcceptedAt: null,
      expectedAvailableAt: null,
    };
  }
  if (state.desiredState === "locked") {
    if (state.mdmAcceptedAt === undefined) {
      return {
        desiredState: "locked" as const,
        availability: "awaiting-mdm-acceptance" as const,
        expiresAt: null,
        mdmAcceptedAt: null,
        expectedAvailableAt: null,
      };
    }
    return {
      desiredState: "locked" as const,
      availability: "locked" as const,
      expiresAt: null,
      mdmAcceptedAt: state.mdmAcceptedAt ?? null,
      expectedAvailableAt: null,
    };
  }
  if (state.expiresAt !== undefined && state.expiresAt <= now) {
    return {
      desiredState: "locked" as const,
      availability: "expired-awaiting-reconcile" as const,
      expiresAt: state.expiresAt,
      mdmAcceptedAt: state.mdmAcceptedAt ?? null,
      expectedAvailableAt: null,
    };
  }
  if (state.mdmAcceptedAt === undefined) {
    return {
      desiredState: "unlocked" as const,
      availability: "awaiting-mdm-acceptance" as const,
      expiresAt: state.expiresAt ?? null,
      mdmAcceptedAt: null,
      expectedAvailableAt: null,
    };
  }
  return {
    desiredState: "unlocked" as const,
    // This is intentionally not a device-observed assertion: SimpleMDM only
    // accepted the profile PATCH, so the client must still handle a failed URL open.
    availability:
      (state.expectedAvailableAt ?? Number.MAX_SAFE_INTEGER) <= now
        ? ("expected-from-mdm-acceptance" as const)
        : ("mdm-accepted-propagating" as const),
    expiresAt: state.expiresAt ?? null,
    mdmAcceptedAt: state.mdmAcceptedAt,
    expectedAvailableAt: state.expectedAvailableAt ?? null,
  };
}

async function prepareRequest(
  ctx: MutationCtx,
  args: {
    deviceId: string;
    desiredState: DesiredState;
    externalAppId?: Id<"externalApps">;
    leaseToken?: string;
  },
): Promise<
  | { needsPatch: false; status: AppUnlockStatus }
  | {
      needsPatch: true;
      binding: Doc<"deviceAppUnlockBindings">;
      revision: number;
      operationToken: string;
      bundleIds: string[];
    }
> {
  const user = await requireUser(ctx);
  await assertNotImpersonating(ctx);
  const { claim, binding } = await requireClaimedDevice(ctx, user, args.deviceId);
  // One clock for the whole request: the visibility gate below and every
  // timestamp written on this row must agree about when "now" is, or a focus
  // expiring mid-request could authorize a lease stamped past its window.
  const now = Date.now();
  const appKey = args.desiredState === "unlocked" && args.externalAppId
    ? await requireAuthorizedNativeTile(ctx, user, args.externalAppId)
    : undefined;
  const leaseToken = args.leaseToken?.trim();
  if (
    args.desiredState === "unlocked" &&
    (!appKey || !leaseToken || leaseToken.length > 200)
  ) {
    throw new Error("This app is not eligible for temporary native access.");
  }
  const current = await ctx.db
    .query("deviceAppUnlockStates")
    .withIndex("by_managed_device", (q) =>
      q.eq("managedDeviceClaimId", claim._id),
    )
    .unique();
  // A CEREMONY operation still blocks, exactly as before. A PROJECTION
  // operation is PREEMPTED: the scholar's tap must never queue behind — or be
  // refused because of — a background job they did not start. Taking the token
  // is safe because the preempted PATCH's own record path tolerates losing it,
  // and `preemptProjectionPatch` marks the row verify-needed so the next
  // projection pass re-reads the live profile instead of trusting a hint the
  // preemption invalidated.
  const holder = current ? operationHolder(current, now) : null;
  if (holder === "ceremony") {
    if (
      current!.desiredState === args.desiredState &&
      (args.desiredState === "locked" || current!.appKey === appKey)
    ) {
      return { needsPatch: false, status: statusFor(current!, now) };
    }
    throw new Error("A temporary app-access update is already in progress. Try again shortly.");
  }
  const preempting = holder === "projection";
  const sameActiveUnlock =
    !preempting &&
    args.desiredState === "unlocked" &&
    current?.desiredState === "unlocked" &&
    current.appKey === appKey &&
    (current.activeSessionFailsafeAt ?? current.expiresAt ?? 0) > now &&
    current.mdmAcceptedAt !== undefined &&
    // A row stamped for a since-superseded owner must NOT be reused as-is —
    // it would keep the STALE generation, and the reconciler's atomic gate
    // (prepareReconcileLock) would then read that mismatch as "stale unlock,
    // not this claim's current owner" and lock out the very re-requester who
    // just proved (via requireClaimedDevice, above) that they ARE the
    // claim's current owner. Falling through re-stamps claimGeneration fresh.
    (current.claimGeneration ?? 0) === (claim.claimGeneration ?? 0);
  // `sameLock` is the "nothing to do, you are already closed" shortcut. It is
  // only honest when this row's projected allowlist is CURRENTLY TRUSTED —
  // i.e. proven against the live profile and not since invalidated. Two cases
  // it must not fire for:
  //   • a row the projector created but has never verified (that row must
  //     behave exactly like the absent row it replaced, which PATCHes);
  //   • a row whose trust was destroyed by a failure, a lost token, a
  //     preemption or a rebind.
  // Without this, "requestLock on a bound device" would silently stop
  // converging the profile the moment a state row came into existence.
  const projectionTrusted =
    current !== null &&
    current !== undefined &&
    current.projectionVerifiedAt !== undefined &&
    current.projectionVerifyNeeded !== true;
  const sameLock =
    args.desiredState === "locked" &&
    current?.desiredState === "locked" &&
    current.mdmAcceptedAt !== undefined &&
    projectionTrusted &&
    !preempting;
  if (sameActiveUnlock) {
    // This is an inactivity lease, not a one-shot launch timer. A warm same-app
    // request extends its server-owned expiry without mutating the profile.
    const expiresAt = now + ACTIVE_SESSION_FAILSAFE_MS;
    await ctx.db.patch(current._id, {
      expiresAt,
      idleSince: undefined,
      activeSessionFailsafeAt: expiresAt,
      activeLeaseToken: leaseToken,
      updatedAt: Math.max(now, current.updatedAt + 1),
      requestedAt: now,
      requestedBy: user._id,
      // Still the same authorized grant — just push the periodic recheck
      // out rather than leaving it due immediately (harmless either way,
      // since the gate would simply re-confirm authorization, but this
      // avoids a redundant gate-check on the very next tick).
      nextRecheckAt: now + RECHECK_INTERVAL_MS,
    });
    return {
      needsPatch: false as const,
      status: { ...statusFor(current, now), expiresAt },
    };
  }
  if (sameLock) {
    return { needsPatch: false as const, status: statusFor(current, now) };
  }

  // The ceremony writes the SAME target set as the projection, so the two
  // writers can never fight over one profile (see lib/deviceAppProjection.ts
  // § composition rule). Two consequences worth naming:
  //   • an unlock is `projected ∪ {the leased app}` — the leased app is
  //     normally already granted, so this union is usually a no-op, but it
  //     makes the lease a guaranteed superset member even at a race edge;
  //   • a LOCK no longer PATCHes bare baseline. "Relock" now means "converge
  //     to the projection", so handing an iPad back cannot strip the apps a
  //     teacher has standing-granted it.
  // `state: null` deliberately excludes the CURRENT lease from the derivation
  // — this request is what decides the lease — so a lock never re-adds the
  // very app it is closing.
  const projected = await projectedBundleIdsForClaim(ctx, {
    claim,
    binding,
    state: null,
    baseline: validateBaseline(binding.baselineBundleIds),
    nowMs: now,
  });
  const bundleIds =
    args.desiredState === "unlocked" && appKey
      ? [...new Set([...projected, SUPPORTED_APPS[appKey].bundleId])].sort()
      : projected;

  const updatedAt = Math.max(now, (current?.updatedAt ?? 0) + 1);
  const patch = {
    institutionId: claim.institutionId,
    managedDeviceClaimId: claim._id,
    desiredState: args.desiredState,
    appKey: args.desiredState === "unlocked" ? appKey : undefined,
    expiresAt:
      args.desiredState === "unlocked" ? now + ACTIVE_SESSION_FAILSAFE_MS : undefined,
    idleSince: undefined,
    activeSessionFailsafeAt:
      args.desiredState === "unlocked" ? now + ACTIVE_SESSION_FAILSAFE_MS : undefined,
    activeLeaseToken: args.desiredState === "unlocked" ? leaseToken : undefined,
    pendingLockRetryAt: args.desiredState === "locked" ? now : undefined,
    updatedAt,
    requestedAt: now,
    requestedBy: user._id,
    mdmAcceptedAt: undefined,
    expectedAvailableAt: undefined,
    lockedAt: undefined,
    lastMdmError: undefined,
    operationToken: crypto.randomUUID(),
    operationStartedAt: now,
    tokenKind: "ceremony" as const,
    // If this request took the token from an in-flight projection PATCH, that
    // PATCH may still land after ours. We cannot know, so the next projection
    // pass must re-read the live profile rather than trust any stored hint.
    ...(preempting && current ? preemptProjectionPatch(current, now) : {}),
    // Stamped fresh on every grant so the reconciler's atomic gate can tell
    // a fresh, just-authorized unlock (generation matches the claim's
    // CURRENT value) apart from stale leftover state from a since-departed
    // owner (see prepareReconcileLock). A lock request's own generation
    // value is irrelevant (only "unlocked" rows are ever gate-checked), but
    // stamping it unconditionally keeps the row internally consistent.
    claimGeneration: claim.claimGeneration ?? 0,
    nextRecheckAt:
      args.desiredState === "unlocked" ? now + RECHECK_INTERVAL_MS : undefined,
    // What this PATCH is about to send. `appliedBundleIds` is only stamped
    // once SimpleMDM durably accepts it (recordMdmPatch), so a failed
    // ceremony PATCH leaves the projection knowing it has drifted.
    desiredBundleIds: bundleIds,
  } as const;
  if (current) await ctx.db.patch(current._id, patch);
  else await ctx.db.insert("deviceAppUnlockStates", patch);
  await ctx.db.insert("auditLog", {
    actorUserId: user._id,
    targetUserId: user._id,
    at: now,
    action:
      args.desiredState === "unlocked"
        ? "device.app-unlock.requested"
        : "device.app-unlock.lock-requested",
    detail:
      args.desiredState === "unlocked"
        ? "Requested temporary app access."
        : "Requested temporary app access lock.",
  });
  return {
    needsPatch: true as const,
    binding,
    revision: updatedAt,
    operationToken: patch.operationToken,
    bundleIds,
  };
}

const prepareUnlockRef = makeFunctionReference<
  "mutation",
  { deviceId: string; externalAppId: Id<"externalApps">; leaseToken: string },
  Awaited<ReturnType<typeof prepareRequest>>
>("deviceAppUnlock:prepareUnlock");
const prepareLockRef = makeFunctionReference<
  "mutation",
  { deviceId: string },
  Awaited<ReturnType<typeof prepareRequest>>
>("deviceAppUnlock:prepareLock");
const recordMdmPatchRef = makeFunctionReference<
  "mutation",
  {
    managedDeviceClaimId: Id<"managedDeviceClaims">;
    revision: number;
    operationToken: string;
    accepted: boolean;
    appliedBundleIds?: string[];
  },
  { recorded: boolean }
>("deviceAppUnlock:recordMdmPatch");
const stateForClaimRef = makeFunctionReference<
  "query",
  { managedDeviceClaimId: Id<"managedDeviceClaims"> },
  Doc<"deviceAppUnlockStates"> | null
>("deviceAppUnlock:stateForClaim");
const dueActiveUnlocksRef = makeFunctionReference<
  "query",
  { nowMs: number },
  Doc<"deviceAppUnlockStates">[]
>("deviceAppUnlock:dueActiveUnlocks");
const pendingLocksRef = makeFunctionReference<
  "query",
  { nowMs: number },
  Doc<"deviceAppUnlockStates">[]
>("deviceAppUnlock:pendingLocks");
const reconcileActiveUnlocksRef = makeFunctionReference<
  "action",
  { nowMs?: number },
  {
    considered: number;
    locked: number;
    authorized: number;
    failed: number;
    projected: number;
    projectionFailed: number;
  }
>("deviceAppUnlock:reconcileActiveUnlocks");
const preparePendingLockRef = makeFunctionReference<
  "mutation",
  { managedDeviceClaimId: Id<"managedDeviceClaims">; expectedRevision: number },
  {
    binding: Doc<"deviceAppUnlockBindings">;
    revision: number;
    operationToken: string;
    bundleIds: string[];
  } | null
>("deviceAppUnlock:preparePendingLock");
// Discriminated so a caller can tell "nothing to do" (already locked, unlocked
// to a different app, or already authorized) apart from "raced an in-flight
// operation" — only the latter needs the row rechecked once that operation
// settles. "locked" carries NO binding/revision/operationToken: the gate
// never reserves a network-operation token for the whole batch (see
// lockedStatePatch) — the actual PATCH attempt is acquired fresh, per row,
// immediately before the network call, by preparePendingLock.
type ReconcileLockResult =
  | { status: "locked" }
  | { status: "not-applicable" }
  | { status: "in-flight" }
  | { status: "authorized" };
const prepareReconcileLockRef = makeFunctionReference<
  "mutation",
  { managedDeviceClaimId: Id<"managedDeviceClaims">; nowMs: number },
  ReconcileLockResult
>("deviceAppUnlock:prepareReconcileLock");
type PreparedDedicatedProfile = {
  managedDeviceClaimId: Id<"managedDeviceClaims">;
  simpleMdmProfileId: string;
  baselineBundleIds: string[];
  serial: string;
  configuredBy: Id<"users">;
  existingBindingId: Id<"deviceAppUnlockBindings"> | null;
};
const prepareDedicatedProfileRef = makeFunctionReference<
  "mutation",
  {
    managedDeviceClaimId: Id<"managedDeviceClaims">;
    simpleMdmProfileId: string;
    baselineBundleIds: string[];
  },
  PreparedDedicatedProfile
>("deviceAppUnlock:prepareDedicatedProfile");
const recordDedicatedProfileRef = makeFunctionReference<
  "mutation",
  PreparedDedicatedProfile & {
    baselineProfileXml: string;
    profilePayloadIdentifier: string;
    profilePayloadUuid: string;
    profileUuid: string;
  },
  { configured: boolean }
>("deviceAppUnlock:recordDedicatedProfile");

// A settled `locked` row (MDM acceptance recorded, no in-flight operation, no
// pending retry owed) — or no row at all — is the only state with nothing in
// motion: safe to reconfigure its profile binding, and safe to delete both it
// and its binding immediately (Finding 3, final gate — see
// `cleanupAfterLockIntent`'s schema doc comment and `removeManagedDevice`).
export function isUnlockStateSettled(
  activeState: Doc<"deviceAppUnlockStates"> | null,
): boolean {
  if (!activeState) return true;
  return (
    activeState.desiredState === "locked" &&
    activeState.mdmAcceptedAt !== undefined &&
    activeState.operationToken === undefined &&
    activeState.pendingLockRetryAt === undefined
  );
}

// Rejects a dedicated-profile (re)configuration while an unlock/relock is
// still in motion for this claim: an active unlock or a still-pending relock
// means the CURRENT profile/baseline is what the physical device is being
// patched against, and swapping the binding underneath that in-flight work
// could orphan the old widened profile instead of ever relocking it.
function assertUnlockStateSettledForProfileChange(
  activeState: Doc<"deviceAppUnlockStates"> | null,
): void {
  if (!isUnlockStateSettled(activeState)) {
    throw new Error(
      "Lock this iPad's temporary app access — and let the lock finish applying — before changing its profile binding.",
    );
  }
}

export const status = authedQuery({
  args: {
    deviceId: v.string(),
    externalAppId: v.id("externalApps"),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    // Argument validation first: a skewed clock is a bad argument whatever this
    // device's configuration turns out to be, so it must not be short-circuited
    // by the not-configured return below.
    const now = statusNow(args.nowMs);
    const { claim, binding } = await resolveClaimedDevice(ctx, ctx.user, args.deviceId);
    // Authorization is checked BEFORE the not-configured return: a scholar no
    // visible surface shows this app to gets the same refusal they always did,
    // never a signal telling the launcher to go ahead and open it.
    const appKey = await requireAuthorizedNativeTile(ctx, ctx.user, args.externalAppId);
    // This iPad's launches are not mediated by the unlock system — fleet devices
    // carry the group profile, which allowlists these apps permanently. Say so
    // in the contract instead of throwing at a launch that needs nothing from us.
    if (!binding) return NOT_CONFIGURED_STATUS;
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", claim._id),
      )
      .unique();
    return statusFor(state, now, appKey);
  },
});

/**
 * Called when Rabbithole regains foreground after a native-app handoff. It does
 * not touch MDM: the app remains available briefly for a warm return, but the
 * normal one-hour clock now measures idle time rather than launch time.
 */
export const markReturned = authedMutation({
  args: { deviceId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const { claim } = await requireClaimedDevice(ctx, ctx.user, args.deviceId);
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", claim._id),
      )
      .unique();
    const now = Date.now();
    const activeFailsafeAt = state?.activeSessionFailsafeAt ?? state?.expiresAt;
    if (
      !state ||
      state.desiredState !== "unlocked" ||
      state.activeLeaseToken !== args.leaseToken ||
      state.mdmAcceptedAt === undefined ||
      activeFailsafeAt === undefined ||
      activeFailsafeAt <= now
    ) {
      return { marked: false, expiresAt: null };
    }
    await ctx.db.patch(state._id, {
      idleSince: now,
      expiresAt: now + IDLE_LEASE_DURATION_MS,
      activeLeaseToken: undefined,
      updatedAt: Math.max(now, state.updatedAt + 1),
    });
    return { marked: true, expiresAt: now + IDLE_LEASE_DURATION_MS };
  },
});

// This is an action rather than a mutation because it proves the profile's
// live SimpleMDM scope before persisting a binding.
export const configureDedicatedProfile = action({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    simpleMdmProfileId: v.string(),
    baselineBundleIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(prepareDedicatedProfileRef, args);
    const profileXml = await downloadProfileTemplate(apiKey(), prepared.simpleMdmProfileId);
    assertTemplateBaseline(profileXml, prepared.baselineBundleIds);
    const identity = parseDedicatedProfileTemplate(profileXml);
    await verifyDedicatedProfileScope(apiKey(), {
      simpleMdmProfileId: prepared.simpleMdmProfileId,
      serial: prepared.serial,
    });
    return await ctx.runMutation(recordDedicatedProfileRef, {
      ...prepared,
      baselineProfileXml: profileXml,
      baselineBundleIds: identity.baselineBundleIds,
      profilePayloadIdentifier: identity.profilePayloadIdentifier,
      profilePayloadUuid: identity.profilePayloadUuid,
      profileUuid: identity.profileUuid,
    });
  },
});

export const prepareDedicatedProfile = internalMutation({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    simpleMdmProfileId: v.string(),
    baselineBundleIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await assertNotImpersonating(ctx);
    const primaryInstitution = await primaryInstitutionId(ctx);
    const claim = await ctx.db.get(args.managedDeviceClaimId);
    if (
      !primaryInstitution ||
      !claim ||
      claim.institutionId !== primaryInstitution ||
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        user,
        claim.institutionId,
      ))
    ) {
      throw new Error("Temporary app access isn't configured for this school.");
    }
    const profileId = args.simpleMdmProfileId.trim();
    if (!SIMPLEMDM_PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error("Enter the dedicated SimpleMDM custom profile ID.");
    }
    const baselineBundleIds = validateBaseline(args.baselineBundleIds);
    const usedProfile = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_profile", (q) => q.eq("simpleMdmProfileId", profileId))
      .unique();
    if (usedProfile && usedProfile.managedDeviceClaimId !== claim._id) {
      throw new Error("That SimpleMDM profile is already bound to another iPad.");
    }
    const existing = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", claim._id),
      )
      .unique();
    const activeState = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", claim._id),
      )
      .unique();
    if (existing) {
      assertUnlockStateSettledForProfileChange(activeState);
    }
    return {
      managedDeviceClaimId: claim._id,
      simpleMdmProfileId: profileId,
      baselineBundleIds,
      serial: claim.serial,
      configuredBy: user._id,
      existingBindingId: existing?._id ?? null,
    };
  },
});

export const recordDedicatedProfile = internalMutation({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    simpleMdmProfileId: v.string(),
    baselineBundleIds: v.array(v.string()),
    baselineProfileXml: v.string(),
    serial: v.string(),
    profilePayloadIdentifier: v.string(),
    profilePayloadUuid: v.string(),
    profileUuid: v.string(),
    configuredBy: v.id("users"),
    existingBindingId: v.union(v.id("deviceAppUnlockBindings"), v.null()),
  },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.managedDeviceClaimId);
    const user = await ctx.db.get(args.configuredBy);
    const primaryInstitution = await primaryInstitutionId(ctx);
    if (
      !primaryInstitution ||
      !claim ||
      claim.institutionId !== primaryInstitution ||
      !user ||
      claim.serial !== args.serial ||
      !(await hasSchoolOperationsAccessAtInstitution(ctx, user, claim.institutionId))) {
      throw new Error("Temporary app access isn't configured for this school.");
    }
    const usedProfile = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_profile", (q) => q.eq("simpleMdmProfileId", args.simpleMdmProfileId))
      .unique();
    if (usedProfile && usedProfile.managedDeviceClaimId !== claim._id) {
      throw new Error("That SimpleMDM profile is already bound to another iPad.");
    }
    const currentBinding = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", claim._id),
      )
      .unique();
    if (
      args.existingBindingId !== null &&
      currentBinding?._id !== args.existingBindingId
    ) {
      throw new Error("The iPad's profile binding changed while it was being configured.");
    }
    if (args.existingBindingId === null && currentBinding) {
      throw new Error("The iPad's profile binding changed while it was being configured.");
    }
    // Mandatory record-time recheck (Finding 5, safety review): an unlock or
    // pending relock can start between prepare and record — re-validate
    // FRESH state right before persisting the binding change, not just the
    // binding identity captured at prepare time.
    if (currentBinding) {
      const activeState = await ctx.db
        .query("deviceAppUnlockStates")
        .withIndex("by_managed_device", (q) =>
          q.eq("managedDeviceClaimId", claim._id),
        )
        .unique();
      assertUnlockStateSettledForProfileChange(activeState);
    }
    const now = Date.now();
    const values = {
      institutionId: claim.institutionId,
      managedDeviceClaimId: claim._id,
      serial: claim.serial,
      simpleMdmProfileId: args.simpleMdmProfileId,
      baselineBundleIds: args.baselineBundleIds,
      baselineProfileXml: args.baselineProfileXml,
      profilePayloadIdentifier: args.profilePayloadIdentifier,
      profilePayloadUuid: args.profilePayloadUuid,
      profileUuid: args.profileUuid,
      configuredAt: now,
      configuredBy: args.configuredBy,
    };
    if (currentBinding) await ctx.db.patch(currentBinding._id, values);
    else await ctx.db.insert("deviceAppUnlockBindings", values);
    // A REBIND repoints this claim at a different SimpleMDM profile (or the
    // same one with a different baseline), so everything the projection
    // believed about the device's allowlist now describes the OLD profile.
    // Left in place, a stale `appliedBundleIds` that happens to equal the
    // newly-derived desired set would make the projector skip forever, and the
    // freshly-bound profile — sitting at bare baseline — would never receive
    // the scholar's granted apps. Clear the hint and force a live-verified
    // pass.
    const boundState = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", claim._id),
      )
      .unique();
    if (boundState) {
      await ctx.db.patch(boundState._id, {
        appliedBundleIds: undefined,
        projectionAppliedAt: undefined,
        projectionVerifiedAt: undefined,
        projectionVerifyNeeded: true,
        projectionError: undefined,
        projectionDueAt: 0,
      });
    }
    await ctx.scheduler.runAfter(0, reconcileActiveUnlocksRef, {});
    await ctx.db.insert("auditLog", {
      actorUserId: args.configuredBy,
      targetUserId: claim.scholarId ?? args.configuredBy,
      at: now,
      action: "device.app-unlock.binding-configured",
      detail: "Configured a dedicated temporary app-access profile.",
    });
    return { configured: true };
  },
});

export const prepareUnlock = internalMutation({
  args: {
    deviceId: v.string(),
    externalAppId: v.id("externalApps"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) =>
    await prepareRequest(ctx, {
      deviceId: args.deviceId,
      desiredState: "unlocked",
      externalAppId: args.externalAppId,
      leaseToken: args.leaseToken,
    }),
});

export const prepareLock = internalMutation({
  args: { deviceId: v.string() },
  handler: async (ctx, args) =>
    await prepareRequest(ctx, { deviceId: args.deviceId, desiredState: "locked" }),
});

export const recordMdmPatch = internalMutation({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    revision: v.number(),
    operationToken: v.string(),
    accepted: v.boolean(),
    // The exact allowlist this operation sent. Every ceremony writer now
    // sends the projected set (see prepareRequest / preparePendingLock), so
    // recording it here is what keeps the projection's diff baseline honest
    // without a second write path: one place stamps "SimpleMDM durably holds
    // this set for this device", whoever performed the PATCH.
    appliedBundleIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    if (
      !state ||
      state.updatedAt !== args.revision ||
      state.operationToken !== args.operationToken
    ) return { recorded: false };
    const now = Date.now();
    if (!args.accepted) {
      const failedUnlock = state.desiredState === "unlocked";
      const operationLeaseExpiresAt =
        (state.operationStartedAt ?? now) + OPERATION_TIMEOUT_MS;
      await ctx.db.patch(state._id, {
        lastMdmError: "request-failed",
        desiredState: failedUnlock ? "locked" : state.desiredState,
        appKey: failedUnlock ? undefined : state.appKey,
        expiresAt: failedUnlock ? undefined : state.expiresAt,
        idleSince: failedUnlock ? undefined : state.idleSince,
        activeSessionFailsafeAt: failedUnlock
          ? undefined
          : state.activeSessionFailsafeAt,
        activeLeaseToken: failedUnlock ? undefined : state.activeLeaseToken,
        pendingLockRetryAt: failedUnlock
          ? operationLeaseExpiresAt
          : now + LOCK_RETRY_DELAY_MS,
        updatedAt: Math.max(now, state.updatedAt + 1),
        // The device's real allowlist is now UNKNOWN (a timed-out PATCH may
        // still have landed), so `appliedBundleIds` is deliberately left
        // alone rather than guessed at — and the stored hint is marked
        // untrusted so the next projection pass reads the LIVE profile instead
        // of comparing against a value it can no longer vouch for.
        ...uncertainProjectionWrite(state, state.operationStartedAt ?? now),
        projectionDueAt: preservedProjectionDueAt(state, operationLeaseExpiresAt),
      });
      if (failedUnlock) {
        // A timed-out PATCH may still have reached the device. Re-assert the
        // locked baseline once its mutual-exclusion lease expires; starting a
        // second whole-profile PATCH sooner could let the first land last.
        await ctx.scheduler.runAfter(
          Math.max(0, operationLeaseExpiresAt - now),
          reconcileActiveUnlocksRef,
          { nowMs: operationLeaseExpiresAt },
        );
      }
      return { recorded: true };
    }
    if (
      state.cleanupAfterLockIntent &&
      state.desiredState === "locked"
    ) {
      // Finding 3 (final gate): the row survived deliberately so a relock
      // still in flight when its claim was removed could finish and be
      // recorded. SimpleMDM has now durably accepted the baseline PATCH —
      // nothing left in motion — so complete the deferred cleanup: delete
      // both this state row and its dedicated-profile binding instead of
      // merely marking them accepted. The staleness guard above (matching
      // revision + operationToken) already proves this is the exact
      // operation the removal scheduled; a stale/superseded task can never
      // reach here to delete a binding a fresh registration now depends on.
      //
      // Defect-only gate (round 5), Finding 1: cleanup must ONLY finalize
      // on an accepted LOCK PATCH, never an accepted UNLOCK PATCH. If
      // removeManagedDevice stamps cleanupAfterLockIntent while an unlock
      // request is still in flight (desiredState is still "unlocked" at
      // that instant), that unlock's own eventual accept still matches
      // this exact revision/token — deleting the row+binding right there
      // would strand SimpleMDM's profile permanently widened, since the
      // reconciler tick that would otherwise flip desiredState to "locked"
      // (and send the actual baseline PATCH) has nothing left to act on.
      // The `desiredState === "locked"` guard defers finalization until
      // AFTER that baseline PATCH is the one being accepted — an accepted
      // unlock with cleanup intent set instead falls through to the normal
      // accept branch below, which preserves cleanupAfterLockIntent
      // (untouched by that patch) for the next reconcile tick to finish.
      // DELETION REQUIRES A PROVABLE BASELINE (verify barrier).
      //
      // "SimpleMDM accepted the baseline PATCH" is not the same as "the
      // profile will still hold the baseline a minute from now". If an earlier
      // projection write is still inside its landing window, it can arrive
      // AFTER this baseline write and re-widen a profile whose device has just
      // been decommissioned — and once the row and binding are gone there is
      // no handle left for any later pass to notice, let alone correct it.
      //
      // So while a barrier is outstanding, finalization is DEFERRED rather
      // than performed: the row and binding stay, parked back in the owing
      // state with a retry just past the barrier. The baseline PATCH is
      // idempotent, so the existing pending-lock machinery simply re-runs it
      // after the window closes — and that later run, which no stale write can
      // overtake, is the proof that lets this branch delete.
      const barrierAt = state.projectionVerifyBarrierAt;
      // `>= now`, not `> now`: trust (resolveProjectionTrust) is only safe
      // STRICTLY after the barrier, so a baseline acceptance recorded at
      // exactly `barrierAt` must still park — an uncertain write can legally
      // land at that same instant. The two predicates must stay complements.
      if (barrierAt !== undefined && barrierAt >= now) {
        await ctx.db.patch(state._id, {
          desiredState: "locked",
          mdmAcceptedAt: undefined,
          expectedAvailableAt: undefined,
          lockedAt: undefined,
          // Just past the barrier: `pendingLocks` filters on
          // `pendingLockRetryAt <= nowMs`, so this is exactly when the
          // re-assertion becomes eligible and not a tick sooner.
          pendingLockRetryAt: barrierAt + 1,
          updatedAt: Math.max(now, state.updatedAt + 1),
          operationToken: undefined,
          operationStartedAt: undefined,
          tokenKind: undefined,
          projectionDueAt: preservedProjectionDueAt(state, barrierAt + 1),
        });
        return { recorded: true };
      }
      const binding = await ctx.db
        .query("deviceAppUnlockBindings")
        .withIndex("by_managed_device", (q) =>
          q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
        )
        .unique();
      if (binding) await ctx.db.delete(binding._id);
      await ctx.db.delete(state._id);
      return { recorded: true };
    }
    await ctx.db.patch(state._id, {
      mdmAcceptedAt: now,
      expectedAvailableAt:
        state.desiredState === "unlocked"
          ? now + EXPECTED_MDM_PROPAGATION_MS
          : undefined,
      lockedAt: state.desiredState === "locked" ? now : undefined,
      lastMdmError: undefined,
      operationToken: undefined,
      operationStartedAt: undefined,
      tokenKind: undefined,
      pendingLockRetryAt: undefined,
      // SimpleMDM durably holds this set now, so it becomes the projection's
      // diff baseline and the periodic re-derive can wait a full interval. A
      // caller that didn't declare what it sent leaves both untouched rather
      // than recording a set it can't vouch for.
      ...(args.appliedBundleIds !== undefined
        ? {
            appliedBundleIds: args.appliedBundleIds,
            projectionAppliedAt: now,
            // A ceremony PATCH goes through the same safety core, which reads
            // the live profile before writing it, so this set is a genuine
            // live read. It still may not clear an outstanding barrier early:
            // succeeding proves nothing about a DIFFERENT write that may yet
            // land, which is exactly the interleaving the fence exists for.
            ...resolveProjectionTrust({
              now,
              barrierAt: state.projectionVerifyBarrierAt,
              verifiedByLiveRead: true,
            }),
            projectionError: undefined,
            projectionDueAt: preservedProjectionDueAt(
              state,
              now + PROJECTION_INTERVAL_MS,
            ),
          }
        : {}),
    });
    return { recorded: true };
  },
});

async function executePreparedRequest(
  ctx: ActionCtx,
  prepared: Awaited<ReturnType<typeof prepareRequest>>,
) {
  if (!prepared.needsPatch) return { ...prepared.status, idempotent: true };
  try {
    await patchProfile(apiKey(), prepared.binding, prepared.bundleIds);
  } catch {
    await ctx.runMutation(recordMdmPatchRef, {
      managedDeviceClaimId: prepared.binding.managedDeviceClaimId,
      revision: prepared.revision,
      operationToken: prepared.operationToken,
      accepted: false,
    });
    throw new Error("SimpleMDM could not accept the temporary app-access update. Try again.");
  }
  const recorded = await ctx.runMutation(recordMdmPatchRef, {
    managedDeviceClaimId: prepared.binding.managedDeviceClaimId,
    revision: prepared.revision,
    operationToken: prepared.operationToken,
    accepted: true,
    appliedBundleIds: prepared.bundleIds,
  });
  if (!recorded.recorded) {
    throw new Error(
      "The iPad's temporary app-access request changed while SimpleMDM was updating it. Check status before trying again.",
    );
  }
  const state = await ctx.runQuery(stateForClaimRef, {
    managedDeviceClaimId: prepared.binding.managedDeviceClaimId,
  });
  return { ...statusFor(state, Date.now()), idempotent: false };
}

export const requestUnlock = action({
  args: {
    deviceId: v.string(),
    externalAppId: v.id("externalApps"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) =>
    await executePreparedRequest(
      ctx,
      await ctx.runMutation(prepareUnlockRef, args),
    ),
});

export const requestLock = action({
  args: { deviceId: v.string() },
  handler: async (ctx, args) =>
    await executePreparedRequest(
      ctx,
      await ctx.runMutation(prepareLockRef, args),
    ),
});

export const stateForClaim = internalQuery({
  args: { managedDeviceClaimId: v.id("managedDeviceClaims") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique(),
});

// ── Reconciler authorization derivation: the ONE place that decides whether
// a scholar can currently see a tile mapping to a given managed appKey — via
// ANY catalog app sharing that scheme, using the exact same `launcherShowsApp`
// rule `requireAuthorizedNativeTile` enforces on request. This is called
// fresh, in the SAME transaction, by prepareReconcileLock below — never
// cached or passed in by a caller — so a stale verdict can never leave a
// device unlocked past what a fresh unlock request would itself be refused
// for. ──────────────────────────────────────────────────────────────────────

// The per-key question is now one membership test against the generalized
// sets in lib/deviceAppProjection.ts, which answer for EVERY managed key at
// once using the identical predicates and sources.
//
// Granted-OR-PUSHED, deliberately, and for the same reason the launch gate
// (`requireAuthorizedNativeTile`) accepts both: this decides whether to
// force-close a lease, so it must ask the question a fresh request would be
// asked. If it asked only about grants, a scholar holding a live push card
// would have their lease relocked out from under a tap the launch gate would
// then happily re-authorize — a relock/re-unlock loop for the length of the
// focus, each iteration a real MDM PATCH.
//
// It also keeps this gate and the allowlist projection on the same predicate.
// They would not FIGHT if they disagreed — the ceremony's relock converges to
// the projected set, so a lease closed here still leaves a pushed app in the
// allowlist — but "the lease closed while the app stayed launchable" is an
// incoherent state to have to reason about, and nothing is bought by it.
async function isScholarAuthorizedForAppKey(
  ctx: DbCtx,
  scholarId: Id<"users">,
  appKey: AppKey,
): Promise<boolean> {
  if ((await grantedManagedAppKeysForScholar(ctx, scholarId)).has(appKey)) {
    return true;
  }
  return (await pushedManagedAppKeysForScholar(ctx, scholarId)).has(appKey);
}

/** The active-unlock reconciler's due-scan: every currently-unlocked device
 *  row that is due (or has never been recheck-stamped) for its periodic
 *  authorization recheck. `undefined` sorts before every real number in a
 *  Convex index, so this naturally includes never-stamped rows too — "absent
 *  = due immediately." Bounded per invocation; anything not reached stays
 *  durably due and is picked up by the very next tick. */
export const dueActiveUnlocks = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_desired_recheck", (q) =>
        q.eq("desiredState", "unlocked").lte("nextRecheckAt", args.nowMs),
      )
      .take(MAX_RECONCILE_BATCH),
});

// Shared "force to locked" patch fields — ONE place defines what "closing" a
// device's unlock means at the state layer, used by both the reconciler gate
// below and the pending-lock retry path.
function lockedStatePatch(nowMs: number) {
  return {
    desiredState: "locked" as const,
    appKey: undefined,
    expiresAt: undefined,
    idleSince: undefined,
    activeSessionFailsafeAt: undefined,
    // Due immediately, not durably reserved: the gate NEVER reserves a
    // long-running network token for the whole batch here. The actual PATCH
    // attempt (and its own fresh operationToken) is acquired immediately
    // before the network call, per row, by preparePendingLock in
    // reconcileActiveUnlocks's second phase — see that function's comment
    // for why a reserved-at-gate-time token can otherwise physically relock
    // a device a fresh, valid unlock has since re-armed.
    pendingLockRetryAt: nowMs,
    requestedAt: nowMs,
    mdmAcceptedAt: undefined,
    expectedAvailableAt: undefined,
    lockedAt: undefined,
    lastMdmError: undefined,
    operationToken: undefined,
    operationStartedAt: undefined,
  };
}

// ── The one authoritative gate: re-derive EVERY currently-unlocked device's
// authorization from scratch, in one transaction, and atomically transition
// to durable `locked` BEFORE any network call if it's no longer valid. No
// caller passes in a verdict — a mutation-site hook can only make this run
// sooner, never decide what it concludes. ─────────────────────────────────
export const prepareReconcileLock = internalMutation({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    nowMs: v.number(),
  },
  handler: async (ctx, args): Promise<ReconcileLockResult> => {
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    if (!state || state.desiredState !== "unlocked") {
      return { status: "not-applicable" };
    }

    // A CEREMONY operation is still within its mutual-exclusion lease —
    // acting on this row now could race it and record a patch under the wrong
    // token. Defer this row past the lease rather than skip it outright; the
    // very next scan can't miss it because nextRecheckAt is durably advanced,
    // not merely "not yet checked."
    //
    // A PROJECTION operation does NOT defer revocation. Closing access that
    // should be gone must never wait on a background convergence job, and the
    // gate's own work is a durable state patch rather than a network call, so
    // there is nothing to race. Taking the row marks it verify-needed, so the
    // preempted PATCH landing late is caught by the next projection pass.
    const holder = operationHolder(state, args.nowMs);
    if (holder === "ceremony") {
      await ctx.db.patch(state._id, {
        nextRecheckAt: state.operationStartedAt! + RECHECK_AFTER_INFLIGHT_MS,
      });
      return { status: "in-flight" };
    }
    const preemptedProjection = holder === "projection";

    const claim = await ctx.db.get(state.managedDeviceClaimId);
    const expired = state.expiresAt !== undefined && state.expiresAt <= args.nowMs;

    // "Fresh owner" is deliberately paranoid: EVERY direct/derived link in the
    // claim → scholar → institution → physical-device chain must still agree,
    // not just the generation counter. A stale reconcile task must never
    // mistake a departed owner's leftover row for a fresh one just because a
    // single field happened to still match.
    //
    // That chain now lives in `freshDeviceOwner` (lib/deviceAppProjection.ts)
    // and is shared VERBATIM with the allowlist projector, so the two can
    // never disagree about who a device belongs to. Nothing in it relaxed:
    // claim claimed + assigned, institution and serial matching the binding,
    // the scholar still existing as a SCHOLAR at that institution (an
    // institution transfer or a role change must lock regardless of a
    // surviving grant), and a CURRENT `pairedDevices` row proving the roster
    // binding this unlock was granted under is still live.
    //
    // This gate keeps ONE check the projector deliberately omits: the claim's
    // generation must still match the value stamped on this row at unlock
    // time. That is the "is this the same LEASE" question, and it is what
    // stops a stale reconcile task from closing a fresh owner's valid unlock.
    const generationMatches =
      !!claim &&
      claim.institutionId === state.institutionId &&
      (claim.claimGeneration ?? 0) === (state.claimGeneration ?? 0);
    const owner = generationMatches
      ? await freshDeviceOwner(ctx, {
          claim,
          binding: await ctx.db
            .query("deviceAppUnlockBindings")
            .withIndex("by_managed_device", (q) =>
              q.eq("managedDeviceClaimId", claim!._id),
            )
            .unique(),
        })
      : null;
    const freshOwner = owner !== null;
    const stillAuthorized =
      !expired &&
      freshOwner &&
      state.appKey !== undefined &&
      (await isScholarAuthorizedForAppKey(ctx, claim!.scholarId!, state.appKey));

    if (stillAuthorized) {
      await ctx.db.patch(state._id, {
        nextRecheckAt: args.nowMs + RECHECK_INTERVAL_MS,
        ...(preemptedProjection ? preemptProjectionPatch(state, args.nowMs) : {}),
      });
      return { status: "authorized" };
    }

    const binding = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    if (!binding) {
      // Nothing to physically relock (never had a dedicated profile bound,
      // or it was already torn down) — clear desiredState so this row stops
      // coming up as due at all rather than looping forever.
      await ctx.db.patch(state._id, {
        desiredState: "locked",
        appKey: undefined,
        nextRecheckAt: undefined,
      });
      return { status: "not-applicable" };
    }

    const revision = Math.max(args.nowMs, state.updatedAt + 1);
    const patch = {
      ...lockedStatePatch(args.nowMs),
      updatedAt: revision,
      ...(preemptedProjection ? preemptProjectionPatch(state, args.nowMs) : {}),
    };
    await ctx.db.patch(state._id, patch);
    return { status: "locked" };
  },
});


// A timeout may happen after the state is changed to locked but before
// SimpleMDM accepts the PATCH. Keep those rows eligible for the next cron tick;
// otherwise the safety backstop itself could leave an iPad unlocked forever.
export const pendingLocks = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_pending_lock_retry", (q) =>
        q
          .eq("desiredState", "locked")
          .eq("mdmAcceptedAt", undefined)
          .lte("pendingLockRetryAt", args.nowMs),
      )
      .take(MAX_RECONCILE_BATCH),
});

/**
 * Rows that still owe a teardown, reachable REGARDLESS of their lease and
 * acceptance flags.
 *
 * `pendingLocks` only matches a row that is locked AND unaccepted. A device
 * whose removal raced an in-flight write could land in a combination no
 * recovery scan matched — the binding surviving with the profile still holding
 * the removed scholar's apps, and nothing left to notice. Cleanup intent is a
 * durable promise, so it gets a scan that cannot be filtered out by any flag.
 */
export const cleanupIntents = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_cleanup_intent", (q) => q.eq("cleanupAfterLockIntent", true))
      .take(MAX_RECONCILE_BATCH),
});

/**
 * Force one cleanup-intent row back onto the pending-lock path.
 *
 * Only acts once nothing is in flight: a LIVE operation is still legitimately
 * working the profile and its own record path routes into teardown. An expired
 * token is an action that died, and the row is normalized on its behalf.
 */
export const normalizeCleanupIntent = internalMutation({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    // The SCAN's clock, not this mutation's. `pendingLocks` filters on
    // `pendingLockRetryAt <= nowMs` using the action's start time, so stamping
    // a fresh `Date.now()` here would land a millisecond PAST that cutoff and
    // push the teardown to the next tick every single time.
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    if (!state || !state.cleanupAfterLockIntent) return { normalized: false };
    const now = Date.now();
    if (operationHolder(state, now) !== null) return { normalized: false };
    // Already correctly parked for the pending-lock sweep — leave the retry
    // schedule alone rather than resetting its backoff on every tick.
    if (
      state.desiredState === "locked" &&
      state.mdmAcceptedAt === undefined &&
      state.pendingLockRetryAt !== undefined
    ) {
      return { normalized: false };
    }
    await ctx.db.patch(state._id, {
      desiredState: "locked",
      appKey: undefined,
      expiresAt: undefined,
      idleSince: undefined,
      activeSessionFailsafeAt: undefined,
      activeLeaseToken: undefined,
      mdmAcceptedAt: undefined,
      expectedAvailableAt: undefined,
      lockedAt: undefined,
      pendingLockRetryAt: args.nowMs,
      updatedAt: Math.max(now, state.updatedAt + 1),
      operationToken: undefined,
      operationStartedAt: undefined,
      tokenKind: undefined,
      ...uncertainProjectionWrite(state, state.operationStartedAt ?? now),
    });
    return { normalized: true };
  },
});

export const preparePendingLock = internalMutation({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    if (
      !state ||
      state.desiredState !== "locked" ||
      state.updatedAt !== args.expectedRevision ||
      state.mdmAcceptedAt !== undefined
    ) {
      return null;
    }
    const binding = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    if (!binding) {
      // No binding at all is not actionable — a stale operationToken lease
      // check below (state.operationToken set) would still self-heal via
      // its own advance, but a MISSING binding never will (nothing here
      // will ever create one). Left un-advanced, this row would flunk
      // preparePendingLock on every drain tick forever, keeping the batch
      // permanently "full" and hot-looping the self-continuation. Back off
      // by the same operation timeout window so it still gets periodically
      // retried (in case a binding shows up later) without starving other
      // rows in the meantime.
      await ctx.db.patch(state._id, {
        pendingLockRetryAt: Date.now() + OPERATION_TIMEOUT_MS,
      });
      return null;
    }
    const pendingNow = Date.now();
    const holder = operationHolder(state, pendingNow);
    if (holder === "ceremony") {
      // Someone else's CEREMONY operation is already in flight for this row (a
      // concurrent invocation, or this same batch racing itself). Returning
      // null here WITHOUT moving `pendingLockRetryAt` would leave the row
      // immediately due again on the very next scan — with a full 25-row
      // page all in-flight, every drain tick would reread the identical
      // rows, make zero progress, and never reach anything past them
      // (starvation), while `pendingScanWasFull` keeps forcing an immediate
      // self-continuation (hot loop). Advance the retry time to when the
      // existing lease is due to expire (+ operation token/revision
      // untouched — this is not our lease to acquire or fail) so the row
      // naturally drops off this scan until that lease either completes
      // (recordMdmPatch clears it) or times out.
      await ctx.db.patch(state._id, {
        pendingLockRetryAt: state.operationStartedAt! + OPERATION_TIMEOUT_MS,
      });
      return null;
    }
    // A PROJECTION token is preempted rather than waited on — an owed relock
    // outranks background convergence, and both target the same set anyway.
    const preemptedProjection = holder === "projection";
    const operationToken = crypto.randomUUID();
    const now = Date.now();
    // "Relock" converges to the PROJECTION, not to bare baseline — the whole
    // point of the inversion. Derived in THIS transaction, immediately before
    // the token is handed out, so the set that gets sent is the set that was
    // true when the operation was claimed. `state` is passed so a row whose
    // lease is somehow still live keeps its app (the composition rule); a
    // gate-locked row has already had its lease cleared, so this is baseline
    // ∪ whatever the scholar is currently granted-or-pushed.
    const claim = await ctx.db.get(args.managedDeviceClaimId);
    const bundleIds = await projectedBundleIdsForClaim(ctx, {
      claim,
      binding,
      state,
      baseline: validateBaseline(binding.baselineBundleIds),
      nowMs: now,
    });
    await ctx.db.patch(state._id, {
      operationToken,
      operationStartedAt: now,
      tokenKind: "ceremony" as const,
      pendingLockRetryAt: now + OPERATION_TIMEOUT_MS,
      desiredBundleIds: bundleIds,
      ...(preemptedProjection ? preemptProjectionPatch(state, pendingNow) : {}),
    });
    return { binding, revision: state.updatedAt, operationToken, bundleIds };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// The PROJECTOR. The relock gate above is the LEASE model's authority; this
// is the GRANT model's. They share one profile, one operation-token lease,
// and one target set (lib/deviceAppProjection.ts § composition rule), and
// they run in the same bounded, Phase-1-durable/Phase-2-network reconciler
// invocation below.
// ─────────────────────────────────────────────────────────────────────────

/**
 * What one projection candidate did this pass. The distinction the action
 * needs is PROGRESS vs STALL: a `token-deferred` row deliberately keeps its
 * dirty mark (so a revoke during a held token converges the moment the token
 * clears), which means it stays due — so a page made entirely of them would
 * re-trigger the self-continuation immediately, forever, while nothing moved
 * and every device behind the first page starved.
 */
type ProjectionPrepareResult =
  | {
      status: "prepared";
      binding: Doc<"deviceAppUnlockBindings">;
      revision: number;
      operationToken: string;
      bundleIds: string[];
      mode: "patch" | "verify";
    }
  | { status: "token-deferred"; retryAt: number }
  | { status: "settled" };

type ProjectionCandidate = {
  managedDeviceClaimId: Id<"managedDeviceClaims">;
  dueAt: number;
};

/**
 * Every BOUND device whose projection is due, most-due first.
 *
 * The scan enumerates `deviceAppUnlockBindings` rather than an index over
 * `deviceAppUnlockStates`, because a device that has never run the ceremony
 * has no state row at all and would otherwise be invisible to the projector
 * forever — which is exactly the class of bug the inversion exists to kill
 * (the 2026-08-31 incident was one binding against ten devices). One row per
 * physically provisioned iPad makes that enumeration fleet-sized; see
 * MAX_BINDINGS_ENUMERATED for the ceiling and what to do if it is ever hit.
 *
 * Ordering by due time is what guarantees progress: even with more bound
 * devices than one tick's cap, the least-recently-projected device is always
 * next, so nothing starves.
 */
export const projectionCandidates = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args): Promise<ProjectionCandidate[]> => {
    const bindings = await ctx.db
      .query("deviceAppUnlockBindings")
      .take(MAX_BINDINGS_ENUMERATED);
    const due: ProjectionCandidate[] = [];
    for (const binding of bindings) {
      const state = await ctx.db
        .query("deviceAppUnlockStates")
        .withIndex("by_managed_device", (q) =>
          q.eq("managedDeviceClaimId", binding.managedDeviceClaimId),
        )
        .unique();
      // A device mid-teardown belongs to `removeManagedDevice`'s deferred
      // cleanup, not to the projector: its row and binding are about to be
      // deleted once the final baseline PATCH lands.
      if (state?.cleanupAfterLockIntent) continue;
      const dueAt = state?.projectionDueAt ?? 0;
      if (dueAt > args.nowMs) continue;
      due.push({ managedDeviceClaimId: binding.managedDeviceClaimId, dueAt });
    }
    due.sort((a, b) => a.dueAt - b.dueAt);
    return due.slice(0, MAX_PROJECTION_BATCH);
  },
});

/**
 * Keep the EARLIER of a row's existing due time and a proposed one.
 *
 * A mutation-site hook that fires while a PATCH is in flight marks the row
 * dirty by stamping `projectionDueAt: 0`. If the record path then wrote its
 * own `now + interval` unconditionally, that dirty mark would be erased by the
 * very operation it was racing, and the grant change that set it would wait a
 * full interval. Only a mark set at or before this operation began is honored,
 * so the acquisition backstop this function also sees is not mistaken for one.
 */
function preservedProjectionDueAt(
  state: Doc<"deviceAppUnlockStates">,
  proposed: number,
): number {
  const existing = state.projectionDueAt;
  const operationStart = state.operationStartedAt ?? Number.MAX_SAFE_INTEGER;
  if (existing !== undefined && existing <= operationStart && existing < proposed) {
    return existing;
  }
  return proposed;
}

/** Is this row's stored `appliedBundleIds` currently trustworthy enough to
 *  skip a PATCH on? See the schema comment on `projectionVerifiedAt`: the
 *  stored value is a hint, and only a recent LIVE read makes it usable as a
 *  drift baseline. */
function projectionTrustIsFresh(
  state: Doc<"deviceAppUnlockStates">,
  nowMs: number,
): boolean {
  if (state.projectionVerifyNeeded === true) return false;
  if (state.appliedBundleIds === undefined) return false;
  if (state.projectionVerifiedAt === undefined) return false;
  return state.projectionVerifiedAt + PROJECTION_VERIFY_INTERVAL_MS > nowMs;
}

/**
 * Acquire the right to converge one device's allowlist.
 *
 * Returns `mode: "verify"` when the stored hint may not be trusted — the
 * action must then read the LIVE profile and PATCH only if it actually
 * differs. Returns `mode: "patch"` when a trusted hint already proves drift.
 * Returns null when a trusted hint proves there is nothing to do, or when the
 * row was deferred.
 *
 * Every skip path DURABLY advances `projectionDueAt` before returning null.
 * That is load-bearing: the scan is ordered by due time and the action
 * self-continues whenever a scan comes back full, so a row that could be
 * skipped without moving would be re-read on every continuation forever (the
 * same starvation/hot-loop hazard `preparePendingLock` documents). The single
 * exception is a row that vanished between the scan and here — there is
 * nothing to advance, and it is recreated on the next pass, so it cannot spin
 * either.
 *
 * The clock is read HERE, not taken from the action's start. Phase 2 can spend
 * minutes on real MDM calls before this runs, and stamping `operationStartedAt`
 * with a stale timestamp would mint a token that is already expired — instantly
 * preemptible, and invisible as an in-flight operation. The same fresh reading
 * drives push and lease liveness, so a focus that closed during phase 2 is not
 * projected as still open.
 */
export const prepareProjectionPatch = internalMutation({
  args: { managedDeviceClaimId: v.id("managedDeviceClaims") },
  handler: async (
    ctx,
    args,
  ): Promise<ProjectionPrepareResult> => {
    const now = Date.now();
    const binding = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    let existing = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();

    // Nothing to project through — this device's launches are not
    // unlock-mediated (the fleet's group-profile case). Back off rather than
    // spin; a binding appearing later is picked up by the enumeration scan.
    if (!binding) {
      if (existing) {
        await ctx.db.patch(existing._id, {
          projectionDueAt: now + OPERATION_TIMEOUT_MS,
        });
      }
      return { status: "settled" };
    }

    if (existing) {
      const row = existing;
      const defer = async (untilMs: number): Promise<ProjectionPrepareResult> => {
        await ctx.db.patch(row._id, { projectionDueAt: untilMs });
        return { status: "settled" };
      };
      // A device mid-teardown belongs to `removeManagedDevice`'s deferred
      // cleanup, which drives the profile back to baseline and then deletes
      // both rows. The projector must not compete with it.
      if (existing.cleanupAfterLockIntent) {
        return await defer(now + OPERATION_TIMEOUT_MS);
      }
      // An owed relock belongs to the pending-lock backstop, which applies the
      // SAME projected set. Two writers must not both claim it.
      if (existing.desiredState === "locked" && existing.mdmAcceptedAt === undefined) {
        return await defer(now + OPERATION_TIMEOUT_MS);
      }
      // Mutual exclusion: one whole-profile PATCH per dedicated profile. The
      // projector always yields — it never preempts the ceremony, and a second
      // projection operation would only race itself.
      if (operationHolder(existing, now) !== null) {
        // Preserve an earlier dirty mark: a hook that fired while this token
        // was held must not be pushed out to the lease expiry, or a revocation
        // during a held token would wait for the next cron instead of
        // converging on the pass right after the token clears.
        // Reported as a STALL, not as work. This path deliberately preserves
        // an earlier dirty mark (a revoke during a held token must converge on
        // the pass right after release, not a cron later) — which means the
        // row stays due, and a page full of these would otherwise re-trigger
        // the self-continuation forever without anything moving.
        const tokenExpiresAt = existing.operationStartedAt! + OPERATION_TIMEOUT_MS;
        await ctx.db.patch(row._id, {
          projectionDueAt: preservedProjectionDueAt(existing, tokenExpiresAt),
        });
        return { status: "token-deferred", retryAt: tokenExpiresAt };
      }
      // An EXPIRED token is the fingerprint of an action that died without
      // recording — its write may or may not have reached SimpleMDM, and
      // nothing ever stamped the uncertainty. Clear it and distrust the stored
      // hint before deciding anything, so this row cannot take the
      // trusted-no-drift early return on the strength of a value no one can
      // vouch for.
      if (existing.operationToken !== undefined) {
        await ctx.db.patch(existing._id, {
          operationToken: undefined,
          operationStartedAt: undefined,
          tokenKind: undefined,
          ...uncertainProjectionWrite(existing, existing.operationStartedAt ?? now),
        });
        // Re-read: every decision below turns on the freshness fields that
        // patch just changed, and a stale in-memory copy would let this row
        // take the trusted early return it was just disqualified from.
        existing = await ctx.db
          .query("deviceAppUnlockStates")
          .withIndex("by_managed_device", (q) =>
            q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
          )
          .unique();
      }
    }

    const claim = await ctx.db.get(args.managedDeviceClaimId);
    const desired = await projectedBundleIdsForClaim(ctx, {
      claim,
      binding,
      state: existing ?? null,
      baseline: validateBaseline(binding.baselineBundleIds),
      nowMs: now,
    });

    // A trusted hint may prove there is nothing to do. An untrusted one may
    // not: it is only a record of what a writer BELIEVED landed, and the whole
    // reason this path exists is that a late-landing stale PATCH can make that
    // belief wrong in the widening direction. When trust is stale or destroyed,
    // the action reads the live profile instead of skipping.
    const trusted = existing !== null && projectionTrustIsFresh(existing, now);
    if (existing && trusted && !projectionHasDrifted(desired, existing.appliedBundleIds)) {
      // Converged. This OVERWRITES the due time rather than preserving an
      // earlier one, and that difference is load-bearing.
      //
      // No operation was acquired on this path, so there is no in-flight write
      // for a concurrent hook's dirty mark to be racing — and this whole
      // decision (freshness check, derivation, diff) happened inside THIS
      // transaction. A hook that stamps `projectionDueAt: 0` serializes
      // against it under OCC: either it lands first and this transaction reads
      // the dirtied row (so `desired` already reflects the change that dirtied
      // it), or it lands after and its mark survives untouched. Preserving the
      // earlier value here instead would be catastrophic rather than merely
      // conservative: `preservedProjectionDueAt` treats an absent
      // `operationStartedAt` as MAX_SAFE_INTEGER, so it would preserve the
      // ALREADY-ELAPSED due time every time, leaving every converged row
      // permanently due — and, past MAX_PROJECTION_BATCH devices, spinning the
      // self-continuation on an identical full page forever while starving
      // every device behind it.
      await ctx.db.patch(existing._id, {
        desiredBundleIds: desired,
        projectionError: undefined,
        projectionDueAt: now + PROJECTION_INTERVAL_MS,
      });
      return { status: "settled" };
    }
    const mode: "patch" | "verify" = trusted ? "patch" : "verify";

    const operationToken = crypto.randomUUID();
    const acquisition = {
      operationToken,
      operationStartedAt: now,
      tokenKind: "projection" as const,
      desiredBundleIds: desired,
      // Held only until this operation's own lease window closes, so a lost
      // action result cannot park the device un-projected indefinitely.
      projectionDueAt: now + OPERATION_TIMEOUT_MS,
    };
    if (existing) {
      const revision = Math.max(now, existing.updatedAt + 1);
      await ctx.db.patch(existing._id, { ...acquisition, updatedAt: revision });
      return {
        status: "prepared",
        binding,
        revision,
        operationToken,
        bundleIds: desired,
        mode,
      };
    }

    // FIRST projection of a device that has never run the ceremony: the state
    // row is created HERE, lazily, at the moment it is needed to hold this
    // operation token — never pre-created by a scan.
    //
    // It is created as a SETTLED LOCKED row, which is NOT byte-identical to
    // the absent row it replaces. Two observable differences, both bounded and
    // both safe:
    //
    //   1. `statusFor` reports the same `desiredState: "locked"` and
    //      `availability: "locked"`, but `mdmAcceptedAt` goes from null to a
    //      timestamp. The shipped client keys on `availability` (see
    //      `decideUnlockEntry` in native/src/lib/asam/appUnlockPolicy.ts) and
    //      never branches on that field.
    //   2. `requestLock` can now take its `sameLock` shortcut and return
    //      idempotent without a PATCH, where a missing row always PATCHed.
    //      That shortcut is gated on TRUSTED projection state, so it cannot
    //      fire until a live read has proven the profile already holds the
    //      projected set — at which point "nothing to do" is the honest
    //      answer, not a skipped convergence.
    //
    // `mdmAcceptedAt` here is a statement about the LEASE (there is none, and
    // that is settled), never about the allowlist: every allowlist claim lives
    // in the projection fields, which start absent and therefore untrusted.
    //
    // `requestedBy` records the operator who configured the dedicated profile;
    // nothing here was requested by a scholar.
    const revision = now;
    await ctx.db.insert("deviceAppUnlockStates", {
      institutionId: binding.institutionId,
      managedDeviceClaimId: args.managedDeviceClaimId,
      desiredState: "locked",
      updatedAt: revision,
      requestedAt: now,
      requestedBy: binding.configuredBy,
      mdmAcceptedAt: now,
      lockedAt: now,
      ...acquisition,
    });
    return {
      status: "prepared",
      binding,
      revision,
      operationToken,
      bundleIds: desired,
      mode,
    };
  },
});

/**
 * Record the outcome of a projection PATCH.
 *
 * The projection NEVER writes the lease fields — not `desiredState`, not
 * `appKey`, not `expiresAt`, not `mdmAcceptedAt`, and above all not
 * `lastMdmError`. `statusFor` reads only those, so a background projection
 * failure can never surface to the live iPad client as a failed unlock, and a
 * projection PATCH can never close a scholar's open lease. That separation is
 * the whole reason `projectionError` is its own field.
 */
export const recordProjectionPatch = internalMutation({
  args: {
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    revision: v.number(),
    operationToken: v.string(),
    accepted: v.boolean(),
    // What the LIVE profile is proven to hold now. Present only when this
    // operation actually read or wrote it.
    liveBundleIds: v.optional(v.array(v.string())),
    // Did this operation READ the live allowlist (rather than only write one)?
    // Only a live read may clear an outstanding verify barrier.
    verifiedByLiveRead: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", args.managedDeviceClaimId),
      )
      .unique();
    if (!state) return { recorded: false };
    const now = Date.now();

    // TEARDOWN FIRST, unconditionally. `removeManagedDevice` may have stamped
    // cleanup intent while this write was in flight, and that outranks every
    // other outcome here — including a FAILED one. Handling failure first was
    // a real stranding path: it cleared the token but left `mdmAcceptedAt`
    // set, a combination that matches neither `pendingLocks` (which requires
    // an unaccepted row) nor `projectionCandidates` (which skips cleanup
    // rows), so the binding survived with the profile still holding the
    // removed scholar's apps and nothing left to notice.
    //
    // Whatever happened to our PATCH, the row is driven back into the
    // pending-lock path so the existing teardown machinery — baseline PATCH,
    // then `recordMdmPatch` deleting row and binding together — finishes the
    // job. Trust is destroyed either way, because a write we cannot vouch for
    // may still land on a profile we are about to hand back.
    if (state.cleanupAfterLockIntent) {
      await ctx.db.patch(state._id, {
        desiredState: "locked",
        appKey: undefined,
        expiresAt: undefined,
        idleSince: undefined,
        activeSessionFailsafeAt: undefined,
        activeLeaseToken: undefined,
        mdmAcceptedAt: undefined,
        expectedAvailableAt: undefined,
        lockedAt: undefined,
        pendingLockRetryAt: now,
        updatedAt: Math.max(now, state.updatedAt + 1),
        operationToken: undefined,
        operationStartedAt: undefined,
        tokenKind: undefined,
        ...uncertainProjectionWrite(state, state.operationStartedAt ?? now),
      });
      return { recorded: true };
    }

    // TOKEN LOST. Another writer took this row — a ceremony request, the
    // revocation gate, or a device teardown — while our PATCH was in flight.
    // We cannot prove what the profile now holds (our write may still land
    // after theirs), so we record NOTHING except the one fact we do know: the
    // stored hint can no longer be trusted, and the next pass must read live.
    // Stamping applied state here is exactly how a resurrected, revoked app
    // would be hidden forever.
    if (
      state.updatedAt !== args.revision ||
      state.operationToken !== args.operationToken
    ) {
      await ctx.db.patch(state._id, {
        ...uncertainProjectionWrite(state, now),
        projectionDueAt: preservedProjectionDueAt(state, now),
      });
      return { recorded: false };
    }

    if (!args.accepted) {
      // A PATCH that timed out may still reach SimpleMDM later, so nothing is
      // claimed about the profile's contents and the hint is invalidated
      // BEHIND A BARRIER — no later success may clear it until that write's
      // landing window has closed. The operation LEASE is released rather than
      // held: holding it would block a scholar's tap behind an invisible
      // background failure, and the ceremony preempts a projection token
      // anyway. The PROJECTOR still backs off past its own window so two of
      // its writes cannot be in flight together.
      await ctx.db.patch(state._id, {
        projectionError: "request-failed",
        ...uncertainProjectionWrite(state, state.operationStartedAt ?? now),
        projectionDueAt: preservedProjectionDueAt(
          state,
          (state.operationStartedAt ?? now) + OPERATION_TIMEOUT_MS,
        ),
        operationToken: undefined,
        operationStartedAt: undefined,
        tokenKind: undefined,
      });
      return { recorded: true };
    }

    const live = args.liveBundleIds ?? [];
    await ctx.db.patch(state._id, {
      appliedBundleIds: live,
      projectionAppliedAt: now,
      // Whether this may be TRUSTED is not ours to assert: a live read clears
      // the flag only once every outstanding uncertain write has passed its
      // landing window. Until then the row keeps re-reading and re-correcting
      // on each pass, which is the safe direction.
      ...resolveProjectionTrust({
        now,
        barrierAt: state.projectionVerifyBarrierAt,
        verifiedByLiveRead: args.verifiedByLiveRead === true,
      }),
      projectionError: undefined,
      projectionDueAt: preservedProjectionDueAt(state, now + PROJECTION_INTERVAL_MS),
      operationToken: undefined,
      operationStartedAt: undefined,
      tokenKind: undefined,
    });
    return { recorded: true };
  },
});

const cleanupIntentsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  Doc<"deviceAppUnlockStates">[]
>("deviceAppUnlock:cleanupIntents");
const normalizeCleanupIntentRef = makeFunctionReference<
  "mutation",
  { managedDeviceClaimId: Id<"managedDeviceClaims">; nowMs: number },
  { normalized: boolean }
>("deviceAppUnlock:normalizeCleanupIntent");
const projectionCandidatesRef = makeFunctionReference<
  "query",
  { nowMs: number },
  ProjectionCandidate[]
>("deviceAppUnlock:projectionCandidates");
const prepareProjectionPatchRef = makeFunctionReference<
  "mutation",
  { managedDeviceClaimId: Id<"managedDeviceClaims"> },
  ProjectionPrepareResult
>("deviceAppUnlock:prepareProjectionPatch");
const recordProjectionPatchRef = makeFunctionReference<
  "mutation",
  {
    managedDeviceClaimId: Id<"managedDeviceClaims">;
    revision: number;
    operationToken: string;
    accepted: boolean;
    liveBundleIds?: string[];
    verifiedByLiveRead?: boolean;
  },
  { recorded: boolean }
>("deviceAppUnlock:recordProjectionPatch");

/**
 * The cold-path nudge: "I just tapped a tile — converge my iPad now."
 *
 * Latency only, and additive. It decides nothing, grants nothing, and takes
 * no app argument (the server owns app identity; the client stops asking for
 * a specific one under the inversion). An unconfigured iPad answers
 * `{ nudged: false }` rather than throwing, keeping the same fail-open
 * posture `status` reports as `not-configured`.
 */
export const nudgeProjection = authedMutation({
  args: { deviceId: v.string() },
  handler: async (ctx, args) => {
    await assertNotImpersonating(ctx);
    const { claim, binding } = await resolveClaimedDevice(
      ctx,
      ctx.user,
      args.deviceId,
    );
    if (!binding) return { nudged: false };
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", claim._id),
      )
      .unique();
    if (state) await ctx.db.patch(state._id, { projectionDueAt: 0 });
    await ctx.scheduler.runAfter(0, reconcileActiveUnlocksRef, {});
    return { nudged: true };
  },
});

export const reconcileActiveUnlocks = internalAction({
  args: { nowMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();

    // Phase 1 — durable-before-network: gate-check every due row FIRST. Each
    // call is a pure DB mutation (no MDM call, no reserved network token —
    // see lockedStatePatch), so this phase can safely run to completion for
    // the whole (cheaply bounded) batch before this invocation risks any
    // network work at all. A row the gate locks is already durably `locked`
    // + immediately due (`pendingLockRetryAt: nowMs`) the instant this loop
    // touches it — nothing below can leave it in limbo.
    const due = await ctx.runQuery(dueActiveUnlocksRef, { nowMs });
    let authorized = 0;
    for (const row of due) {
      const result = await ctx.runMutation(prepareReconcileLockRef, {
        managedDeviceClaimId: row.managedDeviceClaimId,
        nowMs,
      });
      if (result.status === "authorized") authorized += 1;
      // "locked": the gate durably transitioned the row and made it
      // immediately due — it is picked up by the pendingLocks scan below,
      // in THIS SAME invocation, rather than tracked in any local list here.
      // "not-applicable" / "in-flight": the gate itself already durably
      // advanced nextRecheckAt — nothing left for this invocation to do.
    }

    // Phase 1b — enumerate every BOUND device whose projection is due. A
    // device provisioned with a dedicated profile but never run through the
    // ceremony has no state row at all; scanning BINDINGS rather than state
    // rows is what makes it visible, which is the exact shape of the incident
    // this inversion answers. Its row is created lazily, by
    // `prepareProjectionPatch`, at the moment one is needed to hold an
    // operation token — never pre-created here.
    const projectionDue = await ctx.runQuery(projectionCandidatesRef, { nowMs });

    // Phase 1c — durable, DB-only: force any row that still owes a teardown
    // back onto the pending-lock path BEFORE phase 2 scans it, so a device
    // whose removal raced an in-flight write finishes its teardown on this
    // same tick rather than needing a flag combination the other scans happen
    // to match.
    for (const row of await ctx.runQuery(cleanupIntentsRef, {})) {
      await ctx.runMutation(normalizeCleanupIntentRef, {
        managedDeviceClaimId: row.managedDeviceClaimId,
        nowMs,
      });
    }

    // Phase 2 — the only place a network call happens. This is the SAME
    // pendingLocks-driven backstop that already existed for
    // crash/timeout recovery, and it is now ALSO the exclusive path a
    // freshly-gated row takes to get physically PATCHed. Critically,
    // preparePendingLock re-reads desiredState/mdmAcceptedAt/updatedAt FRESH
    // and acquires its OWN operationToken immediately before each PATCH,
    // rather than reusing a token the gate reserved back in Phase 1 for the
    // whole batch. That is what prevents a stale, long-since-superseded PATCH
    // from physically relocking a device: if a fresh valid unlock re-armed
    // this row between Phase 1 and this loop reaching it, `preparePendingLock`
    // sees `desiredState !== "locked"` (or a changed `updatedAt`) and returns
    // null, so this row is silently skipped rather than patched.
    let networkBudget = MAX_REVOCATION_BATCH;
    let locked = 0;
    let failed = 0;
    const pending = await ctx.runQuery(pendingLocksRef, { nowMs });
    let pendingExhaustedBudget = false;
    for (const row of pending) {
      if (networkBudget <= 0) {
        pendingExhaustedBudget = true;
        break;
      }
      const prepared = await ctx.runMutation(preparePendingLockRef, {
        managedDeviceClaimId: row.managedDeviceClaimId,
        expectedRevision: row.updatedAt,
      });
      if (!prepared) continue;
      networkBudget -= 1;
      try {
        // The relock target is the PROJECTED set, derived by
        // preparePendingLock in the same transaction that handed out this
        // operation token — not bare baseline. Converging a device therefore
        // never strips the apps its scholar is standing-granted.
        await patchProfile(apiKey(), prepared.binding, prepared.bundleIds);
        await ctx.runMutation(recordMdmPatchRef, {
          managedDeviceClaimId: row.managedDeviceClaimId,
          revision: prepared.revision,
          operationToken: prepared.operationToken,
          accepted: true,
          appliedBundleIds: prepared.bundleIds,
        });
        locked += 1;
      } catch {
        await ctx.runMutation(recordMdmPatchRef, {
          managedDeviceClaimId: row.managedDeviceClaimId,
          revision: prepared.revision,
          operationToken: prepared.operationToken,
          accepted: false,
        });
        failed += 1;
      }
    }

    // Phase 3 — the projector's own network phase, sharing Phase 2's budget
    // so one invocation can never exceed MAX_REVOCATION_BATCH real MDM
    // attempts in total.
    //
    // Revocation runs FIRST for a reason beyond priority. The projected set
    // carries a device's LIVE lease as a superset member (the composition
    // rule), so a revoked app would linger in the projection for exactly as
    // long as its lease row still claims to be unlocked. Phase 1's gate is
    // what clears that claim, and it has already run — durably — by the time
    // anything here derives a set. A revoke hook additionally stamps the row
    // due immediately, so the gate reaches it on the very same invocation.
    // Absent any hook, the bound is unchanged from before: one cron interval.
    let projected = 0;
    let projectionFailed = 0;
    let projectionExhaustedBudget = false;
    // Did ANY candidate move this pass? Only a stall — every candidate waiting
    // on somebody else's token — earns the backed-off continuation below.
    let projectionProgressed = false;
    let earliestTokenRetryAt = Number.MAX_SAFE_INTEGER;
    for (const candidate of projectionDue) {
      if (networkBudget <= 0) {
        projectionExhaustedBudget = true;
        break;
      }
      const prepared = await ctx.runMutation(prepareProjectionPatchRef, {
        managedDeviceClaimId: candidate.managedDeviceClaimId,
      });
      if (prepared.status === "token-deferred") {
        // Another writer owns this profile right now. Nothing moved, and the
        // row keeps its dirty mark on purpose — so this must NOT count as
        // progress for the self-continuation decision below.
        earliestTokenRetryAt = Math.min(earliestTokenRetryAt, prepared.retryAt);
        continue;
      }
      if (prepared.status === "settled") {
        // A trusted hint proved no drift, or the row was durably deferred past
        // something — either way `prepareProjectionPatch` advanced its due time,
        // so the page shrinks and the scan makes progress.
        projectionProgressed = true;
        continue;
      }
      projectionProgressed = true;
      networkBudget -= 1;
      try {
        // "verify" means the stored hint may not be trusted, so the LIVE
        // profile decides: `verifyAndApplyProfile` reads it through the same
        // safety core and PATCHes only if it actually differs. That is what
        // catches a stale write that landed late and resurrected a revoked
        // app — the case a stored-hint comparison structurally cannot see.
        // "patch" means a trusted hint already proved drift, so go straight to
        // the write (which still reads the profile to build it).
        let live = prepared.bundleIds;
        if (prepared.mode === "verify") {
          const result = await verifyAndApplyProfile(
            apiKey(),
            prepared.binding,
            prepared.bundleIds,
          );
          live = result.liveBundleIds;
          if (result.patched) projected += 1;
        } else {
          await patchProfile(apiKey(), prepared.binding, prepared.bundleIds);
          projected += 1;
        }
        await ctx.runMutation(recordProjectionPatchRef, {
          managedDeviceClaimId: candidate.managedDeviceClaimId,
          revision: prepared.revision,
          operationToken: prepared.operationToken,
          accepted: true,
          liveBundleIds: live,
          // Both branches read the live profile before writing it (see
          // `readLiveProfile`), so either is a genuine verification — the
          // barrier, not the branch, decides whether it may clear the flag.
          verifiedByLiveRead: true,
        });
      } catch {
        await ctx.runMutation(recordProjectionPatchRef, {
          managedDeviceClaimId: candidate.managedDeviceClaimId,
          revision: prepared.revision,
          operationToken: prepared.operationToken,
          accepted: false,
        });
        projectionFailed += 1;
      }
    }

    // Self-drain (Finding 5): a single invocation is deliberately bounded
    // (MAX_RECONCILE_BATCH due-scan rows, MAX_REVOCATION_BATCH network
    // attempts) so it can never overrun an action's time/rate budget. But a
    // large backlog (e.g. a school-wide revoke touching 100+ devices) must
    // not wait for the next 5-minute cron tick to keep draining — that could
    // take well over an hour. Whenever either scan came back FULL (more due
    // rows may exist beyond this page) or the network budget ran out before
    // the pending scan was exhausted, immediately reschedule this SAME action
    // with NO arguments: it re-queries `dueActiveUnlocks`/`pendingLocks`
    // fresh next time, carrying no auth/claim snapshot or id list forward.
    // Termination is guaranteed by recordMdmPatch's failure path (deviceApp
    // Unlock.ts): a failed PATCH moves `pendingLockRetryAt` into the FUTURE
    // (backoff), which drops that row out of `pendingLocks`'s
    // `pendingLockRetryAt <= nowMs` filter — so once only backed-off rows
    // remain, this self-continuation naturally stops re-triggering itself
    // and the row waits for the next real cron tick (or another retry) like
    // before. A row that keeps succeeding drains away entirely, which also
    // stops the loop.
    //
    // The projection phase self-drains on exactly the same terms. Its
    // termination argument is the mirror of the one above: EVERY path out of
    // `prepareProjectionPatch` — converged, deferred, unbound, mid-teardown —
    // durably moves `projectionDueAt` into the future before returning, and
    // `recordProjectionPatch` moves it on both success and failure. So once a
    // continuation finds nothing left that is genuinely due, the scan comes
    // back short and the loop stops.
    const dueScanWasFull = due.length >= MAX_RECONCILE_BATCH;
    const pendingScanWasFull = pending.length >= MAX_RECONCILE_BATCH;
    const projectionScanWasFull = projectionDue.length >= MAX_PROJECTION_BATCH;
    const needsContinuation =
      dueScanWasFull ||
      pendingScanWasFull ||
      pendingExhaustedBudget ||
      projectionScanWasFull ||
      projectionExhaustedBudget;
    if (needsContinuation) {
      // A continuation must be able to accomplish something. If the ONLY
      // reason to continue is a full projection page, and not one candidate on
      // it moved because every row was waiting on another writer's operation
      // token, then continuing immediately re-reads the identical page and
      // spins — starving every device behind it until a token happens to
      // settle. Wait for the earliest of those tokens instead, bounded so a
      // clock skew or a wedged lease cannot stall convergence either.
      const projectionStalled =
        projectionScanWasFull &&
        !projectionProgressed &&
        !dueScanWasFull &&
        !pendingScanWasFull &&
        !pendingExhaustedBudget &&
        !projectionExhaustedBudget;
      const delayMs = projectionStalled
        ? Math.min(
            Math.max(earliestTokenRetryAt - nowMs, PROJECTION_STALL_BACKOFF_MIN_MS),
            PROJECTION_STALL_BACKOFF_MAX_MS,
          )
        : 0;
      await ctx.scheduler.runAfter(delayMs, reconcileActiveUnlocksRef, {});
    }

    return {
      considered: due.length,
      locked,
      authorized,
      failed,
      projected,
      projectionFailed,
    };
  },
});
