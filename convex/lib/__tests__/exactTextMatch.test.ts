import { describe, expect, test } from "vitest";
import { findExactlyOneLiteral } from "../exactTextMatch";

describe("findExactlyOneLiteral", () => {
  test("distinguishes empty, missing, unique, and repeated literal matches", () => {
    expect(findExactlyOneLiteral("abc", "")).toEqual({
      kind: "invalid",
      reason: "empty_needle",
    });
    expect(findExactlyOneLiteral("abc", "z")).toEqual({ kind: "none" });
    expect(findExactlyOneLiteral("abc", "b")).toEqual({ kind: "one", index: 1 });
    expect(findExactlyOneLiteral("repeat repeat", "repeat")).toEqual({
      kind: "many",
      count: 2,
    });
  });
});
