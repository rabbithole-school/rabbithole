// Server half of the teacher archive for scholar-built apps
// (review/teacher-archive-scholar-apps.html; predicate + copy live in
// shared/teacherArchive.ts so web, iPad and server agree).
//
// Two guards, one per kind of chokepoint:
//   - assertNotTeacherArchived: every WRITE / undo / use path. Refuses EVERY
//     caller, teachers included — an archived app is read-only for everyone
//     until a teacher lifts it with sessions.restoreApp.
//   - mayReadTeacherArchived / assertMayReadTeacherArchived: scholar READ
//     paths of the app's code. Teacher roles read freely (Portfolio, remote
//     mode); anyone else is refused.

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  isTeacherArchived,
  TEACHER_ARCHIVE_COPY,
} from "../../shared/teacherArchive";
import { isTeacherRole, type Role } from "./roles";

export const TEACHER_ARCHIVED_CODE = "teacherArchived";

type ArchivableSession = Pick<Doc<"sessions">, "teacherArchivedAt">;

function refusal(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: TEACHER_ARCHIVED_CODE,
    message: TEACHER_ARCHIVE_COPY.refusal,
  });
}

/** Refuse any caller when a teacher has put this session's app away. */
export function assertNotTeacherArchived(
  session: ArchivableSession | null | undefined,
): void {
  if (session && isTeacherArchived(session)) throw refusal();
}

/** True when `caller` may read the app inside `session`. */
export function mayReadTeacherArchived(
  caller: { role?: Role | null } | null | undefined,
  session: ArchivableSession | null | undefined,
): boolean {
  if (!session || !isTeacherArchived(session)) return true;
  return isTeacherRole(caller?.role ?? null);
}

/** Refuse a non-teacher caller reading a teacher-archived session's app. */
export function assertMayReadTeacherArchived(
  caller: { role?: Role | null } | null | undefined,
  session: ArchivableSession | null | undefined,
): void {
  if (!mayReadTeacherArchived(caller, session)) throw refusal();
}

/** Load the session behind an id and refuse when it is teacher-archived. */
export async function assertSessionNotTeacherArchived(
  ctx: Pick<QueryCtx, "db">,
  sessionId: Id<"sessions"> | null | undefined,
): Promise<void> {
  if (!sessionId) return;
  assertNotTeacherArchived(await ctx.db.get(sessionId));
}

/** Does this session hold a scholar-built app (a `type: "code"` artifact)? */
export async function sessionHasCodeArtifact(
  ctx: Pick<QueryCtx, "db">,
  sessionId: Id<"sessions">,
): Promise<boolean> {
  const app = await ctx.db
    .query("artifacts")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .filter((q) => q.eq(q.field("type"), "code"))
    .first();
  return app !== null;
}

/**
 * The patch for un-archiving a session through a path that is NOT the teacher
 * restore (take-home "undo close", Quest reopen). A teacher-archived app must
 * stay archived, but the un-archive still happened from that path's point of
 * view, so record it as the state restoreApp returns to.
 */
export function unarchivePatch(session: {
  teacherArchivedAt?: number;
}): { isArchived: false } | { teacherArchivePriorArchived: false } {
  return session.teacherArchivedAt != null
    ? { teacherArchivePriorArchived: false }
    : { isArchived: false };
}
