// `curriculum:run` — "you can run the units you make."
//
// A staffer who builds curriculum (curriculum:edit) may also be granted the
// right to RUN it without becoming a teacher. Teacher access opens every
// scholar's learning record school-wide; this capability opens none of it.
// The boundary is OWNERSHIP, not a roster:
//
//   - assign a unit she can EDIT to scholars at that unit's school
//     (requireRunnableUnit + requireScholarsAtInstitution);
//   - push / schedule / reschedule / clear on assignments she OWNS
//     (requireCanRunOwnedAssignment — the role half only; callers keep the
//     a.teacherId === user._id check);
//   - read completion + hand-ins on those assignments, and nothing else about
//     a scholar (no transcript, mastery, dossier, portfolio, signals);
//   - Preflight with a SYNTHETIC scholar only (sessions.create).
//
// It deliberately grants no institution lens (staffCapabilityInstitutionIds
// skips it) and never widens accessibleScholarIds. The one roster it reads is
// assignableScholarsForRunner: names, for picking assignees at the unit's
// school. Scoping by scholar group was considered and rejected.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isTeacherRole } from "./roles";
import { authorizedInstitutionIds } from "./staffCapabilities";
import { requireUnitEditAccessForUser } from "./auth";
import { primaryInstitutionId } from "./primaryInstitution";
import {
  hasScholarMembership,
  scholarIdsForInstitution,
  scholarInstitutionId,
} from "./scholarEnrollment";
import { isEnrolledScholar } from "./enrollmentStanding";

type Ctx = QueryCtx | MutationCtx;

/**
 * Live institutions where this user holds BOTH curriculum:run and
 * curriculum:edit with active staff standing. curriculum:run alone is inert:
 * the capability only means "run what you can edit".
 */
export async function curriculumRunInstitutionIds(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<Set<Id<"institutions">>> {
  const run = await authorizedInstitutionIds(ctx, userId, "curriculum:run");
  if (run.size === 0) return run;
  const edit = await authorizedInstitutionIds(ctx, userId, "curriculum:edit");
  return new Set([...run].filter((id) => edit.has(id)));
}

/** Whether a NON-teacher holds a usable curriculum:run grant anywhere. */
export async function hasCurriculumRunAccess(
  ctx: Ctx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<boolean> {
  if (isTeacherRole(user.role)) return false;
  return (await curriculumRunInstitutionIds(ctx, user._id)).size > 0;
}

/** The execution role half: teacher-equivalent, or a curriculum:run holder. */
export async function canRunAssignments(
  ctx: Ctx,
  user: Pick<Doc<"users">, "_id" | "role">,
): Promise<boolean> {
  return isTeacherRole(user.role) || (await hasCurriculumRunAccess(ctx, user));
}

/**
 * A non-teacher may run this unit: she can edit it (the same check the
 * designer uses) AND holds curriculum:run at the unit's own school. A
 * scholar's own Quest unit is never runnable this way.
 */
export async function requireRunnableUnit(
  ctx: Ctx,
  user: Doc<"users">,
  unitId: Id<"units">,
): Promise<{ unit: Doc<"units">; institutionId: Id<"institutions"> }> {
  const { unit } = await requireUnitEditAccessForUser(ctx, user, { unitId });
  if (unit.authorScholarId) {
    throw new Error("Forbidden: a scholar's own unit can't be assigned here");
  }
  // Resolved the way requireUnitEditAccessForUser does: an unstamped
  // pre-tenancy unit belongs to the primary school.
  const institutionId =
    unit.institutionId ?? (await primaryInstitutionId(ctx)) ?? undefined;
  if (!institutionId) throw new Error("Forbidden: unit has no school");
  const runIds = await curriculumRunInstitutionIds(ctx, user._id);
  if (!runIds.has(institutionId)) {
    throw new Error(
      "Forbidden: running this unit needs curriculum:run at its school",
    );
  }
  return { unit, institutionId };
}

/**
 * The role half for an assignment the caller already OWNS. Teachers pass by
 * role; anyone else must still be able to run the assignment's unit (so a
 * revoked grant, a lost edit right or a suspended school ends it). Callers
 * keep the ownership check — this never substitutes for it.
 */
export async function requireCanRunOwnedAssignment(
  ctx: Ctx,
  user: Doc<"users">,
  assignment: Pick<Doc<"assignments">, "unitId">,
): Promise<void> {
  if (isTeacherRole(user.role)) return;
  if (!assignment.unitId) {
    throw new Error("Forbidden: teacher or admin role required");
  }
  await requireRunnableUnit(ctx, user, assignment.unitId);
}

/**
 * The assignments of `unitId` this user OWNS and can still run, as id strings
 * (the runner analogue of "every run of this unit"). Teachers never need it.
 */
export async function runnableOwnedAssignmentIds(
  ctx: Ctx,
  user: Doc<"users">,
  unitId: Id<"units">,
): Promise<Set<string>> {
  const mine = await ctx.db
    .query("assignments")
    .withIndex("by_teacher", (q) => q.eq("teacherId", user._id))
    .collect();
  const ids = new Set<string>();
  let runnable: boolean | undefined;
  for (const a of mine) {
    if (a.unitId !== unitId) continue;
    if (runnable === undefined) {
      try {
        await requireCanRunOwnedAssignment(ctx, user, a);
        runnable = true;
      } catch {
        runnable = false;
      }
    }
    if (runnable) ids.add(String(a._id));
  }
  return ids;
}

/**
 * The real-session scope for a unit's aggregate reads (counts, roll-ups,
 * maturity lamps). `null` = unscoped (a teacher, or anyone who isn't a
 * curriculum:run holder — their existing behavior stands). For a
 * curriculum:run holder: only her own runnable assignments of this unit, so
 * a teacher's run of the same unit never moves her numbers.
 */
export async function curriculumRunnerScopeForUnit(
  ctx: Ctx,
  user: Doc<"users">,
  unitId: Id<"units">,
): Promise<Set<string> | null> {
  if (isTeacherRole(user.role)) return null;
  if (!(await hasCurriculumRunAccess(ctx, user))) return null;
  return await runnableOwnedAssignmentIds(ctx, user, unitId);
}

/**
 * Validate named assignees against ONE school without a scholar lens: each
 * must be a learner whose school is `institutionId`. Deliberately narrower
 * than accessibleScholarIds — it answers "is this id at that school", and
 * reads nothing else about the scholar.
 */
export async function requireScholarsAtInstitution(
  ctx: Ctx,
  scholarIds: readonly Id<"users">[],
  institutionId: Id<"institutions">,
): Promise<void> {
  for (const scholarId of new Set(scholarIds)) {
    if (
      !(await hasScholarMembership(ctx, scholarId)) ||
      (await scholarInstitutionId(ctx, scholarId)) !== institutionId
    ) {
      throw new Error("Forbidden: scholar is not at this unit's school");
    }
  }
}

export type RunnerAssignableScholar = {
  id: Id<"users">;
  name: string;
  username: string | null;
  image: string | null;
  enrollmentStanding: "enrolled" | "program_guest";
};

/**
 * The assignee picker for a runner: identity only (name, username, avatar,
 * enrolled vs Extended Education) for scholars at the given schools. No
 * reading level, grade, birthday, activity or group membership.
 */
export async function runnerAssignableScholars(
  ctx: Ctx,
  institutionIds: Iterable<Id<"institutions">>,
): Promise<RunnerAssignableScholar[]> {
  const out: RunnerAssignableScholar[] = [];
  const seen = new Set<string>();
  for (const institutionId of institutionIds) {
    for (const id of await scholarIdsForInstitution(ctx, institutionId)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const scholar = await ctx.db.get(id);
      if (!scholar) continue;
      out.push({
        id,
        name: scholar.name ?? scholar.username ?? "(unnamed)",
        username: scholar.username ?? null,
        image: scholar.image ?? null,
        enrollmentStanding: isEnrolledScholar(scholar)
          ? "enrolled"
          : "program_guest",
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
