import { describe, it, expect } from "vitest";
import { filterScholarsByScope, scopeCountLabel } from "../roundsBoardScope";

type Row = { scholarId: string; scholarName: string };

const board: Row[] = [
  { scholarId: "a", scholarName: "Ada" },
  { scholarId: "b", scholarName: "Ben" },
  { scholarId: "c", scholarName: "Cy" },
  { scholarId: "d", scholarName: "Dot" },
];

describe("filterScholarsByScope", () => {
  it("returns the whole board for All scholars (null / undefined)", () => {
    expect(filterScholarsByScope(board, null)).toEqual(board);
    expect(filterScholarsByScope(board, undefined)).toEqual(board);
    // A fresh array, so the caller can sort/split it without mutating source.
    expect(filterScholarsByScope(board, null)).not.toBe(board);
  });

  it("keeps only the selected group's scholars, board order preserved", () => {
    const group = new Set(["b", "d"]);
    const rows = filterScholarsByScope(board, group);
    expect(rows.map((r) => r.scholarId)).toEqual(["b", "d"]);
  });

  it("ignores group members who are not on the board this week", () => {
    // A group can name a scholar not enrolled in this reporting period; the
    // filter is an intersection, so such an id simply drops out.
    const group = new Set(["b", "zzz-not-in-period"]);
    const rows = filterScholarsByScope(board, group);
    expect(rows.map((r) => r.scholarId)).toEqual(["b"]);
  });

  it("yields an empty board when the group has no scholars this week", () => {
    const group = new Set(["ghost"]);
    expect(filterScholarsByScope(board, group)).toEqual([]);
  });
});

describe("scopeCountLabel", () => {
  it("is null for All scholars (not scoped)", () => {
    expect(scopeCountLabel(4, 4, false)).toBeNull();
  });

  it("is null when a scope happens to include the whole roster", () => {
    expect(scopeCountLabel(4, 4, true)).toBeNull();
  });

  it("reports N of M, sentence case, when a scope hides rows", () => {
    expect(scopeCountLabel(2, 4, true)).toBe("Showing 2 of 4 scholars");
  });

  it("reports an empty scope honestly", () => {
    expect(scopeCountLabel(0, 4, true)).toBe("Showing 0 of 4 scholars");
  });
});
