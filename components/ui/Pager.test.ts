import { describe, expect, it } from "vitest";

import { pagerLabel } from "@/components/ui/Pager";

// The "X of Y" position text is the one bit of Pager logic worth pinning: it
// must show a 1-based position that matches the roster the pager walks, and it
// must yield null (no label, chevrons only) for a not-found / empty set rather
// than rendering a nonsense "0 of 0" or "-1 of N".
describe("pagerLabel", () => {
  it("renders a 1-based position within the total", () => {
    expect(pagerLabel(0, 12)).toBe("1 of 12");
    expect(pagerLabel(2, 12)).toBe("3 of 12");
    expect(pagerLabel(11, 12)).toBe("12 of 12");
  });

  it("returns null when there is no valid position", () => {
    // Not found in the set.
    expect(pagerLabel(-1, 12)).toBeNull();
    // Empty set.
    expect(pagerLabel(0, 0)).toBeNull();
    // Index past the end (stale roster) — don't render a wrong count.
    expect(pagerLabel(12, 12)).toBeNull();
  });

  it("handles a single-item set", () => {
    expect(pagerLabel(0, 1)).toBe("1 of 1");
  });
});
