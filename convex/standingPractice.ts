/**
 * Standing (open-ended) practice assignments — Mode B from
 * review/practice/practice-engine-roadmap.html §10 ("Teacher scheduling").
 *
 * A standing assignment is an `assignments` row with `practiceMode:
 * "standing"` and NO `unitId` — it isn't tied to a unit at all. Instead it
 * follows each scholar's own DAG frontier via the existing homegrown
 * practice engine (practiceSkills.needsPlacement / nextForScholar /
 * practiceSession / submitAnswer), scoped by `practiceConfig` (domain,
 * dailyGoalMinutes, pinnedStrands, excludedStrands).
 *
 * Deliberately reuses the `assignments` table for cohort membership +
 * ownership (no new table) — this file is the standing-specific slice on
 * top of it. Generic assignment operations that don't care about
 * practiceMode (archive, unarchive, setScholars, addScholars) already live
 * in convex/assignments.ts and work unmodified for a standing row; call
 * those directly rather than duplicating them here.
 *
 * Auth mirrors the practice engine's own convention (practiceSkills.ts /
 * cohortPractice.ts): teacherQuery/teacherMutation for teacher-only
 * surfaces, authedQuery + requireTeacherOrSelf for the scholar-facing read
 * (so a scholar can read their own standing assignment, and a teacher can
 * read any of theirs for a "view as" / rehearsal screen).
 *
 * Strand controls: a single-domain `pinnedStrands[0]` is threaded to
 * practiceSession as a domain-qualified `choiceHint` (weight the strand up),
 * and `excludedStrands` is now
 * ENFORCED end-to-end — it's threaded from this config into
 * practiceSkills.practiceSession / nextForScholar → the scheduler's
 * `nextPractice`, which drops excluded strands from both due reviews and new
 * frontier work, so a scholar is never served an item from an excluded strand.
 */

import { v } from "convex/values";
import { teacherMutation, teacherQuery, authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "./seed/wholeNumberArithmeticGraph";
import { PRACTICE_DOMAINS } from "./lib/practice/domains";
import { gradeRank } from "../shared/gradeRange";
import type { Doc, Id } from "./_generated/dataModel";

// Search is a live teacher query. Keep its indexed catalog window independent
// of the caller's result limit so a broad query cannot read an unbounded domain.
// The drift test covers every registered graph so growth cannot silently move a
// real skill past this window.
export const SEARCH_CANDIDATES_PER_DOMAIN = 128;

function targetsScholar(a: Doc<"assignments">, scholarId: Id<"users">): boolean {
  return a.scholarIds.some((id) => id === scholarId);
}

function shapeConfig(a: Doc<"assignments">) {
  const cfg = a.practiceConfig;
  const primary = cfg?.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
  // Normalized domain SET: the pinned `domains` (deduped) when a mixed playlist,
  // else the single primary domain. Every reader gets a clean array; the
  // single-string `domain` stays = domains[0] for back-compat.
  const domains =
    cfg?.domains && cfg.domains.length > 0
      ? Array.from(new Set(cfg.domains))
      : [primary];
  return {
    domain: domains[0] ?? primary,
    domains,
    dailyGoalMinutes: cfg?.dailyGoalMinutes ?? null,
    pinnedStrands: cfg?.pinnedStrands ?? [],
    excludedStrands: cfg?.excludedStrands ?? [],
  };
}

/** Normalize a create/update payload's domain(s) into a deduped set (primary
 *  first). A `domains` array wins; else the single `domain`; else the default. */
function normalizeDomainSet(input: {
  domain?: string;
  domains?: string[];
}): string[] {
  if (input.domains && input.domains.length > 0) {
    return Array.from(new Set(input.domains));
  }
  return [input.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN];
}

// ─── Teacher: create ───────────────────────────────────────────────────

/**
 * Create a standing-practice assignment for a cohort — "15 min of math
 * daily", not tied to a unit. Reuses the assignments row: teacherId +
 * scholarIds give it the same ownership/roster/Slack-fanout wiring every
 * other assignment gets, with practiceMode "standing" and no unitId.
 */
export const create = teacherMutation({
  args: {
    scholarIds: v.array(v.id("users")),
    title: v.optional(v.string()),
    domain: v.optional(v.string()),
    // A MIXED-domain playlist: pin a set of domains to blend. When length ≥2 the
    // engine runs the mixed-domain merge; length ≤1 behaves exactly like `domain`.
    domains: v.optional(v.array(v.string())),
    dailyGoalMinutes: v.optional(v.number()),
    pinnedStrands: v.optional(v.array(v.string())),
    excludedStrands: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const teacherId = ctx.user._id;
    const roster = Array.from(new Set(args.scholarIds));
    if (roster.length === 0) throw new Error("Pick at least one scholar.");
    const set = normalizeDomainSet(args);
    // Strands are a SINGLE-DOMAIN notion (they name a strand within one graph).
    // A blended playlist spans several domains, so a single domain's pinned/
    // excluded strands are meaningless there and would leak into every blended
    // domain — drop them whenever this is a blend. See updateConfig for the
    // same guard.
    const isBlend = set.length > 1;
    return await ctx.db.insert("assignments", {
      teacherId,
      scholarIds: roster,
      title: args.title?.trim() || undefined,
      practiceMode: "standing",
      practiceConfig: {
        domain: set[0],
        // Persist `domains` only when it's actually a mixed set — a single-domain
        // assignment stays shaped exactly as before.
        domains: isBlend ? set : undefined,
        dailyGoalMinutes: args.dailyGoalMinutes,
        pinnedStrands: isBlend ? undefined : args.pinnedStrands,
        excludedStrands: isBlend ? undefined : args.excludedStrands,
      },
      startedAt: Date.now(),
      // Standing assignments never populate activitySchedule — they have
      // no unit-scoped activities to push. This is the invariant every
      // unitId-widen read site in assignments.ts relies on.
      activitySchedule: [],
    });
  },
});

/** Update a standing assignment's config (domain(s) / daily goal / strands). */
export const updateConfig = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    title: v.optional(v.string()),
    domain: v.optional(v.string()),
    domains: v.optional(v.array(v.string())),
    dailyGoalMinutes: v.optional(v.number()),
    pinnedStrands: v.optional(v.array(v.string())),
    excludedStrands: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.assignmentId);
    if (!a || a.teacherId !== ctx.user._id || a.practiceMode !== "standing") {
      throw new Error("Standing assignment not found (or it isn't yours).");
    }
    const current = shapeConfig(a);
    // Recompute the set only when the caller sent a domain/domains; otherwise
    // keep the existing set untouched.
    const set =
      args.domains !== undefined || args.domain !== undefined
        ? normalizeDomainSet(args)
        : current.domains;
    // Strands are a SINGLE-DOMAIN notion — a blend spans several domains, so one
    // domain's pinned/excluded strands would leak into (and wrongly filter) every
    // blended domain. When the resulting config is a blend, drop strands entirely;
    // this also clears any strands left over from before the assignment was
    // switched into a blend. A genuine single-domain config keeps them as before.
    const isBlend = set.length > 1;
    await ctx.db.patch(args.assignmentId, {
      title: args.title !== undefined ? args.title.trim() || undefined : a.title,
      practiceConfig: {
        domain: set[0],
        domains: isBlend ? set : undefined,
        dailyGoalMinutes: args.dailyGoalMinutes ?? current.dailyGoalMinutes ?? undefined,
        pinnedStrands: isBlend ? undefined : (args.pinnedStrands ?? current.pinnedStrands),
        excludedStrands: isBlend ? undefined : (args.excludedStrands ?? current.excludedStrands),
      },
    });
  },
});

// ─── Teacher: reads ─────────────────────────────────────────────────────

/** The registered practice domains that actually have seeded nodes in THIS
 *  deployment — the option set for the teacher domain picker (StandingPractice
 *  dialog, math-map view, cohort frontier). Non-sensitive (labels only), so it's
 *  an authedQuery: any signed-in surface can offer the picker. A domain from the
 *  registry with no seeded nodes (e.g. a graph not yet rebuilt on this
 *  deployment) is filtered out so the picker never offers an empty domain. */
export const listDomains = authedQuery({
  args: {},
  handler: async (ctx) => {
    const seeded: typeof PRACTICE_DOMAINS = [];
    for (const info of PRACTICE_DOMAINS) {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", info.domain))
        .first();
      if (node) seeded.push(info);
    }
    return seeded;
  },
});

/**
 * Label search across the registered procedural graphs. Reads each domain
 * through `knowledgeNodes.by_domain`, with a fixed candidate window per domain,
 * then applies the existing case-insensitive substring predicate in memory.
 * The registered-domain queries keep non-practice atlas/standards nodes out of
 * scheduling pickers, while the window bounds live-search reads at
 * `PRACTICE_DOMAINS.length * SEARCH_CANDIDATES_PER_DOMAIN` rows.
 */
export const searchSkills = teacherQuery({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { query, limit }) => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const take = Math.max(1, Math.min(Math.floor(limit ?? 12), 30));
    const matches: Array<{
      nodeKey: string;
      label: string;
      domain: string;
      domainLabel: string;
    }> = [];
    for (const info of PRACTICE_DOMAINS) {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", info.domain))
        .take(SEARCH_CANDIDATES_PER_DOMAIN);
      for (const node of nodes) {
        if (!node.label.toLowerCase().includes(needle)) continue;
        matches.push({
          nodeKey: node.nodeKey,
          label: node.label,
          domain: node.domain,
          domainLabel: info.label,
        });
      }
    }
    return matches
      .sort((a, b) => a.label.localeCompare(b.label) || a.nodeKey.localeCompare(b.nodeKey))
      .slice(0, take);
  },
});

/** The distinct strands present in a practice domain, in display order — the
 *  option set for a standing assignment's pinned/excluded strand pickers.
 *  Defaults to the whole-number-arithmetic domain. */
export const domainStrands = teacherQuery({
  args: { domain: v.optional(v.string()) },
  handler: async (ctx, { domain }) => {
    const d = domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", d))
      .collect();
    // First `order` seen per strand → stable, curriculum-ordered strand list.
    const firstOrder = new Map<string, number>();
    for (const n of nodes) {
      const strand = n.strand;
      if (!strand) continue;
      const prev = firstOrder.get(strand);
      const ord = n.order ?? Number.MAX_SAFE_INTEGER;
      if (prev === undefined || ord < prev) firstOrder.set(strand, ord);
    }
    return { domain: d, strands: [...firstOrder.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s) };
  },
});

/** Distinct-strand count per seeded domain — the "N strands" meta the domain
 *  rail shows under each domain name. Mirrors `listDomains`' seeded-domain set
 *  so the rail can annotate exactly the domains it lists. Teacher-only; the rail
 *  is a teacher surface. */
export const domainStrandCounts = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const counts: Record<string, number> = {};
    for (const info of PRACTICE_DOMAINS) {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", info.domain))
        .collect();
      if (nodes.length === 0) continue;
      const strands = new Set<string>();
      for (const n of nodes) if (n.strand) strands.add(n.strand);
      counts[info.domain] = strands.size;
    }
    return counts;
  },
});

/** Grade span (min/max rank) per seeded domain — the "Grade K–6" half of the
 *  domain rail's meta line, derived from the grade hints on the domain's skill
 *  nodes. Ranks are `shared/gradeRange` ranks (K → 0); a domain with no known
 *  grade on any node is omitted. Separate from `domainStrandCounts` so that
 *  query's "N strands" contract stays a plain count. Teacher-only. */
export const domainGradeRanges = teacherQuery({
  args: {},
  handler: async (ctx) => {
    const ranges: Record<string, { min: number; max: number }> = {};
    for (const info of PRACTICE_DOMAINS) {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", info.domain))
        .collect();
      let min: number | null = null;
      let max: number | null = null;
      for (const n of nodes) {
        const rank = gradeRank(n.grade);
        if (rank === null) continue;
        if (min === null || rank < min) min = rank;
        if (max === null || rank > max) max = rank;
      }
      if (min !== null && max !== null) ranges[info.domain] = { min, max };
    }
    return ranges;
  },
});

/** List the teacher's standing-practice assignments (mirrors
 *  assignments.listForTeacher's shape, filtered to practiceMode
 *  "standing" — the unit-mode list intentionally excludes these). */
export const listForTeacher = teacherQuery({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
      .collect();
    const standing = rows.filter((r) => r.practiceMode === "standing");
    const active = includeArchived ? standing : standing.filter((r) => !r.archivedAt);
    active.sort((a, b) => b.startedAt - a.startedAt);
    return Promise.all(
      active.map(async (a) => {
        const facepileLimit = 5;
        const facepile = await Promise.all(
          a.scholarIds.slice(0, facepileLimit).map(async (sid) => {
            const u = await ctx.db.get(sid);
            return {
              _id: sid,
              name: u?.name ?? u?.username ?? null,
              image: u?.image ?? null,
              username: u?.username ?? null,
            };
          }),
        );
        return {
          _id: a._id,
          title: a.title ?? null,
          ...shapeConfig(a),
          scholarCount: a.scholarIds.length,
          scholarIds: a.scholarIds,
          startedAt: a.startedAt,
          archivedAt: a.archivedAt ?? null,
          facepile,
        };
      }),
    );
  },
});

/** Full read of one standing assignment — roster + config. Drives a
 *  teacher panel (e.g. CohortFrontier) for that cohort. */
export const get = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || a.teacherId !== ctx.user._id || a.practiceMode !== "standing") {
      return null;
    }
    const scholars = await Promise.all(
      a.scholarIds.map(async (sid) => {
        const u = await ctx.db.get(sid);
        return {
          id: sid,
          name: u?.name ?? u?.username ?? "Unknown",
          username: u?.username ?? null,
        };
      }),
    );
    return {
      _id: a._id,
      title: a.title ?? null,
      ...shapeConfig(a),
      scholars,
      startedAt: a.startedAt,
      archivedAt: a.archivedAt ?? null,
    };
  },
});

// ─── Scholar-facing discovery ───────────────────────────────────────────

/**
 * The active standing assignment that targets a scholar (or null). Drives
 * the scholar Practice tile: which domain to run placement/practice in,
 * plus the daily-goal/pinned-strand framing. `scholarId` defaults to the
 * caller (self-serve); a teacher may pass another scholarId for a "view
 * as" / rehearsal screen — same requireTeacherOrSelf gate practiceSkills.ts
 * uses throughout.
 */
export const myActiveStanding = authedQuery({
  args: { scholarId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId ?? ctx.user._id;
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    // No index for "assignments targeting scholar X" (same scan pattern as
    // assignments.currentClassFocusForMe / homeworkForMe).
    const rows = await ctx.db.query("assignments").collect();
    const match = rows.find(
      (a) =>
        !a.archivedAt &&
        a.practiceMode === "standing" &&
        targetsScholar(a, scholarId),
    );
    if (!match) return null;
    return {
      assignmentId: match._id,
      title: match.title ?? null,
      ...shapeConfig(match),
    };
  },
});
