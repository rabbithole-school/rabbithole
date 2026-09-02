import { describe, expect, it } from "vitest";

import { tabFromUrlState, urlStateForTab } from "../scholarsTab";

// The Scholars page tab bar (Snapshot · Homework · Academic Rounds · SEL
// Rounds) is a derived view over the layout's `rounds`/`rkind`/`view` URL
// state, chosen so every legacy link keeps resolving. These assert the mapping.

describe("tabFromUrlState — legacy links resolve", () => {
  it("no rounds, no view → Snapshot", () => {
    expect(tabFromUrlState(false, "academic", null)).toBe("snapshot");
  });

  it("view=tonight → Homework (the legacy prep-window / TeacherToday link)", () => {
    expect(tabFromUrlState(false, "academic", "tonight")).toBe("homework");
  });

  it("an unrelated view value falls through to Snapshot", () => {
    expect(tabFromUrlState(false, "academic", "something-else")).toBe("snapshot");
  });

  it("legacy ?rounds=1 (academic default) → Academic Rounds", () => {
    expect(tabFromUrlState(true, "academic", null)).toBe("academic-rounds");
  });

  it("?rounds=1&rkind=sel → SEL Rounds", () => {
    expect(tabFromUrlState(true, "sel", null)).toBe("sel-rounds");
  });

  it("rounds takes precedence over a stray view param", () => {
    expect(tabFromUrlState(true, "academic", "tonight")).toBe("academic-rounds");
  });
});

describe("urlStateForTab — round-trips", () => {
  it("Snapshot clears everything", () => {
    expect(urlStateForTab("snapshot")).toEqual({ rounds: false, rweek: null, view: null });
  });

  it("Homework sets view=tonight", () => {
    expect(urlStateForTab("homework")).toEqual({ rounds: false, rweek: null, view: "tonight" });
  });

  it("Academic Rounds writes rounds=true, rkind=academic", () => {
    expect(urlStateForTab("academic-rounds")).toEqual({
      rounds: true,
      rkind: "academic",
      rweek: null,
      view: null,
    });
  });

  it("SEL Rounds writes rounds=true, rkind=sel", () => {
    expect(urlStateForTab("sel-rounds")).toEqual({
      rounds: true,
      rkind: "sel",
      rweek: null,
      view: null,
    });
  });

  it("round-trips: every tab derives back to itself", () => {
    for (const tab of ["snapshot", "homework", "academic-rounds", "sel-rounds"] as const) {
      const s = urlStateForTab(tab);
      const cadence = s.rkind ?? "academic";
      expect(tabFromUrlState(s.rounds, cadence, s.view)).toBe(tab);
    }
  });
});
