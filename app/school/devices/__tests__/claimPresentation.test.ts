import { describe, expect, it } from "vitest";

import {
  awaitingClaimPresentation,
  claimPresentationOverdue,
  CLAIM_PRESENTATION_GRACE_MS,
  type ClaimPresentationInput,
} from "../claimPresentation";

const NOW = 1_760_000_000_000;

function device(
  overrides: Partial<ClaimPresentationInput> = {},
): ClaimPresentationInput {
  return {
    scholarId: "scholar-1",
    claimState: "unclaimed",
    pushedAt: NOW - 1000,
    ...overrides,
  };
}

describe("claim presentation", () => {
  it("is awaiting once the claim was pushed but never exchanged", () => {
    // The reported failure: staff assign, SimpleMDM takes the token, and the
    // console previously read this state as "Ready" while the iPad was still
    // serving the previous scholar.
    expect(awaitingClaimPresentation(device())).toBe(true);
  });

  it("is not awaiting once the device has presented the claim", () => {
    expect(awaitingClaimPresentation(device({ claimState: "claimed" }))).toBe(
      false,
    );
  });

  it("is not awaiting before anything reached SimpleMDM", () => {
    // That state is already reported as "Pending setup"; it is a push problem,
    // not a device problem, and must not be conflated with one.
    expect(awaitingClaimPresentation(device({ pushedAt: null }))).toBe(false);
  });

  it("is not awaiting on an unassigned device", () => {
    expect(awaitingClaimPresentation(device({ scholarId: null }))).toBe(false);
  });

  it("treats ordinary MDM delivery latency as normal, not as a fault", () => {
    expect(claimPresentationOverdue(device(), NOW)).toBe(false);
    expect(
      claimPresentationOverdue(
        device({ pushedAt: NOW - CLAIM_PRESENTATION_GRACE_MS }),
        NOW,
      ),
    ).toBe(false);
  });

  it("flags a device that never took the claim past the grace window", () => {
    expect(
      claimPresentationOverdue(
        device({ pushedAt: NOW - CLAIM_PRESENTATION_GRACE_MS - 1 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("never flags a device that already presented its claim", () => {
    expect(
      claimPresentationOverdue(
        device({ claimState: "claimed", pushedAt: NOW - 86_400_000 }),
        NOW,
      ),
    ).toBe(false);
  });
});
