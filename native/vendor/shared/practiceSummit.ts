/**
 * Stage-2 summit-handoff selection — the pure, framework-free logic that both
 * the web (`components/practice/SummitHandoff.tsx`) and native
 * (`native/src/components/SummitHandoff.tsx`, via the vendored copy) practice
 * surfaces use to turn a scholar's per-domain progress into "what do we show at
 * the empty-queue moment": a summit celebration, the next domain to invite into,
 * and a modest switcher.
 *
 * Lane 1 owns this file; native vendors a read-only copy through
 * `native/scripts/sync-vendor.js`, so the two surfaces can NEVER drift on which
 * domain is "next" or which pills appear. Imports nothing, so it resolves
 * standalone in either module graph.
 *
 * Input rows mirror `api.practiceSkills.domainsForScholar` (every seeded
 * registered domain, tagged with the scholar's progress).
 */

export type SummitDomain = {
  domain: string;
  label: string;
  discipline: string;
  fluentCount: number;
  total: number;
  /** The scholar has any mastery row in the domain (has entered it). */
  started: boolean;
  /** Number of provisional practice nodes placed in the domain. */
  provisionalCount: number;
  /** Every node grants access, whether demonstrated or provisionally placed. */
  accessComplete: boolean;
  /** Every node in the domain has been demonstrated — the durable summit. */
  exhausted: boolean;
};

export type SummitSelection = {
  /** The session's effective domain (the given one, or the first as default). */
  effective: string | undefined;
  /** The effective domain's row, if present. */
  current: SummitDomain | null;
  /** The domain to invite the scholar into next, or null if none is open. */
  nextOpen: SummitDomain | null;
  /** Other domains worth offering in the switcher. */
  switchable: SummitDomain[];
  /** The effective domain is a durable summit (every node demonstrated). */
  isSummit: boolean;
  /** Every node grants access, but the domain is not yet a summit. */
  placedThrough: boolean;
};

/**
 * Decide the summit-handoff content for `domain` given the scholar's per-domain
 * progress. `domain === undefined` means "the default" — the first-listed
 * domain (matching the query's order + the DomainSelector convention).
 *
 * Before a summit, the "next open" domain prefers one the scholar has already
 * STARTED over a brand-new one. At a summit, the current domain continues with
 * Go Deeper work, so choosing a new primary domain remains the teacher's call:
 * no fresh domain is invited automatically. The switcher still offers other
 * domains the scholar has already started.
 */
export function selectSummitHandoff(
  domains: SummitDomain[],
  domain: string | undefined,
): SummitSelection {
  const effective = domain ?? domains[0]?.domain;
  const current = domains.find((d) => d.domain === effective) ?? null;
  const isSummit = !!current?.exhausted;
  const placedThrough = !!current?.accessComplete && !isSummit;

  const others = domains.filter((d) => d.domain !== effective && !d.exhausted);
  const nextOpen = isSummit
    ? null
    : others.find((d) => d.started) ?? others[0] ?? null;

  const switchable = domains.filter(
    (d) =>
      d.domain !== effective &&
      (d.started || (!isSummit && d.domain === nextOpen?.domain)),
  );

  return { effective, current, nextOpen, switchable, isSummit, placedThrough };
}

export type MixedSummitSelection = {
  /** The blend's domain rows (those in `domainSet`, in `domains` order). */
  domainsInSet: SummitDomain[];
  /** Every domain in the blend is a summit (all nodes demonstrated) — a true
   *  multi-domain summit, not merely a "nothing due right now" lull. */
  allExhausted: boolean;
  /** Every node in every blended domain grants access, but the blend is not an
   * all-domains summit. */
  allPlacedThrough: boolean;
  /** A domain OUTSIDE the blend to invite into next, or null if none is open. */
  nextOpen: SummitDomain | null;
  /** Domains OUTSIDE the current blend worth offering in the switcher. */
  switchable: SummitDomain[];
};

/**
 * Summit-handoff content for a MIXED playlist (≥2 blended domains). The
 * empty-queue moment for a blend means every domain in it yielded nothing right
 * now; this distinguishes a real all-domains summit (celebrate) from a mere
 * caught-up lull, and offers domains OUTSIDE the blend to explore next. Pure so
 * both web + native share it; unit-tested in practiceSummit.test.ts.
 */
export function selectMixedSummitHandoff(
  domains: SummitDomain[],
  domainSet: string[],
): MixedSummitSelection {
  const set = new Set(domainSet);
  const domainsInSet = domains.filter((d) => set.has(d.domain));
  const allExhausted = domainsInSet.length > 0 && domainsInSet.every((d) => d.exhausted);
  const allPlacedThrough =
    domainsInSet.length > 0 &&
    domainsInSet.every((d) => d.accessComplete) &&
    !allExhausted;

  const outside = domains.filter((d) => !set.has(d.domain) && !d.exhausted);
  const nextOpen = allExhausted
    ? null
    : outside.find((d) => d.started) ?? outside[0] ?? null;

  // Switcher: any domain OUTSIDE the current blend the scholar could focus on —
  // other started climbs + the next-open invitation.
  const switchable = domains.filter(
    (d) =>
      !set.has(d.domain) &&
      (d.started || (!allExhausted && d.domain === nextOpen?.domain)),
  );

  return { domainsInSet, allExhausted, allPlacedThrough, nextOpen, switchable };
}
