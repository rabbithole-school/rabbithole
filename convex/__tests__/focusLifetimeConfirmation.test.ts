import { describe, expect, test } from "vitest";
import { classFocusLifetimeConfirmation } from "../lib/assignmentTools";

describe("class focus lifetime confirmation", () => {
  test("does not invent a duration when the teacher gave none", () => {
    expect(classFocusLifetimeConfirmation(undefined)).toBe(
      'Live now · fades from their screen after today. Say "make it homework" or give a lifetime to keep it.',
    );
  });

  test("states an explicit end time in the school time zone label", () => {
    const endsAt = Date.UTC(2026, 8, 12, 1, 0);
    expect(classFocusLifetimeConfirmation(endsAt)).toBe(
      "Live now · stays until Fri, Sep 11, 3:00 PM HST",
    );
  });

  test("describes an unspecified queued focus without claiming it is live", () => {
    expect(classFocusLifetimeConfirmation(undefined, false)).toBe(
      'Queued · fades from their screen after the day it goes live. Say "make it homework" or give a lifetime to keep it.',
    );
  });
});
