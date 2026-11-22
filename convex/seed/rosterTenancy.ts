// Seed invariant: every seeded roster stays inside one school.
//
// A real assignment or scholar group can't span two institutions: the teacher
// fails `requireScholarsAccessible` on her own roster, and anything that reuses
// an assignment skips it and makes a second one. A seed that breaks this makes
// correct tenancy behavior look like a bug in whatever is being tested against
// dev or a preview (TRA-615: two Friends scholars sat on a Moli assignment).
//
// The rule, per roster:
//   - a scholar group: every member's `institutionId` equals the group's
//     (or, for an unstamped group, all members share one);
//   - an assignment: all roster scholars share one institution — the
//     assignment's group's, when it has one — and, once the teacher has
//     school memberships, it is one of the teacher's schools.
//
// Called by the rich seed (over the rosters it inserted) and at the end of the
// Vercel preview seed (over the whole fresh deployment), so drift throws.

import { internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type InstitutionKey = Id<"institutions"> | "none";

async function scholarSchools(
  ctx: QueryCtx,
  scholarIds: Id<"users">[],
): Promise<Map<Id<"users">, InstitutionKey>> {
  const out = new Map<Id<"users">, InstitutionKey>();
  for (const id of scholarIds) {
    const user = await ctx.db.get(id);
    out.set(id, user?.institutionId ?? "none");
  }
  return out;
}

async function describe(
  ctx: QueryCtx,
  schools: Map<Id<"users">, InstitutionKey>,
): Promise<string> {
  const parts: string[] = [];
  for (const [scholarId, school] of schools) {
    const user = await ctx.db.get(scholarId);
    const inst = school === "none" ? null : await ctx.db.get(school);
    parts.push(`${user?.username ?? scholarId} @ ${inst?.slug ?? "no school"}`);
  }
  return parts.join(", ");
}

function distinct(schools: Map<Id<"users">, InstitutionKey>): InstitutionKey[] {
  return [...new Set(schools.values())];
}

async function groupViolation(
  ctx: QueryCtx,
  group: Doc<"scholarGroups">,
): Promise<string | null> {
  const schools = await scholarSchools(ctx, group.scholarIds);
  const keys = distinct(schools);
  const ok = group.institutionId
    ? keys.every((k) => k === group.institutionId)
    : keys.length <= 1;
  if (ok) return null;
  const inst = group.institutionId ? await ctx.db.get(group.institutionId) : null;
  return `scholar group "${group.name}" (${inst?.slug ?? "unstamped"}) has members from another school: ${await describe(ctx, schools)}`;
}

async function assignmentViolation(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
): Promise<string | null> {
  const schools = await scholarSchools(ctx, assignment.scholarIds);
  const keys = distinct(schools);
  const label = `assignment "${assignment.title ?? assignment._id}"`;
  if (keys.length > 1) {
    return `${label} has a roster spanning schools: ${await describe(ctx, schools)}`;
  }
  const rosterSchool = keys[0];
  if (rosterSchool === undefined) return null; // empty roster

  if (assignment.scholarGroupId) {
    const group = await ctx.db.get(assignment.scholarGroupId);
    if (group?.institutionId && group.institutionId !== rosterSchool) {
      return `${label} roster is outside its group "${group.name}"'s school: ${await describe(ctx, schools)}`;
    }
  }

  const teacherSchools = (
    await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", assignment.teacherId))
      .collect()
  )
    .map((m) => m.institutionId)
    .filter((id): id is Id<"institutions"> => id !== undefined);
  if (teacherSchools.length > 0 && !teacherSchools.includes(rosterSchool as Id<"institutions">)) {
    const teacher = await ctx.db.get(assignment.teacherId);
    return `${label} roster is outside teacher ${teacher?.username ?? assignment.teacherId}'s schools: ${await describe(ctx, schools)}`;
  }
  return null;
}

/**
 * Every cross-school roster among the given rows (or the whole deployment when
 * no ids are passed). Empty means the invariant holds.
 */
export async function findCrossSchoolRosters(
  ctx: QueryCtx,
  scope?: {
    groupIds: Id<"scholarGroups">[];
    assignmentIds: Id<"assignments">[];
  },
): Promise<string[]> {
  const groups = scope
    ? (await Promise.all(scope.groupIds.map((id) => ctx.db.get(id)))).filter(
        (g): g is Doc<"scholarGroups"> => g !== null,
      )
    : await ctx.db.query("scholarGroups").collect();
  const assignments = scope
    ? (await Promise.all(scope.assignmentIds.map((id) => ctx.db.get(id)))).filter(
        (a): a is Doc<"assignments"> => a !== null,
      )
    : await ctx.db.query("assignments").collect();

  const violations: string[] = [];
  for (const g of groups) {
    const v = await groupViolation(ctx, g);
    if (v) violations.push(v);
  }
  for (const a of assignments) {
    const v = await assignmentViolation(ctx, a);
    if (v) violations.push(v);
  }
  return violations;
}

/** Throws, listing every violation, if any seeded roster spans schools. */
export async function assertSeedRostersSingleSchool(
  ctx: QueryCtx,
  scope?: Parameters<typeof findCrossSchoolRosters>[1],
): Promise<void> {
  const violations = await findCrossSchoolRosters(ctx, scope);
  if (violations.length > 0) {
    throw new Error(
      `Seed tenancy invariant broken (TRA-615) — a roster spans schools:\n- ${violations.join("\n- ")}`,
    );
  }
}

/** Whole-deployment check, run as the last step of the preview seed. */
export const assertRostersSingleSchool = internalQuery({
  args: {},
  handler: async (ctx) => {
    await assertSeedRostersSingleSchool(ctx);
    return null;
  },
});
