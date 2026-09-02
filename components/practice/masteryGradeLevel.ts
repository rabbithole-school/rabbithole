/**
 * masteryGradeLevel — a computed "mastery grade level" (e.g. "Grade 3.6") from
 * a scholar's GREEN skills over a set of graded knowledge nodes. Replaces the
 * green/amber band-mix meter under each avatar in the mastery matrix column
 * header (`MathSkillsMasteryView.tsx`) with a single, sortable magnitude a
 * teacher can read as "how far this scholar has gotten", rather than a mix
 * ratio.
 *
 * "GREEN" = the fluent-family mastery bands — `placed`, `fluent`, and
 * `overlearned` (see `MASTERY_FILTER_ORDER` in `mathSkillsMasteryFilters.ts`).
 * The caller supplies that judgement per node (`isGreen`); this module never
 * imports the mastery-band vocabulary, so it stays a pure, dependency-free,
 * independently-testable numeric helper.
 *
 * FORMULA — frontier interpolation, not a raw average:
 *   1. Bucket the graded nodes by grade (K=0, 1=1, …, via the caller's own
 *      `gradeRank`, matching `GRADE_RANK`/`gradeRank` in
 *      `MathSkillsMasteryView.tsx`).
 *   2. Walk grades from the bottom. Level = (the highest grade G such that
 *      grades 0..G are ALL fully green) + (the FRACTION of grade G+1's
 *      skills that are green).
 *   Example: every grade-0..3 skill green, 60% of grade-4 green ⇒ 3.6.
 *
 * This is deliberately NOT "average grade of all green skills" — a scholar
 * green on 90% of grade 5 but with a gap at grade 2 reads as held back at
 * their EARLIEST incomplete grade (2.x), the same "where's the reliable
 * floor" read a teacher actually wants, and the same frontier idea the
 * practice engine's own `computeFrontier` already applies per-skill —  here
 * applied per-GRADE to the READOUT. It is monotonic: adding a green skill (or
 * losing a not-yet-green one) never lowers the level.
 *
 * Degenerate case — not even the FIRST present grade is fully green: there is
 * no lower grade to anchor "G" on, so that first grade plays both roles — its
 * own number is the base, and its own fill fraction is the decimal (e.g. 40%
 * green in grade K alone → level 0.4, formatted as "0.4" — see
 * `formatMasteryGradeLevel`, which renders every level as a bare one-decimal
 * number on the K–8 axis (K is simply 0.x).
 *
 * Ungraded/foundational nodes (grade null, or a grade `gradeRank` maps to a
 * negative rank) are EXCLUDED entirely — there is no rung on the K–8 axis to
 * place them on. They still count toward mastery everywhere else (the matrix
 * dots, the domain report); just not this readout.
 *
 * No green skills anywhere ⇒ `null` (the caller renders a calm "—", not an
 * alarming zero).
 */

export type GradeLevelNode = {
  nodeKey: string;
  /** The node's soft grade hint (e.g. "K", "3"), or null/undefined when the
   *  node carries none. */
  grade: string | null | undefined;
};

/** One grade's raw tally — the shape a backend cross-domain rollup can hand
 *  back directly (pre-aggregated, so the frontier FORMULA still lives in
 *  exactly one place: this module, not duplicated server-side). */
export type GradeBucket = {
  grade: string;
  total: number;
  green: number;
};

/**
 * The core computation: given per-grade tallies (already aggregated, however
 * the caller obtained them) and a grade→rank ordering, compute the
 * frontier-interpolated numeric level. `null` when there is nothing gradeable
 * or nothing green at all.
 */
export function levelFromGradeBuckets(
  buckets: readonly GradeBucket[],
  gradeRank: (grade: string) => number,
): number | null {
  const ranked = buckets
    .map((bucket) => ({ ...bucket, rank: gradeRank(bucket.grade) }))
    .filter((bucket) => bucket.rank >= 0 && bucket.total > 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0) return null;

  const totalGreen = ranked.reduce((sum, bucket) => sum + bucket.green, 0);
  if (totalGreen === 0) return null;

  // Walk from the bottom; a grade only counts toward the floor once it is
  // ENTIRELY green — one hole anywhere in it (or below) keeps the floor at
  // the previous grade.
  let frontierIdx = 0;
  while (
    frontierIdx < ranked.length &&
    ranked[frontierIdx].green === ranked[frontierIdx].total
  ) {
    frontierIdx += 1;
  }

  if (frontierIdx === ranked.length) {
    // Every present grade is fully green — cap at the top grade; there's no
    // further curriculum data above it to interpolate into.
    return ranked[ranked.length - 1].rank;
  }

  // frontierIdx === 0 ⇒ not even the first present grade is complete — see
  // the degenerate case in the file header comment.
  const base = frontierIdx === 0 ? ranked[0].rank : ranked[frontierIdx - 1].rank;
  const frontier = ranked[frontierIdx];
  const fraction = frontier.total > 0 ? frontier.green / frontier.total : 0;
  return base + fraction;
}

/** One domain's pre-aggregated grade buckets — the per-domain shape the
 *  cross-domain rollup hands back so "All domains" can blend genuine
 *  per-domain levels instead of pooling every domain into one bucket set. */
export type DomainGradeBuckets = {
  domain: string;
  gradeCounts: readonly GradeBucket[];
};

/**
 * The "All domains" readout: the mean of each domain's OWN frontier level
 * (`levelFromGradeBuckets` per domain), averaged over only the domains where
 * the scholar has a computable (non-null) level.
 *
 * Why not one pooled bucket set across every domain? The frontier only
 * advances past a grade once that grade is ENTIRELY green, so pooling makes
 * the denominator span every domain's skills at a grade — a scholar would
 * have to be green in EVERY domain at grade G to credit grade G. That pins the
 * number far below every single-domain readout (typically < 1.0), which is
 * exactly the bug this replaces. Averaging genuine per-domain levels keeps
 * "All domains" inside the range of the per-domain numbers a teacher sees.
 *
 * Domains the scholar hasn't started (no green skill ⇒ null level) are left
 * OUT of the mean rather than counted as 0 — breadth shouldn't drag the
 * readout toward zero; an untouched domain is "not yet measured", not "grade
 * 0". `null` when no domain has any green skill at all.
 */
export function averageDomainMasteryLevel(
  domains: readonly DomainGradeBuckets[],
  gradeRank: (grade: string) => number,
): number | null {
  const levels = domains
    .map((entry) => levelFromGradeBuckets(entry.gradeCounts, gradeRank))
    .filter((level): level is number => level !== null);
  if (levels.length === 0) return null;
  return levels.reduce((sum, level) => sum + level, 0) / levels.length;
}

/**
 * Convenience wrapper for the common per-domain, client-side path: a flat
 * list of graded nodes + a per-node green predicate. Aggregates into
 * `GradeBucket`s, then defers to `levelFromGradeBuckets` for the formula.
 */
export function masteryGradeLevel(
  nodes: readonly GradeLevelNode[],
  isGreen: (nodeKey: string) => boolean,
  gradeRank: (grade: string | null) => number,
): number | null {
  const buckets = new Map<string, GradeBucket>();
  for (const node of nodes) {
    const grade = node.grade ?? null;
    if (grade == null) continue;
    const bucket = buckets.get(grade) ?? { grade, total: 0, green: 0 };
    bucket.total += 1;
    if (isGreen(node.nodeKey)) bucket.green += 1;
    buckets.set(grade, bucket);
  }
  return levelFromGradeBuckets([...buckets.values()], (grade) => gradeRank(grade));
}

/** K (rank 0) → "K"; every other rank → its own number, e.g. rank 3 → "3". The
 *  display-side inverse of the GRADE_RANK table (MathSkillsMasteryView.tsx). */
export function gradeLabelForRank(rank: number): string {
  return rank <= 0 ? "K" : String(Math.round(rank));
}

/**
 * Renders a computed level as the teacher-facing readout — a bare magnitude on
 * the K–8 grade axis, ALWAYS to one decimal, e.g. "3.6" or an exact "6.0". No
 * "Grade " prefix: the number is a mastery LEVEL (shown in fluent green), not a
 * chronological grade, and the prefix made it read as the latter. `null` (no
 * green skills at all) reads as a calm em-dash. Grade K is level 0.x, shown as
 * "0.0"–"0.9" like any other rung, so the column stays a uniform number.
 */
export function formatMasteryGradeLevel(level: number | null): string {
  if (level === null) return "—";
  return level.toFixed(1);
}
