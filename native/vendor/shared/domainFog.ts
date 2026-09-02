// Fog-of-war classification for the scholar's skills tree (finish-the-check-in
// SURFACES, PR2, Surface 3).
//
// ONE added visual state (founder decision 4: "ONE added visual state, not a
// badge vocabulary"). A domain band whose placement run has CONVERGED renders
// EXACTLY as today (green fluent / hollow placed / violet frontier — untouched
// by this module). EVERY other eligible state — `in_flight`, `available`,
// `queued`, `shadow_placed` — renders identically HAZY, labeled "uncharted".
// There is deliberately no second fog label (an earlier draft split out
// "mapping now…" for `in_flight`; that is a second vocabulary member and the
// ruling forbids it). As the domain's placement converges its band resolves
// back to normal dots.
//
// A domain outside the scholar's grade ring (`ineligible`) is excluded from the
// map entirely (unchanged — never this module's concern).
//
// Framework-free + shared so web (components/map/MapTreeCanvas.tsx) and native
// (native/src/components/tree/TreeMapNative.tsx) classify a domain band
// IDENTICALLY — never a drift where one frontend fogs a band the other
// resolves. `native/`'s `@/` alias resolves to `native/src/`, not the repo
// root, so this module can't import convex/lib/practice/domainMapStatus.ts
// directly — it re-declares the same six literals instead (kept in sync by
// the exhaustive switch below: a status this union doesn't know about is a
// compile error here, not a silent fall-through).

/** Mirrors `DomainMapStatus` in convex/lib/practice/domainMapStatus.ts — kept
 *  as a plain string-literal union (not imported) so this module stays
 *  resolvable from native, which has no path alias to the repo's `convex/`. */
export type DomainMapStatusLike =
  | "converged"
  | "in_flight"
  | "shadow_placed"
  | "queued"
  | "available"
  | "ineligible";

/** The tree's fog-of-war rendering state for one domain band. Exactly one
 *  fogged state exists; `null` means "not this module's concern" — render the
 *  band exactly as it does today (a converged/mapped domain, or a domain
 *  outside the grade ring). */
export type DomainFogState = "uncharted" | null;

export function domainFogState(status: DomainMapStatusLike): DomainFogState {
  switch (status) {
    case "in_flight":
    case "available":
    case "queued":
    case "shadow_placed":
      return "uncharted";
    case "converged":
    case "ineligible":
      return null;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** The label painted over a fogged band. `null` for a non-fogged state (the
 *  band renders its normal dots with no fog label at all). */
export function domainFogLabel(state: DomainFogState): string | null {
  return state === "uncharted" ? "uncharted" : null;
}
