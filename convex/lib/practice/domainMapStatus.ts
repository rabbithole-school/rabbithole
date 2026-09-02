/**
 * DOMAIN MAP STATUS — the single classification of "is this scholar's map drawn
 * in this domain yet?" (finish-the-check-in, founder 2026-08-18).
 *
 * Every predicate that used to ask that question answered it differently: the
 * mixed check-in read `mastery.size > 0 || placement complete`, the playlist
 * pre-check short-circuited on the first mastery row, and the two grade guards
 * refused on mastery existence. A domain a scholar merely PRACTICED in — with no
 * placement run ever converging — therefore counted as mapped and was never
 * searched, which is the shadow-placement hole this module closes.
 *
 * The ruling: **mapped = a CONVERGED placement run** (`practicePlacements.status
 * === "complete"`), never mastery-row existence. Mastery without a converged run
 * is `shadow_placed` — unmapped, counted in the denominator, and searched.
 *
 * Pure over structural inputs (no Convex `Doc`), so the classification unit-tests
 * standalone; `convex/practiceSkills.ts` owns the one ctx loader that feeds it.
 */

/** Where one domain sits on the scholar's map. */
export type DomainMapStatus =
  /** A placement run converged here — the only "mapped" state. */
  | "converged"
  /** A run is open with ≥1 answered probe (either surface). */
  | "in_flight"
  /** Mastery rows exist but NO run ever converged — UNMAPPED, needs searching. */
  | "shadow_placed"
  /** Eligible for the map, but a prerequisite domain hasn't converged yet. */
  | "queued"
  /** Eligible, prerequisites converged, nothing answered here yet. */
  | "available"
  /** Outside the scholar's affect-safe grade ring — excluded from the map. */
  | "ineligible";

/** One domain's structural inputs. `prereqDomains` are cross-domain `buildsOn`
 *  source domains; a prereq not present in the input set counts as satisfied
 *  (it isn't seeded on this deployment, so it can never converge). */
export type DomainMapInput = {
  domain: string;
  prereqDomains: readonly string[];
  /** Does the domain have any node inside the scholar's affect-safe ring? */
  gradeEligible: boolean;
  /** `practicePlacements.status` for this (scholar, domain); null = no row. */
  placementStatus: string | null;
  /** Probes ANSWERED in this domain (`probeLog.length`). */
  answeredProbes: number;
  /** Does the scholar hold ANY `practiceMastery` row in this domain? */
  hasMastery: boolean;
};

/** The canonical definition of a mapped domain: only a converged placement run
 * counts. Mastery rows without one are `shadow_placed`, not mapped. */
export function isMappedPlacementStatus(
  placementStatus: string | null | undefined,
): boolean {
  return placementStatus === "complete";
}

export type DomainMapEntry = {
  domain: string;
  status: DomainMapStatus;
  /** Counted in N (the numerator) — exactly `status === "converged"`. */
  mapped: boolean;
  /** Counted in M (the denominator) — everything but `ineligible`. */
  eligible: boolean;
  /** The RAW "counts toward the scholar's ring" input, independent of
   *  `status`/`eligible`: has a node inside the affect-safe grade ring AND is
   *  not an ELECTIVE domain (the loader folds electivity in — an elective is
   *  never grade-eligible regardless of tags). Unlike `eligible` this never
   *  flips true just because a deliberately-opened domain went `in_flight` (or
   *  even `converged`) — it is the one field a consumer can use to tell "the
   *  grade ring itself grew" apart from "the scholar opened new territory". */
  gradeEligible: boolean;
  /** Every prerequisite domain has CONVERGED, so this one may OPEN now. The
   *  prereq DAG governs serving ORDER, never map membership. */
  prereqsReady: boolean;
  /** Unconverged prereq domains (present in the input set) gating this one.
   *  Empty unless `status === "queued"` — once prereqsReady flips true the
   *  domain moves to `available` (or beyond) and nothing is left blocking it. */
  blockedBy: string[];
  /** OFFERABLE above the grade ring: grade-ineligible, unopened (`ineligible`),
   *  and every cross-domain prereq has already converged. Consumed ONLY by the
   *  deliberate new-territory offer surface — it stays `status: "ineligible"`,
   *  `eligible: false`, and `domainMayServe` still refuses it, so the automatic
   *  breadth-first check-in can never auto-probe it (raise-the-ceiling,
   *  `scratch-critiques/slip-confirm-interaction-review.md` §3a). */
  reachable: boolean;
};

export type ScholarMapSummary = {
  perDomain: DomainMapEntry[];
  /** N — converged domains among the eligible set. */
  mappedCount: number;
  /** M — grade-eligible domains (converged + in_flight + shadow_placed +
   *  queued + available). It grows on a grade unlock, or when the scholar
   *  deliberately opens a domain above their ring; never on prereqs converging,
   *  so it does not treadmill upward mid-check-in. */
  eligibleCount: number;
  /** N === M with at least one eligible domain — the map is finished. */
  allMapped: boolean;
  /** Whether the scholar has an enrolled grade on file. A surface that wants to
   *  explain a small M (the missing-grade ring is the most restrictive one) reads
   *  this rather than re-deriving it. */
  gradeOnFile: boolean;
};

/**
 * Classify every seeded domain for one scholar. Precedence is deliberate:
 *   • CONVERGED wins over everything, including the grade gate — a domain mapped
 *     by a deliberate pick outside the ring is still mapped, and N may never
 *     exceed M.
 *   • IN_FLIGHT outranks the grade gate too. The ring governs which domain opens
 *     AUTOMATICALLY; a deliberate pick may open one above it, and a run with
 *     answered probes must keep serving and must show up in M, or the scholar's
 *     own choice would strand mid-search. This is the one way M grows without a
 *     grade unlock, and it grows because the scholar asked for it.
 *   • `shadow_placed` outranks `queued`/`available` because "has mastery but was
 *     never mapped" is the diagnostic worth surfacing; `prereqsReady` carries the
 *     ordering question independently, so nothing is lost by the precedence.
 */
export function summarizeDomainMap(
  inputs: readonly DomainMapInput[],
  opts: { gradeOnFile: boolean },
): ScholarMapSummary {
  const known = new Set(inputs.map((d) => d.domain));
  const converged = new Set(
    inputs
      .filter((d) => isMappedPlacementStatus(d.placementStatus))
      .map((d) => d.domain),
  );
  const perDomain = inputs.map((d): DomainMapEntry => {
    const prereqsReady = d.prereqDomains.every(
      (p) => !known.has(p) || converged.has(p),
    );
    const status: DomainMapStatus = converged.has(d.domain)
      ? "converged"
      : d.answeredProbes > 0
        ? "in_flight"
        : !d.gradeEligible
          ? "ineligible"
          : d.hasMastery
            ? "shadow_placed"
            : prereqsReady
              ? "available"
              : "queued";
    return {
      domain: d.domain,
      status,
      mapped: status === "converged",
      eligible: status !== "ineligible",
      gradeEligible: d.gradeEligible,
      prereqsReady,
      // Named blockers only mean anything while queued — the moment
      // prereqsReady flips true the domain moves to `available` (or beyond)
      // and there's nothing left to name.
      blockedBy:
        status === "queued"
          ? d.prereqDomains.filter((p) => known.has(p) && !converged.has(p))
          : [],
      // Only an ineligible (grade-outside-the-ring, never opened) domain whose
      // prereq DAG has already converged is offerable — see the field comment.
      reachable: status === "ineligible" && prereqsReady,
    };
  });
  const mappedCount = perDomain.filter((d) => d.mapped).length;
  const eligibleCount = perDomain.filter((d) => d.eligible).length;
  return {
    perDomain,
    mappedCount,
    eligibleCount,
    allMapped: eligibleCount > 0 && mappedCount === eligibleCount,
    gradeOnFile: opts.gradeOnFile,
  };
}

/**
 * May this domain serve a mapping probe right now?
 *
 * Eligible, not yet converged, and either its prerequisites have converged or it
 * already has a run going. The second clause is what keeps a deliberately-picked
 * prereq-gated domain progressing: the gate orders which domain OPENS next, it
 * does not un-open one that is already underway.
 */
export function domainMayServe(entry: DomainMapEntry): boolean {
  return entry.eligible && !entry.mapped && (entry.prereqsReady || entry.status === "in_flight");
}
