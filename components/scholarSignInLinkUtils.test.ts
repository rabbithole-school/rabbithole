import { describe, expect, test } from "vitest";
import { canIssueSignInLink, passwordActionLabel } from "./scholarSignInLinkUtils";

describe("canIssueSignInLink", () => {
  test.each([
    ["kai", true],
    ["  kai  ", true],
    ["", false],
    ["   ", false],
    [null, false],
    [undefined, false],
  ] as const)("username %p => %s", (username, expected) => {
    expect(canIssueSignInLink(username)).toBe(expected);
  });
});

describe("passwordActionLabel", () => {
  test.each([
    [true, "Reset password"],
    [false, "Create password"],
    // A brand-new scholar (loading / unknown) must read Create, never Reset —
    // that mislabel was the exact confusion this affordance is named to fix.
    [undefined, "Create password"],
  ] as const)("hasCredential %p => %s", (hasCredential, expected) => {
    expect(passwordActionLabel(hasCredential)).toBe(expected);
  });

  // The noun itself is load-bearing: the sign-in forms both say "Password", so
  // a scholar who sets one here must not meet a different word there.
  test("never says PIN", () => {
    for (const has of [true, false, undefined] as const) {
      expect(passwordActionLabel(has)).not.toMatch(/PIN/i);
    }
  });
});
