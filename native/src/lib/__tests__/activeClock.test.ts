import { describe, expect, it } from "vitest";

import { createActiveClock } from "../activeClock";

// A realistic open instant. The clock treats openedAt === 0 as "not opened
// yet" (production always opens at Date.now(), never 0), so tests open at a
// non-zero epoch and offset from it.
const T0 = 100_000;

describe("createActiveClock", () => {
  it("returns the persisted base before it opens", () => {
    const clock = createActiveClock();
    // No open() yet: reading the clock is answered from nothing measured.
    expect(clock.activeMs(T0 + 10_000)).toBe(0);
  });

  it("counts wall-clock elapsed since open on top of the base", () => {
    const clock = createActiveClock();
    clock.open(T0, 500, false);
    expect(clock.activeMs(T0)).toBe(500); // no time has passed yet
    expect(clock.activeMs(T0 + 3_000)).toBe(500 + 3_000);
  });

  it("excludes a paused span from active time", () => {
    const clock = createActiveClock();
    clock.open(T0, 0, false);
    clock.setPauseReason("coach", true, T0 + 1_000); // 1s active, then paused
    expect(clock.activeMs(T0 + 1_500)).toBe(1_000); // frozen while paused
    clock.setPauseReason("coach", false, T0 + 3_000); // paused for 2s
    expect(clock.activeMs(T0 + 5_000)).toBe(3_000); // 5s wall - 2s paused
  });

  it("reference-counts overlapping reasons so a span is counted once", () => {
    const clock = createActiveClock();
    clock.open(T0, 0, false);
    clock.setPauseReason("background", true, T0 + 1_000); // pause opens at 1s
    clock.setPauseReason("coach", true, T0 + 1_500); // still one paused span
    clock.setPauseReason("background", false, T0 + 2_000); // one reason still holds
    expect(clock.activeMs(T0 + 2_500)).toBe(1_000); // still paused, frozen at 1s
    clock.setPauseReason("coach", false, T0 + 3_000); // last reason releases: 2s paused
    expect(clock.activeMs(T0 + 6_000)).toBe(4_000); // 6s wall - 2s paused
  });

  it("ignores engaging an already-held reason or releasing an unheld one", () => {
    const clock = createActiveClock();
    clock.open(T0, 0, false);
    clock.setPauseReason("coach", true, T0 + 1_000);
    clock.setPauseReason("coach", true, T0 + 2_000); // duplicate engage: no new span
    clock.setPauseReason("background", false, T0 + 2_500); // release of an unheld reason
    clock.setPauseReason("coach", false, T0 + 4_000); // paused 1s..4s = 3s
    expect(clock.activeMs(T0 + 5_000)).toBe(2_000); // 5s wall - 3s paused
  });

  it("starts paused when opened in the background and resumes on foreground", () => {
    const clock = createActiveClock();
    clock.open(T0, 0, true); // opened backgrounded -> paused from open
    expect(clock.activeMs(T0 + 2_000)).toBe(0); // no active time while backgrounded
    clock.setPauseReason("background", false, T0 + 2_000); // foregrounded at 2s
    expect(clock.activeMs(T0 + 5_000)).toBe(3_000); // only the foregrounded 3s count
  });

  it("never returns less than the base even if paused longer than elapsed", () => {
    const clock = createActiveClock();
    clock.open(T0, 250, false);
    clock.setPauseReason("coach", true, T0);
    // Query at the open instant: no active time has accrued, so just the base.
    expect(clock.activeMs(T0)).toBe(250);
  });

  it("open() resets prior pause state", () => {
    const clock = createActiveClock();
    clock.open(T0, 0, false);
    clock.setPauseReason("coach", true, T0 + 500); // leave a reason held...
    clock.open(T0 + 10_000, 0, false); // ...then a fresh round wipes it
    expect(clock.activeMs(T0 + 13_000)).toBe(3_000); // runs clean, nothing paused
  });
});
