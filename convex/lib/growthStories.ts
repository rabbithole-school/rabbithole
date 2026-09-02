/**
 * Growth stories — derive "how you've grown" entries for the learner's
 * "My Learning" view from raw mastery-observation history.
 *
 * Pure function so the rules are unit-testable (see
 * rabbithole-test-strategy.md). Called server-side by
 * masteryObservations.growthForScholar so mastery levels never ship to
 * the scholar's client — the kid-facing surface renders movement and
 * evidence, never the numbers (review/learner-parent-pedagogy.md).
 *
 * A concept qualifies as a growth story only when the data can actually
 * support the claim (single-session observations are noisy — the
 * observer-redesign eval found per-session readiness calls unreliable):
 *   - at least MIN_OBSERVATIONS observations of the concept,
 *   - spanning at least MIN_SPAN_MS of real time,
 *   - with a level rise of at least MIN_LEVEL_RISE first → latest.
 * Misconception signals are excluded from the math entirely (their level
 * encodes the misconception, not progress on the concept).
 */

export interface GrowthSourceObservation {
  conceptLabel: string;
  domain: string;
  masteryLevel: number;
  observedAt: number;
  evidenceType: string;
  transcriptExcerpt: string;
  studentInitiated: boolean;
}

export interface GrowthStory {
  conceptLabel: string;
  domain: string;
  /** When the concept was first observed (the "you started here" anchor). */
  startedAt: number;
  /** Most recent observation — stories sort by this, newest first. */
  latestAt: number;
  /** The latest non-empty transcript excerpt — the kid's own moment. */
  excerpt: string | null;
  /** True if any observation of the concept was student-initiated. */
  studentInitiated: boolean;
}

export const MIN_OBSERVATIONS = 2;
export const MIN_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_LEVEL_RISE = 1.0;
export const MAX_STORIES = 6;

export function deriveGrowthStories(
  observations: GrowthSourceObservation[],
): GrowthStory[] {
  const byConcept = new Map<string, GrowthSourceObservation[]>();
  for (const o of observations) {
    if (o.evidenceType === "misconception_signal") continue;
    const list = byConcept.get(o.conceptLabel);
    if (list) list.push(o);
    else byConcept.set(o.conceptLabel, [o]);
  }

  const stories: GrowthStory[] = [];
  for (const list of byConcept.values()) {
    if (list.length < MIN_OBSERVATIONS) continue;
    list.sort((a, b) => a.observedAt - b.observedAt);
    const first = list[0];
    const latest = list[list.length - 1];
    if (latest.observedAt - first.observedAt < MIN_SPAN_MS) continue;
    if (latest.masteryLevel - first.masteryLevel < MIN_LEVEL_RISE) continue;

    const latestWithExcerpt = [...list]
      .reverse()
      .find((o) => o.transcriptExcerpt.trim().length > 0);
    stories.push({
      conceptLabel: latest.conceptLabel,
      domain: latest.domain,
      startedAt: first.observedAt,
      latestAt: latest.observedAt,
      excerpt: latestWithExcerpt ? latestWithExcerpt.transcriptExcerpt : null,
      studentInitiated: list.some((o) => o.studentInitiated),
    });
  }

  stories.sort((a, b) => b.latestAt - a.latestAt);
  return stories.slice(0, MAX_STORIES);
}
