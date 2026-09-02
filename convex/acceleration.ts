/**
 * Acceleration — the gifted-school read of standards data.
 *
 * Re-projects the standards graph + a scholar's mastery evidence into a
 * per-strand, per-grade portrait: how far ABOVE chronological grade level a
 * scholar reaches (the headline at a gifted school), with a notch at their
 * actual grade and any genuinely below-age area flagged as a concept to build —
 * never a deficit score, never a learner↔learner comparison.
 *
 * The metric per (strand, grade) is the scholar's AVERAGE mastery on the
 * standards they've demonstrated at that grade (0–5 Bloom → %). Gray = no
 * evidence there yet. This honours the data we have (sparse, real) without
 * pretending to coverage of every committee standard.
 *
 * Design notes: review/knowledge-tree-expansion.html (§5). Standards stay a
 * tag; this is a read over them, no new tables beyond the optional
 * users.gradeLevel notch.
 */

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { internalMutation } from "./_generated/server";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import type { Id } from "./_generated/dataModel";
import {
  ACCELERATION_GRADES,
  gradeIndex,
  isGradeSpecific,
  strandForStandard,
  trackedGrades,
  domainOf,
  type Strand,
} from "./lib/standardStrand";
import { expectedBloomForStandard, fourStop, summarizeBand, type BloomStop, type BandStandard } from "./lib/bloomRigor";

const MASTERY_MAX = 5; // 0–5 Bloom float (convex/lib/observerShared.ts)

// Coverage % at/above which a band reads as "mastered" (the rest is in-progress).
const MASTERED_PCT = 80;

export type AccelCellStatus = "mastered" | "progress" | "below" | "none";

// The scholar's best (max) demonstrated level per standardId, + the strongest
// fluency reading seen — the two scholar-side inputs every band derives from.
// Shared by forScholar and cellDetail so the read is computed one way.
function scholarLevels(
  observations: Array<{ standardIds?: unknown[]; masteryLevel: number; fluencyLevel?: number; fluencySource?: string }>,
) {
  const levelByStandard = new Map<string, number>();
  const fluencyByStandard = new Map<string, { level: number; source?: string }>();
  for (const obs of observations) {
    for (const sid of obs.standardIds ?? []) {
      const k = sid as string;
      levelByStandard.set(k, Math.max(levelByStandard.get(k) ?? 0, obs.masteryLevel));
      if (obs.fluencyLevel && obs.fluencyLevel > (fluencyByStandard.get(k)?.level ?? 0)) {
        fluencyByStandard.set(k, { level: obs.fluencyLevel, source: obs.fluencySource });
      }
    }
  }
  return { levelByStandard, fluencyByStandard };
}

/**
 * The acceleration portrait for one scholar: strand rows × grade columns.
 * Teacher- or self-facing (requireTeacherOrSelf).
 */
export const forScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const scholar = await ctx.db.get(args.scholarId);
    const chronologicalGrade = scholar?.gradeLevel ?? null;

    // Current (non-superseded) mastery observations that are linked to standards.
    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();
    const { levelByStandard, fluencyByStandard } = scholarLevels(observations);

    // Scan ALL grade-specific leaf standards, bucketing by (strandKey, grade).
    // The headline is coverage over EVERY standard in the band (goal 100%), so —
    // unlike a scan of only the scholar's observations — the denominator is the
    // full band. summarizeBand then turns each bucket into the cell's number +
    // colour, the SAME function the drawer ring uses (no drift).
    const allStandards = await ctx.db.query("standards").collect();
    const strandMeta = new Map<string, Strand>();
    const bandStandards = new Map<string, BandStandard[]>();
    const bandFluency = new Map<string, { level: number; source?: string }>();
    for (const s of allStandards) {
      if (!s.isLeaf || !isGradeSpecific(s.gradeLevels)) continue; // skip anchor/skill standards
      const strand = strandForStandard(s.subject, s.notation);
      if (!strand) continue; // not grade-banded → excluded
      strandMeta.set(strand.key, strand);
      const demonstrated = levelByStandard.get(s._id as unknown as string);
      const expected = expectedBloomForStandard(s.description);
      const flu = fluencyByStandard.get(s._id as unknown as string);
      for (const grade of trackedGrades(s.gradeLevels)) {
        const k = `${strand.key}::${grade}`;
        (bandStandards.get(k) ?? bandStandards.set(k, []).get(k)!).push({ demonstrated, expected });
        // Carry the strongest fluency on the band (honesty-gated downstream).
        if (flu && flu.level > (bandFluency.get(k)?.level ?? 0)) bandFluency.set(k, flu);
      }
    }

    const chronoIdx = chronologicalGrade ? gradeIndex(chronologicalGrade) : -1;

    const subjects = [...strandMeta.values()]
      .map((strand) => {
        let reachIdx = -1;
        const cells = ACCELERATION_GRADES.map((grade) => {
          const standards = bandStandards.get(`${strand.key}::${grade}`);
          const summary = summarizeBand(standards ?? []);
          if (summary.evidenced === 0) {
            return { grade, pct: null as number | null, status: "none" as AccelCellStatus, stop: "notyet" as BloomStop, count: 0, fluencyLevel: null as number | null, fluencySource: undefined as string | undefined };
          }
          const pct = summary.coveragePct;
          const gIdx = gradeIndex(grade);
          // Below-age flag: a not-yet-mastered band at or before the scholar's
          // chronological grade is a concept to shore up (owned by the learner,
          // never a rank). Above-age bands are the celebrated reach.
          let status: AccelCellStatus;
          if (chronoIdx >= 0 && gIdx >= 0 && gIdx <= chronoIdx && pct < MASTERED_PCT) status = "below";
          else if (pct >= MASTERED_PCT) status = "mastered";
          else status = "progress";
          if (status === "mastered" || status === "progress") reachIdx = Math.max(reachIdx, gIdx);
          const flu = bandFluency.get(`${strand.key}::${grade}`);
          return { grade, pct, status, stop: summary.stop, count: summary.evidenced, fluencyLevel: flu?.level ?? null, fluencySource: flu?.source };
        });
        // Grades reached above chronological (the celebrated headline).
        const reachAhead = chronoIdx >= 0 && reachIdx > chronoIdx ? reachIdx - chronoIdx : 0;
        return { key: strand.key, label: strand.label, cells, reachAhead };
      })
      // Show EVERY strand in the standards catalog, even with no evidence yet —
      // an all-gray row is itself information (a domain not yet touched), and a
      // stable, complete row set reads better than rows that appear/disappear
      // per scholar. (Was previously filtered to strands with evidence.)
      .sort((a, b) => (strandMeta.get(a.key)!.order - strandMeta.get(b.key)!.order));

    return {
      chronologicalGrade,
      grades: ACCELERATION_GRADES,
      subjects,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 2 — zoom: the fine sub-topic graph behind one (strand, grade) cell.
// Returns the band's grade-specific standards as nodes, clustered by CCSS
// domain and ordered by notation (a left→right within-band sequence), each
// colored by the scholar's mastery. Honest about the data: CCSS ships no fine
// prerequisite edges for most standards, so this is the real sub-topic set +
// the scholar's frontier inside the band, not asserted prerequisites.
// ───────────────────────────────────────────────────────────────────────────

export const cellDetail = authedQuery({
  args: {
    scholarId: v.id("users"),
    strandKey: v.string(),
    grade: v.string(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    // The scholar's mastery per standardId (best/current level) + fluency.
    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();
    const { levelByStandard, fluencyByStandard } = scholarLevels(observations);

    // The band's standards (grade-specific leaves matching this strand+grade).
    const all = await ctx.db.query("standards").collect();
    type Node = {
      id: string;
      notation?: string;
      understanding?: string;
      description: string;
      pct: number | null;
      status: AccelCellStatus;
      stop: BloomStop;
      fluencyLevel: number | null;
      fluencySource?: string;
    };
    const domains = new Map<string, { key: string; label: string; nodes: Node[] }>();
    // The same per-standard inputs the grid cell's summary is built from, so the
    // ring's headline matches the cell's number exactly (one metric, one source).
    const bandStandards: BandStandard[] = [];
    // The standards documents this band's nodes are cited from (e.g. "Common
    // Core State Standards for Mathematics") — for the drawer's citation footer.
    const documentIds = new Set<Id<"standardsDocuments">>();

    for (const s of all) {
      if (!s.isLeaf || !isGradeSpecific(s.gradeLevels)) continue;
      if (!trackedGrades(s.gradeLevels).includes(args.grade)) continue;
      const strand = strandForStandard(s.subject, s.notation);
      if (!strand || strand.key !== args.strandKey) continue;
      documentIds.add(s.documentId);

      const lvl = levelByStandard.get(s._id as unknown as string);
      const expected = expectedBloomForStandard(s.description);
      bandStandards.push({ demonstrated: lvl, expected });
      let pct: number | null = null;
      let status: AccelCellStatus = "none";
      if (lvl !== undefined) {
        pct = Math.round((lvl / MASTERY_MAX) * 100);
        status = pct >= MASTERED_PCT ? "mastered" : "progress";
      }
      // Option C: each node's four-stop position vs the standard's own bar.
      const stop = fourStop(lvl ?? null, expected);
      const flu = fluencyByStandard.get(s._id as unknown as string);
      const dom = domainOf(s.notation);
      const bucket = domains.get(dom.key) ?? { key: dom.key, label: dom.label, nodes: [] };
      bucket.nodes.push({
        id: s._id,
        notation: s.notation,
        understanding: s.understanding,
        description: s.description,
        pct,
        status,
        stop,
        fluencyLevel: flu?.level ?? null,
        fluencySource: flu?.source,
      });
      domains.set(dom.key, bucket);
    }

    const domainList = [...domains.values()]
      .map((d) => ({
        ...d,
        nodes: d.nodes.sort((a, b) => (a.notation ?? "").localeCompare(b.notation ?? "")),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const understood = domainList.reduce(
      (n, d) => n + d.nodes.filter((x) => !!x.understanding).length,
      0,
    );

    // The band's headline + four-stop spread, from the SHARED summary (the grid
    // cell shows the same coveragePct). totalNodes/evidenced/dist all flow from it.
    const summary = summarizeBand(bandStandards);

    // Resolve the source documents for the citation footer, de-duped and sorted
    // by title so the drawer can attribute the codes (e.g. CCSS Math).
    const sourceDocs = await Promise.all(
      [...documentIds].map((id) => ctx.db.get(id)),
    );
    const sources = sourceDocs
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map((d) => ({ title: d.title, jurisdiction: d.jurisdiction }))
      .sort((a, b) => a.title.localeCompare(b.title));

    return {
      strandKey: args.strandKey,
      grade: args.grade,
      domains: domainList,
      totalNodes: summary.total,
      evidenced: summary.evidenced,
      understood,
      dist: summary.dist,
      coveragePct: summary.coveragePct,
      sources,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// DEV-ONLY deterministic fixture.
// scholar grade, so this builds a reproducible acceleration profile for one
// scholar: sets their chronological grade and creates mastery observations
// linked to REAL CCSS standards, with masteryLevel SPREAD around a per-cell
// target so the bar's average lands on the target AND the drill-down (Phase 2)
// shows a realistic within-band frontier (some sub-topics strong, some not).
// The seed IS the world — assert against this. Run:
//   npx convex run acceleration:devSeedAcceleration '{"username":"test-scholar-001"}'
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// DEV-ONLY deterministic fixture.
// Builds a reproducible acceleration profile for one scholar: sets their
// chronological grade and creates mastery observations linked to REAL CCSS/NGSS
// standards. DEMO_PROFILE is a per-band COVERAGE target (the % of the band's
// standards met-or-beyond — the SAME number the grid cell + drawer ring show),
// and planBandSeeds turns it into per-standard levels so the band's coverage AND
// its four-stop colour both land where intended. The seed IS the world — assert
// against this. Run:
//   npx convex run acceleration:devSeedAcceleration '{"username":"test-scholar-001"}'
// ───────────────────────────────────────────────────────────────────────────

// Target COVERAGE % per (strandKey, grade) for the demo scholar (a 2nd grader
// working ~2–3 grades ahead, with Writing below age to exercise the "shore up"
// flag). Read as: "what fraction of this grade's standards has the scholar met
// or gone beyond." ≥80 seeds blue (beyond), 40–79 green (met), <40 the yellow
// shore-up frontier. Absent grades stay gray (no evidence = headroom).
const DEMO_PROFILE: Record<string, Record<string, number>> = {
  math: { K: 100, "1": 100, "2": 96, "3": 92, "4": 85, "5": 45 },
  "ela.reading": { K: 100, "1": 98, "2": 95, "3": 90, "4": 82, "5": 68 },
  "ela.writing": { K: 88, "1": 50, "2": 22 },
  "ela.language": { K: 100, "1": 96, "2": 90, "3": 62 },
  "ela.speaking": { K: 100, "1": 95, "2": 90, "3": 80, "4": 48 },
  science: { K: 100, "1": 95, "2": 90, "3": 84, "4": 55 },
};
const DEMO_GRADE = "2";

// Automaticity (fluency) readings for a few cells — honesty-gated everywhere
// else (most cells show no diamonds). The accelerated 2nd grader has AUTOMATIC
// early-grade number sense (external-practice-site speed) and the teacher has marked a
// couple by hand. 1 = effortful, 2 = fluent, 3 = automatic.
const DEMO_FLUENCY: Record<string, Record<string, { level: number; source: string }>> = {
  math: {
    K: { level: 3, source: "external practice" },
    "1": { level: 3, source: "external practice" },
    "2": { level: 2, source: "teacher" },
    "3": { level: 2, source: "teacher" },
  },
  "ela.reading": {
    K: { level: 3, source: "teacher" },
    "1": { level: 2, source: "teacher" },
  },
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Pure, deterministic: given each band standard's expected bar (in pick order)
 * and a coverage target, decide the demonstrated level to seed each one at.
 * Levels are chosen RELATIVE to each standard's own bar so the four-stop result
 * is guaranteed regardless of the standards' verbs:
 *   ≥80 → seed `metCount = round(cov·N)` BEYOND the bar (blue, mastered)
 *   40–79 → seed `metCount` AT the bar (green, met)
 *   <40 → seed `metCount` at the bar + MORE approaching picks, so the band
 *          average dips below the bar (yellow shore-up) while coverage = cov.
 * Returns one entry per standard to evidence; the rest stay unevidenced (gray).
 */
export function planBandSeeds(
  expecteds: number[],
  covTarget: number,
): Array<{ index: number; level: number }> {
  const N = expecteds.length;
  if (N === 0 || covTarget <= 0) return [];
  const metCount = Math.min(N, Math.round((covTarget / 100) * N));
  // Beyond the bar, but with VARIED depth (not all maxed): the offset from each
  // standard's own bar keeps it met+ (≥ +0.5) and the band average well past it
  // (blue), while the absolute level spreads the Bloom depth shown per node.
  const beyond = (e: number) => clamp(e + 1.5, 2.5, MASTERY_MAX);
  const met = (e: number) => clamp(e, 0, MASTERY_MAX);
  const approaching = (e: number) => clamp(e - 1.1, 0, MASTERY_MAX);
  const seeds: Array<{ index: number; level: number }> = [];
  const strong = covTarget >= 80 ? beyond : met;
  for (let i = 0; i < metCount; i++) seeds.push({ index: i, level: strong(expecteds[i]) });
  if (covTarget < 40) {
    // approachingCount > metCount guarantees the evidenced average lands below
    // the bar (see summarizeBand): yellow, the shore-up read.
    const approachingCount = Math.min(N - metCount, metCount + 1);
    for (let i = 0; i < approachingCount; i++) {
      const idx = metCount + i;
      seeds.push({ index: idx, level: approaching(expecteds[idx]) });
    }
  }
  return seeds;
}

export const devSeedAcceleration = internalMutation({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (!scholar) throw new Error(`No user ${args.username}`);

    await ctx.db.patch(scholar._id, { gradeLevel: DEMO_GRADE });

    // Anchor session (mastery rows require a sessionId FK; the read is by
    // scholar so anchor ownership doesn't matter for the fixture).
    const session =
      (await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholar._id))
        .first()) ?? (await ctx.db.query("sessions").first());
    if (!session) throw new Error("No session exists to anchor evidence");

    // Clear prior fixture rows (idempotent re-seed).
    const prior = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    for (const p of prior) {
      if (p.attemptContext === "dev-acceleration") await ctx.db.delete(p._id);
    }

    // All leaf standards, grouped by (strandKey, grade), so we can pick real
    // ones to evidence. Cap the scan; CCSS Math+ELA leaves are ~1.8k.
    const allStandards = await ctx.db.query("standards").collect();
    const byCell = new Map<string, Array<{ id: Id<"standards">; notation?: string; description: string; subject: string }>>();
    for (const s of allStandards) {
      if (!s.isLeaf) continue;
      if (!isGradeSpecific(s.gradeLevels)) continue; // skip anchor/skill standards
      const strand = strandForStandard(s.subject, s.notation);
      if (!strand) continue;
      for (const grade of trackedGrades(s.gradeLevels)) {
        const k = `${strand.key}::${grade}`;
        const arr = byCell.get(k) ?? [];
        arr.push({ id: s._id, notation: s.notation, description: s.description, subject: s.subject });
        byCell.set(k, arr);
      }
    }

    const insertions: Promise<unknown>[] = [];
    for (const [strandKey, grades] of Object.entries(DEMO_PROFILE)) {
      for (const [grade, covTarget] of Object.entries(grades)) {
        // Deterministic order: sort the band's real standards by notation, then
        // let planBandSeeds decide which to evidence and at what level.
        const pool = [...(byCell.get(`${strandKey}::${grade}`) ?? [])].sort((a, b) =>
          (a.notation ?? "").localeCompare(b.notation ?? ""),
        );
        const flu = DEMO_FLUENCY[strandKey]?.[grade];
        const seeds = planBandSeeds(
          pool.map((p) => expectedBloomForStandard(p.description)),
          covTarget,
        );
        for (const { index, level } of seeds) {
          const pick = pool[index];
          insertions.push(
            ctx.db.insert("masteryObservations", {
              scholarId: scholar._id,
              conceptLabel: pick.notation ? `${pick.notation}: ${pick.description}` : pick.description,
              domain: pick.subject,
              observedAt: Date.now(),
              sessionId: session._id,
              transcriptExcerpt: "(dev acceleration fixture)",
              masteryLevel: level,
              confidenceScore: 0.85,
              evidenceSummary: `Demonstrated ${pick.notation ?? "this standard"} (grade ${grade}).`,
              evidenceType: "demonstration",
              attemptContext: "dev-acceleration",
              studentInitiated: true,
              isSuperseded: false,
              standardIds: [pick.id],
              ...(flu
                ? {
                    fluencyLevel: flu.level,
                    fluencySource: flu.source,
                    fluencyObservedAt: Date.now(),
                  }
                : {}),
            }),
          );
        }
      }
    }
    await Promise.all(insertions);
    return { scholar: scholar.name ?? args.username, grade: DEMO_GRADE, inserted: insertions.length };
  },
});
