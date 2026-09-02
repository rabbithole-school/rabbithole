export type SkySeedCandidate = {
  targetId: string;
  domain: string;
  connectionTo?: string;
  suggestionType: string;
  reach?: number;
  curated: boolean;
  pinned: boolean;
  structured: boolean;
  threaded: boolean;
  recencyRank: number;
};

function groupingKey(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") || fallback;
}

/**
 * Greedily builds the at-rest consideration set. Freshness still matters, but
 * domain/anchor diversity keeps one recent thread from occupying every slot.
 * Teacher curation, structured paths, graph threads, and far-reaching leaps
 * remain strong positive signals.
 */
export function selectSkySeedCandidates<T extends SkySeedCandidate>(
  candidates: readonly T[],
  cap: number,
): T[] {
  if (cap <= 0) return [];

  // A placed concept can have multiple live seed rows. The input is newest
  // first, so keep the freshest framing for each rendered target.
  const remaining: T[] = [];
  const seenTargets = new Set<string>();
  for (const candidate of candidates) {
    if (seenTargets.has(candidate.targetId)) continue;
    seenTargets.add(candidate.targetId);
    remaining.push(candidate);
  }

  const selected: T[] = [];
  const domainCounts = new Map<string, number>();
  const anchorCounts = new Map<string, number>();

  while (selected.length < cap && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const domain = groupingKey(candidate.domain, "general");
      const anchor = groupingKey(candidate.connectionTo, "");
      const domainCount = domainCounts.get(domain) ?? 0;
      const anchorCount = anchor ? (anchorCounts.get(anchor) ?? 0) : 0;

      const score =
        Math.max(0, 60 - candidate.recencyRank) +
        (domainCount === 0 ? 200 : -40 * domainCount) +
        (anchor ? (anchorCount === 0 ? 40 : -20 * anchorCount) : 0) +
        (candidate.curated ? 140 : 0) +
        (candidate.structured ? 100 : 0) +
        (candidate.threaded ? 80 : 0) +
        (candidate.pinned ? 20 : 0) +
        (candidate.reach === 2 ? 80 : candidate.reach === 1 ? 35 : 0) +
        (candidate.suggestionType === "leap" ? 20 : 0);

      const best = remaining[bestIndex];
      if (
        score > bestScore ||
        (score === bestScore &&
          (candidate.recencyRank < best.recencyRank ||
            (candidate.recencyRank === best.recencyRank &&
              candidate.targetId < best.targetId)))
      ) {
        bestIndex = i;
        bestScore = score;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    const domain = groupingKey(chosen.domain, "general");
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    const anchor = groupingKey(chosen.connectionTo, "");
    if (anchor) anchorCounts.set(anchor, (anchorCounts.get(anchor) ?? 0) + 1);
  }

  return selected;
}
