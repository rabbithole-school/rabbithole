// The shared scholar-read DATA layer — plain functions over QueryCtx.
//
// One implementation of "what does a scholar's mastery/signals/seeds/…
// look like to an agent surface," consumed by:
//
//   - convex/curriculumAssistant.ts internal queries (the aide streams),
//   - convex/parents.ts child* queries (the parent portal + parent chat),
//   - convex/mcp.ts (the OAuth-authenticated remote MCP connector).
//
// These functions do NO access control — callers gate first
// (requireTeacher / requireGuardianOf / the policy table in
// scholarReadPolicy.ts) and then read. Keeping them as plain functions
// (not internalQuery) lets queries call them directly without
// ctx.runQuery sub-transactions or api-inference cycles.

import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ROLES, isTeacherRole, type Role } from "./roles";
import { normalizeName } from "./scholarMatch";
import { isEnrolledScholar } from "./enrollmentStanding";
import { extendedEducationTag } from "./scholarParticipationTooling";
import {
  computeFrontier,
  isDue,
  isFluent,
  isProvisional,
  latencyBaselineFromSkillMedians,
  type GraphEdge,
  type SkillState,
} from "./practice/scheduler";
import { eligibleStoryApplication } from "./practice/applicationEligibility";
import {
  domainMayServe,
  type DomainMapStatus,
  type ScholarMapSummary,
} from "./practice/domainMapStatus";
import { buildStoredServable, buildTemplateServable } from "./practice/servable";
import { parseItemId } from "./practice/session";
import { loadScholarMapSummaryWithNodes } from "../practiceSkills";
import { timeZoneForInstitution } from "./institutionTime";
import type { StoryKind } from "./practice/storyRegistry";
import { ageOnDayKey } from "../../shared/birthday";
import { practiceDomainLabel } from "../../shared/practiceDomainLabels";
import { CHECK_IN_SITTING_PROBE_BUDGET } from "../../shared/practiceLoop";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  shiftDayKey,
} from "../../shared/institutionDay";
import {
  SESSION_ACTIVITY_KINDS,
  type SessionActivityKind,
} from "../../lib/activityKinds";

type OrderedOnlineActivity = {
  activity: Doc<"activities">;
  lesson: Doc<"lessons">;
  position: number;
};

type ActivityProgressCtx = QueryCtx | MutationCtx;
type LaunchableActivityKind =
  | SessionActivityKind
  | "web"
  | "game";

async function orderedActivitiesForUnit(
  ctx: ActivityProgressCtx,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
  launchableKinds: LaunchableActivityKind[] = ["online"],
  scholarId?: Id<"users"> | null,
): Promise<OrderedOnlineActivity[]> {
  const launchableKindSet = new Set(launchableKinds);
  const lessons = (
    await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect()
  ).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const ordered: OrderedOnlineActivity[] = [];
  for (const lesson of lessons) {
    const activities = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
        .collect()
    ).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const activity of activities) {
      if (activity.archivedAt) continue; // archived = out of active curriculum
      if (!launchableKindSet.has(activity.kind as LaunchableActivityKind)) continue;
      ordered.push({
        activity,
        lesson,
        position: ordered.length,
      });
    }
  }
  if (!assignmentId) return ordered;
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment || assignment.archivedAt) return [];
  if (String(assignment.unitId) !== String(unitId)) return [];
  if (assignment.selfPaced) return ordered;
  const schedule = assignment?.activitySchedule ?? [];
  if (schedule.length === 0) return [];
  const now = Date.now();
  const scholarKey = scholarId ? String(scholarId) : null;
  const liveActivityIds = new Set(
    schedule
      .filter(
        (entry) =>
          entry.setAt != null &&
          // A class focus counts while it is SHOWING, not merely while its
          // window is open — mirroring `isEntryShowing` in ../assignments.ts.
          // A teacher running long has not wrapped the focus, so it is still
          // what the room is on; narrowing the ladder on `endsAt` emptied it,
          // which then hid the activity from the plate entirely. Homework
          // keeps the window test: there `endsAt` means WITHDRAWN, not
          // "window closed".
          (entry.endsAt == null ||
            entry.endsAt > now ||
            entry.mode === "classFocus") &&
          // Per-scholar targeting: an entry with a non-empty `scholarIds`
          // is live only for those scholars. Absent/empty = cohort-wide.
          // Without a scholarId we can't narrow, so keep cohort-wide only.
          (entry.scholarIds == null ||
            entry.scholarIds.length === 0 ||
            (scholarKey != null &&
              entry.scholarIds.some((id) => String(id) === scholarKey))),
      )
      .map((entry) => String(entry.activityId)),
  );
  return ordered.filter((item) => liveActivityIds.has(String(item.activity._id)));
}

export async function orderedOnlineActivitiesForUnit(
  ctx: ActivityProgressCtx,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
  scholarId?: Id<"users"> | null,
): Promise<OrderedOnlineActivity[]> {
  return orderedActivitiesForUnit(ctx, unitId, assignmentId, ["online"], scholarId);
}

export async function orderedSessionActivitiesForUnit(
  ctx: ActivityProgressCtx,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
  scholarId?: Id<"users"> | null,
): Promise<OrderedOnlineActivity[]> {
  return orderedActivitiesForUnit(
    ctx,
    unitId,
    assignmentId,
    [...SESSION_ACTIVITY_KINDS],
    scholarId,
  );
}

export async function orderedLaunchableActivitiesForUnit(
  ctx: ActivityProgressCtx,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
  scholarId?: Id<"users"> | null,
): Promise<OrderedOnlineActivity[]> {
  return orderedActivitiesForUnit(
    ctx,
    unitId,
    assignmentId,
    // Web/game launch through dedicated shells. Simulator/vibecode create a
    // normal scoped session whose renderer is selected by sessionMode.
    ["online", "web", "game", "simulator", "vibecode"],
    scholarId,
  );
}

// ─── Choice-aware plan ──────────────────────────────────────────────
// One place that reinterprets an ordered activity list under the lessons'
// `selectionMode`, so the plate, progress counts, unit-complete rule and
// "next" navigation can never drift. For a "choice" lesson the scholar
// only owes `pickCount` (clamped to the # of live options) of its
// activities; once that many are done the lesson is SATISFIED and its
// remaining options stop counting as work and stop being surfaced (D2 —
// still openable via the unit nav, just no longer nagging). "sequence"
// lessons (and any lesson without the flag) keep today's linear behavior.
export type ChoiceLessonPlan = {
  pickCount: number;
  optionCount: number;
  completedCount: number;
  satisfied: boolean;
};

export type ChoicePlan = {
  // Choice-aware unit totals (what the scholar actually owes / has done).
  requiredTotal: number;
  completedRequired: number;
  // Activity ids still offerable as work (drives the plate's not-started
  // cards): all uncompleted sequence options + the uncompleted options of
  // any UNsatisfied choice lesson; nothing from a satisfied choice lesson.
  availableActivityIds: Set<string>;
  // Choice-aware "first thing left to do" (skips satisfied choice lessons).
  nextItem: OrderedOnlineActivity | null;
  // Per-lesson choice state, keyed by lessonId — only choice lessons appear.
  choiceByLesson: Map<string, ChoiceLessonPlan>;
};

export function computeChoicePlan(
  ordered: OrderedOnlineActivity[],
  completed: Set<string>,
): ChoicePlan {
  const byLesson: { lesson: Doc<"lessons">; items: OrderedOnlineActivity[] }[] = [];
  const lessonIndex = new Map<string, number>();
  for (const item of ordered) {
    const key = String(item.lesson._id);
    let at = lessonIndex.get(key);
    if (at === undefined) {
      at = byLesson.length;
      lessonIndex.set(key, at);
      byLesson.push({ lesson: item.lesson, items: [] });
    }
    byLesson[at].items.push(item);
  }

  let requiredTotal = 0;
  let completedRequired = 0;
  const availableActivityIds = new Set<string>();
  const choiceByLesson = new Map<string, ChoiceLessonPlan>();
  let nextItem: OrderedOnlineActivity | null = null;

  for (const group of byLesson) {
    const optionCount = group.items.length;
    if (optionCount === 0) continue;
    const completedCount = group.items.filter((it) =>
      completed.has(String(it.activity._id)),
    ).length;
    const isChoice = group.lesson.selectionMode === "choice";

    if (isChoice) {
      const pickCount = Math.min(
        Math.max(1, Math.round(group.lesson.choicePickCount ?? 1)),
        optionCount,
      );
      const satisfied = completedCount >= pickCount;
      choiceByLesson.set(String(group.lesson._id), {
        pickCount,
        optionCount,
        completedCount,
        satisfied,
      });
      requiredTotal += pickCount;
      completedRequired += Math.min(completedCount, pickCount);
      if (!satisfied) {
        for (const it of group.items) {
          if (!completed.has(String(it.activity._id))) {
            availableActivityIds.add(String(it.activity._id));
            if (!nextItem) nextItem = it;
          }
        }
      }
    } else {
      requiredTotal += optionCount;
      completedRequired += completedCount;
      for (const it of group.items) {
        if (!completed.has(String(it.activity._id))) {
          availableActivityIds.add(String(it.activity._id));
          if (!nextItem) nextItem = it;
        }
      }
    }
  }

  return {
    requiredTotal,
    completedRequired,
    availableActivityIds,
    nextItem,
    choiceByLesson,
  };
}

export async function completedActivityIdsForScholarInUnit(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
): Promise<Set<string>> {
  if (assignmentId) {
    const [scoped, unitCompletions] = await Promise.all([
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_assignment", (q) =>
          q.eq("scholarId", scholarId).eq("assignmentId", assignmentId),
        )
        .collect(),
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .collect(),
    ]);
    const completions = scoped.filter(
      (c) => c.unitId && String(c.unitId) === String(unitId),
    );
    for (const c of unitCompletions) {
      if (c.assignmentId !== undefined) continue;
      if (c.sessionId) {
        const session = await ctx.db.get(c.sessionId);
        if (String(session?.assignmentId ?? "") === String(assignmentId)) {
          completions.push(c);
        }
        continue;
      }
      const matchingSessions = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .filter((q) => q.eq(q.field("activityId"), c.activityId))
        .collect();
      if (
        matchingSessions.some(
          (s) => String(s.assignmentId ?? "") === String(assignmentId),
        )
      ) {
        completions.push(c);
      }
    }
    return new Set(completions.map((c) => String(c.activityId)));
  }

  const completions = (
    await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", scholarId).eq("unitId", unitId),
      )
      .collect()
  ).filter((c) => c.assignmentId === undefined);
  const unassigned: typeof completions = [];
  for (const c of completions) {
    if (!c.sessionId) {
      const matchingAssignedSession = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .filter((q) => q.eq(q.field("activityId"), c.activityId))
        .filter((q) => q.neq(q.field("assignmentId"), undefined))
        .first();
      if (matchingAssignedSession) continue;
      unassigned.push(c);
      continue;
    }
    const session = await ctx.db.get(c.sessionId);
    if (session?.assignmentId === undefined) unassigned.push(c);
  }
  return new Set(unassigned.map((c) => String(c.activityId)));
}

export async function firstIncompleteOnlineActivityInUnit(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
) {
  const [ordered, completed] = await Promise.all([
    orderedOnlineActivitiesForUnit(ctx, unitId, assignmentId, scholarId),
    completedActivityIdsForScholarInUnit(ctx, scholarId, unitId, assignmentId),
  ]);
  return computeChoicePlan(ordered, completed).nextItem;
}

export async function firstIncompleteSessionActivityInUnit(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
) {
  const [ordered, completed] = await Promise.all([
    orderedSessionActivitiesForUnit(ctx, unitId, assignmentId, scholarId),
    completedActivityIdsForScholarInUnit(ctx, scholarId, unitId, assignmentId),
  ]);
  return computeChoicePlan(ordered, completed).nextItem;
}

export async function firstIncompleteLaunchableActivityInUnit(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
) {
  const [ordered, completed] = await Promise.all([
    orderedLaunchableActivitiesForUnit(ctx, unitId, assignmentId, scholarId),
    completedActivityIdsForScholarInUnit(ctx, scholarId, unitId, assignmentId),
  ]);
  return computeChoicePlan(ordered, completed).nextItem;
}

export async function unitOnlineProgressForScholar(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
) {
  const [ordered, completed] = await Promise.all([
    orderedOnlineActivitiesForUnit(ctx, unitId, assignmentId, scholarId),
    completedActivityIdsForScholarInUnit(ctx, scholarId, unitId, assignmentId),
  ]);
  const plan = computeChoicePlan(ordered, completed);
  return {
    ordered,
    completedActivityIds: completed,
    totalOnline: plan.requiredTotal,
    completedOnline: plan.completedRequired,
    availableActivityIds: plan.availableActivityIds,
    choiceByLesson: plan.choiceByLesson,
    nextItem: plan.nextItem,
  };
}

/**
 * Assignment-blind online progress for a scholar's quest lifecycle over a unit.
 * Unlike `unitOnlineProgressForScholar`, quest progress counts completions from
 * every assignment: it reads the SAME assignment-blind completion LEDGER as
 * `badgeAward` (the same `by_scholar_unit` index, no `assignmentId` filter).
 *
 * The satisfaction THRESHOLD deliberately differs, though: `computeChoicePlan`
 * is choice-aware and `orderedOnlineActivitiesForUnit` drops archived
 * activities, whereas `badgeAward` requires every online activity via a plain
 * `.every()` and does not exclude archived ones. So a choice-lesson or
 * archived-activity unit can be quest-state `finished` with NO badge minted.
 */
export async function questOnlineProgressForScholar(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
) {
  const [ordered, completions] = await Promise.all([
    orderedOnlineActivitiesForUnit(ctx, unitId, null, scholarId),
    // Deliberately mirrors badgeAward's assignment-blind scholar/unit read.
    ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", scholarId).eq("unitId", unitId),
      )
      .collect(),
  ]);
  const completed = new Set(completions.map((c) => String(c.activityId)));
  const plan = computeChoicePlan(ordered, completed);
  return {
    ordered,
    completedActivityIds: completed,
    totalOnline: plan.requiredTotal,
    completedOnline: plan.completedRequired,
    availableActivityIds: plan.availableActivityIds,
    choiceByLesson: plan.choiceByLesson,
    nextItem: plan.nextItem,
  };
}

export async function unitSessionProgressForScholar(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
) {
  const [ordered, completed] = await Promise.all([
    orderedSessionActivitiesForUnit(ctx, unitId, assignmentId, scholarId),
    completedActivityIdsForScholarInUnit(ctx, scholarId, unitId, assignmentId),
  ]);
  const plan = computeChoicePlan(ordered, completed);
  return {
    ordered,
    completedActivityIds: completed,
    totalOnline: plan.requiredTotal,
    completedOnline: plan.completedRequired,
    availableActivityIds: plan.availableActivityIds,
    choiceByLesson: plan.choiceByLesson,
    nextItem: plan.nextItem,
  };
}

export async function unitLaunchableProgressForScholar(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
) {
  const [ordered, completed] = await Promise.all([
    orderedLaunchableActivitiesForUnit(ctx, unitId, assignmentId, scholarId),
    completedActivityIdsForScholarInUnit(ctx, scholarId, unitId, assignmentId),
  ]);
  const plan = computeChoicePlan(ordered, completed);
  return {
    ordered,
    completedActivityIds: completed,
    totalOnline: plan.requiredTotal,
    completedOnline: plan.completedRequired,
    availableActivityIds: plan.availableActivityIds,
    choiceByLesson: plan.choiceByLesson,
    nextItem: plan.nextItem,
  };
}

/**
 * Is a whole UNIT complete for a scholar? The canonical "unit finished" rule,
 * shared by the seed/quest completion writer (lib/seeds) and the quest-card
 * projections (units.listScholarAuthored, seeds.suggestedQuestsForSelf) so
 * "one completion, one truth": a unit is complete when it has at least one
 * online activity and EVERY online activity is in the scholar's
 * activityCompletions (the canonical ledger). Delegates to
 * `unitOnlineProgressForScholar`, so it can never drift from the plate/nav.
 */
export async function isUnitCompleteForScholar(
  ctx: ActivityProgressCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId?: Id<"assignments"> | null,
): Promise<boolean> {
  const { totalOnline, completedOnline } = await unitOnlineProgressForScholar(
    ctx,
    scholarId,
    unitId,
    assignmentId,
  );
  return totalOnline > 0 && completedOnline >= totalOnline;
}

/** One "Suggested by your teacher" offer card — the shape the scholar-home
 *  SuggestedQuests section renders, plus `isAuthored` (does the offered unit
 *  have an `authorScholarId`?) so a teacher-facing caller can pick the right
 *  removal verb (Retract a scholar-authored quest vs. Remove a catalog-unit
 *  suggestion). */
export interface SuggestedQuestForScholar {
  seedId: Id<"seeds">;
  unitId: Id<"units">;
  title: string;
  emoji: string;
  activityCount: number;
  /** SCHOLAR-facing invitation (scholarInvitation ?? rationale). */
  rationale: string;
  /** The unit's scholar-facing blurb (scholarDescription ?? description). */
  description: string | null;
  teacherName: string;
  teacherImage: string | null;
  /** True ⟺ the offered unit is a scholar-authored quest; false ⟺ a catalog
   *  unit offered as a suggestion (no `authorScholarId`). */
  isAuthored: boolean;
}

/**
 * The scholar-parameterized CORE of `seeds.suggestedQuestsForSelf` — the ONE
 * derivation of the "Suggested by your teacher" cards, shared so the scholar's
 * own home (`seeds.suggestedQuestsForSelf`) and the teacher's Home mirror
 * (`scholarPlate.homeForScholar`) render the identical set and can't drift.
 *
 * A card is an ACTIVE `teacher`-origin seed pointing at an ACTIVE unit the
 * scholar hasn't STARTED (no session stamped with that `seedId`) and hasn't
 * already completed. Newest offer first. Teacher attribution + invitation copy
 * use the same precedence the scholar sees. NOTE this is SEED-derived, not
 * quest-derived: it includes catalog-unit offers (a teacher can `offer` any
 * unit), which `questsForScholar` has no row for.
 */
export async function suggestedQuestsForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<SuggestedQuestForScholar[]> {
  const active = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) =>
      q.eq("scholarId", scholarId).eq("status", "active"),
    )
    .collect();
  const candidates = active
    .filter((s) => s.origin === "teacher" && s.unitId != null)
    .sort((a, b) => b._creationTime - a._creationTime);
  if (candidates.length === 0) return [];

  // A suggested quest the scholar has already begun spawns a session stamped
  // with the seed's id — drop those (they're in the in-progress plate now).
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  const startedSeedIds = new Set(
    sessions.filter((s) => s.seedId).map((s) => String(s.seedId)),
  );

  // Fallback attribution: if a seed didn't record WHO offered it
  // (`teacherId` unset), use the scholar's group teacher so the card shows a
  // real name/avatar instead of the generic "Your teacher".
  const groups = await ctx.db.query("scholarGroups").collect();
  const myGroup = groups.find((g) =>
    g.scholarIds.some((id) => String(id) === String(scholarId)),
  );
  const fallbackTeacher = myGroup?.teacherId
    ? await ctx.db.get(myGroup.teacherId)
    : null;

  const out: SuggestedQuestForScholar[] = [];
  for (const s of candidates) {
    if (startedSeedIds.has(String(s._id)) || !s.unitId) continue;
    const unit = await ctx.db.get(s.unitId);
    if (!unit || !unit.isActive) continue;
    // Never re-suggest a quest the scholar has already finished (belt-and-
    // braces: read the canonical completion ledger, not just the seed status).
    if (await isUnitCompleteForScholar(ctx, scholarId, unit._id)) continue;
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    let activityCount = 0;
    for (const l of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      activityCount += acts.filter((a) => a.kind === "online").length;
    }
    const teacher =
      (s.teacherId ? await ctx.db.get(s.teacherId) : null) ?? fallbackTeacher;
    out.push({
      seedId: s._id,
      unitId: unit._id,
      title: unit.title,
      emoji: unit.emoji ?? "⚡",
      activityCount,
      // Scholar-facing card — prefer the kid's invitation over the teacher
      // diagnostic when one was authored.
      rationale: s.scholarInvitation ?? s.rationale,
      // Scholar copy only — a teacher-authored unit `description` is design
      // intent and never falls back onto a kid's card (title-only is correct).
      description: unit.scholarDescription ?? null,
      teacherName: teacher?.name ?? teacher?.username ?? "Your teacher",
      teacherImage: teacher?.image ?? null,
      isAuthored: unit.authorScholarId != null,
    });
  }
  return out;
}

/** The scholar-home cap for "Unlocked by your new skills" — a calm SECTION,
 *  not the whole accrued pile. Older story stars are never dropped; they keep
 *  living in the Sky (they are `seeds` rows like any other star). */
export const UNLOCKED_STORY_SECTION_CAP = 3;
export const STANDING_STORY_INVITATION_CAP = 2;

const STANDING_STORY_OUTCOMES: ReadonlySet<Doc<"momentEvents">["outcome"]> =
  new Set(["offered", "opened", "probed"]);

export const STORY_KIND_LABELS: Record<StoryKind, string> = {
  instantiates: "instantiates",
  applies: "applies to",
  history: "history",
  etymology: "etymology",
};

/** One "Unlocked by your new skills" card — a world-connection story a scholar
 *  earned by turning a skill fluent, cited back to that skill. */
export interface UnlockedStoryForScholar {
  seedId: Id<"seeds">;
  /** The story's one-line hook — the same headline the moment card led with. */
  hook: string;
  /** The card teaser (falls back to the full narrative on stories seeded
   *  before teasers existed). */
  teaser: string;
  /** Optional authored curiosity cue; absent stories retain their text-only card. */
  visualEmoji?: string;
  /** The skill whose fluency unlocked this story — the card's citation. */
  skillLabel: string;
  /** The far-side idea the story lands on. */
  topic: string;
  domain: string;
  /** Graph identity, so the card can re-open the SAME Socratic story thread
   *  (`/story-open`) the moment card's "Find out more" opens. */
  fromKey: string;
  toKey: string;
  /** Whether this edge still resolves to an eligible verifier-backed
   * application. No item identity or answer-bearing fields cross this wire. */
  hasApplication: boolean;
}

export interface StandingStoryInvitationForScholar {
  seedId: Id<"seeds">;
  eventId: Id<"momentEvents">;
  fromKey: string;
  toKey: string;
  skillLabel: string;
  hook: string;
  teaser?: string;
  visualEmoji?: string;
  artUrl?: string;
  kindLabel: string;
  hasApplication: boolean;
  offeredAt: number;
}

/** Resolve only ready, scholar-safe story art to its public serving URL. Raw
 * storage ids and attachment bookkeeping never cross the scholar boundary. */
export async function storyArtUrlForNode(
  ctx: QueryCtx | MutationCtx,
  nodeKey: string,
): Promise<string | undefined> {
  const node = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
    .unique();
  if (node?.artStatus !== "ready" || !node.artStorageId) return undefined;
  return (await ctx.storage.getUrl(node.artStorageId)) ?? undefined;
}

/**
 * Active story seeds whose latest ledger event is still non-terminal and which
 * have not started a session. The public query uses the two-card cap; the offer
 * governor reads the full set through the same core so eligibility cannot drift.
 */
export async function standingStoryInvitationsForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  limit = STANDING_STORY_INVITATION_CAP,
): Promise<StandingStoryInvitationForScholar[]> {
  const activeStorySeeds = (
    await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", scholarId).eq("status", "active"),
      )
      .collect()
  ).filter(
    (seed) =>
      seed.origin === "story" && seed.storyFromKey && seed.storyToKey,
  );
  if (activeStorySeeds.length === 0 || limit <= 0) return [];

  const [sessions, events] = await Promise.all([
    ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholarId))
      .collect(),
    ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
  ]);
  const startedSeedIds = new Set(
    sessions.filter((session) => session.seedId).map((session) => String(session.seedId)),
  );

  const newestEvents = [...events].sort(
    (a, b) =>
      b.offeredAt - a.offeredAt || b._creationTime - a._creationTime,
  );
  const latestEventByEdge = new Map<string, Doc<"momentEvents">>();
  for (const event of newestEvents) {
    const edgeKey = `${event.fromKey}\u0000${event.toKey}`;
    if (!latestEventByEdge.has(edgeKey)) {
      latestEventByEdge.set(edgeKey, event);
    }
  }

  const joined = activeStorySeeds
    .filter((seed) => !startedSeedIds.has(String(seed._id)))
    .map((seed) => {
      const fromKey = seed.storyFromKey!;
      const toKey = seed.storyToKey!;
      return {
        seed,
        fromKey,
        toKey,
        edgeKey: `${fromKey}\u0000${toKey}`,
        event: latestEventByEdge.get(`${fromKey}\u0000${toKey}`),
      };
    })
    .filter(
      (
        candidate,
      ): candidate is typeof candidate & { event: Doc<"momentEvents"> } =>
        candidate.event !== undefined &&
        STANDING_STORY_OUTCOMES.has(candidate.event.outcome),
    )
    .sort(
      (a, b) =>
        b.event.offeredAt - a.event.offeredAt ||
        b.event._creationTime - a.event._creationTime ||
        b.seed._creationTime - a.seed._creationTime,
    );

  const invitations: StandingStoryInvitationForScholar[] = [];
  const seenEdges = new Set<string>();
  for (const candidate of joined) {
    if (seenEdges.has(candidate.edgeKey)) continue;
    seenEdges.add(candidate.edgeKey);

    const story = (
      await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from_to", (q) =>
          q.eq("fromKey", candidate.fromKey).eq("toKey", candidate.toKey),
        )
        .collect()
    ).find(
      (edge) => edge.toKey === candidate.toKey && edge.story !== undefined,
    )?.story;
    if (!story) continue;

    const [hasApplication, artUrl] = await Promise.all([
      eligibleStoryApplication(
        ctx,
        scholarId,
        candidate.fromKey,
        candidate.toKey,
      ).then((application) => application !== null),
      storyArtUrlForNode(ctx, candidate.toKey),
    ]);
    invitations.push({
      seedId: candidate.seed._id,
      eventId: candidate.event._id,
      fromKey: candidate.fromKey,
      toKey: candidate.toKey,
      skillLabel: candidate.seed.connectionTo ?? candidate.fromKey,
      hook: story.hook,
      ...(story.teaser === undefined ? {} : { teaser: story.teaser }),
      ...(story.visualEmoji === undefined
        ? {}
        : { visualEmoji: story.visualEmoji }),
      ...(artUrl === undefined ? {} : { artUrl }),
      kindLabel: STORY_KIND_LABELS[story.kind],
      hasApplication,
      offeredAt: candidate.event.offeredAt,
    });
    if (invitations.length >= limit) break;
  }
  return invitations;
}

/**
 * The scholar-parameterized CORE of `seeds.unlockedStoriesForSelf` — the
 * scholar-home sibling of `suggestedQuestsForScholar` above.
 *
 * WHY IT EXISTS: a verified world-connection story is offered exactly once, on
 * the practice done screen, at ~one per day. That moment is easy to walk past,
 * and the moment card's terminal outcomes are permanent (a dismissed edge is
 * never re-offered). `practiceMoments.recordMomentOffered` therefore KEEPS
 * every offered story automatically as an `origin: "story"` seed; this read
 * gives those souvenirs a home the scholar actually passes through, instead of
 * leaving them to be found only by hunting the Sky.
 *
 * A card is a live story seed the scholar hasn't flown to yet (no session
 * stamped with that `seedId`), newest first, capped at
 * `UNLOCKED_STORY_SECTION_CAP`. So the section reads as "what your last few
 * days of fluency opened up": a story rotates out when three newer ones land
 * (or when the scholar starts a session from it), and re-reading one meanwhile
 * is deliberately allowed — the souvenir keeps living in the Sky either way.
 * The story copy is re-read from the edge by graph identity — the seed stores
 * the hook, but the teaser lives only on `knowledgeNodeEdges.story`, and the
 * edge stays the single source of truth for story text.
 *
 * REDACTION: scholar-facing. Only the edge's own scholar-safe story copy, the
 * two node labels, and graph keys — never provenance, sources, or the seed's
 * teacher-facing `rationale`.
 */
export async function unlockedStoriesForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<UnlockedStoryForScholar[]> {
  const active = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) =>
      q.eq("scholarId", scholarId).eq("status", "active"),
    )
    .collect();
  const candidates = active
    .filter((s) => s.origin === "story" && s.storyFromKey && s.storyToKey)
    .sort((a, b) => b._creationTime - a._creationTime);
  if (candidates.length === 0) return [];

  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  const startedSeedIds = new Set(
    sessions.filter((s) => s.seedId).map((s) => String(s.seedId)),
  );

  const out: UnlockedStoryForScholar[] = [];
  for (const s of candidates) {
    if (out.length >= UNLOCKED_STORY_SECTION_CAP) break;
    if (startedSeedIds.has(String(s._id))) continue;
    const fromKey = s.storyFromKey!;
    const toKey = s.storyToKey!;

    const edges = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_from", (q) => q.eq("fromKey", fromKey))
      .collect();
    const story = edges.find((e) => e.toKey === toKey && e.story)?.story;
    // The edge (or its story) was removed by a curator since the star was
    // minted — the souvenir stays in the Sky, but there is nothing honest to
    // show on a card, so drop it from the section.
    if (!story) continue;

    out.push({
      seedId: s._id,
      hook: story.hook,
      teaser: story.teaser ?? story.narrative,
      ...(story.visualEmoji === undefined ? {} : { visualEmoji: story.visualEmoji }),
      // `connectionTo` is where plantStorySeed records the unlocking skill's
      // label; fall back to the graph key so a card never renders blank.
      skillLabel: s.connectionTo ?? fromKey,
      topic: s.topic,
      domain: s.domain ?? "general",
      fromKey,
      toKey,
      hasApplication:
        (await eligibleStoryApplication(ctx, scholarId, fromKey, toKey)) !== null,
    });
  }
  return out;
}

/**
 * Has this scholar already completed the activity that anchors this
 * project? Anchorless projects (no activityId) are never "complete" here.
 * When the project carries an assignmentId we scope the completion lookup
 * to it, so the same activity run under two assignments tracks separately.
 *
 * Single source of truth for the "project is done, drop it from the
 * scholar's plate" rule. `scholarPlate.activeForMe` uses it to skip
 * finished projects; `units.myIndependentStudyUnits` uses it so its
 * `hasStartedSession` flag means "has an IN-PROGRESS (plate-visible)
 * project" — the two surfaces MUST agree or an IS unit can fall into a
 * gap where the plate has dropped it but the standalone card is also
 * suppressed (and the scholar loses it from the home).
 */
export async function isSessionActivityComplete(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  session: Doc<"sessions">,
): Promise<boolean> {
  const activityId = session.activityId;
  if (!activityId) return false;
  const assignmentId = session.assignmentId;
  if (assignmentId) {
    const scoped = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_assignment", (q) =>
        q.eq("scholarId", scholarId).eq("assignmentId", assignmentId),
      )
      .filter((q) => q.eq(q.field("activityId"), activityId))
      .first();
    if (scoped) return true;
  }
  const candidates = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar_activity", (q) =>
      q.eq("scholarId", scholarId).eq("activityId", activityId),
    )
    .collect();
  if (!assignmentId) {
    for (const c of candidates) {
      if (c.assignmentId !== undefined) continue;
      if (!c.sessionId) {
        const matchingAssignedSession = await ctx.db
          .query("sessions")
          .withIndex("by_user", (q) => q.eq("userId", scholarId))
          .filter((q) => q.eq(q.field("activityId"), c.activityId))
          .filter((q) => q.neq(q.field("assignmentId"), undefined))
          .first();
        if (!matchingAssignedSession) return true;
        continue;
      }
      const completedSession = await ctx.db.get(c.sessionId);
      if (completedSession?.assignmentId === undefined) return true;
    }
    return false;
  }
  return candidates.some(
    (c) => String(c.sessionId ?? "") === String(session._id),
  ) || candidates.some(
    (c) =>
      c.assignmentId === undefined &&
      !c.sessionId &&
      c.unitId &&
      String(c.unitId) === String(session.unitId ?? ""),
  );
}

/**
 * Roster with per-scholar counts, optionally narrowed to an allowed id set.
 * Enumerations default to ENROLLED scholars only; `includeProgramGuests`
 * widens to Extended Education (program-guest) scholars, whose rows carry
 * `extendedEducation: true` (enrolled rows stay byte-identical either way).
 * Returns `{ scholars, extendedEducationOmitted }` — the count of guests the
 * default hid, so tool edges can say what was omitted without re-counting.
 */
export async function readScholarRoster(
  ctx: QueryCtx,
  allowedScholarIds: ReadonlySet<Id<"users">> | null = null,
  opts: { includeProgramGuests?: boolean } = {},
) {
  const includeProgramGuests = opts.includeProgramGuests ?? false;
  let scholars: Doc<"users">[];
  if (allowedScholarIds) {
    scholars = [];
    for (const scholarId of allowedScholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (scholar?.role === ROLES.SCHOLAR) scholars.push(scholar);
    }
  } else {
    scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
  }
  // Filter BEFORE the per-scholar loop below — omitted guests must not pay
  // for sessions/observations/chronology reads they'll never appear in.
  let extendedEducationOmitted = 0;
  if (!includeProgramGuests) {
    const enrolled = scholars.filter(isEnrolledScholar);
    extendedEducationOmitted = scholars.length - enrolled.length;
    scholars = enrolled;
  }

  const result = [];
  const now = Date.now();
  for (const s of scholars) {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", s._id))
      .collect();
    const observations = await ctx.db
      .query("observations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", s._id))
      .collect();
    const chronology = await readScholarChronology(ctx, s, now);
    result.push({
      id: s._id,
      name: s.name ?? "Unknown",
      username: s.username ?? "",
      readingLevel: s.readingLevel ?? null,
      ...chronology,
      sessionCount: sessions.length,
      observationCount: observations.length,
      ...extendedEducationTag(s),
    });
  }
  return { scholars: result, extendedEducationOmitted };
}

/** Authoritative profile chronology using the scholar's institution-local day. */
export async function readScholarChronology(
  ctx: QueryCtx,
  scholar: Pick<Doc<"users">, "dateOfBirth" | "institutionId">,
  now = Date.now(),
) {
  const institution = scholar.institutionId
    ? await ctx.db.get(scholar.institutionId)
    : null;
  const currentAgeAsOf = dayKeyForTimezone(
    now,
    institution?.timeZone ?? DEFAULT_TIMEZONE,
  );
  const dateOfBirth = scholar.dateOfBirth ?? null;
  return {
    dateOfBirth,
    currentAge: ageOnDayKey(dateOfBirth, currentAgeAsOf),
    currentAgeAsOf,
  };
}

/**
 * Named scholar groups (cohorts) with each one's members resolved to
 * names. Roster-wide (every teacher shares them) — see schema.ts. Member
 * ids that no longer point at a live scholar are dropped, so the count
 * reflects real, current members (matching the picker UI's behavior).
 * Teacher/admin only at the call sites: member names are roster data.
 *
 * Member lists default to ENROLLED scholars only: Extended Education
 * (program-guest) members are dropped and counted in
 * `extendedEducationMembersOmitted` (present only when > 0).
 * `includeProgramGuests` keeps them, tagged `extendedEducation: true`.
 * `memberCount` always reflects the returned members. Every group carries
 * its designed `participation` ("enrolled_only" for legacy rows).
 *
 * `allowedScholarIds` is the caller's institution lens: out-of-lens members
 * are hidden (and flagged via `hasHiddenMembers`), and a group whose every
 * member falls outside the lens is dropped entirely so out-of-lens cohort
 * NAMES don't leak either. The lens is tenancy; participation is a display
 * default — the two filters are orthogonal.
 */
export async function readScholarGroups(
  ctx: QueryCtx,
  allowedScholarIds: ReadonlySet<Id<"users">> | null = null,
  opts: { includeProgramGuests?: boolean } = {},
) {
  const includeProgramGuests = opts.includeProgramGuests ?? false;
  const groups = await ctx.db.query("scholarGroups").collect();
  groups.sort((a, b) => a.name.localeCompare(b.name));
  type GroupMember = { id: Id<"users">; name: string; extendedEducation?: true };
  const result: Array<{
    id: Id<"scholarGroups">;
    name: string;
    emoji: string | null;
    participation: NonNullable<Doc<"scholarGroups">["participation"]>;
    memberCount: number;
    members: GroupMember[];
    hasHiddenMembers: boolean;
    extendedEducationMembersOmitted?: number;
  }> = [];
  for (const g of groups) {
    const members: GroupMember[] = [];
    // Whether any LIVE scholar member fell outside the lens. A caller seeing a
    // partial group must not be able to act on it as though it were whole —
    // e.g. granting an app to the group id would also grant it to the members
    // hidden here. Tracked as it's computed; the members loop is the only
    // place that knows. Participation-omitted members do NOT count as hidden:
    // the caller can always surface them with `includeProgramGuests`.
    let hasHiddenMembers = false;
    let extendedEducationMembersOmitted = 0;
    for (const id of g.scholarIds) {
      const u = await ctx.db.get(id);
      if (!u || u.role !== ROLES.SCHOLAR) continue;
      if (allowedScholarIds && !allowedScholarIds.has(id)) {
        hasHiddenMembers = true;
        continue;
      }
      if (!includeProgramGuests && !isEnrolledScholar(u)) {
        extendedEducationMembersOmitted++;
        continue;
      }
      members.push({
        id: u._id,
        name: u.name ?? "Unknown",
        ...extendedEducationTag(u),
      });
    }
    // A group whose every member is outside the lens is not this caller's
    // group to see at all — dropping it (rather than showing an empty one)
    // keeps out-of-lens cohort NAMES from leaking too. A group emptied only
    // by the participation default stays visible (its omitted count names
    // the opt-in), so the drop applies just when the LENS did the emptying.
    if (
      allowedScholarIds &&
      members.length === 0 &&
      extendedEducationMembersOmitted === 0
    )
      continue;
    result.push({
      id: g._id,
      name: g.name,
      emoji: g.emoji ?? null,
      participation: g.participation ?? "enrolled_only",
      memberCount: members.length,
      members,
      hasHiddenMembers,
      ...(extendedEducationMembersOmitted > 0
        ? { extendedEducationMembersOmitted }
        : {}),
    });
  }
  return result;
}

/**
 * Current (non-superseded) mastery observations grouped by domain.
 *
 * Teacher/admin get the full rows. TIER_1 callers (scholar / parent /
 * lifelong_learner) NEVER see `evidenceType === "misconception_signal"` rows:
 * misconception observations are deliberately TEACHER/ADMIN-ONLY (same
 * invariant redactScholarPractice enforces for the practice tool — see its
 * comment + review/practice §5). Enforced here at the READ, before grouping,
 * so no downstream grouping/shape change can leak a misconception to Tier-1.
 */
export async function readScholarMastery(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  role: Role | undefined | null,
) {
  const allObservations = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_current", (q) =>
      q.eq("scholarId", scholarId).eq("isSuperseded", false),
    )
    .collect();

  // Tier-1 callers never see misconception observations.
  const observations = isTeacherRole(role)
    ? allObservations
    : allObservations.filter((o) => o.evidenceType !== "misconception_signal");

  // The scan `source` label is a portfolio item's documentHeading/title, which
  // can name a STAFF-ONLY artifact (e.g. a capture_station capture is
  // familyVisibility staff_only). Mastery is Tier-1, so gate the label on the
  // SAME caller-tier check the misconception strip above uses: only
  // teacher/admin callers get the document name. Tier-1 callers (parents/
  // scholars) never receive it — and we skip the extra db.get for them.
  const includeSource = isTeacherRole(role);

  const byDomain: Record<
    string,
    {
      concept: string;
      level: number;
      evidence: string;
      // Which kind of attempt produced this evidence (session, portfolio_scan,
      // reflection, …). Additive — existing consumers ignore it.
      attemptContext: string;
      // Present ONLY on scan-anchored rows (portfolioItemId set) for
      // teacher/admin callers: the printed heading of the scanned page (falling
      // back to its title), so a reader can say "from scanned work: 'Learning
      // Print'" without a second lookup.
      source?: string;
    }[]
  > = {};
  for (const o of observations) {
    if (!byDomain[o.domain]) byDomain[o.domain] = [];
    // A scan-derived observation points at its portfolio item instead of a
    // transcript; name the document so downstream text can attribute it.
    let source: string | undefined;
    if (includeSource && o.portfolioItemId) {
      const item = await ctx.db.get(o.portfolioItemId);
      // documentHeading may be "" (extraction found no printed heading) — fall
      // back to the item's title in that case.
      if (item) source = item.documentHeading || item.title;
    }
    byDomain[o.domain].push({
      concept: o.conceptLabel,
      level: o.masteryLevel,
      evidence: o.evidenceSummary,
      attemptContext: o.attemptContext,
      ...(source ? { source } : {}),
    });
  }
  return byDomain;
}

/** Learning-signal counts by type (with high-intensity counts). */
export async function readScholarSignals(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const signals = await ctx.db
    .query("sessionSignals")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();

  const byType: Record<string, { count: number; highCount: number }> = {};
  for (const s of signals) {
    if (!byType[s.signalType]) byType[s.signalType] = { count: 0, highCount: 0 };
    byType[s.signalType].count++;
    if (s.intensity === "high") byType[s.signalType].highCount++;
  }
  return byType;
}

/** Active + pending exploration seeds. */
export async function readScholarSeeds(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const seeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
    .collect();

  return seeds
    .filter((s) => s.status === "active" || s.status === "pending")
    .map((s) => ({
      topic: s.topic,
      domain: s.domain ?? null,
      rationale: s.rationale,
      status: s.status,
    }));
}

/** Most recent 20 teacher observations. */
export async function readScholarObservations(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const observations = await ctx.db
    .query("observations")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .order("desc")
    .take(20);

  return observations.map((o) => ({
    note: o.note,
    type: o.type,
    createdAt: o._creationTime,
  }));
}

/** The scholar's dossier content (teacher-facing — never for parents). */
export async function readScholarDossier(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const dossier = await ctx.db
    .query("scholarDossiers")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .first();
  return dossier?.content ?? "No dossier data available yet.";
}

/**
 * Classify a session as teacher-ASSIGNED (cohort work) vs SELF-INITIATED
 * (a Quest / Independent Study the scholar chose). Pure — takes the
 * already-resolved unit doc so callers that already loaded it (the session
 * list, the transcript reader) don't re-query.
 *
 * The rule mirrors scholarPlate's origin buckets: a session anchored to an
 * `assignmentId` is assigned; everything else is self-initiated — whether
 * that's the scholar's own Independent Study unit (`unit.authorScholarId`),
 * a seed-spawned exploration (`seedId` / anchorless), or a teacher unit the
 * scholar opened on their own without an assignment. This is what lets the
 * bot stop calling a self-started Quest "an assigned project" — and assess
 * it on its own terms (is the scholar getting value?) instead of against an
 * assignment bar that doesn't exist.
 */
export type SessionOrigin = "assigned" | "selfInitiated";

export function classifySessionOrigin(
  session: Pick<
    Doc<"sessions">,
    "assignmentId" | "seedId" | "activityId" | "unitId"
  >,
  unit: Doc<"units"> | null,
): {
  origin: SessionOrigin;
  originLabel: string;
  isIndependentStudyUnit: boolean;
  fromSeed: boolean;
} {
  const isIndependentStudyUnit = unit?.authorScholarId != null;
  const fromSeed =
    session.seedId != null || (!session.activityId && !session.unitId);

  if (session.assignmentId != null) {
    return {
      origin: "assigned",
      originLabel: "Teacher-assigned (part of a cohort assignment)",
      isIndependentStudyUnit,
      fromSeed,
    };
  }

  let originLabel: string;
  if (isIndependentStudyUnit) {
    originLabel =
      "Self-initiated — the scholar's OWN Independent Study unit (they chose this, it was not assigned)";
  } else if (fromSeed) {
    originLabel =
      "Self-initiated — an open exploration the scholar started by following their own curiosity (not assigned)";
  } else {
    originLabel =
      "Self-initiated — the scholar opened this on their own, not through a teacher assignment";
  }
  return {
    origin: "selfInitiated",
    originLabel,
    isIndependentStudyUnit,
    fromSeed,
  };
}

/**
 * Resolve a session's curriculum context (activity → lesson → unit) the same
 * way scholarPlate does: a session may carry `unitId`/`lessonId` directly OR
 * derive them from its `activityId`. Returns the resolved docs so callers can
 * classify origin + label the context.
 */
async function resolveSessionContext(ctx: QueryCtx, session: Doc<"sessions">) {
  const activity = session.activityId
    ? await ctx.db.get(session.activityId)
    : null;
  const lesson = activity?.lessonId
    ? await ctx.db.get(activity.lessonId)
    : session.lessonId
      ? await ctx.db.get(session.lessonId)
      : null;
  const unitId = session.unitId ?? lesson?.unitId ?? null;
  const unit = unitId ? await ctx.db.get(unitId) : null;
  return { activity, lesson, unit };
}

/**
 * Assignment context for an assigned session: its display title and the
 * scheduled mode (classFocus / homework) for THIS activity. Null when the
 * session isn't assignment-anchored or the assignment/entry is gone.
 */
async function resolveAssignmentContext(
  ctx: QueryCtx,
  session: Doc<"sessions">,
  unit: Doc<"units"> | null,
): Promise<{
  assignmentTitle: string | null;
  assignmentMode: "classFocus" | "homework" | null;
}> {
  if (!session.assignmentId) {
    return { assignmentTitle: null, assignmentMode: null };
  }
  const assignment = await ctx.db.get(session.assignmentId);
  if (!assignment) {
    return { assignmentTitle: null, assignmentMode: null };
  }
  let assignmentMode: "classFocus" | "homework" | null = null;
  if (session.activityId) {
    const entry = (assignment.activitySchedule ?? []).find(
      (e) => String(e.activityId) === String(session.activityId),
    );
    assignmentMode = entry?.mode ?? null;
  }
  return {
    assignmentTitle: assignment.title ?? unit?.title ?? null,
    assignmentMode,
  };
}

/**
 * Recent non-archived projects (chat sessions) with unit/lesson context AND
 * an origin tag (assigned vs self-initiated). The origin is what stops the
 * bot from mislabeling a self-started Quest as "an assigned project".
 */
export async function readScholarSessions(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user_and_archived", (q) =>
      q.eq("userId", scholarId).eq("isArchived", false),
    )
    .order("desc")
    .take(50);

  return await Promise.all(
    sessions.map(async (p) => {
      const { activity, lesson, unit } = await resolveSessionContext(ctx, p);
      const { origin, originLabel, isIndependentStudyUnit, fromSeed } =
        classifySessionOrigin(p, unit);
      const { assignmentTitle, assignmentMode } =
        await resolveAssignmentContext(ctx, p, unit);
      return {
        id: p._id,
        title: p.title,
        createdAt: p._creationTime,
        lastMessageAt: p.lastMessageAt ?? null,
        lastMessagePreview: p.lastMessagePreview ?? null,
        unitTitle: unit?.title ?? null,
        lessonTitle: lesson?.title ?? null,
        activityTitle: activity?.title ?? null,
        origin,
        originLabel,
        isIndependentStudyUnit,
        fromSeed,
        assignmentTitle,
        assignmentMode,
      };
    }),
  );
}

/**
 * The full(er) transcript of ONE session, plus the context needed to judge
 * it: origin (assigned vs self-initiated), the activity's prompt/deliverable,
 * completion status, and any observer analysis summary. TEACHER/ADMIN ONLY —
 * raw tutor conversation is the most granular scholar data, walled off from
 * parents and scholars by the policy table (lib/scholarReadPolicy.ts).
 *
 * SCOPE GUARD: `scholarId` is the resolved (allowed) scholar; a `sessionId`
 * that doesn't belong to them reads nothing (returns null) so a foreign id
 * can't be turned into a transcript. With no `sessionId`, defaults to the
 * scholar's most recent real session (skipping test-drive / offline).
 */
export async function readSessionTranscript(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  opts: { sessionId?: Id<"sessions">; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);

  let session: Doc<"sessions"> | null = null;
  if (opts.sessionId) {
    session = await ctx.db.get(opts.sessionId);
    // Foreign / mismatched id → nothing (don't leak existence).
    if (!session || session.userId !== scholarId) return null;
  } else {
    const recent = await ctx.db
      .query("sessions")
      .withIndex("by_user_and_archived", (q) =>
        q.eq("userId", scholarId).eq("isArchived", false),
      )
      .order("desc")
      .take(10);
    session = recent.find((s) => !s.isTestDrive && !s.isOffline) ?? null;
    if (!session) return null;
  }

  const { activity, lesson, unit } = await resolveSessionContext(ctx, session);
  const { origin, originLabel, isIndependentStudyUnit, fromSeed } =
    classifySessionOrigin(session, unit);
  const { assignmentTitle, assignmentMode } = await resolveAssignmentContext(
    ctx,
    session,
    unit,
  );

  // Rubric the scholar is held to: the per-session snapshot (auto-mode
  // calibrated criteria) wins, else the activity's authored criteria.
  const criteria =
    session.deliverableCriteria ??
    activity?.deliverable?.criteria?.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description ?? null,
    })) ??
    null;

  const activityComplete = await isSessionActivityComplete(
    ctx,
    scholarId,
    session,
  );

  const analysis = await ctx.db
    .query("analyses")
    .withIndex("by_session", (q) => q.eq("sessionId", session!._id))
    .first();

  const allMessages = await ctx.db
    .query("messages")
    .withIndex("by_session", (q) => q.eq("sessionId", session!._id))
    .order("asc")
    .collect();
  const conversational = allMessages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  const totalCount = conversational.length;
  const truncated = conversational.length > limit;
  const shown = truncated ? conversational.slice(-limit) : conversational;

  return {
    sessionId: session._id,
    title: session.title,
    origin,
    originLabel,
    isIndependentStudyUnit,
    fromSeed,
    assignmentTitle,
    assignmentMode,
    unitTitle: unit?.title ?? null,
    lessonTitle: lesson?.title ?? null,
    activityTitle: activity?.title ?? null,
    // Tier-2 payload: get_session_transcript is teacher/admin ONLY
    // (scholarReadPolicy), so the TEACHER description is the right context here
    // — the aide judging a session needs the design intent.
    activityDescription: activity?.description ?? null,
    deliverablePrompt: activity?.deliverable?.prompt ?? null,
    deliverableCriteria: criteria,
    activityComplete,
    createdAt: session._creationTime,
    lastMessageAt: session.lastMessageAt ?? null,
    analysisSummary: analysis?.summary ?? session.analysisSummary ?? null,
    messageCount: totalCount,
    truncated,
    // Chronological user/assistant turns. The tutor's `role` is "assistant".
    messages: shown.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  };
}

/**
 * Recent Web Assignment sessions (e.g. an external practice site) — the scholar's
 * external-site practice captured by the web-assignment pipeline, newest
 * first. Non-sensitive learning data: course, daily XP vs goal, tasks
 * completed, the one-line recap, and webview-open duration. Screenshots are
 * omitted (this feeds agent text, not a filmstrip). See
 * convex/webActivitySessions.ts.
 *
 * Agent-facing time semantics are resolved HERE rather than delegated to the
 * model. A production aide once converted bare epoch milliseconds to the wrong
 * local day, called an overnight-stale unfinalized row "active right now", and
 * described wall-clock webview-open duration as time spent practicing.
 */
export async function readScholarWebActivity(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  limit = 10,
  now = Date.now(),
) {
  // Capture ticks arrive every 25 seconds from ExternalAppHost. Ninety seconds
  // allows three missed ticks plus network jitter; older unfinalized rows are
  // abandoned sessions, not evidence that the scholar is active right now.
  const activeFreshnessMs = 90_000;
  const futureClockSkewMs = 15_000;
  const scholar = await ctx.db.get(scholarId);
  const timeZone = await timeZoneForInstitution(ctx, scholar?.institutionId);
  const todayDayKey = dayKeyForTimezone(now, timeZone);
  const yesterdayDayKey = shiftDayKey(todayDayKey, -1);
  const localFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const sessions = await ctx.db
    .query("webActivitySessions")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .order("desc")
    .take(limit);
  return {
    currentTimeLocal: localFormatter.format(new Date(now)),
    timeZone,
    todayDayKey,
    interpretation:
      "Use dayRelation and the local timestamps for date/time claims. activeNow requires a fresh capture heartbeat; stale_unfinalized is not active. webviewOpenMinutes is only the wall-clock span that the embedded site stayed open, not proof of continuous attention or practice. Use XP, completed tasks, task summaries, or the recap as evidence of work.",
    sessions: sessions.map((s) => {
      const lastObservedAt = s.endedAt ?? s.lastHeartbeatAt ?? s.startedAt;
      const sessionDayKey = dayKeyForTimezone(s.startedAt, timeZone);
      const activeNow =
        s.endedAt == null &&
        lastObservedAt - now <= futureClockSkewMs &&
        now - lastObservedAt <= activeFreshnessMs;
      const status =
        s.endedAt != null
          ? ("ended" as const)
          : activeNow
            ? ("active" as const)
            : ("stale_unfinalized" as const);
      const dayRelation =
        sessionDayKey === todayDayKey
          ? ("today" as const)
          : sessionDayKey === yesterdayDayKey
            ? ("yesterday" as const)
            : sessionDayKey > todayDayKey
              ? ("future" as const)
              : ("earlier" as const);
      const e = s.extracted ?? null;
      const hasCapturedProgress =
        !!s.summary?.trim() ||
        typeof e?.xpToday === "number" ||
        typeof e?.percentComplete === "number" ||
        typeof e?.tasksCompletedToday === "number" ||
        (e?.taskSummaries?.length ?? 0) > 0;
      return {
        site: "External practice",
        course: e?.courseName ?? null,
        localDay: sessionDayKey,
        dayRelation,
        startedAtLocal: localFormatter.format(new Date(s.startedAt)),
        endedAtLocal:
          s.endedAt == null
            ? null
            : localFormatter.format(new Date(s.endedAt)),
        lastObservedAtLocal: localFormatter.format(new Date(lastObservedAt)),
        status,
        activeNow,
        webviewOpenMinutes: Math.max(
          0,
          Math.round((lastObservedAt - s.startedAt) / 60_000),
        ),
        hasCapturedProgress,
        xpToday: e?.xpToday ?? null,
        xpGoal: e?.xpGoal ?? null,
        goalMet:
          typeof e?.xpToday === "number" &&
          typeof e?.xpGoal === "number" &&
          e.xpGoal > 0 &&
          e.xpToday >= e.xpGoal,
        tasksCompletedToday: e?.tasksCompletedToday ?? null,
        taskSummaries: e?.taskSummaries ?? null,
        summary: s.summary ?? null,
      };
    }),
  };
}

/**
 * Uploaded source documents with AI summaries. TEACHER-FACING: the
 * summary retains assessment scores (IQ/subscales) — never expose to
 * parents or scholars (the policy table already restricts the tool).
 */
export async function readScholarDocuments(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const rows = await ctx.db
    .query("scholarDocuments")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .order("desc")
    .collect();

  return rows.map((r) => ({
    title: r.title,
    kind: r.kind,
    processingStatus: r.processingStatus,
    // Teacher-facing, so the full (score-bearing) summary + findings —
    // NOT the redacted (number-free) scholar-tutor variant. Fall back to
    // the redacted/legacy fields for documents processed before the
    // summary/redacted split.
    summary: r.summary ?? r.redactedSummary ?? null,
    keyFindings: r.keyFindings ?? [],
  }));
}

// ─── Scanned/uploaded WORK SAMPLES ("learning prints") ───────────────────

/** ~500-char preview cap for a scan's transcribed text (avoid token bloat). */
const WORK_SAMPLE_EXTRACT_PREVIEW_CHARS = 500;
/** Default number of work samples returned when the caller gives no limit. */
const WORK_SAMPLE_DEFAULT_LIMIT = 20;

type WorkSampleObservation = {
  concept: string;
  level: number;
  evidence: string;
  evidenceType: string;
  // Present only on misconception_signal rows.
  misconceptionStatus?: string;
  misconceptionNote?: string | null;
};

export type ScholarWorkSample = {
  itemId: Id<"portfolioItems">;
  title: string;
  documentHeading: string | null;
  label: string | null;
  aiCaption: string | null;
  source: Doc<"portfolioItems">["source"];
  createdAt: number;
  hasAssignment: boolean;
  assignmentTitle: string | null;
  hasActivity: boolean;
  activityTitle: string | null;
  processingStatus: Doc<"portfolioItems">["processingStatus"];
  extractedTextPreview: string | null;
  scanObservations: WorkSampleObservation[];
};

export type ScholarWorkSamplesResult = {
  items: ScholarWorkSample[];
  // True when the returned items reflect the request: either no `query` was
  // supplied, or a `query` was supplied AND matched at least one item. FALSE
  // only in the graceful-degradation case — a `query` was supplied, matched
  // ZERO items, but the scholar DOES have work, so `items` is a most-recent
  // fallback rather than a match. Consumers must not present a false value as a
  // match. (When the scholar has no work at all, `items` is empty and this is
  // false — an empty list, never a fabricated fallback.)
  queryMatched: boolean;
};

/**
 * The scholar's scanned/uploaded WORK — worksheets, drawings, photos of builds
 * ("learning prints") — newest first, each with the AI-observer evidence read
 * straight off that physical page (masteryObservations anchored via
 * portfolioItemId, non-superseded only).
 *
 * Mirrors convex/portfolio.ts `listForScholar`: the item set is the by_scholar
 * legacy rows UNION portfolioAttributions (a work sample can belong to several
 * scholars without duplicating storage), and capture-station captures are
 * excluded (they have one canonical staff home — School → Devices).
 *
 * `query` is an optional free-text filter matched case-insensitively (via
 * scholarMatch.normalizeName) as a substring over label,
 * documentHeading, title, and aiCaption. Full `extractedText` is deliberately
 * omitted; only a ~500-char `extractedTextPreview` is returned to keep the tool
 * payload small.
 *
 * GRACEFUL DEGRADATION: teachers refer to these onboarding scans by a
 * colloquial name ("learning print") that is printed NOWHERE on the page — the
 * documents only carry section headers like "I. STRENGTHS AND INTERESTS". So a
 * name-based `query` frequently matches zero items even when the scholar has
 * work sitting right there. Rather than dead-end, when a `query` matches zero
 * items but the scholar HAS work, fall back to the most-recent items and set
 * `queryMatched: false` so the caller can say so honestly. A scholar with no
 * work at all still returns an empty list (no fabrication).
 *
 * TEACHER-FACING: the scan observations carry observer analysis (including
 * misconception evidence). The role policy (scholarReadPolicy.ts) restricts the
 * backing tool to teacher/admin; no redaction is done here.
 */
export async function readScholarWorkSamples(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  opts: { query?: string; limit?: number } = {},
): Promise<ScholarWorkSamplesResult> {
  const legacyRows = await ctx.db
    .query("portfolioItems")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const attributionRows = await ctx.db
    .query("portfolioAttributions")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const itemsById = new Map(legacyRows.map((row) => [row._id, row]));
  for (const attribution of attributionRows) {
    if (itemsById.has(attribution.portfolioItemId)) continue;
    const item = await ctx.db.get(attribution.portfolioItemId);
    if (item) itemsById.set(item._id, item);
  }

  // Program captures live in School → Devices, not the general portfolio.
  const allItems = [...itemsById.values()]
    .filter((item) => item.source !== "capture_station")
    .sort((a, b) => b._creationTime - a._creationTime);

  // Optional free-text filter. Normalize BOTH sides the same way the ingestion
  // matcher normalizes names, then substring-match — rather than inventing a
  // new matcher.
  const needle = normalizeName(opts.query).join(" ");
  let selected = allItems;
  let queryMatched = true;
  if (needle) {
    const matched = allItems.filter((item) => {
      const haystack = [
        item.label,
        item.documentHeading,
        item.title,
        item.aiCaption,
      ]
        .map((field) => normalizeName(field).join(" "))
        .join("  ");
      return haystack.includes(needle);
    });
    if (matched.length > 0) {
      selected = matched;
      queryMatched = true;
    } else {
      // Zero matches. If the scholar HAS work, degrade to the most-recent items
      // and flag the miss; if they have none, `allItems` is empty and we return
      // an honest empty list (queryMatched stays false — nothing matched).
      selected = allItems;
      queryMatched = false;
    }
  }

  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.floor(opts.limit)
      : WORK_SAMPLE_DEFAULT_LIMIT;
  const limited = selected.slice(0, limit);

  const items = await Promise.all(
    limited.map(async (item) => {
      const scanObservations = (
        await ctx.db
          .query("masteryObservations")
          .withIndex("by_portfolioItem", (q) =>
            q.eq("portfolioItemId", item._id),
          )
          .collect()
      )
        .filter((o) => !o.isSuperseded)
        .map((o) => ({
          concept: o.conceptLabel,
          level: o.masteryLevel,
          evidence: o.evidenceSummary,
          evidenceType: o.evidenceType,
          ...(o.evidenceType === "misconception_signal"
            ? {
                misconceptionStatus: o.misconceptionStatus ?? "open",
                misconceptionNote: o.misconceptionNote ?? null,
              }
            : {}),
        }));

      const activity = item.activityId
        ? await ctx.db.get(item.activityId)
        : null;
      const assignment = item.assignmentId
        ? await ctx.db.get(item.assignmentId)
        : null;
      let assignmentTitle: string | null = null;
      if (assignment) {
        // A standing (practice-mode) assignment has NO unit — its own `title`
        // is the only name; a unit assignment may still carry a customized
        // title that overrides the unit's. Mirror the established fallback in
        // convex/portfolio.ts (listAssignmentsForPicker): assignment.title first,
        // then the unit title.
        const unit = assignment.unitId
          ? await ctx.db.get(assignment.unitId)
          : null;
        assignmentTitle = assignment.title ?? unit?.title ?? null;
      }

      const extractedText = item.extractedText ?? null;
      const extractedTextPreview =
        extractedText === null
          ? null
          : extractedText.length > WORK_SAMPLE_EXTRACT_PREVIEW_CHARS
            ? `${extractedText.slice(0, WORK_SAMPLE_EXTRACT_PREVIEW_CHARS)}…`
            : extractedText;

      return {
        itemId: item._id,
        title: item.title,
        documentHeading: item.documentHeading ?? null,
        label: item.label ?? null,
        aiCaption: item.aiCaption ?? null,
        source: item.source,
        createdAt: item._creationTime,
        hasAssignment: item.assignmentId != null,
        assignmentTitle,
        hasActivity: item.activityId != null,
        activityTitle: activity?.title ?? null,
        processingStatus: item.processingStatus,
        extractedTextPreview,
        scanObservations,
      };
    }),
  );

  return { items, queryMatched };
}

/**
 * Internal query wrapper for the aide tool layer.
 *
 * The other readScholar* functions are wrapped as internalQueries in
 * convex/curriculumAssistant.ts; this one is wrapped HERE (like the
 * lib/unitDesignerTools internal fns) because it was added alongside the
 * scanned-work read and its only caller is the shared tool layer. Referenced as
 * `internal.lib.scholarReads.getScholarWorkSamples`.
 */
export const getScholarWorkSamples = internalQuery({
  args: {
    scholarId: v.id("users"),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    readScholarWorkSamples(ctx, args.scholarId, {
      query: args.query,
      limit: args.limit,
    }),
});

// ─── Homegrown procedural-practice state ─────────────────────────────────

/** Open (non-addressed, non-superseded) misconception observations. */
async function loadOpenMisconceptions(ctx: QueryCtx, scholarId: Id<"users">) {
  const obs = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  return obs.filter(
    (o) =>
      o.evidenceType === "misconception_signal" &&
      !o.isSuperseded &&
      (o.misconceptionStatus === "open" || o.misconceptionStatus === undefined),
  );
}

// ── Math Check-In reads ───────────────────────────────────────────────────
//
// WHY THIS EXISTS: a check-in in flight writes `practicePlacements` rows and
// nothing else. `practiceMastery` is written only as a domain finalizes, so
// every aide read that inferred check-in state from mastery / sessions /
// assignments / web activity confidently reported a LIVE check-in as absent.
//
// WHAT IT DOES NOT DO: classify. "Is this domain mapped / in flight / shadow
// placed?" is answered exactly once in the codebase, by
// `lib/practice/domainMapStatus`, loaded here through
// `practiceSkills.loadScholarMapSummaryWithNodes` — the same derivation the serving loop
// itself runs. This module is its SECOND CONSUMER, and it adds only what that
// derivation deliberately lacks: the per-probe TRANSCRIPT (question stems,
// submitted answers, correctness) and a DAY axis, both read straight off the
// placement rows. If you ever find yourself writing `status === "complete"`
// here, you are re-opening the shadow-placement hole domainMapStatus closed.

/** One answered probe, straight from `practicePlacements.probeLog`. */
type CheckInProbeRecord = {
  domain: string;
  strand: string;
  nodeKey: string;
  itemId: string | null;
  submittedAnswer: string | null;
  /** Raw ternary outcome as logged: "correct" | "incorrect" | "unknown". */
  outcome: string;
  correct: boolean;
  at: number;
  /** Index within its own domain's probeLog (stable tiebreak on equal `at`). */
  sequence: number;
  answeredToday: boolean;
};

type CheckInDomainRecord = {
  domain: string;
  label: string;
  /** THE canonical classification — never re-derived here. `null` means the
   *  domain is not on the map at all on this deployment (no seeded nodes), so
   *  no map status honestly applies to it. */
  status: DomainMapStatus | null;
  probesAnswered: number;
  probesAnsweredToday: number;
  lastProbeAt: number | null;
  frontierByStrand: NonNullable<Doc<"practicePlacements">["frontierByStrand"]>;
  servedProbe: Doc<"practicePlacements">["servedProbe"];
};

type CheckInRecord = {
  summary: ScholarMapSummary;
  /** Node labels from the map load — never a second `knowledgeNodes` scan. */
  nodeLabels: Map<string, string>;
  domains: CheckInDomainRecord[];
  probes: CheckInProbeRecord[];
  currentProbe: {
    domain: string;
    served: NonNullable<Doc<"practicePlacements">["servedProbe"]>;
  } | null;
  probesAnsweredToday: number;
  responsesToday: { correct: number; incorrect: number; unknown: number };
  lastProbeAt: number | null;
};

/**
 * How much of the scholar's domain MAP is drawn — projected from the canonical
 * per-domain statuses and nothing else, so it cannot disagree with the map.
 *
 * Named for what it measures, deliberately. An earlier draft called this
 * `overall: not_started | in_progress | complete`, which reads as a claim about
 * a check-in SITTING — and a scholar who converged one domain through a
 * single-domain placement, having never sat a mixed check-in, would have been
 * reported as "in progress" on one. Map progress is the honest question this
 * derivation can answer; "is she answering probes right now" is the day-scoped
 * probe count, which is a different field.
 */
function mapProgressOf(
  summary: ScholarMapSummary,
): "unmapped" | "partial" | "complete" {
  if (summary.allMapped) return "complete";
  return summary.perDomain.some(
    (d) => d.status === "in_flight" || d.status === "converged",
  )
    ? "partial"
    : "unmapped";
}

/**
 * The ONE read behind both check-in presentations: the canonical map summary,
 * plus the probe transcript and day-scoped counts the summary has no axis for.
 *
 * The day boundary is the scholar's INSTITUTION-local day — a second school in
 * another timezone must not inherit the home school's midnight.
 *
 * "Today" is counted from `probeLog[].at` ONLY, never from `updatedAt`. Two
 * writers bump `updatedAt` with no scholar action behind it: `persistServed`
 * rewrites the row whenever the loop advances, and `finalizeCappedMappingRuns`
 * stamps `status: "complete"` on a sweep. Reading either as same-day activity
 * is the exact false positive this rule exists to prevent.
 *
 * NO ACCESS CONTROL — callers gate first (see the file header).
 */
async function readScholarCheckInRecord(
  ctx: QueryCtx,
  scholar: Pick<Doc<"users">, "_id" | "institutionId">,
  now: number,
): Promise<CheckInRecord> {
  const { summary, nodeLabels } = await loadScholarMapSummaryWithNodes(
    ctx,
    scholar._id,
  );
  const statusOf = new Map(summary.perDomain.map((d) => [d.domain, d.status]));

  const timeZone = await timeZoneForInstitution(ctx, scholar.institutionId);
  const today = dayKeyForTimezone(now, timeZone);
  const isToday = (at: number) => dayKeyForTimezone(at, timeZone) === today;

  const placements = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholar._id))
    .collect();
  placements.sort((a, b) => a.domain.localeCompare(b.domain));

  const probes: CheckInProbeRecord[] = [];
  const responsesToday = { correct: 0, incorrect: 0, unknown: 0 };
  const domains: CheckInDomainRecord[] = [];

  for (const placement of placements) {
    let probesAnsweredToday = 0;
    let lastProbeAt: number | null = null;
    (placement.probeLog ?? []).forEach((probe, sequence) => {
      const answeredToday = isToday(probe.at);
      if (answeredToday) {
        probesAnsweredToday++;
        if (probe.outcome === "correct") responsesToday.correct++;
        else if (probe.outcome === "incorrect") responsesToday.incorrect++;
        else responsesToday.unknown++;
      }
      lastProbeAt =
        lastProbeAt === null ? probe.at : Math.max(lastProbeAt, probe.at);
      probes.push({
        domain: placement.domain,
        strand: probe.strand,
        nodeKey: probe.nodeKey,
        itemId: probe.itemId ?? null,
        submittedAnswer: probe.answerRaw ?? null,
        outcome: probe.outcome,
        correct: probe.outcome === "correct",
        at: probe.at,
        sequence,
        answeredToday,
      });
    });

    domains.push({
      domain: placement.domain,
      label: practiceDomainLabel(placement.domain),
      // A placement row for a domain the map summary doesn't know about means
      // the domain has no seeded nodes on this deployment. Report the row's
      // probes, but NEVER invent a map status for it — every other word in this
      // field came from domainMapStatus, and a fabricated one would read
      // identically to a derived one.
      status: statusOf.get(placement.domain) ?? null,
      // From the LOG, not the stored counter — `domainMapStatus` classifies on
      // `probeLog.length`, so a legacy row whose counter disagrees with its log
      // would otherwise hand the model two different "probes answered" numbers
      // in one payload, one of which the status word contradicts.
      probesAnswered: (placement.probeLog ?? []).length,
      probesAnsweredToday,
      lastProbeAt,
      frontierByStrand: placement.frontierByStrand ?? [],
      servedProbe: placement.servedProbe,
    });
  }

  probes.sort(
    (a, b) =>
      a.at - b.at || a.domain.localeCompare(b.domain) || a.sequence - b.sequence,
  );

  // WHICH probe is actually in front of the scholar is NOT a sorting question,
  // and every sort key gets it wrong. `mixedPlacementCurrent` (practiceSkills)
  // answers it by walking the domains in registry order and taking the first
  // SERVABLE one that holds a probe — and a stale `servedProbe` left on a
  // converged or prereq-queued domain is deliberately ignored there, because
  // the next serve clears it and it must never be re-served. A reader that
  // skipped that predicate would show a teacher "she's on this question right
  // now" for a probe the app will never present.
  //
  // `summary.perDomain` is built by iterating PRACTICE_DOMAINS, so it is
  // already in the registry order the serving loop uses — walk it and apply the
  // same `domainMayServe` gate rather than re-deriving either half.
  const rowOf = new Map(domains.map((d) => [d.domain, d]));
  const held = summary.perDomain
    .filter(domainMayServe)
    .map((entry) => rowOf.get(entry.domain))
    .find((row) => row?.servedProbe !== undefined);

  return {
    summary,
    nodeLabels,
    domains,
    probes,
    currentProbe: held?.servedProbe
      ? { domain: held.domain, served: held.servedProbe }
      : null,
    // Restricted to domains the map knows about, so this matches the serving
    // loop's `sittingAnswered` exactly — a row for an unregistered domain is
    // not part of the sitting the budget is counted against.
    probesAnsweredToday: domains.reduce(
      (total, d) => total + (statusOf.has(d.domain) ? d.probesAnsweredToday : 0),
      0,
    ),
    responsesToday,
    lastProbeAt: probes.length > 0 ? probes[probes.length - 1].at : null,
  };
}

export type PracticeCheckInGlance = {
  /** How much of the MAP is drawn — see mapProgressOf. Not a sitting state. */
  mapProgress: "unmapped" | "partial" | "complete";
  /** The canonical N-of-M map counts, verbatim. */
  map: {
    mappedCount: number;
    eligibleCount: number;
    allMapped: boolean;
    gradeOnFile: boolean;
  };
  probesAnsweredToday: number;
  /** Right/wrong split for today. TIER-1 CALLERS DO NOT GET THIS — see
   *  redactScholarPractice: an aggregate score is still a score, and a check-in
   *  is a map. Teacher/admin only. */
  responsesToday: {
    correct: number;
    incorrect: number;
    unknown: number;
  } | null;
  /** Only domains the scholar actually ANSWERED a probe in today. */
  domainsToday: Array<{
    domain: string;
    label: string;
    status: DomainMapStatus | null;
    probesAnsweredToday: number;
    lastProbeAt: number;
  }>;
  /** The domain holding a probe in front of the scholar right now, if any. */
  heldProbeDomain: string | null;
  lastProbeAt: number | null;
};

/**
 * GLANCE presentation — "is this scholar's check-in moving, and how far along
 * is the map?" Rides along with practice detail so an aide answering "how is X
 * doing?" sees a live check-in before a single mastery row exists.
 *
 * MIND THE TWO CLOCKS. `probesAnsweredToday`, `responsesToday`, and
 * `domainsToday` are day-scoped, so an abandoned run from last week contributes
 * nothing to them. `mapProgress` and `heldProbeDomain` are LIFETIME facts and
 * always were — a run abandoned last week still reports `partial` with a held
 * probe. That is correct (the map really is half-drawn, and a probe really is
 * parked there), but it means "is she working right now" is answered by the
 * probe COUNTS, never by `mapProgress`.
 *
 * For the questions, answers, and per-probe outcomes, callers use
 * `readScholarMathCheckIn` — two presentations, one read.
 */
export async function readScholarPracticeCheckIn(
  ctx: QueryCtx,
  scholar: Pick<Doc<"users">, "_id" | "institutionId">,
  now = Date.now(),
): Promise<PracticeCheckInGlance> {
  const record = await readScholarCheckInRecord(ctx, scholar, now);
  const domainsToday = record.domains
    .filter((d) => d.probesAnsweredToday > 0)
    .map((d) => ({
      domain: d.domain,
      label: d.label,
      status: d.status,
      probesAnsweredToday: d.probesAnsweredToday,
      lastProbeAt: d.lastProbeAt ?? 0,
    }))
    .sort(
      (a, b) => b.lastProbeAt - a.lastProbeAt || a.label.localeCompare(b.label),
    );
  return {
    mapProgress: mapProgressOf(record.summary),
    map: {
      mappedCount: record.summary.mappedCount,
      eligibleCount: record.summary.eligibleCount,
      allMapped: record.summary.allMapped,
      gradeOnFile: record.summary.gradeOnFile,
    },
    probesAnsweredToday: record.probesAnsweredToday,
    responsesToday: record.responsesToday,
    domainsToday,
    heldProbeDomain: record.currentProbe?.domain ?? null,
    lastProbeAt: record.lastProbeAt,
  };
}

/**
 * TRANSCRIPT presentation — the authoritative deep read behind the aide's
 * `get_scholar_math_checkin`: every answered probe in order, with the question
 * reconstructed where it still can be, the submitted answer, and the outcome.
 *
 * WHAT A STEM IS WORTH. A stored (`gen#`) item's stem is the real text the
 * scholar saw. A TEMPLATE stem is REGENERATED from the item id's seed, so it is
 * faithful only while that generator is unchanged: edit a template's numbers or
 * phrasing and an old probe replays with the NEW question beside the scholar's
 * old answer. That is reported as `question: "regenerated"` rather than
 * `"available"`, so a teacher reading a stem next to a wrong-looking answer can
 * tell which of the two they are looking at. An id nothing can rebuild — a
 * deleted `gen#` row, a legacy id, a template whose skillKey no longer matches
 * the probe's node — reports `question: "unavailable", stem: null`. The aide's
 * contract forbids inventing a check-in question, and admitting the gap is the
 * only way to keep that promise.
 *
 * NO ACCESS CONTROL — callers gate first. Every shipped caller resolves the
 * scholar through the lens-scoped name chokepoint before reaching this.
 */
export async function readScholarMathCheckIn(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  now = Date.now(),
) {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) {
    throw new Error("Scholar not found");
  }
  const record = await readScholarCheckInRecord(ctx, scholar, now);

  // Labels ride along from the map load above. Re-querying `knowledgeNodes`
  // here would be an unindexed full-table scan for data that call just paid for.
  const labelFor = (nodeKey: string) => record.nodeLabels.get(nodeKey) ?? nodeKey;

  const questionFor = async (
    domain: string,
    nodeKey: string,
    itemId: string | null | undefined,
  ): Promise<{
    question: "available" | "regenerated" | "unavailable";
    stem: string | null;
  }> => {
    const unavailable = { question: "unavailable" as const, stem: null };
    if (!itemId) return unavailable;
    const nodeInfo = { label: labelFor(nodeKey), domain };
    const parsed = parseItemId(itemId);
    if (parsed) {
      // A template id whose skillKey isn't this probe's node would pair a
      // regenerated stem with the wrong node label. Refuse rather than pair.
      if (parsed.skillKey !== nodeKey) return unavailable;
      const item = buildTemplateServable(itemId, nodeInfo, domain);
      return item
        ? { question: "regenerated" as const, stem: item.prompt.stem }
        : unavailable;
    }
    if (!itemId.startsWith("gen#")) return unavailable;
    try {
      const stored = await ctx.db.get(itemId.slice(4) as Id<"practiceItems">);
      const item = stored && buildStoredServable(itemId, stored, nodeInfo, domain);
      return item
        ? { question: "available" as const, stem: item.prompt.stem }
        : unavailable;
    } catch {
      // A malformed/legacy id isn't a valid document id — report the gap.
      return unavailable;
    }
  };

  const probes = await Promise.all(
    record.probes.map(async (probe) => ({
      at: probe.at,
      domain: probe.domain,
      strand: probe.strand,
      nodeKey: probe.nodeKey,
      nodeLabel: labelFor(probe.nodeKey),
      itemId: probe.itemId,
      ...(await questionFor(probe.domain, probe.nodeKey, probe.itemId)),
      submittedAnswer: probe.submittedAnswer,
      outcome: probe.outcome,
      correct: probe.correct,
      answeredToday: probe.answeredToday,
      sequence: probe.sequence,
    })),
  );

  const currentProbe = record.currentProbe
    ? {
        domain: record.currentProbe.domain,
        strand: record.currentProbe.served.strand,
        nodeKey: record.currentProbe.served.nodeKey,
        nodeLabel: labelFor(record.currentProbe.served.nodeKey),
        itemId: record.currentProbe.served.itemId,
        ...(await questionFor(
          record.currentProbe.domain,
          record.currentProbe.served.nodeKey,
          record.currentProbe.served.itemId,
        )),
      }
    : null;

  return {
    mapProgress: mapProgressOf(record.summary),
    map: {
      mappedCount: record.summary.mappedCount,
      eligibleCount: record.summary.eligibleCount,
      allMapped: record.summary.allMapped,
      gradeOnFile: record.summary.gradeOnFile,
    },
    totals: {
      probesAnswered: record.probes.length,
      domainsStarted: record.domains.length,
      sittingAnswered: record.probesAnsweredToday,
      sittingBudget: CHECK_IN_SITTING_PROBE_BUDGET,
      // "Paused" is a budget fact, never a claim that the scholar stopped: a
      // check-in under budget simply has not been asked for its next probe yet.
      //
      // "Still has work" is `some(domainMayServe)`, exactly as the serving loop
      // computes `done` — NOT `!allMapped`. The two diverge when every
      // remaining unmapped domain is queued behind a prereq that can never
      // converge: nothing can be served, so nothing is paused.
      paused:
        record.summary.perDomain.some(domainMayServe) &&
        record.probesAnsweredToday >= CHECK_IN_SITTING_PROBE_BUDGET,
    },
    domains: record.domains.map((d) => ({
      domain: d.domain,
      label: d.label,
      status: d.status,
      probesAnswered: d.probesAnswered,
      probesAnsweredToday: d.probesAnsweredToday,
      lastProbeAt: d.lastProbeAt,
      frontierByStrand: d.frontierByStrand,
      hasCurrentProbe: d.servedProbe !== undefined,
    })),
    currentProbe,
    probes,
  };
}

/**
 * Scholar's homegrown procedural-practice state across all domains.
 *
 * Returns per-strand placement (strandPlacement), the frontier (ready-to-
 * practice skills with all prerequisites met), skills due for spaced-rep
 * review (dueForReview), skills that recently crossed the fluency threshold
 * (recentlyCrossed, last 14 days), open observer-flagged misconceptions, and
 * summary counts.
 *
 * REDACTION: `observerFlaggedMisconceptions` includes sensitive observer
 * fields (observationId, evidenceSummary, transcriptExcerpt). The TOOL layer
 * (scholarReadTools.ts for the aide stream, mcp.ts for the MCP surface) MUST
 * strip those fields for TIER_1 callers (parents/scholars) — only
 * teacher/admin may see them. No access-control is done here; the caller is
 * responsible.
 */
export async function readScholarPractice(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const now = Date.now();
  const RECENTLY_MS = 14 * 86_400_000;

  // Today's check-in glance rides along, because a check-in in flight writes
  // ONLY placement rows: without this, an aide reading practice state sees an
  // empty mastery table and reports "no math activity" mid-check-in.
  const scholar = await ctx.db.get(scholarId);
  const checkIn =
    scholar?.role === ROLES.SCHOLAR
      ? await readScholarPracticeCheckIn(ctx, scholar, now)
      : null;

  // Load all per-scholar mastery rows (across all domains in one index scan).
  const allMastery = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();

  const misconceptionRows = await loadOpenMisconceptions(ctx, scholarId);

  if (allMastery.length === 0) {
    return {
      checkIn,
      strandPlacement: [] as StrandPlacement[],
      frontier: [] as SkillItem[],
      dueForReview: [] as SkillItem[],
      recentlyCrossed: [] as RecentlyCrossedItem[],
      observerFlaggedMisconceptions: misconceptionRows.map(misconceptionToRaw),
      counts: {
        frontierCount: 0,
        dueCount: 0,
        recentlyCrossedCount: 0,
        openMisconceptionCount: misconceptionRows.length,
        totalPracticedSkills: 0,
      },
    };
  }

  const domainSet = new Set(allMastery.map((r) => r.domain));

  // Cross-domain frontier resolution (D4): a `buildsOn` edge may reference a
  // FOREIGN prerequisite (a node in another domain). The per-domain `stateOf`
  // below falls back to this global-by-key map so a foreign prereq resolves to
  // the scholar's real mastery in its own domain instead of reading as ZERO
  // (never-practiced), which would permanently lock the child skill. Built from
  // the already-loaded `allMastery` — no extra reads. Own-domain rows always
  // win (checked first), so this only ever supplies out-of-domain prereqs.
  const masteryByKey = new Map(allMastery.map((r) => [r.skillKey, r]));

  // Keyed `${domain}::${strand ?? "_"}` for grouping.
  const strandMap = new Map<string, StrandPlacement>();
  const frontierItems: SkillItem[] = [];
  const dueForReview: SkillItem[] = [];
  const recentlyCrossed: RecentlyCrossedItem[] = [];

  for (const domain of domainSet) {
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect();
    const edgeRows = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect();
    const edges: GraphEdge[] = edgeRows
      .filter((e) => e.kind === "buildsOn")
      .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));

    const masteryInDomain = new Map(
      allMastery
        .filter((r) => r.domain === domain)
        .map((r) => [r.skillKey, r]),
    );

    // P5 composite context: the scholar's self-relative latency baseline for
    // this domain, so the GREEN tally reflects retention + speed, not just
    // source. (Recent-accuracy + coverage legs deferred — see TODO.)
    const fluencyCtx = {
      now,
      latencyBaseline: latencyBaselineFromSkillMedians(
        [...masteryInDomain.values()].map((r) => r.latencyMedianMs ?? NaN),
      ),
    };

    const stateOf = (k: string): SkillState => {
      const r = masteryInDomain.get(k) ?? masteryByKey.get(k);
      return r
        ? {
            repetition: r.repetition,
            halfLifeDays: r.halfLifeDays,
            lastPracticedAt: r.lastPracticedAt,
          }
        : { repetition: 0, halfLifeDays: 0 };
    };

    const keys = nodes.map((n) => n.nodeKey);
    const frontierSet = new Set(computeFrontier(keys, edges, stateOf));

    const labelOf = new Map(nodes.map((n) => [n.nodeKey, n.label]));

    for (const k of frontierSet) {
      frontierItems.push({ nodeKey: k, label: labelOf.get(k) ?? k, domain });
    }

    for (const r of masteryInDomain.values()) {
      const state = stateOf(r.skillKey);
      if (isDue(state, now)) {
        dueForReview.push({
          nodeKey: r.skillKey,
          label: labelOf.get(r.skillKey) ?? r.skillKey,
          domain,
        });
      }
      // recentlyCrossed: became GREEN (demonstrated + retained + fast, not an
      // inferred credit) in the last 14 days.
      if (isFluent(r, fluencyCtx) && r.updatedAt >= now - RECENTLY_MS) {
        recentlyCrossed.push({
          nodeKey: r.skillKey,
          label: labelOf.get(r.skillKey) ?? r.skillKey,
          domain,
          crossedAt: r.updatedAt,
        });
      }
    }

    for (const node of nodes) {
      const strandKey = `${domain}::${node.strand ?? "_"}`;
      if (!strandMap.has(strandKey)) {
        strandMap.set(strandKey, {
          strand: node.strand ?? "",
          domain,
          fluentCount: 0,
          provisionalCount: 0,
          frontierCount: 0,
          total: 0,
        });
      }
      const entry = strandMap.get(strandKey)!;
      entry.total++;
      const r = masteryInDomain.get(node.nodeKey);
      // GREEN count is the honest fluent tally (demonstrated + retained + fast);
      // provisional (inferred, not yet demonstrated) credits are counted
      // separately. A demonstrated-but-decayed/slow skill is in neither — it's a
      // due review, surfaced above.
      if (r && isFluent(r, fluencyCtx)) entry.fluentCount++;
      else if (r && isProvisional(r)) entry.provisionalCount++;
      if (frontierSet.has(node.nodeKey)) entry.frontierCount++;
    }
  }

  return {
    checkIn,
    strandPlacement: [...strandMap.values()],
    frontier: frontierItems,
    dueForReview,
    recentlyCrossed,
    observerFlaggedMisconceptions: misconceptionRows.map(misconceptionToRaw),
    counts: {
      frontierCount: frontierItems.length,
      dueCount: dueForReview.length,
      recentlyCrossedCount: recentlyCrossed.length,
      openMisconceptionCount: misconceptionRows.length,
      totalPracticedSkills: allMastery.length,
    },
  };
}

// ── Type aliases (for readability — these are just inlined objects) ────────

type SkillItem = { nodeKey: string; label: string; domain: string };

type RecentlyCrossedItem = SkillItem & { crossedAt: number };

type StrandPlacement = {
  strand: string;
  domain: string;
  fluentCount: number;
  provisionalCount: number;
  frontierCount: number;
  total: number;
};

/** Sensitive observer fields included; the TOOL layer redacts for TIER_1. */
function misconceptionToRaw(o: Doc<"masteryObservations">) {
  return {
    label: o.conceptLabel,
    domain: o.domain,
    observedAt: o.observedAt,
    // REDACT these for parents/scholars in the tool layer — not here.
    observationId: o._id,
    evidenceSummary: o.evidenceSummary,
    transcriptExcerpt: o.transcriptExcerpt,
    misconceptionNote: o.misconceptionNote ?? null,
  };
}

/**
 * Field-level, ROLE-TIERED redaction for get_scholar_practice, applied at
 * EVERY tool surface that exposes it (aide/Slack/parent-chat via
 * scholarReadTools + the MCP surface). Centralized here so no surface can
 * drift. Three tiers:
 *
 * - Teacher/admin: the full data.
 * - Scholar (and other TIER_1 non-parents): the positive practice signal
 *   only — misconceptions derive from masteryObservations (observations),
 *   which are deliberately TEACHER/ADMIN-ONLY (review/practice §5 + the
 *   "don't widen observations to parents as a side effect" invariant), so
 *   NO misconception list and NO misconception count. Due-for-review stays:
 *   "what should I review?" is the scholar's own actionable question.
 * - Parent: the scholar tier MINUS the spaced-review backlog (`dueForReview`
 *   + `counts.dueCount`). A due backlog is scheduler internals the school
 *   manages — to a parent, "86 skills due" reads as an alarming deficit when
 *   it's routine retention scheduling (Andy, 2026-08-04: parents get
 *   monthly/quarterly trends, not day-to-day variation). The frontier and
 *   recent fluency crossings are KEPT — they're forward-looking growth
 *   signal and the fuel for at-home enrichment suggestions; the parent-aide
 *   system prompt (lib/parentAidePrompt.ts) governs presenting them at
 *   trend altitude.
 */
export function redactScholarPractice(
  practice: Awaited<ReturnType<typeof readScholarPractice>>,
  role: Role | undefined | null,
) {
  if (isTeacherRole(role)) return practice;
  const tier1 = {
    ...practice,
    // A check-in is a MAP, not a score — the same reason
    // `get_scholar_math_checkin` is kept out of TIER_1 (scholarReadPolicy).
    // "You got 4 right and 3 wrong today" is an aggregate rather than a list of
    // misses, but it is still a score, and the scholar aide would read it back
    // to the child. Map progress and how many probes they answered stay.
    checkIn: practice.checkIn
      ? { ...practice.checkIn, responsesToday: null }
      : null,
    observerFlaggedMisconceptions: [] as ReturnType<typeof misconceptionToRaw>[],
    // Keep the same counts SHAPE (uniform return type), but blank the sensitive
    // field — undefined is dropped by JSON.stringify, so a TIER_1 caller still
    // receives no misconception count.
    counts: {
      ...practice.counts,
      openMisconceptionCount: undefined as number | undefined,
    },
  };
  if (role !== ROLES.PARENT) return tier1;
  return {
    ...tier1,
    // A parent loses the check-in entirely: day-level state is school
    // operational detail, not a parent trend signal.
    checkIn: null as PracticeCheckInGlance | null,
    dueForReview: [] as SkillItem[],
    counts: { ...tier1.counts, dueCount: undefined as number | undefined },
  };
}
