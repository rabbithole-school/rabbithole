import { describe, expect, test } from "vitest";
import {
  isWelcomeGated,
  pickLockingFocus,
  prioritizeFocusedUnit,
} from "../focusLock";

// The hard class-focus gate is gone (see shared/focusLock.ts), so these are
// the policies behind the SOFT focus signal: which live focus is named as
// "what the class is on", and how it sorts the plate.
describe("pickLockingFocus (policy b: only a solo-startable focus is headlined)", () => {
  const offline = {
    unitId: "unitA",
    activityTitle: "Card sort (done in class)",
    soloStartableByMe: false,
  };
  const online = {
    unitId: "unitC",
    activityTitle: "Reading with the tutor",
    soloStartableByMe: true,
  };

  test("no entries → no focus", () => {
    expect(pickLockingFocus(undefined)).toBeNull();
    expect(pickLockingFocus(null)).toBeNull();
    expect(pickLockingFocus([])).toBeNull();
  });

  test("a focus the scholar can't do solo is NOT headlined", () => {
    // A class-done-together card-sort is the only live focus → nothing to name.
    expect(pickLockingFocus([offline])).toBeNull();
  });

  test("a solo-startable focus IS headlined", () => {
    expect(pickLockingFocus([online])).toBe(online);
  });

  test("picks the first solo-startable entry, skipping non-solo ones", () => {
    // The most-recent entry (offline card-sort) can't be headlined; the solo
    // online focus is.
    expect(pickLockingFocus([offline, online])).toBe(online);
  });
});

describe("prioritizeFocusedUnit", () => {
  test("puts the focused unit's rows before the rest of the plate", () => {
    const offline = { id: "offline", unitId: "unitA" };
    const focusedFirst = { id: "focus-1", unitId: "unitC" };
    const remaining = { id: "remaining", unitId: "unitB" };
    const focusedSecond = { id: "focus-2", unitId: "unitC" };

    expect(
      prioritizeFocusedUnit(
        [offline, focusedFirst, remaining, focusedSecond],
        { unitId: "unitC", label: "Reading with the tutor" },
      ).map((item) => item.id),
    ).toEqual(["focus-1", "focus-2", "offline", "remaining"]);
  });

  test("preserves the existing order when there is no live focus", () => {
    const items = [
      { id: "first", unitId: "unitA" },
      { id: "second", unitId: "unitB" },
    ];
    expect(prioritizeFocusedUnit(items, null)).toEqual(items);
  });
});

describe("isWelcomeGated (H1 fix: zero-history quest actions gate on Welcome's first beat)", () => {
  test("no onboarding pin at all → never gated", () => {
    expect(isWelcomeGated(null)).toBe(false);
    expect(isWelcomeGated(undefined)).toBe(false);
  });

  test("onboarding active with ZERO beats done → gated", () => {
    expect(isWelcomeGated({ completedCount: 0 })).toBe(true);
  });

  test("onboarding active with at least one beat done → no longer gated", () => {
    expect(isWelcomeGated({ completedCount: 1 })).toBe(false);
    expect(isWelcomeGated({ completedCount: 3 })).toBe(false);
  });
});
