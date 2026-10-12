// Unit publication — whether scholars can find and start a catalog unit on
// their own (TRA-490).
//
// A new catalog unit is UNPUBLISHED: teachers see and edit it in the
// curriculum browser, scholars do not see it in Start a Quest and cannot open
// a session on it unless they hold an assignment to it. A teacher publishes it
// explicitly (`units.publish`) or by assigning it — every assignment path that
// names a unit calls `publishUnitOnAssign`.
//
// The stored field is `units.unpublished`, and ABSENT means published, so
// every unit that existed before this field reads as published with no
// migration. Scholar-owned Independent Study units (`authorScholarId`) are
// never unpublished: they are private to their author already.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireUnitAccessForUser } from "./unitAccess";

/** True when scholars may find and start this unit without an assignment. */
export function isUnitPublished(unit: Pick<Doc<"units">, "unpublished">): boolean {
  return unit.unpublished !== true;
}

/**
 * Assigning a unit publishes it (Andy's ruling, TRA-490). Called by every
 * assignment path that names a unit, whether it creates the assignment or
 * reuses an existing one. A no-op for a unit that is already published.
 *
 * Publishes only when the assigning caller can access the unit
 * (`requireUnitAccessForUser`), so an assignment path that does not itself
 * check unit tenancy can never flip another school's unit. It does not
 * refuse the assignment — that tenancy gap predates publication.
 */
export async function publishUnitOnAssign(
  ctx: MutationCtx,
  unitId: Id<"units"> | undefined,
  callerId: Id<"users">,
): Promise<void> {
  if (!unitId) return;
  const unit = await ctx.db.get(unitId);
  if (!unit || unit.unpublished !== true) return;
  const caller = await ctx.db.get(callerId);
  if (!caller) return;
  try {
    await requireUnitAccessForUser(ctx, caller, unitId);
  } catch {
    return;
  }
  await ctx.db.patch(unitId, { unpublished: undefined });
}

/**
 * Whether a live (non-archived) assignment of this unit names this scholar —
 * the one way a scholar may start an unpublished unit (a teacher unpublished
 * it after assigning it).
 */
export async function scholarHoldsAssignmentForUnit(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
): Promise<boolean> {
  const assignments = await ctx.db
    .query("assignments")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  return assignments.some(
    (assignment) =>
      !assignment.archivedAt &&
      assignment.scholarIds.some((id) => id === scholarId),
  );
}
