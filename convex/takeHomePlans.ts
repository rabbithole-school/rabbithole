import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery, teacherQuery } from "./lib/customFunctions";
import {
  accessibleGroupScholars,
  canReadScholarAsTeacher,
  filterToAccessibleScholars,
  requireActiveScholarAccess,
} from "./lib/access";
import { ROLES, isPlatformAdminRole, isTeacherRole } from "./lib/roles";
import { timeZoneForInstitution } from "./lib/institutionTime";
import { nextOpenSchoolDayKey, prevOpenSchoolDayKey } from "./lib/schoolDays";
import {
  homeworkForScholar,
  homeworkForScholarFromAssignments,
  homeworkAssignmentsByScholar,
} from "./assignments";
import { questStateForPair, questsForScholar } from "./lib/questLifecycle";
import { reconcileActivityCompletion } from "./lib/activityCompletionCore";
import { suggestedQuestsForScholar } from "./lib/scholarReads";
import { createSessionFromSeedCore } from "./sessions";
import {
  dayKeysShareCalendarWeek,
  dayKeyForTimezone,
} from "../shared/institutionDay";
import { filterHomeworkForNow } from "../shared/scholarHomeNow";

const suggestionValidator = v.union(
  v.object({
    kind: v.literal("activity"),
    sessionId: v.id("sessions"),
  }),
  v.object({
    kind: v.literal("quest"),
    unitId: v.id("units"),
  }),
);

type ScholarContext = {
  scholar: Doc<"users">;
  institutionId: Id<"institutions">;
  timeZone: string;
  dayKey: string;
  nowMs: number;
  isPrimary: boolean;
};

type SelectedActivity = {
  kind: "activity";
  id: Id<"takeHomePlanItems">;
  activityId: Id<"activities">;
  sessionId: Id<"sessions"> | null;
  label: string;
  meta: string | null;
  checked: boolean;
  actions:
    | readonly ["remove", "markDone"]
    | readonly ["remove", "undoMarkDone"]
    | readonly ["remove"];
};

type SelectedQuest = {
  kind: "quest";
  id: Id<"takeHomePlanItems">;
  unitId: Id<"units">;
  sessionId: Id<"sessions"> | null;
  label: string;
  meta: string | null;
  checked: boolean;
  actions: readonly ["remove", "closeQuest"] | readonly ["remove", "undoCloseQuest"];
};

type SelectedSession = {
  kind: "session";
  id: Id<"takeHomePlanItems">;
  sessionId: Id<"sessions">;
  label: string;
  meta: null;
  checked: false;
  actions: readonly ["remove"];
};

type SelectedNote = {
  kind: "note";
  id: Id<"takeHomePlanItems">;
  text: string;
  checked: boolean;
  actions: readonly ["edit", "remove", "setChecked"];
};

type SelectedItem =
  | SelectedActivity
  | SelectedQuest
  | SelectedSession
  | SelectedNote;

type Suggestion =
  | {
      kind: "activity";
      id: string;
      sessionId: Id<"sessions">;
      activityId: Id<"activities">;
      label: string;
      meta: string | null;
      actions: readonly ["addToPlan", "markDone"];
    }
  | {
      kind: "quest";
      id: string;
      unitId: Id<"units">;
      sessionId: Id<"sessions"> | null;
      label: string;
      meta: string | null;
      actions: readonly ["addToPlan", "markDone"];
    };

type ResolvedToday =
  | {
      kind: "activity";
      itemId: Id<"takeHomePlanItems">;
      label: string;
      actions: readonly ["undo"];
    }
  | {
      kind: "quest";
      itemId: Id<"takeHomePlanItems">;
      label: string;
      actions: readonly ["undo"];
    };

function sessionTouchTime(session: Doc<"sessions">) {
  return Math.max(
    session._creationTime,
    session.lastMessageAt ?? 0,
    session.reopenedAt ?? 0,
  );
}

async function scholarContext(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  nowMs = Date.now(),
): Promise<ScholarContext | null> {
  if (user.role !== ROLES.SCHOLAR || !user.institutionId) return null;
  await requireActiveScholarAccess(ctx, user, user._id);
  const institution = await ctx.db.get(user.institutionId);
  if (!institution || institution.disabledAt !== undefined) {
    throw new Error("Your school's Rabbithole access is paused.");
  }
  const timeZone = await timeZoneForInstitution(ctx, institution._id);
  return {
    scholar: user,
    institutionId: institution._id,
    timeZone,
    dayKey: dayKeyForTimezone(nowMs, timeZone),
    nowMs,
    isPrimary: institution.isPrimary === true,
  };
}

async function currentItem(
  ctx: MutationCtx,
  context: ScholarContext,
  itemId: Id<"takeHomePlanItems">,
) {
  const item = await ctx.db.get(itemId);
  if (
    !item ||
    item.scholarId !== context.scholar._id ||
    item.institutionId !== context.institutionId
  ) {
    throw new Error("Plan item not found");
  }
  if (item.dayKey !== context.dayKey) {
    throw new Error("This plan item belongs to a previous day");
  }
  return item;
}

async function selectedItems(
  ctx: QueryCtx,
  context: ScholarContext,
): Promise<SelectedItem[]> {
  const rows = await ctx.db
    .query("takeHomePlanItems")
    .withIndex("by_scholar_day", (q) =>
      q.eq("scholarId", context.scholar._id).eq("dayKey", context.dayKey),
    )
    .collect();
  const visible = rows
    .filter(
      (row) =>
        row.institutionId === context.institutionId &&
        !row.removedAt &&
        !row.resolution,
    )
    .sort((a, b) => a._creationTime - b._creationTime);
  const items: SelectedItem[] = [];

  for (const row of visible) {
    if (row.kind === "note") {
      if (!row.text) continue;
      items.push({
        kind: "note",
        id: row._id,
        text: row.text,
        checked: row.checkedAt !== undefined,
        actions: ["edit", "remove", "setChecked"],
      });
      continue;
    }
    if (row.kind === "activity") {
      if (!row.activityId) continue;
      const [activity, session] = await Promise.all([
        ctx.db.get(row.activityId),
        row.sessionId ? ctx.db.get(row.sessionId) : null,
      ]);
      items.push({
        kind: "activity",
        id: row._id,
        activityId: row.activityId,
        sessionId: row.sessionId ?? null,
        label: activity?.title ?? "(removed activity)",
        meta: session?.title ?? null,
        checked: row.checkedAt !== undefined,
        actions: row.markedCompletionId
          ? ["remove", "undoMarkDone"]
          : row.checkedAt
            ? ["remove"]
            : ["remove", "markDone"],
      });
      continue;
    }
    if (row.kind === "session") {
      if (!row.sessionId) continue;
      const session = await ctx.db.get(row.sessionId);
      if (!session || session.userId !== context.scholar._id) continue;
      items.push({
        kind: "session",
        id: row._id,
        sessionId: row.sessionId,
        label: session.title,
        meta: null,
        checked: false,
        actions: ["remove"],
      });
      continue;
    }
    if (!row.unitId) continue;
    const [unit, session] = await Promise.all([
      ctx.db.get(row.unitId),
      row.sessionId ? ctx.db.get(row.sessionId) : null,
    ]);
    items.push({
      kind: "quest",
      id: row._id,
      unitId: row.unitId,
      sessionId: row.sessionId ?? null,
      label: unit?.title ?? "(removed quest)",
      meta: session?.title ?? null,
      checked: row.checkedAt !== undefined,
      actions: row.questOutcome === "scholar_closed"
          ? ["remove", "undoCloseQuest"]
          : ["remove", "closeQuest"],
    });
  }
  return items;
}

/** The enriched-homework list for one scholar (the shared, once-computed input
 *  threaded through the composition so a group read never re-scans per call). */
type ScholarHomework = Awaited<ReturnType<typeof homeworkForScholar>>;

function assignedItems(
  context: ScholarContext,
  homework: ScholarHomework,
  nextOpenDayKey: string | null,
) {
  const forNow = filterHomeworkForNow(homework, {
    nowMs: context.nowMs,
    timeZone: context.timeZone,
    nextOpenSchoolDayKey: nextOpenDayKey,
  });
  return forNow.map((item) => {
    return {
      kind: "assigned" as const,
      id: `assigned:${item.assignmentId}:${item.activityId}`,
      assignmentId: item.assignmentId,
      activityId: item.activityId,
      label: item.activityTitle ?? "(removed activity)",
      // `meta` is ATTRIBUTION ONLY — the unit this activity belongs to. It used
      // to be `due?.phrase ?? item.unitTitle`, which made the deadline and the
      // attribution compete for one slot: an overdue row silently LOST its unit
      // and teacher, exactly when a scholar most needs to know whose work it is.
      // The deadline is now derived client-side from `dueAt` (already on this
      // payload) and rendered in its own status slot. Any caller that needs the
      // due phrase calls `dueStatus(item.dueAt, …)` — never string-matches this.
      meta: item.unitTitle ?? null,
      teacherName: item.teacherName ?? null,
      unitEmoji: item.unitEmoji ?? null,
      dueAt: item.dueAt,
      activityKind: item.activityKind,
      practiceSkillKey: item.practiceSkillKey,
      webUrl: item.webUrl,
      webAllowedHosts: item.webAllowedHosts,
      gameId: item.gameId,
      actions: ["open"] as const,
    };
  });
}

async function suggestions(
  ctx: QueryCtx,
  context: ScholarContext,
  selected: readonly SelectedItem[],
  homework: ScholarHomework,
): Promise<Suggestion[]> {
  const assignedActivityIds = new Set(
    homework.map((item) => String(item.activityId)),
  );
  const selectedActivityIds = new Set(
    selected.flatMap((item) => (item.kind === "activity" ? [String(item.activityId)] : [])),
  );
  const selectedUnitIds = new Set(
    selected.flatMap((item) => (item.kind === "quest" ? [String(item.unitId)] : [])),
  );
  const priorRows = await ctx.db
    .query("takeHomePlanItems")
    .withIndex("by_scholar_day", (q) =>
      q.eq("scholarId", context.scholar._id).eq("dayKey", context.dayKey),
    )
    .collect();
  const resolvedActivityIds = new Set(
    priorRows.flatMap((item) =>
      item.resolution === "activity_completed" && item.activityId
        ? [String(item.activityId)]
        : [],
    ),
  );
  const resolvedUnitIds = new Set(
    priorRows.flatMap((item) =>
      item.resolution === "quest_closed" && item.unitId
        ? [String(item.unitId)]
        : [],
    ),
  );
  const activitySuggestions: Suggestion[] = [];
  const questSuggestions: Suggestion[] = [];

  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", context.scholar._id))
    .collect();
  const seenActivityIds = new Set<string>();
  for (const session of [...sessions].sort(
    (a, b) => sessionTouchTime(b) - sessionTouchTime(a),
  )) {
    if (
      session.isArchived ||
      session.isTestDrive ||
      session.isOffline ||
      session.activityCompletedAt ||
      !session.activityId ||
      dayKeyForTimezone(
        sessionTouchTime(session),
        context.timeZone,
      ) !== context.dayKey
    ) {
      continue;
    }
    const activityKey = String(session.activityId);
    if (
      seenActivityIds.has(activityKey) ||
      assignedActivityIds.has(activityKey) ||
      selectedActivityIds.has(activityKey) ||
      resolvedActivityIds.has(activityKey) ||
      (session.unitId && selectedUnitIds.has(String(session.unitId)))
    ) {
      continue;
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity) continue;
    seenActivityIds.add(activityKey);
    activitySuggestions.push({
      kind: "activity",
      id: `activity:${session._id}`,
      sessionId: session._id,
      activityId: session.activityId,
      label: activity.title,
      meta: session.title,
      actions: ["addToPlan", "markDone"],
    });
  }

  for (const quest of await questsForScholar(ctx, context.scholar._id)) {
    if (
      quest.state !== "active" ||
      quest.completedCount >= quest.onlineActivityCount ||
      selectedUnitIds.has(String(quest.unitId)) ||
      resolvedUnitIds.has(String(quest.unitId))
    ) {
      continue;
    }
    const session =
      [...sessions]
        .filter(
          (candidate) =>
            candidate.unitId === quest.unitId &&
            !candidate.isArchived &&
            !candidate.isTestDrive &&
            !candidate.isOffline &&
            !candidate.assignmentId,
        )
        .sort((a, b) => sessionTouchTime(b) - sessionTouchTime(a))[0] ?? null;
    questSuggestions.push({
      kind: "quest",
      id: `quest:${quest.unitId}`,
      unitId: quest.unitId,
      sessionId: session?._id ?? null,
      label: quest.title,
      meta: quest.emoji,
      actions: ["addToPlan", "markDone"],
    });
  }

  return [...questSuggestions.slice(0, 2), ...activitySuggestions].slice(0, 3);
}

async function resolvedToday(
  ctx: QueryCtx,
  context: ScholarContext,
): Promise<ResolvedToday[]> {
  const rows = await ctx.db
    .query("takeHomePlanItems")
    .withIndex("by_scholar_day", (q) =>
      q.eq("scholarId", context.scholar._id).eq("dayKey", context.dayKey),
    )
    .collect();
  const resolved: ResolvedToday[] = [];
  for (const row of rows
    .filter(
      (row) =>
        row.institutionId === context.institutionId &&
        !row.removedAt &&
        row.resolution,
    )
    .sort((a, b) => (b.resolvedAt ?? b._creationTime) - (a.resolvedAt ?? a._creationTime))) {
    if (row.resolution === "activity_completed" && row.activityId) {
      const activity = await ctx.db.get(row.activityId);
      resolved.push({
        kind: "activity",
        itemId: row._id,
        label: activity?.title ?? "(removed activity)",
        actions: ["undo"],
      });
    } else if (row.resolution === "quest_closed" && row.unitId) {
      const unit = await ctx.db.get(row.unitId);
      resolved.push({
        kind: "quest",
        itemId: row._id,
        label: unit?.title ?? "(removed quest)",
        actions: ["undo"],
      });
    }
  }
  return resolved;
}

/** The shape a non-scholar / no-context caller gets — an empty tonight list. */
function emptyPlan() {
  return {
    timeZone: null,
    dayKey: null,
    isPrimary: false,
    printsTonight: false,
    takeHomePeriod: "tonight" as const,
    assigned: [],
    selected: [],
    suggestions: [],
    resolvedToday: [],
    counts: { assigned: 0, selected: 0, suggestions: 0, checked: 0 },
  };
}

/**
 * THE canonical tonight-list composition, shared verbatim by the scholar's own
 * card (`forSelf`) and the teacher reads (`forScholarAsTeacher` /
 * `forGroupAsTeacher`). The scholar and the teacher must never disagree about a
 * scholar's list, so there is exactly one computation — never a re-derivation.
 * The caller owns the auth gate; this takes an already-resolved context.
 */
async function composePlan(
  ctx: QueryCtx,
  context: ScholarContext,
  homework: ScholarHomework,
  // The teacher card grid renders ONLY `assigned` + `selected`, so its whole-
  // view read passes `lean` to skip the expensive `suggestions` pass (which
  // scans every session for the scholar and re-walks quest history) and the
  // `resolvedToday` read. ONE composition seam — never a forked lean copy (T1);
  // the skipped fields are simply returned empty, and buildTonightPlanRows drops
  // them anyway, so a lean row is byte-identical to a full row in the shape it
  // actually returns.
  opts: { lean?: boolean } = {},
) {
  const [selected, nextOpenDayKey] = await Promise.all([
    selectedItems(ctx, context),
    nextOpenSchoolDayKey(
      ctx,
      context.institutionId,
      context.dayKey,
      context.timeZone,
    ),
  ]);
  const [suggested, resolved] = opts.lean
    ? [[] as Awaited<ReturnType<typeof suggestions>>, [] as Awaited<ReturnType<typeof resolvedToday>>]
    : await Promise.all([
        suggestions(ctx, context, selected, homework),
        resolvedToday(ctx, context),
      ]);
  const assigned = assignedItems(context, homework, nextOpenDayKey);
  return {
    timeZone: context.timeZone,
    dayKey: context.dayKey,
    isPrimary: context.isPrimary,
    printsTonight: context.isPrimary,
    takeHomePeriod:
      nextOpenDayKey &&
      !dayKeysShareCalendarWeek(context.dayKey, nextOpenDayKey)
        ? ("weekend" as const)
        : ("tonight" as const),
    assigned,
    selected,
    suggestions: suggested,
    resolvedToday: resolved,
    counts: {
      assigned: assigned.length,
      selected: selected.length,
      suggestions: suggested.length,
      checked: selected.filter((item) => item.checked).length,
    },
  };
}

/**
 * The named outcome of homework that was due by this morning — join the
 * homework whose `dueAt` fell on the PRIOR open school day to the canonical
 * `activityCompletions` record (via `homeworkForScholar`'s `completedByMe`).
 * The claim is narrow on purpose (T7): this is "homework that was due
 * yesterday," not a reconstruction of last night's exact tonight card. Takes
 * the already-computed `homework` so a group read never re-scans per scholar.
 */
async function lastNightOutcome(
  ctx: QueryCtx,
  context: ScholarContext,
  homework: ScholarHomework,
) {
  const prevDayKey = await prevOpenSchoolDayKey(
    ctx,
    context.institutionId,
    context.dayKey,
    context.timeZone,
  );
  if (!prevDayKey) return [];
  return homework
    .filter(
      (item) =>
        item.dueAt != null &&
        dayKeyForTimezone(item.dueAt, context.timeZone) === prevDayKey,
    )
    .map((item) => ({
      assignmentId: item.assignmentId,
      activityId: item.activityId,
      label: item.activityTitle ?? "(removed activity)",
      done: item.completedByMe,
    }));
}

export const forSelf = authedQuery({
  // The minute-rounded client timestamp is an intentional reactive dependency:
  // Convex re-runs the query across an institution-local midnight without the
  // client having to invent or know a day key.
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user, args.now);
    if (!context) return emptyPlan();
    const homework = await homeworkForScholar(
      ctx,
      context.scholar._id,
      context.nowMs,
    );
    return await composePlan(ctx, context, homework);
  },
});

/**
 * The teacher-gated read of ONE scholar's tonight list — the SAME composition
 * `forSelf` returns, behind `canReadScholarAsTeacher` instead of self-auth, so
 * the scholar card and the teacher board can never disagree.
 */
export const forScholarAsTeacher = teacherQuery({
  args: { scholarId: v.id("users"), now: v.number() },
  handler: async (ctx, args) => {
    if (!(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))) {
      throw new Error("Forbidden: scholar is not in your current context");
    }
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) return emptyPlan();
    const context = await scholarContext(ctx, scholar, args.now);
    if (!context) return emptyPlan();
    const homework = await homeworkForScholar(
      ctx,
      context.scholar._id,
      context.nowMs,
    );
    return await composePlan(ctx, context, homework);
  },
});

/**
 * Whether the caller may read `group` as a group RESOURCE — its institution
 * must be in the caller's teacher-accessible scope. `accessibleGroupScholars`
 * only intersects the ROSTER (deliberately lenient for reads: an empty group is
 * harmless, partial overlap is fine), which never authorizes the group's own
 * institution — so a stamped foreign group (empty, or containing one scholar
 * the caller happens to reach) would otherwise leak. Mirrors the teacher-
 * membership loop in `canReadScholarAsTeacher`. A legacy UNSTAMPED group
 * (institutionId unset) falls back to the roster rule the caller already
 * applied.
 */
async function groupInstitutionAccessible(
  ctx: QueryCtx,
  user: Doc<"users">,
  group: Doc<"scholarGroups">,
): Promise<boolean> {
  if (isPlatformAdminRole(user.role)) return true;
  if (!group.institutionId) return true;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  return memberships.some(
    (m) => isTeacherRole(m.role) && m.institutionId === group.institutionId,
  );
}

/**
 * Build the per-scholar tonight rows for a set of already-authorized scholars —
 * the shared core of the group prep board and the whole-view prep grid, so the
 * two can never derive a scholar's list two ways (T1). Collects assignments ONCE
 * for the whole set and partitions per scholar (never a full assignment-table
 * scan per scholar), then composes each row with the SAME `composePlan` the
 * scholar's own card uses. The caller owns the access gate; this takes an
 * already-filtered scholar list.
 */
async function buildTonightPlanRows(
  ctx: QueryCtx,
  scholars: Doc<"users">[],
  now: number,
) {
  const sorted = [...scholars].sort((a, b) =>
    (a.name ?? a.username ?? "").localeCompare(b.name ?? b.username ?? ""),
  );

  // Collect assignments ONCE and partition per scholar, so each scholar's
  // homework is enriched exactly once. Assignments target scholars via an
  // un-indexable `scholarIds` array (and an optional `scholarGroupId`), so a
  // full collect is the repo-wide pattern for scholar-facing homework reads —
  // `forSelf`/`assignmentsForScholar` both do it; there is no scholar or
  // institution index to bound it. The two real read-cost defenses are instead:
  // the LEAN composePlan below (which skips the per-scholar session/quest scans
  // that dominated cost), and the CLIENT paginating the grid into fixed-size
  // pages (so no single subscription's transaction grows unbounded).
  const allAssignments = await ctx.db.query("assignments").collect();
  const byScholar = homeworkAssignmentsByScholar(
    allAssignments,
    sorted.map((s) => s._id),
  );

  return Promise.all(
    sorted.map(async (scholar) => {
      const context = await scholarContext(ctx, scholar, now);
      if (!context) {
        const plan = emptyPlan();
        return {
          scholarId: scholar._id,
          name: scholar.name ?? scholar.username ?? "Scholar",
          username: scholar.username ?? null,
          image: scholar.image ?? null,
          // A staffer's visible roster can legitimately span institutions, so
          // the day-boundary clock is a PER-ROW fact, never one for the view.
          timeZone: plan.timeZone,
          emptyList: true,
          assigned: plan.assigned,
          selected: plan.selected,
          lastNight: [] as Awaited<ReturnType<typeof lastNightOutcome>>,
        };
      }
      const homework = await homeworkForScholarFromAssignments(
        ctx,
        scholar._id,
        byScholar.get(String(scholar._id)) ?? [],
        context.nowMs,
      );
      const [plan, lastNight] = await Promise.all([
        // Lean: the card renders only assigned + selected, so skip the
        // suggestions/resolvedToday work. buildTonightPlanRows already drops
        // those fields, so the row is identical — one composition seam (T1).
        composePlan(ctx, context, homework, { lean: true }),
        lastNightOutcome(ctx, context, homework),
      ]);
      return {
        scholarId: scholar._id,
        name: scholar.name ?? scholar.username ?? "Scholar",
        username: scholar.username ?? null,
        image: scholar.image ?? null,
        timeZone: plan.timeZone,
        // A neutral property of the same read: nothing on the list yet. Not a
        // red alert — an empty list can simply mean nothing is due (T6/T7).
        emptyList: plan.assigned.length === 0 && plan.selected.length === 0,
        assigned: plan.assigned,
        selected: plan.selected,
        lastNight,
      };
    }),
  );
}

/**
 * The prep board's read model: the tonight list for every scholar in a group,
 * access-gated per handler via `accessibleGroupScholars` (a role check alone is
 * a cross-tenant leak). Each row carries the SAME composed plan `forSelf`
 * returns, plus a neutral empty-list flag and the named last-night outcome.
 */
export const forGroupAsTeacher = teacherQuery({
  args: { groupId: v.id("scholarGroups"), now: v.number() },
  handler: async (ctx, args) => {
    const { group, scholarIds, forbidden } = await accessibleGroupScholars(
      ctx,
      ctx.user,
      args.groupId,
    );
    if (forbidden) {
      throw new Error("Forbidden: group is not in your current context");
    }
    // Authorize the group RESOURCE itself, independently of roster filtering —
    // a stamped foreign group (even empty, or with one reachable scholar) must
    // not leak. accessibleGroupScholars only gated the roster.
    if (group && !(await groupInstitutionAccessible(ctx, ctx.user, group))) {
      throw new Error("Forbidden: group is not in your current context");
    }
    const scholars = (
      await Promise.all(scholarIds.map((id) => ctx.db.get(id)))
    ).filter((s): s is Doc<"users"> => s != null && s.role === ROLES.SCHOLAR);

    const rows = await buildTonightPlanRows(ctx, scholars, args.now);

    return {
      group: group ? { id: group._id, name: group.name, emoji: group.emoji ?? null } : null,
      scholars: rows,
    };
  },
});

/**
 * The whole-VIEW prep board: the tonight list for every scholar the caller can
 * see, from a client-supplied roster (the scholars already rendered in the
 * grid), access-gated per handler via `filterToAccessibleScholars` — a role
 * check alone is a cross-tenant leak, and for a multi-institution staffer the
 * visible roster can legitimately span institutions, so the per-scholar gate is
 * what bounds it, not a single institution id.
 *
 * ONE subscription for the whole grid (the tonight strips render on ALL scopes,
 * including All scholars), bounded by the roster the teacher already has. Reuses
 * `buildTonightPlanRows` — the SAME composition `forGroupAsTeacher` and the
 * scholar's own card use (T1), never a fork.
 */
export const forVisibleScholarsAsTeacher = teacherQuery({
  args: { scholarIds: v.array(v.id("users")), now: v.number() },
  handler: async (ctx, args) => {
    const requested = [...new Set(args.scholarIds)];
    const accessibleIds = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      requested,
    );
    const scholars = (
      await Promise.all(accessibleIds.map((id) => ctx.db.get(id)))
    ).filter((s): s is Doc<"users"> => s != null && s.role === ROLES.SCHOLAR);

    return { scholars: await buildTonightPlanRows(ctx, scholars, args.now) };
  },
});

/** The small self-only projection used by canonical Quest cards for pin state. */
export const pinningForSelf = authedQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user, args.now);
    if (!context) {
      return { dayKey: null, takeHomePeriod: "tonight" as const, pins: [] };
    }
    const [nextOpenDayKey, rows] = await Promise.all([
      nextOpenSchoolDayKey(
        ctx,
        context.institutionId,
        context.dayKey,
        context.timeZone,
      ),
      ctx.db
        .query("takeHomePlanItems")
        .withIndex("by_scholar_day", (q) =>
          q.eq("scholarId", context.scholar._id).eq("dayKey", context.dayKey),
        )
        .collect(),
    ]);
    return {
      dayKey: context.dayKey,
      takeHomePeriod:
        nextOpenDayKey &&
        !dayKeysShareCalendarWeek(context.dayKey, nextOpenDayKey)
          ? ("weekend" as const)
          : ("tonight" as const),
      pins: rows
        .filter(
          (row) =>
            row.institutionId === context.institutionId &&
            !row.removedAt &&
            !row.resolution &&
            (row.kind === "quest" || row.kind === "session"),
        )
        .map((row) => ({
          itemId: row._id,
          unitId: row.unitId ?? null,
          sessionId: row.sessionId ?? null,
        })),
    };
  },
});

export const addSuggestion = authedMutation({
  args: { suggestion: suggestionValidator },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const selected = await selectedItems(ctx, context);
    let candidate: Suggestion | undefined;
    if ("sessionId" in args.suggestion) {
      const sessionId = args.suggestion.sessionId;
      const candidates = await suggestions(
        ctx,
        context,
        selected,
        await homeworkForScholar(ctx, context.scholar._id, context.nowMs),
      );
      candidate = candidates.find(
        (item) =>
          item.kind === "activity" &&
          item.sessionId === sessionId,
      );
    } else {
      const unitId = args.suggestion.unitId;
      const quest = (await questsForScholar(ctx, context.scholar._id)).find(
        (item) => item.unitId === unitId && item.state === "active",
      );
      if (quest) {
        const session = (
          await ctx.db
            .query("sessions")
            .withIndex("by_user_unit", (q) =>
              q.eq("userId", context.scholar._id).eq("unitId", unitId),
            )
            .collect()
        )
          .filter(
            (item) =>
              !item.isArchived &&
              !item.isTestDrive &&
              !item.isOffline &&
              !item.assignmentId,
          )
          .sort((a, b) => sessionTouchTime(b) - sessionTouchTime(a))[0];
        candidate = {
          kind: "quest",
          id: `quest:${quest.unitId}`,
          unitId: quest.unitId,
          sessionId: session?._id ?? null,
          label: quest.title,
          meta: quest.emoji,
          actions: ["addToPlan", "markDone"],
        };
      }
    }
    if (!candidate) throw new Error("Suggestion is no longer available");

    const existing = selected.find((item) =>
      candidate.kind === "activity"
        ? item.kind === "activity" && item.activityId === candidate.activityId
        : item.kind === "quest" && item.unitId === candidate.unitId,
    );
    if (existing) return existing.id;
    const prior = (
      await ctx.db
        .query("takeHomePlanItems")
        .withIndex("by_scholar_day", (q) =>
          q.eq("scholarId", context.scholar._id).eq("dayKey", context.dayKey),
        )
        .collect()
    ).find(
      (item) =>
        item.institutionId === context.institutionId &&
        item.removedAt !== undefined &&
        (candidate.kind === "activity"
          ? item.kind === "activity" && item.activityId === candidate.activityId
          : item.kind === "quest" && item.unitId === candidate.unitId),
    );
    if (prior) {
      await ctx.db.patch(prior._id, { removedAt: undefined });
      return prior._id;
    }

    return await ctx.db.insert("takeHomePlanItems", {
      scholarId: context.scholar._id,
      institutionId: context.institutionId,
      dayKey: context.dayKey,
      kind: candidate.kind,
      ...(candidate.kind === "activity"
        ? { activityId: candidate.activityId, sessionId: candidate.sessionId }
        : { unitId: candidate.unitId, sessionId: candidate.sessionId ?? undefined }),
    });
  },
});

/**
 * Resolve a current suggestion in one transaction. Unlike `addSuggestion`,
 * this records the outcome in `resolvedToday`, keeping the editable tonight
 * list free of already-finished work.
 */
export const resolveSuggestion = authedMutation({
  args: { suggestion: suggestionValidator },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const selected = await selectedItems(ctx, context);
    const candidates = await suggestions(
      ctx,
      context,
      selected,
      await homeworkForScholar(ctx, context.scholar._id, context.nowMs),
    );
    const suggestion:
      | { kind: "activity"; sessionId: Id<"sessions"> }
      | { kind: "quest"; unitId: Id<"units"> } = args.suggestion;
    let candidate: Suggestion | undefined;
    if (suggestion.kind === "activity") {
      candidate = candidates.find(
        (item) =>
          item.kind === "activity" &&
          item.sessionId === suggestion.sessionId,
      );
    } else {
      candidate = candidates.find(
        (item) =>
          item.kind === "quest" && item.unitId === suggestion.unitId,
      );
    }
    if (!candidate) throw new Error("Suggestion is no longer available");

    if (candidate.kind === "activity") {
      const activity = await ctx.db.get(candidate.activityId);
      if (!activity?.lessonId) {
        throw new Error("Only lesson activities can be marked done");
      }
      const session = await ctx.db.get(candidate.sessionId);
      if (
        !session ||
        session.userId !== context.scholar._id ||
        session.activityId !== candidate.activityId
      ) {
        throw new Error("Activity session no longer belongs to this suggestion");
      }
      const completion = await reconcileActivityCompletion(ctx, {
        scholarId: context.scholar._id,
        activityId: candidate.activityId,
        sessionId: candidate.sessionId,
        note: "Marked done from today's suggestion",
        source: "scholar_home",
        action: "scholar_marked_take_home_done",
      });
      if (!completion.completionId) throw new Error("Failed to record completion");
      const itemId = await ctx.db.insert("takeHomePlanItems", {
        scholarId: context.scholar._id,
        institutionId: context.institutionId,
        dayKey: context.dayKey,
        kind: "activity",
        activityId: candidate.activityId,
        sessionId: candidate.sessionId,
        checkedAt: Date.now(),
        ...(completion.created
          ? {
              markedDoneAt: Date.now(),
              markedCompletionId: completion.completionId,
            }
          : {}),
        resolution: "activity_completed",
        resolvedAt: Date.now(),
      });
      return {
        itemId,
        kind: "activity" as const,
        undoAvailable: true,
      };
    }

    if (
      (await questStateForPair(ctx, context.scholar._id, candidate.unitId)) !==
      "active"
    ) {
      throw new Error("Quest is no longer active");
    }
    const activeSessions = (
      await ctx.db
        .query("sessions")
        .withIndex("by_user_unit", (q) =>
          q.eq("userId", context.scholar._id).eq("unitId", candidate.unitId),
        )
        .collect()
    ).filter(
      (session) =>
        !session.isArchived &&
        !session.isTestDrive &&
        !session.isOffline &&
        !session.assignmentId,
    );
    if (activeSessions.length === 0) throw new Error("Quest has no open sessions");
    for (const session of activeSessions) {
      await ctx.db.patch(session._id, { isArchived: true });
    }
    const itemId = await ctx.db.insert("takeHomePlanItems", {
      scholarId: context.scholar._id,
      institutionId: context.institutionId,
      dayKey: context.dayKey,
      kind: "quest",
      unitId: candidate.unitId,
      checkedAt: Date.now(),
      questOutcome: "scholar_closed",
      questClosedAt: Date.now(),
      questClosedSessionIds: activeSessions.map((session) => session._id),
      resolution: "quest_closed",
      resolvedAt: Date.now(),
    });
    return { itemId, kind: "quest" as const, undoAvailable: true };
  },
});

export const undoResolveSuggestion = authedMutation({
  args: { itemId: v.id("takeHomePlanItems") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    if (!item.resolution || item.removedAt) {
      throw new Error("Resolved suggestion not found");
    }
    if (item.resolution === "activity_completed") {
      if (item.markedCompletionId) {
        const completion = await ctx.db.get(item.markedCompletionId);
        if (
          completion?.scholarId === context.scholar._id &&
          completion.source === "scholar_home" &&
          completion.action === "scholar_marked_take_home_done"
        ) {
          await ctx.db.delete(completion._id);
          if (item.sessionId) {
            const session = await ctx.db.get(item.sessionId);
            if (session?.userId === context.scholar._id) {
              await ctx.db.patch(session._id, {
                activityCompletedAt: undefined,
                activityCompletionMessageId: undefined,
              });
            }
          }
        }
      }
    } else {
      for (const sessionId of item.questClosedSessionIds ?? []) {
        const session = await ctx.db.get(sessionId);
        if (session?.userId === context.scholar._id) {
          await ctx.db.patch(session._id, { isArchived: false });
        }
      }
    }
    await ctx.db.delete(item._id);
    return { restored: true };
  },
});

/**
 * Start one canonical teacher-suggested Quest and attach its new session to
 * today's plan in the same mutation.
 */
export const startSeedInPlan = authedMutation({
  args: { seedId: v.id("seeds") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const candidates = await suggestedQuestsForScholar(ctx, context.scholar._id);
    if (!candidates.some((candidate) => candidate.seedId === args.seedId)) {
      throw new Error("Quest invitation is no longer available");
    }

    const { id: sessionId } = await createSessionFromSeedCore(
      ctx,
      context.scholar._id,
      args.seedId,
    );
    const session = await ctx.db.get(sessionId);
    if (!session || session.userId !== context.scholar._id) {
      throw new Error("Failed to start Quest session");
    }
    const itemId = await ctx.db.insert("takeHomePlanItems", {
      scholarId: context.scholar._id,
      institutionId: context.institutionId,
      dayKey: context.dayKey,
      kind: session.unitId ? "quest" : "session",
      sessionId,
      ...(session.unitId ? { unitId: session.unitId } : {}),
    });
    return { itemId, sessionId, kind: session.unitId ? "quest" as const : "session" as const };
  },
});

/**
 * Attach a session already created by the existing freeform Quest flow to
 * the take-home plan. Creation remains owned by `units.createQuest` /
 * `sessions.startUnit`; this is intentionally only the idempotent plan seam.
 */
export const addSessionToPlan = authedMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const session = await ctx.db.get(args.sessionId);
    if (
      !session ||
      session.userId !== context.scholar._id ||
      session.isArchived ||
      session.isTestDrive ||
      session.isOffline ||
      session.assignmentId
    ) {
      throw new Error("Quest session is not available");
    }

    let unitId: Id<"units"> | undefined;
    if (session.unitId) {
      const unit = await ctx.db.get(session.unitId);
      if (
        !unit ||
        !unit.isActive ||
        unit.authorScholarId !== context.scholar._id ||
        unit.institutionId !== context.institutionId
      ) {
        throw new Error("Quest session is not available");
      }
      unitId = unit._id;
    }

    const rows = await ctx.db
      .query("takeHomePlanItems")
      .withIndex("by_scholar_day", (q) =>
        q.eq("scholarId", context.scholar._id).eq("dayKey", context.dayKey),
      )
      .collect();
    const existing = rows.find(
      (item) =>
        item.institutionId === context.institutionId &&
        !item.resolution &&
        (item.sessionId === session._id ||
          (unitId !== undefined && item.kind === "quest" && item.unitId === unitId)),
    );
    if (existing) {
      if (existing.removedAt) await ctx.db.patch(existing._id, { removedAt: undefined });
      return existing._id;
    }
    return await ctx.db.insert("takeHomePlanItems", {
      scholarId: context.scholar._id,
      institutionId: context.institutionId,
      dayKey: context.dayKey,
      kind: unitId ? "quest" : "session",
      sessionId: session._id,
      ...(unitId ? { unitId } : {}),
    });
  },
});

export const addNote = authedMutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const text = args.text.trim();
    if (!text || text.length > 1_000) throw new Error("Note must be 1–1000 characters");
    return await ctx.db.insert("takeHomePlanItems", {
      scholarId: context.scholar._id,
      institutionId: context.institutionId,
      dayKey: context.dayKey,
      kind: "note",
      text,
    });
  },
});

export const editNote = authedMutation({
  args: { itemId: v.id("takeHomePlanItems"), text: v.string() },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    if (item.kind !== "note" || item.removedAt) throw new Error("Note not found");
    const text = args.text.trim();
    if (!text || text.length > 1_000) throw new Error("Note must be 1–1000 characters");
    await ctx.db.patch(item._id, { text });
  },
});

export const setNoteChecked = authedMutation({
  args: { itemId: v.id("takeHomePlanItems"), checked: v.boolean() },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    if (item.kind !== "note" || item.removedAt) throw new Error("Note not found");
    await ctx.db.patch(item._id, { checkedAt: args.checked ? Date.now() : undefined });
  },
});

/** Remove the choice itself so eligible work can return to the suggestion pool. */
export const removeItem = authedMutation({
  args: { itemId: v.id("takeHomePlanItems") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    await ctx.db.delete(item._id);
  },
});

export const markActivityDone = authedMutation({
  args: { itemId: v.id("takeHomePlanItems") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    if (item.kind !== "activity" || !item.activityId || item.removedAt) {
      throw new Error("Activity plan item not found");
    }
    const activity = await ctx.db.get(item.activityId);
    if (!activity?.lessonId) {
      throw new Error("Only lesson activities can be marked done");
    }
    if (item.sessionId) {
      const session = await ctx.db.get(item.sessionId);
      if (
        !session ||
        session.userId !== context.scholar._id ||
        session.activityId !== item.activityId
      ) {
        throw new Error("Activity session no longer belongs to this plan");
      }
    }
    const completion = await reconcileActivityCompletion(ctx, {
      scholarId: context.scholar._id,
      activityId: item.activityId,
      sessionId: item.sessionId,
      note: "Marked from take-home plan",
      source: "scholar_home",
      action: "scholar_marked_take_home_done",
    });
    if (!completion.completionId) throw new Error("Failed to record completion");
    await ctx.db.patch(item._id, {
      checkedAt: Date.now(),
      markedDoneAt: completion.created ? Date.now() : item.markedDoneAt,
      markedCompletionId: completion.created
        ? completion.completionId
        : item.markedCompletionId,
    });
    return {
      completionId: completion.completionId,
      undoAvailable: completion.created,
      undoItemId: completion.created ? item._id : null,
    };
  },
});

export const undoMarkActivityDone = authedMutation({
  args: { itemId: v.id("takeHomePlanItems") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    if (
      item.kind !== "activity" ||
      !item.markedCompletionId ||
      item.removedAt
    ) {
      throw new Error("This activity completion cannot be undone here");
    }
    const completion = await ctx.db.get(item.markedCompletionId);
    if (completion?.scholarId === context.scholar._id) {
      await ctx.db.delete(completion._id);
    }
    if (item.sessionId) {
      const session = await ctx.db.get(item.sessionId);
      if (session?.userId === context.scholar._id) {
        await ctx.db.patch(session._id, {
          activityCompletedAt: undefined,
          activityCompletionMessageId: undefined,
        });
      }
    }
    await ctx.db.patch(item._id, {
      checkedAt: undefined,
      markedDoneAt: undefined,
      markedCompletionId: undefined,
    });
    return { restored: true };
  },
});

export const closeQuest = authedMutation({
  args: { itemId: v.id("takeHomePlanItems") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    if (item.kind !== "quest" || !item.unitId || item.removedAt) {
      throw new Error("Quest plan item not found");
    }
    if (
      (await questStateForPair(ctx, context.scholar._id, item.unitId)) !==
      "active"
    ) {
      throw new Error("Quest is no longer active");
    }
    const activeSessions = (
      await ctx.db
        .query("sessions")
        .withIndex("by_user_unit", (q) =>
          q.eq("userId", context.scholar._id).eq("unitId", item.unitId!),
        )
        .collect()
    ).filter(
      (session) =>
        !session.isArchived &&
        !session.isTestDrive &&
        !session.isOffline &&
        !session.assignmentId,
    );
    if (activeSessions.length === 0) throw new Error("Quest has no open sessions");
    for (const session of activeSessions) {
      await ctx.db.patch(session._id, { isArchived: true });
    }
    await ctx.db.patch(item._id, {
      checkedAt: Date.now(),
      questOutcome: "scholar_closed",
      questClosedAt: Date.now(),
      questClosedSessionIds: activeSessions.map((session) => session._id),
    });
    return { undoAvailable: true, undoItemId: item._id };
  },
});

export const undoCloseQuest = authedMutation({
  args: { itemId: v.id("takeHomePlanItems") },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const item = await currentItem(ctx, context, args.itemId);
    if (item.kind !== "quest" || !item.questClosedSessionIds || item.removedAt) {
      throw new Error("This quest closure cannot be undone here");
    }
    for (const sessionId of item.questClosedSessionIds) {
      const session = await ctx.db.get(sessionId);
      if (session?.userId === context.scholar._id) {
        await ctx.db.patch(session._id, { isArchived: false });
      }
    }
    await ctx.db.patch(item._id, {
      checkedAt: undefined,
      questOutcome: undefined,
      questClosedAt: undefined,
      questClosedSessionIds: undefined,
    });
    return { restored: true };
  },
});
