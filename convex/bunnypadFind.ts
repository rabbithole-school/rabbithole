/**
 * Find my BunnyPad: make a lost BunnyPad play a loud sound.
 *
 * The iPad registers its APNs device token here (registerPushToken); a find
 * is a visible push with a bundled tone, sent by bunnypadFindPush.ts. This
 * file owns who may ask and which iPads a request reaches:
 *
 *   - Staff (aide, Slack, MCP): the same guard as Freeze Mode and Rabbithole
 *     Lock (deviceLock.resolveAgentWriteRows): live school-operations
 *     standing at every named iPad's institution, or nothing is sent.
 *   - Parents (portal aide, SMS): GUARDIANSHIP, exactly as freezeFromGuardian.
 *     A parent reaches only the pairedDevices rows whose scholar is their own
 *     child. Unlike a freeze there is nothing for the school to outrank: a
 *     find changes no state on the iPad.
 *
 * A find writes an audit row per iPad and stamps lastFindAt for the repeat
 * guard. It never reaches a device that hasn't registered a token, and it
 * carries no names: the notification reads the same on every BunnyPad.
 */
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation } from "./lib/customFunctions";
import { writeAuditLog } from "./lib/auditLog";
import {
  assertNotImpersonating,
  isGuardianOf,
  READ_ONLY_ACCOUNT_ERROR,
} from "./lib/auth";
import {
  agentSourceValidator,
  guardianSourceValidator,
  resolveAgentWriteRows,
} from "./deviceLock";

/**
 * A second find inside this window is refused rather than sent. The bundled
 * tone runs about 30 s, so this keeps a repeated "beep it again" (or an SMS
 * retry) from stacking sounds; it is a spam guard, not a calibrated threshold.
 */
export const FIND_REPEAT_GUARD_MS = 30_000;

const environmentValidator = v.union(
  v.literal("production"),
  v.literal("development"),
);

/** Each channel build is its own app, so its own APNs topic. */
const KNOWN_TOPICS = new Set([
  "school.rabbithole",
  "school.rabbithole.canary",
  "school.rabbithole.metro",
]);

/** The iPad reports its APNs token. Only a binding owned by the signed-in
 *  scholar can be updated, as with deviceLock.reportAppliedState. */
export const registerPushToken = authedMutation({
  args: {
    deviceId: v.string(),
    token: v.string(),
    topic: v.string(),
    environment: environmentValidator,
  },
  handler: async (ctx, args) => {
    if (!/^[0-9a-f]{64,200}$/i.test(args.token)) return { accepted: false };
    if (!KNOWN_TOPICS.has(args.topic)) return { accepted: false };
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .collect();
    const row = bindings.find((binding) => binding.deviceId === args.deviceId);
    if (!row) return { accepted: false };
    if (
      row.apnsToken === args.token &&
      row.apnsTopic === args.topic &&
      row.apnsEnvironment === args.environment
    ) {
      return { accepted: true };
    }
    await ctx.db.patch(row._id, {
      apnsToken: args.token,
      apnsTopic: args.topic,
      apnsEnvironment: args.environment,
      apnsTokenUpdatedAt: Date.now(),
    });
    return { accepted: true };
  },
});

export type FindTarget = {
  pairedDeviceId: Id<"pairedDevices">;
  token: string;
  topic: string;
  environment: "production" | "development";
};

export type PreparedFind =
  | { ok: false; message: string }
  | {
      ok: true;
      targets: FindTarget[];
      /** Rows skipped because they have no token yet. */
      unregistered: number;
      /** Rows skipped by the repeat guard. */
      recentlyFound: number;
      childName?: string;
    };

async function prepareRows(
  ctx: MutationCtx,
  rows: Doc<"pairedDevices">[],
  actorUserId: Id<"users">,
  source: string,
): Promise<{ targets: FindTarget[]; unregistered: number; recentlyFound: number }> {
  const now = Date.now();
  const targets: FindTarget[] = [];
  let unregistered = 0;
  let recentlyFound = 0;
  for (const row of rows) {
    if (!row.apnsToken || !row.apnsTopic || !row.apnsEnvironment) {
      unregistered += 1;
      continue;
    }
    if (row.lastFindAt !== undefined && now - row.lastFindAt < FIND_REPEAT_GUARD_MS) {
      recentlyFound += 1;
      continue;
    }
    await ctx.db.patch(row._id, { lastFindAt: now });
    await writeAuditLog(ctx, {
      institutionId: row.institutionId,
      actorUserId,
      action: "device.find.request",
      targetUserId: row.scholarId,
      at: now,
      detail: `find sound via ${source}; device ${row.deviceId}`,
    });
    targets.push({
      pairedDeviceId: row._id,
      token: row.apnsToken,
      topic: row.apnsTopic,
      environment: row.apnsEnvironment,
    });
  }
  return { targets, unregistered, recentlyFound };
}

/** Staff half: the same all-or-nothing guard as Freeze Mode. */
export const prepareFindFromAgent = internalMutation({
  args: {
    callerUserId: v.id("users"),
    source: agentSourceValidator,
    pairedDeviceIds: v.array(v.id("pairedDevices")),
  },
  handler: async (ctx, args): Promise<PreparedFind> => {
    const resolved = await resolveAgentWriteRows(
      ctx,
      args.callerUserId,
      args.pairedDeviceIds,
    );
    if (!resolved.ok) return { ok: false, message: resolved.message };
    if (resolved.caller.readOnly) {
      return { ok: false, message: READ_ONLY_ACCOUNT_ERROR };
    }
    return {
      ok: true,
      ...(await prepareRows(ctx, resolved.rows, resolved.caller._id, args.source)),
    };
  },
});

/**
 * A guardian's find refusals that need no write (read-only account, not a
 * guardian, nothing paired). `prepareFindFromGuardian` applies the result;
 * the /family-chat staff preview runs it alone (`previewFindFromGuardian`)
 * so staff see the refusal a parent would.
 */
async function checkGuardianFind(
  ctx: QueryCtx,
  args: { guardianUserId: Id<"users">; scholarId: Id<"users"> },
): Promise<
  | { ok: false; message: string }
  | { ok: true; childName: string; rows: Doc<"pairedDevices">[] }
> {
  const guardian = await ctx.db.get(args.guardianUserId);
  if (guardian?.readOnly) return { ok: false, message: READ_ONLY_ACCOUNT_ERROR };
  if (!(await isGuardianOf(ctx, args.guardianUserId, args.scholarId))) {
    return { ok: false, message: "You can only find your own child's BunnyPad." };
  }
  const scholar = await ctx.db.get(args.scholarId);
  const childName = scholar?.name ?? "Your child";
  const rows = await ctx.db
    .query("pairedDevices")
    .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
    .collect();
  if (rows.length === 0) {
    return { ok: false, message: `${childName} doesn't have a BunnyPad paired yet.` };
  }
  return { ok: true, childName, rows };
}

/** The refusal a guardian's find would meet, or ok, writing nothing: the
 *  /family-chat staff preview's dry run. */
export const previewFindFromGuardian = internalQuery({
  args: { guardianUserId: v.id("users"), scholarId: v.id("users") },
  handler: async (ctx, args): Promise<{ ok: boolean; message?: string }> => {
    const check = await checkGuardianFind(ctx, args);
    return check.ok ? { ok: true } : check;
  },
});

/** Parent half: guardianship is the authorization and the tenancy boundary,
 *  with the same refusals as freezeFromGuardian. */
export const prepareFindFromGuardian = internalMutation({
  args: {
    guardianUserId: v.id("users"),
    scholarId: v.id("users"),
    source: guardianSourceValidator,
  },
  handler: async (ctx, args): Promise<PreparedFind> => {
    try {
      await assertNotImpersonating(ctx);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const check = await checkGuardianFind(ctx, args);
    if (!check.ok) return check;
    return {
      ok: true,
      childName: check.childName,
      ...(await prepareRows(ctx, check.rows, args.guardianUserId, args.source)),
    };
  },
});

/** After a send: forget tokens APNs says are dead, so the next find says
 *  "needs to open Rabbithole" instead of failing the same way again. Only
 *  clears a token that is still the one we sent to. */
export const recordFindDelivery = internalMutation({
  args: {
    deadTokens: v.array(
      v.object({ pairedDeviceId: v.id("pairedDevices"), token: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    for (const { pairedDeviceId, token } of args.deadTokens) {
      const row = await ctx.db.get(pairedDeviceId);
      if (row?.apnsToken !== token) continue;
      await ctx.db.patch(pairedDeviceId, {
        apnsToken: undefined,
        apnsTopic: undefined,
        apnsEnvironment: undefined,
        apnsTokenUpdatedAt: Date.now(),
      });
    }
  },
});
