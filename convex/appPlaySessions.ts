// When a scholar had one of their own apps on screen. The Rabbithole host
// around the app (web CodeArtifactViewer, native CodeArtifactWebView) calls
// start → heartbeat (about once a minute) → end; see shared/appPlaySession.ts
// for the timing policy and the host-side tracker, and schema.ts's
// `appPlaySessions` comment for the row shape.
//
// Timestamps are server-side: a host can only say "still here" or "gone",
// never when. A host that goes quiet leaves its row closed at the last
// check-in — the next heartbeat or end() after a stale gap finalizes it there
// instead of stretching it to now.
//
// Hosts that see interactions (start with `tracksInteraction`) also report
// active time and their last interaction on each check-in and on end(); both
// are clamped to the interval's own server times. Rows from older hosts carry
// no interaction data and are reported as on-screen only.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authedMutation } from "./lib/customFunctions";
import { isTeacherArchived } from "../shared/teacherArchive";
import {
  APP_PLAY_MIN_HEARTBEAT_INTERVAL_MS,
  APP_PLAY_RESUME_GAP_MS,
  APP_PLAY_RETENTION_MS,
  APP_PLAY_STALE_GAP_MS,
  appPlayActiveMs,
  appPlayDurationMs,
  firstPlayedRow,
  type AppPlayHandle,
  type AppPlaySurface,
} from "../shared/appPlaySession";

/** Old rows one start() deletes, so the prune never outweighs the write. */
const PRUNE_BATCH = 5;

export type LatestAppPlay = {
  startedAt: number;
  lastActiveAt: number;
  endedAt?: number;
  durationMs: number;
  /** Interaction-tracked rows only; absent when the host could not tell. */
  activeMs?: number;
  surface: AppPlaySurface;
};

export function toLatestAppPlay(row: Doc<"appPlaySessions">): LatestAppPlay {
  return {
    startedAt: row.startedAt,
    lastActiveAt: row.lastActiveAt,
    ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    durationMs: appPlayDurationMs(row),
    ...(row.interactionTracked ? { activeMs: appPlayActiveMs(row) } : {}),
    surface: row.surface,
  };
}

const activityArgs = {
  /** Active ms since this host's previous report. */
  activeMs: v.optional(v.number()),
  /** The host's latest interaction, on the server's clock. */
  lastInteractionAt: v.optional(v.number()),
};

/**
 * The interaction fields an interaction-tracked row takes from one report,
 * with the row's interval ending at `endAt`. Active time can only grow and
 * never past the interval's length; the last interaction stays inside the
 * interval and never moves backwards. Rows from older hosts are left alone.
 */
function activityPatch(
  row: Doc<"appPlaySessions">,
  endAt: number,
  args: { activeMs?: number; lastInteractionAt?: number },
): Partial<Doc<"appPlaySessions">> {
  if (!row.interactionTracked) return {};
  const length = Math.max(0, endAt - row.startedAt);
  const delta =
    typeof args.activeMs === "number" && Number.isFinite(args.activeMs)
      ? Math.max(0, args.activeMs)
      : 0;
  const patch: Partial<Doc<"appPlaySessions">> = {
    activeMs: Math.min(length, (row.activeMs ?? 0) + delta),
  };
  if (
    typeof args.lastInteractionAt === "number" &&
    Number.isFinite(args.lastInteractionAt)
  ) {
    const reported = Math.min(
      endAt,
      Math.max(row.startedAt, args.lastInteractionAt),
    );
    patch.lastInteractionAt = Math.max(row.lastInteractionAt ?? 0, reported);
  }
  return patch;
}

function isStale(row: Doc<"appPlaySessions">, now: number): boolean {
  return now - row.lastActiveAt > APP_PLAY_STALE_GAP_MS;
}

async function ownedRow(
  ctx: MutationCtx & { user: Doc<"users"> },
  playSessionId: Id<"appPlaySessions">,
): Promise<Doc<"appPlaySessions"> | null> {
  const row = await ctx.db.get(playSessionId);
  if (!row) return null;
  if (row.userId !== ctx.user._id) throw new Error("Forbidden");
  return row;
}

async function pruneExpired(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<void> {
  const expired = await ctx.db
    .query("appPlaySessions")
    .withIndex("by_user_startedAt", (q) =>
      q.eq("userId", userId).lt("startedAt", now - APP_PLAY_RETENTION_MS),
    )
    .take(PRUNE_BATCH);
  for (const row of expired) await ctx.db.delete(row._id);
}

/**
 * Open (or reopen) a play interval for the caller's own app. Resolves null —
 * never throws — when this viewer is not tracked: someone else's app (a
 * teacher watching), a non-code artifact, a test drive, or an app a teacher
 * put away. Hosts call it without knowing which case they are in.
 */
export const start = authedMutation({
  args: {
    artifactId: v.id("artifacts"),
    surface: v.union(v.literal("web"), v.literal("native")),
    /** This host reports interactions on check-ins and end(). Older hosts
     *  omit it and their rows stay on-screen only. */
    tracksInteraction: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<AppPlayHandle<Id<"appPlaySessions">> | null> => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.type !== "code") return null;
    const session = await ctx.db.get(artifact.sessionId);
    if (!session || session.userId !== ctx.user._id) return null;
    if (session.isTestDrive || isTeacherArchived(session)) return null;

    const now = Date.now();
    await pruneExpired(ctx, ctx.user._id, now);

    const previous = await ctx.db
      .query("appPlaySessions")
      .withIndex("by_artifact_startedAt", (q) =>
        q.eq("artifactId", artifact._id),
      )
      .order("desc")
      .first();
    if (previous && previous.userId === ctx.user._id) {
      const open = previous.endedAt === undefined && !isStale(previous, now);
      const justEnded =
        previous.endedAt !== undefined &&
        now - previous.endedAt <= APP_PLAY_RESUME_GAP_MS;
      if (open || justEnded) {
        const resumes = previous.resumes + 1;
        await ctx.db.patch(previous._id, {
          lastActiveAt: now,
          endedAt: undefined,
          surface: args.surface,
          resumes,
          // A row is interaction-tracked only if every host that wrote it
          // was: an older host reopening it leaves time it cannot vouch for.
          ...(previous.interactionTracked && !args.tracksInteraction
            ? { interactionTracked: undefined }
            : {}),
        });
        return { playSessionId: previous._id, resumes, serverNow: now };
      }
      if (previous.endedAt === undefined) {
        await ctx.db.patch(previous._id, { endedAt: previous.lastActiveAt });
      }
    }

    const playSessionId = await ctx.db.insert("appPlaySessions", {
      userId: ctx.user._id,
      ...(session.institutionId ? { institutionId: session.institutionId } : {}),
      sessionId: session._id,
      artifactId: artifact._id,
      surface: args.surface,
      startedAt: now,
      lastActiveAt: now,
      resumes: 0,
      ...(args.tracksInteraction
        ? { interactionTracked: true as const, activeMs: 0 }
        : {}),
    });
    return { playSessionId, resumes: 0, serverNow: now };
  },
});

/** "Still on screen." Resolves false when the interval is over (ended, gone,
 *  or closed as stale just now), so the host starts a fresh one. An
 *  interaction-tracking host adds its active time since the last report. A
 *  report after a stale gap is dropped with the gap: the interval already
 *  ended at its last check-in. */
export const heartbeat = authedMutation({
  args: { playSessionId: v.id("appPlaySessions"), ...activityArgs },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ownedRow(ctx, args.playSessionId);
    if (!row || row.endedAt !== undefined) return false;
    const now = Date.now();
    if (isStale(row, now)) {
      await ctx.db.patch(row._id, { endedAt: row.lastActiveAt });
      return false;
    }
    const reportsActivity =
      row.interactionTracked === true &&
      ((args.activeMs ?? 0) > 0 || args.lastInteractionAt !== undefined);
    if (
      reportsActivity ||
      now - row.lastActiveAt >= APP_PLAY_MIN_HEARTBEAT_INTERVAL_MS
    ) {
      await ctx.db.patch(row._id, {
        lastActiveAt: now,
        ...activityPatch(row, now, args),
      });
    }
    return true;
  },
});

/** "Off screen." Idempotent. `endedAt` is the host's own report of when
 *  the app left the screen (a call queued while iOS suspended the app lands
 *  later); it is clamped between the last check-in (for an
 *  interaction-tracked row, the last interaction) and the stale horizon, so
 *  it can only place the end where the host had evidence for it. Without it, the
 *  end is now — or the last check-in when the row has already gone stale.
 *  A `resumes` that no longer matches means a newer start() reopened the
 *  row, which is then not this caller's to close. */
export const end = authedMutation({
  args: {
    playSessionId: v.id("appPlaySessions"),
    resumes: v.number(),
    endedAt: v.optional(v.number()),
    ...activityArgs,
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ownedRow(ctx, args.playSessionId);
    if (!row || row.endedAt !== undefined || row.resumes !== args.resumes) {
      return null;
    }
    const now = Date.now();
    const latest = Math.min(now, row.lastActiveAt + APP_PLAY_STALE_GAP_MS);
    // An interaction-tracking host may close an unattended interval BEFORE
    // its last check-in (at the last interaction + the active window, or at
    // the start if nobody touched it), but never before the last interaction
    // it reported. Older hosts can only close at or after the last check-in.
    const earliest = row.interactionTracked
      ? Math.max(row.startedAt, row.lastInteractionAt ?? row.startedAt)
      : row.lastActiveAt;
    const closeAt =
      args.endedAt === undefined
        ? isStale(row, now)
          ? row.lastActiveAt
          : now
        : Math.min(latest, Math.max(earliest, args.endedAt));
    const activity = activityPatch(row, closeAt, args);
    await ctx.db.patch(row._id, {
      lastActiveAt: closeAt,
      endedAt: closeAt,
      ...activity,
      // Shortening an interval can leave earlier credit past its new end.
      ...(row.interactionTracked
        ? {
            activeMs: Math.min(
              Math.max(0, closeAt - row.startedAt),
              activity.activeMs ?? row.activeMs ?? 0,
            ),
          }
        : {}),
    });
    return null;
  },
});

/** The newest interval for one app. */
export async function readLatestAppPlayForArtifact(
  ctx: QueryCtx,
  artifactId: Id<"artifacts">,
): Promise<LatestAppPlay | null> {
  const row = await firstPlayedRow(
    ctx.db
      .query("appPlaySessions")
      .withIndex("by_artifact_startedAt", (q) => q.eq("artifactId", artifactId))
      .order("desc"),
  );
  return row ? toLatestAppPlay(row) : null;
}

/** The newest interval for one session, for the Portfolio's app rows. The
 *  caller has already gated access to the session's scholar. */
export async function readLatestAppPlayForSession(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<{ artifactId: Id<"artifacts">; play: LatestAppPlay } | null> {
  const row = await firstPlayedRow(
    ctx.db
      .query("appPlaySessions")
      .withIndex("by_session_startedAt", (q) => q.eq("sessionId", sessionId))
      .order("desc"),
  );
  return row ? { artifactId: row.artifactId, play: toLatestAppPlay(row) } : null;
}
