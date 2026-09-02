import { describe, expect, test } from "vitest";
import {
  ENROLLMENT_STANDINGS,
  isEnrolledScholar,
  isProgramGuest,
} from "../enrollmentStanding";

describe("enrollment standing", () => {
  test("treats legacy rows as fully enrolled", () => {
    expect(isEnrolledScholar({})).toBe(true);
    expect(isProgramGuest({})).toBe(false);
  });

  test("identifies program guests explicitly", () => {
    const scholar = {
      enrollmentStanding: ENROLLMENT_STANDINGS.PROGRAM_GUEST,
    };
    expect(isProgramGuest(scholar)).toBe(true);
    expect(isEnrolledScholar(scholar)).toBe(false);
  });
});
