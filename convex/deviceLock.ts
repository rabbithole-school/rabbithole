/**
 * Rabbithole Lock — remote control for the native iPad app's Autonomous Single
 * App Mode posture — and Freeze Mode, which holds that lock armed behind a
 * "frozen until <time>" overlay (bottom of this file).
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
  liveSchoolOperationsInstitutionIds,
  hasSchoolOperationsAccessAtInstitution,
} from "./lib/staffCapabilities";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { snapshotForInstitutionSerial } from "./lib/simpleMdmSnapshots";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  instantForLocalMinutes,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import { schoolDayKeysAfter } from "../shared/schoolClosures";
import { loadInstitutionClosures } from "./masterSchedule";
import {
  activeScheduleBlocks,
  isWithinSchoolDay,
  schoolDayStartLocal,
} from "./lib/schoolDay";
import { schoolTimeLabel, siteUrl, withBase } from "./lib/channels";
import { writeAuditLog } from "./lib/auditLog";
import {
  assertNotImpersonating,
  isGuardianOf,
  READ_ONLY_ACCOUNT_ERROR,
} from "./lib/auth";

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

// Freeze Mode's window, in minutes. Up to 96 hours so staff can hold an iPad
// across a weekend; the cap still means a forgotten freeze thaws on its own.
export const FREEZE_MIN_MINUTES = 5;
const FREEZE_MAX_MINUTES = 96 * 60;

/** Resolves a freeze request to the instant it ends. Exactly one of the two. */
function requireFreezeEnd(
  { minutes, untilMs }: { minutes?: number; untilMs?: number },
  now: number,
): number {
  if (minutes !== undefined && untilMs !== undefined) {
    throw new Error("Freeze Mode takes minutes or an end time, not both.");
  }
  if (untilMs !== undefined) {
    if (
      !Number.isInteger(untilMs) ||
      untilMs < now + FREEZE_MIN_MINUTES * 60_000 ||
      untilMs > now + FREEZE_MAX_MINUTES * 60_000
    ) {
      throw new Error(
        `Freeze Mode needs an end time between ${FREEZE_MIN_MINUTES} minutes and ${FREEZE_MAX_MINUTES / 60} hours from now.`,
      );
    }
    return untilMs;
  }
  if (
    minutes === undefined ||
    !Number.isInteger(minutes) ||
    minutes < FREEZE_MIN_MINUTES ||
    minutes > FREEZE_MAX_MINUTES
  ) {
    throw new Error(
      `Freeze Mode needs minutes between ${FREEZE_MIN_MINUTES} and ${FREEZE_MAX_MINUTES}.`,
    );
  }
  return now + minutes * 60_000;
}

const FROZEN_DISARM_REFUSAL =
  "That iPad is in Freeze Mode. Unfreeze it before disarming Rabbithole Lock.";

type LockCommand = {
  state: RabbitholeLockState;
  disarmMode?: RabbitholeLockDisarmMode;
  /** Required (and pre-validated by the caller) when disarmMode is "timed". */
  disarmMinutes?: number;
};

type LockTransitionSource =
  | "web"
  | "app"
  | "slack"
  | "mcp"
  | "midnight"
  | "timed"
  | "device"
  | "freeze"
  // A guardian freezing their own child's BunnyPad, through the parent aide
  // on the web panel or by SMS (freezeFromGuardian).
  | "parent_app"
  | "parent_sms"
  // A family's scheduled freeze starting (scheduledFreezes.fire).
  | "parent_schedule";

/** The agent transports that share listForAgent/setFromAgent ("app" = the
 *  in-app staff aide). Required, not defaulted: the value lands verbatim in
 *  the audit line, so a new caller must say which surface it is rather than
 *  inheriting "slack". */
export const agentSourceValidator = v.union(
  v.literal("slack"),
  v.literal("mcp"),
  v.literal("app"),
);

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
  await writeAuditLog(ctx, {
    institutionId: row.institutionId,
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
// (setRabbitholeLock, setFromAgent) already validates before reaching here.
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
  // setFromAgent) already validates disarmMinutes before calling. Without
  // this, a future caller that forgets validation would silently schedule an
  // immediate re-arm rather than failing loudly.
  const timedMinutes =
    mode === "timed" ? requireTimedDisarmMinutes(command.disarmMinutes) : null;
  // Freeze Mode holds the lock armed. Callers pre-check so they can answer
  // politely; this backstop keeps a future caller from silently letting a
  // frozen iPad leave Rabbithole.
  if (command.state === "disarmed" && rows.some((row) => row.freezeUntil !== undefined)) {
    throw new Error(FROZEN_DISARM_REFUSAL);
  }
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
  // What SimpleMDM last said about this iPad (simpleMdmDeviceSnapshots), so
  // the Lost Mode control can render without a live SimpleMDM read.
  const snapshot = serial
    ? await snapshotForInstitutionSerial(ctx, row.institutionId, serial)
    : null;
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
    frozenUntil: row.freezeUntil ?? null,
    desiredUpdatedAt: updatedAt,
    desiredUpdatedByName: updatedBy?.name ?? null,
    appliedMatchesDesired,
    appliedAt: row.rabbitholeLockAppliedAt ?? null,
    inSingleAppMode: row.rabbitholeLockInSingleAppMode ?? null,
    institutionTimeZone: timeZone,
    settingsPath: settingsPath(row._id),
    simpleMdm:
      snapshot && snapshot.inventoryAt !== undefined && snapshot.foundInSimpleMdm !== undefined
        ? {
          checkedAt: snapshot.inventoryAt,
          foundInSimpleMdm: snapshot.foundInSimpleMdm,
          name: snapshot.name ?? null,
          isSupervised: snapshot.isSupervised ?? null,
          lostModeEnabled: snapshot.lostModeEnabled ?? null,
        }
        : null,
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
      // The boundary, not a verdict: the iPad compares it to its own clock
      // (T11), so an offline device still thaws on time.
      frozenUntil: row.freezeUntil ?? null,
      // Who to ask: "family" or "school". An enum only — never the person,
      // because this read is unauthenticated.
      frozenBy: await freezeOwner(ctx, row),
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
    if (args.state === "disarmed" && row.freezeUntil !== undefined) {
      throw new Error(FROZEN_DISARM_REFUSAL);
    }
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

/**
 * The read half of the agent read-before-write contract, shared by every
 * agent transport (in-app aide, Slack bot, MCP connector) through
 * `lib/deviceOpsTools.ts`. Institution-scoped to the caller's
 * `school:operations` grants, so a fuzzy search can only ever surface iPads
 * the caller may already command.
 */
export const listForAgent = internalQuery({
  args: {
    callerUserId: v.id("users"),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) {
      return { ok: false as const, message: "Forbidden: school staff role required" };
    }
    const eligibleInstitutionIds = await liveSchoolOperationsInstitutionIds(
      ctx,
      caller,
    );
    if (!eligibleInstitutionIds) {
      return { ok: false as const, message: "Forbidden: school operations access required" };
    }
    const rows: Doc<"pairedDevices">[] = [];
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
        frozenUntil: device.frozenUntil,
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

/**
 * The guard every agent WRITE shares: refuse a view-as session, then require
 * every id to resolve inside the caller's live school-operations institutions
 * — or refuse the WHOLE batch before a single row changes. A fuzzy
 * scholar-name match upstream can therefore never write to a device the agent
 * merely guessed at. Prompt confirmation is a UX obligation on the tool layer,
 * never the authorization boundary; that lives here.
 */
export async function resolveAgentWriteRows(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  pairedDeviceIds: Id<"pairedDevices">[],
): Promise<
  | { ok: false; message: string }
  | { ok: true; caller: Doc<"users">; rows: Doc<"pairedDevices">[] }
> {
  // A view-as session is read-only, and the in-app aide ("app") runs as the
  // REAL owner of that browser session — so refuse here, as the console's
  // own write wrapper does. A no-op for Slack (no session) and MCP (an
  // OAuth session carries no overlay).
  try {
    await assertNotImpersonating(ctx);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  const caller = await ctx.db.get(callerUserId);
  if (!caller) {
    return { ok: false, message: "Forbidden: school staff role required" };
  }
  const ids = [...new Set(pairedDeviceIds)];
  if (ids.length === 0) {
    return { ok: false, message: "Choose at least one iPad." };
  }
  if (ids.length > 50) {
    return { ok: false, message: "Choose no more than 50 iPads at once." };
  }

  const institutionIds = await liveSchoolOperationsInstitutionIds(ctx, caller);
  if (!institutionIds) {
    return { ok: false, message: "Forbidden: school operations access required" };
  }
  const rows: Doc<"pairedDevices">[] = [];
  for (const id of ids) {
    const row = await ctx.db.get(id);
    // No "all" escape hatch: every row faces the same live-institution set.
    if (!row || !institutionIds.has(row.institutionId)) {
      return {
        ok: false,
        message: "One or more iPads are unavailable in your school context.",
      };
    }
    rows.push(row);
  }
  return { ok: true, caller, rows };
}

/** The Rabbithole Lock write half for agents. */
export const setFromAgent = internalMutation({
  args: {
    callerUserId: v.id("users"),
    /** Which agent transport is writing — recorded in the audit line. */
    source: agentSourceValidator,
    pairedDeviceIds: v.array(v.id("pairedDevices")),
    state: lockStateValidator,
    disarmMode: v.optional(disarmModeValidator),
    /** Required (5..480), and only meaningful, when disarmMode is "timed". */
    disarmMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveAgentWriteRows(
      ctx,
      args.callerUserId,
      args.pairedDeviceIds,
    );
    if (!resolved.ok) return { ok: false as const, message: resolved.message };
    const { caller, rows } = resolved;

    const mode =
      args.state === "disarmed"
        ? args.disarmMode ?? "until_midnight"
        : undefined;
    if (mode === "timed") requireTimedDisarmMinutes(args.disarmMinutes);
    if (args.state === "disarmed") {
      const frozen = rows.filter((row) => row.freezeUntil !== undefined);
      if (frozen.length > 0) {
        return {
          ok: false as const,
          message: `${frozen.length} of those iPads ${frozen.length === 1 ? "is" : "are"} in Freeze Mode. Unfreeze ${frozen.length === 1 ? "it" : "them"} before disarming Rabbithole Lock.`,
        };
      }
    }
    const result = await applyCommandToRows(
      ctx,
      rows,
      caller._id,
      { state: args.state, disarmMode: mode, disarmMinutes: args.disarmMinutes },
      args.source,
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

// ─── Freeze Mode ────────────────────────────────────────────────────────────
//
// A staff "pause" for one iPad: Rabbithole Lock is armed (so the scholar can't
// leave the app) and the native app covers itself with a "frozen until
// <time>, ask a teacher to unfreeze" overlay. It thaws on its own at the
// chosen time, or when staff unfreeze it here, on the devices page, or
// through an agent tool. Thawing leaves the lock armed — the fleet default.

type FreezeCommand = { kind: "freeze"; untilMs: number } | { kind: "unfreeze" };

// Exported for tests, like applyCommandToRows above.
export async function applyFreezeToRows(
  ctx: MutationCtx,
  rows: Doc<"pairedDevices">[],
  actorUserId: Id<"users">,
  command: FreezeCommand,
  source: LockTransitionSource,
): Promise<{ changedIds: Id<"pairedDevices">[] }> {
  const now = Date.now();
  const untilMs = command.kind === "freeze" ? command.untilMs : null;
  const changedIds: Id<"pairedDevices">[] = [];

  for (const row of rows) {
    if (untilMs === null) {
      if (row.freezeUntil === undefined) continue;
      await ctx.db.patch(row._id, {
        freezeUntil: undefined,
        freezeUpdatedBy: actorUserId,
      });
    } else {
      // A re-freeze REPLACES the end time (shorter or longer). It only has to
      // differ from the old one, so the old thaw job (which compares this
      // exact value) can't clear the new freeze.
      const freezeUntil = untilMs === row.freezeUntil ? untilMs + 1 : untilMs;
      await ctx.db.patch(row._id, { freezeUntil, freezeUpdatedBy: actorUserId });
      await ctx.scheduler.runAt(freezeUntil, internal.deviceLock.thawFreeze, {
        pairedDeviceId: row._id,
        expectedFreezeUntil: freezeUntil,
      });
      // Pin the iPad inside Rabbithole for the freeze. A no-op when already
      // armed; otherwise it replaces any disarm (and its scheduled re-arm).
      const current = await ctx.db.get(row._id);
      if (current) {
        await applyCommandToRows(ctx, [current], actorUserId, { state: "armed" }, "freeze");
      }
    }
    changedIds.push(row._id);
    await writeAuditLog(ctx, {
      institutionId: row.institutionId,
      actorUserId,
      action: untilMs === null ? "device.freeze.end" : "device.freeze.start",
      targetUserId: row.scholarId,
      at: now,
      detail: `${untilMs === null ? "unfrozen" : `frozen until ${new Date(untilMs).toISOString()}`} via ${source}; device ${row.deviceId}`,
    });
  }
  return { changedIds };
}

export const setFreezeMode = authedMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    frozen: v.boolean(),
    /** Required (5..5760) when freezing. */
    minutes: v.optional(v.number()),
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
    const command: FreezeCommand = args.frozen
      ? { kind: "freeze", untilMs: requireFreezeEnd(args, Date.now()) }
      : { kind: "unfreeze" };
    const result = await applyFreezeToRows(ctx, [row], ctx.user._id, command, "web");
    const updated = await ctx.db.get(row._id);
    return {
      changed: result.changedIds.length === 1,
      frozenUntil: updated?.freezeUntil ?? null,
    };
  },
});

/**
 * Scheduled at each freeze's end. Revision-checked on the exact instant, so a
 * re-freeze or an unfreeze made after this job was scheduled is never undone.
 */
export const thawFreeze = internalMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    expectedFreezeUntil: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row || row.freezeUntil !== args.expectedFreezeUntil) {
      return { thawed: false };
    }
    await ctx.db.patch(row._id, { freezeUntil: undefined });
    await writeAuditLog(ctx, {
      institutionId: row.institutionId,
      actorUserId: row.freezeUpdatedBy ?? row.pairedBy,
      action: "device.freeze.end",
      targetUserId: row.scholarId,
      at: Date.now(),
      detail: `freeze ended on schedule; device ${row.deviceId}`,
    });
    return { thawed: true };
  },
});

/** Freeze Mode's agent write half; same guard as setFromAgent. */
export const freezeFromAgent = internalMutation({
  args: {
    callerUserId: v.id("users"),
    source: agentSourceValidator,
    pairedDeviceIds: v.array(v.id("pairedDevices")),
    frozen: v.boolean(),
    /** When freezing, exactly one of these: a duration or an end instant. */
    minutes: v.optional(v.number()),
    untilMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveAgentWriteRows(
      ctx,
      args.callerUserId,
      args.pairedDeviceIds,
    );
    if (!resolved.ok) return { ok: false as const, message: resolved.message };
    const { caller, rows } = resolved;
    let command: FreezeCommand;
    try {
      command = args.frozen
        ? { kind: "freeze", untilMs: requireFreezeEnd(args, Date.now()) }
        : { kind: "unfreeze" };
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
    const result = await applyFreezeToRows(ctx, rows, caller._id, command, args.source);
    const count = result.changedIds.length;
    const noun = (n: number) => `${n} iPad${n === 1 ? "" : "s"}`;
    // Stated in school time so the agent can check it against the request.
    const institution = await ctx.db.get(rows[0].institutionId);
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    return {
      ok: true as const,
      changedCount: count,
      message:
        command.kind === "freeze"
          ? `${noun(count)} frozen until ${schoolTimeLabel(command.untilMs, timeZone)}. Each stays in Rabbithole behind the Freeze Mode screen until then, or until staff unfreeze it.`
          : count === 0
            ? `${rows.length === 1 ? "That iPad wasn't" : "None of those iPads were"} frozen.`
            : `${noun(count)} unfrozen.`,
    };
  },
});

// ─── Guardian freezes ───────────────────────────────────────────────────────
//
// A guardian can freeze their own child's BunnyPad for as long as they like,
// so long as it thaws by the time the next school day starts: a family freeze
// is a family's call about home time, and school time is the school's. Eight
// hours is always allowed (the original family window, so a freeze at 6am
// still covers a morning), and nothing outlasts the staff ceiling above.
// Authorized on GUARDIANSHIP,
// never role, so a staffer who is also a parent at the school can use it for
// their own child. Guardianship is also the tenancy boundary: a guardian
// reaches only the `pairedDevices` rows whose `scholarId` is their child.
//
// Teachers outrank parents. While a school freeze is active, a guardian can
// neither lift it nor replace it; staff can always override a family freeze
// through setFreezeMode / freezeFromAgent, which don't consult the owner.
// Between two guardians of the same child, the latest request wins.

/** A family freeze may always last this long, whatever the school day. */
const GUARDIAN_FREEZE_FLOOR_MINUTES = 480;
/** How far ahead to look for the next school-day start; past this the staff
 *  ceiling (96 hours) binds first anyway. */
const GUARDIAN_FREEZE_LOOKAHEAD_DAYS = 5;

/**
 * The latest moment a family freeze set at `now` may end: the start of the
 * next school day (the first bell of the institution's Master Schedule on the
 * next open weekday, today included if school hasn't started), but never less
 * than 8 hours from now and never more than the 96-hour staff ceiling. With
 * no bell schedule it stays at the 8-hour floor, the window families had
 * before school days were known here.
 */
export async function guardianFreezeLatestEnd(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  timeZone: string,
  now: number,
): Promise<number> {
  const floor = now + GUARDIAN_FREEZE_FLOOR_MINUTES * 60_000;
  const ceiling = now + FREEZE_MAX_MINUTES * 60_000;
  const next = await nextSchoolDayStart(ctx, institutionId, timeZone, now);
  if (next === "unknown") return floor;
  // No school day starts within the lookahead (a break): the ceiling binds.
  if (next === null) return ceiling;
  return Math.min(ceiling, Math.max(floor, next));
}

/**
 * The next instant after `now` that a school day starts (the first bell of
 * the Master Schedule on the next open weekday, today included if school
 * hasn't started); null when none starts within the lookahead (a break);
 * "unknown" when the school has no bell schedule.
 */
async function nextSchoolDayStart(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  timeZone: string,
  now: number,
): Promise<number | null | "unknown"> {
  const blocks = await activeScheduleBlocks(ctx, institutionId);
  if (blocks.length === 0) return "unknown";
  const todayKey = dayKeyForTimezone(now, timeZone);
  const openDays = schoolDayKeysAfter(
    shiftDayKey(todayKey, -1),
    await loadInstitutionClosures(ctx, institutionId),
    GUARDIAN_FREEZE_LOOKAHEAD_DAYS + 1,
    { maxCalendarDays: GUARDIAN_FREEZE_LOOKAHEAD_DAYS + 1 },
  );
  for (const dayKey of openDays) {
    const weekday = weekdayForDayKey(dayKey);
    const start = schoolDayStartLocal(blocks, weekday === 0 ? 7 : weekday);
    if (start === null) continue;
    const [h, m] = start.split(":").map(Number);
    const startMs = instantForLocalMinutes(dayKey, h * 60 + m, timeZone);
    if (startMs > now) return startMs;
  }
  return null;
}

/** Whether school is in session at `now`: an open day (not a closure or
 *  weekend) inside the Master Schedule's span for that weekday. */
async function inSchoolDay(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  timeZone: string,
  now: number,
): Promise<boolean> {
  const blocks = await activeScheduleBlocks(ctx, institutionId);
  if (!isWithinSchoolDay(blocks, timeZone, now)) return false;
  const todayKey = dayKeyForTimezone(now, timeZone);
  const [firstOpen] = schoolDayKeysAfter(
    shiftDayKey(todayKey, -1),
    await loadInstitutionClosures(ctx, institutionId),
    1,
    { maxCalendarDays: 1 },
  );
  return firstOpen === todayKey;
}

export const guardianSourceValidator = v.union(
  v.literal("parent_app"),
  v.literal("parent_sms"),
);

export type FreezeOwner = "family" | "school";

/**
 * Who set this iPad's current freeze: "family" when the last freeze writer is
 * a guardian of the iPad's scholar, otherwise "school". A freeze with no
 * recorded writer counts as the school's, so a gap fails toward the adult
 * with more authority. Null when the row isn't frozen.
 */
export async function freezeOwner(
  ctx: QueryCtx,
  row: Doc<"pairedDevices">,
): Promise<FreezeOwner | null> {
  if (row.freezeUntil === undefined) return null;
  if (
    row.freezeUpdatedBy !== undefined &&
    (await isGuardianOf(ctx, row.freezeUpdatedBy, row.scholarId))
  ) {
    return "family";
  }
  return "school";
}

function bunnyPads(n: number): string {
  return n === 1 ? "BunnyPad" : `${n} BunnyPads`;
}

type GuardianFreezeRequest = {
  guardianUserId: Id<"users">;
  scholarId: Id<"users">;
  frozen: boolean;
  /** When freezing, at most one of these: a length, or an end clock time
   *  (minutes past local midnight, the next time it comes round). */
  minutes?: number;
  untilClockMinutes?: number;
};

/** The next instant, after `now`, that reads `minutes` past midnight on the
 *  school's clock: today's if it is still ahead, else tomorrow's. */
export function nextLocalClockInstant(
  now: number,
  minutes: number,
  timeZone: string,
): number {
  const today = dayKeyForTimezone(now, timeZone);
  const todayAt = instantForLocalMinutes(today, minutes, timeZone);
  return todayAt > now
    ? todayAt
    : instantForLocalMinutes(shiftDayKey(today, 1), minutes, timeZone);
}

type GuardianFreezeCheck =
  | { ok: false; message: string }
  | {
      ok: true;
      childName: string;
      command: FreezeCommand;
      rows: Doc<"pairedDevices">[];
    };

/**
 * Every refusal a guardian's freeze request can meet (read-only account, not
 * a guardian, bad minutes, nothing paired, a school freeze in force), reading
 * only. `freezeFromGuardian` applies the result; the /family-chat staff
 * preview runs it alone (`previewFreezeFromGuardian`) so staff see the same
 * refusal a parent would.
 */
export async function checkGuardianFreeze(
  ctx: QueryCtx,
  args: GuardianFreezeRequest,
  now: number,
): Promise<GuardianFreezeCheck> {
  // A read-only account (the prod service account) never writes, whichever
  // channel reached this. The web route refuses it before the turn too.
  const guardian = await ctx.db.get(args.guardianUserId);
  if (guardian?.readOnly) {
    return { ok: false, message: READ_ONLY_ACCOUNT_ERROR };
  }
  if (!(await isGuardianOf(ctx, args.guardianUserId, args.scholarId))) {
    return { ok: false, message: "You can only freeze your own child's BunnyPad." };
  }
  const scholar = await ctx.db.get(args.scholarId);
  const childName = scholar?.name ?? "Your child";

  const rows = await ctx.db
    .query("pairedDevices")
    .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
    .collect();

  let command: FreezeCommand;
  if (args.frozen && args.untilClockMinutes !== undefined) {
    const institutionId = rows[0]?.institutionId ?? scholar?.institutionId;
    const institution = institutionId ? await ctx.db.get(institutionId) : null;
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    const latestEnd = institutionId
      ? await guardianFreezeLatestEnd(ctx, institutionId, timeZone, now)
      : now + GUARDIAN_FREEZE_FLOOR_MINUTES * 60_000;
    const clock = args.untilClockMinutes;
    if (args.minutes !== undefined) {
      return { ok: false, message: "A freeze takes a length or an end time, not both." };
    }
    if (!Number.isInteger(clock) || clock < 0 || clock >= 24 * 60) {
      return { ok: false, message: "That end time isn't a time of day." };
    }
    const untilMs = nextLocalClockInstant(now, clock, timeZone);
    if (untilMs < now + FREEZE_MIN_MINUTES * 60_000) {
      return {
        ok: false,
        message: `A family freeze lasts at least ${FREEZE_MIN_MINUTES} minutes.`,
      };
    }
    if (untilMs > latestEnd) {
      return {
        ok: false,
        message: `A family freeze has to end before the next school day starts, so right now it can run until ${schoolTimeLabel(latestEnd, timeZone)} at the latest.`,
      };
    }
    command = { kind: "freeze", untilMs };
  } else if (args.frozen) {
    const minutes = args.minutes;
    const institutionId = rows[0]?.institutionId ?? scholar?.institutionId;
    const institution = institutionId ? await ctx.db.get(institutionId) : null;
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    const latestEnd = institutionId
      ? await guardianFreezeLatestEnd(ctx, institutionId, timeZone, now)
      : now + GUARDIAN_FREEZE_FLOOR_MINUTES * 60_000;
    // Round up: the aide's clock is minute-truncated, so "until 8am" arrives
    // a few seconds long. The end is clamped to latestEnd below, so rounding
    // up never lets a freeze run past the first bell.
    const maxMinutes = Math.ceil((latestEnd - now) / 60_000);
    if (
      minutes === undefined ||
      !Number.isInteger(minutes) ||
      minutes < FREEZE_MIN_MINUTES ||
      minutes > maxMinutes
    ) {
      return {
        ok: false,
        message: `A family freeze lasts at least ${FREEZE_MIN_MINUTES} minutes, and right now it can run until ${schoolTimeLabel(latestEnd, timeZone)} at the latest (${maxMinutes} minutes from now).`,
      };
    }
    command = {
      kind: "freeze",
      untilMs: Math.min(now + minutes * 60_000, latestEnd),
    };
  } else {
    command = { kind: "unfreeze" };
  }

  if (rows.length === 0) {
    return { ok: false, message: `${childName} doesn't have a BunnyPad paired yet.` };
  }

  // A freeze whose end has passed but whose thaw job hasn't run yet is
  // already over on the device (it compares to its own clock), so it no
  // longer outranks anyone.
  const schoolFrozen: Doc<"pairedDevices">[] = [];
  for (const row of rows) {
    if (
      row.freezeUntil !== undefined &&
      row.freezeUntil > now &&
      (await freezeOwner(ctx, row)) === "school"
    ) {
      schoolFrozen.push(row);
    }
  }
  if (schoolFrozen.length > 0) {
    const latest = Math.max(...schoolFrozen.map((row) => row.freezeUntil!));
    const institution = await ctx.db.get(schoolFrozen[0].institutionId);
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    return {
      ok: false,
      message: `The school froze ${childName}'s ${schoolFrozen.length === 1 ? "BunnyPad" : "BunnyPads"} until ${schoolTimeLabel(latest, timeZone)}. Only the school can change that freeze, so please ask ${childName}'s teacher.`,
    };
  }
  return { ok: true, childName, command, rows };
}

/**
 * The refusal `freezeFromGuardian` would return for this request, or ok,
 * without writing anything: the /family-chat staff preview's dry run.
 */
export const previewFreezeFromGuardian = internalQuery({
  args: {
    guardianUserId: v.id("users"),
    scholarId: v.id("users"),
    frozen: v.boolean(),
    minutes: v.optional(v.number()),
    untilClockMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; message?: string }> => {
    // t11-ok: internal query only the family-chat action calls once per
    // dry run; never subscribed, so a stale cached result can't linger.
    const check = await checkGuardianFreeze(ctx, args, Date.now());
    return check.ok ? { ok: true } : check;
  },
});

/** Check and apply one guardian's freeze request; every refusal comes back
 *  as a message. Shared by the parent aide (freezeFromGuardian) and the
 *  parent portal's freeze card (scheduledFreezes.freezeNowForScholar). */
export async function runGuardianFreeze(
  ctx: MutationCtx,
  args: GuardianFreezeRequest,
  source: "parent_app" | "parent_sms",
) {
  const check = await checkGuardianFreeze(ctx, args, Date.now());
  if (!check.ok) return { ok: false as const, message: check.message };
  const { childName, command, rows } = check;

  const result = await applyFreezeToRows(
    ctx,
    rows,
    args.guardianUserId,
    command,
    source,
  );
  const count = result.changedIds.length;
  const institution = await ctx.db.get(rows[0].institutionId);
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  // The write is saved here; an offline BunnyPad applies it when it next
  // connects, so the parent-facing message says so rather than "is frozen".
  return {
    ok: true as const,
    changedCount: count,
    frozenUntil: command.kind === "freeze" ? command.untilMs : null,
    message:
      command.kind === "freeze"
        ? `${childName}'s ${bunnyPads(count)} will be frozen until ${schoolTimeLabel(command.untilMs, timeZone)}. The freeze takes effect once ${count === 1 ? "the BunnyPad is" : "they are"} connected.`
        : count === 0
          ? `${childName}'s ${rows.length === 1 ? "BunnyPad wasn't" : "BunnyPads weren't"} frozen.`
          : `${childName}'s ${bunnyPads(count)} will be unfrozen. That takes effect once ${count === 1 ? "the BunnyPad is" : "they are"} connected.`,
  };
}

/**
 * Freeze or unfreeze every BunnyPad paired to one child, on a guardian's
 * request. Returns `{ ok: false, message }` for every refusal (not a
 * guardian, nothing paired, bad minutes, a school freeze in force) so the
 * calling tool can say it back to the parent, as freezeFromAgent does.
 * All-or-nothing: if any of the child's rows carries a school freeze, none
 * of them changes.
 */
export const freezeFromGuardian = internalMutation({
  args: {
    guardianUserId: v.id("users"),
    scholarId: v.id("users"),
    /** Which parent channel is writing — recorded in the audit line. */
    source: guardianSourceValidator,
    frozen: v.boolean(),
    /** When freezing, one of these: 5 minutes up to the next school day,
     *  or an end clock time (minutes past local midnight). */
    minutes: v.optional(v.number()),
    untilClockMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // The web panel's aide runs as the real owner of a view-as session, which
    // is read-only. A no-op for SMS, which has no session.
    try {
      await assertNotImpersonating(ctx);
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
    return await runGuardianFreeze(ctx, args, args.source);
  },
});

/**
 * A family's scheduled freeze starting (scheduledFreezes.fire): freeze the
 * child's BunnyPads until `untilMs` as the guardian who planned it. The same
 * rules as a freeze the parent asks for now, applied at the start instant,
 * but stricter about school time: a school freeze in force wins, an
 * occurrence that starts during the school day is skipped, and the end is
 * clamped to the next school day's first bell (no 8-hour floor). A family
 * freeze already running past `untilMs` is left alone rather than cut short.
 */
export async function applyScheduledGuardianFreeze(
  ctx: MutationCtx,
  guardianUserId: Id<"users">,
  scholarId: Id<"users">,
  untilMs: number,
  now: number,
): Promise<{ applied: boolean; reason?: string }> {
  const rows = await ctx.db
    .query("pairedDevices")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  if (rows.length === 0) return { applied: false, reason: "no BunnyPad paired" };
  for (const row of rows) {
    if (
      row.freezeUntil !== undefined &&
      row.freezeUntil > now &&
      (await freezeOwner(ctx, row)) === "school"
    ) {
      return { applied: false, reason: "school freeze in force" };
    }
  }
  const institutionId = rows[0].institutionId;
  const institution = await ctx.db.get(institutionId);
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  // A plan repeats with no one asking each time, so it gets the strict
  // rule: never during the school day, and over by the next first bell. The
  // 8-hour floor a parent's freeze-now gets doesn't apply here.
  if (await inSchoolDay(ctx, institutionId, timeZone, now)) {
    return { applied: false, reason: "during the school day" };
  }
  const nextStart = await nextSchoolDayStart(ctx, institutionId, timeZone, now);
  const latestEnd =
    typeof nextStart === "number"
      ? nextStart
      : await guardianFreezeLatestEnd(ctx, institutionId, timeZone, now);
  const end = Math.min(untilMs, latestEnd);
  if (end < now + 60_000) return { applied: false, reason: "window already over" };
  const toFreeze = rows.filter(
    (row) => row.freezeUntil === undefined || row.freezeUntil < end,
  );
  if (toFreeze.length === 0) return { applied: false, reason: "already frozen longer" };
  await applyFreezeToRows(
    ctx,
    toFreeze,
    guardianUserId,
    { kind: "freeze", untilMs: end },
    "parent_schedule",
  );
  return { applied: true };
}

/**
 * Freeze status for every BunnyPad of a guardian's own children: what's
 * frozen, until when (epoch ms and school-time label), and whether the
 * family or the school set it. Scoped by the guardian's `guardianships`
 * rows, so it can't name another family's child.
 */
export const freezeStatusForGuardian = internalQuery({
  args: { guardianUserId: v.id("users") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", args.guardianUserId))
      .collect();
    const children = [];
    for (const link of links) {
      const scholar = await ctx.db.get(link.scholarUserId);
      const rows = await ctx.db
        .query("pairedDevices")
        .withIndex("by_scholar", (q) => q.eq("scholarId", link.scholarUserId))
        .collect();
      const devices = [];
      for (const row of rows) {
        // The boundary, not a verdict (T11): thawFreeze clears the field on
        // schedule, and the caller can compare frozenUntil to its own clock.
        const institution =
          row.freezeUntil === undefined ? null : await ctx.db.get(row.institutionId);
        devices.push({
          pairedDeviceId: row._id,
          device: row.deviceLabel ?? "BunnyPad",
          frozenUntil: row.freezeUntil ?? null,
          frozenUntilLabel: schoolTimeLabel(
            row.freezeUntil,
            effectiveInstitutionTimeZone(institution?.timeZone),
          ),
          frozenBy: await freezeOwner(ctx, row),
          setByYou:
            row.freezeUntil !== undefined &&
            row.freezeUpdatedBy === args.guardianUserId,
        });
      }
      children.push({
        scholarId: link.scholarUserId,
        name: scholar?.name ?? "Your child",
        devices,
      });
    }
    return { children };
  },
});
