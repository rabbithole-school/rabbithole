/**
 * Practice-engine instrumentation — READ-ONLY aggregation over the existing
 * practice tables (`practiceMastery`, `practiceErrorEvents`, `knowledgeNodes`).
 *
 * This is the "instrument, not re-argue" lane from the practice plan of record
 * (review/practice/practice-plan-of-record.html §9): the plan asks for
 * calibration counters on the acceleration valve, source mix, latency
 * baselines, error-pattern base rates, and domain exhaustion — WITHOUT
 * standing up a new event log or touching the engine itself. Every number
 * here is computed from rows the engine already writes; no mutations, no new
 * tables. Admin-only (mirrors the platform-admin gate other admin-console
 * reads use, e.g. convex/passkeys.ts `adminCounts`).
 */

import { v } from "convex/values";
import { platformAdminQuery } from "./lib/customFunctions";
import { FLUENT_REPS, ACCEL_SOURCE, isDue } from "./lib/practice/scheduler";
import { pickFlaggedNode, pickRemediationTarget } from "./lib/practice/remediation";
import type { Doc } from "./_generated/dataModel";

const ERROR_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, matches errorFlags.ts's rolling window

/** Simple sort-based percentile (linear interpolation between ranks). `sorted` must already be ascending. */
function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * The one instrumentation read — every counter the panel renders, computed
 * fresh from existing rows. Optionally scoped to a single `domain`.
 */
export const getInstruments = platformAdminQuery({
  args: { domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();

    const allMastery = await ctx.db.query("practiceMastery").collect();
    const mastery = args.domain
      ? allMastery.filter((m) => m.domain === args.domain)
      : allMastery;

    const allNodes = await ctx.db.query("knowledgeNodes").collect();
    const nodes = args.domain
      ? allNodes.filter((n) => n.domain === args.domain)
      : allNodes;

    const allErrors = await ctx.db.query("practiceErrorEvents").collect();
    const recentErrors = allErrors.filter(
      (e) => e.createdAt >= now - ERROR_WINDOW_MS && (!args.domain || e.domain === args.domain),
    );
    const domainErrors = args.domain
      ? allErrors.filter((e) => e.domain === args.domain)
      : allErrors;

    const allEdges = await ctx.db.query("knowledgeNodeEdges").collect();
    const buildsOnEdges = allEdges
      .filter((e) => e.kind === "buildsOn" && (!args.domain || e.domain === args.domain))
      .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey, domain: e.domain }));

    const allTuneups = await ctx.db.query("practiceTuneups").collect();
    const tuneups = args.domain ? allTuneups.filter((r) => r.domain === args.domain) : allTuneups;

    return {
      valve: valveStats(mastery, now),
      sourceMix: sourceMixStats(mastery),
      latency: latencyStats(mastery),
      errorPatterns: errorPatternStats(recentErrors),
      domainExhaustion: domainExhaustionStats(mastery, nodes),
      implicit: implicitStats(mastery, now),
      remediation: remediationStats(mastery, domainErrors, buildsOnEdges, now),
      tuneups: tuneupStats(tuneups, now),
    };
  },
});

/**
 * Valve fire count + false-fire PROXY (§9 note: a true per-attempt fire rate
 * needs a future valveEvents log; this is the row-level proxy — of the
 * mastery rows the valve has ever accelerated, how many are now due again,
 * i.e. "didn't hold").
 */
function valveStats(mastery: Doc<"practiceMastery">[], now: number) {
  const accelerated = mastery.filter((m) => m.source === ACCEL_SOURCE);
  let lapsed = 0;
  for (const m of accelerated) {
    if (isDue({ repetition: m.repetition, halfLifeDays: m.halfLifeDays, lastPracticedAt: m.lastPracticedAt }, now)) {
      lapsed++;
    }
  }
  const fired = accelerated.length;
  const stillHolding = fired - lapsed;
  return {
    fired,
    stillHolding,
    lapsed,
    lapseRate: fired > 0 ? lapsed / fired : 0,
  };
}

/** Source mix across rows the cohort has taken FLUENT (repetition >= FLUENT_REPS). */
function sourceMixStats(mastery: Doc<"practiceMastery">[]) {
  const fluent = mastery.filter((m) => m.repetition >= FLUENT_REPS);
  const counts: Record<string, number> = { practice: 0, placement: 0, accelerated: 0 };
  for (const m of fluent) {
    counts[m.source] = (counts[m.source] ?? 0) + 1;
  }
  return { total: fluent.length, counts };
}

/** Latency baseline distribution over rows carrying a `latencyMedianMs` reading. */
function latencyStats(mastery: Doc<"practiceMastery">[]) {
  const values = mastery
    .map((m) => m.latencyMedianMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { count: 0, min: undefined, p25: undefined, median: undefined, p75: undefined, max: undefined };
  }
  return {
    count: values.length,
    min: values[0],
    p25: percentile(values, 25),
    median: percentile(values, 50),
    p75: percentile(values, 75),
    max: values[values.length - 1],
  };
}

/** Error-pattern base rates (last 14 days): count per pattern + distinct scholars affected. */
function errorPatternStats(recentErrors: Doc<"practiceErrorEvents">[]) {
  const byPattern = new Map<string, { count: number; scholars: Set<string> }>();
  for (const e of recentErrors) {
    const entry = byPattern.get(e.pattern) ?? { count: 0, scholars: new Set<string>() };
    entry.count++;
    entry.scholars.add(e.scholarId);
    byPattern.set(e.pattern, entry);
  }
  return Array.from(byPattern.entries())
    .map(([pattern, { count, scholars }]) => ({ pattern, count, scholarCount: scholars.size }))
    .sort((a, b) => b.count - a.count);
}

/**
 * FIRe implicit-repetition counters (§4A). `refreshedRows14d`: mastery rows that
 * received fractional implicit credit in the trailing 14 days; `totalImplicitCount`:
 * lifetime sum of implicit refreshes; `dueNow`: how many rows are currently due —
 * the number to watch trend DOWN after the flag flips (implicit credit refreshing
 * prerequisites before they lapse). No new writes — all read off `practiceMastery`.
 */
function implicitStats(mastery: Doc<"practiceMastery">[], now: number) {
  const since = now - ERROR_WINDOW_MS; // 14 days
  let refreshedRows14d = 0;
  let totalImplicitCount = 0;
  let dueNow = 0;
  for (const m of mastery) {
    if (m.lastImplicitAt !== undefined && m.lastImplicitAt >= since) refreshedRows14d++;
    totalImplicitCount += m.implicitCount ?? 0;
    if (isDue({ repetition: m.repetition, halfLifeDays: m.halfLifeDays, lastPracticedAt: m.lastPracticedAt }, now)) {
      dueNow++;
    }
  }
  return { refreshedRows14d, totalImplicitCount, dueNow };
}

/**
 * Domain-exhaustion PROXY — per PRACTICE domain, total practice nodes vs. the
 * cohort's fluent-node instances, averaged over the scholars who've touched it.
 *
 * IMPORTANT: `knowledgeNodes` is a SHARED table — besides the practice graph it
 * also holds Sky/concept-atlas + standards nodes whose free-form `domain`
 * ("Math", "Mathematics", "Reading", "Historical Thinking", …) is a different,
 * multi-source taxonomy (and is not even case-normalized — see the atlas TODO).
 * Those are NOT practice domains and would otherwise flood this metric. A
 * PRACTICE node is the one the scheduler drills — identified by carrying a
 * `strand`; atlas/standards nodes have none. So we count only stranded nodes and
 * only emit domains that have practice nodes and/or practice-mastery rows.
 */
function domainExhaustionStats(mastery: Doc<"practiceMastery">[], nodes: Doc<"knowledgeNodes">[]) {
  const practiceNodesByDomain = new Map<string, number>();
  for (const n of nodes) {
    if (!n.strand) continue; // atlas/standards node — not a practice domain
    practiceNodesByDomain.set(n.domain, (practiceNodesByDomain.get(n.domain) ?? 0) + 1);
  }

  const scholarsByDomain = new Map<string, Set<string>>();
  const fluentByDomain = new Map<string, number>();
  for (const m of mastery) {
    const scholars = scholarsByDomain.get(m.domain) ?? new Set<string>();
    scholars.add(m.scholarId);
    scholarsByDomain.set(m.domain, scholars);
    if (m.repetition >= FLUENT_REPS) {
      fluentByDomain.set(m.domain, (fluentByDomain.get(m.domain) ?? 0) + 1);
    }
  }

  // Practice domains only: those with practice nodes and/or practice-mastery.
  const domains = new Set<string>([...practiceNodesByDomain.keys(), ...scholarsByDomain.keys()]);
  return Array.from(domains)
    .map((domain) => {
      const totalNodes = practiceNodesByDomain.get(domain) ?? 0;
      const scholarCount = scholarsByDomain.get(domain)?.size ?? 0;
      const fluentNodeInstances = fluentByDomain.get(domain) ?? 0;
      const denominator = totalNodes * scholarCount;
      return {
        domain,
        totalNodes,
        scholarCount,
        fluentNodeInstances,
        avgPercentComplete: denominator > 0 ? (fluentNodeInstances / denominator) * 100 : 0,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Auto-remediation coverage (§5). `scholarsWithOpenFlags`: distinct scholars
 * with an open error-pattern flag on some node (the trigger population).
 * `activeTargets`: (scholar, domain) pairs where the engine is actively serving
 * a pinpointed prerequisite — i.e. a flagged node exists and a weak-enough
 * prereq was found. Watch `activeTargets` rise
 * when flags open, and target prereqs' retention climb across sessions. No new
 * writes — recomputed from `practiceMastery` / `practiceErrorEvents` /
 * `knowledgeNodeEdges`.
 */
function remediationStats(
  mastery: Doc<"practiceMastery">[],
  errors: Doc<"practiceErrorEvents">[],
  edges: { fromKey: string; toKey: string; domain: string }[],
  now: number,
) {
  const edgesByDomain = new Map<string, { fromKey: string; toKey: string }[]>();
  for (const e of edges) {
    const arr = edgesByDomain.get(e.domain) ?? [];
    arr.push({ fromKey: e.fromKey, toKey: e.toKey });
    edgesByDomain.set(e.domain, arr);
  }

  const masteryByScholarDomain = new Map<string, Map<string, Doc<"practiceMastery">>>();
  for (const m of mastery) {
    const sdKey = `${m.scholarId}::${m.domain}`;
    let byKey = masteryByScholarDomain.get(sdKey);
    if (!byKey) {
      byKey = new Map();
      masteryByScholarDomain.set(sdKey, byKey);
    }
    byKey.set(m.skillKey, m);
  }

  const errorsByScholarDomain = new Map<string, Doc<"practiceErrorEvents">[]>();
  for (const e of errors) {
    const sdKey = `${e.scholarId}::${e.domain}`;
    const arr = errorsByScholarDomain.get(sdKey) ?? [];
    arr.push(e);
    errorsByScholarDomain.set(sdKey, arr);
  }

  const scholarsWithOpenFlags = new Set<string>();
  let activeTargets = 0;
  for (const [sdKey, evs] of errorsByScholarDomain) {
    const flagged = pickFlaggedNode(evs, now);
    if (flagged === null) continue;
    const scholarId = sdKey.slice(0, sdKey.indexOf("::"));
    scholarsWithOpenFlags.add(scholarId);
    const domain = sdKey.slice(sdKey.indexOf("::") + 2);
    const masteryMap = masteryByScholarDomain.get(sdKey);
    const target = pickRemediationTarget(
      flagged,
      edgesByDomain.get(domain) ?? [],
      (k) => {
        const row = masteryMap?.get(k);
        return row
          ? { repetition: row.repetition, halfLifeDays: row.halfLifeDays, lastPracticedAt: row.lastPracticedAt }
          : undefined;
      },
      now,
    );
    if (target !== null) activeTargets++;
  }
  return { activeTargets, scholarsWithOpenFlags: scholarsWithOpenFlags.size };
}

/**
 * Tune-up throughput (§4B). `started14d` / `completed14d`: tune-ups started /
 * completed in the trailing 14 days; `avgCorrect`: mean `correctCount` over the
 * tune-ups COMPLETED in that window (0 when none — no completions yet). No new
 * writes — read straight off `practiceTuneups`.
 */
function tuneupStats(tuneups: Doc<"practiceTuneups">[], now: number) {
  const since = now - ERROR_WINDOW_MS; // 14 days
  let started14d = 0;
  let completed14d = 0;
  let correctSum = 0;
  for (const tu of tuneups) {
    if (tu.startedAt >= since) started14d++;
    if (tu.completedAt !== undefined && tu.completedAt >= since) {
      completed14d++;
      correctSum += tu.correctCount ?? 0;
    }
  }
  return { started14d, completed14d, avgCorrect: completed14d > 0 ? correctSum / completed14d : 0 };
}
