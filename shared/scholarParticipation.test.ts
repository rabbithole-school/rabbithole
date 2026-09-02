import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCHOLAR_PARTICIPATION,
  deepLinkIncludesExtendedEducation,
  scholarMatchesParticipation,
} from "./scholarParticipation";

describe("scholar participation", () => {
  test("defaults to enrolled scholars and treats legacy rows as enrolled", () => {
    expect(
      scholarMatchesParticipation(
        { enrollmentStanding: "enrolled" },
        DEFAULT_SCHOLAR_PARTICIPATION,
      ),
    ).toBe(true);
    expect(
      scholarMatchesParticipation({}, DEFAULT_SCHOLAR_PARTICIPATION),
    ).toBe(true);
    expect(
      scholarMatchesParticipation(
        { enrollmentStanding: "program_guest" },
        DEFAULT_SCHOLAR_PARTICIPATION,
      ),
    ).toBe(false);
  });

  test("supports an Extended education-only view", () => {
    const extendedOnly = {
      enrolled: false,
      extendedEducation: true,
    };

    expect(
      scholarMatchesParticipation(
        { enrollmentStanding: "enrolled" },
        extendedOnly,
      ),
    ).toBe(false);
    expect(
      scholarMatchesParticipation(
        { enrollmentStanding: "program_guest" },
        extendedOnly,
      ),
    ).toBe(true);
  });
});

describe("deepLinkIncludesExtendedEducation", () => {
  test("stays enrolled-only for an ordinary enrolled deep link", () => {
    expect(
      deepLinkIncludesExtendedEducation({
        scholarEnrollmentStanding: "enrolled",
        scopedGroupParticipation: "enrolled_only",
      }),
    ).toBe(false);
    // No signals at all (a bare visit) also stays enrolled-only.
    expect(deepLinkIncludesExtendedEducation({})).toBe(false);
  });

  test("widens when the path scholar is a program guest", () => {
    expect(
      deepLinkIncludesExtendedEducation({
        scholarEnrollmentStanding: "program_guest",
      }),
    ).toBe(true);
    // Even when the ?group= is enrolled-only, the guest scholar still widens.
    expect(
      deepLinkIncludesExtendedEducation({
        scholarEnrollmentStanding: "program_guest",
        scopedGroupParticipation: "enrolled_only",
      }),
    ).toBe(true);
  });

  test("widens when ?group= names a guest-inclusive group", () => {
    expect(
      deepLinkIncludesExtendedEducation({
        scopedGroupParticipation: "includes_program_guests",
      }),
    ).toBe(true);
    // Group signal alone widens even with no resolved scholar (the group-only
    // deep link), and regardless of an enrolled path scholar.
    expect(
      deepLinkIncludesExtendedEducation({
        scholarEnrollmentStanding: "enrolled",
        scopedGroupParticipation: "includes_program_guests",
      }),
    ).toBe(true);
  });

  test("treats missing/legacy signals as enrolled-only", () => {
    expect(
      deepLinkIncludesExtendedEducation({
        scholarEnrollmentStanding: null,
        scopedGroupParticipation: null,
      }),
    ).toBe(false);
  });
});
