// Node/action half of vibecode starter promotion. The transactional validation
// and customApps write remain in activities.ts; this action only copies the
// referenced storage blobs (lib/appAssetCopy.ts) and commits the rewritten HTML.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  copyArtifactAppAssets,
  deleteAppAssetCopies,
} from "./lib/appAssetCopy";

type StarterPromotionResult = {
  id: Id<"customApps">;
  name: string;
  updatedAt: number;
};

/**
 * Promote a rehearsal artifact to an activity's vibecode starter, on behalf of
 * an EXPLICIT caller (never read from auth). The internal queries/mutations it
 * calls re-verify that `callerUserId` has unit-edit access AND owns the
 * test-drive session, so this is safe to run in a scheduled (no-identity)
 * context. Reached only through the server-side autosave helper below.
 */
async function promoteStarterFromArtifactImpl(
  ctx: ActionCtx,
  args: {
    callerUserId: Id<"users">;
    activityId: Id<"activities">;
    artifactId: Id<"artifacts">;
  },
): Promise<StarterPromotionResult> {
  const { callerUserId, activityId, artifactId } = args;
  const source: { title: string; html: string; revision: number } =
    await ctx.runQuery(internal.activities.prepareVibecodeStarterFromArtifact, {
      activityId,
      artifactId,
      callerUserId,
    });
  // Short-circuit BEFORE copying any asset blobs: on a re-promotion of the
  // same (artifact, revision) the copies below would be referenced by nothing
  // once commit returns its no-op result, leaking storage (F6).
  const alreadyPromoted: {
    id: Id<"customApps">;
    name: string;
    updatedAt: number;
  } | null = await ctx.runQuery(
    internal.activities.vibecodeStarterAlreadyPromoted,
    {
      activityId,
      artifactId,
      sourceRevision: source.revision,
      callerUserId,
    },
  );
  if (alreadyPromoted) return alreadyPromoted;
  const { html, copied } = await copyArtifactAppAssets(ctx, {
    artifactId,
    callerUserId,
    html: source.html,
  });
  try {
    return await ctx.runMutation(
      internal.activities.commitVibecodeStarterFromArtifact,
      {
        activityId,
        artifactId,
        callerUserId,
        sourceRevision: source.revision,
        html,
        appAssetIds: copied,
      },
    );
  } catch (error) {
    // The failed promotion has no durable reference to these copies.
    await deleteAppAssetCopies(ctx, copied);
    throw error;
  }
}

/**
 * The ONE "autosave this artifact to the starter, stamp failure" unit, shared
 * by the stream commit path (convex/http.ts `recordWorkshopTurn`) and the
 * manual-edit / Restore path (`artifacts.scholarUpdate` schedules it). Runs the
 * promotion for the session owner, swallows any failure, and records whether it
 * failed on the session so the Workshop can toast a NEW failure (and clear it
 * on the next success). Never throws — a failed autosave must not break the
 * turn that produced it.
 */
export const autosaveStarterFromArtifact = internalAction({
  args: {
    sessionId: v.id("sessions"),
    callerUserId: v.id("users"),
    activityId: v.id("activities"),
    artifactId: v.id("artifacts"),
  },
  handler: async (ctx, args): Promise<void> => {
    let autosaveFailed = false;
    try {
      await promoteStarterFromArtifactImpl(ctx, {
        callerUserId: args.callerUserId,
        activityId: args.activityId,
        artifactId: args.artifactId,
      });
    } catch (err) {
      console.error("[autosave-starter] app autosave failed:", err);
      autosaveFailed = true;
    }
    await ctx.runMutation(internal.sessions.setAppAutosaveFailed, {
      sessionId: args.sessionId,
      failed: autosaveFailed,
    });
  },
});

/**
 * Record this designer turn's app version (if it changed) and autosave a
 * teacher build session's app to the activity starter — the ONE unit extracted
 * from the stream commit path (convex/http.ts) so BOTH the normal path and the
 * error path can call it (G4). A code tool that succeeded before a later error
 * or abort must still leave a revision + autosave.
 *
 * Idempotent: `recordTurnRevision` inserts one row per (artifact, revision) and
 * the autosave short-circuits on an already-promoted (artifact, revision), so a
 * double call (normal path THEN a late error into the catch) is a no-op the
 * second time. NEVER throws — the caller runs lease-release + stream-close after
 * it, and those must not be skipped.
 */
export const recordWorkshopTurn = internalAction({
  args: {
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    callerUserId: v.id("users"),
    // TRA-519: this turn worked on an app — the session has builder features
    // (any session with an app, or a builder-primary one;
    // shared/appSurface.ts) or `create_code` ran this turn. Replaces the old
    // `sessionMode === "vibecode"` gate, so a chat session's app gets History
    // too.
    appBuild: v.boolean(),
    workshopMode: v.union(v.literal("edit"), v.literal("play")),
    baselineArtifactId: v.optional(v.id("artifacts")),
    baselineRevision: v.number(),
    // TRA-519: the app open in the builder this turn (recordTurnRevision).
    focusArtifactId: v.optional(v.id("artifacts")),
  },
  handler: async (ctx, args): Promise<void> => {
    // App turns in Edit only — Play never records or autosaves (F9), and a
    // turn with no app has nothing to version. (recordTurnRevision also finds
    // no code artifact and records nothing for such a session.)
    if (!args.appBuild || args.workshopMode === "play") {
      return;
    }
    try {
      const rec = await ctx.runMutation(
        internal.codeArtifactRevisions.recordTurnRevision,
        {
          sessionId: args.sessionId,
          messageId: args.messageId,
          ...(args.baselineArtifactId
            ? { baselineArtifactId: args.baselineArtifactId }
            : {}),
          baselineRevision: args.baselineRevision,
          ...(args.focusArtifactId
            ? { focusArtifactId: args.focusArtifactId }
            : {}),
        },
      );
      if (rec.recorded && rec.autosaveActivityId && rec.artifactId) {
        await ctx.runAction(
          internal.vibecodeStarterActions.autosaveStarterFromArtifact,
          {
            sessionId: args.sessionId,
            callerUserId: args.callerUserId,
            activityId: rec.autosaveActivityId,
            artifactId: rec.artifactId,
          },
        );
      }
    } catch (err) {
      // Never propagate: the stream's normal AND error paths call this right
      // before releasing the lease and closing the stream.
      console.error("[record-workshop-turn] failed:", err);
    }
  },
});
