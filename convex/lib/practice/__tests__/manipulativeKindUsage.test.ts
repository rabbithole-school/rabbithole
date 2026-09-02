import { describe, expect, it } from "vitest";
import {
  groupManipulativeKindUsage,
  type KindUsageRow,
} from "../manipulativeKindUsage";
import { ALL_MANIPULATIVE_KINDS } from "../../../../lib/manipulative/types";

/** A minimal, valid gradable spec of a given kind — just enough to parse and
 *  carry a `kind`. `parseManipulativeSpec` only requires an object with a
 *  string `kind`, so the rest is unimportant for grouping. */
function spec(kind: string): string {
  return JSON.stringify({ kind, id: `${kind}-x`, goal: { type: "any" } });
}

describe("groupManipulativeKindUsage", () => {
  it("zero-fills every kind, so a never-used mechanic still appears", () => {
    const { byKind } = groupManipulativeKindUsage([]);
    // Every kind present, all zeroed — the "Never used (N)" scoreboard.
    expect(Object.keys(byKind).sort()).toEqual([...ALL_MANIPULATIVE_KINDS].sort());
    for (const kind of ALL_MANIPULATIVE_KINDS) {
      expect(byKind[kind]).toEqual({
        kind,
        itemCount: 0,
        skillKeys: [],
        perSkill: [],
      });
    }
  });

  it("counts a multi-item kind across skills, distinct + busiest-first", () => {
    const rows: KindUsageRow[] = [
      { skillKey: "make_ten", manipulativeSpec: spec("rekenrek") },
      { skillKey: "make_ten", manipulativeSpec: spec("rekenrek") },
      { skillKey: "count_on", manipulativeSpec: spec("rekenrek") },
      { skillKey: "teen_numbers", manipulativeSpec: spec("rekenrek") },
    ];
    const { byKind, unparseableCount } = groupManipulativeKindUsage(rows);
    const rk = byKind.rekenrek;
    expect(rk.itemCount).toBe(4);
    // Distinct skills, alphabetised.
    expect(rk.skillKeys).toEqual(["count_on", "make_ten", "teen_numbers"]);
    // Busiest skill first, then alphabetical on ties.
    expect(rk.perSkill).toEqual([
      { skillKey: "make_ten", count: 2 },
      { skillKey: "count_on", count: 1 },
      { skillKey: "teen_numbers", count: 1 },
    ]);
    expect(unparseableCount).toBe(0);
  });

  it("a zero-item kind stays 0 while another kind has items", () => {
    const { byKind } = groupManipulativeKindUsage([
      { skillKey: "plot_points", manipulativeSpec: spec("numberline") },
    ]);
    expect(byKind.numberline.itemCount).toBe(1);
    // balance is one of the four unauthored mechanics — must read as never used.
    expect(byKind.balance.itemCount).toBe(0);
    expect(byKind.balance.skillKeys).toEqual([]);
  });

  it("counts malformed / kind-less / absent specs as unparseable, never dropped", () => {
    const rows: KindUsageRow[] = [
      { skillKey: "a", manipulativeSpec: "{ not json" }, // malformed
      { skillKey: "b", manipulativeSpec: "{}" }, // valid JSON, no kind
      { skillKey: "c", manipulativeSpec: '{"kind":123}' }, // kind not a string
      { skillKey: "d", manipulativeSpec: null }, // absent
      { skillKey: "e", manipulativeSpec: undefined }, // absent
      { skillKey: "f", manipulativeSpec: spec("array") }, // one good row
    ];
    const { byKind, unparseableCount } = groupManipulativeKindUsage(rows);
    expect(unparseableCount).toBe(5);
    expect(byKind.array.itemCount).toBe(1);
    // The bad rows must NOT be silently absorbed into any real kind's tally.
    const attributed = ALL_MANIPULATIVE_KINDS.reduce(
      (sum, k) => sum + byKind[k].itemCount,
      0,
    );
    expect(attributed).toBe(1);
  });

  it("treats a legacy/removed kind as unparseable, not a phantom mechanic", () => {
    // A spec whose `kind` parses fine but is no longer a union member (e.g. the
    // retired Factor Game). It must not create a bogus scoreboard entry.
    const { byKind, unparseableCount } = groupManipulativeKindUsage([
      { skillKey: "factors", manipulativeSpec: spec("factorGame") },
      { skillKey: "factors", manipulativeSpec: spec("array") },
    ]);
    expect(unparseableCount).toBe(1);
    expect(byKind.array.itemCount).toBe(1);
    expect(Object.keys(byKind)).not.toContain("factorGame");
  });
});
