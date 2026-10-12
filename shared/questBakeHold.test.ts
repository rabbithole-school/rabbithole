import { describe, expect, test } from "vitest";

import {
  QUEST_BAKE_HOLD_CAP_MS,
  questBakeHoldDeadline,
  shouldHoldOpeningTurn,
} from "./questBakeHold";

// The behaviour under test is a fail-open gate on a scholar-facing wait: while
// it says "hold", the session shows "building your quest" and sends nothing.
// So the cases that matter are the ones where it must NOT hold — every one of
// them puts the scholar back on the pre-existing opener rather than leaving
// them staring at a spinner.

const START = 1_700_000_000_000;
const pending = { questBakeStatus: "pending", _creationTime: START };

describe("shouldHoldOpeningTurn", () => {
  test("holds while a bake is pending and inside the cap", () => {
    expect(shouldHoldOpeningTurn(pending, START)).toBe(true);
    expect(shouldHoldOpeningTurn(pending, START + 60_000)).toBe(true);
    expect(
      shouldHoldOpeningTurn(pending, START + QUEST_BAKE_HOLD_CAP_MS - 1),
    ).toBe(true);
  });

  test("stops holding the instant the activity lands", () => {
    // The bake linked: the activity kickoff is the opener now, so even a stale
    // `pending` (a patch this client has not observed yet) must not hold.
    expect(
      shouldHoldOpeningTurn({ ...pending, activityId: "act_1" }, START + 1_000),
    ).toBe(false);
  });

  test("stops holding once the bake releases the hold", () => {
    expect(
      shouldHoldOpeningTurn(
        { questBakeStatus: undefined, _creationTime: START },
        START + 1_000,
      ),
    ).toBe(false);
  });

  test("stops holding at the cap, for a bake that died without writing back", () => {
    // This is the only branch that protects a scholar from an action that
    // crashed before its `finally` ran. Boundary is exclusive: at exactly the
    // cap we are already open.
    expect(
      shouldHoldOpeningTurn(pending, START + QUEST_BAKE_HOLD_CAP_MS),
    ).toBe(false);
    expect(
      shouldHoldOpeningTurn(pending, START + QUEST_BAKE_HOLD_CAP_MS + 60_000),
    ).toBe(false);
  });

  test("never holds a session that was not launched into a bake", () => {
    // Every pre-existing row, and every ordinary activity/assignment session.
    expect(shouldHoldOpeningTurn({ _creationTime: START }, START)).toBe(false);
    expect(shouldHoldOpeningTurn(null, START)).toBe(false);
    expect(shouldHoldOpeningTurn(undefined, START)).toBe(false);
  });

  test("never holds on a missing or nonsense creation time", () => {
    // No usable clock means no way to bound the wait, so open rather than risk
    // an unbounded hold.
    expect(shouldHoldOpeningTurn({ questBakeStatus: "pending" }, START)).toBe(
      false,
    );
    expect(
      shouldHoldOpeningTurn(
        { questBakeStatus: "pending", _creationTime: Number.NaN },
        START,
      ),
    ).toBe(false);
  });
});

describe("questBakeHoldDeadline", () => {
  test("is the launch time plus the cap while pending", () => {
    expect(questBakeHoldDeadline(pending)).toBe(START + QUEST_BAKE_HOLD_CAP_MS);
  });

  test("is null whenever there is nothing to wait for", () => {
    // The hook keys its timer on this, so a null here is what tears the timer
    // down instead of leaving one armed against a session that already opened.
    expect(questBakeHoldDeadline({ ...pending, activityId: "act_1" })).toBeNull();
    expect(questBakeHoldDeadline({ _creationTime: START })).toBeNull();
    expect(questBakeHoldDeadline(null)).toBeNull();
  });
});
