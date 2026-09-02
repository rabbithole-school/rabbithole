/**
 * MAPPING-IN-PLAYLIST (Option D — OPTION_D_RULINGS, founder 2026-07-19) — the
 * PURE mix policy for the "· mapping" segment of the one daily playlist.
 *
 * Option D removes the standalone placement/check-in surface: an unmapped spot
 * is a `· mapping` segment of the ordinary daily playlist the scheduler already
 * composes. Mapping items are placement PROBES served AS playlist items; they
 * grade through the placement path (inferred credit, trust-upward, the short
 * half-life leash — never a demonstrated-fluency claim). This module is only the
 * QUEUE-LEVEL policy — how many mapping probes ride a playlist and in what order
 * — kept free of Convex/ctx so it unit-tests standalone (mapping.test.ts). The
 * per-strand adaptive search itself stays in placement.ts; practiceSkills.ts
 * wires the two together.
 *
 * The ruled defaults this encodes (OPTION_D_RULINGS slides 2–3, as amended by
 * finish-the-check-in, founder 2026-08-18):
 *   • Q2 mix policy — a FIXED CAP of ≤2 mapping items on a BLENDED playlist (one
 *     that also carries real review/new work), ordered AFTER due reviews and
 *     BEFORE new frontier work (reviews are never displaceable; a warmed-up kid
 *     also maps better). Foundational-first across domains, then least-answered.
 *   • BREADTH-FIRST across every eligible unmapped domain (finish-the-check-in,
 *     superseding the one-domain-at-a-time scoping this module used to apply).
 *     Pass 1 gives every eligible strand its FIRST probe before anything
 *     deepens; pass 2 then deepens to convergence foundational-first, so the
 *     scholar's "N of M domains mapped" ticks up domain by domain instead of
 *     stalling behind whichever run happened to be open. The pass boundary is
 *     STRUCTURAL (`answeredInStrand === 0`), not a tunable depth constant.
 *   • Q1 cold start — when NOTHING ELSE is servable (a brand-new scholar; a
 *     freshly-picked domain), the playlist is 100% `· mapping` and that
 *     "all-mapping" ratio emerges naturally: the blend cap is lifted to a
 *     day-1 sitting budget so mapping proceeds firmly in one tolerable sit
 *     ("honest-and-done"). The run re-serves the next probes as the scholar
 *     answers (each grades adaptively), so the ~15–20-item first sit builds up
 *     across recompositions, never a static pre-baked batch.
 */

/**
 * The fixed cap on `· mapping` items in a BLENDED playlist (Q2 soft default:
 * "≤ 2 per playlist, a scheduler constant"). Reviews sit ahead of it and are
 * never displaced; new frontier work follows.
 */
export const MAPPING_BLEND_CAP = 2;

/**
 * The all-mapping (cold-start) sitting budget — the max `· mapping` items one
 * recomposition serves when nothing else is servable (Q1 "honest-and-done"). The
 * whole first sit is longer (~15–20) but builds across recompositions as each
 * probe grades and the search advances; a single served batch stays a tolerable
 * length. One probe per eligible strand, capped here.
 */
export const MAPPING_DAY1_BUDGET = 6;

/** One candidate mapping probe: the next probe of a still-unconverged
 *  (domain, strand) adaptive search, tagged for the mix policy below. */
export type MappingCandidate = {
  domain: string;
  strand: string;
  /** The nodeKey the search wants to probe next for this strand. */
  probeKey: string;
  /** True when this probe RE-SERVES a node that carries a single unconfirmed miss
   *  (a possible slip) — the "confirm" of "confirm before you cap". A pending
   *  confirm must be resolved before any fresh probe, so it sorts FIRST. */
  pendingConfirm: boolean;
  /** Foundational-first rank of the domain (lower = probed sooner —
   *  `checkInDomainPriority`). Whole-number then fractions lead. */
  domainPriority: number;
  /** Probes already answered in this strand — least-answered leads, so a kid
   *  never grinds one topic. */
  answeredInStrand: number;
  /** Display order of the domain, the final deterministic tiebreak. */
  domainOrder: number;
};

/** One planned mapping item to serve, in order. */
export type MappingPick = { domain: string; strand: string; probeKey: string };

export type MappingPlan = {
  /** The ordered mapping probes to serve this recomposition (deduped by
   *  (domain, strand); at most one probe per strand per batch so the adaptive
   *  search never precomputes probe N+1 without probe N's outcome). */
  picks: MappingPick[];
  /** True when the playlist is 100% mapping (nothing else servable) — drives
   *  the ceremony-lite "Math Check-In" skin + the "Your map is started ✨"
   *  completion beat. */
  allMapping: boolean;
};

/**
 * The BREADTH-FIRST candidate order (finish-the-check-in, founder 2026-08-18) —
 * the one canonical serving policy, shared by the playlist's `· mapping` band and
 * the multi-domain check-in orchestrator so the two surfaces can never disagree
 * about which probe is next:
 *
 *   1. `leadDomain` — the deliberate-entry pick (Q6) leads, unchanged;
 *   2. PASS 1 before PASS 2 — a strand with no answered probe (`answeredInStrand
 *      === 0`) sorts ahead of every deepening candidate, so first coverage spreads
 *      across all eligible domains before any one of them is drilled to
 *      convergence. The boundary is structural, not a tunable depth;
 *   3. within a pass — foundational-first (`domainPriority`), then least-answered
 *      strand, then domain display order, then (domain, strand) name for total
 *      determinism.
 *
 * NOTE: `orderMappingCandidates` itself is a pure BREADTH-FIRST sort and does
 * NOT hoist a `pendingConfirm` candidate — callers that must preempt do so
 * explicitly. All THREE scholar-facing serve paths now preempt: the interactive
 * single-domain (`selectNextProbe`) and multi-domain (`serveNext`) check-ins,
 * AND the playlist `· mapping` band (`submitMappingAnswer`). The band's confirm
 * is served IMMEDIATELY, interrupting breadth-first order (founder ruling,
 * 2026-08-19, REVERSING the earlier "don't preempt the band" decision): the
 * whole value of "confirm before you cap" is the moment being attached to the
 * slip, so a confirm that arrives strands later is meaningless to a child. The
 * band therefore resolves a slip on the SAME skill NOW rather than when the
 * strand happens to come up again.
 */
export function orderMappingCandidates<T extends MappingCandidate>(
  cands: readonly T[],
  leadDomain?: string,
): T[] {
  return [...cands].sort((a, b) => {
    if (leadDomain) {
      const al = a.domain === leadDomain ? 0 : 1;
      const bl = b.domain === leadDomain ? 0 : 1;
      if (al !== bl) return al - bl;
    }
    const ap = a.answeredInStrand === 0 ? 0 : 1;
    const bp = b.answeredInStrand === 0 ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (
      a.domainPriority - b.domainPriority ||
      a.answeredInStrand - b.answeredInStrand ||
      a.domainOrder - b.domainOrder ||
      (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0) ||
      (a.strand < b.strand ? -1 : a.strand > b.strand ? 1 : 0)
    );
  });
}

/**
 * Plan the `· mapping` band for one playlist recomposition (PURE).
 *
 * @param candidates  the next probe of every still-unconverged (domain, strand)
 *                    the scholar is eligible to map (prereq-gated upstream).
 * @param hasOtherServable  true when the blended playlist ALSO carries real
 *                    review/new work from already-placed domains. False → the
 *                    playlist is all-mapping (cold start), so the cap lifts to
 *                    the day-1 sitting budget.
 * @param opts.leadDomain  the deliberate-entry domain to lead with (Q6).
 * @param opts.blendCap / opts.day1Budget  overridable for tests.
 */
export function planMappingBand(
  candidates: MappingCandidate[],
  hasOtherServable: boolean,
  opts: { leadDomain?: string; blendCap?: number; day1Budget?: number } = {},
): MappingPlan {
  const blendCap = opts.blendCap ?? MAPPING_BLEND_CAP;
  const day1Budget = opts.day1Budget ?? MAPPING_DAY1_BUDGET;

  // Dedup to one probe per (domain, strand) — the adaptive search serves at
  // most one probe per strand per batch (defensive; callers already pass one).
  const seen = new Set<string>();
  const deduped: MappingCandidate[] = [];
  for (const c of orderMappingCandidates(candidates, opts.leadDomain)) {
    const id = `${c.domain}\u0000${c.strand}`;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(c);
  }

  // No domain scoping: the band serves BREADTH-FIRST across every eligible
  // unmapped domain the caller passed candidates for (finish-the-check-in,
  // founder 2026-08-18). The old one-domain-at-a-time filter (#cap-open-placements,
  // audit F3) is gone along with the open-run cap it belonged to. The audit's
  // real complaint was that a run "going well got dropped to open another";
  // breadth-first ordering answers that directly — every strand's first probe
  // lands before anything deepens, then deepening runs foundational-first to
  // convergence, so a domain gets finished rather than abandoned. WHICH domains
  // may be scanned at all is the caller's prereq/grade gate, not this policy.

  // All-mapping (100% ratio) exactly when there is mapping to do AND nothing
  // else is servable — the emergent cold-start case (Q1). The cap lifts to the
  // day-1 sitting budget so mapping proceeds in one honest sit.
  const allMapping = deduped.length > 0 && !hasOtherServable;
  const cap = allMapping ? day1Budget : blendCap;

  return {
    picks: deduped.slice(0, Math.max(0, cap)).map((c) => ({
      domain: c.domain,
      strand: c.strand,
      probeKey: c.probeKey,
    })),
    allMapping,
  };
}
