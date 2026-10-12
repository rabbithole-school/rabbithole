/**
 * SimpleMDM claim delivery for a primary institution's physical iPad fleet.
 *
 * This integration is intentionally first-party-only: the API key controls one
 * institution's SimpleMDM tenant. Other institutions get a legible refusal
 * until they have a real tenant and contract of their own.
 */
import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assertCanWrite,
  requireUser,
  assertWritableAction,
} from "./lib/auth";
import { primaryInstitutionId } from "./institutions";
import {
  auditManagedClaim,
  stageClaimReplacementForSimpleMdm,
} from "./managedDeviceClaims";
import { ROLES, isPlatformAdminRole } from "./lib/roles";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import { sha256Hex } from "./lib/oauthCrypto";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import {
  dayKeyForTimezone,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { isClosedDay } from "../shared/schoolClosures";
import { deviceBatteryBand } from "../shared/deviceBattery";
import { raiseAlert } from "./alerts";
import { siteUrl, withBase } from "./lib/channels";
import { escapeSlackText } from "./lib/slackApi";
import {
  hasAnySchoolOperationsAccess,
  hasSchoolOperationsAccessAtInstitution,
} from "./lib/staffCapabilities";
import {
  SimpleMdmApiError,
  fetchInstalledAppBundleIds,
  fetchSimpleMdmDevice,
  findSimpleMdmDeviceBySerial,
  isEnrolledSimpleMdmStatus,
  isSimpleMdmNotFound,
  listSimpleMdmDevices,
  normalizeSerial,
  simpleMdmErrorMessage,
  simpleMdmJson,
  simpleMdmRequest,
  type SimpleMdmDeviceDetails,
} from "./lib/simpleMdmClient";
import {
  snapshotForInstitutionSerial,
  upsertSimpleMdmSnapshot,
  type SimpleMdmSnapshotPatch,
} from "./lib/simpleMdmSnapshots";
import { writeAuditLog } from "./lib/auditLog";

const CLAIM_ATTRIBUTE = "rabbithole_claim_token";
const SIMPLEMDM_NOT_CONFIGURED_FOR_SCHOOL =
  "SimpleMDM provisioning isn't configured for your school";
const SIMPLEMDM_API_KEY_MISSING =
  "SimpleMDM API key not configured — set SIMPLEMDM_API_KEY in the Convex deployment";

// Neutral, non-shaming default lock-screen text for Apple's supervised
// Lost Mode. Staff can leave this as-is; there is no phone number to
// show since the point is to route the scholar back to a teacher in person.
export const DEFAULT_LOST_MODE_MESSAGE =
  "This iPad has been disabled. Please return it to a teacher.";

export type SimpleMdmPushResult = {
  managedDeviceId: Id<"managedDeviceClaims">;
  serial: string;
  status: "pushed" | "device-not-found-in-simplemdm" | "api-error";
  message: string;
};

/**
 * Read-back of an iPad's Apple supervised Lost Mode state, resolved
 * live from SimpleMDM. `configured`/`foundInSimpleMdm`/`isSupervised` are all
 * legible refusal states rather than errors: plenty of devices are pre-enrollment,
 * unsupervised, or simply not on a SimpleMDM-tenant school.
 */
export type LostModeState = {
  configured: boolean;
  foundInSimpleMdm: boolean;
  isSupervised: boolean | null;
  lostModeEnabled: boolean | null;
};

export type SetLostModeResult = {
  queued: boolean;
  message: string;
};

/**
 * `queued` is SimpleMDM's 202 — the command is accepted but delivered on the
 * iPad's next MDM check-in, so the console must never phrase it as "rebooted".
 */
export type RestartDeviceResult = {
  queued: boolean;
  message: string;
};

/**
 * Ground-truth reconciliation of one device's SimpleMDM-stored claim against
 * what Rabbithole considers live:
 *   - `in-sync`          SimpleMDM's stored token hashes to our current claim.
 *   - `stale`            the stored attribute is missing/empty/mismatched.
 *   - `not-in-simplemdm` SimpleMDM has no device record for this serial yet.
 */
export type SimpleMdmVerifyResult = {
  managedDeviceId: Id<"managedDeviceClaims">;
  serial: string;
  status: "in-sync" | "stale" | "not-in-simplemdm";
};

export type SimpleMdmInventoryResult = {
  managedDeviceId: Id<"managedDeviceClaims">;
  serial: string;
  foundInSimpleMdm: boolean;
  simpleMdmName: string | null;
  batteryLevel: number | null;
  lastSeenAt: number | null;
  isSupervised: boolean | null;
  lostModeEnabled: boolean | null;
};

type BatteryAlertDevice = {
  managedDeviceId: Id<"managedDeviceClaims">;
  serial: string;
  scholarId: Id<"users">;
  scholarName: string;
};

type BatteryAlertContext = {
  institutionId: Id<"institutions"> | null;
  dayKey: string | null;
  timeZone: string | null;
  isSchoolDay: boolean;
  devices: BatteryAlertDevice[];
};

type LowBatteryAlertDevice = {
  scholarName: string;
  batteryLevel: number;
  lastSeenAt: number | null;
};

type LowBatteryCheckResult = {
  status: "not-a-school-day" | "not-configured" | "api-error" | "clear" | "alerted";
  lowBatteryCount: number;
};


type DbCtx = QueryCtx | MutationCtx;

async function requireSimpleMdmAccess(
  ctx: DbCtx,
): Promise<{ user: Doc<"users">; institutionId: Id<"institutions"> }> {
  const user = await requireUser(ctx);
  const institutionId = await primaryInstitutionId(ctx);
  if (!institutionId) {
    throw new Error(SIMPLEMDM_NOT_CONFIGURED_FOR_SCHOOL);
  }

  if (
    !(await hasSchoolOperationsAccessAtInstitution(ctx, user, institutionId))
  ) {
    throw new Error(SIMPLEMDM_NOT_CONFIGURED_FOR_SCHOOL);
  }

  return { user, institutionId };
}

/**
 * The school a SimpleMDM push for this claim row is scoped to, or null to
 * refuse. Ordinarily the row must belong to the primary school, which owns
 * the SimpleMDM tenant. A platform admin may also push a primary-school iPad
 * that has been lent to a guest school for an event (TRA-465): the row then
 * carries the guest school, but the iPad is still enrolled in the primary's
 * SimpleMDM, so the push is real. Scoping to the ROW's school keeps the push
 * snapshot where that school's devices page reads it. A serial SimpleMDM
 * doesn't know simply comes back "device not found".
 */
function simpleMdmPushScope(
  user: Pick<Doc<"users">, "role">,
  primaryInstitutionId: Id<"institutions">,
  row: Pick<Doc<"managedDeviceClaims">, "institutionId">,
): Id<"institutions"> | null {
  if (row.institutionId === primaryInstitutionId) return row.institutionId;
  return isPlatformAdminRole(user.role) ? row.institutionId : null;
}

function simpleMdmApiKeyOrNull(): string | null {
  return process.env.SIMPLEMDM_API_KEY?.trim() || null;
}

function simpleMdmApiKey(): string {
  const key = simpleMdmApiKeyOrNull();
  if (!key) throw new Error(SIMPLEMDM_API_KEY_MISSING);
  return key;
}

// The non-throwing twin of requireSimpleMdmAccess: is this integration usable
// AT ALL for this caller? A deployment with no SIMPLEMDM_API_KEY, and a school
// that isn't the hardware tenant, are both ordinary states — plenty of
// institutions will never run SimpleMDM — so they answer `false` rather than
// raising. Callers that MUTATE still go through requireSimpleMdmAccess +
// simpleMdmApiKey, which throw a legible message if invoked anyway.
async function simpleMdmConfiguredFor(
  ctx: DbCtx,
  user: Doc<"users">,
): Promise<boolean> {
  if (!simpleMdmApiKeyOrNull()) return false;
  const institutionId = await primaryInstitutionId(ctx);
  if (!institutionId) return false;
  return await hasSchoolOperationsAccessAtInstitution(ctx, user, institutionId);
}

/**
 * Whether SimpleMDM provisioning is available to this caller — the signal the
 * devices console uses to decide whether to show push/verify affordances at
 * all. Answering `false` is a normal outcome, not a failure: it means either
 * this deployment has no `SIMPLEMDM_API_KEY` or this school isn't the tenant
 * that owns the fleet.
 */
export const integrationStatus = query({
  args: {},
  handler: async (ctx): Promise<{ configured: boolean }> => {
    const user = await requireUser(ctx);
    return { configured: await simpleMdmConfiguredFor(ctx, user) };
  },
});

// ── SimpleMDM device lookup, with memory ─────────────────────────────────
//
// All HTTP goes through convex/lib/simpleMdmClient.ts (deadline, backoff,
// legible ConvexErrors). This section adds the one thing the client cannot:
// the per-serial cache of SimpleMDM's device id in `simpleMdmDeviceSnapshots`,
// so a per-device action costs ONE request (the real one) instead of a roster
// walk followed by the real one.

export const snapshotForSerial = internalQuery({
  args: { institutionId: v.id("institutions"), serial: v.string() },
  handler: async (ctx, args): Promise<Doc<"simpleMdmDeviceSnapshots"> | null> => {
    return await snapshotForInstitutionSerial(ctx, args.institutionId, args.serial);
  },
});

/** The inventory fields of a snapshot, derived from one device record. */
function inventoryPatch(
  details: SimpleMdmDeviceDetails | null,
  at: number,
): SimpleMdmSnapshotPatch {
  if (!details) {
    return {
      foundInSimpleMdm: false,
      simpleMdmDeviceId: undefined,
      name: undefined,
      batteryLevel: undefined,
      lastSeenAt: undefined,
      isSupervised: undefined,
      lostModeEnabled: undefined,
      simpleMdmStatus: undefined,
      inventoryAt: at,
    };
  }
  return {
    foundInSimpleMdm: true,
    simpleMdmDeviceId: details.id,
    name: details.name ?? undefined,
    batteryLevel: details.batteryLevel ?? undefined,
    lastSeenAt: details.lastSeenAt ?? undefined,
    isSupervised: details.isSupervised ?? undefined,
    lostModeEnabled: details.lostModeEnabled ?? undefined,
    simpleMdmStatus: details.status ?? undefined,
    inventoryAt: at,
  };
}

export const recordDeviceInventory = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    serial: v.string(),
    device: v.union(
      v.null(),
      v.object({
        id: v.string(),
        serial: v.string(),
        name: v.union(v.string(), v.null()),
        batteryLevel: v.union(v.number(), v.null()),
        lastSeenAt: v.union(v.number(), v.null()),
        isSupervised: v.union(v.boolean(), v.null()),
        lostModeEnabled: v.union(v.boolean(), v.null()),
        status: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await upsertSimpleMdmSnapshot(
      ctx,
      args.institutionId,
      args.serial,
      inventoryPatch(args.device, Date.now()),
    );
  },
});

export const forgetCachedDeviceId = internalMutation({
  args: { institutionId: v.id("institutions"), serial: v.string() },
  handler: async (ctx, args) => {
    const existing = await snapshotForInstitutionSerial(
      ctx,
      args.institutionId,
      args.serial,
    );
    if (existing) {
      await ctx.db.patch(existing._id, {
        simpleMdmDeviceId: undefined,
        updatedAt: Date.now(),
      });
    }
  },
});

/**
 * Resolve a serial to its SimpleMDM device id: the cached id when we have one,
 * otherwise one `?search=` request whose answer is cached for next time.
 * Returns `null` when SimpleMDM has no record of the serial.
 */
async function resolveSimpleMdmDeviceId(
  ctx: ActionCtx,
  apiKey: string,
  institutionId: Id<"institutions">,
  serial: string,
): Promise<string | null> {
  const snapshot = await ctx.runQuery(internal.simplemdm.snapshotForSerial, {
    institutionId,
    serial,
  });
  if (snapshot?.simpleMdmDeviceId) return snapshot.simpleMdmDeviceId;
  const found = await findSimpleMdmDeviceBySerial(apiKey, serial);
  await ctx.runMutation(internal.simplemdm.recordDeviceInventory, {
    institutionId,
    serial,
    device: found,
  });
  return found?.id ?? null;
}

/**
 * Run one per-device SimpleMDM call against the cached id. If SimpleMDM
 * answers 404 — the device was re-enrolled or deleted and re-added, so its id
 * moved — forget the cache, re-look-up by serial, and retry exactly once.
 * `fn` receives `null` when the serial is not in SimpleMDM at all.
 */
async function withSimpleMdmDeviceId<T>(
  ctx: ActionCtx,
  apiKey: string,
  institutionId: Id<"institutions">,
  serial: string,
  fn: (simpleMdmDeviceId: string | null) => Promise<T>,
): Promise<T> {
  const cached =
    (
      await ctx.runQuery(internal.simplemdm.snapshotForSerial, {
        institutionId,
        serial,
      })
    )?.simpleMdmDeviceId ?? null;
  const first = cached ?? (await resolveSimpleMdmDeviceId(ctx, apiKey, institutionId, serial));
  try {
    return await fn(first);
  } catch (error) {
    if (!cached || !isSimpleMdmNotFound(error)) throw error;
  }
  await ctx.runMutation(internal.simplemdm.forgetCachedDeviceId, {
    institutionId,
    serial,
  });
  const fresh = await resolveSimpleMdmDeviceId(ctx, apiKey, institutionId, serial);
  return await fn(fresh);
}

/**
 * `GET /devices/{id}` — read-only, ground-truth for `is_supervised` (Managed
 * Lost Mode only works on a supervised device) and `lost_mode_enabled` (is a
 * previously-sent enable/disable command actually reflected by SimpleMDM
 * yet). Missing/non-boolean attributes resolve to `null` — "not reported" —
 * rather than fabricating a state. Throws `not-found` when the id is stale so
 * `withSimpleMdmDeviceId` can re-resolve it.
 */
async function fetchDeviceAttributes(
  apiKey: string,
  simpleMdmDeviceId: string,
  serial: string,
): Promise<SimpleMdmDeviceDetails> {
  const details = await fetchSimpleMdmDevice(apiKey, simpleMdmDeviceId, serial);
  if (!details) {
    throw new SimpleMdmApiError({
      code: "not-found",
      status: 404,
      what: "reading the device",
      message: "SimpleMDM no longer has a device with that id.",
    });
  }
  return details;
}

/**
 * `POST /devices/{id}/lost_mode` — activate Apple's supervised Lost Mode.
 * SimpleMDM requires at least `message` or `phone_number`; we only ever
 * send a message (no phone number — the point is to route the scholar back to
 * a teacher in person, not to invite a call). Returns 202 while the command
 * queues for a device that is currently offline; the caller uses that status
 * to report queued-vs-accepted accurately rather than assuming either.
 */
async function enableLostModeOnSimpleMdmDevice(
  apiKey: string,
  simpleMdmDeviceId: string,
  message: string,
): Promise<{ queued: boolean }> {
  const response = await simpleMdmRequest(
    apiKey,
    `devices/${encodeURIComponent(simpleMdmDeviceId)}/lost_mode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    },
    { what: "enabling Lost Mode" },
  );
  return { queued: response.status === 202 };
}

/**
 * `DELETE /devices/{id}/lost_mode` — release Lost Mode. Also queues
 * (202) until the device is next online; the caller uses the returned status
 * to report queued-vs-accepted accurately rather than assuming either.
 */
async function disableLostModeOnSimpleMdmDevice(
  apiKey: string,
  simpleMdmDeviceId: string,
): Promise<{ queued: boolean }> {
  const response = await simpleMdmRequest(
    apiKey,
    `devices/${encodeURIComponent(simpleMdmDeviceId)}/lost_mode`,
    { method: "DELETE" },
    { what: "disabling Lost Mode" },
  );
  return { queued: response.status === 202 };
}

/**
 * `POST /devices/{id}/restart` — Apple's RestartDevice command, the escape
 * hatch for an iPad whose app has wedged. Like Lost Mode it answers 202 and
 * is delivered on the device's next MDM check-in, so the caller reports
 * queued-vs-accepted from the status rather than claiming it rebooted.
 *
 * Deliberately sends NO body: SimpleMDM's `notify_user` and
 * `rebuild_kernel_cache` parameters are macOS-only, and this fleet is iPads.
 *
 * Apple lists RestartDevice as iOS/iPadOS *(Supervised)*, so callers must
 * check supervision first — see `restartDevice`.
 */
async function restartSimpleMdmDevice(
  apiKey: string,
  simpleMdmDeviceId: string,
): Promise<{ queued: boolean }> {
  const response = await simpleMdmRequest(
    apiKey,
    `devices/${encodeURIComponent(simpleMdmDeviceId)}/restart`,
    { method: "POST" },
    {
      what: "restarting the iPad",
      // This POST is NOT idempotent — each accepted call queues a reboot — and
      // the caller's authorization is revalidated only before the first
      // attempt. So narrow the shared client's default retry set to the one
      // status that PROVES SimpleMDM did not act on the request: 429. A lost
      // response or a 502/503/504 is ambiguous, and re-sending it can queue a
      // second reboot (under authority checked for the first attempt only),
      // which is worse than reporting the failure and letting staff retry.
      retryStatuses: new Set([429]),
      retryOnTransportError: false,
    },
  );
  return { queued: response.status === 202 };
}

type SimpleMdmCustomAttributeValue = {
  id?: unknown;
  attributes?: { value?: unknown };
};

/**
 * Read the plaintext claim SimpleMDM currently stores for a device in the
 * `rabbithole_claim_token` custom attribute. Returns null when the attribute is
 * absent or empty. Any transport/HTTP error throws — verification must never
 * fabricate a "matches" result from a failed read.
 */
async function fetchClaimAttributeValue(
  apiKey: string,
  simpleMdmDeviceId: string,
): Promise<string | null> {
  const what = "reading the device claim";
  const payload = (await simpleMdmJson(
    apiKey,
    `devices/${encodeURIComponent(simpleMdmDeviceId)}/custom_attribute_values`,
    { what },
  )) as { data?: unknown };
  if (!Array.isArray(payload.data)) {
    throw new SimpleMdmApiError({
      code: "unreadable",
      what,
      message: "SimpleMDM returned an invalid custom-attribute list.",
    });
  }
  const entry = (payload.data as SimpleMdmCustomAttributeValue[]).find(
    (item) => item.id === CLAIM_ATTRIBUTE,
  );
  const value = entry?.attributes?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function writeClaimAttribute(
  apiKey: string,
  simpleMdmDeviceId: string,
  claimToken: string,
): Promise<void> {
  // simpleMdmRequest never includes a response body in its error: an error
  // page could echo the claim token.
  await simpleMdmRequest(
    apiKey,
    `devices/${encodeURIComponent(simpleMdmDeviceId)}/custom_attribute_values/${CLAIM_ATTRIBUTE}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: claimToken }),
    },
    { what: "updating the claim" },
  );
}

async function renameSimpleMdmDevice(
  apiKey: string,
  simpleMdmDeviceId: string,
  name: string,
): Promise<string> {
  const what = "renaming the device";
  const payload = (await simpleMdmJson(
    apiKey,
    `devices/${encodeURIComponent(simpleMdmDeviceId)}`,
    { what },
    {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name }).toString(),
    },
  )) as { data?: { attributes?: { name?: unknown } } };
  const savedName = payload.data?.attributes?.name;
  if (typeof savedName !== "string" || !savedName.trim()) {
    throw new SimpleMdmApiError({
      code: "unreadable",
      what,
      message: "SimpleMDM renamed the device but did not return its saved name.",
    });
  }
  return savedName.trim();
}

export const managedDeviceForPush = internalQuery({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args) => {
    const { user, institutionId: primaryId } = await requireSimpleMdmAccess(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    const institutionId = row ? simpleMdmPushScope(user, primaryId, row) : null;
    if (!row || !institutionId) {
      throw new Error("That device is not available for SimpleMDM provisioning.");
    }
    if (!row.scholarId) {
      throw new Error("Assign a scholar before pushing this device.");
    }
    if (row.claimState === "revoked") {
      throw new Error(
        "This claim is revoked. Rotate it before pushing to SimpleMDM.",
      );
    }
    return {
      managedDeviceId: row._id,
      serial: row.serial,
      institutionId,
    };
  },
});

export const prepareSimpleMdmRename = internalMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args) => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
    await assertCanWrite(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row || row.institutionId !== institutionId) {
      throw new Error("That device is not available for SimpleMDM management.");
    }
    return { serial: row.serial, institutionId };
  },
});

export const recordSimpleMdmRename = internalMutation({
  args: {
    managedDeviceId: v.id("managedDeviceClaims"),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const { user, institutionId } = await requireSimpleMdmAccess(ctx);
    await assertCanWrite(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row || row.institutionId !== institutionId) {
      return { recorded: false };
    }
    await auditManagedClaim(
      ctx,
      user._id,
      "managed-device.simplemdm-rename",
      row.scholarId ?? user._id,
      `serial ${row.serial} renamed to ${args.name}`,
      institutionId,
    );
    return { recorded: true };
  },
});

export const pendingManagedDevicesForPush = internalQuery({
  args: {},
  handler: async (ctx) => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
    const rows = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    const assigned = rows.filter(
      (row): row is typeof row & { scholarId: Id<"users"> } =>
        !!row.scholarId &&
        row.claimState !== "revoked" &&
        (row.pendingClaimTokenHash
          ? !row.pendingSimplemdmPushedAt
          : !row.simplemdmPushedAt ||
            row.simplemdmPushedAt < row.claimIssuedAt),
    );
    return assigned.map((row) => ({
      managedDeviceId: row._id,
      serial: row.serial,
      institutionId,
    }));
  },
});

export const assignedManagedDevicesForVerify = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, { institutionId }) => {
    const rows = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    const assigned = rows.filter(
      (
        row,
      ): row is typeof row & {
        scholarId: Id<"users">;
        claimTokenHash: string;
      } =>
        !!row.scholarId &&
        row.claimState !== "revoked" &&
        typeof row.claimTokenHash === "string" &&
        row.claimTokenHash.length > 0,
    );
    return assigned.map((row) => ({
      managedDeviceId: row._id,
      serial: row.serial,
      claimTokenHash: row.claimTokenHash,
      pendingClaimTokenHash: row.pendingClaimTokenHash,
    }));
  },
});

export const managedDevicesForInventory = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, { institutionId }) => {
    const rows = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    return rows.map((row) => ({
      managedDeviceId: row._id,
      serial: row.serial,
    }));
  },
});


export const batteryAlertContext = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args): Promise<BatteryAlertContext> => {
    const institutionId = await primaryInstitutionId(ctx);
    if (!institutionId) {
      return {
        institutionId: null,
        dayKey: null,
        timeZone: null,
        isSchoolDay: false,
        devices: [],
      };
    }

    const institution = await ctx.db.get(institutionId);
    if (!institution || institution.disabledAt !== undefined) {
      return {
        institutionId,
        dayKey: null,
        timeZone: null,
        isSchoolDay: false,
        devices: [],
      };
    }

    const timeZone = effectiveInstitutionTimeZone(institution.timeZone);
    const dayKey = dayKeyForTimezone(args.nowMs, timeZone);
    const weekday = weekdayForDayKey(dayKey);
    const [scopedClosures, globalClosures] = await Promise.all([
      ctx.db
        .query("schoolClosures")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect(),
      ctx.db
        .query("schoolClosures")
        .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
        .collect(),
    ]);
    const isSchoolDay =
      weekday >= 1 &&
      weekday <= 5 &&
      isClosedDay(dayKey, [...scopedClosures, ...globalClosures]) === null;
    if (!isSchoolDay) {
      return {
        institutionId,
        dayKey,
        timeZone,
        isSchoolDay: false,
        devices: [],
      };
    }

    const rows = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    const devices: BatteryAlertDevice[] = [];
    for (const row of rows) {
      if (!row.scholarId || row.claimState === "revoked") continue;
      const scholar = await ctx.db.get(row.scholarId);
      if (!scholar) continue;
      devices.push({
        managedDeviceId: row._id,
        serial: row.serial,
        scholarId: row.scholarId,
        scholarName: scholar.name ?? scholar.username ?? "A scholar",
      });
    }
    devices.sort((left, right) =>
      left.scholarName.localeCompare(right.scholarName),
    );

    return {
      institutionId,
      dayKey,
      timeZone,
      isSchoolDay: true,
      devices,
    };
  },
});

export const raiseLowBatteryAlert = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    dayKey: v.string(),
    timeZone: v.string(),
    devices: v.array(
      v.object({
        scholarName: v.string(),
        batteryLevel: v.number(),
        lastSeenAt: v.union(v.number(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.devices.length === 0) return;

    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: args.timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const deviceLines = args.devices.map((device) => {
      const lastSeen =
        device.lastSeenAt === null
          ? "last check-in unavailable"
          : `last seen ${formatter.format(new Date(device.lastSeenAt))}`;
      return `- ${escapeSlackText(device.scholarName)} — ${device.batteryLevel}% (${lastSeen})`;
    });
    const plural = args.devices.length !== 1;

    await raiseAlert(ctx, {
      kind: "device_low_battery",
      severity: "warning",
      title: plural ? "iPads need charging" : "An iPad needs charging",
      body: [
        `${args.devices.length} scholar iPad${plural ? "s are" : " is"} below 20% at the start of the school day:`,
        ...deviceLines,
        `Please plug ${plural ? "them" : "it"} in before use.`,
      ].join("\n"),
      source: "simplemdm.checkLowBatteryAtSchoolStart",
      audience: "institution",
      institutionId: args.institutionId,
      deepLink: withBase(siteUrl(), "/school/devices"),
      dedupKey: `device-low-battery:${args.institutionId}:${args.dayKey}`,
      dedupWindowMs: 48 * 60 * 60 * 1000,
    });
  },
});

export const stageManagedDeviceClaimForPush = internalMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args) => {
    const { user, institutionId: primaryId } = await requireSimpleMdmAccess(ctx);
    await assertCanWrite(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    const institutionId = row ? simpleMdmPushScope(user, primaryId, row) : null;
    if (
      !row ||
      !institutionId ||
      !row.scholarId ||
      row.claimState === "revoked"
    ) {
      throw new Error("That device is not ready for SimpleMDM provisioning.");
    }
    const scholar = await ctx.db.get(row.scholarId);
    if (
      !scholar ||
      scholar.role !== ROLES.SCHOLAR ||
      scholar.institutionId !== institutionId
    ) {
      throw new Error("The assigned scholar is no longer available.");
    }

    return await stageClaimReplacementForSimpleMdm(ctx, row, user._id);
  },
});

export const recordSimpleMdmPush = internalMutation({
  args: {
    managedDeviceId: v.id("managedDeviceClaims"),
    pendingClaimIssuedAt: v.number(),
    pendingRotationCount: v.number(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const { user, institutionId: primaryId } = await requireSimpleMdmAccess(ctx);
    await assertCanWrite(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    const institutionId = row ? simpleMdmPushScope(user, primaryId, row) : null;
    if (!row || !institutionId || !row.scholarId) {
      return { recorded: false };
    }

    const stillStaged =
      row.pendingClaimIssuedAt === args.pendingClaimIssuedAt &&
      row.pendingRotationCount === args.pendingRotationCount;
    // The iPad polls managed config every few seconds, so it can exchange the
    // replacement in the window between the SimpleMDM PUT returning and this
    // mutation running. Promotion copies the staged values into the current
    // claim, so that exact match is proof the push DID deliver — stamp the
    // current claim rather than reporting a failed push over a live device.
    // `claimState` separates a promotion from a staff re-mint, which also
    // rewrites claimIssuedAt/rotationCount but leaves the claim unclaimed.
    const promotedWhilePushing =
      !stillStaged &&
      row.claimState === "claimed" &&
      row.claimIssuedAt === args.pendingClaimIssuedAt &&
      row.rotationCount === args.pendingRotationCount;
    if (!stillStaged && !promotedWhilePushing) {
      return { recorded: false };
    }

    const pushedAt = Date.now();
    await ctx.db.patch(
      row._id,
      stillStaged
        ? { pendingSimplemdmPushedAt: pushedAt, updatedAt: pushedAt }
        : { simplemdmPushedAt: pushedAt, updatedAt: pushedAt },
    );
    await auditManagedClaim(
      ctx,
      user._id,
      "managed-claim.simplemdm-push",
      row.scholarId,
      `serial ${row.serial}${promotedWhilePushing ? " (claimed during push)" : ""}`,
      institutionId,
    );
    return { recorded: true };
  },
});

/**
 * Resolve enrollment, stage a replacement, then write it to SimpleMDM. The
 * current claim remains valid until the iPad exchanges the replacement, so a
 * failed or delayed MDM delivery cannot strand the device.
 */
async function pushPreparedDevice(
  ctx: ActionCtx,
  device: {
    managedDeviceId: Id<"managedDeviceClaims">;
    serial: string;
    institutionId: Id<"institutions">;
  },
  apiKey: string,
  mappedSimpleMdmDeviceId?: string | null,
): Promise<SimpleMdmPushResult> {
  const result = await pushPreparedDeviceUnrecorded(
    ctx,
    device,
    apiKey,
    mappedSimpleMdmDeviceId,
  );
  // Remember the outcome so "Push failed" survives a page reload; the
  // transient per-click result the console shows is the same data.
  await ctx.runMutation(internal.simplemdm.recordPushOutcome, {
    institutionId: device.institutionId,
    serial: device.serial,
    status: result.status,
    message: result.message,
  });
  return { managedDeviceId: result.managedDeviceId, serial: result.serial, status: result.status, message: result.message };
}

export const recordPushOutcome = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    serial: v.string(),
    status: v.union(
      v.literal("pushed"),
      v.literal("device-not-found-in-simplemdm"),
      v.literal("api-error"),
    ),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    await upsertSimpleMdmSnapshot(ctx, args.institutionId, args.serial, {
      lastPushAt: Date.now(),
      lastPushStatus: args.status,
      lastPushMessage: args.message,
      // A successful push replaces the claim SimpleMDM holds, so the previous
      // read-back verdict no longer describes anything. Drop it (never
      // fabricate "in-sync"); the next scheduled check will say.
      ...(args.status === "pushed"
        ? { claimVerifyStatus: undefined, claimVerifiedAt: undefined }
        : {}),
    });
  },
});

async function pushPreparedDeviceUnrecorded(
  ctx: ActionCtx,
  device: {
    managedDeviceId: Id<"managedDeviceClaims">;
    serial: string;
    institutionId: Id<"institutions">;
  },
  apiKey: string,
  mappedSimpleMdmDeviceId?: string | null,
): Promise<SimpleMdmPushResult> {
  const publicDevice = { managedDeviceId: device.managedDeviceId, serial: device.serial };
  const notFound = (): SimpleMdmPushResult => ({
    ...publicDevice,
    status: "device-not-found-in-simplemdm",
    message:
      "SimpleMDM has no record of this serial. Check the serial, then confirm " +
      "the iPad is assigned to SimpleMDM in Apple School Manager and the ADE " +
      "sync has run.",
  });

  let minted: {
    claimToken: string;
    pendingClaimIssuedAt: number;
    pendingRotationCount: number;
  };
  try {
    minted = await ctx.runMutation(
      internal.simplemdm.stageManagedDeviceClaimForPush,
      { managedDeviceId: device.managedDeviceId },
    );
  } catch {
    return {
      ...publicDevice,
      status: "api-error",
      message: "Rabbithole couldn't mint a fresh claim for this device.",
    };
  }

  try {
    const write = async (simpleMdmDeviceId: string | null) => {
      if (!simpleMdmDeviceId) return false;
      await writeClaimAttribute(apiKey, simpleMdmDeviceId, minted.claimToken);
      return true;
    };
    const wrote =
      mappedSimpleMdmDeviceId === undefined
        ? await withSimpleMdmDeviceId(
            ctx,
            apiKey,
            device.institutionId,
            device.serial,
            write,
          )
        : await write(mappedSimpleMdmDeviceId);
    if (!wrote) return notFound();
  } catch (error) {
    if (isSimpleMdmNotFound(error)) return notFound();
    return {
      ...publicDevice,
      status: "api-error",
      message: simpleMdmErrorMessage(
        error,
        "SimpleMDM could not update the device claim.",
      ),
    };
  }

  let recorded: { recorded: boolean };
  try {
    recorded = await ctx.runMutation(
      internal.simplemdm.recordSimpleMdmPush,
      {
        managedDeviceId: device.managedDeviceId,
        pendingClaimIssuedAt: minted.pendingClaimIssuedAt,
        pendingRotationCount: minted.pendingRotationCount,
      },
    );
  } catch {
    return {
      ...publicDevice,
      status: "api-error",
      message:
        "The claim reached SimpleMDM, but Rabbithole couldn't record the push. Push it again.",
    };
  }
  if (!recorded.recorded) {
    return {
      ...publicDevice,
      status: "api-error",
      message:
        "The device assignment changed during the push. Push it again to send the current claim.",
    };
  }

  return {
    ...publicDevice,
    status: "pushed",
    message: "Claim pushed to SimpleMDM.",
  };
}

export const pushClaimToSimpleMdm = action({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args): Promise<SimpleMdmPushResult> => {
    await assertWritableAction(ctx);
    const device = await ctx.runQuery(
      internal.simplemdm.managedDeviceForPush,
      args,
    );
    const apiKey = simpleMdmApiKey();
    return await pushPreparedDevice(ctx, device, apiKey);
  },
});

export const pushAllPendingClaims = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ results: SimpleMdmPushResult[] }> => {
    await assertWritableAction(ctx);
    const devices: Array<{
      managedDeviceId: Id<"managedDeviceClaims">;
      serial: string;
      institutionId: Id<"institutions">;
    }> = await ctx.runQuery(
      internal.simplemdm.pendingManagedDevicesForPush,
      {},
    );
    if (devices.length === 0) return { results: [] };

    const apiKey = simpleMdmApiKey();
    let bySerial: Map<string, SimpleMdmDeviceDetails>;
    try {
      bySerial = await listSimpleMdmDevices(apiKey);
    } catch (error) {
      return {
        results: devices.map((device) => ({
          managedDeviceId: device.managedDeviceId,
          serial: device.serial,
          status: "api-error",
          message: simpleMdmErrorMessage(
            error,
            "SimpleMDM could not list enrolled devices.",
          ),
        })),
      };
    }
    // The roster walk just told us every id — remember them.
    await ctx.runMutation(internal.simplemdm.recordRosterInventory, {
      institutionId: devices[0].institutionId,
      devices: devices.map((device) => ({
        serial: device.serial,
        device: bySerial.get(normalizeSerial(device.serial)) ?? null,
      })),
    });
    const results: SimpleMdmPushResult[] = [];
    for (const device of devices) {
      results.push(
        await pushPreparedDevice(
          ctx,
          device,
          apiKey,
          bySerial.get(device.serial.trim().toUpperCase())?.id ?? null,
        ),
      );
    }
    return { results };
  },
});

export const renameManagedDevice = action({
  args: {
    managedDeviceId: v.id("managedDeviceClaims"),
    name: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ simpleMdmName: string }> => {
    const name = args.name.trim();
    if (!name || name.length > 120) {
      throw new Error("Device name must be between 1 and 120 characters.");
    }
    const device = await ctx.runMutation(
      internal.simplemdm.prepareSimpleMdmRename,
      { managedDeviceId: args.managedDeviceId },
    );
    const apiKey = simpleMdmApiKey();
    const simpleMdmName = await withSimpleMdmDeviceId(
      ctx,
      apiKey,
      device.institutionId,
      device.serial,
      async (simpleMdmDeviceId) => {
        if (!simpleMdmDeviceId) {
          throw new Error(
            "SimpleMDM has no record of this serial. Confirm the device is enrolled, then try again.",
          );
        }
        return await renameSimpleMdmDevice(apiKey, simpleMdmDeviceId, name);
      },
    );
    await ctx.runMutation(internal.simplemdm.recordDeviceName, {
      institutionId: device.institutionId,
      serial: device.serial,
      name: simpleMdmName,
    });
    const recorded = await ctx.runMutation(
      internal.simplemdm.recordSimpleMdmRename,
      {
        managedDeviceId: args.managedDeviceId,
        name: simpleMdmName,
      },
    );
    if (!recorded.recorded) {
      throw new Error(
        "The name changed in SimpleMDM, but Rabbithole couldn't record the audit entry.",
      );
    }
    return { simpleMdmName };
  },
});

export const recordRosterInventory = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    devices: v.array(
      v.object({
        serial: v.string(),
        device: v.union(
          v.null(),
          v.object({
            id: v.string(),
            serial: v.string(),
            name: v.union(v.string(), v.null()),
            batteryLevel: v.union(v.number(), v.null()),
            lastSeenAt: v.union(v.number(), v.null()),
            isSupervised: v.union(v.boolean(), v.null()),
            lostModeEnabled: v.union(v.boolean(), v.null()),
            status: v.union(v.string(), v.null()),
          }),
        ),
        // Device truth panel (TRA-241 step 1) — the `GET
        // .../installed_apps` read-back, one call per device found in
        // SimpleMDM. Absent (not just an empty array) means "not fetched
        // this pass" (e.g. `device` was null); the mutation then leaves any
        // previously-stored installed-apps fields untouched rather than
        // wiping them.
        installedBundleIds: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const entry of args.devices) {
      await upsertSimpleMdmSnapshot(ctx, args.institutionId, entry.serial, {
        ...inventoryPatch(entry.device, now),
        ...(entry.installedBundleIds !== undefined
          ? { installedBundleIds: entry.installedBundleIds, installedAppsAt: now }
          : {}),
      });
    }
  },
});

export const recordDeviceName = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    serial: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await upsertSimpleMdmSnapshot(ctx, args.institutionId, args.serial, {
      name: args.name,
    });
  },
});

/**
 * Write down the SimpleMDM devices that have NO `managedDeviceClaims` row in
 * this institution — the MDM → Rabbithole direction of reconciliation. Called
 * only from `refreshSnapshotsForInstitution`, with the complete roster walk
 * that pass already fetched; it makes no SimpleMDM requests of its own.
 *
 * Snapshot rows are written through the same `inventoryPatch` the rostered
 * devices use, so the row is correctly shaped for the OTHER consumer: the
 * moment somebody registers the serial, `listManagedDevices` starts reading
 * this row through the new claim and must find real inventory there, not a
 * counter's private bookkeeping. (`installedBundleIds` is left absent — the
 * per-device installed-apps read is one HTTP call each and is reserved for
 * rostered devices; absent already renders as "unknown".)
 *
 * Staleness is handled in the same pass, which is why the caller hands over
 * the whole unrostered set rather than just the new ones: a claim-less
 * snapshot row whose serial is no longer anywhere in SimpleMDM is dated and
 * marked `foundInSimpleMdm: false`, so it stops being counted. A row that
 * gained a claim row is left entirely alone — the roster-driven passes above
 * own it from then on.
 */
export const reconcileUnrosteredDevices = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    devices: v.array(
      v.object({
        id: v.string(),
        serial: v.string(),
        name: v.union(v.string(), v.null()),
        batteryLevel: v.union(v.number(), v.null()),
        lastSeenAt: v.union(v.number(), v.null()),
        isSupervised: v.union(v.boolean(), v.null()),
        lostModeEnabled: v.union(v.boolean(), v.null()),
        status: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const claimedSerials = await claimedSerialsForInstitution(
      ctx,
      args.institutionId,
    );
    const seen = new Set<string>();
    for (const device of args.devices) {
      const serial = normalizeSerial(device.serial);
      seen.add(serial);
      // Registered between the walk and this write: the roster-driven pass
      // owns the row now, and re-writing it here would drop the claim fields.
      if (claimedSerials.has(serial)) continue;
      await upsertSimpleMdmSnapshot(
        ctx,
        args.institutionId,
        serial,
        inventoryPatch(device, now),
      );
    }
    const rows = await ctx.db
      .query("simpleMdmDeviceSnapshots")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .collect();
    for (const row of rows) {
      if (row.foundInSimpleMdm !== true) continue;
      if (seen.has(row.serial) || claimedSerials.has(row.serial)) continue;
      await upsertSimpleMdmSnapshot(
        ctx,
        args.institutionId,
        row.serial,
        inventoryPatch(null, now),
      );
    }
  },
});

async function claimedSerialsForInstitution(
  ctx: QueryCtx | MutationCtx,
  institutionId: Id<"institutions">,
): Promise<Set<string>> {
  const claims = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  return new Set(claims.map((claim) => normalizeSerial(claim.serial)));
}

/**
 * The serials SimpleMDM is actively managing that this roster has never heard
 * of — the one signal the devices console had no way to show, so an enrolled,
 * checking-in iPad could simply be absent with nothing saying so.
 *
 * Read entirely from STORED snapshots (the console never calls SimpleMDM on a
 * page load), so the answer is as of the last check. The toolbar's existing
 * freshness line already dates that check from the canonical source, so this
 * query returns serials only and never re-derives a second clock.
 *
 * ENROLLED only. The roster walk asks for `include_awaiting_enrollment=true`,
 * so a boxed or ADE-pending iPad is in it; reporting those would make this
 * line loudest during an unboxing wave, which is exactly when it needs to be
 * trustworthy. A retired ("unenrolled") device is excluded for the same
 * reason. Rows written before `simpleMdmStatus` existed report no status and
 * are therefore not counted until the next refresh dates them — under-report,
 * never over-accuse.
 *
 * Same gate as every other SimpleMDM surface: one global tenant API key means
 * school-operations access at the PRIMARY institution, and a refusal (never a
 * silent fallback to the primary's fleet) for anyone else.
 */
export const unrosteredSimpleMdmDevices = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ serials: string[] }> => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
    const claimedSerials = await claimedSerialsForInstitution(
      ctx,
      institutionId,
    );
    const rows = await ctx.db
      .query("simpleMdmDeviceSnapshots")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    const serials: string[] = [];
    for (const row of rows) {
      if (row.foundInSimpleMdm !== true) continue;
      if (!isEnrolledSimpleMdmStatus(row.simpleMdmStatus)) continue;
      if (claimedSerials.has(row.serial)) continue;
      serials.push(row.serial);
    }
    serials.sort();
    return { serials };
  },
});

/**
 * Persist verify verdicts — but only for claims that still ARE the claim the
 * verdict was computed against. The refresh action reads the claim hashes,
 * then spends seconds-to-minutes talking to SimpleMDM; a mint / rotate /
 * unassign / revoke in that window clears the stored verdict and changes the
 * hashes. Without this check the late write would put a stale "in-sync" back
 * on a claim that no longer exists. Each verdict carries the hashes it
 * compared; a row whose hashes moved is skipped, not overwritten.
 */
export const recordClaimVerification = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    results: v.array(
      v.object({
        managedDeviceId: v.id("managedDeviceClaims"),
        serial: v.string(),
        claimTokenHash: v.string(),
        pendingClaimTokenHash: v.optional(v.string()),
        status: v.union(
          v.literal("in-sync"),
          v.literal("stale"),
          v.literal("not-in-simplemdm"),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const result of args.results) {
      const claim = await ctx.db.get(result.managedDeviceId);
      if (
        !claim ||
        claim.institutionId !== args.institutionId ||
        claim.claimState === "revoked" ||
        claim.claimTokenHash !== result.claimTokenHash ||
        claim.pendingClaimTokenHash !== result.pendingClaimTokenHash
      ) {
        continue;
      }
      await upsertSimpleMdmSnapshot(ctx, args.institutionId, result.serial, {
        claimVerifyStatus: result.status,
        claimVerifiedAt: now,
      });
    }
  },
});

/**
 * Reconcile every managed device against SimpleMDM's ground truth and WRITE
 * the answer to `simpleMdmDeviceSnapshots` — the one copy the console reads.
 * Pages the roster ONCE (it carries name/battery/last-seen/supervision/Lost
 * Mode for every serial, assigned or not), then reads each assigned device's
 * stored claim and compares its sha256 to the hash Rabbithole holds. Any
 * SimpleMDM API failure throws (callers surface it) rather than fabricating a
 * partial answer; the previous snapshot stays put, dated, until a check
 * succeeds.
 *
 * Runs from the hourly cron, from "Check now" in the console, and from
 * nothing else — a page opening is not a reason to call SimpleMDM.
 */
async function refreshSnapshotsForInstitution(
  ctx: ActionCtx,
  apiKey: string,
  institutionId: Id<"institutions">,
): Promise<{
  results: SimpleMdmVerifyResult[];
  inventory: SimpleMdmInventoryResult[];
}> {
  const [devices, inventoryDevices] = await Promise.all([
    ctx.runQuery(internal.simplemdm.assignedManagedDevicesForVerify, {
      institutionId,
    }),
    ctx.runQuery(internal.simplemdm.managedDevicesForInventory, {
      institutionId,
    }),
  ]);
  const bySerial = await listSimpleMdmDevices(apiKey);
  // Installed-apps read-back (device truth panel, TRA-241 step 1): one call
  // per device found in SimpleMDM (`GET /devices/{id}/installed_apps`).
  // Verdicts are flushed in the same small batches, and on the same
  // stop-asking-when-SimpleMDM-says-so posture, as the claim-verify loop
  // below — a rate limit or transport failure here aborts this refresh pass
  // (the cron and "Check now" both already tolerate a failed pass and retry
  // next tick) rather than silently skipping installed-apps for the rest of
  // the roster.
  const inventory: SimpleMdmInventoryResult[] = [];
  let unflushedInventory: Array<{
    serial: string;
    device: SimpleMdmDeviceDetails | null;
    installedBundleIds: string[] | undefined;
  }> = [];
  const flushInventory = async () => {
    if (!unflushedInventory.length) return;
    const batch = unflushedInventory;
    unflushedInventory = [];
    await ctx.runMutation(internal.simplemdm.recordRosterInventory, {
      institutionId,
      devices: batch,
    });
  };
  try {
    for (const device of inventoryDevices) {
      const details = bySerial.get(normalizeSerial(device.serial));
      const installedBundleIds = details
        ? await fetchInstalledAppBundleIds(apiKey, details.id)
        : undefined;
      inventory.push({
        managedDeviceId: device.managedDeviceId,
        serial: device.serial,
        foundInSimpleMdm: details !== undefined,
        simpleMdmName: details?.name ?? null,
        batteryLevel: details?.batteryLevel ?? null,
        lastSeenAt: details?.lastSeenAt ?? null,
        isSupervised: details?.isSupervised ?? null,
        lostModeEnabled: details?.lostModeEnabled ?? null,
      });
      unflushedInventory.push({
        serial: device.serial,
        device: details ?? null,
        installedBundleIds,
      });
      if (unflushedInventory.length >= VERIFY_FLUSH_EVERY) await flushInventory();
    }
  } finally {
    await flushInventory();
  }

  // One read per assigned device. Verdicts are persisted in small batches as
  // they arrive, so a run that dies partway (action limit, SimpleMDM going
  // dark) still leaves every device it did reach freshly dated; and the
  // moment SimpleMDM says "slow down" or stops answering we stop asking —
  // hammering the rest of the roster would only lengthen the rate limit.
  const results: SimpleMdmVerifyResult[] = [];
  let unflushed: Array<
    SimpleMdmVerifyResult & {
      claimTokenHash: string;
      pendingClaimTokenHash: string | undefined;
    }
  > = [];
  const flush = async () => {
    if (!unflushed.length) return;
    const batch = unflushed;
    unflushed = [];
    await ctx.runMutation(internal.simplemdm.recordClaimVerification, {
      institutionId,
      results: batch,
    });
  };
  const record = (
    result: SimpleMdmVerifyResult,
    device: (typeof devices)[number],
  ) => {
    results.push(result);
    unflushed.push({
      ...result,
      claimTokenHash: device.claimTokenHash,
      pendingClaimTokenHash: device.pendingClaimTokenHash,
    });
  };
  try {
    for (const device of devices) {
      const simpleMdmDevice = bySerial.get(normalizeSerial(device.serial));
      if (!simpleMdmDevice) {
        record(
          {
            managedDeviceId: device.managedDeviceId,
            serial: device.serial,
            status: "not-in-simplemdm",
          },
          device,
        );
        continue;
      }
      const storedValue = await fetchClaimAttributeValue(
        apiKey,
        simpleMdmDevice.id,
      );
      const storedHash = storedValue ? await sha256Hex(storedValue) : null;
      record(
        {
          managedDeviceId: device.managedDeviceId,
          serial: device.serial,
          status:
            storedHash === device.claimTokenHash ||
            storedHash === device.pendingClaimTokenHash
              ? "in-sync"
              : "stale",
        },
        device,
      );
      if (unflushed.length >= VERIFY_FLUSH_EVERY) await flush();
    }
  } finally {
    await flush();
  }

  // MDM → Rabbithole reconciliation. `bySerial` above is the COMPLETE
  // SimpleMDM roster this pass already paid for; every serial in it that has
  // no `managedDeviceClaims` row is a device that is enrolled (or boxed) at
  // SimpleMDM and invisible to this console. Writing them down here costs
  // ZERO extra SimpleMDM requests — the walk already happened.
  //
  // Deliberately last: both loops above throw on a SimpleMDM failure, so a
  // partial pass never reaches this point. "These serials are missing from
  // your roster" is an accusation, and it may only be made from a walk that
  // completed.
  const rosteredSerials = new Set(
    inventoryDevices.map((device) => normalizeSerial(device.serial)),
  );
  await ctx.runMutation(internal.simplemdm.reconcileUnrosteredDevices, {
    institutionId,
    devices: [...bySerial.values()].filter(
      (device) => !rosteredSerials.has(device.serial),
    ),
  });

  return { results, inventory };
}

/** Persist claim verdicts after this many devices so a partial run still counts. */
const VERIFY_FLUSH_EVERY = 10;

export const simpleMdmAccessContext = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ institutionId: Id<"institutions"> }> => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
    return { institutionId };
  },
});

/**
 * "Check now": a staff member asks for a fresh SimpleMDM read-back. Persists
 * the result (the console re-renders from the snapshot rows) and also returns
 * it, for callers that want the answer inline. Unconfigured is an ordinary
 * state, not an error — `{ configured: false }`.
 */
export const verifySimpleMdmClaims = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    configured: boolean;
    results: SimpleMdmVerifyResult[];
    inventory: SimpleMdmInventoryResult[];
  }> => {
    const { configured } = await ctx.runQuery(
      api.simplemdm.integrationStatus,
      {},
    );
    if (!configured) return { configured: false, results: [], inventory: [] };
    const { institutionId } = await ctx.runQuery(
      internal.simplemdm.simpleMdmAccessContext,
      {},
    );
    const apiKey = simpleMdmApiKey();
    const { results, inventory } = await refreshSnapshotsForInstitution(
      ctx,
      apiKey,
      institutionId,
    );
    return { configured: true, results, inventory };
  },
});

/**
 * Scheduled twin of `verifySimpleMdmClaims` (crons.ts, hourly). The API key
 * is one tenant's, so this refreshes the primary institution's fleet only.
 * Unconfigured deployments return quietly; an API failure logs and leaves the
 * last good snapshot in place.
 */
export const refreshSimpleMdmSnapshots = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const apiKey = simpleMdmApiKeyOrNull();
    if (!apiKey) return;
    const institutionId = await ctx.runQuery(
      internal.simplemdm.primaryInstitutionForSnapshots,
      {},
    );
    if (!institutionId) return;
    try {
      await refreshSnapshotsForInstitution(ctx, apiKey, institutionId);
    } catch (error) {
      console.error(
        "refreshSimpleMdmSnapshots: SimpleMDM read-back failed:",
        simpleMdmErrorMessage(error, "unknown error"),
      );
    }
  },
});

export const primaryInstitutionForSnapshots = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"institutions"> | null> => {
    return await primaryInstitutionId(ctx);
  },
});

// ── Lost Mode ─────────────────────────────────────────────────────────
//
// A staff-only control, distinct from Rabbithole Lock: Rabbithole Lock is our
// own app-level Single App Mode toggle (convex/deviceLock.ts), applied by the
// native app itself and reversible by re-entering Rabbithole. This is Apple's
// OS-level supervised "Lost Mode" — SimpleMDM tells the device to show
// ONLY Apple's lock screen, and while it's active the device rejects most
// other MDM commands. It exists for a highly distracted scholar who needs the
// iPad fully taken away, not just walled off from other apps.
//
// Desired-state schema was deliberately NOT added: SimpleMDM is itself the
// durable owner of Lost Mode state, so the console always reads it back live
// (`lostModeStatus`) rather than tracking a second, possibly-stale copy.

/**
 * Resolve a `pairedDeviceId` to the SimpleMDM-enrolled serial (if any) for a
 * MUTATING device command, after confirming the caller may administer that
 * scholar. Shared by every such command — Lost Mode enable/disable and
 * `restartDevice` — so a new command inherits the tenant + scholar-access
 * check rather than growing a third copy of it. (The read-back status action
 * has its own twin, `pairedDeviceForLostModeStatus`, with a softer gate.)
 */
export const pairedDeviceForDeviceCommand = internalQuery({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scholarId: Id<"users">;
    serial: string | null;
    institutionId: Id<"institutions">;
  }> => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row || row.institutionId !== institutionId) {
      // ConvexError so the reason survives to the console: remote commands are
      // bound to the PRIMARY institution, so this is also what a device viewed
      // under another institution's lens hits, and "Server Error" would be an
      // unreadable answer to a legitimate question.
      throw new ConvexError("This iPad isn't available for remote commands.");
    }
    const claims = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_last_device_id", (q) => q.eq("lastDeviceId", row.deviceId))
      .collect();
    const claim =
      claims.find((candidate) => candidate.institutionId === institutionId) ??
      null;
    return { scholarId: row.scholarId, serial: claim?.serial ?? null, institutionId };
  },
});

export const pairedDeviceForLostModeStatus = internalQuery({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scholarId: Id<"users">;
    serial: string | null;
    institutionId: Id<"institutions">;
  }> => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row) {
      throw new Error("This iPad is not available for Lost Mode.");
    }
    if (
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        user,
        row.institutionId,
      ))
    ) {
      if (!(await hasAnySchoolOperationsAccess(ctx, user))) {
        throw new Error("Forbidden: school operations access required");
      }
      throw new Error("This iPad is not available for Lost Mode.");
    }
    const claims = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_last_device_id", (q) => q.eq("lastDeviceId", row.deviceId))
      .collect();
    const claim =
      claims.find((candidate) => candidate.institutionId === row.institutionId) ??
      null;
    return {
      scholarId: row.scholarId,
      serial: claim?.serial ?? null,
      institutionId: row.institutionId,
    };
  },
});

/**
 * Read-only-while-impersonating gate for every mutating device command. Must
 * be run — and awaited — BEFORE any real SimpleMDM request:
 * `assertCanWrite` only has DB access via a query/mutation, but
 * `setLostMode` and `restartDevice` are actions, so this is the mutation each
 * one calls first. Checking it only inside the later audit-log mutation (as
 * the original cut did) would let an impersonating admin's POST/DELETE reach
 * a real device before the write is ever rejected.
 */
export const assertDeviceCommandCallerNotImpersonating = internalMutation({
  args: {},
  handler: async (ctx) => {
    await assertCanWrite(ctx);
  },
});

/**
 * Rechecks the CURRENT caller's full authorization — not just impersonation
 * — and durably records the staff member's INTENT to send a Lost Mode
 * command, called immediately before the external SimpleMDM POST/DELETE,
 * never after it. This closes two races, not one:
 *
 *   1. Impersonation: if a session starts impersonating between the early
 *      `assertDeviceCommandCallerNotImpersonating` guard and this point, the real
 *      command could otherwise still reach SimpleMDM while the *only* audit
 *      write (previously done after the command) rejected — an unaudited
 *      device command.
 *   2. Authorization/mapping drift: the caller's role, tenant membership, or
 *      access to this scholar — and the paired device's SimpleMDM mapping —
 *      were all checked once, in `pairedDeviceForDeviceCommand`, before the
 *      awaited SimpleMDM list/detail reads that follow it in `setLostMode`.
 *      If a membership is revoked, a role changed, or the device is
 *      reassigned to a different scholar/serial while those reads are in
 *      flight, the stale caller/serial passed into this mutation would
 *      otherwise still be trusted. So this mutation re-derives EVERYTHING
 *      from the current DB state — the current user via `requireSimpleMdmAccess`,
 *      the current paired-device row, `requireScholarsAccessible` for its
 *      CURRENT scholar, and the CURRENT managed-claim serial — and rejects if
 *      any of it no longer matches what the action resolved earlier, before
 *      ever recording intent or allowing the write to proceed.
 *
 * Rechecking + auditing in one mutation right before the write means any
 * command that can be sent has already been durably, authorizedly recorded
 * against CURRENT access; if the write itself later fails, "requested"
 * remains an accurate description (we never claim sent/applied here — that
 * would be recorded, and worded, separately).
 */
export const recordLostModeCommandIntent = internalMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    expectedSerial: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Re-derive the caller, tenant, paired device, scholar access, and
    // SimpleMDM mapping from CURRENT state — never trust anything the action
    // resolved before its awaited SimpleMDM reads.
    const { user, institutionId } = await requireSimpleMdmAccess(ctx);
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row || row.institutionId !== institutionId) {
      throw new Error("This iPad is not available for Lost Mode.");
    }

    const claims = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_last_device_id", (q) => q.eq("lastDeviceId", row.deviceId))
      .collect();
    const claim =
      claims.find((candidate) => candidate.institutionId === institutionId) ??
      null;
    const currentSerial = claim?.serial ?? null;
    if (currentSerial !== args.expectedSerial) {
      throw new Error(
        "This iPad's SimpleMDM enrollment changed while checking its status. Refresh and try again.",
      );
    }

    await assertCanWrite(ctx);

    await writeAuditLog(ctx, {
      institutionId: institutionId,
      actorUserId: user._id,
      action: args.enabled
        ? "device.lost-mode.enable.requested"
        : "device.lost-mode.disable.requested",
      targetUserId: row.scholarId,
      at: Date.now(),
      // "Requested" — this runs BEFORE the SimpleMDM request is sent, so it
      // records only that an authorized staff member asked for the command,
      // never that it was sent or applied.
      detail: `${
        args.enabled ? "Requested command to enable" : "Requested command to disable"
      } Lost Mode via SimpleMDM; serial ${args.expectedSerial}`,
    });
  },
});

/**
 * Read one device's current attributes from SimpleMDM and record them in its
 * snapshot row, so the console's dated copy is refreshed by every real read.
 */
async function readDeviceAttributes(
  ctx: ActionCtx,
  apiKey: string,
  institutionId: Id<"institutions">,
  serial: string,
): Promise<SimpleMdmDeviceDetails | null> {
  const details = await withSimpleMdmDeviceId(
    ctx,
    apiKey,
    institutionId,
    serial,
    async (simpleMdmDeviceId) =>
      simpleMdmDeviceId
        ? await fetchDeviceAttributes(apiKey, simpleMdmDeviceId, serial)
        : null,
  );
  await ctx.runMutation(internal.simplemdm.recordDeviceInventory, {
    institutionId,
    serial,
    device: details,
  });
  return details;
}

/**
 * Explicit read-back of an iPad's Lost Mode state, resolved fresh from
 * SimpleMDM so a remote command is never mistaken for an applied state. The
 * console calls this from its "Refresh" button — not on drawer open; the
 * drawer renders the dated snapshot until staff ask. Mirrors
 * `verifySimpleMdmClaims`'s "unconfigured is not an error" posture: every
 * non-actionable case (not configured, not enrolled, not supervised) is a
 * normal `LostModeState`, not a thrown error.
 */
export const lostModeStatus = action({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (ctx, args): Promise<LostModeState> => {
    const resolved = await ctx.runQuery(
      internal.simplemdm.pairedDeviceForLostModeStatus,
      { pairedDeviceId: args.pairedDeviceId },
    );
    const { configured } = await ctx.runQuery(api.simplemdm.integrationStatus, {});
    if (!configured) {
      return {
        configured: false,
        foundInSimpleMdm: false,
        isSupervised: null,
        lostModeEnabled: null,
      };
    }
    if (!resolved.serial) {
      return {
        configured: true,
        foundInSimpleMdm: false,
        isSupervised: null,
        lostModeEnabled: null,
      };
    }
    const apiKey = simpleMdmApiKey();
    const attributes = await readDeviceAttributes(
      ctx,
      apiKey,
      resolved.institutionId,
      resolved.serial,
    );
    if (!attributes) {
      return {
        configured: true,
        foundInSimpleMdm: false,
        isSupervised: null,
        lostModeEnabled: null,
      };
    }
    return {
      configured: true,
      foundInSimpleMdm: true,
      isSupervised: attributes.isSupervised,
      lostModeEnabled: attributes.lostModeEnabled,
    };
  },
});

/**
 * Enable ("Disable Lost Mode" action) or disable ("Enable Lost Mode" action)
 * Apple's supervised Lost Mode via SimpleMDM. Refuses unless SimpleMDM affirmatively
 * reports the device supervised — an unreported (`null`) supervision state is
 * treated the same as `false`, since a command sent on a guess could silently
 * no-op rather than actually disable anything. SimpleMDM queues the command
 * (202) when the device is offline; a queued command is not the same as an
 * applied one, so the caller should re-read `lostModeStatus` rather than
 * assume success from this call alone.
 *
 * The lock-screen message is always the fixed, neutral
 * `DEFAULT_LOST_MODE_MESSAGE` — callers cannot supply arbitrary text for a
 * kid's lock screen.
 *
 * Audit ordering: impersonation is checked twice — once early (before any
 * SimpleMDM read) and again, together with a full revalidation of
 * authorization and the durable "requested" audit write, immediately before
 * the state-changing POST/DELETE. That final recheck (`recordLostModeCommandIntent`)
 * re-derives the caller's role/tenant, this scholar's accessibility, and the
 * device's current SimpleMDM serial mapping from scratch — it never trusts
 * the caller identity or serial resolved earlier in this action, since those
 * were read before the awaited SimpleMDM list/detail calls above, during
 * which the caller's access or the device's mapping could have changed. This
 * means the audit record always exists, against CURRENT access, before any
 * real command can be sent — so a session that starts impersonating mid-call,
 * loses its scholar access mid-call, or targets a device that gets reassigned
 * mid-call can never produce an unaudited or wrongly-authorized device
 * command, and a write that fails after being requested still leaves an
 * accurate "requested" (not "sent"/"applied") record behind.
 */
export const setLostMode = action({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args): Promise<SetLostModeResult> => {
    // Enforced BEFORE any request reaches SimpleMDM — an admin viewing-as
    // another user must never be able to command a real device.
    await ctx.runMutation(internal.simplemdm.assertDeviceCommandCallerNotImpersonating, {});

    const resolved = await ctx.runQuery(internal.simplemdm.pairedDeviceForDeviceCommand, {
      pairedDeviceId: args.pairedDeviceId,
    });
    if (!resolved.serial) {
      throw new Error("This iPad isn't enrolled in SimpleMDM yet.");
    }
    const apiKey = simpleMdmApiKey();
    const attributes = await readDeviceAttributes(
      ctx,
      apiKey,
      resolved.institutionId,
      resolved.serial,
    );
    if (!attributes) {
      throw new Error("SimpleMDM has no enrolled record for this iPad's serial.");
    }
    const simpleMdmDeviceId = attributes.id;
    if (attributes.isSupervised !== true) {
      throw new Error(
        "Lost Mode requires a supervised iPad, and SimpleMDM did not report this device as supervised.",
      );
    }

    // Fully revalidate the CURRENT caller's authorization, tenant, scholar
    // access, and this device's SimpleMDM serial mapping — and recheck
    // impersonation — then durably record intent, all immediately before the
    // external write, not after it. A session that starts impersonating,
    // loses access, or targets a device whose mapping changed between the
    // early guard above and this point must still be caught before any real
    // command is sent; and once this succeeds, the command is
    // authorized-and-audited even if the SimpleMDM request that follows
    // fails for an unrelated reason.
    await ctx.runMutation(internal.simplemdm.recordLostModeCommandIntent, {
      pairedDeviceId: args.pairedDeviceId,
      expectedSerial: resolved.serial,
      enabled: args.enabled,
    });

    const { queued } = args.enabled
      ? await enableLostModeOnSimpleMdmDevice(
          apiKey,
          simpleMdmDeviceId,
          DEFAULT_LOST_MODE_MESSAGE,
        )
      : await disableLostModeOnSimpleMdmDevice(apiKey, simpleMdmDeviceId);

    const commandDescription = args.enabled
      ? "Command sent to SimpleMDM to enable Lost Mode."
      : "Command sent to SimpleMDM to disable Lost Mode.";
    const readyWhen = queued
      ? "It's queued and will apply once the iPad is next online."
      : "SimpleMDM accepted it immediately.";

    return {
      queued,
      message: `${commandDescription} ${readyWhen}`,
    };
  },
});

/**
 * Rechecks the CURRENT caller's full authorization and durably records the
 * staff member's INTENT to restart an iPad, immediately before the external
 * SimpleMDM POST — never after it. Same discipline, and for the same two
 * races, as `recordLostModeCommandIntent` above: the caller, tenant,
 * paired-device row, assigned scholar and CURRENT managed-claim serial are all
 * re-derived from live DB state rather than trusted from what `restartDevice`
 * resolved before its awaited SimpleMDM reads, and impersonation is rechecked
 * here too.
 *
 * It does NOT re-run `requireScholarsAccessible`, and does not need to:
 * `requireSimpleMdmAccess` grants school operations at the institution, which
 * covers every scholar in it. The explicit scholar comparison below buys
 * accuracy, not authorization.
 */
export const recordDeviceRestartIntent = internalMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    expectedSerial: v.string(),
    expectedScholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const { user, institutionId } = await requireSimpleMdmAccess(ctx);
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row || row.institutionId !== institutionId) {
      throw new ConvexError("This iPad isn't available for remote commands.");
    }
    // The serial check below cannot see a reassignment that KEEPS the serial:
    // the same physical iPad handed to a different scholar. Authorization is
    // unaffected (school operations covers every scholar at the institution),
    // but the audit row would name a scholar staff never selected, and staff
    // would be rebooting a device that is no longer the one they looked at.
    if (row.scholarId !== args.expectedScholarId) {
      throw new ConvexError(
        "This iPad was reassigned to a different scholar while checking its status. Refresh and try again.",
      );
    }

    const claims = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_last_device_id", (q) => q.eq("lastDeviceId", row.deviceId))
      .collect();
    const claim =
      claims.find((candidate) => candidate.institutionId === institutionId) ??
      null;
    const currentSerial = claim?.serial ?? null;
    if (currentSerial !== args.expectedSerial) {
      throw new ConvexError(
        "This iPad's SimpleMDM enrollment changed while checking its status. Refresh and try again.",
      );
    }

    await assertCanWrite(ctx);

    await writeAuditLog(ctx, {
      institutionId: institutionId,
      actorUserId: user._id,
      action: "device.restart.requested",
      targetUserId: row.scholarId,
      at: Date.now(),
      // "Requested" — this runs BEFORE the SimpleMDM request is sent, so it
      // records only that an authorized staff member asked for the restart,
      // never that the iPad rebooted.
      detail: `Requested a restart via SimpleMDM; serial ${args.expectedSerial}`,
    });
  },
});

/**
 * Restart one iPad over SimpleMDM — the escape hatch for a wedged app.
 *
 * Why this exists next to "Force sign out": on a MANAGED device that action
 * runs `decommissionManagedClaim`, which invalidates the enrollment key, so
 * the iPad cannot sign itself back in until staff push a fresh one. Using it
 * merely to unstick a frozen screen costs the scholar their session and a
 * staff follow-up. A restart costs neither and needs no cooperation from the
 * app, which is the whole point when the app is what's wedged.
 *
 * The guard sequence mirrors `setLostMode` exactly — impersonation before any
 * SimpleMDM traffic, supervision checked against a live read, then full
 * re-authorization + audit immediately before the write.
 */
export const restartDevice = action({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (ctx, args): Promise<RestartDeviceResult> => {
    // Enforced BEFORE any request reaches SimpleMDM — an admin viewing-as
    // another user must never be able to reboot a real device.
    await ctx.runMutation(
      internal.simplemdm.assertDeviceCommandCallerNotImpersonating,
      {},
    );

    const resolved = await ctx.runQuery(
      internal.simplemdm.pairedDeviceForDeviceCommand,
      { pairedDeviceId: args.pairedDeviceId },
    );
    // ConvexError, not Error, for all three refusals below: Convex replaces a
    // plain Error's message with an opaque "Server Error" in prod (see
    // `lib/simpleMdmClient.ts`). Lost Mode can afford plain throws because its
    // UI only offers the button once the snapshot proves the device eligible;
    // Restart is deliberately offered on an unknown snapshot, so a refusal IS
    // the normal way staff learn why — it has to reach the toast intact.
    if (!resolved.serial) {
      throw new ConvexError("This iPad isn't enrolled in SimpleMDM yet.");
    }
    const apiKey = simpleMdmApiKey();
    const attributes = await readDeviceAttributes(
      ctx,
      apiKey,
      resolved.institutionId,
      resolved.serial,
    );
    if (!attributes) {
      throw new ConvexError(
        "SimpleMDM has no enrolled record for this iPad's serial.",
      );
    }
    // Apple lists RestartDevice as iOS/iPadOS (Supervised). An unreported
    // (null) supervision state refuses too — the same posture Lost Mode
    // takes, so an unverifiable device never receives a doomed command.
    if (attributes.isSupervised !== true) {
      throw new ConvexError(
        "Restarting requires a supervised iPad, and SimpleMDM did not report this device as supervised.",
      );
    }

    await ctx.runMutation(internal.simplemdm.recordDeviceRestartIntent, {
      pairedDeviceId: args.pairedDeviceId,
      expectedSerial: resolved.serial,
      expectedScholarId: resolved.scholarId,
    });

    const { queued } = await restartSimpleMdmDevice(apiKey, attributes.id);

    return {
      queued,
      message: queued
        ? "Restart command sent to SimpleMDM. It's queued and will apply once the iPad is next online."
        : "Restart command sent to SimpleMDM. SimpleMDM accepted it immediately.",
    };
  },
});

/**
 * First-party fleet check, run at the institution's first bell. SimpleMDM reports
 * the most recent inventory value, so the alert includes each device's
 * last-seen time rather than implying the percentage is a live telemetry feed.
 */
export const checkLowBatteryAtSchoolStart = internalAction({
  args: { nowMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<LowBatteryCheckResult> => {
    const context: BatteryAlertContext = await ctx.runQuery(
      internal.simplemdm.batteryAlertContext,
      { nowMs: args.nowMs ?? Date.now() },
    );
    if (
      !context.isSchoolDay ||
      !context.institutionId ||
      !context.dayKey ||
      !context.timeZone
    ) {
      return { status: "not-a-school-day" as const, lowBatteryCount: 0 };
    }

    const apiKey = simpleMdmApiKeyOrNull();
    if (!apiKey) {
      console.warn(
        "checkLowBatteryAtSchoolStart: SIMPLEMDM_API_KEY is not configured.",
      );
      return { status: "not-configured" as const, lowBatteryCount: 0 };
    }

    let bySerial: Map<string, SimpleMdmDeviceDetails>;
    try {
      bySerial = await listSimpleMdmDevices(apiKey);
    } catch (error) {
      console.error(
        "checkLowBatteryAtSchoolStart: SimpleMDM inventory failed:",
        error,
      );
      return { status: "api-error" as const, lowBatteryCount: 0 };
    }

    const lowBatteryDevices: LowBatteryAlertDevice[] = context.devices.flatMap(
      (device) => {
        const details = bySerial.get(device.serial.trim().toUpperCase());
        const batteryLevel = details?.batteryLevel ?? null;
        if (
          !details ||
          batteryLevel === null ||
          deviceBatteryBand(batteryLevel) !== "low"
        ) {
          return [];
        }
        return [
          {
            scholarName: device.scholarName,
            batteryLevel,
            lastSeenAt: details.lastSeenAt,
          },
        ];
      },
    );
    if (lowBatteryDevices.length === 0) {
      return { status: "clear" as const, lowBatteryCount: 0 };
    }

    await ctx.runMutation(internal.simplemdm.raiseLowBatteryAlert, {
      institutionId: context.institutionId,
      dayKey: context.dayKey,
      timeZone: context.timeZone,
      devices: lowBatteryDevices,
    });
    return {
      status: "alerted" as const,
      lowBatteryCount: lowBatteryDevices.length,
    };
  },
});
