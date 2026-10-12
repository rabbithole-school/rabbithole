import { describe, expect, test } from "vitest";
import { compareText, nextSort, sortRows, type SortColumn } from "./tableSort";

type Row = { id: string; n: number | null };
const byN: SortColumn<Row> = { compare: (a, b) => a.n! - b.n!, isMissing: (r) => r.n === null };
const rows: Row[] = [
  { id: "a", n: 2 },
  { id: "b", n: null },
  { id: "c", n: 1 },
  { id: "d", n: 2 },
  { id: "e", n: null },
];
const ids = (rs: Row[]) => rs.map((r) => r.id).join("");

describe("sortRows", () => {
  test("ascending, with missing values last and ties in their incoming order", () => {
    expect(ids(sortRows(rows, byN, "asc"))).toBe("cadbe");
  });
  test("descending keeps missing values last and ties stable", () => {
    expect(ids(sortRows(rows, byN, "desc"))).toBe("adcbe");
  });
  test("does not mutate its input", () => {
    const copy = [...rows];
    sortRows(rows, byN, "desc");
    expect(rows).toEqual(copy);
  });
  test("a column without isMissing sorts every row", () => {
    const text: SortColumn<{ s: string }> = { compare: (a, b) => compareText(a.s, b.s) };
    expect(sortRows([{ s: "b" }, { s: "A" }, { s: "c10" }, { s: "c2" }], text, "asc").map((r) => r.s)).toEqual([
      "A",
      "b",
      "c2",
      "c10",
    ]);
  });
});

describe("nextSort", () => {
  test("the active column flips; another column starts ascending", () => {
    expect(nextSort({ key: "due", dir: "asc" }, "due")).toEqual({ key: "due", dir: "desc" });
    expect(nextSort({ key: "due", dir: "desc" }, "due")).toEqual({ key: "due", dir: "asc" });
    expect(nextSort({ key: "due", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: null, dir: "asc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });
});
