import { v } from "convex/values";
import { authedMutation, scholarAdminQuery } from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const channelValidator = v.union(v.literal("stable"), v.literal("canary"));
const MAX_METADATA_LENGTH = 120;

function requiredMetadata(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_METADATA_LENGTH) {
    throw new Error(`Invalid native client ${label}.`);
  }
  return normalized;
}

function normalizedDeviceId(deviceId: string): string {
  const normalized = deviceId.trim();
  if (normalized.length < 6 || normalized.length > 200) {
    throw new Error("Invalid device id.");
  }
  return normalized;
}

async function bindingForUserDevice(
  ctx: QueryCtx,
  userId: Id<"users">,
  deviceId: string,
) {
  const bindings = await ctx.db
    .query("pairedDevices")
    .withIndex("by_device_id", (q) => q.eq("deviceId", deviceId))
    .collect();
  return bindings.find((binding) => binding.scholarId === userId) ?? null;
}

async function managedClaimForUserDevice(
  ctx: QueryCtx,
  user: Doc<"users">,
  deviceId: string,
  institutionId: Id<"institutions"> | undefined,
) {
  const claims = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_last_device_id", (q) => q.eq("lastDeviceId", deviceId))
    .collect();
  return (
    claims.find(
      (claim) =>
        claim.claimState === "claimed" &&
        claim.scholarId === user._id &&
        claim.institutionId === institutionId,
    ) ?? null
  );
}

async function isStillManaged(
  ctx: QueryCtx,
  heartbeat: Doc<"nativeClientHeartbeats">,
) {
  if (!heartbeat.managedDeviceId) return false;
  const claim = await ctx.db.get(heartbeat.managedDeviceId);
  return (
    claim?.claimState === "claimed" &&
    claim.scholarId === heartbeat.userId &&
    claim.institutionId === heartbeat.institutionId &&
    claim.lastDeviceId === heartbeat.deviceId
  );
}

/**
 * Authenticated native clients report the build currently running on a stable
 * local installation id. Tenant and managed status are deliberately derived
 * here rather than accepted from the client.
 */
export const record = authedMutation({
  args: {
    deviceId: v.string(),
    channel: channelValidator,
    appVersion: v.string(),
    buildNumber: v.string(),
    gitSha: v.string(),
  },
  handler: async (ctx, args) => {
    const deviceId = normalizedDeviceId(args.deviceId);
    const binding = await bindingForUserDevice(ctx, ctx.user._id, deviceId);
    const institutionId = binding?.institutionId ?? ctx.user.institutionId;
    const managedClaim = await managedClaimForUserDevice(
      ctx,
      ctx.user,
      deviceId,
      institutionId,
    );
    const now = Date.now();
    const fields = {
      institutionId,
      deviceId,
      channel: args.channel,
      appVersion: requiredMetadata(args.appVersion, "version"),
      buildNumber: requiredMetadata(args.buildNumber, "build number"),
      gitSha: requiredMetadata(args.gitSha, "git SHA"),
      managedDeviceId: managedClaim?._id,
      lastSeenAt: now,
    };
    const existing = await ctx.db
      .query("nativeClientHeartbeats")
      .withIndex("by_user_device", (q) =>
        q.eq("userId", ctx.user._id).eq("deviceId", deviceId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { heartbeatId: existing._id, managed: !!managedClaim };
    }

    const heartbeatId = await ctx.db.insert("nativeClientHeartbeats", {
      userId: ctx.user._id,
      ...fields,
    });
    return { heartbeatId, managed: !!managedClaim };
  },
});

/**
 * Staff-facing rollout inventory. It reads only tenant rows selected through
 * the caller's resolved institution lens and rechecks managed status from the
 * current claim, so a revoked/reassigned device is never presented as managed.
 */
export const listForInstitution = scholarAdminQuery({
  args: {
    institutionScope: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Limit must be between 1 and 500.");
    }
    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope ?? "",
    );
    const institutionIds =
      lens.scope === "all"
        ? [...lens.allowedInstitutionIds]
        : lens.institution && lens.allowedInstitutionIds.has(lens.institution._id)
          ? [lens.institution._id]
          : [];
    const rows = (
      await Promise.all(
        institutionIds.map((institutionId) =>
          ctx.db
            .query("nativeClientHeartbeats")
            .withIndex("by_institution_last_seen", (q) =>
              q.eq("institutionId", institutionId),
            )
            .order("desc")
            .take(limit),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit);

    return await Promise.all(
      rows.map(async (row) => ({
        _id: row._id,
        userId: row.userId,
        deviceId: row.deviceId,
        channel: row.channel,
        appVersion: row.appVersion,
        buildNumber: row.buildNumber,
        gitSha: row.gitSha,
        managed: await isStillManaged(ctx, row),
        lastSeenAt: row.lastSeenAt,
      })),
    );
  },
});
