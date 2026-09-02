import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedQuery, teacherQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { deriveGranuleStatuses, statusFromEvidence, unitGranules } from "./lib/granules";
import type { GranuleStatus } from "./lib/granules";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Granule evidence — observer attributions of conversations to the
 * unit's EQs/EUs. See the table comment in schema.ts for the model
 * (derived green/yellow/gray status, no overrides). Writes come only
 * from the observer (convex/observer.ts); reads power the Run page
 * coverage grid and the tutor's steering section (the latter reads
 * the table directly inside sessionHelpers.getSessionContext).
 */

export const record = internalMutation({
  args: {
    scholarId: v.id("users"),
    unitId: v.id("units"),
    granuleKey: v.string(),
    assignmentId: v.optional(v.id("assignments")),
    sessionId: v.id("sessions"),
    outcome: v.union(v.literal("demonstrated"), v.literal("probed")),
    transcriptExcerpt: v.string(),
    evidenceSummary: v.string(),
    bloomLevel: v.optional(v.string()),
    misconceptionObservationId: v.optional(v.id("masteryObservations")),
    phase: v.optional(v.union(v.literal("baseline"), v.literal("exit"))),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("granuleEvidence", {
      ...args,
      observedAt: Date.now(),
    });
  },
});

export type CoverageCellEvidence = {
  outcome: "demonstrated" | "probed";
  evidenceSummary: string;
  transcriptExcerpt: string;
  bloomLevel: string | null;
  phase: "baseline" | "exit" | null;
  observedAt: number;
  sessionId: string;
  hasMisconception: boolean;
};

/**
 * The Run page grid: scholars × the unit's granules, with derived
 * status + the underlying evidence per cell. Owner-gated like
 * assignments.get.
 */
export const coverageForAssignment = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || a.teacherId !== ctx.user._id) return null;
    // A standing (unitId-less) assignment has no unit/granules grid.
    const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
    if (!unit) return null;

    const granules = unitGranules(unit);
    if (granules.length === 0) {
      return { granules: [], scholars: [] };
    }

    const evidence = await ctx.db
      .query("granuleEvidence")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
      .collect();
    const byScholar = new Map<string, typeof evidence>();
    for (const e of evidence) {
      const bucket = byScholar.get(String(e.scholarId));
      if (bucket) bucket.push(e);
      else byScholar.set(String(e.scholarId), [e]);
    }

    const scholars = await Promise.all(
      a.scholarIds.map(async (sid) => {
        const s = await ctx.db.get(sid);
        const rows = byScholar.get(String(sid)) ?? [];
        const statuses = deriveGranuleStatuses(granules, rows);
        const cells: Record<
          string,
          { status: GranuleStatus; evidence: CoverageCellEvidence[] }
        > = {};
        for (const g of granules) {
          const cellRows = rows
            .filter((e) => e.granuleKey === g.key)
            .sort((x, y) => x.observedAt - y.observedAt);
          cells[g.key] = {
            status: statuses.get(g.key) ?? "gray",
            evidence: cellRows.map((e) => ({
              outcome: e.outcome,
              evidenceSummary: e.evidenceSummary,
              transcriptExcerpt: e.transcriptExcerpt,
              bloomLevel: e.bloomLevel ?? null,
              phase: e.phase ?? null,
              observedAt: e.observedAt,
              sessionId: String(e.sessionId),
              hasMisconception: !!e.misconceptionObservationId,
            })),
          };
        }
        return {
          scholarId: sid,
          name: s?.name ?? s?.username ?? "(unknown)",
          username: s?.username ?? null,
          image: s?.image ?? null,
          cells,
        };
      }),
    );

    return { granules, scholars };
  },
});

/**
 * Aide-tool variant of the coverage grid — same ownership gate, keyed
 * by callerUserId (the aide's HTTP action carries no Convex identity),
 * compacted for token economy: statuses only, no excerpts.
 */
export const aideCoverage = internalQuery({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
  },
  handler: async (ctx, { callerUserId, assignmentId }) => {
    const a = await ctx.db.get(assignmentId);
    if (!a || a.teacherId !== callerUserId) return null;
    // A standing (unitId-less) assignment has no unit/granules grid.
    const unit = a.unitId ? await ctx.db.get(a.unitId) : null;
    if (!unit) return null;
    const granules = unitGranules(unit);
    if (granules.length === 0) {
      return { unitTitle: unit.title, granules: [], scholars: [], movement: null };
    }
    const evidence = await ctx.db
      .query("granuleEvidence")
      .withIndex("by_assignment", (q) => q.eq("assignmentId", a._id))
      .collect();
    const rank: Record<GranuleStatus, number> = { gray: 0, yellow: 1, green: 2 };
    const scholars = await Promise.all(
      a.scholarIds.map(async (sid) => {
        const s = await ctx.db.get(sid);
        const rows = evidence.filter((e) => e.scholarId === sid);
        const statuses = deriveGranuleStatuses(granules, rows);
        // Rosters are factual membership — never filtered; Extended Education
        // members are annotated (lib/scholarParticipationTooling.ts).
        return {
          name: s?.name ?? s?.username ?? "(unknown)",
          statuses: granules.map((g) => {
            const cell = rows.filter((e) => e.granuleKey === g.key);
            // Phase-split for before/after: baseline (start of unit) vs exit.
            const baseline = statusFromEvidence(
              cell.filter((e) => e.phase === "baseline"),
            );
            const exit = statusFromEvidence(cell.filter((e) => e.phase === "exit"));
            return {
              granule: g.text,
              kind: g.kind,
              status: statuses.get(g.key) ?? "gray",
              baselineStatus: baseline,
              exitStatus: exit,
              // true when the unit demonstrably moved this granule forward
              // for this scholar (only meaningful when both phases exist).
              improved:
                baseline !== "gray" && exit !== "gray" && rank[exit] > rank[baseline],
            };
          }),
          ...extendedEducationTag(s ?? {}),
        };
      }),
    );
    // Cohort-level before/after rollup — answers "how did this assignment
    // affect understanding across the class?" Only counts granules that have
    // BOTH a baseline and an exit reading (i.e. a real pre/post pair).
    let pairs = 0;
    let improved = 0;
    let heldGreen = 0;
    for (const sch of scholars) {
      for (const st of sch.statuses) {
        if (st.baselineStatus !== "gray" && st.exitStatus !== "gray") {
          pairs++;
          if (st.improved) improved++;
          else if (st.baselineStatus === "green" && st.exitStatus === "green")
            heldGreen++;
        }
      }
    }
    const movement =
      pairs > 0
        ? {
            comparablePairs: pairs,
            improved,
            heldAtDemonstrated: heldGreen,
            note: "Before/after is per scholar × granule, comparing baseline-phase vs exit-phase evidence. Only granules with BOTH a baseline and an exit reading are counted. 'improved' = status rose (e.g. yellow→green); needs a baseline AND an exit-ticket activity to have run.",
          }
        : {
            comparablePairs: 0,
            improved: 0,
            heldAtDemonstrated: 0,
            note: "No before/after pairs yet — this needs both a baseline (start-of-unit) and an exit-ticket activity to have run for the same scholars. The per-granule status below is still cumulative coverage.",
          };
    return { unitTitle: unit.title, granules, scholars, movement };
  },
});

export type GrowthPair = {
  unitTitle: string;
  unitEmoji: string | null;
  /** The EQ/EU the unit chases — curriculum language, not a status. */
  prompt: string;
  /** The scholar's own words at the start of the unit (baseline). */
  before: string;
  /** The scholar's own words by the end (exit ticket). */
  after: string;
  /** Exit timestamp — newest-first ordering only; never rendered. */
  latestAt: number;
};

/**
 * Kid-facing "look how far you've come": per (unit × granule) pairs that
 * have BOTH a baseline-phase and an exit-phase reading, surfaced as the
 * scholar's OWN WORDS at each end (the verbatim `transcriptExcerpt`).
 *
 * Deliberately learner-safe — the complement of `coverageForAssignment`,
 * which is teacher-only: NO derived green/yellow/gray status, no
 * demonstrated/probed outcome, no Bloom level, no evidenceSummary (that
 * one is observer-voiced third person). Just the unit, the question, and
 * what the scholar said before and after, so the words carry the growth.
 *
 * Self-or-teacher gated like masteryObservations.growthForScholar. A pair
 * is included only when both ends have a non-empty verbatim excerpt and
 * the granule still exists on the unit (an edited/removed key drops out).
 */
export const growthPairsForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }): Promise<GrowthPair[]> => {
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);

    const rows = await ctx.db
      .query("granuleEvidence")
      .withIndex("by_scholar_unit", (q) => q.eq("scholarId", scholarId))
      .collect();
    if (rows.length === 0) return [];

    // Group every reading by unit + granule.
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.unitId}::${r.granuleKey}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(r);
      else groups.set(key, [r]);
    }

    // Resolve a unit's title/emoji + key→text map once, cached.
    const unitCache = new Map<
      string,
      { title: string; emoji: string | null; texts: Map<string, string> } | null
    >();
    const getUnit = async (unitId: Id<"units">) => {
      const cacheKey = String(unitId);
      const cached = unitCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const unit = (await ctx.db.get(unitId)) as Doc<"units"> | null;
      const resolved = unit
        ? {
            title: unit.title,
            emoji: unit.emoji ?? null,
            texts: new Map(unitGranules(unit).map((g) => [g.key, g.text])),
          }
        : null;
      unitCache.set(cacheKey, resolved);
      return resolved;
    };

    const pairs: GrowthPair[] = [];
    for (const group of groups.values()) {
      const byTime = (a: Doc<"granuleEvidence">, b: Doc<"granuleEvidence">) =>
        a.observedAt - b.observedAt;
      const baseline = group
        .filter((r) => r.phase === "baseline" && r.transcriptExcerpt.trim())
        .sort(byTime);
      const exit = group
        .filter((r) => r.phase === "exit" && r.transcriptExcerpt.trim())
        .sort(byTime);
      if (baseline.length === 0 || exit.length === 0) continue;

      // Earliest baseline → latest exit spans the widest before/after.
      const first = baseline[0];
      const last = exit[exit.length - 1];
      const unit = await getUnit(first.unitId);
      if (!unit) continue;
      const prompt = unit.texts.get(first.granuleKey);
      if (!prompt) continue; // granule edited/removed — no text to show

      pairs.push({
        unitTitle: unit.title,
        unitEmoji: unit.emoji,
        prompt,
        before: first.transcriptExcerpt.trim(),
        after: last.transcriptExcerpt.trim(),
        latestAt: last.observedAt,
      });
    }

    pairs.sort((a, b) => b.latestAt - a.latestAt);
    return pairs;
  },
});
