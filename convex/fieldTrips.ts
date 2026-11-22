// Field trips (TRA-601): staff enter them here, and the schedule reads honor
// them. A trip is its own record (schema.ts `fieldTrips`), never a closure:
// only the going groups miss class, and only the meetings that overlap the
// trip's window.
//
// Where the effect lands:
//   • classLink.classMeetingForGive: no class link to a meeting a trip cancels.
//   • giveWindow: a cancelled block is not offered and "in that class" during
//     a trip asks the teacher instead of guessing an end.
//   • masterSchedule.currentBlockForSelf: the scholar's Home names the trip
//     and drops the classes it cancels.
//   • parents.childHomeworkPlan: the parent Homework week shows a trip line.
//
// Entered on School › Classes & times (teachers and admins of that school).
// Every read and write is scoped to one institution (CLAUDE.md, multi-tenancy).

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { teacherMutation, teacherQuery } from "./lib/customFunctions";
import { assertCuratableInstitution } from "./lib/access";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { dayKeyForTimezone, shiftDayKey } from "../shared/institutionDay";
import { tripTimesProblem, type FieldTripSummary } from "../shared/fieldTrips";

type ReadCtx = Pick<QueryCtx, "db">;

/** A school's live (not canceled) trips in an inclusive day range. */
export async function loadInstitutionTrips(
  ctx: ReadCtx,
  institutionId: Id<"institutions">,
  fromDayKey: string,
  toDayKey: string,
): Promise<Doc<"fieldTrips">[]> {
  const rows = await ctx.db
    .query("fieldTrips")
    .withIndex("by_institution_day", (q) =>
      q.eq("institutionId", institutionId).gte("dayKey", fromDayKey).lte("dayKey", toDayKey),
    )
    .collect();
  return rows.filter((trip) => trip.canceledAt === undefined);
}

/** The trips some of `groupIds` go on. */
export function tripsForGroups<T extends Pick<Doc<"fieldTrips">, "groupIds">>(
  trips: readonly T[],
  groupIds: Iterable<Id<"scholarGroups"> | string>,
): T[] {
  const wanted = new Set([...groupIds].map(String));
  return trips.filter((trip) => trip.groupIds.some((id) => wanted.has(String(id))));
}

/** The groups of `institutionId` (legacy unstamped groups belong to the
 *  primary school), the same rule classLink.loadClassLinkData applies. */
async function institutionGroups(
  ctx: ReadCtx,
  institution: Doc<"institutions">,
): Promise<Doc<"scholarGroups">[]> {
  const groups = await ctx.db
    .query("scholarGroups")
    .withIndex("by_institution", (q) => q.eq("institutionId", institution._id))
    .collect();
  if (institution.isPrimary) {
    groups.push(
      ...(await ctx.db
        .query("scholarGroups")
        .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
        .collect()),
    );
  }
  return groups;
}

/** A scholar's trips in a day range: trips of their school that one of their
 *  groups goes on. */
export async function tripsForScholar(
  ctx: ReadCtx,
  scholarId: Id<"users">,
  fromDayKey: string,
  toDayKey: string,
): Promise<{ trips: FieldTripSummary[]; timeZone: string }> {
  const institutionId = await scholarInstitutionId(ctx as QueryCtx, scholarId);
  const institution = institutionId ? await ctx.db.get(institutionId) : null;
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  if (!institution) return { trips: [], timeZone };
  const trips = await loadInstitutionTrips(ctx, institution._id, fromDayKey, toDayKey);
  if (trips.length === 0) return { trips: [], timeZone };
  const myGroups = (await institutionGroups(ctx, institution))
    .filter((group) => group.scholarIds.includes(scholarId))
    .map((group) => group._id);
  return {
    timeZone,
    trips: tripsForGroups(trips, myGroups).map(summary),
  };
}

function summary(trip: Doc<"fieldTrips">): FieldTripSummary {
  return {
    dayKey: trip.dayKey,
    startLocal: trip.startLocal,
    endLocal: trip.endLocal,
    destination: trip.destination,
  };
}

/** The school a staff surface is looking at: one institution, never "all". */
async function lensInstitution(
  ctx: QueryCtx,
  user: Doc<"users">,
  scope: string | undefined,
): Promise<Doc<"institutions"> | null> {
  const lens = await resolveInstitutionLens(ctx, user, scope);
  if (lens.scope !== "institution" || !lens.institution) return null;
  return lens.institution;
}

// ── Staff surface: School › Classes & times ─────────────────────────────

/** The school's trips from last week on, plus its groups for the picker.
 *  `institution` is null under the all-schools lens: trips belong to one
 *  school, so the page asks for one. */
export const listForSchool = teacherQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const institution = await lensInstitution(ctx, ctx.user, args.scope);
    if (!institution) return { institution: null, trips: [], groups: [] };
    await assertCuratableInstitution(ctx, ctx.user, institution._id);
    const timeZone = effectiveInstitutionTimeZone(institution.timeZone);
    // t11-ok: the window only decides how far back past trips are listed.
    const today = dayKeyForTimezone(Date.now(), timeZone);
    const trips = await loadInstitutionTrips(
      ctx,
      institution._id,
      shiftDayKey(today, -7),
      "9999-12-31",
    );
    const groups = await institutionGroups(ctx, institution);
    return {
      institution: { id: institution._id, name: institution.name },
      todayDayKey: today,
      trips: trips
        .sort((a, b) => a.dayKey.localeCompare(b.dayKey) || a.startLocal.localeCompare(b.startLocal))
        .map((trip) => ({
          id: trip._id,
          groupIds: trip.groupIds,
          dayKey: trip.dayKey,
          startLocal: trip.startLocal,
          endLocal: trip.endLocal,
          destination: trip.destination,
          notes: trip.notes ?? null,
        })),
      groups: groups
        .map((group) => ({ id: group._id, name: group.name, emoji: group.emoji ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

const tripFields = {
  groupIds: v.array(v.id("scholarGroups")),
  dayKey: v.string(),
  startLocal: v.string(),
  endLocal: v.string(),
  destination: v.string(),
  notes: v.optional(v.string()),
};

type TripInput = {
  groupIds: Id<"scholarGroups">[];
  dayKey: string;
  startLocal: string;
  endLocal: string;
  destination: string;
  notes?: string;
};

/** Validate a trip against its school and return the fields to store. Every
 *  group must be the school's own: a trip never names another school's group.
 *  On an edit, a group the trip already had that has since left the school or
 *  been deleted drops out instead of blocking the save; only a newly named
 *  group is refused. */
async function checkedTripFields(
  ctx: QueryCtx,
  institution: Doc<"institutions">,
  input: TripInput,
  storedGroupIds: readonly Id<"scholarGroups">[] = [],
) {
  const destination = input.destination.trim();
  if (!destination) throw new Error("Where is the trip going?");
  const times = {
    dayKey: input.dayKey.trim(),
    startLocal: input.startLocal.trim(),
    endLocal: input.endLocal.trim(),
  };
  const problem = tripTimesProblem(times);
  if (problem) throw new Error(problem);
  const groupIds: Id<"scholarGroups">[] = [];
  for (const groupId of new Set(input.groupIds)) {
    const group = await ctx.db.get(groupId);
    const inSchool =
      group &&
      (group.institutionId === institution._id ||
        (group.institutionId === undefined && institution.isPrimary));
    if (inSchool) groupIds.push(groupId);
    else if (!storedGroupIds.includes(groupId)) {
      throw new Error("That group isn't at this school.");
    }
  }
  if (groupIds.length === 0) throw new Error("Which groups are going?");
  const notes = input.notes?.trim();
  return { ...times, groupIds, destination, notes: notes || undefined };
}

export const create = teacherMutation({
  args: { scope: v.optional(v.string()), ...tripFields },
  handler: async (ctx, { scope, ...input }) => {
    const institution = await lensInstitution(ctx, ctx.user, scope);
    if (!institution) throw new Error("Pick a school first: a trip belongs to one school.");
    await assertCuratableInstitution(ctx, ctx.user, institution._id);
    const fields = await checkedTripFields(ctx, institution, input);
    return await ctx.db.insert("fieldTrips", {
      institutionId: institution._id,
      ...fields,
      createdBy: ctx.user._id,
      updatedAt: Date.now(),
    });
  },
});

async function editableTrip(
  ctx: QueryCtx,
  user: Doc<"users">,
  tripId: Id<"fieldTrips">,
): Promise<{ trip: Doc<"fieldTrips">; institution: Doc<"institutions"> }> {
  const trip = await ctx.db.get(tripId);
  if (!trip || trip.canceledAt !== undefined) throw new Error("That trip is gone.");
  await assertCuratableInstitution(ctx, user, trip.institutionId);
  const institution = await ctx.db.get(trip.institutionId);
  if (!institution) throw new Error("That trip is gone.");
  return { trip, institution };
}

export const update = teacherMutation({
  args: { tripId: v.id("fieldTrips"), ...tripFields },
  handler: async (ctx, { tripId, ...input }) => {
    const { trip, institution } = await editableTrip(ctx, ctx.user, tripId);
    const fields = await checkedTripFields(ctx, institution, input, trip.groupIds);
    await ctx.db.patch(tripId, { ...fields, updatedAt: Date.now() });
  },
});

export const cancel = teacherMutation({
  args: { tripId: v.id("fieldTrips") },
  handler: async (ctx, { tripId }) => {
    await editableTrip(ctx, ctx.user, tripId);
    const now = Date.now();
    await ctx.db.patch(tripId, { canceledAt: now, updatedAt: now });
  },
});
