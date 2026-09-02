// The per-open lifecycle of StartAssignmentDialog's scholar selection, as a
// pure reducer. It lives out here rather than as refs inside the component
// because the transitions are where the bugs are, and here they're testable
// without a DOM (see startAssignmentRoster.test.ts, and the "split the pure
// core out" rule in .claude/rules/rabbithole-test-strategy.md).
//
// The whole job is one sentence: an opener may hand the dialog a roster, and
// exactly once per open — after the roster query resolves — the selection is
// settled against what actually loaded. Everything after that belongs to the
// teacher and is never re-seeded.

export type RosterSelectionState = {
  /** The ids the opener asked for, captured at open. `undefined` means the
   *  opener expressed no preference, so the roster defaults to everyone. An
   *  explicit `[]` IS a preference ("nobody yet") and stays authoritative. */
  readonly requested: readonly string[] | undefined;
  /** Whether the one-shot settle has run for the current open. Guards both the
   *  default and the reconcile, which is why they can't disagree. */
  readonly settled: boolean;
  readonly selection: Set<string>;
};

export type RosterSelectionEvent =
  /** The dialog went from closed to open. Only this event re-seeds. */
  | { type: "opened"; initialScholarIds: readonly string[] | undefined }
  /** The scholar roster query resolved (may fire repeatedly; settles once). */
  | { type: "rosterLoaded"; rosterIds: readonly string[] }
  /** The teacher edited the selection — including clearing it to none. */
  | { type: "selectionChanged"; selection: Set<string> };

export const initialRosterSelectionState: RosterSelectionState = {
  requested: undefined,
  settled: false,
  selection: new Set(),
};

export function rosterSelectionReducer(
  state: RosterSelectionState,
  event: RosterSelectionEvent,
): RosterSelectionState {
  switch (event.type) {
    case "opened": {
      const requested = event.initialScholarIds?.map((id) => String(id));
      return {
        requested,
        settled: false,
        selection: new Set(requested ?? []),
      };
    }
    case "rosterLoaded": {
      // Exactly once per open. Without this guard an empty selection reads as
      // "uninitialized", so choosing None immediately reselects everyone.
      if (state.settled) return state;
      const roster = new Set(event.rosterIds);
      if (state.requested === undefined) {
        return { ...state, settled: true, selection: roster };
      }
      // A preselection is authoritative, minus ids the roster doesn't contain
      // (stale, or outside the caller's institution lens) so they can't reach
      // assignWork. Selection identity is preserved when nothing was dropped.
      const kept = [...state.selection].filter((id) => roster.has(id));
      return {
        ...state,
        settled: true,
        selection:
          kept.length === state.selection.size ? state.selection : new Set(kept),
      };
    }
    case "selectionChanged":
      return { ...state, selection: event.selection };
  }
}
