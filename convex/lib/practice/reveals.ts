// PURE thoughtful-reveal predicates for the Tree map's horizon (no ctx, no
// reads — mirrors scheduler.ts). The reveal rule is deliberately ONE HOP wider
// than the frontier rule so their events can never fire together:
//   • a node JOINS THE FRONTIER when every direct prerequisite is proven;
//   • a node is REVEALED when any direct prerequisite joins the frontier —
//     the scholar always sees exactly one hop past what they can practice.
// `nodeReveals` rows latch reveals forever (never un-reveal), so visibility is
// derived-state ∪ latch — a regressed prerequisite can retract the derived
// horizon but never a latched node.

export type RevealEdge = {
  fromKey: string;
  toKey: string;
};

function prereqsByKey(edges: RevealEdge[]): Map<string, string[]> {
  const prereqs = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = prereqs.get(edge.toKey);
    if (existing) existing.push(edge.fromKey);
    else prereqs.set(edge.toKey, [edge.fromKey]);
  }
  return prereqs;
}

// "Could the scholar work here?" — every prerequisite proven (roots trivially
// qualify), OR any mastery evidence at all: a placement-credited or challenged
// node was never "available" in the classic sense, but a node the kid has
// touched must never sit behind the mist.
function availableOrBetter(
  key: string,
  prereqs: Map<string, string[]>,
  provenKeys: Set<string>,
  evidenceKeys: Set<string>,
): boolean {
  return (
    evidenceKeys.has(key) ||
    (prereqs.get(key) ?? []).every((prereq) => provenKeys.has(prereq))
  );
}

export function computeVisibleKeys(
  nodeKeys: string[],
  edges: RevealEdge[],
  provenKeys: Set<string>,
  evidenceKeys: Set<string>,
  revealedKeys: Set<string>,
): Set<string> {
  const prereqs = prereqsByKey(edges);
  return new Set(
    nodeKeys.filter(
      (key) =>
        revealedKeys.has(key) ||
        availableOrBetter(key, prereqs, provenKeys, evidenceKeys) ||
        (prereqs.get(key) ?? []).some((prereq) =>
          availableOrBetter(prereq, prereqs, provenKeys, evidenceKeys),
        ),
    ),
  );
}

export function computeNewReveals(
  changedKey: string,
  edges: RevealEdge[],
  provenBefore: Set<string>,
  provenAfter: Set<string>,
  evidenceKeys: Set<string>,
  alreadyRevealed: Set<string>,
): string[] {
  if (provenBefore.has(changedKey) || !provenAfter.has(changedKey)) return [];

  const prereqs = prereqsByKey(edges);
  const directDependents = edges
    .filter((edge) => edge.fromKey === changedKey)
    .map((edge) => edge.toKey);
  const newlyAvailable = new Set(
    directDependents.filter(
      (key) =>
        !evidenceKeys.has(key) &&
        availableOrBetter(key, prereqs, provenAfter, evidenceKeys) &&
        !availableOrBetter(key, prereqs, provenBefore, evidenceKeys),
    ),
  );

  const newlyRevealed: string[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!newlyAvailable.has(edge.fromKey)) continue;
    const candidate = edge.toKey;
    if (seen.has(candidate) || alreadyRevealed.has(candidate)) continue;
    if (evidenceKeys.has(candidate)) continue;
    if (availableOrBetter(candidate, prereqs, provenBefore, evidenceKeys)) continue;

    // A candidate already visible through ANOTHER prerequisite before this
    // attempt gets no stamp: nodes visible before the latch shipped (or via an
    // earlier un-latched path) must never mint a spurious "Added to your Tree
    // Map" card for territory the scholar has been looking at for weeks.
    const wasVisibleThroughAnotherPrereq = (prereqs.get(candidate) ?? []).some(
      (prereq) =>
        prereq !== edge.fromKey &&
        availableOrBetter(prereq, prereqs, provenBefore, evidenceKeys),
    );
    if (wasVisibleThroughAnotherPrereq) continue;

    seen.add(candidate);
    newlyRevealed.push(candidate);
  }
  return newlyRevealed;
}
