/**
 * Judge ↔ teacher correlation (pure core) — the math behind sim-realism
 * adoptable #2 (review/sim-realism-lessons.html §5 #2, addressing §4 Finding 4).
 *
 * Grounding judges REAL transcripts with the curriculum judge, but the SAME
 * judge scores both the sim and the real transcript, so any judge bias cancels
 * in the calibration delta — we learn how realistic the SIM KID is, never how
 * trustworthy the JUDGE is. The paper (He-Yueya, Goodman & Brunskill, EDM 2024)
 * validated its evaluator against teachers with a pairwise-preference
 * correlation (r = 0.661). This module is that validation at our scale: a
 * teacher makes a handful of pairwise "which session went better for this kid?"
 * calls, and we correlate their picks against the judge's fitness ranking.
 *
 * Two numbers come out:
 *  - agreement — of the DECISIVE pairs (teacher AND judge both had a strict
 *    preference), the fraction where the judge's higher-fitness session matched
 *    the teacher's pick. The intuitive "how often does the judge agree with me?"
 *  - r — a Pearson correlation between the judge's fitness MARGIN (fitnessA −
 *    fitnessB, a signed magnitude) and the teacher's choice coded +1 / 0 / −1.
 *    This uses the size of the judge's preference, not just its sign, so it's
 *    the closer analogue of the paper's r.
 *
 * No Convex / no SDK imports — pure so it's unit-tested
 * (convex/__tests__/judgeCorrelation.test.ts) and importable from a query.
 */

export type TeacherChoice = "A" | "B" | "tie";

/** One judged pair the teacher compared. */
export interface PairObservation {
  /** Judge fitness margin for A over B (fitnessA − fitnessB). */
  judgeMargin: number;
  /** Which session the teacher said went better. */
  teacherChoice: TeacherChoice;
}

export interface CorrelationResult {
  /** Total comparisons considered. */
  n: number;
  /**
   * Comparisons where BOTH the teacher and the judge expressed a strict
   * preference (not a tie) — the denominator for `agreement`.
   */
  nDecisive: number;
  /** Decisive comparisons where the judge's pick matched the teacher's. */
  agreements: number;
  /** agreements / nDecisive, or null when there are no decisive pairs. */
  agreement: number | null;
  /**
   * Pearson r between judgeMargin and the teacher choice (+1/0/−1), over all n
   * comparisons. null when either series has no variance (undefined r) or n<2.
   */
  r: number | null;
  /** How many ties came from each side (diagnostic). */
  ties: { teacher: number; judge: number };
}

/** Teacher choice → numeric score. A better = +1, B better = −1, tie = 0. */
export function teacherScore(choice: TeacherChoice): number {
  return choice === "A" ? 1 : choice === "B" ? -1 : 0;
}

/** Sign of the judge margin with a small epsilon so ~0 counts as a judge tie. */
export function judgeSign(margin: number, eps = 1e-9): -1 | 0 | 1 {
  if (margin > eps) return 1;
  if (margin < -eps) return -1;
  return 0;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  // No variance in one series ⇒ correlation is undefined.
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Correlate a set of teacher pairwise picks against the judge's fitness
 * margins. `agreement` is the decisive-pair match rate; `r` is Pearson over
 * (judgeMargin, teacherScore). Both defined so a hand-built fixture has a known
 * answer (see the test).
 */
export function computeCorrelation(
  observations: PairObservation[],
): CorrelationResult {
  const n = observations.length;
  let nDecisive = 0;
  let agreements = 0;
  let teacherTies = 0;
  let judgeTies = 0;

  const judgeMargins: number[] = [];
  const teacherScores: number[] = [];

  for (const o of observations) {
    const ts = teacherScore(o.teacherChoice);
    const js = judgeSign(o.judgeMargin);
    judgeMargins.push(o.judgeMargin);
    teacherScores.push(ts);
    if (o.teacherChoice === "tie") teacherTies++;
    if (js === 0) judgeTies++;
    // Decisive = both sides picked a side.
    if (o.teacherChoice !== "tie" && js !== 0) {
      nDecisive++;
      if (js === ts) agreements++;
    }
  }

  return {
    n,
    nDecisive,
    agreements,
    agreement: nDecisive > 0 ? agreements / nDecisive : null,
    r: pearson(judgeMargins, teacherScores),
    ties: { teacher: teacherTies, judge: judgeTies },
  };
}
