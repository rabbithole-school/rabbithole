// The CLASS resolver — the one new primitive behind the class-scoped Class
// Digest and the group's class picker (review/class-view-and-shelf-proposal.html
// §4/§5). A "class" is the implicit (groupId, subject) entity the schedule
// already draws; `resolveClass` turns it into the two sets the existing digest
// generator already eats — the group's scholars + the assignments linked from
// that class's placements this period — WITHOUT a new table or a hidden
// recurrence rule (it reads the same schedulePlacements the class drawer +
// cascade read). The pure (groupId, subject) match + dedupe lives in
// lib/classResolver.ts so it's unit-testable; this file owns the DB reads.

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { teacherQuery } from "./lib/customFunctions";
import { coreGrid } from "./masterSchedule";
import { currentReportingPeriod } from "./reportingPeriods";
import { requireGroupScholarAccess } from "./lib/access";
import { deriveClassMeetingPattern } from "../shared/meetingSlots";
import {
  classSubjectKey,
  formatMeetingSummary,
  linkedAssignmentIdsForClass,
} from "./lib/classResolver";

export type ClassTarget = {
  groupId: Id<"scholarGroups">;
  subject: string;
  periodId: Id<"reportingPeriods">;
};

export type ResolvedClass = {
  scholarIds: Id<"users">[];
  /** The class's linked assignments this period, most-recently-created first. */
  assignmentIds: Id<"assignments">[];
  /** The class subject in its ORIGINAL display casing (from a matching
   *  placement row) — the target subject is normalized to the class key, so
   *  this is what prose/prompts should show. Falls back to the target subject. */
  displaySubject: string;
};

export type ResolvedAssignmentClass = {
  groupId: Id<"scholarGroups">;
  subject: string;
};

export async function resolveAssignmentClass(
  ctx: Pick<QueryCtx, "db">,
  assignmentId: Id<"assignments">,
  activityId?: Id<"activities">,
): Promise<ResolvedAssignmentClass | null> {
  const placements = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
    .collect();
  const placement =
    placements.find((row) => row.activityId === activityId) ?? placements[0];
  return placement
    ? {
        groupId: placement.groupId,
        subject: classSubjectKey(placement.subject),
      }
    : null;
}

/**
 * Resolve a (groupId, subject, periodId) class into its scholars + work set.
 *   - scholarIds: the group's roster (scholarGroups.scholarIds), verbatim.
 *   - assignmentIds: the DISTINCT assignments linked from that class's
 *     schedulePlacements this period (both recurring shells + concrete
 *     week-stamped rows), recency-windowed = ordered most-recently-created
 *     first (§ open decision #1). A subject match is trim/case-insensitive.
 *   - displaySubject: the class's subject in its original casing (from a
 *     matching placement), for prose/prompts (the key is normalized).
 * A missing group or period yields empty sets (the caller renders an empty
 * state); a linked assignment that no longer exists is dropped.
 */
export async function resolveClass(
  ctx: QueryCtx,
  target: ClassTarget,
): Promise<ResolvedClass> {
  const group = await ctx.db.get(target.groupId);
  const scholarIds = group?.scholarIds ?? [];

  const placements = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_period_group", (q) =>
      q.eq("periodId", target.periodId).eq("groupId", target.groupId),
    )
    .collect();

  const wantKey = classSubjectKey(target.subject);
  // Display-cased subject: the first placement of this class, trimmed. Keeps
  // the model prompt reading "Humanities" even though we key on "humanities".
  const displaySubject =
    placements.find((p) => classSubjectKey(p.subject) === wantKey)?.subject.trim() ??
    target.subject;

  const linkedIds = linkedAssignmentIdsForClass({
    placements: placements.map((p) => ({
      groupId: String(p.groupId),
      subject: p.subject,
      assignmentId: p.assignmentId ? String(p.assignmentId) : null,
    })),
    groupId: String(target.groupId),
    subject: target.subject,
  });

  // Recency window (keep it simple): order the whole set most-recently-created
  // first. Drop any assignment that no longer exists.
  const assignments = (
    await Promise.all(
      linkedIds.map((id) => ctx.db.get(id as Id<"assignments">)),
    )
  ).filter((a): a is Doc<"assignments"> => a !== null);
  assignments.sort((a, b) => b._creationTime - a._creationTime);

  return {
    scholarIds,
    assignmentIds: assignments.map((a) => a._id),
    displaySubject,
  };
}

/** Internal wrapper so tests (+ the aide, later) can call the resolver through
 *  the registered-function boundary. */
export const resolveClassInternal = internalQuery({
  args: {
    groupId: v.id("scholarGroups"),
    subject: v.string(),
    periodId: v.id("reportingPeriods"),
  },
  handler: (ctx, args) => resolveClass(ctx, args),
});

export type GroupClass = {
  /** Display subject (original case, trimmed) — what the teacher named it. */
  subject: string;
  /** Trim/lowercase class key — pass to the digest queries. */
  subjectKey: string;
  /** The class's meeting weekdays (1–5), sorted, deduped. */
  weekdays: number[];
  /** "Mon · Wed · Fri" — the picker chip's meeting-pattern summary. */
  meetingSummary: string;
  /** The block start time when every meeting shares one (else null). */
  startLocal: string | null;
  teacherName: string | null;
};

/**
 * The distinct classes of a group this period — the picker feed for the class
 * card (§5b). Derived from the group's RECURRING schedule rows (the class
 * identity), reusing coreGrid's already-enriched placements + the shared
 * meeting-pattern derivation rather than re-deriving structure. `periodId` is
 * returned so the card can thread it straight into the digest queries.
 */
export const listGroupClasses = teacherQuery({
  args: {
    groupId: v.id("scholarGroups"),
    // Omitted → the current (writing/open) reporting period for the caller's
    // institution lens, mirroring how the schedule surfaces resolve "this term".
    periodId: v.optional(v.id("reportingPeriods")),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Institution boundary: a foreign teacher must not enumerate another
    // context's classes via a bare groupId (Forbidden on a wholly-foreign
    // group; an empty group is harmless).
    await requireGroupScholarAccess(ctx, ctx.user, args.groupId);
    const period = args.periodId
      ? await ctx.db.get(args.periodId)
      : await currentReportingPeriod(ctx, ctx.user, args.scope);
    if (!period) return { periodId: null, classes: [] as GroupClass[] };

    const grid = await coreGrid(ctx, period._id);
    const blockOrder = new Map(grid.blocks.map((b) => [String(b._id), b.order]));
    const startByBlockId = new Map(
      grid.blocks.map((b) => [String(b._id), b.startLocal]),
    );

    // Every recurring class meeting of THIS group (the class identity): a
    // placed (weekday + block), non-homework, non-week-stamped row.
    const recurring = grid.placements.filter(
      (p) =>
        String(p.groupId) === String(args.groupId) &&
        p.weekStartMs == null &&
        p.weekday != null &&
        p.blockId != null &&
        p.mode !== "homework",
    );

    // Distinct classes by subject key, keeping a display subject + a teacher.
    const order: string[] = [];
    const byKey = new Map<
      string,
      { subject: string; teacherName: string | null }
    >();
    for (const p of recurring) {
      const key = classSubjectKey(p.subject);
      if (!byKey.has(key)) {
        order.push(key);
        byKey.set(key, {
          subject: p.subject.trim(),
          teacherName: p.teacherName ?? null,
        });
      } else if (p.teacherName && !byKey.get(key)!.teacherName) {
        byKey.get(key)!.teacherName = p.teacherName;
      }
    }

    // Shared, once, for every class's pattern derivation.
    const patternInput = grid.placements.map((p) => ({
      weekStartMs: p.weekStartMs ?? null,
      weekday: p.weekday ?? null,
      blockId: p.blockId ? String(p.blockId) : null,
      groupId: String(p.groupId),
      subject: p.subject,
      mode: p.mode ?? null,
    }));

    const classes: GroupClass[] = order.map((key) => {
      const entry = byKey.get(key)!;
      const pattern = deriveClassMeetingPattern({
        placements: patternInput,
        groupId: String(args.groupId),
        subject: entry.subject,
        blockOrder,
      });
      const weekdays = [...new Set(pattern.map((m) => m.weekday))].sort(
        (a, b) => a - b,
      );
      const startTimes = new Set(
        pattern
          .map((m) => startByBlockId.get(m.blockId))
          .filter((t): t is string => Boolean(t)),
      );
      return {
        subject: entry.subject,
        subjectKey: key,
        weekdays,
        meetingSummary: formatMeetingSummary(weekdays),
        startLocal: startTimes.size === 1 ? [...startTimes][0] : null,
        teacherName: entry.teacherName,
      };
    });

    return { periodId: period._id, classes };
  },
});
