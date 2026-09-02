import { describe, expect, test } from "vitest";
import { shouldShowProfileSetup } from "./profileSetup";

describe("shouldShowProfileSetup", () => {
  const incompleteScholar = {
    role: "scholar",
    profileSetupComplete: false,
  };

  test("shows setup for a scholar using their own account", () => {
    expect(shouldShowProfileSetup(incompleteScholar, false)).toBe(true);
  });

  test("suppresses setup during read-only impersonation", () => {
    expect(shouldShowProfileSetup(incompleteScholar, true)).toBe(false);
  });

  test("waits for viewing state before opening a write-only exit flow", () => {
    expect(shouldShowProfileSetup(incompleteScholar, undefined)).toBe(false);
  });

  test("does not show setup after completion or for staff", () => {
    expect(
      shouldShowProfileSetup(
        { role: "scholar", profileSetupComplete: true },
        false,
      ),
    ).toBe(false);
    expect(shouldShowProfileSetup({ role: "teacher" }, false)).toBe(false);
  });
});
