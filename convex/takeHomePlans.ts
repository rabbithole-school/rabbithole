import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { ScheduleCache } from "./lib/scheduleStore";
import { authedMutation, authedQuery, teacherQuery } from "./lib/customFunctions";
import { unarchivePatch } from "./lib/teacherArchive";
import {
  filterToAccessibleScholars,
  requireActiveScholarAccess,
} from "./lib/access";
import { ROLES } from "./lib/roles";
import { timeZoneForInstitution } from "./lib/institutionTime";
import {
  nextOpenSchoolDayKey,
  nextOpenSchoolDayKeys,
  prevOpenSchoolDayKey,
} from "./lib/schoolDays";
import { bestNextQuestionForScholar } from "./lib/questionQueue";
import { liveQuestionHomework } from "./lib/questionHomework";
import {
  homeworkForScholar,
  homeworkForScholarFromAssignments,
  homeworkAssignmentsByScholar,
} from "./assignments";
import {
  isRetractedQuestSession,
  questStateForPair,
  questsForScholar,
} from "./lib/questLifecycle";
import { reconcileActivityCompletion } from "./lib/activityCompletionCore";
import {
  dayKeysShareCalendarWeek,
  dayKeyForTimezone,
} from "../shared/institutionDay";
import { filterHomeworkForNow } from "../shared/scholarHomeNow";

let specialDeliveryAutoPrintingEnabled = false;

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

type Suggestion =
  | {
      kind: "activity";
      id: string;
      sessionId: Id<"sessions">;
      activityId: Id<"activities">;
      label: string;
      meta: string | null;
      actions: readonly ["markDone"];
    }
  | {
      kind: "quest";
      id: string;
      unitId: Id<"units">;
      sessionId: Id<"sessions"> | null;
      label: string;
      meta: string | null;
      actions: readonly ["markDone"];
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

/** The enriched-homework list for one scholar (the shared, once-computed input
 *  threaded through the composition so a roster read never re-scans per call). */
type ScholarHomework = Awaited<ReturnType<typeof homeworkForScholar>>;

function assignedItems(homework: ScholarHomework) {
  const forNow = filterHomeworkForNow(homework);
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
  homework: ScholarHomework,
): Promise<Suggestion[]> {
  const assignedActivityIds = new Set(
    homework.map((item) => String(item.activityId)),
  );
  const priorRows = await ctx.db
    .query("takeHomePlanItems")
    .withIndex("by_scholar_day", (q) =>
      q.eq("scholarId", context.scholar._id).eq("dayKey", context.dayKey),
    )
    .collect();
  const resolvedActivityIds = new Set(
    priorRows.flatMap((item) =>
      (item.resolution === "activity_completed" ||
        (item.resolution === "kept_open" && item.kind === "activity")) &&
      item.activityId
        ? [String(item.activityId)]
        : [],
    ),
  );
  const resolvedUnitIds = new Set(
    priorRows.flatMap((item) =>
      (item.resolution === "quest_closed" ||
        (item.resolution === "kept_open" && item.kind === "quest")) &&
      item.unitId
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
      resolvedActivityIds.has(activityKey)
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
      actions: ["markDone"],
    });
  }

  for (const quest of await questsForScholar(ctx, context.scholar._id)) {
    if (
      quest.state !== "active" ||
      quest.completedCount >= quest.onlineActivityCount ||
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
      actions: ["markDone"],
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
    suggestions: [],
    resolvedToday: [],
    counts: { assigned: 0, suggestions: 0 },
  };
}

/**
 * THE canonical Prep composition, shared verbatim by the scholar's own Prep
 * (`forSelf`) and the teacher Prep table (`forVisibleScholarsAsTeacher`). The
 * scholar and the teacher must never disagree about a scholar's Due list, so
 * there is exactly one computation — never a re-derivation. The caller owns
 * the auth gate; this takes an already-resolved context.
 */
async function composePlan(
  ctx: QueryCtx,
  context: ScholarContext,
  homework: ScholarHomework,
  // The teacher Prep table reads `assigned` from here (and `resolvedToday`
  // directly), so its whole-view read passes `lean` to skip the expensive
  // `suggestions` pass (which scans every session for the scholar and re-walks
  // quest history). ONE composition seam — never a forked lean copy (T1); the
  // skipped fields are simply returned empty, and buildTonightPlanRows never
  // returns them.
  opts: { lean?: boolean } = {},
) {
  const nextOpenDayKey = await nextOpenSchoolDayKey(
    ctx,
    context.institutionId,
    context.dayKey,
    context.timeZone,
  );
  const [suggested, resolved] = opts.lean
    ? [[] as Awaited<ReturnType<typeof suggestions>>, [] as Awaited<ReturnType<typeof resolvedToday>>]
    : await Promise.all([
        suggestions(ctx, context, homework),
        resolvedToday(ctx, context),
      ]);
  const assigned = assignedItems(homework);
  return {
    timeZone: context.timeZone,
    dayKey: context.dayKey,
    isPrimary: context.isPrimary,
    printsTonight:
      context.isPrimary && specialDeliveryAutoPrintingEnabled,
    takeHomePeriod:
      nextOpenDayKey &&
      !dayKeysShareCalendarWeek(context.dayKey, nextOpenDayKey)
        ? ("weekend" as const)
        : ("tonight" as const),
    assigned,
    suggestions: suggested,
    resolvedToday: resolved,
    counts: {
      assigned: assigned.length,
      suggestions: suggested.length,
    },
  };
}

/**
 * The named outcome of homework that was due by this morning — join the
 * homework whose `dueAt` fell on the PRIOR open school day to the canonical
 * `activityCompletions` record (via `homeworkForScholar`'s `completedByMe`).
 * The claim is narrow on purpose (T7): this is "homework that was due
 * yesterday," not a reconstruction of last night's exact tonight card. Takes
 * the already-computed `homework` so a roster read never re-scans per scholar.
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
 * Question homework a teacher set for a day BEYOND the Due window (TRA-476).
 * `assigned` follows the scholar's own Due window (overdue / today / next
 * school day), so "Assign…" for Thursday would otherwise make the question
 * leave the row's next-question line with nothing replacing it. These are the
 * live homework entries `assignedItems` left out, narrowed to seed-backed
 * question homework through THE live predicate (`liveQuestionHomework`), so a
 * teacher sees what they just set. Plain homework due later is not a question
 * and stays off this row, as before. Bounded: one `activities.get` per
 * out-of-window entry (a handful), then `liveQuestionHomework`'s indexed
 * `by_seed` read.
 */
async function laterQuestionHomework(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  homework: ScholarHomework,
  assigned: readonly {
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
  }[],
) {
  const inWindow = new Set(
    assigned.map((item) => `${item.assignmentId}:${item.activityId}`),
  );
  const out: {
    id: string;
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
    label: string;
    meta: string | null;
    dueAt: number;
  }[] = [];
  for (const item of homework) {
    if (item.completedByMe || item.dueAt == null) continue;
    if (inWindow.has(`${item.assignmentId}:${item.activityId}`)) continue;
    const activity = await ctx.db.get(item.activityId);
    if (!activity?.seedId) continue;
    const live = await liveQuestionHomework(ctx, scholarId, activity.seedId);
    if (!live || live.activityId !== item.activityId) continue;
    out.push({
      id: `later:${item.assignmentId}:${item.activityId}`,
      assignmentId: item.assignmentId,
      activityId: item.activityId,
      label: item.activityTitle ?? "(removed activity)",
      meta: item.unitTitle ?? null,
      dueAt: item.dueAt,
    });
  }
  return out;
}

/** How many upcoming open school days a Prep row offers in its "Assign…" menu
 *  (the first is usually tomorrow; "Pick a date…" covers the rest). */
const ASSIGN_DAY_OPTIONS = 3;

/** A Prep row's single best next question: the top QUESTION row of the
 *  scholar's one ranked queue, read bounded by `bestNextQuestionForScholar`
 *  (same evaluation + ranker as `questionQueueForScholar`, the rows their
 *  Quests list and Prep "Keep going" show). Teacher-suggested quests are not
 *  questions, so they never fill this slot. */
function bestNextQuestion(
  row: Awaited<ReturnType<typeof bestNextQuestionForScholar>>,
): { seedId: Id<"seeds">; emoji: string; prompt: string } | null {
  return row ? { seedId: row.seedId, emoji: row.emoji, prompt: row.question.prompt } : null;
}

/**
 * Build the per-scholar Prep rows for a set of already-authorized scholars —
 * the core of the whole-view Homework table. Collects assignments ONCE
 * for the whole set and partitions per scholar (never a full assignment-table
 * scan per scholar), then composes each row with the SAME `composePlan` the
 * scholar's own Prep uses. The caller owns the access gate; this takes an
 * already-filtered scholar list.
 *
 * A row is what a teacher needs at Scholar's Prep: what is DUE (the scholar's
 * Due list), what they CLOSED today (their "Done today?" close-outs), their one
 * best NEXT question with the open school days it can be assigned for, and
 * last night's outcome. The retired tonight plan ("Chosen" items, notes) is no
 * longer a teacher fact — the scholar can no longer choose items.
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
  // The "Assign…" day options are an institution fact; a roster can span
  // institutions, so compute once per (institution, local day), not per row.
  const assignDaysCache = new Map<string, Promise<string[]>>();
  const assignDaysFor = (context: ScholarContext) => {
    const key = `${context.institutionId}:${context.dayKey}`;
    let days = assignDaysCache.get(key);
    if (!days) {
      days = nextOpenSchoolDayKeys(
        ctx,
        context.institutionId,
        context.dayKey,
        context.timeZone,
        ASSIGN_DAY_OPTIONS,
      );
      assignDaysCache.set(key, days);
    }
    return days;
  };
  // One schedule read per assignment across the whole roster.
  const scheduleCache: ScheduleCache = new Map();

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
          dayKey: plan.dayKey,
          emptyList: true,
          assigned: plan.assigned,
          closedToday: plan.resolvedToday as ResolvedToday[],
          later: [] as Awaited<ReturnType<typeof laterQuestionHomework>>,
          bestNext: null as ReturnType<typeof bestNextQuestion>,
          assignDays: [] as string[],
          lastNight: [] as Awaited<ReturnType<typeof lastNightOutcome>>,
        };
      }
      const homework = await homeworkForScholarFromAssignments(
        ctx,
        scholar._id,
        byScholar.get(String(scholar._id)) ?? [],
        context.nowMs,
        scheduleCache,
      );
      const [plan, closedToday, lastNight, best, assignDays] = await Promise.all([
        // Lean: skip the suggestions scan (the scholar's own "Done today?"
        // prompt); the teacher reads only what they already closed.
        composePlan(ctx, context, homework, { lean: true }),
        resolvedToday(ctx, context),
        lastNightOutcome(ctx, context, homework),
        // Bounded: only the top row, never the scholar's whole queue — this
        // runs per scholar inside a subscribed whole-roster query.
        bestNextQuestionForScholar(ctx, scholar._id),
        assignDaysFor(context),
      ]);
      return {
        scholarId: scholar._id,
        name: scholar.name ?? scholar.username ?? "Scholar",
        username: scholar.username ?? null,
        image: scholar.image ?? null,
        timeZone: plan.timeZone,
        dayKey: plan.dayKey,
        // A neutral property of the same read: nothing due. Not a red alert —
        // an empty Due list can simply mean nothing is due (T6/T7).
        emptyList: plan.assigned.length === 0,
        assigned: plan.assigned,
        closedToday,
        later: await laterQuestionHomework(
          ctx,
          scholar._id,
          homework,
          plan.assigned,
        ),
        bestNext: bestNextQuestion(best),
        assignDays,
        lastNight,
      };
    }),
  );
}

/**
 * The whole-VIEW prep board: the tonight list for every scholar the caller can
 * see, from a client-supplied roster (the scholars already rendered in the
 * grid), access-gated per handler via `filterToAccessibleScholars` — a role
 * check alone is a cross-tenant leak, and for a multi-institution staffer the
 * visible roster can legitimately span institutions, so the per-scholar gate is
 * what bounds it, not a single institution id.
 *
 * ONE subscription for the whole grid (the tonight strips render on ALL scopes,
 * including All scholars), bounded by the roster the teacher already has. Each
 * row is composed by `composePlan`, the SAME composition the scholar's own
 * Prep uses (T1), never a fork.
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

/**
 * Resolve a current suggestion ("Done today?" → done) in one transaction: it
 * records the completion or closes the quest, and the outcome shows in
 * `resolvedToday` with an undo.
 */
export const resolveSuggestion = authedMutation({
  args: { suggestion: suggestionValidator },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const candidates = await suggestions(
      ctx,
      context,
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

/**
 * "Keep it open" on the Scholar's Prep "Done today?" close-out — the sibling
 * of `resolveSuggestion` that changes nothing about the work itself. It only
 * records the answer for today (`resolution: "kept_open"`), so the close-out
 * stops asking about that activity/quest until tomorrow. No completion, no
 * archive, nothing to undo; `resolvedToday` ignores these rows.
 */
export const keepSuggestionOpen = authedMutation({
  args: { suggestion: suggestionValidator },
  handler: async (ctx, args) => {
    const context = await scholarContext(ctx, ctx.user);
    if (!context) throw new Error("Only scholars can edit a take-home plan");
    const candidates = await suggestions(
      ctx,
      context,
      await homeworkForScholar(ctx, context.scholar._id, context.nowMs),
    );
    const suggestion = args.suggestion;
    const candidate = candidates.find((item) =>
      suggestion.kind === "activity"
        ? item.kind === "activity" && item.sessionId === suggestion.sessionId
        : item.kind === "quest" && item.unitId === suggestion.unitId,
    );
    // Already answered today (or no longer open): nothing to record.
    if (!candidate) return null;
    return await ctx.db.insert("takeHomePlanItems", {
      scholarId: context.scholar._id,
      institutionId: context.institutionId,
      dayKey: context.dayKey,
      kind: candidate.kind,
      ...(candidate.kind === "activity"
        ? { activityId: candidate.activityId, sessionId: candidate.sessionId }
        : { unitId: candidate.unitId }),
      resolution: "kept_open",
      resolvedAt: Date.now(),
    });
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
        if (session?.userId !== context.scholar._id) continue;
        // A teacher may have retracted the quest since it was closed; that
        // work stays put away (lib/questLifecycle.ts isRetractedQuestSession).
        const unit = session.unitId ? await ctx.db.get(session.unitId) : null;
        if (isRetractedQuestSession(session, unit)) continue;
        await ctx.db.patch(session._id, unarchivePatch(session));
      }
    }
    await ctx.db.delete(item._id);
    return { restored: true };
  },
});
