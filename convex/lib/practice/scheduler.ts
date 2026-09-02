/**
 * The mastery + spaced-repetition + frontier engine for homegrown practice
 * (discipline-agnostic; math is the first domain). Pure functions, validated in
 * the scheduler spike (review/
 * practice/spikes.html §D): prereq-gated introduction of new skills +
 * spaced review resurfacing as retention decays.
 *
 * Vocabulary is engine-neutral and deliberately matches the fuel-disc /
 * Skills-lens reading (not started → practicing → fluent → overlearned, plus a
 * fresh/due retention axis), so the same Skills › Math surface renders this
 * data unchanged whether the engine is our practice engine or (legacy) a scrape.
 * When PR #395's maVocabulary lands, reconcile these thresholds with it.
 */

import { ancestorWeights } from "./implicitCredit";
import { normalizeGradeTag } from "../../../shared/grade";

export type Proficiency =
  | "not_started"
  | "practicing"
  | "fluent"
  | "overlearned";

/** Per-skill state the engine reads + writes (mirrors the mastery table row). */
export type SkillState = {
  repetition: number;
  halfLifeDays: number;
  lastPracticedAt?: number;
};

// Reps thresholds for the proficiency bands (kept consistent with the
// documented fuel-disc bands). A skill is "fluent enough" to be a prerequisite
// at FLUENT_REPS.
export const PRACTICING_REPS = 1;
export const FLUENT_REPS = 3;
export const OVERLEARNED_REPS = 5;

// The consecutive-miss count at which a skill reads as "struggling" — the
// teacher/parent-facing red mastery state, distinct from amber "frontier". Set
// to 2 ("at least two recent wrong answers not superseded by a later correct"):
// a lower bar than the mid-run spiral-breaker's threshold-3 (spiralBreaker.ts),
// because this is a low-stakes at-a-glance diagnostic color, not a heavier
// in-run intervention. Read off the resident `practiceMastery.missStreak`
// counter (the mirror of accelStreak), never a scan of the attempts log.
export const STRUGGLING_MISS_THRESHOLD = 2;

// Retention model. A successful spaced rep multiplies the half-life (you'll
// remember it longer); a lapse halves it. Tunable; replace with a fitted FSRS
// model once we have real review history (see the plan §6 / the engine note).
export const HALFLIFE_GROWTH = 2.3;
export const HALFLIFE_LAPSE = 0.5;
export const MIN_HALFLIFE_DAYS = 1;
export const DUE_THRESHOLD = 0.6;
export const FOUNDATION_RETENTION_TARGET = 0.9;
export const DEFAULT_RETENTION_TARGET = 0.85;
export const LEAF_RETENTION_TARGET = 0.8;
export const FOUNDATION_DEPENDENT_COUNT = 8;
export const CHALLENGE_OVERFLOW_CAP = 2;
const DAY_MS = 86_400_000;

/** Grade-band ordinal: "K"=0, "1"=1 ... "9"=9; anything else is unknown. The
 *  input is shape-normalized first ("Grade 2" ≡ "2") so a legacy/seed long-form
 *  enrolled grade still yields the intended enrolled-grade protection. */
export function gradeOrdinal(grade: string | undefined): number | undefined {
  const g = normalizeGradeTag(grade);
  if (g === "K") return 0;
  if (g !== undefined && /^[1-9]$/.test(g)) return Number(g);
  return undefined;
}

export type GradeBandCeilingInput = {
  demonstratedGrade?: number;
  accessGrade?: number;
  fallbackGrade?: number;
  firstPostPlacementBlock?: boolean;
  placedThroughGrade?: string | null;
};

/**
 * Daily-serving grade ceiling. Normal practice may look one grade beyond the
 * highest ACCESS-proven row; the first block after placement is deliberately
 * more conservative because placement's trust-upward credits are inferred.
 */
export function gradeBandCeiling({
  demonstratedGrade,
  accessGrade,
  fallbackGrade,
  firstPostPlacementBlock = false,
  placedThroughGrade,
}: GradeBandCeilingInput): number | undefined {
  if (firstPostPlacementBlock) {
    if (demonstratedGrade !== undefined) return demonstratedGrade + 1;
    const placed = gradeOrdinal(placedThroughGrade ?? undefined);
    if (placed !== undefined) return placed;
    // No demonstrated grade and nothing placed-through: a total beginner who
    // answered every probe "unknown". There's no inferred trust-upward credit to
    // be conservative about here, so fall back to the scholar's OWN grade with
    // the normal one-grade look-ahead (matching the non-first-block band width).
    // Returning the bare `fallbackGrade` would set the ceiling one grade too low
    // and deny a scholar sitting BELOW a domain's floor (e.g. a young scholar
    // entering Fractions) their own foundational frontier — an inert, empty
    // first block, the exact dead end this change fixes.
    return fallbackGrade === undefined ? undefined : fallbackGrade + 1;
  }
  const bandBase = demonstratedGrade ?? accessGrade ?? fallbackGrade;
  return bandBase === undefined ? undefined : bandBase + 1;
}

export function proficiencyFromReps(reps: number): Proficiency {
  if (reps <= 0) return "not_started";
  if (reps < FLUENT_REPS) return "practicing";
  if (reps < OVERLEARNED_REPS) return "fluent";
  return "overlearned";
}

/** A skill counts as a satisfied prerequisite once it's fluent or better. */
export function isFluentPlus(state: { repetition: number }): boolean {
  return state.repetition >= FLUENT_REPS;
}

// ── Access vs. fluency — two axes, one rule (plan of record §1) ────────────
// "May they proceed?" (ACCESS) and "are they fluent?" (the GREEN claim) are
// SEPARATE claims; one rep count must not make both. The rule everywhere:
//   inferred credit → provisional;  demonstrated over time → green.
// Provisional is DERIVED at read time from `source` (accessProven && !fluent) —
// never stored, no new mastery band, no migration.

/** Sources that count as DEMONSTRATED (earned through real practice). Any other
 *  source — the valve ("accelerated"), placement, a future re-probe, an assisted
 *  SCAFFOLDED completion — is an INFERRED credit: access-proven (trusted upward)
 *  but not yet a fluency claim. */
export const DEMONSTRATED_SOURCES: ReadonlySet<string> = new Set(["practice"]);

/** Does a mastery row's `source` count as DEMONSTRATED credit (earned through
 *  real practice), rather than an INFERRED credit (placement / accelerated /
 *  re-probe / scaffolded)? This is the single home for the `?? "practice"`
 *  default — a row with NO source is legacy practice — so the
 *  demonstrated-vs-inferred rule can never silently diverge between the
 *  scheduler, the map (`cohortPractice` / `practiceSkills`), and the NodeDrawer
 *  read model (`nodeNeighbourhood`). Prefer this over reaching into
 *  `DEMONSTRATED_SOURCES` with an inline default. */
export function isDemonstratedSource(source?: string): boolean {
  return DEMONSTRATED_SOURCES.has(source ?? "practice");
}

/** A correct answer produced WITH the worked-example scaffold still visible
 *  (≥1 revealed step — a completion problem, not a bare problem). It's assisted,
 *  so it's an INFERRED credit: it bumps repetition/access exactly like a practice
 *  attempt (the fade still progresses, reviews still schedule) but is
 *  deliberately NOT in DEMONSTRATED_SOURCES — only a correct answer on a BARE
 *  problem is a real demonstration that can go green. */
export const SCAFFOLDED_SOURCE = "scaffolded";

/** ACCESS — "may they proceed?" The generous gate that opens postrequisites:
 *  any credit at FLUENT_REPS+ counts, whatever its source (the valve/placement/
 *  re-probe are trusted upward; the short half-life leash self-corrects). This
 *  is exactly today's `isFluentPlus` behaviour — the prereq/frontier gate. */
export function accessProven(row: { repetition: number }): boolean {
  return row.repetition >= FLUENT_REPS;
}

/** FLUENT (the green claim) — what the tutor, seeds, portrait, and parents are
 *  told. Two forms, one helper (callers keep calling `isFluent`):
 *   • `isFluent(row)` — the v1 DEMONSTRATED gate: access-proven AND earned
 *     through real practice (not an inferred credit). Used where no read-time
 *     context is available (pure per-row callers).
 *   • `isFluent(row, ctx)` — the P5 COMPOSITE (raise-the-ceiling §1): the
 *     demonstrated gate PLUS the signals we can evaluate at read time —
 *     RETENTION (a skill overdue for review isn't currently fluent → green
 *     decays honestly) and self-relative LATENCY (a skill answered slowly for
 *     THIS scholar isn't automatic yet; SOFT — skipped when we can't judge
 *     speed). Recent-accuracy and fact-family COVERAGE are deferred (no history
 *     tracked yet) — see TODO "Tighten the green = fluent bar". The green-claim
 *     surfaces (tutor labels, portrait fluent-count, "recently fluent") pass
 *     ctx; internal mechanics (serving difficulty, seed gate, chat ordering)
 *     keep the demonstrated gate. */
export type FluencyContext = {
  now: number;
  /** Per-row retention target; omitted callers keep the legacy `DUE_THRESHOLD`. */
  retentionThreshold?: number;
  /** The scholar's cross-skill latency baseline (median of per-skill medians,
   *  reduced by `latencyBaselineFromSkillMedians`) — undefined until they have
   *  enough history, in which case the latency leg is skipped (unknown never
   *  blocks green). */
  latencyBaseline?: number;
};

/** How much slower than the scholar's own baseline a skill may be answered and
 *  still count as fluent (the latency leg is generous — it only catches
 *  genuinely slow skills, and only gates the GREEN claim, never access). */
export const LATENCY_FLUENT_TOLERANCE = 1.5;

export function isFluent(
  row: {
    repetition: number;
    source?: string;
    halfLifeDays?: number;
    lastPracticedAt?: number;
    latencyMedianMs?: number;
  },
  ctx?: FluencyContext,
): boolean {
  if (!accessProven(row)) return false;
  if (!isDemonstratedSource(row.source)) return false;
  if (!ctx) return true; // demonstrated gate (v1) for context-free callers
  // RETENTION leg (always evaluable): overdue for review ⇒ not currently green.
  const state = {
    repetition: row.repetition,
    halfLifeDays: row.halfLifeDays ?? 0,
    lastPracticedAt: row.lastPracticedAt,
  };
  if (isDue(state, ctx.now, ctx.retentionThreshold)) return false;
  // LATENCY leg (self-relative, SOFT): slow-for-this-scholar ⇒ not automatic
  // yet. Only applied when we have both a baseline and a per-skill median.
  if (
    ctx.latencyBaseline !== undefined &&
    row.latencyMedianMs !== undefined &&
    row.latencyMedianMs > ctx.latencyBaseline * LATENCY_FLUENT_TOLERANCE
  ) {
    return false;
  }
  return true;
}

/** PROVISIONAL — access-proven but not yet green: an INFERRED credit (valve /
 *  placement / re-probe) awaiting demonstration. Derived from `source` alone
 *  (deliberately independent of the composite: a demonstrated-but-decayed or
 *  demonstrated-but-slow skill is NOT provisional — it's a due/rusty review, so
 *  it must never be reported to the tutor as "recently moved up"). Practising a
 *  provisional row correctly flips `source` to "practice" → no longer
 *  provisional, and green once the composite legs clear. Never stored. */
export function isProvisional(row: { repetition: number; source?: string }): boolean {
  return accessProven(row) && !isDemonstratedSource(row.source);
}

// ── Acceleration valve (Wave B, "B1" — raise-the-ceiling plan §4) ──────────
// Under-placement is the failure mode that matters for gifted kids: grinding
// FLUENT_REPS on every node between a placed floor and the real frontier teaches
// a quick kid that practice wastes their time. The valve is the missing half of
// "trust upward": a demonstrated fast streak at a frontier node earns fluent
// credit immediately, so the map opens under them.
//
// v1 = STREAK-JUMP (Mechanism 1), streak-count core (the plan's "ship streak-
// count first, gate the latency arm on B5" path): N consecutive CLEAN correct
// attempts at a frontier node (a miss resets the streak; ⑫ retries use
// record:false so they never count) credits the node fluent. Accelerated credit
// keeps a short (placement-length) half-life leash, so anything shaky resurfaces
// as a due review within days and truth wins — exactly how placement credit
// self-corrects. The mastery row records source:"accelerated" so the portrait
// stays honest about demonstrated-vs-inferred.
//
// The self-relative latency gate (§5) and Mechanism 2 (strand re-probe) are
// deliberately deferred: on a brand-new node there is no per-node latency
// baseline yet (chicken-and-egg), so the latency arm meaningfully applies to the
// re-probe / strategy-node paths (M2), not the first jump.
export const ACCEL_STREAK = 2;
/** Accelerated credit's half-life (days) — placement's short leash, so a lucky
 *  streak self-corrects the same way trusted-upward placement credit does. */
export const ACCEL_HALFLIFE_DAYS = 4;
/** "One jump per chain per session" (§4) proxy — practice has no server session
 *  entity, so we approximate: don't accelerate a node whose direct prerequisite
 *  was itself accelerated within this window (a lucky streak shouldn't cascade
 *  up a chain in one sitting). */
export const ACCEL_CHAIN_WINDOW_MS = 15 * 60 * 1000;
/** The mastery-row source value the valve stamps (distinct from
 *  "practice"/"placement" so teacher/observer see demonstrated-vs-inferred). */
export const ACCEL_SOURCE = "accelerated";

/**
 * Pure predicate: should this correct attempt trigger a streak-jump to fluent?
 * Kept side-effect-free so it's unit-testable; the caller (recordAttemptCore)
 * supplies the frontier + prereq facts it can't compute here.
 */
export function shouldAccelerate(opts: {
  /** Was THIS (recorded, first-attempt) submission correct? */
  correct: boolean;
  /** repetition BEFORE this attempt. */
  prevRepetition: number;
  /** The clean consecutive-correct streak AFTER counting this attempt. */
  nextAccelStreak: number;
  /** Is the node currently on the frontier (not yet fluent, all prereqs fluent)? */
  isFrontierNode: boolean;
  /** Does a direct prerequisite carry source "accelerated" updated within
   *  ACCEL_CHAIN_WINDOW_MS (the one-jump-per-chain proxy)? */
  prereqAcceleratedRecently: boolean;
  /** Is this attempt FAST for THIS scholar (self-relative, §5)? Gating on speed
   *  is what makes the valve accelerate a QUICK kid rather than lower the
   *  fluency bar for everyone — a slow-but-correct kid (for whom the strategy is
   *  the real frontier) keeps the full rep count. False when the scholar has no
   *  personal latency baseline yet (a fresh kid isn't accelerated until they've
   *  demonstrably shown fast recall — conservative + honest). */
  isFast: boolean;
}): boolean {
  if (!opts.correct) return false;
  if (opts.prevRepetition >= FLUENT_REPS) return false; // already fluent — nothing to jump
  if (!opts.isFrontierNode) return false; // never jump a locked/unreachable node
  if (opts.prereqAcceleratedRecently) return false; // bounded optimism: one jump per chain
  if (!opts.isFast) return false; // speed gate — accelerate the quick kid, not everyone
  return opts.nextAccelStreak >= ACCEL_STREAK;
}

/** Minimum # of the scholar's own skills that must carry a latency baseline
 *  before we trust a scholar-level "fast" read (so a brand-new kid isn't
 *  accelerated on 2 lucky taps before we know their normal speed). */
export const ACCEL_MIN_BASELINE_SKILLS = 3;

/**
 * Reduce a caller-selected set of per-skill medians to a self-relative latency
 * baseline, or undefined until enough skills have readings. Callers own the
 * population scope; fact automaticity uses the all-mastery DB helper in
 * `scholarLatencyBaseline.ts`.
 */
export function latencyBaselineFromSkillMedians(
  perSkillMediansMs: number[],
): number | undefined {
  const vals = perSkillMediansMs.filter((m) => Number.isFinite(m) && m > 0).sort((a, b) => a - b);
  if (vals.length < ACCEL_MIN_BASELINE_SKILLS) return undefined;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
}

// ── Strand re-probe (Wave B, "B1" Mechanism 2 — raise-the-ceiling §4) ───────
// The valve (Mechanism 1) jumps ONE node when a quick kid shows a fast streak.
// A kid who keeps triggering it in a strand is under-placed at the STRAND level:
// grinding node-by-node still wastes their time. Mechanism 2 OFFERS a
// placement-style re-probe that moves the whole strand frontier at once — reusing
// the placement binary search (nextStrandProbe/strandFrontier) but starting from
// the scholar's CURRENT frontier as the resume floor, and crediting the newly
// cleared nodes PROVISIONALLY (source "reprobe" → not green until demonstrated,
// on placement's short leash). It's an OFFER, never automatic (the scholar picks
// "jump ahead" vs "keep going"); the offer/reveal UI is rendered elsewhere.

/** Accelerated (valve) credits in a strand before we OFFER a strand re-probe. */
export const REPROBE_STRAND_ACCEL = 2;
/** The mastery-row source a re-probe stamps (distinct + provisional, like placement). */
export const REPROBE_SOURCE = "reprobe";

/**
 * Pure predicate: should we OFFER a strand re-probe? True once the scholar has
 * accumulated ≥ REPROBE_STRAND_ACCEL valve-accelerated credits in the strand —
 * a clear "keeps jumping, is under-placed here" signal. Kept side-effect-free;
 * the caller supplies the count from the scholar's mastery rows.
 */
export function shouldOfferReprobe(strandAcceleratedCount: number): boolean {
  return strandAcceleratedCount >= REPROBE_STRAND_ACCEL;
}

/**
 * Retention 0..1 on a memory half-life forgetting curve, R = 2^(−Δdays/halfLife).
 * A never-practiced skill returns 1 (nothing to forget yet); a practiced skill
 * with no half-life returns 0.
 */
export function retention(state: SkillState, now: number): number {
  if (state.repetition <= 0) return 1;
  if (!state.lastPracticedAt || state.halfLifeDays <= 0) return 0;
  const days = (now - state.lastPracticedAt) / DAY_MS;
  if (days <= 0) return 1;
  return Math.pow(2, -days / state.halfLifeDays);
}

function effectiveDueThreshold(threshold: number | undefined): number {
  return threshold !== undefined && Number.isFinite(threshold) && threshold > 0 && threshold < 1
    ? threshold
    : DUE_THRESHOLD;
}

/** A practiced skill is "due" when its retention has faded below the threshold. */
export function isDue(state: SkillState, now: number, threshold = DUE_THRESHOLD): boolean {
  return state.repetition > 0 && retention(state, now) < effectiveDueThreshold(threshold);
}

/** A retention label for display (drives the `↻ due` marker in the Skills lens). */
export function retentionLabel(
  state: SkillState,
  now: number,
  threshold = DUE_THRESHOLD,
): "fresh" | "due" | "none" {
  if (state.repetition <= 0) return "none";
  return retention(state, now) < effectiveDueThreshold(threshold) ? "due" : "fresh";
}

/** The timestamp when a practiced skill will cross its due threshold. */
export function dueAt(state: SkillState, threshold = DUE_THRESHOLD): number | undefined {
  if (state.repetition <= 0 || state.lastPracticedAt === undefined || state.halfLifeDays <= 0) {
    return undefined;
  }
  const target = effectiveDueThreshold(threshold);
  const daysUntilDue = Math.log2(1 / target) * state.halfLifeDays;
  return state.lastPracticedAt + daysUntilDue * DAY_MS;
}

/**
 * Update a skill's state after one practice attempt. Success advances the
 * repetition count and grows the half-life; a miss shrinks the half-life and
 * does NOT advance reps (you haven't demonstrated it yet).
 */
export function applyAttempt(
  prev: SkillState,
  correct: boolean,
  now: number,
  threshold = DUE_THRESHOLD,
): SkillState {
  if (correct) {
    const target = effectiveDueThreshold(threshold);
    const spacingCredit =
      prev.halfLifeDays <= 0
        ? 1
        : Math.max(0, Math.min(1, (1 - retention(prev, now)) / (1 - target)));
    const growth = 1 + (HALFLIFE_GROWTH - 1) * spacingCredit;
    const halfLifeDays = prev.halfLifeDays <= 0 ? 1 : prev.halfLifeDays * growth;
    return {
      repetition: prev.repetition + 1,
      halfLifeDays,
      lastPracticedAt: now,
    };
  }
  return {
    repetition: prev.repetition,
    halfLifeDays: Math.max(MIN_HALFLIFE_DAYS, prev.halfLifeDays * HALFLIFE_LAPSE),
    lastPracticedAt: now,
  };
}

export type GraphEdge = {
  fromKey: string;
  toKey: string;
  /**
   * Optional prerequisite-strength weight in (0,1] (FIRe, §4A). Ignored by
   * frontier/selection; consumed only by implicit-credit propagation and the
   * review-compression sort. Absent → the implicit-credit default.
   */
  weight?: number;
};

const retentionTargetCache = new Map<string, ReadonlyMap<string, number>>();

function retentionTargetCacheKey(skillKeys: readonly string[], edges: readonly GraphEdge[]): string {
  const edgeKey = edges
    .map((edge) => `${edge.fromKey}->${edge.toKey}`)
    .sort()
    .join("|");
  return `${skillKeys.join("|")}::${edgeKey}`;
}

/**
 * Per-skill desired-retention targets from graph fan-out (Phase 2):
 *  - high-fanout foundation (top quartile, or >= 8 transitive dependents): 0.90
 *  - leaf/enrichment (0 dependents): 0.80
 *  - default middle: 0.85
 *
 * Pure and structurally memoized; edge weights do not affect fan-out.
 */
export function desiredRetentionTargets(
  skillKeys: readonly string[],
  edges: readonly GraphEdge[],
): ReadonlyMap<string, number> {
  const cacheKey = retentionTargetCacheKey(skillKeys, edges);
  const cached = retentionTargetCache.get(cacheKey);
  if (cached) return cached;

  const skillSet = new Set(skillKeys);
  const dependents = new Map<string, string[]>();
  for (const key of skillKeys) dependents.set(key, []);
  for (const edge of edges) {
    if (!skillSet.has(edge.toKey)) continue;
    const list = dependents.get(edge.fromKey);
    if (list) list.push(edge.toKey);
  }

  const dependentCount = new Map<string, number>();
  for (const key of skillKeys) {
    const seen = new Set<string>();
    const stack = [...(dependents.get(key) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (!skillSet.has(next) || seen.has(next)) continue;
      seen.add(next);
      stack.push(...(dependents.get(next) ?? []));
    }
    dependentCount.set(key, seen.size);
  }

  const sortedCounts = skillKeys
    .map((key) => dependentCount.get(key) ?? 0)
    .sort((a, b) => b - a);
  const topQuartileSize = Math.max(1, Math.ceil(skillKeys.length / 4));
  // The dependent-count value at the top-quartile boundary. When it lands at 0
  // (a sparse graph where fewer than a quartile of nodes have ANY dependents),
  // the quartile is degenerate — a `count >= 0` test would promote every non-leaf
  // to the foundation target — so the quartile rule is disabled and only the
  // absolute `>= FOUNDATION_DEPENDENT_COUNT` rule can promote.
  const topQuartileCutoff =
    sortedCounts[Math.min(topQuartileSize - 1, sortedCounts.length - 1)] ?? Infinity;

  const targets = new Map<string, number>();
  for (const key of skillKeys) {
    const count = dependentCount.get(key) ?? 0;
    if (count === 0) {
      targets.set(key, LEAF_RETENTION_TARGET);
    } else if (
      count >= FOUNDATION_DEPENDENT_COUNT ||
      (topQuartileCutoff > 0 && count >= topQuartileCutoff)
    ) {
      targets.set(key, FOUNDATION_RETENTION_TARGET);
    } else {
      targets.set(key, DEFAULT_RETENTION_TARGET);
    }
  }

  retentionTargetCache.set(cacheKey, targets);
  return targets;
}

/**
 * The frontier: skills a learner can start NOW — not yet fluent, but every
 * prerequisite is fluent+. This is the gate that makes practice (and gated
 * cross-domain leaps) prereq-aware. `stateOf` returns the current state for a
 * skill key (a not-yet-touched skill has repetition 0).
 */
export function computeFrontier(
  skillKeys: string[],
  edges: GraphEdge[],
  stateOf: (key: string) => SkillState,
): string[] {
  const prereqs = new Map<string, string[]>();
  for (const key of skillKeys) prereqs.set(key, []);
  for (const e of edges) {
    if (prereqs.has(e.toKey)) prereqs.get(e.toKey)!.push(e.fromKey);
  }
  return skillKeys.filter((key) => {
    if (isFluentPlus(stateOf(key))) return false; // already past the frontier
    return (prereqs.get(key) ?? []).every((p) => isFluentPlus(stateOf(p)));
  });
}

// ── Multi-strand scheduling (roadmap §2) ──────────────────────────────────
// A "strand" is a sub-thread within a domain (counting · place-value ·
// add-subtract · mult-divide · number-theory for whole-number arithmetic). One
// scholar has many open strand frontiers at once; the scheduler balances breadth
// across them without starving depth. See review/practice/practice-engine-
// roadmap.html §2 ("How nextPractice picks across many open frontiers").

export type NextPracticeReason = "review" | "new" | "remediation" | "challenge";

export type NextPracticeItem = {
  key: string;
  reason: NextPracticeReason;
  /** The skill's strand ("" is the single default strand of an unstranded domain). */
  strand: string;
};

export type NextPracticeOptions = {
  /**
   * Maps a skill key to its strand. Absent, or returning undefined, means the
   * skill belongs to the single default strand — which degrades the whole
   * algorithm to the original single-track behavior (due reviews, then frontier).
   */
  strandOf?: (key: string) => string | undefined;
  /**
   * Per-strand "last served" timestamp — the caller computes it as
   * MAX(updatedAt) GROUP BY strand over the scholar's mastery rows. Drives the
   * least-recently-served round-robin (rule 2). A strand missing here has never
   * been served, so it sorts first (most overdue for attention).
   */
  lastServedByStrand?: ReadonlyMap<string, number> | Record<string, number>;
  /**
   * Scholar hint (rule 4, optional): "I want multiplication today". The hinted
   * strand jumps the round-robin queue AND receives ×2 interleave weight — but
   * never overrides due reviews.
   */
  hintStrand?: string;
  /**
   * Ambient teacher-set checkpoint for default adaptive NEW work. A present
   * strand is force-activated when capacity remains and receives the same ×2
   * weight as a scholar hint. With no strand, the checkpoint applies no strand
   * force/weight. In both cases an exact grade match is only a final tiebreak
   * after readiness and due coverage. Reviews and every hard filter ignore it.
   */
  preferredCheckpoint?: { strand?: string; grade: string };
  /**
   * Teacher pin (roadmap §10): the node the teacher wants this scholar pointed
   * at next. When it's a frontier skill it is hoisted to the front of the NEW
   * picks (still after any due reviews) and its strand is force-activated.
   */
  focusSkillKey?: string;
  /**
   * Session-breadth cap (roadmap §2): the max number of distinct strands drawn
   * from for NEW frontier work in one call. Default 2 — "a 12-item session that
   * touches 6 strands leaves the kid nowhere". Due reviews are cross-strand and
   * NOT subject to this cap. Forced strands (teacher focus / scholar hint) are
   * always active even if that exceeds the cap.
   */
  maxActiveStrands?: number;
  /**
   * Standing-practice exclusion (roadmap §10): strands a scholar must NEVER be
   * served from — the teacher's `practiceConfig.excludedStrands`. Applies to
   * BOTH due reviews and new frontier work: an excluded strand is entirely
   * off-limits as a served item. Excluded skills are still visible to prereq
   * gating (they can satisfy a prerequisite for a non-excluded frontier skill);
   * they're just filtered out of what's actually served. An empty/absent list
   * excludes nothing, so this is a no-op for ordinary (non-standing) practice.
   */
  excludedStrands?: readonly string[];
  /**
   * Focus-mode strand allowlist for NEW frontier work only. Due reviews remain
   * cross-strand so locking a strand never abandons retention work already
   * started there. Challenge, calibration, and inferred-confirmation picks use
   * the same gate. An empty list means reviews-only.
   *
   * A valid `focusSkillKey` is deliberately exempt: an explicit teacher gesture
   * outranks the ambient focus gate. This is distinct from `excludedStrands`,
   * whose hard prohibition still drops reviews and teacher pins alike.
   */
  frontierAllowedStrands?: readonly string[];
  /**
   * Session-mix floor (raise-the-ceiling plan §8): guarantee a session is
   * never 100% review. When true, and the frontier is non-empty, at least
   * `ceil(limit / 4)` of the returned slots are reserved for frontier ("new")
   * items — reviews keep absolute priority for the REMAINING slots
   * (most-decayed-first), and any review overflow simply spills to the next
   * session (a decay model expects that: still most-decayed tomorrow).
   * Default false — a SCOPED session (an explicit skillKeys set for
   * teacher-prescribed / misconception practice) must keep its scope and NOT
   * have the floor imposed, so only the whole-graph adaptive caller opts in.
   */
  applyMixFloor?: boolean;
  /**
   * Per-skill desired-retention target. Absent/invalid values fall back to
   * `DUE_THRESHOLD`, preserving the original single-threshold scheduler.
   */
  retentionThresholdOf?: (key: string) => number | undefined;
  /**
   * Repetition compression (FIRe, §4A). When true, the due-reviews list is
   * re-ordered by "cover count" — the number of OTHER due skills a review would
   * implicitly refresh (its due prerequisites, via `ancestorWeights` over the
   * `edges`) — descending, retention-ascending as tiebreak. Serving the deepest
   * due skill first means one explicit review knocks out the most other due
   * reviews the moment it's answered correctly. Reviews-first priority and the
   * review budget are untouched. Default false.
   */
  compressReviews?: boolean;
  /**
   * Apply the same due-coverage idea to FRONTIER ordering: among equally-ready
   * frontier candidates, prefer the one whose ancestor cone contains more
   * currently-due skills. Defaults to `compressReviews`; exposed separately so
   * eval scenarios can compare Phase 1 (review compression only) to Phase 2.
   */
  compressFrontierReviews?: boolean;
  /**
   * Auto-remediation (§5). The pinpointed prerequisite of a flagged node to
   * serve automatically. When set (and it's a real, non-excluded skill not
   * already in the due list), it is appended to the reviews channel — AFTER
   * real due reviews and any compression sort — with reason `"remediation"`.
   * It is injected regardless of retention (the target is usually below the
   * frontier and not itself "due"). The caller passes this only when NO teacher
   * pin is set (a pin fully disables remediation). Default undefined.
   */
  remediationSkillKey?: string;
  /**
   * Grade-band helper for frontier NEW work. A missing/unparseable grade is
   * band-exempt (served exactly as before). Reviews, confirmation, and
   * remediation never consult this.
   */
  gradeOf?: (key: string) => string | undefined;
  /**
   * Final daily-serving ceiling as a grade ordinal ("K"=0, "1"=1...). Frontier
   * nodes above this are withheld from normal lanes and appended as a bounded
   * `reason: "challenge"` overflow. Absent with `gradeOf` => no band.
   */
  scholarBandCeiling?: number;
  /**
   * Optional per-key widening over `scholarBandCeiling` (used by callers to
   * honor the acceleration valve per strand without changing the public scalar).
   */
  bandCeilingOf?: (key: string, baseCeiling: number) => number | undefined;
  /** Cap for the challenge overflow. Defaults to `CHALLENGE_OVERFLOW_CAP`. */
  challengeOverflowCap?: number;
  /**
   * Keys that must not be mixed into the REQUIRED frontier set for this call.
   * They are demoted to the optional challenge tail instead, so a "not yet"
   * placement signal becomes a teaching candidate, not a required probe.
   */
  requiredExcludedSkillKeys?: readonly string[] | ReadonlySet<string>;
  /**
   * Confirmation lane (placement-v2). Classifies a DUE skill as an INFERRED
   * credit never genuinely attempted — `source ∉ DEMONSTRATED_SOURCES` AND no
   * real attempt (`lastAttemptAt` unset; `lastPracticedAt` is inflated by
   * placement/reprobe inserts, so it's NOT the honest signal). The problem this
   * solves: placement credits a whole prefix on a short (4-day) leash, so ~day 3
   * the ENTIRE placed set crosses `DUE_THRESHOLD` at once and floods sessions
   * with easy review of skills the kid just placed out of. When set, such due
   * rows are routed into a METERED confirmation lane (`confirmationLaneCap` per
   * session, interleaved with frontier, never eating the frontier mix-floor)
   * instead of the ordinary uncapped review channel — so a freshly-placed
   * scholar's session stays frontier-dominant with a small confirmation trickle.
   * DEMONSTRATED due reviews (real attempts, incl. a placement row that was
   * attempted-and-MISSED — `source` still inferred but `lastAttemptAt` set) keep
   * full priority: real spaced repetition is sacred. A correct confirmation
   * attempt promotes the row exactly as any practice attempt does today
   * (`recordAttemptCore` flips `source`→"practice"); a miss shrinks it. Absent
   * this classifier → NO metering (byte-identical to the prior behavior).
   */
  inferredDueCredit?: (key: string) => boolean;
  /**
   * Max inferred-due rows the confirmation lane serves in ONE session (default
   * `CONFIRMATION_LANE_CAP`). Only meaningful alongside `inferredDueCredit`.
   */
  confirmationLaneCap?: number;
  /**
   * First post-placement REQUIRED lane (raise-the-ceiling). Usually the top
   * CREDITED placement skills to confirm; when placement credited nothing, the
   * caller supplies honest unmastered frontier foundations instead. The latter
   * are teaching starts, not inferred credit. Both are band/exclusion-exempt,
   * runnable, ordered by the caller, and present only for the first block.
   */
  calibrationSkillKeys?: readonly string[] | ReadonlySet<string>;
};

/**
 * The per-session cap on the inferred confirmation lane — small on purpose: a
 * freshly-placed scholar should mostly see NEW frontier work, with a sprinkle of
 * "let's just confirm you really know this" from the placement set, not a review
 * block. Inferred-due beyond the cap spills to the next session (a decay model
 * expects that — still due tomorrow).
 */
export const CONFIRMATION_LANE_CAP = 2;

/** Sentinel strand for an unstranded (single-track) domain. */
export const DEFAULT_STRAND = "";
export const DEFAULT_MAX_ACTIVE_STRANDS = 2;
/** The round-robin weight a scholar-hinted strand gets (rule 4: ×2). */
export const HINT_STRAND_WEIGHT = 2;

function readLastServed(
  table: ReadonlyMap<string, number> | Record<string, number> | undefined,
  strand: string,
): number {
  if (!table) return -Infinity;
  const v = table instanceof Map ? table.get(strand) : (table as Record<string, number>)[strand];
  return v === undefined ? -Infinity : v;
}

/** Stable descending sort by frontier score tuple (equal scores keep input order). */
function stableSortFrontierKeys(
  keys: string[],
  score: (key: string) => {
    readiness: number;
    dueCoverage: number;
    checkpointExact?: number;
  },
): string[] {
  return keys
    .map((key, i) => ({ key, i, s: score(key) }))
    .sort(
      (a, b) =>
        b.s.readiness - a.s.readiness ||
        b.s.dueCoverage - a.s.dueCoverage ||
        (b.s.checkpointExact ?? 0) - (a.s.checkpointExact ?? 0) ||
        a.i - b.i,
    )
    .map((d) => d.key);
}

/**
 * Weighted round-robin interleave of per-strand queues: one "round" gives each
 * active strand `weightOf(strand)` picks, in `activeStrands` order (which is
 * least-recently-served first). A hinted strand's weight 2 makes it appear
 * twice as often — round-robin breadth, not one track drained to the bottom.
 */
function interleaveStrands(
  activeStrands: string[],
  byStrand: Map<string, string[]>,
  weightOf: (strand: string) => number,
): string[] {
  const idx = new Map<string, number>(activeStrands.map((s) => [s, 0]));
  const out: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const strand of activeStrands) {
      const list = byStrand.get(strand) ?? [];
      const weight = weightOf(strand);
      for (let n = 0; n < weight; n++) {
        const i = idx.get(strand)!;
        if (i < list.length) {
          out.push(list[i]);
          idx.set(strand, i + 1);
          progressed = true;
        }
      }
    }
  }
  return out;
}

/**
 * The next-practice queue for a scholar on a domain, balanced across strands.
 * Priority (roadmap §2):
 *   1. Due reviews — any strand, most-decayed first (retention < DUE_THRESHOLD).
 *   2. Strand balance — among frontier skills, serve the least-recently-served
 *      strand first (round-robin breadth).
 *   3. Most-ready-within-strand — the frontier skill with the most prerequisites
 *      already fluent (deepest-built, shallowest remaining dependency).
 *   4. Scholar hint — a requested strand gets ×2 weight (never over due reviews).
 * A `maxActiveStrands` cap bounds NEW-work breadth. `focusSkillKey` lets a
 * teacher pin the next frontier skill. `excludedStrands` (standing practice)
 * removes whole strands from what's served — reviews and frontier alike. With
 * no strand info this reduces exactly to the original single-track "due
 * reviews, then frontier" behavior.
 */
export function nextPractice(
  skillKeys: string[],
  edges: GraphEdge[],
  stateOf: (key: string) => SkillState,
  now: number,
  limit = 5,
  options: NextPracticeOptions = {},
): NextPracticeItem[] {
  const {
    strandOf,
    lastServedByStrand,
    hintStrand,
    preferredCheckpoint,
    focusSkillKey,
    maxActiveStrands = DEFAULT_MAX_ACTIVE_STRANDS,
    excludedStrands,
    frontierAllowedStrands,
    applyMixFloor = false,
    compressReviews = false,
    compressFrontierReviews = compressReviews,
    remediationSkillKey,
    gradeOf,
    scholarBandCeiling,
    bandCeilingOf,
    challengeOverflowCap = CHALLENGE_OVERFLOW_CAP,
    requiredExcludedSkillKeys,
    inferredDueCredit,
    confirmationLaneCap = CONFIRMATION_LANE_CAP,
    retentionThresholdOf,
    calibrationSkillKeys,
  } = options;

  const strandFor = (key: string): string => {
    const s = strandOf?.(key);
    return s == null ? DEFAULT_STRAND : s;
  };

  // Standing-practice exclusion: strands that must never be served. Applied to
  // both due reviews and new frontier work below (excluded skills still count
  // for prereq gating in computeFrontier — they're only dropped from output).
  const excludedSet = new Set(excludedStrands ?? []);
  const isExcludedKey = (key: string): boolean => excludedSet.has(strandFor(key));
  const frontierAllowedSet =
    frontierAllowedStrands === undefined
      ? undefined
      : new Set(frontierAllowedStrands);
  const isFrontierAllowedKey = (key: string): boolean =>
    frontierAllowedSet === undefined ||
    frontierAllowedSet.has(strandFor(key)) ||
    key === focusSkillKey;
  const thresholdFor = (key: string): number => effectiveDueThreshold(retentionThresholdOf?.(key));
  const skillSet = new Set(skillKeys);
  const requiredExcludedSet =
    requiredExcludedSkillKeys === undefined
      ? new Set<string>()
      : new Set(
          Array.isArray(requiredExcludedSkillKeys)
            ? requiredExcludedSkillKeys
            : [...requiredExcludedSkillKeys],
        );

  // ── Rule 1: due reviews, any strand, most-decayed first. Cross-strand and
  //    uncapped — a fading fact is absolute and beats any shiny new frontier.
  //    Excluded strands are dropped even here: an off-limits strand is never
  //    served, review or not. ──
  const reviews: NextPracticeItem[] = skillKeys
    .filter((k) => isDue(stateOf(k), now, thresholdFor(k)) && !isExcludedKey(k))
    .sort((a, b) => retention(stateOf(a), now) - retention(stateOf(b), now))
    .map((key) => ({ key, reason: "review" as const, strand: strandFor(key) }));

  // Repetition compression (FIRe §4A): re-order the due reviews so the one that
  // implicitly refreshes the most OTHER due skills is served first. A review's
  // "cover count" is how many other due skills are among its prerequisites
  // (`ancestorWeights` — the skills a correct answer here would trickle credit
  // to). Ties fall back to most-decayed-first (the pre-compression order).
  if (compressReviews && reviews.length > 1) {
    const dueKeys = new Set(reviews.map((r) => r.key));
    const coverCount = new Map<string, number>();
    for (const r of reviews) {
      let n = 0;
      for (const key of ancestorWeights(r.key, edges).keys()) {
        if (key !== r.key && dueKeys.has(key)) n += 1;
      }
      coverCount.set(r.key, n);
    }
    reviews.sort((a, b) => {
      const byCover = (coverCount.get(b.key) ?? 0) - (coverCount.get(a.key) ?? 0);
      if (byCover !== 0) return byCover;
      return retention(stateOf(a.key), now) - retention(stateOf(b.key), now);
    });
  }

  // ── Auto-remediation (§5): a pinpointed prerequisite of a flagged node,
  //    appended to the reviews channel AFTER real due reviews (and any
  //    compression sort). It flows like a review from here on (subject to the
  //    same review budget), but is injected regardless of retention — the
  //    target is usually below the frontier and not itself due. Never a
  //    duplicate of an already-due skill, never an excluded strand, and only a
  //    skill that actually exists in this graph. ──
  if (
    remediationSkillKey !== undefined &&
    skillKeys.includes(remediationSkillKey) &&
    !isExcludedKey(remediationSkillKey) &&
    isFrontierAllowedKey(remediationSkillKey) &&
    !reviews.some((r) => r.key === remediationSkillKey)
  ) {
    reviews.push({
      key: remediationSkillKey,
      reason: "remediation",
      strand: strandFor(remediationSkillKey),
    });
  }

  // ── Frontier (new work): prereq-gated skills not yet fluent. Excluded
  //    strands are filtered out of what's served (but still gate, above). ──
  const rawFrontier = computeFrontier(skillKeys, edges, stateOf).filter(
    (key) => !isExcludedKey(key) && isFrontierAllowedKey(key),
  );

  // Prereq adjacency for the most-ready tiebreak (rule 3).
  const prereqs = new Map<string, string[]>();
  for (const key of skillKeys) prereqs.set(key, []);
  for (const e of edges) if (prereqs.has(e.toKey)) prereqs.get(e.toKey)!.push(e.fromKey);
  const fluentPrereqCount = (key: string): number =>
    (prereqs.get(key) ?? []).reduce((n, p) => n + (isFluentPlus(stateOf(p)) ? 1 : 0), 0);

  const bandActive =
    gradeOf !== undefined &&
    scholarBandCeiling !== undefined &&
    Number.isFinite(scholarBandCeiling);
  const normalFrontier: string[] = [];
  const challengeFrontier: string[] = [];
  for (const key of rawFrontier) {
    const requiredExcluded = requiredExcludedSet.has(key);
    const keyGrade = bandActive ? gradeOrdinal(gradeOf?.(key)) : undefined;
    const effectiveCeiling =
      bandActive && scholarBandCeiling !== undefined
        ? (bandCeilingOf?.(key, scholarBandCeiling) ?? scholarBandCeiling)
        : undefined;
    if (
      requiredExcluded ||
      key !== focusSkillKey &&
      !isDue(stateOf(key), now, thresholdFor(key)) &&
      keyGrade !== undefined &&
      effectiveCeiling !== undefined &&
      Number.isFinite(effectiveCeiling) &&
      keyGrade > effectiveCeiling
    ) {
      challengeFrontier.push(key);
    } else {
      // A teacher-pinned frontier skill is band-EXEMPT, but not exempt from an
      // explicit required-exclusion (first post-placement don't-know skills).
      // Locked/excluded pins remain no-ops elsewhere.
      normalFrontier.push(key);
    }
  }

  // ── Structural challenge tail — one-hop widening (the #735 finding) ────────
  // The above-band tail is fed by `rawFrontier`, which requires EVERY prereq
  // fluent-plus. But for a strong learner the ceiling rises in lockstep with the
  // frontier: an above-band key's prereqs sit AT the current frontier (being
  // practiced, not yet fluent), so no above-band key reaches `rawFrontier` and
  // `challengeFrontier` is (near-)always empty — leaving the opt-in "challenge"
  // offer permanently dark. When (and only when) the structural tail is empty,
  // reach exactly ONE hop past the reachable frontier: admit an above-band key
  // whose every prereq is fluent-plus OR itself on `rawFrontier`. This fills the
  // EXISTING gate's empty input — same `prereqs`/`effectiveCeiling`/order/cap and
  // the same `reason: "challenge"` tag — it does not add a second gate. Reused
  // and capped by the challenge machinery below, so it never crowds normal work.
  if (bandActive && challengeFrontier.length === 0) {
    const onFrontier = new Set(rawFrontier);
    for (const key of skillKeys) {
      if (
        isExcludedKey(key) ||
        !isFrontierAllowedKey(key) ||
        isFluentPlus(stateOf(key)) ||
        onFrontier.has(key)
      ) continue;
      const keyGrade = gradeOrdinal(gradeOf?.(key));
      const effectiveCeiling =
        scholarBandCeiling !== undefined
          ? (bandCeilingOf?.(key, scholarBandCeiling) ?? scholarBandCeiling)
          : undefined;
      if (
        keyGrade === undefined ||
        effectiveCeiling === undefined ||
        !Number.isFinite(effectiveCeiling) ||
        keyGrade <= effectiveCeiling
      ) {
        continue;
      }
      const keyPrereqs = prereqs.get(key) ?? [];
      if (
        keyPrereqs.length > 0 &&
        keyPrereqs.every((p) => isFluentPlus(stateOf(p)) || onFrontier.has(p))
      ) {
        challengeFrontier.push(key);
      }
    }
  }

  const orderFrontierKeys = (
    candidates: string[],
    allowFocus: boolean,
    allowCheckpoint: boolean,
  ): { keys: string[]; focusIsFrontier: boolean } => {
    // Group frontier by strand; within each strand, most-ready first (stable, so
    // equal-readiness keeps input/topological order).
    const byStrand = new Map<string, string[]>();
    for (const key of candidates) {
      const s = strandFor(key);
      const list = byStrand.get(s);
      if (list) list.push(key);
      else byStrand.set(s, [key]);
    }
    const dueCoverage = (key: string): number => {
      if (!compressFrontierReviews) return 0;
      let n = 0;
      for (const ancestorKey of ancestorWeights(key, edges).keys()) {
        if (
          skillSet.has(ancestorKey) &&
          isDue(stateOf(ancestorKey), now, thresholdFor(ancestorKey))
        ) {
          n += 1;
        }
      }
      return n;
    };
    for (const [s, list] of byStrand) {
      byStrand.set(
        s,
        stableSortFrontierKeys(list, (key) => ({
          readiness: fluentPrereqCount(key),
          dueCoverage: dueCoverage(key),
          checkpointExact:
            allowCheckpoint &&
            preferredCheckpoint !== undefined &&
            (preferredCheckpoint.strand === undefined ||
              s === preferredCheckpoint.strand) &&
            gradeOf?.(key) === preferredCheckpoint.grade
              ? 1
              : 0,
        })),
      );
    }

    // Is the teacher pin actually a normal frontier skill? (A locked,
    // already-fluent, excluded, or challenge-only pin is a no-op for normal work.)
    const focusIsFrontier =
      allowFocus &&
      focusSkillKey !== undefined &&
      (byStrand.get(strandFor(focusSkillKey))?.includes(focusSkillKey) ?? false);

    // ── Rule 2 + cap: choose the active strands. Forced strands (teacher focus,
    //    then scholar hint) are always active; the rest fill by least-recently-
    //    served, up to the cap. ──
    const forced: string[] = [];
    if (focusIsFrontier) forced.push(strandFor(focusSkillKey!));
    if (hintStrand !== undefined && byStrand.has(hintStrand) && !forced.includes(hintStrand)) {
      forced.push(hintStrand);
    }
    if (
      allowCheckpoint &&
      preferredCheckpoint !== undefined &&
      preferredCheckpoint.strand !== undefined &&
      byStrand.has(preferredCheckpoint.strand) &&
      !forced.includes(preferredCheckpoint.strand) &&
      forced.length < maxActiveStrands
    ) {
      forced.push(preferredCheckpoint.strand);
    }
    const rest = [...byStrand.keys()]
      .filter((s) => !forced.includes(s))
      .sort((a, b) => readLastServed(lastServedByStrand, a) - readLastServed(lastServedByStrand, b));
    const active: string[] = [...forced];
    for (const s of rest) {
      if (active.length >= maxActiveStrands) break;
      active.push(s);
    }

    // Weighted round-robin (rule 4: hinted strand ×2).
    const weightOf = (strand: string): number =>
      strand === hintStrand ||
      (allowCheckpoint &&
        preferredCheckpoint?.strand !== undefined &&
        strand === preferredCheckpoint.strand)
        ? HINT_STRAND_WEIGHT
        : 1;
    let keys = interleaveStrands(active, byStrand, weightOf);

    // Teacher pin: hoist the focused skill to the very front of the NEW picks.
    if (focusIsFrontier) {
      const fk = focusSkillKey!;
      keys = [fk, ...keys.filter((k) => k !== fk)];
    }
    return { keys, focusIsFrontier };
  };

  const { keys: frontierKeys } = orderFrontierKeys(
    normalFrontier,
    true,
    true,
  );
  const challengeActive = bandActive || requiredExcludedSet.size > 0;
  const challengeKeys = challengeActive
    ? orderFrontierKeys(challengeFrontier, false, false).keys.slice(0, Math.max(0, challengeOverflowCap))
    : [];

  const frontierItems: NextPracticeItem[] = frontierKeys.map((key) => ({
    key,
    reason: "new" as const,
    strand: strandFor(key),
  }));
  const challengeItems: NextPracticeItem[] = challengeKeys.map((key) => ({
    key,
    reason: "challenge" as const,
    strand: strandFor(key),
  }));

  // ── First post-placement REQUIRED lane (raise-the-ceiling): confirm the top
  //    inferred placement credit when it exists; otherwise teach from the honest
  //    unmastered frontier foundations selected by the caller. Required-lane
  //    membership outranks challenge classification for this ONE block, so an
  //    all-"not yet" placement cannot strand its runnable foundation behind the
  //    optional challenge tail. This lane only schedules; it grants no credit. ──
  const calibrationItems: NextPracticeItem[] = [];
  if (calibrationSkillKeys !== undefined) {
    const ordered = Array.isArray(calibrationSkillKeys)
      ? calibrationSkillKeys
      : [...calibrationSkillKeys];
    const alreadyQueued = new Set<string>([
      ...frontierItems.map((f) => f.key),
    ]);
    for (const key of ordered) {
      if (
        !skillSet.has(key) ||
        isExcludedKey(key) ||
        !isFrontierAllowedKey(key) ||
        reviews.some(
          (review) =>
            review.key === key &&
            !(review.reason === "review" && (inferredDueCredit?.(key) ?? false)),
        ) ||
        alreadyQueued.has(key)
      ) continue;
      alreadyQueued.add(key);
      calibrationItems.push({ key, reason: "new", strand: strandFor(key) });
    }
  }
  const collidingCalibrationKeys = new Set(
    calibrationItems
      .filter((item) =>
        reviews.some(
          (review) =>
            review.key === item.key &&
            review.reason === "review" &&
            (inferredDueCredit?.(item.key) ?? false),
        ),
      )
      .map((item) => item.key),
  );
  // Keep ordinary first-block ordering for the lane's normal accounting.
  const newLane: NextPracticeItem[] = [...frontierItems, ...calibrationItems];

  // ── Confirmation lane (placement-v2): partition due reviews into DEMONSTRATED
  //    (real attempts — sacred spaced repetition) and an INFERRED lane
  //    (placement/accel/reprobe credit never genuinely attempted). Demonstrated
  //    reviews keep today's priority; the inferred lane is METERED so a
  //    freshly-placed scholar isn't flooded with easy review of skills they just
  //    placed out of — frontier gets the freed slots. Only `reason: "review"`
  //    rows are ever metered: a remediation row is a teacher-driven prereq, not
  //    inferred placement credit, so it stays in the priority lane. Absent the
  //    `inferredDueCredit` classifier → nothing is metered (identical to the
  //    prior reviews-first behavior). ──
  const isConfirmationItem = (item: NextPracticeItem): boolean =>
    item.reason === "review" && (inferredDueCredit?.(item.key) ?? false);
  const priorityReviews = reviews.filter((r) => !isConfirmationItem(r));
  const confirmationReviews = reviews.filter(
    (r) =>
      isConfirmationItem(r) &&
      isFrontierAllowedKey(r.key) &&
      !collidingCalibrationKeys.has(r.key),
  );

  // ── Merge: priority reviews first, then a frontier-dominant body with the
  //    confirmation lane sprinkled in. Dedupe; cap at `limit`.
  //    When `applyMixFloor` is set (plan §8), reserve a frontier floor —
  //    `ceil(limit / 4)` slots — so a session is never 100% review, without
  //    ever dropping below that floor OR exceeding `limit`. Priority (demonstrated
  //    + remediation) reviews win absolute priority for the review budget
  //    (most-decayed-first); a review that doesn't fit spills to the next
  //    session unchanged. ──
  const floor = applyMixFloor && newLane.length > 0 ? Math.ceil(limit / 4) : 0;
  const frontierReserve = Math.min(floor, newLane.length);
  const reviewBudget = Math.max(0, limit - frontierReserve);

  const seen = new Set<string>();
  const out: NextPracticeItem[] = [];

  // 1. Priority (demonstrated + remediation) reviews — most-decayed-first.
  for (const item of priorityReviews) {
    if (out.length >= reviewBudget) break;
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }

  // 2. Confirmation lane + frontier for the remaining slots. The lane may only
  //    use slots BEYOND the reserved frontier floor and is capped at
  //    `confirmationLaneCap`, so the mix floor still protects frontier from
  //    BOTH review kinds. Frontier keeps the rest → frontier-dominant.
  const remaining = Math.max(0, limit - out.length);
  const laneRoom = Math.max(0, remaining - frontierReserve);
  const laneCount = Math.min(confirmationLaneCap, confirmationReviews.length, laneRoom);
  const frontierCount = Math.max(0, remaining - laneCount);
  const laneSlice = confirmationReviews.slice(0, laneCount);
  // Preserve the genuine-frontier floor before serving colliding calibrations.
  // Past that reserve, a calibration whose confirmation twin was removed gets
  // the next required slot rather than disappearing behind ordinary frontier.
  const realFrontierReserve = Math.min(frontierReserve, frontierItems.length);
  const requiredLane = [
    ...frontierItems.slice(0, realFrontierReserve),
    ...calibrationItems.filter((item) => collidingCalibrationKeys.has(item.key)),
    ...frontierItems.slice(realFrontierReserve),
    ...calibrationItems.filter((item) => !collidingCalibrationKeys.has(item.key)),
  ];
  const frontierSlice = requiredLane.slice(0, frontierCount);
  for (const item of interleaveConfirmationLane(frontierSlice, laneSlice)) {
    if (out.length >= limit) break;
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }

  // 3. Backfill any still-empty slots (dedupe/scarcity): leftover frontier first
  //    (keeps the session frontier-dominant), then leftover priority reviews.
  //    Inferred confirmations never backfill: without frontier, a short honest
  //    block is better than reviving a placement-review flood past the cap.
  if (out.length < limit) {
    for (const item of [...newLane, ...priorityReviews]) {
      if (out.length >= limit) break;
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      out.push(item);
    }
  }
  for (const item of challengeItems) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/**
 * Interleave the (small) confirmation lane into the frontier body so the two are
 * spread rather than block-stacked — one lane item roughly every `gap` frontier
 * items, frontier leading. Both lists are pre-sized by the caller (laneCount +
 * frontierCount == the slots to fill), so every element is kept; this only
 * decides ORDER. With an empty lane it returns the frontier unchanged.
 */
function interleaveConfirmationLane(
  frontier: NextPracticeItem[],
  lane: NextPracticeItem[],
): NextPracticeItem[] {
  if (lane.length === 0) return frontier;
  if (frontier.length === 0) return lane;
  const gap = Math.max(1, Math.floor(frontier.length / lane.length));
  const out: NextPracticeItem[] = [];
  let li = 0;
  let sinceLane = 0;
  for (let fi = 0; fi < frontier.length; fi++) {
    out.push(frontier[fi]);
    sinceLane++;
    if (li < lane.length && sinceLane >= gap) {
      out.push(lane[li++]);
      sinceLane = 0;
    }
  }
  while (li < lane.length) out.push(lane[li++]); // any remainder (frontier ran out)
  return out;
}
