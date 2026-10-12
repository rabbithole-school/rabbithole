import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  APP_UPDATE_LLM_SURFACE,
  decideLlmLease,
  LEASE_TTL_MS,
  type LlmLimitReason,
  PER_USER_CONCURRENT,
  WINDOW_MS,
} from "./lib/llmLimiter";
import { STREAM_DEAD_PLACEHOLDER_MS } from "../shared/streamRetry";

const RETENTION_SWEEP_BATCH = 250;

/** The surfaces only `/session-stream` acquires: one lease per tutor turn. */
const SESSION_STREAM_SURFACES: ReadonlySet<string> = new Set([
  "project-stream",
  APP_UPDATE_LLM_SURFACE,
]);
/** Besides the turn's own session, the user's most recently messaged ones. */
const RECLAIM_RECENT_SESSIONS = 5;

/**
 * Session-stream leases whose streams are gone. A `/session-stream` turn whose
 * action dies (Convex ends it, or it crashes) never reaches its release, so
 * its lease would hold one of the user's two slots for the full TTL: two such
 * turns lock a child out of the tutor for five minutes. Every live turn keeps
 * a placeholder with a fresh heartbeat (http.ts, every 5 s), so leases beyond
 * the count of OTHER live placeholders cannot belong to a running stream.
 * Leases do not record their stream, so the oldest surplus go; marking a live
 * one's lease inactive only lets that turn finish uncounted, and its own
 * release is then a no-op. A placeholder still inside the dead window counts
 * as live, so a stream that just died is reclaimed a few seconds later, on the
 * client's busy retry.
 */
async function deadSessionStreamLeaseIds(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    sessionId: Id<"sessions">;
    assistantMsgId: Id<"messages">;
    now: number;
    userLeases: readonly Doc<"llmLeases">[];
  },
): Promise<Id<"llmLeases">[]> {
  const leaseCutoff = args.now - LEASE_TTL_MS;
  const activeLeases = args.userLeases.filter(
    (lease) => lease.active && lease.startedAt > leaseCutoff,
  );
  // Only step in when the user would be refused for concurrency.
  if (activeLeases.length < PER_USER_CONCURRENT) return [];
  const candidates = activeLeases
    .filter((lease) => SESSION_STREAM_SURFACES.has(lease.surface))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (candidates.length === 0) return [];

  const recentSessions = await ctx.db
    .query("sessions")
    .withIndex("by_user_last_message", (q) => q.eq("userId", args.userId))
    .order("desc")
    .take(RECLAIM_RECENT_SESSIONS);
  const sessionIds = new Set<Id<"sessions">>([
    args.sessionId,
    ...recentSessions.map((session) => session._id),
  ]);
  const liveAfter = args.now - STREAM_DEAD_PLACEHOLDER_MS;
  let liveOtherTurns = 0;
  for (const sessionId of sessionIds) {
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(20);
    liveOtherTurns += recent.filter(
      (message) =>
        message._id !== args.assistantMsgId &&
        message.role === "assistant" &&
        !!message.streamId &&
        (message.lastStreamActivityAt ?? message._creationTime) >= liveAfter,
    ).length;
  }
  const surplus = candidates.length - liveOtherTurns;
  return surplus > 0
    ? candidates.slice(0, surplus).map((lease) => lease._id)
    : [];
}

type AcquireResult =
  | { ok: true; leaseId: Id<"llmLeases"> }
  | {
      ok: false;
      reason: LlmLimitReason;
      retryAfterSec: number;
    };

export const acquire = internalMutation({
  args: {
    userId: v.id("users"),
    surface: v.string(),
    institutionId: v.optional(v.id("institutions")),
    /** A `/session-stream` turn: lets its dead predecessors' leases go. */
    sessionStream: v.optional(
      v.object({
        sessionId: v.id("sessions"),
        assistantMsgId: v.id("messages"),
      }),
    ),
  },
  handler: async (ctx, args): Promise<AcquireResult> => {
    const now = Date.now();
    let userLeases = await ctx.db
      .query("llmLeases")
      .withIndex("by_user_startedAt", (q) =>
        q.eq("userId", args.userId).gt("startedAt", now - WINDOW_MS),
      )
      .collect();
    if (args.sessionStream && SESSION_STREAM_SURFACES.has(args.surface)) {
      const dead = await deadSessionStreamLeaseIds(ctx, {
        userId: args.userId,
        ...args.sessionStream,
        now,
        userLeases,
      });
      if (dead.length > 0) {
        for (const leaseId of dead) {
          await ctx.db.patch(leaseId, { active: false });
        }
        const deadIds = new Set(dead);
        userLeases = userLeases.map((lease) =>
          deadIds.has(lease._id) ? { ...lease, active: false } : lease,
        );
        console.warn("[llm-limiter] reclaimed dead session-stream leases", {
          count: dead.length,
        });
      }
    }
    const platformActiveLeases = await ctx.db
      .query("llmLeases")
      .withIndex("by_active_startedAt", (q) =>
        q.eq("active", true).gt("startedAt", now - LEASE_TTL_MS),
      )
      .collect();

    const { decision, staleUserLeaseIds } = decideLlmLease({
      now,
      userLeases: userLeases.map((lease) => ({
        leaseId: lease._id,
        startedAt: lease.startedAt,
        active: lease.active,
        surface: lease.surface,
      })),
      platformActiveLeases: platformActiveLeases.map((lease) => ({
        startedAt: lease.startedAt,
        surface: lease.surface,
      })),
      surface: args.surface,
    });

    for (const leaseId of staleUserLeaseIds) {
      await ctx.db.patch(leaseId, { active: false });
    }

    if (!decision.ok) return decision;

    const leaseId = await ctx.db.insert("llmLeases", {
      userId: args.userId,
      surface: args.surface,
      startedAt: now,
      active: true,
      ...(args.institutionId !== undefined
        ? { institutionId: args.institutionId }
        : {}),
    });
    return { ok: true, leaseId };
  },
});

export const release = internalMutation({
  args: { leaseId: v.id("llmLeases") },
  handler: async (ctx, args): Promise<void> => {
    const lease = await ctx.db.get(args.leaseId);
    if (lease?.active) {
      await ctx.db.patch(args.leaseId, { active: false });
    }
  },
});

/**
 * Delete lease history after the rolling start window. Batched and
 * self-draining so one cron tick clears a backlog without an unbounded
 * transaction.
 */
export const retentionSweep = internalMutation({
  args: { batch: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ deleted: number; more: boolean }> => {
    const cutoff = Date.now() - WINDOW_MS;
    const limit = args.batch ?? RETENTION_SWEEP_BATCH;
    const staleActive = await ctx.db
      .query("llmLeases")
      .withIndex("by_active_startedAt", (q) =>
        q.eq("active", true).lt("startedAt", cutoff),
      )
      .take(limit);
    const staleInactive =
      staleActive.length < limit
        ? await ctx.db
            .query("llmLeases")
            .withIndex("by_active_startedAt", (q) =>
              q.eq("active", false).lt("startedAt", cutoff),
            )
            .take(limit - staleActive.length)
        : [];
    const stale = [...staleActive, ...staleInactive];
    for (const lease of stale) {
      await ctx.db.delete(lease._id);
    }
    const more = stale.length === limit;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.llmLimiter.retentionSweep, {
        batch: limit,
      });
    }
    return { deleted: stale.length, more };
  },
});
