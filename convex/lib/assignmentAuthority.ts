// Who may act on an assignment, and which school it belongs to.
//
// An assignment belongs to the teacher who made it (`teacherId`). Two other
// people may also change it: a platform admin (global by design) and a
// school admin at the assignment's own school. Before this, every assignment
// write was owner-only, so a Head of School could not add a visiting child to
// another teacher's class, on the web or through the aide.
//
// The school admin path is tenant-checked: the admin needs a LIVE
// `school_admin` membership at the institution the assignment resolves to,
// and an assignment whose sources disagree about its school resolves to none.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { primaryInstitutionId } from "./primaryInstitution";
import { isPlatformAdminRole } from "./roles";
import { hasActiveStaffMembershipAtInstitution } from "./staffCapabilities";

type DbCtx = QueryCtx | MutationCtx;

/**
 * The school an assignment belongs to. Every source present must agree: its
 * coached group's school, its unit's school, and the schools of the scholars
 * on its roster. Any disagreement (a school A unit run with school B
 * scholars) resolves to null, so neither school's admin gains authority over
 * a mixed row. With no stamped source at all, a unit with no school is the
 * primary school's (the schema's rule for legacy units).
 */
export async function assignmentInstitutionId(
  ctx: DbCtx,
  assignment: Doc<"assignments">,
): Promise<Id<"institutions"> | null> {
  const found = new Set<Id<"institutions">>();
  if (assignment.scholarGroupId) {
    const group = await ctx.db.get(assignment.scholarGroupId);
    if (group?.institutionId) found.add(group.institutionId);
  }
  const unit = assignment.unitId ? await ctx.db.get(assignment.unitId) : null;
  if (unit?.institutionId) found.add(unit.institutionId);
  const scholars = await Promise.all(
    assignment.scholarIds.map((scholarId) => ctx.db.get(scholarId)),
  );
  for (const scholar of scholars) {
    if (scholar?.institutionId) found.add(scholar.institutionId);
  }
  if (found.size === 1) return [...found][0];
  if (found.size > 1) return null;
  if (unit) return await primaryInstitutionId(ctx);
  return null;
}

/**
 * Where the caller may act as an assignment admin: "all" for a platform
 * admin, otherwise the schools where they hold a live `school_admin`
 * membership (often none). Resolve it once when checking many assignments.
 */
export async function assignmentAdminScope(
  ctx: DbCtx,
  caller: Pick<Doc<"users">, "_id" | "role">,
): Promise<"all" | Set<Id<"institutions">>> {
  if (isPlatformAdminRole(caller.role)) return "all";
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", caller._id))
    .collect();
  const ids = new Set<Id<"institutions">>();
  for (const m of memberships) {
    if (m.role !== "school_admin" || !m.institutionId) continue;
    if (await hasActiveStaffMembershipAtInstitution(ctx, caller._id, m.institutionId)) {
      ids.add(m.institutionId);
    }
  }
  return ids;
}

/** Owner, or an admin with authority over the assignment's school. Pass a
 *  precomputed `scope` when checking many rows for one caller. */
export async function mayActOnAssignment(
  ctx: DbCtx,
  caller: Pick<Doc<"users">, "_id" | "role">,
  assignment: Doc<"assignments">,
  scope?: "all" | Set<Id<"institutions">>,
): Promise<boolean> {
  if (assignment.teacherId === caller._id) return true;
  const admin = scope ?? (await assignmentAdminScope(ctx, caller));
  if (admin === "all") return true;
  if (admin.size === 0) return false;
  const institutionId = await assignmentInstitutionId(ctx, assignment);
  return institutionId !== null && admin.has(institutionId);
}
