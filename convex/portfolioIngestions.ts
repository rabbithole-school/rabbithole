import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";

// A claim protects an action that can download a file and call an AI model. It
// must comfortably outlive normal action latency, but eventually expire if the
// worker is terminated mid-flight.
const CLAIM_LEASE_MS = 15 * 60 * 1000;
const INITIAL_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_FAILURE_REASON_LENGTH = 500;

function retryDelayMs(attempts: number): number {
  return Math.min(
    INITIAL_RETRY_DELAY_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
    MAX_RETRY_DELAY_MS,
  );
}

async function alreadyHandled(
  ctx: MutationCtx,
  driveFileId: string,
): Promise<boolean> {
  // This remains the rollout bridge: scans completed before claims existed
  // never get a claim row, but must still never be sent through AI again.
  const item = await ctx.db
    .query("portfolioItems")
    .withIndex("by_driveFileId", (q) => q.eq("driveFileId", driveFileId))
    .first();
  if (item) return true;
  const dismissal = await ctx.db
    .query("driveFileDismissals")
    .withIndex("by_driveFileId", (q) => q.eq("driveFileId", driveFileId))
    .first();
  return dismissal !== null;
}

/**
 * Atomically reserve a Drive file before its bytes are downloaded. Convex
 * retries conflicting mutations, so two folder syncs that observe no row
 * cannot both win this claim.
 */
export const claimDriveFile = internalMutation({
  args: {
    institutionId: v.optional(v.id("institutions")),
    driveFileId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("driveFileIngestions")
      .withIndex("by_institution_drive_file", (q) =>
        q
          .eq("institutionId", args.institutionId)
          .eq("driveFileId", args.driveFileId),
      )
      .unique();

    if (existing?.status === "completed") {
      return { kind: "alreadyHandled" as const };
    }
    if (
      existing?.status === "claimed" &&
      existing.claimedAt + CLAIM_LEASE_MS > now
    ) {
      return { kind: "inProgress" as const };
    }
    if (
      existing?.status === "failed" &&
      existing.retryAt == null
    ) {
      return { kind: "deadLettered" as const };
    }
    if (
      existing?.status === "failed" &&
      existing.retryAt != null &&
      existing.retryAt > now
    ) {
      return { kind: "retryLater" as const };
    }
    if (!existing && (await alreadyHandled(ctx, args.driveFileId))) {
      return { kind: "alreadyHandled" as const };
    }

    const claimToken = crypto.randomUUID();
    const attempts = (existing?.attempts ?? 0) + 1;
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "claimed",
        claimToken,
        claimedAt: now,
        attempts,
        completedAt: undefined,
        failedAt: undefined,
        retryAt: undefined,
        failureReason: undefined,
      });
    } else {
      await ctx.db.insert("driveFileIngestions", {
        institutionId: args.institutionId,
        driveFileId: args.driveFileId,
        status: "claimed",
        claimToken,
        claimedAt: now,
        attempts,
      });
    }
    return { kind: "claimed" as const, claimToken };
  },
});

/** Mark the claimed file durably complete after every segment is written. */
export const completeDriveFile = internalMutation({
  args: {
    institutionId: v.optional(v.id("institutions")),
    driveFileId: v.string(),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("driveFileIngestions")
      .withIndex("by_institution_drive_file", (q) =>
        q
          .eq("institutionId", args.institutionId)
          .eq("driveFileId", args.driveFileId),
      )
      .unique();
    if (!row || row.claimToken !== args.claimToken || row.status !== "claimed") {
      return false;
    }
    await ctx.db.patch(row._id, {
      status: "completed",
      completedAt: Date.now(),
      retryAt: undefined,
      failureReason: undefined,
    });
    return true;
  },
});

/**
 * Release a finished-but-unsuccessful action for a bounded-backoff retry.
 * The claim token prevents an old, expired worker from releasing a newer lease.
 */
export const failDriveFile = internalMutation({
  args: {
    institutionId: v.optional(v.id("institutions")),
    driveFileId: v.string(),
    claimToken: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("driveFileIngestions")
      .withIndex("by_institution_drive_file", (q) =>
        q
          .eq("institutionId", args.institutionId)
          .eq("driveFileId", args.driveFileId),
      )
      .unique();
    if (!row || row.claimToken !== args.claimToken || row.status !== "claimed") {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "failed",
      failedAt: now,
      retryAt:
        row.attempts >= MAX_ATTEMPTS
          ? undefined
          : now + retryDelayMs(row.attempts),
      failureReason: args.reason.slice(0, MAX_FAILURE_REASON_LENGTH),
    });
    return { failed: true, deadLettered: row.attempts >= MAX_ATTEMPTS };
  },
});
