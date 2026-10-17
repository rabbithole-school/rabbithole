/**
 * App designer scholar edit policy (TRA-301, review/teacher-build-flow.html §2
 * states F–H). ONE derivation, called from every place that must agree:
 *
 *  - `sessions.sendMessage` stamps `messages.thread` on the user turn and the
 *    assistant placeholder from the effective mode;
 *  - the `/session-stream` HTTP action re-derives it to pick the tool set, the
 *    prompt, and whether the turn may record a version (the body's `mode` is a
 *    REQUEST, never trusted — a scholar forging `mode: "edit"` under `never`
 *    runs a Play turn);
 *  - `sessions.getWithMessages` exposes the verdict as `effectiveEditAccess` so
 *    web and native render the lock / hidden-toggle states without re-deriving
 *    the policy.
 *
 * The pure half (`effectiveEditAccessFor`) is what the matrix tests pin; the
 * db half only gathers its inputs.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { isTeacherRole } from "./roles";
import { isAppActivity } from "../../shared/appSurface";
import {
  defaultWorkshopMode,
  effectiveWorkshopMode,
  threadForMode,
  type EditAccess,
  type EffectiveEditAccess,
  type WorkshopMode,
  type WorkshopThread,
} from "../../shared/workshopMode";

export type { EditAccess, EffectiveEditAccess, WorkshopMode, WorkshopThread };

export const EDIT_ACCESS_DEFAULT: EditAccess = "always";

/**
 * The verdict for one viewer of one session.
 *
 *  - A teacher-role caller is never gated: their own build session (the
 *    rehearsal that shapes the app) and any scholar session they open remotely
 *    both get `allowed`. The policy exists to shape a SCHOLAR's experience.
 *  - `always` (and an activity without the field, or a session without an
 *    activity) → `allowed` — today's behavior.
 *  - `never` → `hidden`: Play is the only state, no control rendered.
 *  - `afterCompletion` → `allowed` once the scholar's completion row exists,
 *    `locked` before it.
 */
export function effectiveEditAccessFor(args: {
  editAccess: EditAccess | null | undefined;
  callerRole: string | null | undefined;
  hasCompletion: boolean;
}): EffectiveEditAccess {
  if (isTeacherRole(args.callerRole as Doc<"users">["role"])) return "allowed";
  const policy = args.editAccess ?? EDIT_ACCESS_DEFAULT;
  if (policy === "never") return "hidden";
  if (policy === "afterCompletion") {
    return args.hasCompletion ? "allowed" : "locked";
  }
  return "allowed";
}

/**
 * Whether the session's scholar has finished the session's activity — under
 * the session's assignment when it has one. A session-scoped activity only
 * unlocks from a completion that belongs to THAT assignment: a row stamped with
 * the assignment, or a bare (un-backfilled) row written from a session that is
 * in the assignment (the session carries the scope the row lacks). A completion
 * that carries no assignment scope at all — a self-mark outside any run, or a
 * row from a session in some OTHER assignment — does NOT unlock an
 * assignment-scoped session; otherwise a scholar could mark the activity done
 * once (or in one cohort) and buy Edit in every other run of it. A session with
 * NO assignment accepts any completion of the activity.
 */
export async function scholarHasCompletedActivity(
  ctx: Pick<QueryCtx, "db">,
  args: {
    scholarId: Id<"users">;
    activityId: Id<"activities">;
    assignmentId: Id<"assignments"> | null | undefined;
  },
): Promise<boolean> {
  const rows = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar_activity", (q) =>
      q.eq("scholarId", args.scholarId).eq("activityId", args.activityId),
    )
    .collect();
  if (rows.length === 0) return false;
  if (!args.assignmentId) return true;
  for (const row of rows) {
    if (row.assignmentId === args.assignmentId) return true;
    // A bare row (predates assignment stamping) only counts when the session it
    // was written from is itself in this assignment — never a truly bare row or
    // a row from an unrelated session.
    if (row.assignmentId === undefined && row.sessionId) {
      const rowSession = await ctx.db.get(row.sessionId);
      if (rowSession?.assignmentId === args.assignmentId) return true;
    }
  }
  return false;
}

export type WorkshopPolicy = {
  /** The activity's stored policy (`always` when absent). */
  editAccess: EditAccess;
  /** The verdict for this caller on this session. */
  effectiveEditAccess: EffectiveEditAccess;
};

/**
 * Gather the inputs and derive the verdict for `caller` viewing `session`.
 * Cheap: one activity read + one indexed completion scan, and the scan is
 * skipped unless the policy actually depends on it.
 */
export async function resolveWorkshopPolicy(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  args: {
    session: Pick<
      Doc<"sessions">,
      "userId" | "activityId" | "assignmentId"
    >;
    caller: Pick<Doc<"users">, "_id" | "role">;
    /** The session's activity when the caller already loaded it (saves a read). */
    activity?: Doc<"activities"> | null;
  },
): Promise<WorkshopPolicy> {
  const activity =
    args.activity !== undefined
      ? args.activity
      : args.session.activityId
        ? await ctx.db.get(args.session.activityId)
        : null;
  // The policy is an app-activity field (either shape, TRA-519): an activity
  // that stopped being an app may still carry it, and it must not gate
  // anything then — a non-app activity resolves to `always`.
  const editAccess: EditAccess = isAppActivity(activity)
    ? (activity?.editAccess ?? EDIT_ACCESS_DEFAULT)
    : EDIT_ACCESS_DEFAULT;
  const needsCompletion =
    editAccess === "afterCompletion" &&
    activity != null &&
    !isTeacherRole(args.caller.role);
  const hasCompletion = needsCompletion
    ? await scholarHasCompletedActivity(ctx, {
        scholarId: args.session.userId,
        activityId: activity._id,
        assignmentId: args.session.assignmentId ?? null,
      })
    : false;
  return {
    editAccess,
    effectiveEditAccess: effectiveEditAccessFor({
      editAccess,
      callerRole: args.caller.role,
      hasCompletion,
    }),
  };
}

/**
 * The mode a requested turn runs in, and the thread it is stamped with.
 * `requested` absent (an older client that sends no mode) counts as an Edit
 * request — the same default `parseSessionStreamBody` applies — and is still
 * clamped by the verdict, so a legacy client under `never` gets Play.
 */
export function resolveTurnMode(
  requested: WorkshopMode | null | undefined,
  access: EffectiveEditAccess,
): { mode: WorkshopMode; thread: WorkshopThread } {
  const mode = effectiveWorkshopMode(requested ?? "edit", access);
  return { mode, thread: threadForMode(mode) };
}

export type WorkshopOpening = {
  /** The screen mode the Workshop opens in before any `?mode=` override. */
  defaultMode: WorkshopMode;
  /** Whether this session is a teacher build hand-off (auto-kickoff, build
   *  progress card). */
  teacherBuildKickoff: boolean;
  /** The caller has Edit only because they are staff: scholars on this
   *  activity cannot edit (yet), so the Edit segment is a teacher affordance. */
  teacherEditOverride: boolean;
};

/**
 * How the Workshop opens for this caller (TRA-477). ONE server rule, read by
 * web and native alike (`getWithMessages` -> `defaultWorkshopMode`,
 * `teacherBuildKickoff`, `teacherEditOverride`):
 *
 *  - A teacher REHEARSING an app scholars only play (the session opened on an
 *    existing starter, `vibecodeStarterUsedAt`, and the activity's
 *    `editAccess` is `never` or `afterCompletion`) opens in Play, because
 *    Play is what a scholar sees first. Edit stays available to the teacher
 *    (they may need to fix the app); it is just not the default, and the
 *    rehearsal is not a build hand-off, so no auto-kickoff fires.
 *  - Otherwise today's rule: a build hand-off (`appRequest` on a test drive)
 *    opens in Edit with the build partner; a coached scholar session opens in
 *    Play; a plain vibecode session opens in Edit.
 *
 * Keyed on the SESSION's starter snapshot, not the activity's current
 * `starterAppId`: the build session's own autosave writes the starter, and
 * the teacher who is building it must not be flipped to Play mid-build.
 */
export function workshopOpeningFor(args: {
  isTestDrive: boolean;
  callerRole: string | null | undefined;
  editAccess: EditAccess;
  /** The session was seeded from the activity's starter app. */
  openedOnStarter: boolean;
  hasAppRequest: boolean;
}): WorkshopOpening {
  const callerIsStaff = isTeacherRole(
    args.callerRole as Doc<"users">["role"],
  );
  const scholarsCannotEdit = args.editAccess !== "always";
  const rehearsesPlayableApp =
    args.isTestDrive &&
    callerIsStaff &&
    args.openedOnStarter &&
    scholarsCannotEdit;
  const teacherBuildKickoff =
    args.isTestDrive && args.hasAppRequest && !rehearsesPlayableApp;
  return {
    defaultMode: rehearsesPlayableApp
      ? "play"
      : defaultWorkshopMode({
          teacherBuildKickoff,
          hasAppRequest: args.hasAppRequest,
        }),
    teacherBuildKickoff,
    teacherEditOverride: callerIsStaff && scholarsCannotEdit,
  };
}
