import { describe, expect, it } from "vitest";

import { nextHeld, nextRetained, resolveSmoothed } from "@/hooks/useSmoothedQuery";

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

// The reset key (TRA-424): a minute re-arm may keep the previous result, but a
// SUBJECT change (institution lens, assignment) must not show the previous
// subject's data while the new one loads.
describe("nextHeld", () => {
  it("retains across a clock-only re-arm while the key is unchanged", () => {
    const held = { key: "schoolA", value: "schoolA-devices" };
    expect(nextHeld(undefined, held, "schoolA", false)).toEqual(held);
  });

  it("drops the held value on the render the key changes", () => {
    const held = { key: "schoolA", value: "schoolA-devices" };
    const next = nextHeld<string>(undefined, held, "schoolB", false);
    expect(next).toEqual({ key: "schoolB", value: undefined });
    // ...so the hook shows nothing (a fresh load), and nothing is "pending".
    expect(resolveSmoothed(undefined, next.value)).toEqual({
      data: undefined,
      isPending: false,
    });
  });

  it("holds the new subject's data once it arrives, and retains it after", () => {
    const afterSwitch = { key: "schoolB", value: undefined };
    const loaded = nextHeld("schoolB-devices", afterSwitch, "schoolB", false);
    expect(loaded).toEqual({ key: "schoolB", value: "schoolB-devices" });
    expect(nextHeld(undefined, loaded, "schoolB", false)).toEqual(loaded);
  });

  it("takes a live value straight through even on the render the key changes", () => {
    // A cached subscription for the new key can resolve synchronously.
    const held = { key: "a1", value: "a1-readout" };
    expect(nextHeld("a2-readout", held, "a2", false)).toEqual({
      key: "a2",
      value: "a2-readout",
    });
  });

  it("a scholar switch with the new scholar still loading shows nothing, not the old scholar's evidence", () => {
    // ScholarProfile keys levelEvidence by scholarId; a minute re-arm for the
    // same scholar still retains.
    const held = { key: "scholarA", value: "A-evidence" };
    expect(nextHeld(undefined, held, "scholarB", false).value).toBeUndefined();
    expect(nextHeld(undefined, held, "scholarA", false).value).toBe("A-evidence");
  });

  it("an omitted key behaves exactly like the keyless hook", () => {
    const held = { key: undefined, value: "previous" };
    expect(nextHeld(undefined, held, undefined, false).value).toBe("previous");
    expect(nextHeld(undefined, held, undefined, true).value).toBeUndefined();
  });
});
