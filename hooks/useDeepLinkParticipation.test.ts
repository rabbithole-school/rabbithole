import { describe, expect, test } from "vitest";
import {
  decideDeepLinkParticipation,
  resolvedEnrollmentStanding,
} from "./useDeepLinkParticipation";

const guestGroup = [
  { id: "g1", participation: "includes_program_guests" as const },
];
const enrolledGroup = [{ id: "g1", participation: "enrolled_only" as const }];

describe("resolvedEnrollmentStanding", () => {
  test("distinguishes still-loading (undefined) from a resolved miss (null)", () => {
    expect(resolvedEnrollmentStanding(undefined)).toBe(undefined);
    expect(resolvedEnrollmentStanding(null)).toBe(null);
    expect(
      resolvedEnrollmentStanding({ enrollmentStanding: "program_guest" }),
    ).toBe("program_guest");
    expect(resolvedEnrollmentStanding({ enrollmentStanding: "enrolled" })).toBe(
      "enrolled",
    );
  });
});

describe("decideDeepLinkParticipation", () => {
  const base = {
    enabled: true,
    scholarSlugPresent: false,
    scholarEnrollmentStanding: undefined,
    groupId: null as string | null,
    groups: [] as { id: string; participation: "enrolled_only" | "includes_program_guests" }[],
    rosterLoading: false,
  };

  test("waits while disabled, while roster loads, or while the scholar is still resolving", () => {
    expect(decideDeepLinkParticipation({ ...base, enabled: false })).toBe("wait");
    expect(decideDeepLinkParticipation({ ...base, rosterLoading: true })).toBe(
      "wait",
    );
    expect(
      decideDeepLinkParticipation({
        ...base,
        scholarSlugPresent: true,
        scholarEnrollmentStanding: undefined, // in flight
      }),
    ).toBe("wait");
  });

  // The regression this whole finding is about: a guest-inclusive ?group= plus a
  // scholar slug that RESOLVED TO A MISS (null) must still latch and widen — the
  // old call site collapsed null→undefined, so it waited forever and the rail
  // stayed empty.
  test("a resolved-miss scholar slug (null) does NOT block widening on the group", () => {
    expect(
      decideDeepLinkParticipation({
        ...base,
        scholarSlugPresent: true,
        scholarEnrollmentStanding: null, // resolved miss
        groupId: "g1",
        groups: guestGroup,
      }),
    ).toBe("widen");
  });

  test("widens on a program-guest scholar, or a guest-inclusive group", () => {
    expect(
      decideDeepLinkParticipation({
        ...base,
        scholarSlugPresent: true,
        scholarEnrollmentStanding: "program_guest",
      }),
    ).toBe("widen");
    expect(
      decideDeepLinkParticipation({ ...base, groupId: "g1", groups: guestGroup }),
    ).toBe("widen");
  });

  test("settles (latches, no widen) for an ordinary enrolled deep link", () => {
    expect(
      decideDeepLinkParticipation({
        ...base,
        scholarSlugPresent: true,
        scholarEnrollmentStanding: "enrolled",
        groupId: "g1",
        groups: enrolledGroup,
      }),
    ).toBe("settle");
    // A resolved-miss scholar with an enrolled-only group settles too (nothing
    // to widen), but crucially it does NOT wait.
    expect(
      decideDeepLinkParticipation({
        ...base,
        scholarSlugPresent: true,
        scholarEnrollmentStanding: null,
        groupId: "g1",
        groups: enrolledGroup,
      }),
    ).toBe("settle");
  });
});
