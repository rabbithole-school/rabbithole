import { describe, expect, it } from "vitest";

import {
  homeTabIndexForKey,
  homeTabKeyForIndex,
  homeTabPageKeys,
} from "../homeTabPager";
import type { ScholarHomeTab } from "../../../vendor/shared/scholarHomeNow";

// Pure page-order logic for the Home tab pager. There is no component render
// harness here (edge-runtime vitest, no jsdom), so the pager wiring in
// index.tsx can't be render-tested — but the index<->key mapping that keeps a
// swipe and the active tab in sync is pure, and this pins its edges: the page
// order matches tab order, "now" is always a valid page, and every lookup has
// a defined fall-back so a mid-day tab reshape can't strand or crash the pager.

const tab = (key: string, label = key): ScholarHomeTab => ({ key, label });

// The canonical Home tab list (deriveHomeTabs always leads with now · all and
// ends with quests).
const FULL: ScholarHomeTab[] = [
  tab("now", "Now"),
  tab("all", "All"),
  tab("subject:math", "Math"),
  tab("prep", "Scholar's Prep"),
  tab("quests", "Quests"),
];

describe("homeTabPageKeys", () => {
  it("returns the tab keys in tab order", () => {
    expect(homeTabPageKeys(FULL)).toEqual([
      "now",
      "all",
      "subject:math",
      "prep",
      "quests",
    ]);
  });

  it("yields a single 'now' page for an empty (loading) tab list", () => {
    expect(homeTabPageKeys([])).toEqual(["now"]);
  });

  it("does not duplicate the leading 'now' the tab list already carries", () => {
    // deriveHomeTabs' first tab is already "now"; the prepend must not double it.
    const keys = homeTabPageKeys(FULL);
    expect(keys.filter((key) => key === "now")).toHaveLength(1);
    expect(keys[0]).toBe("now");
  });

  it("prepends 'now' when a tab list somehow omits it", () => {
    expect(homeTabPageKeys([tab("all"), tab("quests")])).toEqual([
      "now",
      "all",
      "quests",
    ]);
  });

  it("removes duplicate tab keys, keeping first-seen order", () => {
    expect(
      homeTabPageKeys([tab("all"), tab("subject:math"), tab("all")]),
    ).toEqual(["now", "all", "subject:math"]);
  });
});

describe("homeTabIndexForKey", () => {
  const keys = homeTabPageKeys(FULL);

  it("finds a present key's index", () => {
    expect(homeTabIndexForKey(keys, "now")).toBe(0);
    expect(homeTabIndexForKey(keys, "subject:math")).toBe(2);
    expect(homeTabIndexForKey(keys, "quests")).toBe(4);
  });

  it("falls back to the 'now' page (0) for an absent key", () => {
    // A subject tab that disappeared mid-day: the active key is gone, so the
    // pager parks on now rather than a negative index.
    expect(homeTabIndexForKey(keys, "subject:science")).toBe(0);
  });
});

describe("homeTabKeyForIndex", () => {
  const keys = homeTabPageKeys(FULL);

  it("maps an in-range index to its key", () => {
    expect(homeTabKeyForIndex(keys, 0)).toBe("now");
    expect(homeTabKeyForIndex(keys, 3)).toBe("prep");
    expect(homeTabKeyForIndex(keys, 4)).toBe("quests");
  });

  it("clamps an index that outruns a shrinking page list to the last key", () => {
    expect(homeTabKeyForIndex(keys, 99)).toBe("quests");
  });

  it("clamps a negative index to the first key", () => {
    expect(homeTabKeyForIndex(keys, -1)).toBe("now");
  });

  it("returns 'now' when there are no pages at all", () => {
    expect(homeTabKeyForIndex([], 0)).toBe("now");
  });

  it("round-trips every key through index and back", () => {
    for (const key of keys) {
      expect(homeTabKeyForIndex(keys, homeTabIndexForKey(keys, key))).toBe(key);
    }
  });
});
