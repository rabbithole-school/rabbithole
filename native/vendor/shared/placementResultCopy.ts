/**
 * Scholar-facing PLACEMENT / mapping END copy — SKILL-anchored, never
 * grade-anchored.
 *
 * Ruling J3 (pilot9 judgment queue, Option A): the mapping/check-in END screen
 * used to read "You're starting at Grade 2" while the Tree simultaneously marked
 * "You are here" at the scholar's real frontier (~grade 5) — two conflicting
 * stories of where the kid stands. A grade number is a TEACHER-facing concept: it
 * both fights the Tree's own "you are here" and can sting a scholar. So the end
 * copy names the SKILL she is starting from — her leading frontier, the SAME
 * "you are here" node the Tree already shows — and carries NO grade token. Any
 * grade signal stays teacher-facing only (dashboards / priors), never here.
 *
 * ON-BRAND CONTRACT (portrait, not scorecard — review/anti-parasocial-design.md,
 * review/learner-parent-pedagogy.md, and the sibling shared/closureLines.ts): the
 * line names the WORK / the place on the map, never a caliber or a number; it is a
 * warm "here's where we build next", never a verdict. Like closureLines it imports
 * NOTHING, so native vendors a read-only copy (native/vendor/shared/
 * placementResultCopy.ts) and both surfaces render the EXACT same words
 * (SCHOLAR-facing parity is a standing rule).
 */

/** A frontier-skill candidate for the "you are here" anchor. `grade` is used ONLY
 *  to RANK candidates (which frontier to name) — it is never rendered. */
export type FrontierSkill = {
  skillKey: string;
  label?: string | null;
  grade?: string | null;
};

// Soft K–9 band order — mirrors shared/treeMapLayout.ts GRADE_ORDER, inlined so
// this module stays import-free (native-vendorable). Ranking-only; never shown.
const GRADE_RANK: Record<string, number> = {
  K: 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
};

function gradeRankOf(grade: string | null | undefined): number {
  if (grade == null) return -1;
  return GRADE_RANK[grade.trim()] ?? -1;
}

/**
 * Pick the ONE skill to name on the placement END screen from the scholar's
 * frontier set. The headline must AGREE with the Tree's most-advanced
 * "you are here" — that is the whole point of the ruling — so we name the
 * FURTHEST-reached frontier (highest grade band), the single leading edge, NOT
 * the conservative credited-through grade that created the two-story conflict.
 * Deterministic tie-break by `skillKey`. Returns null only when NO frontier
 * carries a human label (all-mastered / degenerate graph) — the caller then
 * shows a warm, still-numberless fallback.
 */
export function pickStartingSkillLabel(frontier: readonly FrontierSkill[]): string | null {
  let best: { label: string; rank: number; key: string } | null = null;
  for (const f of frontier) {
    const label = f.label?.trim();
    if (!label) continue;
    const rank = gradeRankOf(f.grade);
    if (
      best === null ||
      rank > best.rank ||
      (rank === best.rank && f.skillKey < best.key)
    ) {
      best = { label, rank, key: f.skillKey };
    }
  }
  return best ? best.label : null;
}

/**
 * The placement END headline — SKILL-anchored, no grade token.
 *  • a named frontier → "You're starting at: <skill>";
 *  • no frontier but the scholar DID place through real ground (`placed`) → a
 *    warm "mapped a strong foundation" (the rare all-mastered case — never a
 *    grade, never "start from the beginning");
 *  • neither → the genuine beginner's "start from the beginning".
 */
export function placementStartHeadline(
  startingSkillLabel: string | null,
  placed: boolean,
): string {
  if (startingSkillLabel) return `You're starting at: ${startingSkillLabel}`;
  return placed ? "You've mapped a strong foundation" : "Let's start from the beginning";
}

/** The placement END body — the same warm "pick up where you're ready to grow"
 *  reassurance, unchanged in intent. Skill or already-placed → the growth line;
 *  a true beginner → the foundation line. */
export function placementStartBody(
  startingSkillLabel: string | null,
  placed: boolean,
): string {
  return startingSkillLabel || placed
    ? "We'll pick up right where you're ready to grow. You can always revisit anything earlier."
    : "We'll build a strong foundation together, step by step.";
}

/** The mixed check-in per-domain "your spots" value — the domain's frontier skill,
 *  or a warm "Starting out" when nothing placed. Never a grade. */
export function placementSpotLabel(startingSkillLabel: string | null): string {
  return startingSkillLabel ?? "Starting out";
}
