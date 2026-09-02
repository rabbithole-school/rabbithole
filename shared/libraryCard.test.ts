import { describe, expect, test } from "vitest";

import {
  LIBRARY_CARD_HELPER_COPY,
  libraryCardValidationIssue,
  libraryCredentialRevision,
  maskLibraryCardNumber,
  normalizeLibraryCardInput,
} from "./libraryCard";

describe("library card privacy and validation", () => {
  test("normalizes outer whitespace without inventing a card-number format", () => {
    expect(normalizeLibraryCardInput("  AB-12 34  ", "  0042 ")).toEqual({
      cardNumber: "AB-12 34",
      pin: "0042",
    });
    expect(libraryCardValidationIssue("AB-12 34", "0042")).toBeNull();
  });

  test("requires both credentials and rejects controls or oversized values", () => {
    expect(libraryCardValidationIssue("", "1234")).toMatchObject({
      field: "cardNumber",
      code: "card_number_required",
    });
    expect(libraryCardValidationIssue("card", "")).toMatchObject({
      field: "pin",
      code: "pin_required",
    });
    expect(libraryCardValidationIssue("card\u0000", "1234")).toMatchObject({
      field: "cardNumber",
      code: "card_number_unsupported_characters",
    });
    expect(libraryCardValidationIssue("card", "x".repeat(65))).toMatchObject({
      field: "pin",
      code: "pin_too_long",
    });
  });

  test("masks all short numbers and only exposes the last four of longer ones", () => {
    expect(maskLibraryCardNumber("123")).toBe("••••");
    expect(maskLibraryCardNumber("1234567890")).toBe("•••• 7890");
    expect(maskLibraryCardNumber("1234567890")).not.toContain("123456");
  });

  test("treats legacy credentials as revision one", () => {
    expect(libraryCredentialRevision(undefined)).toBe(0);
    expect(libraryCredentialRevision({})).toBe(1);
    expect(libraryCredentialRevision(undefined, 4)).toBe(4);
    expect(libraryCredentialRevision({}, 7)).toBe(7);
  });

  test("keeps the required parent helper copy exact", () => {
    expect(LIBRARY_CARD_HELPER_COPY).toBe(
      "Don’t have one yet? No worries—we’ll sign your child up when our class visits the library.",
    );
  });
});
