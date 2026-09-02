import { v } from "convex/values";
import { internalQuery, QueryCtx } from "./_generated/server";
import {
  authedQuery,
  authedMutation,
  teacherQuery,
  teacherMutation,
} from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { Doc, Id } from "./_generated/dataModel";
import { timeZoneForScholar } from "./lib/institutionTime";
import {
  DEFAULT_TIMEZONE,
  mondayDayKeyForTimezone,
} from "../shared/institutionDay";

/**
 * Weekly goals — the learner-owned self-regulated-learning loop.
 *
 * A small, visible weekly commitment ("what am I trying to become able to
 * do?") that the SCHOLAR sets or a teacher suggests. Zimmerman's forethought
 * → performance → reflection: `strategy` is the kid's named approach
 * (forethought); the end-of-week `met`/`not_yet` + `reflection` is their own
 * self-report (reflection). Governed authorship — scholar/teacher-authored
 * (never model), schema'd + reviewable, deterministically injected into the
 * tutor prompt (buildWeeklyGoalsSection in sessionHelpers). Outcomes are
 * self-reported + teacher-annotatable, NEVER auto-graded, NEVER comparative.
 *
 * DISTINCT from `scholarGoals` (the long-term, year-spanning goals primitive):
 * this is the WEEKLY cadence keyed to a Monday. See DRAFT-NOTES.md.
 *
 * Status flow: the scholar sets their own goal → `active` IMMEDIATELY. They own
 * it end-to-end — there is NO teacher approval gate (curator, not per-item gate,
 * per the product philosophy). A teacher can `suggest` a goal → `proposed`, which
 * the scholar `accept`s → `active` (agency: a suggestion needs the scholar's yes).
 * Week ends → the scholar `setOutcome` marks `met`/`not_yet` + optional
 * reflection. A teacher can `archive` (veto / close) any goal after the fact and
 * `annotate` (edit / note) it — visibility + veto — but their inaction never
 * blocks the scholar. Only `active` goals for the current week feed the tutor.
 */

const MAX_GOALS_PER_WEEK = 3;
const MAX_TEXT_LEN = 280;
const MAX_STRATEGY_LEN = 280;
const MAX_REFLECTION_LEN = 500;
const MAX_NOTE_LEN = 500;

// ── Institution-local week math ────────────────────────────────────────

/**
 * ISO date (YYYY-MM-DD) of the Monday that anchors `now`'s institution-local
 * week. `weekOffset` steps whole calendar weeks (−1 = last week).
 */
export function mondayWeekOf(
  now: number,
  weekOffset = 0,
  timeZone = DEFAULT_TIMEZONE,
): string {
  return mondayDayKeyForTimezone(now, weekOffset, timeZone);
}

// ── Scholar-facing (own goals) ────────────────────────────────────────

/**
 * The scholar's own goals for this week + last week (the SRL surface). Private
 * to the scholar (own-data authedQuery). Returns the two week anchors so the UI
 * can label without recomputing the Monday.
 */
export const myGoals = authedQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const scholarId = ctx.user._id;
    const timeZone = await timeZoneForScholar(ctx, scholarId);
    const thisWeek = mondayWeekOf(now, 0, timeZone);
    const lastWeek = mondayWeekOf(now, -1, timeZone);

    const [currentRaw, previousRaw] = await Promise.all([
      goalsForWeek(ctx, scholarId, thisWeek),
      goalsForWeek(ctx, scholarId, lastWeek),
    ]);

    // Enrich ACTIVE goals with any demonstrated practice movement that matches
    // the goal's subject — a gentle "look at this" moment on the card. Non-active
    // and last-week goals carry movement: null (uniform shape for the client).
    const current = await Promise.all(
      currentRaw.map(async (g) => ({
        ...g,
        movement: await movementForActiveGoal(ctx, g),
      })),
    );
    const previous = previousRaw.map((g) => ({
      ...g,
      movement: null as GoalMovement | null,
    }));

    return {
      thisWeekOf: thisWeek,
      lastWeekOf: lastWeek,
      current,
      lastWeek: previous,
    };
  },
});

/**
 * Scholar sets their own goal for this week → `active` IMMEDIATELY. The scholar
 * owns this end-to-end: no teacher approval gate, so it feeds the tutor and can
 * be marked done the moment it's set. Cap: MAX_GOALS_PER_WEEK non-archived goals
 * per scholar per week.
 */
export const create = authedMutation({
  args: {
    text: v.string(),
    strategy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholarId = ctx.user._id;
    const text = args.text.trim();
    if (!text) throw new Error("A goal needs some words");
    if (text.length > MAX_TEXT_LEN)
      throw new Error("That goal is a bit long — try to keep it short");
    const strategy = args.strategy?.trim() || undefined;
    if (strategy && strategy.length > MAX_STRATEGY_LEN)
      throw new Error("That plan is a bit long — try to keep it short");

    const timeZone = await timeZoneForScholar(ctx, scholarId);
    const weekOf = mondayWeekOf(Date.now(), 0, timeZone);
    await assertUnderWeeklyCap(ctx, scholarId, weekOf);

    const now = Date.now();
    const id = await ctx.db.insert("weeklyGoals", {
      scholarId,
      text,
      strategy,
      weekOf,
      status: "active",
      source: "scholar",
      createdAt: now,
      activatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

/**
 * Scholar accepts a TEACHER-SUGGESTED goal → `active`. Owner-only, and only for
 * `source: "teacher"` proposals awaiting the scholar's yes. A scholar's OWN goal
 * is already `active` the moment it's set (nothing to accept), so this is purely
 * the learner-agency half: a teacher suggestion doesn't feed the tutor until the
 * scholar takes it on.
 */
export const accept = authedMutation({
  args: { goalId: v.id("weeklyGoals") },
  handler: async (ctx, args) => {
    const goal = await requireOwnGoal(ctx, args.goalId);
    if (goal.status !== "proposed")
      throw new Error("Only a proposed goal can be accepted");
    if (goal.source !== "teacher")
      throw new Error("Your own goals are already active — nothing to accept");
    await ctx.db.patch(args.goalId, {
      status: "active",
      activatedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.get(args.goalId);
  },
});

/**
 * Scholar marks their own goal met / not_yet at week's end, with an optional
 * one-line reflection. Owner-only. A "not_yet" is DATA, never shame — outcomes
 * are the kid's own judgment, never auto-graded.
 */
export const setOutcome = authedMutation({
  args: {
    goalId: v.id("weeklyGoals"),
    outcome: v.union(v.literal("met"), v.literal("not_yet")),
    reflection: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const goal = await requireOwnGoal(ctx, args.goalId);
    if (goal.status === "proposed" || goal.status === "archived")
      throw new Error("This goal isn't active yet");
    const reflection = args.reflection?.trim() || undefined;
    if (reflection && reflection.length > MAX_REFLECTION_LEN)
      throw new Error("That reflection is a bit long");
    await ctx.db.patch(args.goalId, {
      status: args.outcome,
      reflection,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(args.goalId);
  },
});

// ── Teacher-facing (visibility + veto) ────────────────────────────────

/**
 * All of one scholar's recent weekly goals, newest week first — the teacher's
 * visibility surface. Teacher-only + institution-scoped. The teacher sees every
 * goal but does NOT gate it: a scholar-set goal is already live. Analysis stays
 * teacher-facing.
 */
export const listForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("weeklyGoals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    // Newest week first, then newest within a week.
    rows.sort((a, b) =>
      a.weekOf === b.weekOf
        ? b.createdAt - a.createdAt
        : b.weekOf.localeCompare(a.weekOf),
    );
    return rows;
  },
});

/**
 * Teacher suggests a goal FOR a scholar → `proposed` (source teacher). The
 * scholar accepts it → active (agency). Cap applies to the target week.
 */
export const suggest = teacherMutation({
  args: {
    scholarId: v.id("users"),
    text: v.string(),
    strategy: v.optional(v.string()),
    teacherNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const text = args.text.trim();
    if (!text) throw new Error("A goal needs some words");
    if (text.length > MAX_TEXT_LEN) throw new Error("That goal is a bit long");
    const strategy = args.strategy?.trim() || undefined;
    const teacherNote = args.teacherNote?.trim() || undefined;
    if (teacherNote && teacherNote.length > MAX_NOTE_LEN)
      throw new Error("That note is a bit long");

    const timeZone = await timeZoneForScholar(ctx, args.scholarId);
    const weekOf = mondayWeekOf(Date.now(), 0, timeZone);
    await assertUnderWeeklyCap(ctx, args.scholarId, weekOf);

    const now = Date.now();
    const id = await ctx.db.insert("weeklyGoals", {
      scholarId: args.scholarId,
      text,
      strategy,
      weekOf,
      status: "proposed",
      source: "teacher",
      teacherNote,
      createdAt: now,
    });
    return await ctx.db.get(id);
  },
});

/** Teacher edits a goal's text and/or adds a private note (teacher-only). */
export const annotate = teacherMutation({
  args: {
    goalId: v.id("weeklyGoals"),
    text: v.optional(v.string()),
    strategy: v.optional(v.string()),
    teacherNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTeacherGoal(ctx, args.goalId);
    const patch: Partial<Doc<"weeklyGoals">> = {};
    if (args.text !== undefined) {
      const t = args.text.trim();
      if (!t) throw new Error("A goal needs some words");
      if (t.length > MAX_TEXT_LEN) throw new Error("That goal is a bit long");
      patch.text = t;
    }
    if (args.strategy !== undefined)
      patch.strategy = args.strategy.trim() || undefined;
    if (args.teacherNote !== undefined) {
      const n = args.teacherNote.trim();
      if (n.length > MAX_NOTE_LEN) throw new Error("That note is a bit long");
      patch.teacherNote = n || undefined;
    }
    patch.updatedAt = Date.now();
    await ctx.db.patch(args.goalId, patch);
    return await ctx.db.get(args.goalId);
  },
});

/**
 * Teacher archives a goal — the after-the-fact veto / close. Drops it from the
 * scholar's week + the tutor. The scholar side degrades gracefully: an archived
 * goal simply leaves their card (no error, nothing punitive). This is the
 * teacher's override, used sparingly — their inaction never blocks the scholar.
 */
export const archive = teacherMutation({
  args: { goalId: v.id("weeklyGoals") },
  handler: async (ctx, args) => {
    await requireTeacherGoal(ctx, args.goalId);
    await ctx.db.patch(args.goalId, {
      status: "archived",
      updatedAt: Date.now(),
    });
    return await ctx.db.get(args.goalId);
  },
});

// ── Internal (tutor prompt) ───────────────────────────────────────────

/**
 * The scholar's ACTIVE goals for the current week, for the deterministic tutor
 * prompt section. Read by getSessionContext. Returns just kid-safe text.
 */
export const activeForPrompt = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const timeZone = await timeZoneForScholar(ctx, args.scholarId);
    const weekOf = mondayWeekOf(Date.now(), 0, timeZone);
    const rows = await ctx.db
      .query("weeklyGoals")
      .withIndex("by_scholar_week", (q) =>
        q.eq("scholarId", args.scholarId).eq("weekOf", weekOf),
      )
      .collect();
    return rows
      .filter((g) => g.status === "active")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((g) => ({ text: g.text, strategy: g.strategy }));
  },
});

// ── Helpers ───────────────────────────────────────────────────────────

async function goalsForWeek(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  weekOf: string,
): Promise<Doc<"weeklyGoals">[]> {
  const rows = await ctx.db
    .query("weeklyGoals")
    .withIndex("by_scholar_week", (q) =>
      q.eq("scholarId", scholarId).eq("weekOf", weekOf),
    )
    .collect();
  return rows
    .filter((g) => g.status !== "archived")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Throw if the scholar already has MAX_GOALS_PER_WEEK non-archived goals. */
async function assertUnderWeeklyCap(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  weekOf: string,
): Promise<void> {
  const rows = await ctx.db
    .query("weeklyGoals")
    .withIndex("by_scholar_week", (q) =>
      q.eq("scholarId", scholarId).eq("weekOf", weekOf),
    )
    .collect();
  const active = rows.filter((g) => g.status !== "archived");
  if (active.length >= MAX_GOALS_PER_WEEK)
    throw new Error(
      `You can have up to ${MAX_GOALS_PER_WEEK} goals in a week — finish or archive one first`,
    );
}

/** Load a goal that MUST belong to the calling scholar. */
async function requireOwnGoal(
  ctx: { db: QueryCtx["db"]; user: Doc<"users"> },
  goalId: Id<"weeklyGoals">,
): Promise<Doc<"weeklyGoals">> {
  const goal = await ctx.db.get(goalId);
  if (!goal) throw new Error("Goal not found");
  if (goal.scholarId !== ctx.user._id) throw new Error("Forbidden");
  return goal;
}

/** Load a goal for a teacher op, enforcing the institution boundary. */
async function requireTeacherGoal(
  ctx: QueryCtx & { user: Doc<"users"> },
  goalId: Id<"weeklyGoals">,
): Promise<Doc<"weeklyGoals">> {
  const goal = await ctx.db.get(goalId);
  if (!goal) throw new Error("Goal not found");
  await requireActiveScholarAccess(ctx, ctx.user, goal.scholarId);
  return goal;
}

// ── Practice-movement "look at this" moment ───────────────────────────

export type GoalMovement = { skills: string[] };

// Generic goal-verb / filler words that carry no subject signal — dropped
// before matching so "get better at big division" reduces to ["division"].
const GOAL_STOPWORDS = new Set([
  "get",
  "getting",
  "better",
  "best",
  "good",
  "great",
  "more",
  "want",
  "wanna",
  "gonna",
  "going",
  "keep",
  "learn",
  "learning",
  "practice",
  "practise",
  "practicing",
  "improve",
  "improving",
  "understand",
  "understanding",
  "master",
  "mastering",
  "this",
  "that",
  "them",
  "with",
  "work",
  "working",
  "harder",
  "faster",
  "some",
  "doing",
  "make",
  "being",
  "trying",
  "will",
  "able",
  "myself",
  "really",
  "very",
]);

/**
 * Meaningful subject tokens from a free-text goal: lowercase words ≥4 chars
 * that aren't generic goal-verbs/filler. Exported for unit testing.
 */
export function goalKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (GOAL_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** True when any goal keyword overlaps a word in the skill's label/domain. */
function goalMatchesSkill(keywords: string[], haystack: string): boolean {
  const words = haystack.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return keywords.some((k) =>
    words.some(
      (w) => w === k || (k.length >= 4 && (w.includes(k) || k.includes(w))),
    ),
  );
}

/**
 * Demonstrated practice movement that matches an ACTIVE goal's subject — the
 * gentle "look at this" moment on the goal card. Returns null unless the goal
 * is active AND a skill whose label/domain overlaps the goal text moved
 * (became fluent, or its frontier advanced) since the goal activated.
 *
 * REDACTION (scholar-facing read): touches ONLY practiceMastery's non-sensitive
 * fields (skillKey, domain, source, becameFluentAt/frontierAdvancedAt) and
 * knowledgeNodes labels — never error events, misconceptions, mastery levels,
 * or FIRe implicit-credit fields. Same boundary as dailyRecap.forScholar.
 */
async function movementForActiveGoal(
  ctx: QueryCtx,
  goal: Doc<"weeklyGoals">,
): Promise<GoalMovement | null> {
  if (goal.status !== "active") return null;
  const keywords = goalKeywords(goal.text);
  if (keywords.length === 0) return null;

  const windowStart = goal.activatedAt ?? goal.createdAt;
  const mastery = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", goal.scholarId))
    .collect();
  const moved = mastery.filter(
    (r) =>
      ((r.becameFluentAt ?? 0) >= windowStart && r.source === "practice") ||
      (r.frontierAdvancedAt ?? 0) >= windowStart,
  );
  if (moved.length === 0) return null;

  const nodes = await Promise.all(
    moved.map((r) =>
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", r.skillKey))
        .first(),
    ),
  );

  const skills: string[] = [];
  const seen = new Set<string>();
  moved.forEach((r, i) => {
    const node = nodes[i];
    const label = node?.label ?? "";
    if (!label || seen.has(label)) return;
    const haystack = `${label} ${r.domain} ${node?.strand ?? ""}`;
    if (goalMatchesSkill(keywords, haystack)) {
      seen.add(label);
      skills.push(label);
    }
  });
  if (skills.length === 0) return null;
  return { skills: skills.slice(0, 3) };
}
