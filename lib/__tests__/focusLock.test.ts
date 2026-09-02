import { describe, expect, test } from "vitest";
import {
  isLockedByFocus,
  isWelcomeGated,
  pickLockingFocus,
  prioritizeFocusedUnit,
} from "../focusLock";

// The focused unit the class is on right now.
const FOCUS = { unitId: "unitA", label: "Card sort" };

describe("isLockedByFocus (policy a: homework exempt)", () => {
  test("no live focus → nothing is locked", () => {
    expect(isLockedByFocus(null, "unitB", "is")).toBe(false);
    expect(isLockedByFocus({ unitId: null, label: null }, "unitB", "is")).toBe(
      false,
    );
  });

  test("a card in the focused unit is never locked", () => {
    expect(isLockedByFocus(FOCUS, "unitA", "is")).toBe(false);
    expect(isLockedByFocus(FOCUS, "unitA", "classFocus")).toBe(false);
  });

  test("HOMEWORK in another unit stays startable under a live focus", () => {
    // policy (a): required, independently-scheduled work is not the "new
    // exploration" the wall defers.
    expect(isLockedByFocus(FOCUS, "unitB", "homework")).toBe(false);
  });

  test("a new-exploration (IS/Quest) card in another unit STILL locks", () => {
    // policy (a) must not over-open: the wall's intended case is preserved.
    expect(isLockedByFocus(FOCUS, "unitB", "is")).toBe(true);
  });

  test("a class-focus card in another unit locks (default, no origin)", () => {
    expect(isLockedByFocus(FOCUS, "unitB", "classFocus")).toBe(true);
    expect(isLockedByFocus(FOCUS, "unitB")).toBe(true);
  });
});

describe("pickLockingFocus (policy b: only a solo-startable focus locks)", () => {
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

  test("no entries → no lock", () => {
    expect(pickLockingFocus(undefined)).toBeNull();
    expect(pickLockingFocus(null)).toBeNull();
    expect(pickLockingFocus([])).toBeNull();
  });

  test("a focus the scholar can't do solo does NOT drive a lock", () => {
    // A class-done-together card-sort is the only live focus → no lock.
    expect(pickLockingFocus([offline])).toBeNull();
  });

  test("a solo-startable focus DOES drive the lock", () => {
    expect(pickLockingFocus([online])).toBe(online);
  });

  test("picks the first solo-startable entry, skipping non-solo ones", () => {
    // Most-recent (offline card-sort) can't lock; the solo online focus does.
    expect(pickLockingFocus([offline, online])).toBe(online);
  });
});

describe("prioritizeFocusedUnit", () => {
  test("puts the unlock target before rows locked by it", () => {
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

  test("preserves the existing order when there is no lock", () => {
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
