/**
 * Spotted flair: flair for an idea nobody listed in advance.
 *
 * Every other flair is minted against a criterion fixed before the scholar
 * starts (`mintFlair` in convex/deliverables.ts). This one is awarded by the
 * observer, after the fact, for a moment in the transcript that went beyond
 * the listed goals. Design and evidence:
 * review/spotted-flair-proposal.html.
 *
 * It is stored on the SESSION (`sessions.spottedFlair`), never as a criterion
 * in `session.deliverableCriteria`: the rubric check fills an omitted criterion
 * with "not", so a spotted line there would block completion, and the tutor
 * would start steering the scholar toward a goal nobody set.
 *
 * Pure helpers only; the gated write lives in convex/spottedFlair.ts.
 */

import type { ObserverResult } from "./observerShared";

/**
 * Starting caps, NOT calibrated values (T6). They bound how often the
 * prototype can fire while the bar is calibrated against teacher labels; the
 * proposal's back-test sets the real numbers. A cap is a rate limit, not the
 * quality gate: the gate is the corroboration rule below.
 */
export const SPOTTED_FLAIR_PER_SESSION = 1;
export const SPOTTED_FLAIR_PER_SCHOLAR_WEEK = 2;
export const SPOTTED_FLAIR_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const SPOTTED_FLAIR_LABEL_MAX = 40;
export const SPOTTED_FLAIR_NOTE_MAX = 200;

export type SpottedFlairProposal = NonNullable<ObserverResult["spottedFlair"]>;

/**
 * The quality gate: the observer may only spot a moment that its own governed
 * record ALSO marks as the scholar's unprompted work, in the same pass. The
 * scholar line must carry either
 *   - a student-initiated cross-domain connection, or
 *   - a student-initiated `direct_demonstration` mastery observation,
 * whose excerpt is quoted from that line. This keeps the flair a rendering of
 * evidence the teacher can already see (T7), with no new numeric threshold.
 */
export function spottedFlairCorroborated(
  result: Pick<ObserverResult, "crossDomainConnections" | "observations">,
  sourceContent: string,
): boolean {
  // An excerpt may elide the middle of a long line ("…a big sign ... what
  // type of craft go here."): every fragment must come from the line, and at
  // least one must be long enough to identify it.
  const quotes = (excerpt: string | undefined | null) => {
    const fragments = (excerpt ?? "")
      .trim()
      .replace(/^["“]|["”]$/g, "")
      .split(/\s*(?:\.\.\.|…)\s*/)
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.length > 0);
    return (
      fragments.some((fragment) => fragment.length >= 8) &&
      fragments.every((fragment) => sourceContent.includes(fragment))
    );
  };
  const byConnection = result.crossDomainConnections.some(
    (connection) =>
      connection.studentInitiated === true && quotes(connection.transcriptExcerpt),
  );
  const byObservation = result.observations.some(
    (observation) =>
      observation.studentInitiated === true &&
      observation.evidenceType === "direct_demonstration" &&
      quotes(observation.transcriptExcerpt),
  );
  return byConnection || byObservation;
}

/** Trim and bound the scholar-facing strings; null when unusable. */
export function cleanSpottedFlairText(
  proposal: Pick<SpottedFlairProposal, "label" | "note">,
): { label: string; note: string } | null {
  const label = proposal.label?.trim().replace(/[.!]+$/, "") ?? "";
  const note = proposal.note?.trim() ?? "";
  if (!label || !note) return null;
  if (label.length > SPOTTED_FLAIR_LABEL_MAX) return null;
  return {
    label,
    note:
      note.length > SPOTTED_FLAIR_NOTE_MAX
        ? `${note.slice(0, SPOTTED_FLAIR_NOTE_MAX - 1).trimEnd()}…`
        : note,
  };
}

/**
 * Everything the session already pays flair for, as the observer reads it:
 * the rubric (or mission criteria) and, for an app, the mission itself. An
 * app session whose criteria were never generated still has a mission on its
 * build contract, and an idea that only meets it must not be spotted.
 */
export function spottedFlairListedGoals(args: {
  rubric?: string | null;
  buildContract?: { gate?: string; invariants?: string[] } | null;
}): string | null {
  const parts: string[] = [];
  const rubric = args.rubric?.trim();
  if (rubric) parts.push(rubric);
  const gate = args.buildContract?.gate?.trim();
  const invariants = (args.buildContract?.invariants ?? [])
    .map((line) => line.trim())
    .filter(Boolean);
  if (gate || invariants.length > 0) {
    parts.push(
      [
        "Mission:",
        ...(gate ? [`- ${gate}`] : []),
        ...invariants.map((line) => `- Must be true: ${line}`),
      ].join("\n"),
    );
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** The flair id: one per scholar turn, so a re-reading observer is a no-op. */
export function spottedFlairId(sourceMessageId: string): string {
  return `spotted:${sourceMessageId}`;
}
