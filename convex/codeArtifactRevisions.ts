// App-designer version history (review/teacher-build-flow.html §2/§5).
//
// The live `artifacts` row keeps only the current html + a monotonic
// `revision`; `edit_document` overwrites in place. One `codeArtifactRevisions`
// row is recorded per DESIGNER TURN that changed the app — SERVER-SIDE, at the
// end of the turn in the stream commit path (convex/http.ts) — plus one row on
// a manual edit / Restore through `artifacts.scholarUpdate`. Recording no
// longer runs in the browser, so a closed tab, a native build, or an aide
// write can never drop a revision (F3/F11).

import { v } from "convex/values";
import type { GenericQueryCtx, GenericMutationCtx } from "convex/server";
import { authedQuery } from "./lib/customFunctions";
import { internalMutation, internalQuery } from "./_generated/server";
import { isTeacherRole } from "./lib/roles";
import { requireActiveScholarAccess } from "./lib/access";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import { pickFocusApp, pickTurnRecordApp } from "./lib/focusApp";
import {
  assertMayReadTeacherArchived,
  mayReadTeacherArchived,
} from "./lib/teacherArchive";
import { isTeacherArchived } from "../shared/teacherArchive";

type MutationCtx = GenericMutationCtx<DataModel>;

/** Retention cap per session — each row holds a full app html snapshot. */
export const MAX_REVISIONS_PER_SESSION = 30;

async function requireSessionRead(
  ctx: GenericQueryCtx<DataModel> & { user: Doc<"users"> },
  sessionId: Id<"sessions">,
): Promise<Doc<"sessions"> | null> {
  const session = await ctx.db.get(sessionId);
  if (!session) return null;
  const isTeacher = isTeacherRole(ctx.user.role);
  if (!isTeacher && session.userId !== ctx.user._id) return null;
  if (isTeacher && session.userId !== ctx.user._id) {
    await requireActiveScholarAccess(ctx, ctx.user, session.userId);
  }
  // A put-away app's history is teacher-only until a teacher restores it.
  if (!mayReadTeacherArchived(ctx.user, session)) return null;
  return session;
}

/**
 * Insert one code revision, idempotent per (artifactId, revision) — a re-run
 * with the same revision returns the existing row. Shared by the server-side
 * turn recorder and the `scholarUpdate` manual-edit/Restore path. Callers hold
 * db access already (both are mutations), so this is a plain helper, never a
 * client-callable mutation.
 */
export async function insertCodeRevision(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    artifactId: Id<"artifacts">;
    revision: number;
    html: string;
    messageId?: Id<"messages">;
    requestText?: string | null;
    restoredFromRevision?: number;
  },
): Promise<Id<"codeArtifactRevisions">> {
  const existing = await ctx.db
    .query("codeArtifactRevisions")
    .withIndex("by_artifact_revision", (q) =>
      q.eq("artifactId", args.artifactId).eq("revision", args.revision),
    )
    .first();
  if (existing) return existing._id;

  const id = await ctx.db.insert("codeArtifactRevisions", {
    sessionId: args.sessionId,
    artifactId: args.artifactId,
    revision: args.revision,
    html: args.html,
    ...(args.messageId ? { messageId: args.messageId } : {}),
    ...(args.requestText ? { requestText: args.requestText } : {}),
    ...(args.restoredFromRevision !== undefined
      ? { restoredFromRevision: args.restoredFromRevision }
      : {}),
    createdAt: Date.now(),
  });

  // Retention cap: each row holds the full app html (up to ~700 KB), so keep
  // only the newest N per session, deleting the oldest in the SAME transaction
  // as the insert (F2). Bounds a long build to a fixed footprint.
  const all = await ctx.db
    .query("codeArtifactRevisions")
    .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  if (all.length > MAX_REVISIONS_PER_SESSION) {
    const oldestFirst = all
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.revision - b.revision);
    for (const row of oldestFirst.slice(
      0,
      all.length - MAX_REVISIONS_PER_SESSION,
    )) {
      await ctx.db.delete(row._id);
    }
  }
  return id;
}

/** The request that produced a turn: the newest non-empty user message at or
 * before the producing assistant message. Resolved ONCE, at record time. */
async function resolveProducingRequest(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  messageId: Id<"messages"> | undefined,
): Promise<string | null> {
  if (!messageId) return null;
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("asc")
    .collect();
  const anchorIndex = messages.findIndex((m) => m._id === messageId);
  const from = anchorIndex === -1 ? messages.length - 1 : anchorIndex;
  for (let i = from; i >= 0; i -= 1) {
    if (messages[i].role === "user" && messages[i].content.trim()) {
      return messages[i].content;
    }
  }
  return null;
}

/**
 * Record the current app revision for a designer turn, called from the stream
 * commit path once the assistant message is finalized. Reads the session's
 * newest code artifact and records a row ONLY when it changed this turn
 * (a new artifact, or a revision beyond the pre-turn baseline). Idempotent, and
 * reports back whether the caller should autosave the promotion to the starter.
 */
export const recordTurnRevision = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    baselineArtifactId: v.optional(v.id("artifacts")),
    baselineRevision: v.number(),
    // TRA-519: the app the builder had open for this turn. An app created
    // this turn is still the turn's app; otherwise the open one is versioned,
    // not the newest. Absent = the newest app (old behavior).
    focusArtifactId: v.optional(v.id("artifacts")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    recorded: boolean;
    artifactId?: Id<"artifacts">;
    revision?: number;
    autosaveActivityId?: Id<"activities">;
  }> => {
    // Put away by a teacher mid-turn: record nothing and never autosave. A
    // quiet no-op, not a throw — this runs in the stream's commit path, where
    // a throw would cost the turn's finalization (the tutor's code writes are
    // already refused in artifacts.ai*).
    const owning = await ctx.db.get(args.sessionId);
    if (owning && isTeacherArchived(owning)) {
      return { recorded: false };
    }
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const turnMessage = await ctx.db.get(args.messageId);
    const artifact = pickTurnRecordApp(
      artifacts,
      args.sessionId,
      args.focusArtifactId,
      turnMessage?._creationTime ?? null,
    );
    if (!artifact) return { recorded: false };

    const revision = artifact.revision ?? 0;
    const isNewArtifact =
      !args.baselineArtifactId ||
      String(artifact._id) !== String(args.baselineArtifactId);
    const changed = isNewArtifact || revision > args.baselineRevision;
    if (!changed) return { recorded: false };

    const requestText = await resolveProducingRequest(
      ctx,
      args.sessionId,
      args.messageId,
    );
    await insertCodeRevision(ctx, {
      sessionId: args.sessionId,
      artifactId: artifact._id,
      revision,
      html: artifact.content,
      messageId: args.messageId,
      requestText,
    });

    // A teacher build hand-off (isTestDrive rehearsal whose activity carries an
    // appRequest, owned by the rehearsing teacher) autosaves its app to the
    // activity starter. Everyone else records history only.
    const session = await ctx.db.get(args.sessionId);
    let autosaveActivityId: Id<"activities"> | undefined;
    // A free-play copy (TRA-489) never writes back into the activity's starter.
    if (session?.isTestDrive && session.activityId && session.freePlay !== true) {
      const activity = await ctx.db.get(session.activityId);
      if (activity?.appRequest != null) {
        autosaveActivityId = session.activityId;
      }
    }
    return {
      recorded: true,
      artifactId: artifact._id,
      revision,
      autosaveActivityId,
    };
  },
});

/**
 * List the session's code revisions, newest first, as METADATA ONLY (never the
 * html — a dozen 700 KB revisions would blow the per-query read cap, F5).
 * `version` is a dense per-session number (v1 = oldest), the same number the
 * inline turn markers show. Restore fetches html on click via `getRevisionHtml`.
 */
export const listForSession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await requireSessionRead(ctx, args.sessionId);
    if (!session) return [];

    const revisions = await ctx.db
      .query("codeArtifactRevisions")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    if (revisions.length === 0) return [];

    const oldestFirst = revisions
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.revision - b.revision);
    const versionById = new Map<Id<"codeArtifactRevisions">, number>();
    oldestFirst.forEach((rev, index) => versionById.set(rev._id, index + 1));

    return await Promise.all(
      oldestFirst
        .slice()
        .reverse()
        .map(async (rev) => {
          const message = rev.messageId
            ? await ctx.db.get(rev.messageId)
            : null;
          return {
            id: rev._id,
            // Which app this version belongs to: a session can hold more
            // than one, and a builder lists only its app's versions.
            artifactId: String(rev.artifactId),
            revision: rev.revision,
            version: versionById.get(rev._id) ?? rev.revision,
            createdAt: rev.createdAt,
            requestText: rev.requestText ?? null,
            snapshotStorageId:
              message?.renderCheck?.snapshotStorageId ?? null,
            snapshotUrl: message?.renderCheck?.snapshotStorageId
              ? await ctx.storage.getUrl(message.renderCheck.snapshotStorageId)
              : null,
            restoredFromRevision: rev.restoredFromRevision ?? null,
            messageId: rev.messageId ? String(rev.messageId) : null,
          };
        }),
    );
  },
});

/** The pre-turn baseline the stream commit path captures before running the
 * tool runner, so `recordTurnRevision` can tell whether the app changed this
 * turn. Same "newest code artifact by creation time" pick the recorder uses. */
export const newestCodeArtifactBaseline = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    // TRA-519: the app open in the builder this turn; its baseline is the
    // one recordTurnRevision compares against. Absent = the newest app.
    focusArtifactId: v.optional(v.id("artifacts")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ artifactId: Id<"artifacts">; revision: number } | null> => {
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const artifact = pickFocusApp(
      artifacts,
      args.sessionId,
      args.focusArtifactId,
    );
    if (!artifact) return null;
    return { artifactId: artifact._id, revision: artifact.revision ?? 0 };
  },
});

/** Fetch one revision's html for Restore, resolved on click (owner/teacher). */
export const getRevisionHtml = authedQuery({
  args: { revisionId: v.id("codeArtifactRevisions") },
  handler: async (ctx, args) => {
    const rev = await ctx.db.get(args.revisionId);
    if (!rev) return null;
    // A one-shot fetch on Restore click (not a subscription), so a scholar
    // gets the legible refusal rather than a bare "Forbidden".
    const owning = await ctx.db.get(rev.sessionId);
    if (owning?.userId === ctx.user._id) {
      assertMayReadTeacherArchived(ctx.user, owning);
    }
    const session = await requireSessionRead(ctx, rev.sessionId);
    if (!session) throw new Error("Forbidden");
    return { html: rev.html, revision: rev.revision };
  },
});
