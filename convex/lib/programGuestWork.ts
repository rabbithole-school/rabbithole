import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { entryTargetsScholar, isLiveEntry } from "../assignments";
import { includesProgramGuests } from "../../shared/scholarGroupRouting";

type ProgramGuestWorkCtx = QueryCtx | MutationCtx;

async function assignedProgramAssignmentsForScholar(
  ctx: ProgramGuestWorkCtx,
  scholarId: Id<"users">,
) {
  const assignments = await ctx.db.query("assignments").collect();
  const eligible: Doc<"assignments">[] = [];
  const now = Date.now();
  for (const assignment of assignments) {
    if (
      assignment.archivedAt ||
      !assignment.unitId ||
      !assignment.scholarGroupId ||
      !assignment.scholarIds.includes(scholarId) ||
      !(assignment.activitySchedule ?? []).some(
        (entry) =>
          entryTargetsScholar(entry, scholarId) &&
          isLiveEntry(entry, now),
      )
    ) {
      continue;
    }
    const group = await ctx.db.get(assignment.scholarGroupId);
    if (group && includesProgramGuests(group)) eligible.push(assignment);
  }
  return eligible;
}

/** Unit access for an Extended Education scholar is anchored to active program work. */
export async function assignedProgramUnitIdsForScholar(
  ctx: ProgramGuestWorkCtx,
  scholarId: Id<"users">,
): Promise<Set<Id<"units">>> {
  return new Set(
    (await assignedProgramAssignmentsForScholar(ctx, scholarId)).map(
      (assignment) => assignment.unitId!,
    ),
  );
}

export async function assignedProgramAssignmentForUnit(
  ctx: ProgramGuestWorkCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  activityId?: Id<"activities">,
): Promise<Doc<"assignments"> | null> {
  const now = Date.now();
  return (
    (await assignedProgramAssignmentsForScholar(ctx, scholarId)).find(
      (assignment) =>
        assignment.unitId === unitId &&
        (!activityId ||
          (assignment.activitySchedule ?? []).some(
            (entry) =>
              entry.activityId === activityId &&
              entryTargetsScholar(entry, scholarId) &&
              isLiveEntry(entry, now),
          )),
    ) ?? null
  );
}
