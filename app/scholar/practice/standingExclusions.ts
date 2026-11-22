/**
 * Which of a teacher's standing-assignment `excludedStrands` the practice page
 * hands to `practiceSession`. Pure so the rule is unit-tested (see
 * `standingExclusions.test.ts`) instead of living only in page.tsx's JSX.
 *
 * The client list matters because `resolvePracticeScope`
 * (convex/lib/practice/mathPlan.ts) only folds exclusions into the server-side
 * scope for a single standing row whose exclusions leave a strand behind. With
 * ≥2 standing rows, or a row that excludes every strand, the scope comes back
 * `{ kind: "open" }` and this list is the only thing keeping an off-limits
 * strand out of the run.
 *
 * Exclusions are not domain-qualified, so they apply only to a single-domain
 * run on the standing row's own domain:
 *   • no explicit `?domain=` — the run IS the standing's domain (unchanged);
 *   • a strand-tile Start (`?domain=` === `?choiceDomain=`) — only when the
 *     standing is single-domain and the pick is that domain;
 *   • any other explicit `?domain=` (a deep link) — none, as before.
 * Never for a problem set or a mixed playlist.
 */
export type StandingExclusionSource = {
  domain: string;
  domains: string[];
  excludedStrands: string[];
};

export function standingExcludedStrands(inputs: {
  isProblemSet: boolean;
  isMixedSession: boolean;
  /** The resolved `?domain=`, or null when the URL carried none. */
  explicitDomain: string | null;
  /** `?choiceDomain=` matches `?domain=` — a strand-tile Start. */
  isStrandPickEntry: boolean;
  /** The domain this run will actually serve. */
  domain: string | undefined;
  /** The scholar's effective legacy standing row (null under a Math plan). */
  standing: StandingExclusionSource | null | undefined;
}): string[] | undefined {
  const { standing } = inputs;
  if (inputs.isProblemSet || inputs.isMixedSession || !standing) return undefined;
  if (inputs.explicitDomain === null) return standing.excludedStrands;
  if (
    inputs.isStrandPickEntry &&
    standing.domains.length <= 1 &&
    standing.domain === inputs.domain
  ) {
    return standing.excludedStrands;
  }
  return undefined;
}
