// Interaction regression for StartAssignmentDialog's roster selection.
//
// The bug this locks down (PR #2294): clicking "None" immediately reselected
// every scholar, because an empty selection was indistinguishable from an
// uninitialized one. These cases are the whole per-open lifecycle — seed,
// settle once, then hands off to the teacher — driven through the pure reducer
// the component binds to, in the same order the component dispatches them.

import { describe, expect, test } from "vitest";
import {
  initialRosterSelectionState,
  rosterSelectionReducer,
  type RosterSelectionEvent,
  type RosterSelectionState,
} from "./startAssignmentRoster";

const ROSTER = ["kai_kahale", "lani_kahale", "oliver_stone"];

/** Replays events the way the component's effects do: `opened` on the
 *  closed→open edge, then `rosterLoaded` whenever the roster query resolves. */
function replay(
  events: RosterSelectionEvent[],
  from: RosterSelectionState = initialRosterSelectionState,
): RosterSelectionState {
  return events.reduce(rosterSelectionReducer, from);
}

const opened = (
  initialScholarIds?: readonly string[],
): RosterSelectionEvent => ({ type: "opened", initialScholarIds });
const rosterLoaded = (rosterIds = ROSTER): RosterSelectionEvent => ({
  type: "rosterLoaded",
  rosterIds,
});
const selected = (...ids: string[]): RosterSelectionEvent => ({
  type: "selectionChanged",
  selection: new Set(ids),
});

const ids = (state: RosterSelectionState) => [...state.selection].sort();

describe("unscoped open", () => {
  test("defaults to the whole roster once it loads", () => {
    expect(ids(replay([opened(), rosterLoaded()]))).toEqual([...ROSTER].sort());
  });

  test("selection is empty until the roster actually resolves", () => {
    expect(ids(replay([opened()]))).toEqual([]);
  });

  test("defaults exactly once — a later roster update never re-defaults", () => {
    const after = replay([
      opened(),
      rosterLoaded(),
      selected("kai_kahale"),
      rosterLoaded(),
    ]);
    expect(ids(after)).toEqual(["kai_kahale"]);
  });

  // The PR #2294 regression, stated directly.
  test("choosing None stays empty when the roster query re-resolves", () => {
    const after = replay([opened(), rosterLoaded(), selected(), rosterLoaded()]);
    expect(ids(after)).toEqual([]);
  });
});

describe("reopening", () => {
  test("defaults to everyone again after the teacher cleared it", () => {
    const closedWithNone = replay([opened(), rosterLoaded(), selected()]);
    const reopened = replay([opened(), rosterLoaded()], closedWithNone);
    expect(ids(reopened)).toEqual([...ROSTER].sort());
  });

  test("a preselected open does not leak into the next unscoped open", () => {
    const first = replay([opened(["kai_kahale"]), rosterLoaded()]);
    expect(ids(first)).toEqual(["kai_kahale"]);
    expect(ids(replay([opened(), rosterLoaded()], first))).toEqual(
      [...ROSTER].sort(),
    );
  });
});

describe("explicit initialScholarIds", () => {
  test("is authoritative — no default-everyone on top of it", () => {
    const after = replay([
      opened(["kai_kahale", "lani_kahale"]),
      rosterLoaded(),
    ]);
    expect(ids(after)).toEqual(["kai_kahale", "lani_kahale"]);
  });

  // An empty array is a real preference ("nobody yet"), not "unset".
  test("an explicit empty preselection stays empty", () => {
    expect(ids(replay([opened([]), rosterLoaded()]))).toEqual([]);
  });

  test("stale / out-of-lens ids are dropped exactly once", () => {
    const settled = replay([
      opened(["kai_kahale", "scholar_from_another_school"]),
      rosterLoaded(),
    ]);
    expect(ids(settled)).toEqual(["kai_kahale"]);

    // The teacher then adds someone; a later roster update must not re-filter.
    const edited = replay(
      [selected("kai_kahale", "lani_kahale"), rosterLoaded()],
      settled,
    );
    expect(ids(edited)).toEqual(["kai_kahale", "lani_kahale"]);
  });

  test("preserves selection identity when nothing needed dropping", () => {
    const seeded = replay([opened(["kai_kahale"])]);
    expect(rosterSelectionReducer(seeded, rosterLoaded()).selection).toBe(
      seeded.selection,
    );
  });
});

describe("re-renders while open", () => {
  // The component only dispatches `opened` on the closed→open edge, so no other
  // event may re-seed from the captured preselection.
  test("a roster update never clobbers the teacher's edits", () => {
    const after = replay([
      opened(["kai_kahale"]),
      rosterLoaded(),
      selected("lani_kahale", "oliver_stone"),
      rosterLoaded(),
      rosterLoaded(["kai_kahale", "lani_kahale", "oliver_stone", "new_scholar"]),
    ]);
    expect(ids(after)).toEqual(["lani_kahale", "oliver_stone"]);
  });

  test("a scholar leaving the roster does not re-filter an edited selection", () => {
    const after = replay([
      opened(),
      rosterLoaded(),
      selected("kai_kahale", "lani_kahale"),
      rosterLoaded(["kai_kahale"]),
    ]);
    expect(ids(after)).toEqual(["kai_kahale", "lani_kahale"]);
  });
});
