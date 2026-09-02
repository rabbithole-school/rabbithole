import { describe, expect, test } from "vitest";
import { normalizeEmail, isValidEmail } from "../lib/email";

// Pure helpers — no convex-test needed. These back the magic-link auth
// path (case-insensitive lookup + obvious-typo rejection on trusted entry),
// so the cases here pin the exact normalization the `by_email` index relies
// on.

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
  test("leaves an already-normal address unchanged", () => {
    expect(normalizeEmail("a@b.co")).toBe("a@b.co");
  });
  test("empty stays empty", () => {
    expect(normalizeEmail("   ")).toBe("");
  });
});

describe("isValidEmail", () => {
  test.each([
    "staff.member@school.example",
    "Parent.Name@gmail.com",
    "  spaced@example.org  ",
  ])("accepts %s", (e) => {
    expect(isValidEmail(e)).toBe(true);
  });

  test.each([
    "",
    "no-at-sign",
    "two@@at.com",
    "@nolocal.com",
    "trailingdot@domain.",
    "nodot@domain",
    "has space@domain.com",
  ])("rejects %s", (e) => {
    expect(isValidEmail(e)).toBe(false);
  });
});
