// Pure scholar-name matcher for the portfolio ingestion pipeline.
//
// A classroom printer drops scans into Drive; Claude vision reads the name
// the kid wrote in the corner. That raw string ("Kai", "kai n", "Kai
// Nakamura", "KAI") has to resolve to one scholar — or fail safely into a
// teacher review queue. This module is the decision logic, kept PURE (no
// ctx, no DB) so it's cheap to unit-test exhaustively. The action in
// `portfolioActions.ts` feeds it the scholar roster and acts on the verdict.
//
// Design bias: a school cohort is small (tens of kids), and a WRONG
// auto-match (work filed under the wrong child) is worse than a miss (work
// parked in a review queue a teacher clears in one click). So the thresholds
// lean conservative — when in doubt, return "ambiguous"/"unmatched" rather
// than guess.

export interface MatchCandidate {
  id: string;
  name?: string | null;
  username?: string | null;
}

export type MatchStatus = "matched" | "ambiguous" | "unmatched";

export interface MatchResult {
  status: MatchStatus;
  /** Set when status === "matched". */
  scholarId?: string;
  /** Set when status === "ambiguous" — the near-tie candidates, best-first. */
  candidateIds: string[];
  /** 0–1. The top candidate's raw score (0 when unmatched). */
  confidence: number;
  /** The normalized detected name, for debugging / display. */
  normalizedName: string;
}

/** lowercase, strip diacritics + punctuation, collapse whitespace, tokenize. */
export function normalizeName(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks (accents)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Score how well a detected name matches one scholar's name, 0–1.
 * Higher = better. The bands are deliberately coarse AND well-separated so the
 * decision logic downstream can reason about tiers.
 *
 * KEY DESIGN POINT: a kid signs their work with their FIRST name (or first +
 * last). They essentially never sign with only their last name. So a
 * first-name hit (0.75) is a much stronger author signal than an incidental
 * last-name collision (0.5) — and the gap between those bands is wide enough
 * that a unique first-name match still auto-files even when some OTHER scholar
 * happens to carry that word as a surname. (This is the "Oliver Stone"
 * vs "Test Oliver" case: writing "Oliver" means the first-name Oliver.)
 */
function scoreOne(detected: string[], candidate: MatchCandidate): number {
  const s = normalizeName(candidate.name);
  if (detected.length === 0) return 0;

  // Username exact match is a strong signal even with no display name.
  const uname = normalizeName(candidate.username).join("");
  if (uname && detected.join("") === uname) return 1;

  if (s.length === 0) return 0;

  const dJoined = detected.join(" ");
  const sJoined = s.join(" ");
  if (dJoined === sJoined) return 1;

  const firstD = detected[0];
  const lastD = detected[detected.length - 1];
  const firstS = s[0];
  const lastS = s[s.length - 1];

  // Multi-token detected name (has both a first and last-ish token).
  if (detected.length >= 2) {
    if (firstD === firstS && lastD === lastS) return 0.95;
    // Last initial only, e.g. "Kai N" vs "Kai Nakamura".
    if (firstD === firstS && lastD.length === 1 && lastS.startsWith(lastD))
      return 0.9;
    if (firstD === firstS) return 0.75; // first names agree (strong signal)
    if (lastD === lastS) return 0.5; // last names agree, first doesn't (weak)
  } else {
    // Single detected token — almost always the kid's first name.
    if (firstD === firstS) return 0.75; // first-name hit (strong)
    if (firstD === lastS) return 0.5; // matched only a surname (weak)
    // Prefix (kid wrote a short/cut-off name): "kath" vs "katherine".
    if (firstS.startsWith(firstD) && firstD.length >= 3) return 0.5;
  }

  // Any token in common (weak — e.g. shared middle/last fragment).
  if (detected.some((t) => s.includes(t))) return 0.3;
  return 0;
}

/**
 * Resolve a detected name against the scholar roster.
 *
 * Decision rules (conservative — a wrong auto-file is worse than a review):
 *  - unique winner at the first-name tier or better (>= 0.6) that clears the
 *    runner-up by >= 0.15                                          -> matched
 *    (a unique first-name hit auto-files even past an incidental
 *     surname collision, which only scores 0.5)
 *  - candidates clustered near the top (margin < 0.15)             -> ambiguous
 *    (e.g. two scholars genuinely share a first name)
 *  - nothing clears the 0.5 floor                                  -> unmatched
 */
export function matchScholar(
  detectedNameRaw: string | null | undefined,
  scholars: MatchCandidate[]
): MatchResult {
  const detected = normalizeName(detectedNameRaw);
  const normalizedName = detected.join(" ");

  if (detected.length === 0 || scholars.length === 0) {
    return { status: "unmatched", candidateIds: [], confidence: 0, normalizedName };
  }

  const scored = scholars
    .map((c) => ({ id: c.id, score: scoreOne(detected, c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: "unmatched", candidateIds: [], confidence: 0, normalizedName };
  }

  const top = scored[0];
  const second = scored[1];
  const margin = top.score - (second?.score ?? 0);

  const FLOOR = 0.5;
  if (top.score < FLOOR) {
    return { status: "unmatched", candidateIds: [], confidence: top.score, normalizedName };
  }

  const uniqueWinner = top.score >= 0.6 && margin >= 0.15;
  if (uniqueWinner) {
    return {
      status: "matched",
      scholarId: top.id,
      candidateIds: [top.id],
      confidence: top.score,
      normalizedName,
    };
  }

  // Near-tie at or above the floor → let a teacher pick. Surface every
  // candidate within 0.15 of the top so the UI can preselect the cluster.
  const candidateIds = scored
    .filter((c) => top.score - c.score < 0.15)
    .map((c) => c.id);
  return {
    status: "ambiguous",
    candidateIds,
    confidence: top.score,
    normalizedName,
  };
}
