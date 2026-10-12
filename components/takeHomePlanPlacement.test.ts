import { describe, expect, test } from "vitest";

import { afterPrepEvening } from "@/components/takeHomePlanPlacement";

// Truth table for the evening Home: when the Now tab is past Prep (and the
// dated "Coming up" forecast joins it).
describe("after-Prep evening on the Now tab", () => {
  test("after Prep, with homework showing on Now", () => {
    expect(
      afterPrepEvening({ isRemoteMode: false, showHomeworkInNow: true, isPrepTime: false }),
    ).toBe(true);
  });

  test("inside the Prep window the forecast stays on the Prep tab", () => {
    expect(
      afterPrepEvening({ isRemoteMode: false, showHomeworkInNow: true, isPrepTime: true }),
    ).toBe(false);
  });

  test("during school hours (no homework on Now) it is not the evening", () => {
    expect(
      afterPrepEvening({ isRemoteMode: false, showHomeworkInNow: false, isPrepTime: false }),
    ).toBe(false);
  });

  test("a teacher's remote view never gets the scholar's evening layout", () => {
    expect(
      afterPrepEvening({ isRemoteMode: true, showHomeworkInNow: true, isPrepTime: false }),
    ).toBe(false);
  });
});
