import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { entryTargetsScholar, isLiveEntry } from "../assignments";
import { includesProgramGuests } from "../../shared/scholarGroupRouting";
import { readSchedule } from "./scheduleStore";

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
      !(await readSchedule(ctx, assignment)).some(
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
  for (const assignment of await assignedProgramAssignmentsForScholar(
    ctx,
    scholarId,
  )) {
    if (assignment.unitId !== unitId) continue;
    if (
      !activityId ||
      (await readSchedule(ctx, assignment)).some(
        (entry) =>
          entry.activityId === activityId &&
          entryTargetsScholar(entry, scholarId) &&
          isLiveEntry(entry, now),
      )
    ) {
      return assignment;
    }
  }
  return null;
}

/**
 * A scholar's OWN Quest (a unit they authored) is theirs to explore whatever
 * their standing: Extended Education isolation covers school-assigned work,
 * not a kid's curiosity. Program work a teacher assigns stays gated above.
 */
export function isOwnQuestUnit(
  unit: Pick<Doc<"units">, "authorScholarId"> | null,
  scholarId: Id<"users">,
): boolean {
  return !!unit && unit.authorScholarId === scholarId;
}

/** The refusal a program guest sees for unassigned school work. A
 *  ConvexError so production shows the sentence, not "Server Error". */
export function notAssignedProgramWork(): ConvexError<string> {
  return new ConvexError(
    "This isn't part of your assigned program work yet. Ask your teacher if you'd like to do it.",
  );
}
