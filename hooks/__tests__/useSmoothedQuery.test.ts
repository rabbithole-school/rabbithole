import { describe, expect, it } from "vitest";

import { nextRetained, resolveSmoothed } from "@/hooks/useSmoothedQuery";

// The React hook itself can't be rendered here (edge-runtime, no DOM), so the
// keep-previous transition is tested through its pure core. This is exactly the
// scholar-switch sequence the teacher pane goes through: an in-flight swap must
// keep showing the OUTGOING scholar's content (never unmount to empty) while
// flagging the swap as pending so the UI can dim it.
describe("resolveSmoothed", () => {
  it("shows nothing and is NOT pending before the very first result", () => {
    // Nothing loaded yet — this is a genuine cold load, not a stale swap, so
    // there is nothing to hold and nothing to dim.
    expect(resolveSmoothed(undefined, undefined)).toEqual({
      data: undefined,
      isPending: false,
    });
  });

  it("passes the live value straight through once it has loaded", () => {
    expect(resolveSmoothed("scholarA", "scholarA")).toEqual({
      data: "scholarA",
      isPending: false,
    });
  });

  it("RETAINS the previous value and marks it pending during an in-flight swap", () => {
    // The teacher clicked a new scholar: the live query dropped to undefined
    // while its new args load. We must still render the previous scholar's data
    // (no flash to empty, no height collapse) and signal the swap.
    expect(resolveSmoothed(undefined, "scholarA")).toEqual({
      data: "scholarA",
      isPending: true,
    });
  });

  it("swaps to the new value and clears pending when the live result arrives", () => {
    expect(resolveSmoothed("scholarB", "scholarA")).toEqual({
      data: "scholarB",
      isPending: false,
    });
  });
});

// The retention rule the hook applies before resolving: a "skip" clears what
// was held, so re-enabling the query for another scholar loads fresh instead
// of flashing the previous scholar's data (review finding on PR #3934).
describe("nextRetained", () => {
  it("holds the live value when there is one", () => {
    expect(nextRetained("scholarB", "scholarA", false)).toBe("scholarB");
  });

  it("keeps the previous value while new args load", () => {
    expect(nextRetained(undefined, "scholarA", false)).toBe("scholarA");
  });

  it("drops the retained value while the query is skipped", () => {
    expect(nextRetained(undefined, "scholarA", true)).toBeUndefined();
  });

  it("re-enabling after a skip starts from nothing, not the old scholar", () => {
    const afterSkip = nextRetained(undefined, "scholarA", true);
    expect(nextRetained(undefined, afterSkip, false)).toBeUndefined();
  });
});
