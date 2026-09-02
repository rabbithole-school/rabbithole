import { describe, expect, it } from "vitest";
import {
  CHECK_IN_EXIT_LABEL,
  checkInExitVisible,
  checkInResultCtaLabel,
} from "./checkInResultCta";

describe("checkInResultCtaLabel", () => {
  it("invites the scholar to see what they unlocked while the Tree reveal is pending", () => {
    expect(checkInResultCtaLabel(true)).toBe("See what you unlocked");
  });

  it("reads a plain 'Back to home' once the reveal has already been shown", () => {
    expect(checkInResultCtaLabel(false)).toBe("Back to home");
  });
});

describe("checkInExitVisible", () => {
  // Regression coverage for the pilot7 f18 finding: the check-in screens had
  // NO leave/Home affordance at all — the quiet exit link fixes that, but
  // only for a real scholar's own check-in (a teacher's remote rehearsal has
  // no home to route to and keeps its existing onDone fallback).

  it("is visible whenever a real home destination is set", () => {
    expect(checkInExitVisible("/scholar")).toBe(true);
  });

  it("is hidden for a teacher remote-rehearsal (no homeHref)", () => {
    expect(checkInExitVisible(null)).toBe(false);
  });

  it("the exit label is non-alarming — never 'Leave' or 'Quit'", () => {
    expect(CHECK_IN_EXIT_LABEL).toBe("I'll come back later");
    expect(CHECK_IN_EXIT_LABEL.toLowerCase()).not.toMatch(/leave|quit|exit/);
  });
});
