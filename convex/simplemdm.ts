/**
 * SimpleMDM claim delivery for a primary institution's physical iPad fleet.
 *
 * This integration is intentionally first-party-only: the API key controls one
 * institution's SimpleMDM tenant. Other institutions get a legible refusal
 * until they have a real tenant and contract of their own.
 */
import { v } from "convex/values";
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
  assertNotImpersonating,
  requireUser,
} from "./lib/auth";
import { primaryInstitutionId } from "./institutions";
import {
  auditManagedClaim,
  stageClaimReplacementForSimpleMdm,
} from "./managedDeviceClaims";
import { ROLES } from "./lib/roles";
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

const SIMPLEMDM_API_BASE = "https://a.simplemdm.com/api/v1";
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

function authorizationHeader(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

type SimpleMdmDevice = {
  id: string | number;
  attributes?: {
    serial_number?: unknown;
    name?: unknown;
    battery_level?: unknown;
    last_seen_at?: unknown;
    is_supervised?: unknown;
    lost_mode_enabled?: unknown;
  };
};

type SimpleMdmDeviceDetails = {
  id: string;
  name: string | null;
  batteryLevel: number | null;
  lastSeenAt: number | null;
  isSupervised: boolean | null;
  lostModeEnabled: boolean | null;
};

type SimpleMdmListResponse = {
  data?: unknown;
  has_more?: unknown;
  next?: unknown;
};

class SimpleMdmApiError extends Error {}

/**
 * Page through the SimpleMDM device roster, invoking `onPage` for each page.
 * The callback can stop the walk early by returning `true`.
 *
 * `include_awaiting_enrollment=true` is load-bearing, not an optimization.
 * SimpleMDM's device list omits ADE-assigned devices that have not completed
 * Setup Assistant unless it is passed, and a still-boxed fleet iPad is exactly
 * the device whose claim we most want staged: SimpleMDM already holds a device
 * record for it (custom attribute values are readable and writable), so writing
 * the claim now is what makes the scholar's first unbox zero-touch. Without the
 * parameter every unopened iPad reported "not enrolled in SimpleMDM yet" — which
 * inverted the feature, since the claim can only be pre-staged before enrollment.
 *
 * Callers that need many serials (verification and bulk pushes) share ONE walk
 * of the roster.
 */
async function walkSimpleMdmDevicePages(
  apiKey: string,
  onPage: (devices: SimpleMdmDevice[]) => boolean,
): Promise<void> {
  let startingAfter: string | null = null;
  const seenCursors = new Set<string>();

  for (let page = 0; page < 500; page += 1) {
    const url = new URL(`${SIMPLEMDM_API_BASE}/devices`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("include_awaiting_enrollment", "true");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: authorizationHeader(apiKey) },
      });
    } catch (error) {
      throw new SimpleMdmApiError(
        `Could not reach SimpleMDM: ${
          error instanceof Error ? error.message : "Network request failed."
        }`,
      );
    }
    if (!response.ok) {
      throw new SimpleMdmApiError(
        `SimpleMDM returned HTTP ${response.status} while listing devices.`,
      );
    }

    let payload: SimpleMdmListResponse;
    try {
      payload = (await response.json()) as SimpleMdmListResponse;
    } catch {
      throw new SimpleMdmApiError(
        "SimpleMDM returned an unreadable device list.",
      );
    }
    if (!Array.isArray(payload.data)) {
      throw new SimpleMdmApiError(
        "SimpleMDM returned an invalid device list.",
      );
    }

    const devices = payload.data as SimpleMdmDevice[];
    if (onPage(devices)) return;
    if (payload.has_more !== true) return;

    const lastId = devices.at(-1)?.id;
    const next =
      typeof payload.next === "string" || typeof payload.next === "number"
        ? String(payload.next)
        : lastId === undefined
          ? null
          : String(lastId);
    if (!next || seenCursors.has(next)) {
      throw new SimpleMdmApiError(
        "SimpleMDM device pagination stopped before the roster was complete.",
      );
    }
    seenCursors.add(next);
    startingAfter = next;
  }

  throw new SimpleMdmApiError(
    "SimpleMDM device pagination exceeded the safety limit.",
  );
}

async function listSimpleMdmDevices(
  apiKey: string,
): Promise<Map<string, SimpleMdmDeviceDetails>> {
  const bySerial = new Map<string, SimpleMdmDeviceDetails>();
  await walkSimpleMdmDevicePages(apiKey, (devices) => {
    for (const device of devices) {
      const serial = device.attributes?.serial_number;
      if (typeof serial === "string") {
        const key = serial.trim().toUpperCase();
        // First record wins if a serial somehow appears twice.
        if (key && !bySerial.has(key)) {
          const batteryMatch =
            typeof device.attributes?.battery_level === "string"
              ? device.attributes.battery_level.trim().match(/^(\d{1,3})%$/)
              : null;
          const batteryLevel = batteryMatch ? Number(batteryMatch[1]) : null;
          const parsedLastSeen =
            typeof device.attributes?.last_seen_at === "string"
              ? Date.parse(device.attributes.last_seen_at)
              : Number.NaN;
          const name =
            typeof device.attributes?.name === "string"
              ? device.attributes.name.trim() || null
              : null;
          bySerial.set(key, {
            id: String(device.id),
            name,
            batteryLevel:
              batteryLevel !== null && batteryLevel <= 100 ? batteryLevel : null,
            lastSeenAt: Number.isFinite(parsedLastSeen) ? parsedLastSeen : null,
            isSupervised:
              typeof device.attributes?.is_supervised === "boolean"
                ? device.attributes.is_supervised
                : null,
            lostModeEnabled:
              typeof device.attributes?.lost_mode_enabled === "boolean"
                ? device.attributes.lost_mode_enabled
                : null,
          });
        }
      }
    }
    return false;
  });
  return bySerial;
}

/**
 * Find one device by serial, stopping the paginated roster walk as soon as it
 * is found. Bulk callers should use `listSimpleMdmDevices` instead.
 */
async function resolveSimpleMdmDeviceId(
  apiKey: string,
  serial: string,
): Promise<string | null> {
  const targetSerial = serial.trim().toUpperCase();
  let foundDeviceId: string | null = null;
  await walkSimpleMdmDevicePages(apiKey, (devices) => {
    const found = devices.find(
      (device) =>
        typeof device.attributes?.serial_number === "string" &&
        device.attributes.serial_number.trim().toUpperCase() === targetSerial,
    );
    if (!found) return false;
    foundDeviceId = String(found.id);
    return true;
  });
  return foundDeviceId;
}

type SimpleMdmDeviceDetailResponse = {
  data?: {
    attributes?: {
      is_supervised?: unknown;
      lost_mode_enabled?: unknown;
    };
  };
};

/**
 * `GET /devices/{id}` — read-only, ground-truth for `is_supervised` (Managed
 * Lost Mode only works on a supervised device) and `lost_mode_enabled` (is a
 * previously-sent enable/disable command actually reflected by SimpleMDM
 * yet). Missing/non-boolean attributes resolve to `null` — "not reported" —
 * rather than fabricating a state.
 */
async function fetchDeviceAttributes(
  apiKey: string,
  simpleMdmDeviceId: string,
): Promise<{ isSupervised: boolean | null; lostModeEnabled: boolean | null }> {
  const url = `${SIMPLEMDM_API_BASE}/devices/${encodeURIComponent(simpleMdmDeviceId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: authorizationHeader(apiKey) },
    });
  } catch (error) {
    throw new SimpleMdmApiError(
      `Could not reach SimpleMDM: ${
        error instanceof Error ? error.message : "Network request failed."
      }`,
    );
  }
  if (!response.ok) {
    throw new SimpleMdmApiError(
      `SimpleMDM returned HTTP ${response.status} while reading the device.`,
    );
  }

  let payload: SimpleMdmDeviceDetailResponse;
  try {
    payload = (await response.json()) as SimpleMdmDeviceDetailResponse;
  } catch {
    throw new SimpleMdmApiError("SimpleMDM returned an unreadable device response.");
  }
  const attributes = payload.data?.attributes;
  return {
    isSupervised:
      typeof attributes?.is_supervised === "boolean"
        ? attributes.is_supervised
        : null,
    lostModeEnabled:
      typeof attributes?.lost_mode_enabled === "boolean"
        ? attributes.lost_mode_enabled
        : null,
  };
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
  const url = `${SIMPLEMDM_API_BASE}/devices/${encodeURIComponent(simpleMdmDeviceId)}/lost_mode`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorizationHeader(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
  } catch (error) {
    throw new SimpleMdmApiError(
      `Could not reach SimpleMDM: ${
        error instanceof Error ? error.message : "Network request failed."
      }`,
    );
  }
  if (!response.ok) {
    throw new SimpleMdmApiError(
      `SimpleMDM returned HTTP ${response.status} while enabling Lost Mode.`,
    );
  }
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
  const url = `${SIMPLEMDM_API_BASE}/devices/${encodeURIComponent(simpleMdmDeviceId)}/lost_mode`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: authorizationHeader(apiKey) },
    });
  } catch (error) {
    throw new SimpleMdmApiError(
      `Could not reach SimpleMDM: ${
        error instanceof Error ? error.message : "Network request failed."
      }`,
    );
  }
  if (!response.ok) {
    throw new SimpleMdmApiError(
      `SimpleMDM returned HTTP ${response.status} while disabling Lost Mode.`,
    );
  }
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
  const url =
    `${SIMPLEMDM_API_BASE}/devices/${encodeURIComponent(simpleMdmDeviceId)}` +
    `/custom_attribute_values`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: authorizationHeader(apiKey) },
    });
  } catch (error) {
    throw new SimpleMdmApiError(
      `Could not reach SimpleMDM: ${
        error instanceof Error ? error.message : "Network request failed."
      }`,
    );
  }
  if (!response.ok) {
    throw new SimpleMdmApiError(
      `SimpleMDM returned HTTP ${response.status} while reading the device claim.`,
    );
  }

  let payload: SimpleMdmListResponse;
  try {
    payload = (await response.json()) as SimpleMdmListResponse;
  } catch {
    throw new SimpleMdmApiError(
      "SimpleMDM returned an unreadable custom-attribute list.",
    );
  }
  if (!Array.isArray(payload.data)) {
    throw new SimpleMdmApiError(
      "SimpleMDM returned an invalid custom-attribute list.",
    );
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
  const url =
    `${SIMPLEMDM_API_BASE}/devices/${encodeURIComponent(simpleMdmDeviceId)}` +
    `/custom_attribute_values/${CLAIM_ATTRIBUTE}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: authorizationHeader(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: claimToken }),
    });
  } catch (error) {
    throw new SimpleMdmApiError(
      `Could not reach SimpleMDM: ${
        error instanceof Error ? error.message : "Network request failed."
      }`,
    );
  }
  if (!response.ok) {
    // Do not include the response body: an error page could echo the claim token.
    throw new SimpleMdmApiError(
      `SimpleMDM returned HTTP ${response.status} while updating the claim.`,
    );
  }
}

async function renameSimpleMdmDevice(
  apiKey: string,
  simpleMdmDeviceId: string,
  name: string,
): Promise<string> {
  const url = `${SIMPLEMDM_API_BASE}/devices/${encodeURIComponent(simpleMdmDeviceId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: authorizationHeader(apiKey),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ name }).toString(),
    });
  } catch (error) {
    throw new SimpleMdmApiError(
      `Could not reach SimpleMDM: ${
        error instanceof Error ? error.message : "Network request failed."
      }`,
    );
  }
  if (!response.ok) {
    throw new SimpleMdmApiError(
      `SimpleMDM returned HTTP ${response.status} while renaming the device.`,
    );
  }

  let payload: { data?: { attributes?: { name?: unknown } } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new SimpleMdmApiError(
      "SimpleMDM renamed the device but returned an unreadable response.",
    );
  }
  const savedName = payload.data?.attributes?.name;
  if (typeof savedName !== "string" || !savedName.trim()) {
    throw new SimpleMdmApiError(
      "SimpleMDM renamed the device but did not return its saved name.",
    );
  }
  return savedName.trim();
}

export const managedDeviceForPush = internalQuery({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args) => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row || row.institutionId !== institutionId) {
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
    };
  },
});

export const prepareSimpleMdmRename = internalMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args) => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
    await assertNotImpersonating(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row || row.institutionId !== institutionId) {
      throw new Error("That device is not available for SimpleMDM management.");
    }
    return { serial: row.serial };
  },
});

export const recordSimpleMdmRename = internalMutation({
  args: {
    managedDeviceId: v.id("managedDeviceClaims"),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const { user, institutionId } = await requireSimpleMdmAccess(ctx);
    await assertNotImpersonating(ctx);
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
    }));
  },
});

export const assignedManagedDevicesForVerify = internalQuery({
  args: {},
  handler: async (ctx) => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
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
  args: {},
  handler: async (ctx) => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
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
    const { user, institutionId } = await requireSimpleMdmAccess(ctx);
    await assertNotImpersonating(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    if (
      !row ||
      row.institutionId !== institutionId ||
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
    const { user, institutionId } = await requireSimpleMdmAccess(ctx);
    await assertNotImpersonating(ctx);
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row || row.institutionId !== institutionId || !row.scholarId) {
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
  },
  apiKey: string,
  mappedSimpleMdmDeviceId?: string | null,
): Promise<SimpleMdmPushResult> {
  let simpleMdmDeviceId: string | null;
  try {
    simpleMdmDeviceId =
      mappedSimpleMdmDeviceId === undefined
        ? await resolveSimpleMdmDeviceId(apiKey, device.serial)
        : mappedSimpleMdmDeviceId;
  } catch (error) {
    return {
      ...device,
      status: "api-error",
      message:
        error instanceof Error
          ? error.message
          : "SimpleMDM could not list enrolled devices.",
    };
  }
  if (!simpleMdmDeviceId) {
    return {
      ...device,
      status: "device-not-found-in-simplemdm",
      message:
        "SimpleMDM has no record of this serial. Check the serial, then confirm " +
        "the iPad is assigned to SimpleMDM in Apple School Manager and the ADE " +
        "sync has run.",
    };
  }

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
      ...device,
      status: "api-error",
      message: "Rabbithole couldn't mint a fresh claim for this device.",
    };
  }
  try {
    await writeClaimAttribute(
      apiKey,
      simpleMdmDeviceId,
      minted.claimToken,
    );
  } catch (error) {
    return {
      ...device,
      status: "api-error",
      message:
        error instanceof Error
          ? error.message
          : "SimpleMDM could not update the device claim.",
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
      ...device,
      status: "api-error",
      message:
        "The claim reached SimpleMDM, but Rabbithole couldn't record the push. Push it again.",
    };
  }
  if (!recorded.recorded) {
    return {
      ...device,
      status: "api-error",
      message:
        "The device assignment changed during the push. Push it again to send the current claim.",
    };
  }

  return {
    ...device,
    status: "pushed",
    message: "Claim pushed to SimpleMDM.",
  };
}

export const pushClaimToSimpleMdm = action({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args): Promise<SimpleMdmPushResult> => {
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
    const devices: Array<{
      managedDeviceId: Id<"managedDeviceClaims">;
      serial: string;
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
          ...device,
          status: "api-error",
          message:
            error instanceof Error
              ? error.message
              : "SimpleMDM could not list enrolled devices.",
        })),
      };
    }
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
    const simpleMdmDeviceId = await resolveSimpleMdmDeviceId(
      apiKey,
      device.serial,
    );
    if (!simpleMdmDeviceId) {
      throw new Error(
        "SimpleMDM has no record of this serial. Confirm the device is enrolled, then try again.",
      );
    }
    const simpleMdmName = await renameSimpleMdmDevice(
      apiKey,
      simpleMdmDeviceId,
      name,
    );
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

/**
 * Reconcile every assigned, non-revoked device against SimpleMDM's ground truth
 * so the console can hide the "Push" button when the stored claim already
 * matches. The same roster response carries battery and last-seen inventory for
 * every managed device, including unassigned devices. Pages the roster ONCE,
 * then reads each assigned device's stored claim and compares its sha256 to the
 * hash Rabbithole holds. Any SimpleMDM API failure throws (the console surfaces
 * it) rather than fabricating a partial answer.
 *
 * The console fires this AUTOMATICALLY on mount, so "this deployment has no
 * SimpleMDM" must not be an error — it would raise on every page load for every
 * institution that never adopts SimpleMDM. Unconfigured returns
 * `{ configured: false, results: [], inventory: [] }` instead.
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
    const devices = await ctx.runQuery(
      internal.simplemdm.assignedManagedDevicesForVerify,
      {},
    );
    const inventoryDevices: Array<{
      managedDeviceId: Id<"managedDeviceClaims">;
      serial: string;
    }> = await ctx.runQuery(
      internal.simplemdm.managedDevicesForInventory,
      {},
    );
    const apiKey = simpleMdmApiKey();
    const bySerial = await listSimpleMdmDevices(apiKey);
    const inventory = inventoryDevices.map((device) => {
      const details = bySerial.get(device.serial.trim().toUpperCase());
      return {
        managedDeviceId: device.managedDeviceId,
        serial: device.serial,
        foundInSimpleMdm: details !== undefined,
        simpleMdmName: details?.name ?? null,
        batteryLevel: details?.batteryLevel ?? null,
        lastSeenAt: details?.lastSeenAt ?? null,
        isSupervised: details?.isSupervised ?? null,
        lostModeEnabled: details?.lostModeEnabled ?? null,
      };
    });

    const results: SimpleMdmVerifyResult[] = [];
    for (const device of devices) {
      const simpleMdmDevice = bySerial.get(device.serial.trim().toUpperCase());
      if (!simpleMdmDevice) {
        results.push({
          managedDeviceId: device.managedDeviceId,
          serial: device.serial,
          status: "not-in-simplemdm",
        });
        continue;
      }
      const storedValue = await fetchClaimAttributeValue(
        apiKey,
        simpleMdmDevice.id,
      );
      const storedHash = storedValue ? await sha256Hex(storedValue) : null;
      results.push({
        managedDeviceId: device.managedDeviceId,
        serial: device.serial,
        status:
          storedHash === device.claimTokenHash ||
          storedHash === device.pendingClaimTokenHash
            ? "in-sync"
            : "stale",
      });
    }
    return { configured: true, results, inventory };
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
 * Resolve a `pairedDeviceId` to the SimpleMDM-enrolled serial (if any) for
 * Lost Mode calls, after confirming the caller may administer that scholar.
 * Shared by both the read-back status action and the enable/disable action.
 */
export const pairedDeviceForLostMode = internalQuery({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (
    ctx,
    args,
  ): Promise<{ scholarId: Id<"users">; serial: string | null }> => {
    const { institutionId } = await requireSimpleMdmAccess(ctx);
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
    return { scholarId: row.scholarId, serial: claim?.serial ?? null };
  },
});

export const pairedDeviceForLostModeStatus = internalQuery({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (
    ctx,
    args,
  ): Promise<{ scholarId: Id<"users">; serial: string | null }> => {
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
    return { scholarId: row.scholarId, serial: claim?.serial ?? null };
  },
});

/**
 * Read-only-while-impersonating gate for Lost Mode's mutating action. Must be
 * run — and awaited — BEFORE any real SimpleMDM request: `assertNotImpersonating`
 * only has DB access via a query/mutation, but `setLostMode` is an action, so
 * this is the query the action calls first. Checking it only inside the later
 * audit-log mutation (as the original cut did) would let an impersonating
 * admin's POST/DELETE reach a real device before the write is ever rejected.
 */
export const assertLostModeCallerNotImpersonating = internalMutation({
  args: {},
  handler: async (ctx) => {
    await assertNotImpersonating(ctx);
  },
});

/**
 * Rechecks the CURRENT caller's full authorization — not just impersonation
 * — and durably records the staff member's INTENT to send a Lost Mode
 * command, called immediately before the external SimpleMDM POST/DELETE,
 * never after it. This closes two races, not one:
 *
 *   1. Impersonation: if a session starts impersonating between the early
 *      `assertLostModeCallerNotImpersonating` guard and this point, the real
 *      command could otherwise still reach SimpleMDM while the *only* audit
 *      write (previously done after the command) rejected — an unaudited
 *      device command.
 *   2. Authorization/mapping drift: the caller's role, tenant membership, or
 *      access to this scholar — and the paired device's SimpleMDM mapping —
 *      were all checked once, in `pairedDeviceForLostMode`, before the
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

    await assertNotImpersonating(ctx);

    await ctx.db.insert("auditLog", {
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
 * Live read-back of an iPad's Lost Mode state — never stored, always
 * resolved fresh from SimpleMDM so a remote command is never mistaken for an
 * applied state. Mirrors `verifySimpleMdmClaims`'s "unconfigured is not an
 * error" posture: every non-actionable case (not configured, not enrolled,
 * not supervised) is a normal `LostModeState`, not a thrown error.
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
    const simpleMdmDeviceId = await resolveSimpleMdmDeviceId(apiKey, resolved.serial);
    if (!simpleMdmDeviceId) {
      return {
        configured: true,
        foundInSimpleMdm: false,
        isSupervised: null,
        lostModeEnabled: null,
      };
    }
    const attributes = await fetchDeviceAttributes(apiKey, simpleMdmDeviceId);
    return { configured: true, foundInSimpleMdm: true, ...attributes };
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
    await ctx.runMutation(internal.simplemdm.assertLostModeCallerNotImpersonating, {});

    const resolved = await ctx.runQuery(internal.simplemdm.pairedDeviceForLostMode, {
      pairedDeviceId: args.pairedDeviceId,
    });
    if (!resolved.serial) {
      throw new Error("This iPad isn't enrolled in SimpleMDM yet.");
    }
    const apiKey = simpleMdmApiKey();
    const simpleMdmDeviceId = await resolveSimpleMdmDeviceId(apiKey, resolved.serial);
    if (!simpleMdmDeviceId) {
      throw new Error("SimpleMDM has no enrolled record for this iPad's serial.");
    }
    const attributes = await fetchDeviceAttributes(apiKey, simpleMdmDeviceId);
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
