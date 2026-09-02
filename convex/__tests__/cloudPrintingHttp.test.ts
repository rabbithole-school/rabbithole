import { describe, expect, test } from "vitest";
import { isPrintRelayClaimConflict } from "../lib/printRelayHttp";

describe("print relay HTTP error mapping", () => {
  test.each([
    "Print job claim is no longer valid",
    "Uncaught Error: Print job is not owned by the relay",
  ])("maps a known claim conflict to 409", (message) => {
    expect(isPrintRelayClaimConflict(new Error(message))).toBe(true);
  });

  test("does not hide an unexpected backend failure as a claim conflict", () => {
    expect(isPrintRelayClaimConflict(new Error("Database unavailable"))).toBe(false);
  });
});
