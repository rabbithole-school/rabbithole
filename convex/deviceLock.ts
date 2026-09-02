/**
 * Rabbithole Lock — remote control for the native iPad app's Autonomous Single
 * App Mode posture.
 *
 * The server owns desired state; the iPad owns OS truth. Staff can request an
 * arm/disarm here, while the native app subscribes by its high-entropy local
 * device id and acknowledges the exact revision it applied. The unauthenticated
 * device read returns no scholar or institution data, so a signed-out paired
 * iPad can still obey a remote command and render its staff-only settings QR.
 */
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  authedMutation,
  authedQuery,
} from "./lib/customFunctions";
import {
  schoolOperationsInstitutionIds,
  hasSchoolOperationsAccessAtInstitution,
} from "./lib/staffCapabilities";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
} from "../shared/institutionDay";
import { siteUrl, withBase } from "./lib/channels";

export type RabbitholeLockState = "armed" | "disarmed";
export type RabbitholeLockDisarmMode =
  | "one_time"
  | "until_midnight"
  | "until_further_notice"
  | "timed";

const lockStateValidator = v.union(
  v.literal("armed"),
  v.literal("disarmed"),
);
const disarmModeValidator = v.union(
  v.literal("one_time"),
  v.literal("until_midnight"),
  v.literal("until_further_notice"),
  v.literal("timed"),
);

// A "timed" disarm's window, in minutes. Floor keeps a fat-fingered request
// from disarming for a few seconds; ceiling keeps it well short of a school
// day so an abandoned timed disarm can't silently become "until further
// notice" in all but name.
const TIMED_DISARM_MIN_MINUTES = 5;
const TIMED_DISARM_MAX_MINUTES = 480;

function requireTimedDisarmMinutes(minutes: number | undefined): number {
  if (
    minutes === undefined ||
    !Number.isInteger(minutes) ||
    minutes < TIMED_DISARM_MIN_MINUTES ||
    minutes > TIMED_DISARM_MAX_MINUTES
  ) {
    throw new Error(
      `A timed disarm needs disarmMinutes between ${TIMED_DISARM_MIN_MINUTES} and ${TIMED_DISARM_MAX_MINUTES}.`,
    );
  }
  return minutes;
}

type LockCommand = {
  state: RabbitholeLockState;
  disarmMode?: RabbitholeLockDisarmMode;
  /** Required (and pre-validated by the caller) when disarmMode is "timed". */
  disarmMinutes?: number;
};

type LockTransitionSource = "web" | "slack" | "midnight" | "timed" | "device";

function desiredState(row: Doc<"pairedDevices">): RabbitholeLockState {
  return row.rabbitholeLockDesiredState ?? "armed";
}

function desiredUpdatedAt(row: Doc<"pairedDevices">): number {
  return row.rabbitholeLockUpdatedAt ?? row.pairedAt;
}

function settingsPath(pairedDeviceId: Id<"pairedDevices">): string {
  return `/school/devices/${pairedDeviceId}`;
}

async function nextInstitutionMidnight(
  ctx: QueryCtx,
  row: Doc<"pairedDevices">,
  now: number,
): Promise<{ expiresAt: number; timeZone: string }> {
  const institution = await ctx.db.get(row.institutionId);
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  const today = dayKeyForTimezone(now, timeZone);
  return {
    expiresAt: dayStartForDayKey(shiftDayKey(today, 1), timeZone),
    timeZone,
  };
}

function commandDescription(
  state: RabbitholeLockState,
  mode?: RabbitholeLockDisarmMode,
  minutes?: number,
): string {
  if (state === "armed") return "armed";
  switch (mode) {
    case "one_time":
      return "disarmed for one app entry";
    case "until_further_notice":
      return "disarmed until further notice";
    case "timed":
      return minutes !== undefined
        ? `disarmed for ${minutes} minute${minutes === 1 ? "" : "s"}`
        : "disarmed for a limited time";
    case "until_midnight":
    default:
      return "disarmed until midnight";
  }
}

async function auditTransition(
  ctx: MutationCtx,
  row: Doc<"pairedDevices">,
  actorUserId: Id<"users">,
  state: RabbitholeLockState,
  mode: RabbitholeLockDisarmMode | undefined,
  source: LockTransitionSource,
  minutes?: number,
): Promise<void> {
  await ctx.db.insert("auditLog", {
    actorUserId,
    action:
      state === "armed"
        ? "device.rabbithole-lock.arm"
        : "device.rabbithole-lock.disarm",
    targetUserId: row.scholarId,
    at: Date.now(),
    detail: `${commandDescription(state, mode, minutes)} via ${source}; device ${row.deviceId}`,
  });
}

// Exported (like resolveManagedSerialsForRows below) so a test can exercise
// the internal validation backstop directly — every real caller
// (setRabbitholeLock, setFromSlack) already validates before reaching here.
export async function applyCommandToRows(
  ctx: MutationCtx,
  rows: Doc<"pairedDevices">[],
  actorUserId: Id<"users">,
  command: LockCommand,
  source: LockTransitionSource,
): Promise<{ changedIds: Id<"pairedDevices">[] }> {
  const now = Date.now();
  const mode =
    command.state === "disarmed"
      ? command.disarmMode ?? "until_midnight"
      : undefined;
  // applyCommandToRows owns the mode -> expiry mapping, so re-validate here
  // as a backstop even though every current caller (setRabbitholeLock,
  // setFromSlack) already validates disarmMinutes before calling. Without
  // this, a future caller that forgets validation would silently schedule an
  // immediate re-arm rather than failing loudly.
  const timedMinutes =
    mode === "timed" ? requireTimedDisarmMinutes(command.disarmMinutes) : null;
  const changedIds: Id<"pairedDevices">[] = [];

  for (const row of rows) {
    // Desired timestamps are also optimistic-concurrency revisions. Convex can
    // commit multiple mutations in one wall-clock millisecond, so make each row
    // revision strictly monotonic instead of trusting Date.now() to be unique.
    const updatedAt = Math.max(now, desiredUpdatedAt(row) + 1);
    const midnight =
      mode === "until_midnight"
        ? await nextInstitutionMidnight(ctx, row, now)
        : null;
    const expiresAt =
      mode === "until_midnight"
        ? midnight?.expiresAt
        : timedMinutes !== null
          ? now + timedMinutes * 60_000
          : undefined;
    const unchanged =
      desiredState(row) === command.state &&
      row.rabbitholeLockDisarmMode === mode &&
      row.rabbitholeLockDisarmExpiresAt === expiresAt;
    if (unchanged) continue;

    await ctx.db.patch(row._id, {
      rabbitholeLockDesiredState: command.state,
      rabbitholeLockDisarmMode: mode,
      rabbitholeLockDisarmExpiresAt: expiresAt,
      rabbitholeLockUpdatedAt: updatedAt,
      rabbitholeLockUpdatedBy: actorUserId,
      rabbitholeLockAppliedDesiredState: undefined,
      rabbitholeLockAppliedAt: undefined,
      rabbitholeLockInSingleAppMode: undefined,
    });
    changedIds.push(row._id);

    // No previously scheduled re-arm job is tracked or cancelled here — same
    // as the existing until_midnight path. A stale job is harmless: it will
    // find `rabbitholeLockUpdatedAt` has moved on and no-op (see
    // rearmAtMidnight / rearmTimed's expectedUpdatedAt check below).
    if (mode === "until_midnight" && expiresAt !== undefined) {
      await ctx.scheduler.runAt(
        expiresAt,
        internal.deviceLock.rearmAtMidnight,
        {
          pairedDeviceId: row._id,
          expectedUpdatedAt: updatedAt,
        },
      );
    } else if (mode === "timed" && expiresAt !== undefined) {
      await ctx.scheduler.runAt(expiresAt, internal.deviceLock.rearmTimed, {
        pairedDeviceId: row._id,
        expectedUpdatedAt: updatedAt,
      });
    }
    await auditTransition(
      ctx,
      row,
      actorUserId,
      command.state,
      mode,
      source,
      command.disarmMinutes,
    );
  }

  return { changedIds };
}

async function managedSerialForBinding(
  ctx: QueryCtx,
  row: Doc<"pairedDevices">,
): Promise<string | null> {
  const claims = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_institution", (q) =>
      q.eq("institutionId", row.institutionId),
    )
    .collect();
  return (
    claims.find((claim) => claim.lastDeviceId === row.deviceId)?.serial ?? null
  );
}

type PairedDeviceSerialBinding = Pick<
  Doc<"pairedDevices">,
  "_id" | "institutionId" | "deviceId"
>;
type ManagedDeviceSerialClaim = Pick<
  Doc<"managedDeviceClaims">,
  "lastDeviceId" | "serial"
>;

export async function resolveManagedSerialsForRows(
  rows: PairedDeviceSerialBinding[],
  loadClaimsForInstitution: (
    institutionId: Id<"institutions">,
  ) => Promise<ManagedDeviceSerialClaim[]>,
): Promise<Map<Id<"pairedDevices">, string | null>> {
  const serialsByInstitutionAndDevice = new Map<
    Id<"institutions">,
    Map<string, string>
  >();
  await Promise.all(
    [...new Set(rows.map((row) => row.institutionId))].map(
      async (institutionId) => {
        const serialsByDevice = new Map<string, string>();
        for (const claim of await loadClaimsForInstitution(institutionId)) {
          if (
            claim.lastDeviceId &&
            !serialsByDevice.has(claim.lastDeviceId)
          ) {
            serialsByDevice.set(claim.lastDeviceId, claim.serial);
          }
        }
        serialsByInstitutionAndDevice.set(institutionId, serialsByDevice);
      },
    ),
  );
  return new Map(
    rows.map((row) => [
      row._id,
      serialsByInstitutionAndDevice
        .get(row.institutionId)
        ?.get(row.deviceId) ?? null,
    ]),
  );
}

async function deviceSettingsPayload(
  ctx: QueryCtx,
  row: Doc<"pairedDevices">,
  resolvedSerial?: string | null,
) {
  const [scholar, updatedBy, serial] = await Promise.all([
    ctx.db.get(row.scholarId),
    row.rabbitholeLockUpdatedBy
      ? ctx.db.get(row.rabbitholeLockUpdatedBy)
      : null,
    resolvedSerial === undefined
      ? managedSerialForBinding(ctx, row)
      : resolvedSerial,
  ]);
  const institution = await ctx.db.get(row.institutionId);
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  let hasLiveSession = false;
  if (row.authSessionId) {
    const session = await ctx.db.get(row.authSessionId);
    hasLiveSession = !!session && session.expirationTime > Date.now();
  }
  const state = desiredState(row);
  const updatedAt = desiredUpdatedAt(row);
  const appliedMatchesDesired =
    row.rabbitholeLockAppliedDesiredState === state &&
    row.rabbitholeLockAppliedAt !== undefined &&
    row.rabbitholeLockAppliedAt >= updatedAt &&
    row.rabbitholeLockInSingleAppMode === (state === "armed");

  return {
    _id: row._id,
    deviceId: row.deviceId,
    deviceLabel: row.deviceLabel ?? null,
    serial,
    scholarId: row.scholarId,
    scholarName: scholar?.name ?? null,
    scholarUsername: scholar?.username ?? null,
    hasLiveSession,
    desiredState: state,
    disarmMode: row.rabbitholeLockDisarmMode ?? null,
    disarmExpiresAt: row.rabbitholeLockDisarmExpiresAt ?? null,
    desiredUpdatedAt: updatedAt,
    desiredUpdatedByName: updatedBy?.name ?? null,
    appliedMatchesDesired,
    appliedAt: row.rabbitholeLockAppliedAt ?? null,
    inSingleAppMode: row.rabbitholeLockInSingleAppMode ?? null,
    institutionTimeZone: timeZone,
    settingsPath: settingsPath(row._id),
    // Annotate, never filter: a paired-device inventory is factual, so an
    // Extended Education (program-guest) scholar's row is tagged instead of
    // hidden (lib/scholarParticipationTooling.ts).
    ...extendedEducationTag({ enrollmentStanding: scholar?.enrollmentStanding }),
  };
}

/**
 * Device-facing read. A random SecureStore UUID is the lookup key; the response
 * deliberately contains no person or institution data.
 */
export const stateForDevice = query({
  args: { deviceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", args.deviceId))
      .take(2);
    if (rows.length !== 1) return null;
    const row = rows[0];
    return {
      pairedDeviceId: row._id,
      desiredState: desiredState(row),
      disarmMode: row.rabbitholeLockDisarmMode ?? null,
      disarmExpiresAt: row.rabbitholeLockDisarmExpiresAt ?? null,
      desiredUpdatedAt: desiredUpdatedAt(row),
      settingsPath: settingsPath(row._id),
    };
  },
});

export const getDeviceSettings = authedQuery({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row) return null;
    if (
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        row.institutionId,
      ))
    ) {
      throw new Error("Forbidden: device is not in your current school context");
    }
    return await deviceSettingsPayload(ctx, row);
  },
});

export const setRabbitholeLock = authedMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    state: lockStateValidator,
    disarmMode: v.optional(disarmModeValidator),
    /** Required (5..480), and only meaningful, when disarmMode is "timed". */
    disarmMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row) throw new Error("That device is no longer paired.");
    if (
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        row.institutionId,
      ))
    ) {
      throw new Error("Forbidden: device is not in your current school context");
    }
    const mode =
      args.state === "disarmed" ? args.disarmMode ?? "until_midnight" : undefined;
    if (mode === "timed") requireTimedDisarmMinutes(args.disarmMinutes);
    const result = await applyCommandToRows(
      ctx,
      [row],
      ctx.user._id,
      {
        state: args.state,
        disarmMode: args.disarmMode,
        disarmMinutes: args.disarmMinutes,
      },
      "web",
    );
    return {
      changed: result.changedIds.length === 1,
      state: args.state,
      disarmMode: mode ?? null,
      disarmMinutes: mode === "timed" ? args.disarmMinutes ?? null : null,
    };
  },
});

/**
 * The authenticated iPad acknowledges the exact desired revision it applied.
 * The mutation can only touch a binding owned by the signed-in scholar.
 */
export const reportAppliedState = authedMutation({
  args: {
    deviceId: v.string(),
    desiredState: lockStateValidator,
    desiredUpdatedAt: v.number(),
    inSingleAppMode: v.boolean(),
  },
  handler: async (ctx, args) => {
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .collect();
    const row = bindings.find((binding) => binding.deviceId === args.deviceId);
    if (!row) return { accepted: false };
    if (
      desiredState(row) !== args.desiredState ||
      desiredUpdatedAt(row) !== args.desiredUpdatedAt
    ) {
      return { accepted: false };
    }
    await ctx.db.patch(row._id, {
      rabbitholeLockAppliedDesiredState: args.desiredState,
      rabbitholeLockAppliedAt: Date.now(),
      rabbitholeLockInSingleAppMode: args.inSingleAppMode,
    });
    return { accepted: true };
  },
});

/**
 * One-time release is consumed when Rabbithole is entered again. Re-arming only
 * makes the device more restrictive, so this narrow UUID-keyed mutation remains
 * safe for a signed-out paired iPad.
 */
export const consumeOneTimeDisarm = mutation({
  args: { deviceId: v.string(), expectedUpdatedAt: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", args.deviceId))
      .take(2);
    if (rows.length !== 1) return { rearmed: false };
    const row = rows[0];
    if (
      desiredState(row) !== "disarmed" ||
      row.rabbitholeLockDisarmMode !== "one_time" ||
      desiredUpdatedAt(row) !== args.expectedUpdatedAt
    ) {
      return { rearmed: false };
    }
    const actor = row.rabbitholeLockUpdatedBy ?? row.pairedBy;
    const result = await applyCommandToRows(
      ctx,
      [row],
      actor,
      { state: "armed" },
      "device",
    );
    return { rearmed: result.changedIds.length === 1 };
  },
});

export const rearmAtMidnight = internalMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    expectedUpdatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pairedDeviceId);
    if (
      !row ||
      desiredState(row) !== "disarmed" ||
      row.rabbitholeLockDisarmMode !== "until_midnight" ||
      desiredUpdatedAt(row) !== args.expectedUpdatedAt
    ) {
      return { rearmed: false };
    }
    const actor = row.rabbitholeLockUpdatedBy ?? row.pairedBy;
    const result = await applyCommandToRows(
      ctx,
      [row],
      actor,
      { state: "armed" },
      "midnight",
    );
    return { rearmed: result.changedIds.length === 1 };
  },
});

/**
 * Mirrors rearmAtMidnight for the "timed" disarm mode: same idempotence
 * discipline (re-check state + revision before re-arming, so a staff change
 * made after this job was scheduled — a re-arm, a longer timed window, a
 * switch to another mode — is never clobbered by a stale scheduled call).
 */
export const rearmTimed = internalMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    expectedUpdatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pairedDeviceId);
    if (
      !row ||
      desiredState(row) !== "disarmed" ||
      row.rabbitholeLockDisarmMode !== "timed" ||
      desiredUpdatedAt(row) !== args.expectedUpdatedAt
    ) {
      return { rearmed: false };
    }
    const actor = row.rabbitholeLockUpdatedBy ?? row.pairedBy;
    const result = await applyCommandToRows(
      ctx,
      [row],
      actor,
      { state: "armed" },
      "timed",
    );
    return { rearmed: result.changedIds.length === 1 };
  },
});

export const listForSlack = internalQuery({
  args: {
    callerUserId: v.id("users"),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) {
      return { ok: false as const, message: "Forbidden: school staff role required" };
    }
    const institutionIds = await schoolOperationsInstitutionIds(ctx, caller);
    if (institutionIds !== "all" && institutionIds.size === 0) {
      return { ok: false as const, message: "Forbidden: school operations access required" };
    }
    const rows: Doc<"pairedDevices">[] = [];
    const eligibleInstitutionIds =
      institutionIds === "all"
        ? (await ctx.db.query("institutions").collect()).map(
            (institution) => institution._id,
          )
        : institutionIds;
    for (const institutionId of eligibleInstitutionIds) {
      rows.push(
        ...(await ctx.db
          .query("pairedDevices")
          .withIndex("by_institution", (q) =>
            q.eq("institutionId", institutionId),
          )
          .collect()),
      );
    }
    const serialsByPairedDevice = await resolveManagedSerialsForRows(
      rows,
      async (institutionId) =>
        await ctx.db
          .query("managedDeviceClaims")
          .withIndex("by_institution", (q) =>
            q.eq("institutionId", institutionId),
          )
          .collect(),
    );
    const payloads = await Promise.all(
      rows.map((row) =>
        deviceSettingsPayload(
          ctx,
          row,
          serialsByPairedDevice.get(row._id) ?? null,
        ),
      ),
    );
    const search = args.search?.trim().toLowerCase() ?? "";
    const devices = payloads
      .filter((device) => {
        if (!search) return true;
        return [
          device._id,
          device.deviceId,
          device.deviceLabel,
          device.serial,
          device.scholarName,
          device.scholarUsername,
        ].some((value) => value?.toLowerCase().includes(search));
      })
      .slice(0, 50)
      .map((device) => ({
        pairedDeviceId: device._id,
        device: device.deviceLabel ?? device.serial ?? "iPad",
        serial: device.serial,
        scholar: device.scholarName ?? device.scholarUsername ?? "Scholar",
        desiredState: device.desiredState,
        disarmMode: device.disarmMode,
        disarmExpiresAt: device.disarmExpiresAt,
        appliedMatchesDesired: device.appliedMatchesDesired,
        inSingleAppMode: device.inSingleAppMode,
        settingsUrl: withBase(siteUrl(), device.settingsPath),
        ...(device.extendedEducation
          ? { extendedEducation: true as const }
          : {}),
      }));
    return { ok: true as const, devices };
  },
});

export const setFromSlack = internalMutation({
  args: {
    callerUserId: v.id("users"),
    pairedDeviceIds: v.array(v.id("pairedDevices")),
    state: lockStateValidator,
    disarmMode: v.optional(disarmModeValidator),
    /** Required (5..480), and only meaningful, when disarmMode is "timed". */
    disarmMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) {
      return { ok: false as const, message: "Forbidden: school staff role required" };
    }
    const ids = [...new Set(args.pairedDeviceIds)];
    if (ids.length === 0) {
      return { ok: false as const, message: "Choose at least one iPad." };
    }
    if (ids.length > 50) {
      return { ok: false as const, message: "Choose no more than 50 iPads at once." };
    }

    const institutionIds = await schoolOperationsInstitutionIds(ctx, caller);
    if (institutionIds !== "all" && institutionIds.size === 0) {
      return {
        ok: false as const,
        message: "Forbidden: school operations access required",
      };
    }
    const rows: Doc<"pairedDevices">[] = [];
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (
        !row ||
        (institutionIds !== "all" && !institutionIds.has(row.institutionId))
      ) {
        return {
          ok: false as const,
          message: "One or more iPads are unavailable in your school context.",
        };
      }
      rows.push(row);
    }

    const mode =
      args.state === "disarmed"
        ? args.disarmMode ?? "until_midnight"
        : undefined;
    if (mode === "timed") requireTimedDisarmMinutes(args.disarmMinutes);
    const result = await applyCommandToRows(
      ctx,
      rows,
      caller._id,
      { state: args.state, disarmMode: mode, disarmMinutes: args.disarmMinutes },
      "slack",
    );
    const description = commandDescription(args.state, mode, args.disarmMinutes);
    return {
      ok: true as const,
      changedCount: result.changedIds.length,
      message:
        result.changedIds.length === 0
          ? `Those ${rows.length} iPad${rows.length === 1 ? " is" : "s are"} already ${description}.`
          : `${result.changedIds.length} iPad${result.changedIds.length === 1 ? "" : "s"} ${description}.`,
    };
  },
});
