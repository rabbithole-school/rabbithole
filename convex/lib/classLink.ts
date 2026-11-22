// A give's class link and end fields, derived at write time. Never guess a
// class from an ambiguous meeting.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  classMeetingAt,
  endFromRequestedWindow,
  meetingsOnDay,
  type GiveEnd,
  type RequestedWindow,
} from "../../shared/classMeetings";
import { dayKeyForTimezone, dayStartForDayKey } from "../../shared/institutionDay";
import { isRecurringClassMeeting } from "../../shared/meetingSlots";
import { classSubjectKey, unitSubjectFitsClass } from "./classResolver";
import { primaryInstitutionId } from "./primaryInstitution";
import { GiveQuestionError } from "./giveQuestionError";
import { effectiveInstitutionTimeZone } from "./institutionTime";
import { loadInstitutionClosures } from "../masterSchedule";
import { isClosedDay, type SchoolClosure } from "../../shared/schoolClosures";
import { loadInstitutionTrips, tripsForGroups } from "../fieldTrips";
import { tripOverlaps } from "../../shared/fieldTrips";

type ReadCtx = Pick<QueryCtx, "db">;
type PushTimingKind = Doc<"pushes">["timing"]["kind"];

export type PeriodBlockCache = Map<Id<"reportingPeriods">, Promise<Doc<"scheduleBlocks">[]>>;

export function loadPeriodBlocks(
  ctx: ReadCtx,
  periodId: Id<"reportingPeriods">,
  cache: PeriodBlockCache,
): Promise<Doc<"scheduleBlocks">[]> {
  let pending = cache.get(periodId);
  if (!pending) {
    pending = ctx.db.query("scheduleBlocks")
      .withIndex("by_period", (q) => q.eq("periodId", periodId)).collect();
    cache.set(periodId, pending);
  }
  return pending;
}

type ClassLinkData = {
  institution: Doc<"institutions"> | null;
  timeZone: string;
  groups: Doc<"scholarGroups">[];
  periods: Doc<"reportingPeriods">[];
  closures: SchoolClosure[];
  blocks: PeriodBlockCache;
  classes: Map<string, Promise<Doc<"classes">[]>>;
  /** Live field trips by day key (TRA-601), loaded on first use. */
  trips: Map<string, Promise<Doc<"fieldTrips">[]>>;
};

/** Request-local only: never carry these snapshots across mutations. */
export type ClassLinkReadCache = Map<Id<"institutions"> | undefined, Promise<ClassLinkData>>;

export function loadClassLinkData(
  ctx: ReadCtx,
  institutionId: Id<"institutions"> | undefined,
  cache: ClassLinkReadCache = new Map(),
): Promise<ClassLinkData> {
  let pending = cache.get(institutionId);
  if (!pending) {
    pending = (async (): Promise<ClassLinkData> => {
      const institution = institutionId ? await ctx.db.get(institutionId) : null;
      const groups = await ctx.db.query("scholarGroups")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId)).collect();
      const periods = await ctx.db.query("reportingPeriods")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId)).collect();
      if (institution?.isPrimary) {
        groups.push(...await ctx.db.query("scholarGroups")
          .withIndex("by_institution", (q) => q.eq("institutionId", undefined)).collect());
        periods.push(...await ctx.db.query("reportingPeriods")
          .withIndex("by_institution", (q) => q.eq("institutionId", undefined)).collect());
      }
      return {
        institution, groups, periods,
        timeZone: effectiveInstitutionTimeZone(institution?.timeZone),
        closures: await loadInstitutionClosures(ctx, institutionId),
        blocks: new Map(),
        classes: new Map(),
        trips: new Map(),
      };
    })();
    cache.set(institutionId, pending);
  }
  return pending;
}

/** The term covering `at`: the school's own, else an unstamped legacy one,
 *  and only when exactly one does (the class linker's rule). */
export function termCovering(
  periods: readonly Doc<"reportingPeriods">[],
  institutionId: Id<"institutions">,
  at: number,
): Doc<"reportingPeriods"> | null {
  const covering = periods.filter((p) => p.startsAt <= at && at < p.endsAt);
  const own = covering.filter((p) => p.institutionId === institutionId);
  const terms = own.length ? own : covering;
  return terms.length === 1 ? terms[0] : null;
}

/**
 * A school's subjects (TRA-723): its class names, one entry per name however
 * many groups take it, sorted. A unit's subject is picked from this list.
 * Taken from the term covering `at` when it has live classes (every covering
 * term with classes, when terms overlap); else the most recent past term with
 * live classes; else the next upcoming one. So a school that has classes
 * keeps its list between terms and before a new term's timetable is built.
 * Empty only when no term of the school has a live class, and the unit
 * designer then keeps free text.
 */
export async function schoolSubjectOptions(
  ctx: ReadCtx,
  institutionId: Id<"institutions"> | undefined,
  at: number,
): Promise<string[]> {
  if (!institutionId) return [];
  const periods = (await loadClassLinkData(ctx, institutionId)).periods;
  const classes = await ctx.db
    .query("classes")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  // Live class names per term, for this school's terms only.
  const namesByTerm = new Map<Id<"reportingPeriods">, string[]>();
  for (const cls of classes) {
    if (cls.archivedAt !== undefined) continue;
    const subject = cls.subject.trim();
    if (!subject) continue;
    const names = namesByTerm.get(cls.periodId) ?? [];
    names.push(subject);
    namesByTerm.set(cls.periodId, names);
  }
  const withClasses = periods.filter((p) => namesByTerm.has(p._id));
  if (withClasses.length === 0) return [];

  const covering = withClasses.filter((p) => p.startsAt <= at && at < p.endsAt);
  const ownCovering = covering.filter((p) => p.institutionId === institutionId);
  let chosen = ownCovering.length ? ownCovering : covering;
  if (chosen.length === 0) {
    const past = withClasses.filter((p) => p.endsAt <= at);
    const upcoming = withClasses.filter((p) => p.startsAt > at);
    if (past.length) {
      chosen = [past.reduce((a, b) => (b.endsAt > a.endsAt ? b : a))];
    } else if (upcoming.length) {
      chosen = [upcoming.reduce((a, b) => (b.startsAt < a.startsAt ? b : a))];
    }
  }
  const byKey = new Map<string, string>();
  for (const term of chosen) {
    for (const subject of namesByTerm.get(term._id) ?? []) {
      const key = classSubjectKey(subject);
      if (!byKey.has(key)) byKey.set(key, subject);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * The subjects an EXISTING unit can be filed under: its own school's classes
 * (the unit's institution stamp, else the primary school for a legacy
 * unstamped unit), whoever is looking. Empty for a scholar's own unit, which
 * takes no class. The one rule for the designer's picker and the aide's
 * writes; a NEW unit uses the school it will be stamped with instead.
 */
export async function unitSubjectOptions(
  ctx: ReadCtx,
  unit: Pick<Doc<"units">, "institutionId" | "authorScholarId">,
  at: number,
): Promise<string[]> {
  if (unit.authorScholarId) return [];
  const institutionId =
    unit.institutionId ?? (await primaryInstitutionId(ctx)) ?? undefined;
  return await schoolSubjectOptions(ctx, institutionId, at);
}

/** A placement edit invalidates class snapshots, not the school's lookup data. */
export async function invalidateClassLinkClasses(cache: ClassLinkReadCache): Promise<void> {
  for (const data of cache.values()) (await data).classes.clear();
}

/** Shared with giveWindow: a partial roster belongs to every group containing
 * all its scholars, never a group containing just some of them. */
export function groupsContainingRoster(
  groups: readonly Doc<"scholarGroups">[],
  scholarIds: readonly Id<"users">[],
): Doc<"scholarGroups">[] {
  if (scholarIds.length === 0) return [];
  return groups.filter((group) =>
    scholarIds.every((id) => group.scholarIds.includes(id)),
  );
}

export async function syncClassesForGroupPeriod(
  ctx: MutationCtx,
  periodId: Id<"reportingPeriods">,
  groupId: Id<"scholarGroups">,
  blocksCache: PeriodBlockCache = new Map(),
): Promise<void> {
  const group = await ctx.db.get(groupId);
  const period = await ctx.db.get(periodId);
  const existing = await ctx.db.query("classes")
    .withIndex("by_period_group", (q) => q.eq("periodId", periodId).eq("groupId", groupId))
    .collect();
  if (!group || !period) {
    for (const cls of existing) {
      if (cls.archivedAt === undefined) {
        await ctx.db.patch(cls._id, { archivedAt: Date.now() });
      }
    }
    return;
  }
  const institutionId = group.institutionId ?? (await primaryInstitutionId(ctx));
  if (!institutionId || (period.institutionId && period.institutionId !== institutionId)) {
    console.warn(`[classLink] cannot sync group ${groupId} in period ${periodId}: institution mismatch or missing institution.`);
    return;
  }
  const placements = await ctx.db.query("schedulePlacements")
    .withIndex("by_period_group", (q) => q.eq("periodId", periodId).eq("groupId", groupId))
    .collect();
  // An emptied group only needs archival; don't read a term's entire grid.
  const blocks = placements.some(isRecurringClassMeeting)
    ? await loadPeriodBlocks(ctx, periodId, blocksCache) : [];
  const blocksById = new Map(blocks.map((block) => [block._id, block]));
  const bySubject = new Map<string, Doc<"schedulePlacements">[]>();
  for (const p of placements) {
    if (!isRecurringClassMeeting(p)) continue;
    const block = blocksById.get(p.blockId);
    if (!block || (block.kind ?? "class") !== "class" || !block.weekdays.includes(p.weekday) ||
        (block.groupId && block.groupId !== groupId)) continue;
    const key = classSubjectKey(p.subject);
    const rows = bySubject.get(key) ?? [];
    rows.push(p);
    bySubject.set(key, rows);
  }
  // Only an INSERT needs this; most syncs only patch. A new row inherits `kind`
  // and `includedInReports`
  // first from a live class of the same name in the same school AND term (a
  // sibling group's row), and only when there is none from the newest row of
  // that name in the school, so a term built ahead of time or an unrelated
  // older row cannot decide while a current sibling exists. Exact index,
  // newest first, small bound (rows per name = groups x terms).
  const inheritedMarks = async (key: string): Promise<Pick<Doc<"classes">, "kind" | "includedInReports">> => {
    const rows = await ctx.db.query("classes")
      .withIndex("by_institution_subjectKey", (q) =>
        q.eq("institutionId", institutionId).eq("subjectKey", key))
      .order("desc")
      .take(100);
    const sibling = rows.find((row) =>
      row.periodId === periodId && row.archivedAt === undefined);
    const from = sibling ?? rows[0];
    return { kind: from?.kind, includedInReports: from?.includedInReports };
  };
  for (const [subjectKey, rows] of bySubject) {
    const meetings: Doc<"classes">["meetings"] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isRecurringClassMeeting(row)) continue;
      const key = `${row.weekday}|${row.blockId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      meetings.push({ weekday: row.weekday, blockId: row.blockId });
    }
    meetings.sort((a, b) => a.weekday - b.weekday ||
      blocksById.get(a.blockId)!.order - blocksById.get(b.blockId)!.order ||
      a.blockId.localeCompare(b.blockId));
    const apps = [...new Set(rows.flatMap((p) => p.externalAppId ? [p.externalAppId] : []))];
    const fields = {
      institutionId,
      periodId,
      groupId,
      subjectKey,
      subject: rows[0].subject.trim(),
      teacherId: rows.every((p) => p.teacherId === rows[0].teacherId)
        ? rows[0].teacherId : undefined,
      meetings,
      externalAppId: apps.length === 1 ? apps[0] : undefined,
      archivedAt: undefined,
    };
    const cls = existing.find((row) => row.subjectKey === subjectKey);
    if (!cls) {
      const { kind, includedInReports } = await inheritedMarks(subjectKey);
      await ctx.db.insert("classes", {
        ...fields,
        ...(kind ? { kind } : {}),
        ...(includedInReports === false ? { includedInReports } : {}),
      });
    } else if (
      cls.institutionId !== institutionId ||
      cls.subject !== fields.subject ||
      cls.teacherId !== fields.teacherId ||
      cls.externalAppId !== fields.externalAppId ||
      cls.archivedAt !== undefined ||
      cls.meetings.length !== meetings.length ||
      cls.meetings.some((m, i) =>
        m.weekday !== meetings[i].weekday || m.blockId !== meetings[i].blockId)
    ) {
      await ctx.db.patch(cls._id, fields);
    }
  }
  for (const cls of existing) {
    if (!bySubject.has(cls.subjectKey) && cls.archivedAt === undefined) {
      await ctx.db.patch(cls._id, { archivedAt: Date.now() });
    }
  }
}

/** May receive the pre-edit row, including after its deletion, to retire a
 * meeting that just disappeared. */
export async function upsertClassForPlacement(
  ctx: MutationCtx,
  placement: Doc<"schedulePlacements">,
): Promise<void> {
  await syncClassesForPlacements(ctx, [placement]);
}

export async function syncClassesForPlacements(
  ctx: MutationCtx,
  placements: readonly Doc<"schedulePlacements">[],
): Promise<void> {
  const pairs = new Map<string, Doc<"schedulePlacements">>();
  const blocksCache: PeriodBlockCache = new Map();
  for (const p of placements) {
    if (isRecurringClassMeeting(p)) pairs.set(`${p.periodId}|${p.groupId}`, p);
  }
  for (const p of pairs.values()) {
    await syncClassesForGroupPeriod(ctx, p.periodId, p.groupId, blocksCache);
  }
}

export async function classMeetingForGive(
  ctx: ReadCtx,
  args: {
    institutionId: Id<"institutions">;
    groupIds: readonly Id<"scholarGroups">[];
    at: number;
    timeZone: string;
  },
  cache: ClassLinkReadCache = new Map(),
): Promise<{ classId: Id<"classes">; dayKey: string } | null> {
  const found = await classMeetingLookup(ctx, args, cache);
  return found.kind === "match" ? { classId: found.classId, dayKey: found.dayKey } : null;
}

/**
 * `classMeetingForGive`, saying why it found no meeting:
 *   none     → no class of these groups meets at `at` (outside every block)
 *   declined → it won't guess: a closed day, a field trip over the meeting,
 *              a class meeting twice that day, two classes meeting at once,
 *              or no single term (or school) to read
 * Only `none` leaves room to file work by its subject (TRA-725).
 */
export type ClassMeetingLookup =
  | { kind: "match"; classId: Id<"classes">; dayKey: string }
  | { kind: "none" }
  | { kind: "declined"; reason: "closed" | "trip" | "twice" | "ambiguous" | "term" };

export async function classMeetingLookup(
  ctx: ReadCtx,
  args: {
    institutionId: Id<"institutions">;
    groupIds: readonly Id<"scholarGroups">[];
    at: number;
    timeZone: string;
  },
  cache: ClassLinkReadCache = new Map(),
): Promise<ClassMeetingLookup> {
  const data = await loadClassLinkData(ctx, args.institutionId, cache);
  const { institution } = data;
  if (!institution) return { kind: "declined", reason: "term" };
  const dayKey = dayKeyForTimezone(args.at, args.timeZone);
  if (isClosedDay(dayKey, data.closures)) return { kind: "declined", reason: "closed" };
  const periods = data.periods.filter(
    (period) => period.startsAt <= args.at && args.at < period.endsAt,
  );
  const ownPeriods = periods.filter((period) => period.institutionId === args.institutionId);
  const candidates = ownPeriods.length ? ownPeriods : periods;
  if (candidates.length !== 1) return { kind: "declined", reason: "term" };
  const period = candidates[0];
  const blocks = await loadPeriodBlocks(ctx, period._id, data.blocks);
  let match: { classId: Id<"classes">; dayKey: string } | null = null;
  for (const groupId of new Set(args.groupIds)) {
    if (!data.groups.some((group) => group._id === groupId)) continue;
    const blocksById = new Map(blocks
      .filter((block) => (block.kind ?? "class") === "class" &&
        (!block.groupId || block.groupId === groupId))
      .map((block) => [String(block._id), block]));
    const key = `${period._id}|${groupId}`;
    if (!data.classes.has(key)) {
      data.classes.set(key, ctx.db.query("classes")
        .withIndex("by_period_group", (q) => q.eq("periodId", period._id).eq("groupId", groupId))
        .collect());
    }
    const classes = await data.classes.get(key)!;
    for (const cls of classes) {
      if (cls.archivedAt !== undefined || cls.institutionId !== args.institutionId) continue;
      const meeting = classMeetingAt(cls, blocksById, args.at, args.timeZone);
      if (!meeting) continue;
      // A field trip of this group over the meeting: the class doesn't meet,
      // so there is no meeting to link (TRA-601).
      if (!data.trips.has(dayKey)) {
        data.trips.set(dayKey, loadInstitutionTrips(ctx, args.institutionId, dayKey, dayKey));
      }
      const trips = tripsForGroups(await data.trips.get(dayKey)!, [groupId]);
      if (trips.some((trip) =>
        tripOverlaps(trip, args.timeZone, meeting.startsAt, meeting.endsAt))) {
        return { kind: "declined", reason: "trip" };
      }
      if (match) return { kind: "declined", reason: "ambiguous" };
      if (meetingsOnDay(cls, blocksById, dayKey, args.timeZone).length !== 1) {
        return { kind: "declined", reason: "twice" };
      }
      match = { classId: cls._id, dayKey: meeting.dayKey };
    }
  }
  return match ? { kind: "match", ...match } : { kind: "none" };
}

/**
 * The audience's live classes that teach the unit's subject, in the term
 * covering `at`: the classes this work belongs to whatever happens to be
 * meeting when it is given. Subjects match by meaning, not spelling
 * (`unitSubjectFitsClass`: a "Social Studies" unit fits "Humanities", a
 * "Mathematics" unit fits "Math Workshop"). Empty when the unit has no subject
 * or no class teaches it: then the meeting link stands as before.
 */
export async function subjectClassesForGive(
  ctx: ReadCtx,
  args: {
    institutionId: Id<"institutions">;
    groupIds: readonly Id<"scholarGroups">[];
    at: number;
    unitSubject: string | null | undefined;
  },
  cache: ClassLinkReadCache = new Map(),
): Promise<Id<"classes">[]> {
  const subject = args.unitSubject?.trim();
  if (!subject) return [];
  const data = await loadClassLinkData(ctx, args.institutionId, cache);
  const periods = data.periods.filter(
    (period) => period.startsAt <= args.at && args.at < period.endsAt,
  );
  const ownPeriods = periods.filter((period) => period.institutionId === args.institutionId);
  const candidates = ownPeriods.length ? ownPeriods : periods;
  if (candidates.length !== 1) return [];
  const period = candidates[0];
  const found: Id<"classes">[] = [];
  for (const groupId of new Set(args.groupIds)) {
    if (!data.groups.some((group) => group._id === groupId)) continue;
    const key = `${period._id}|${groupId}`;
    if (!data.classes.has(key)) {
      data.classes.set(key, ctx.db.query("classes")
        .withIndex("by_period_group", (q) => q.eq("periodId", period._id).eq("groupId", groupId))
        .collect());
    }
    for (const cls of await data.classes.get(key)!) {
      if (cls.archivedAt !== undefined || cls.institutionId !== args.institutionId) continue;
      if (unitSubjectFitsClass(subject, cls.subject)) found.push(cls._id);
    }
  }
  return found;
}

/** The subject of the unit a give's work comes from: the assignment's unit,
 *  else the activity's lesson's unit. */
export async function unitSubjectForWork(
  ctx: ReadCtx,
  work: {
    assignmentId?: Id<"assignments"> | null;
    /** A unit to use when there is no assignment yet (the give form). */
    unitId?: Id<"units"> | null;
    activityId?: Id<"activities"> | null;
  },
): Promise<string | null> {
  let unitId: Id<"units"> | undefined;
  if (work.assignmentId) unitId = (await ctx.db.get(work.assignmentId))?.unitId;
  if (!unitId && work.unitId) unitId = work.unitId;
  if (!unitId && work.activityId) {
    const activity = await ctx.db.get(work.activityId);
    const lesson = activity?.lessonId ? await ctx.db.get(activity.lessonId) : null;
    unitId = lesson?.unitId;
  }
  const unit = unitId ? await ctx.db.get(unitId) : null;
  return unit?.subject?.trim() || null;
}

/**
 * A give's class link. Classwork links the class meeting when it is given;
 * homework links a class but no day. When the unit's subject fits the
 * audience's classes, those win: homework links the one that fits whenever it
 * is given, and classwork given during a class that does NOT fit (or when no
 * class meets) links the one class that fits rather than that other class (a
 * Science unit given at 8:30 is Science work, not Math Workshop work just
 * because Math Workshop meets at 8:30). Several fitting classes: nothing.
 */
export async function classFieldsForPush(
  ctx: ReadCtx,
  args: {
    institutionId: Id<"institutions">;
    audience: Doc<"pushes">["audience"];
    at: number | undefined;
    timeZone: string;
    /** Only the kind matters: homework links to a class but not a day. */
    timingKind: PushTimingKind;
    cohortRoster?: readonly Id<"users">[];
    /** The subject of the work's unit (`unitSubjectForWork`). Omitted: the
     *  meeting alone decides, as for an app placement in its own class. */
    unitSubject?: string | null;
  },
  cache: ClassLinkReadCache = new Map(),
): Promise<{ classId: Id<"classes"> | undefined; dayKey: string | undefined }> {
  const groupIds = await audienceGroupIds(ctx, args, cache);
  if (args.at === undefined || groupIds.length === 0) {
    // Explicit undefined removes a stale link when a give is moved out of class.
    return { classId: undefined, dayKey: undefined };
  }
  const subjectClasses = await subjectClassesForGive(ctx, {
    institutionId: args.institutionId, groupIds, at: args.at, unitSubject: args.unitSubject,
  }, cache);
  if (args.timingKind === "homework" && subjectClasses.length === 1) {
    return { classId: subjectClasses[0], dayKey: undefined };
  }
  const lookup = await classMeetingLookup(ctx, { ...args, at: args.at, groupIds }, cache);
  const meeting = lookup.kind === "match" ? { classId: lookup.classId, dayKey: lookup.dayKey } : null;
  const fits = !meeting || !subjectClasses.length || subjectClasses.includes(meeting.classId);
  if (args.timingKind === "homework") {
    return { classId: meeting && fits ? meeting.classId : undefined, dayKey: undefined };
  }
  if (meeting && fits) return meeting;
  // Classwork given while no class meets, or while a class of another
  // subject meets, belongs to the one class that teaches its unit's subject
  // (TRA-725), on the day it happens. Never when the lookup declined to guess
  // (a closed day, a field trip, a class meeting twice, two classes at
  // once): that stays unfiled, as before; so does any day a field trip takes
  // the audience out, whatever the time. The Master Schedule draws it where
  // it happens (lib/gridGives). Not when it starts right at the start of its
  // school day: that is the grid's "All day" row, where a teacher put it on
  // purpose (gridGiveActions.moveGive).
  if (subjectFilingApplies(lookup, subjectClasses) && !isAllDayStart(args.at, args.timeZone) &&
    !await audienceTripOnDay(ctx, args.institutionId, groupIds, args.at, args.timeZone, cache)) {
    return { classId: subjectClasses[0], dayKey: dayKeyForTimezone(args.at, args.timeZone) };
  }
  return { classId: undefined, dayKey: undefined };
}

/** Whether a field trip of any of these groups falls on the school day of
 *  `at` (TRA-725: no subject filing that day). */
export async function audienceTripOnDay(
  ctx: ReadCtx,
  institutionId: Id<"institutions">,
  groupIds: readonly Id<"scholarGroups">[],
  at: number,
  timeZone: string,
  cache: ClassLinkReadCache = new Map(),
): Promise<boolean> {
  const data = await loadClassLinkData(ctx, institutionId, cache);
  const dayKey = dayKeyForTimezone(at, timeZone);
  if (!data.trips.has(dayKey)) {
    data.trips.set(dayKey, loadInstitutionTrips(ctx, institutionId, dayKey, dayKey));
  }
  return tripsForGroups(await data.trips.get(dayKey)!, groupIds).length > 0;
}

/** Whether classwork is filed by its subject rather than its meeting: one
 *  class fits, and either nothing meets or a class that doesn't fit does. */
export function subjectFilingApplies(
  lookup: ClassMeetingLookup,
  subjectClasses: readonly Id<"classes">[],
): boolean {
  if (subjectClasses.length !== 1) return false;
  if (lookup.kind === "none") return true;
  return lookup.kind === "match" && !subjectClasses.includes(lookup.classId);
}

/** The groups a give's class link looks in: its group, or the groups that
 *  hold its whole roster. An all-school give has none. */
export async function audienceGroupIds(
  ctx: ReadCtx,
  args: {
    institutionId: Id<"institutions">;
    audience: Doc<"pushes">["audience"];
    cohortRoster?: readonly Id<"users">[];
  },
  cache: ClassLinkReadCache = new Map(),
): Promise<Id<"scholarGroups">[]> {
  const { audience } = args;
  if (audience.kind === "group") return [audience.groupId];
  if (audience.kind === "institution") return [];
  const roster = audience.kind === "scholars" && audience.scholarIds.length > 0
    ? audience.scholarIds
    : args.cohortRoster ?? (audience.kind === "assignment"
      ? (await ctx.db.get(audience.assignmentId))?.scholarIds ?? [] : []);
  const data = await loadClassLinkData(ctx, args.institutionId, cache);
  return groupsContainingRoster(data.groups, roster).map((group) => group._id);
}

/** A give that starts at the very start of its school-local day: how the
 *  grid's "All day" row plans work (gridGiveActions.moveGive). */
export function isAllDayStart(at: number, timeZone: string): boolean {
  return at === dayStartForDayKey(dayKeyForTimezone(at, timeZone), timeZone);
}

/**
 * The link for homework given for a NAMED class (TRA-581: the aide's "next
 * week's homework" picks the class directly, so it can show up at the start
 * of the school day, when no class meets). The same checks a meeting lookup
 * implies, made explicit so a caller can't name a class that isn't this
 * give's: the class is live, at this school, in the term covering `at`, and
 * one of the groups that hold the whole roster (or the group audience).
 * Homework links a class, never a day.
 */
export async function homeworkClassFields(
  ctx: ReadCtx,
  args: {
    institutionId: Id<"institutions">;
    classId: Id<"classes">;
    audience: Doc<"pushes">["audience"];
    at: number | undefined;
    cohortRoster?: readonly Id<"users">[];
  },
  cache: ClassLinkReadCache = new Map(),
): Promise<{ classId: Id<"classes">; dayKey: undefined }> {
  const refuse = () => {
    throw new GiveQuestionError(
      "That class isn't one of this group's classes this term. Which class is this homework for?",
    );
  };
  const cls = await ctx.db.get(args.classId);
  if (!cls || cls.archivedAt !== undefined || cls.institutionId !== args.institutionId) {
    return refuse();
  }
  const data = await loadClassLinkData(ctx, args.institutionId, cache);
  const at = args.at ?? Date.now();
  if (termCovering(data.periods, args.institutionId, at)?._id !== cls.periodId) {
    return refuse();
  }
  const { audience } = args;
  let groupIds: Id<"scholarGroups">[] = [];
  if (audience.kind === "group") {
    groupIds = [audience.groupId];
  } else if (audience.kind === "scholars" || audience.kind === "assignment") {
    const roster = audience.kind === "scholars" && audience.scholarIds.length > 0
      ? audience.scholarIds
      : args.cohortRoster ?? (audience.kind === "assignment"
        ? (await ctx.db.get(audience.assignmentId))?.scholarIds ?? [] : []);
    groupIds = groupsContainingRoster(data.groups, roster).map((group) => group._id);
  }
  if (!groupIds.includes(cls.groupId)) return refuse();
  return { classId: cls._id, dayKey: undefined };
}

type PushLinkInputs = Pick<Doc<"pushes">, "startsAt" | "setAt" | "audience">;

/** Activation stamps setAt but does not move a planned give out of its class. */
export function classLinkInputsChanged(previous: PushLinkInputs, next: PushLinkInputs): boolean {
  const startChanged = previous.startsAt !== next.startsAt ||
    (previous.setAt !== next.setAt &&
      !(previous.setAt === undefined && previous.startsAt !== undefined));
  const a = previous.audience;
  const b = next.audience;
  const sameAudience = a.kind === b.kind && (
    (a.kind === "institution" && b.kind === "institution") ||
    (a.kind === "group" && b.kind === "group" && a.groupId === b.groupId) ||
    (a.kind === "assignment" && b.kind === "assignment" && a.assignmentId === b.assignmentId) ||
    (a.kind === "scholars" && b.kind === "scholars" &&
      a.scholarIds.length === b.scholarIds.length &&
      a.scholarIds.every((id) => b.scholarIds.includes(id)))
  );
  return startChanged || !sameAudience;
}

/**
 * The stored `endsAt` + `afterEnd` for a give of `kind` whose requested end is
 * `end`: a focus's explicit end, a homework's due date (undefined = undated),
 * ignored for `untilCleared` (its end is the close of its school day).
 *
 * Writers pass the REQUESTED number here; storage keeps `timing` as the kind
 * alone (TRA-580 step 5), so nothing is ever read back from a nested number.
 */
export function endFieldsForPush(
  kind: PushTimingKind,
  end: number | undefined,
  setAt: number | undefined,
  startsAt: number | undefined,
  timeZone: string,
): GiveEnd {
  const at = setAt ?? startsAt;
  // An undated plan has no school day yet. Activation supplies it.
  if (kind === "untilCleared" && at === undefined) {
    return { endsAt: undefined, afterEnd: "fade" };
  }
  let requested: RequestedWindow;
  // An `openUntil` row (TRA-726) ends exactly as a timed focus does.
  if (kind === "focus" || kind === "openUntil") {
    if (end === undefined) throw new Error("A timed focus needs an end time.");
    requested = { kind: "focus", endsAt: end };
  } else {
    requested = kind === "homework" ? { kind, dueAt: end } : { kind };
  }
  return endFromRequestedWindow(requested, at ?? 0, timeZone);
}
