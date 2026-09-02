import { describe, expect, test } from "vitest";
import {
  normalizePassword,
  passwordAuthParams,
  passwordsMatch,
} from "./password";

describe("password normalization", () => {
  test("removes leading and trailing whitespace without changing the interior", () => {
    expect(normalizePassword(" \t open sesame \n")).toBe("open sesame");
    expect(normalizePassword("Open  Sesame")).toBe("Open  Sesame");
  });

  test("compares confirmations after applying the same normalization", () => {
    expect(passwordsMatch("  rabbit hole", "rabbit hole  ")).toBe(true);
    expect(passwordsMatch("rabbit hole", "rabbit  hole")).toBe(false);
  });

  test("preserves sign-in input for legacy credential verification", () => {
    expect(passwordAuthParams("  burrow  ", "signIn")).toEqual({
      password: "  burrow  ",
      flow: "signIn",
    });
  });
});
