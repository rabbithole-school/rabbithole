/**
 * Pure derivation of the Assignments/Schedule view's top-level render state
 * from its three Convex queries (terms, currentTerm, grid) plus the resolved
 * termId. Extracted from MasterScheduleView so the "no reporting period
 * exists yet" case — previously indistinguishable from "still fetching" —
 * has an isolated, testable definition.
 *
 * Before this fix, `loading` was `grid === undefined || termId === null`.
 * On an institution with zero reporting periods (the true day-one state —
 * neither the base nor rich dev seed creates any), `terms` resolves to `[]`
 * and `currentTerm` resolves to `null`, so `termId` can never leave `null`
 * and the grid query never runs — the view spun on "Loading schedule…"
 * forever instead of surfacing an empty state with a next step.
 */

export interface ScheduleLoadingInputs {
  /** `reportingPeriods.list` result — undefined while the query is in flight. */
  terms: unknown[] | undefined;
  /** `reportingPeriods.current` result — undefined in flight, null = resolved with no active period. */
  currentTerm: unknown | null | undefined;
  /** The term derived from `terms`/`currentTerm`/`anchorMs` — null if none resolved. */
  termId: string | null;
  /** `masterSchedule.grid` result — undefined while its query is in flight (it only runs once termId is set). */
  grid: unknown | undefined;
}

export interface ScheduleLoadingState {
  /** Show the generic "Loading schedule…" spinner. */
  loading: boolean;
  /** Both term queries resolved and there's genuinely no active reporting period. */
  noTermConfigured: boolean;
}

export function computeScheduleLoadingState({
  terms,
  currentTerm,
  termId,
  grid,
}: ScheduleLoadingInputs): ScheduleLoadingState {
  const termsResolved = terms !== undefined && currentTerm !== undefined;
  const noTermConfigured = termsResolved && termId === null;
  const loading = !noTermConfigured && (grid === undefined || termId === null);
  return { loading, noTermConfigured };
}
