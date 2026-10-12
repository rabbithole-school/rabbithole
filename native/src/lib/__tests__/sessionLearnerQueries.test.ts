import { describe, expect, it } from "vitest";

import { shouldSkipLearnerQueries } from "../sessionLearnerQueries";

describe("shouldSkipLearnerQueries", () => {
  it("starts learner queries while session data is loading", () => {
    expect(shouldSkipLearnerQueries(undefined)).toBe(false);
  });

  it("skips learner queries once the session is known to be a test drive", () => {
    expect(
      shouldSkipLearnerQueries({
        session: { isTestDrive: true },
      }),
    ).toBe(true);
  });
});
