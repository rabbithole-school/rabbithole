import { describe, expect, test } from "vitest";

import {
  EXTERNAL_RETURN_WINDOW_MS,
  FOREGROUND_PRESENCE_GAP_MS,
  UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
  msToMinutes,
  rollupDeviceActivityDay,
  type RollupEvent,
} from "./deviceActivityRollup";

const MINUTE = 60_000;
const T0 = Date.parse("2026-09-14T18:00:00.000Z"); // 08:00 Pacific/Honolulu

function event(
  kind: RollupEvent["kind"],
  atMinutes: number,
  overrides: Partial<RollupEvent> = {},
): RollupEvent {
  return {
    kind,
    clientAt: T0 + atMinutes * MINUTE,
    context: "core_day",
    ...overrides,
  };
}

/** A minute of foreground presence: heartbeats one minute apart. */
function heartbeats(fromMinute: number, count: number, context = "core_day") {
  return Array.from({ length: count }, (_, index) =>
    event("heartbeat", fromMinute + index, { context }),
  );
}

describe("rollupDeviceActivityDay", () => {
  test("an empty day is all zeros", () => {
    const rollup = rollupDeviceActivityDay([]);
    expect(rollup.foregroundMs).toBe(0);
    expect(rollup.totals).toEqual({ measuredMs: 0, estimatedMs: 0 });
    expect(rollup.apps).toEqual([]);
    expect(rollup.estimatedIntervals).toBe(0);
    expect(rollup.eventCount).toBe(0);
  });

  test("heartbeats measure foreground minute by minute", () => {
    // foreground at 0, heartbeats 1..10, background at 11 → 11 minutes.
    const rollup = rollupDeviceActivityDay([
      event("app_foreground", 0),
      ...heartbeats(1, 10),
      event("app_background", 11),
    ]);
    expect(msToMinutes(rollup.foregroundMs)).toBe(11);
    expect(msToMinutes(rollup.totals.measuredMs)).toBe(11);
    expect(rollup.totals.estimatedMs).toBe(0);
    expect(rollup.unattributedBackgroundMs).toBe(0);
  });

  test("backgrounded time is unattributed, never foreground", () => {
    const rollup = rollupDeviceActivityDay([
      event("app_foreground", 0),
      event("app_background", 5),
      event("app_foreground", 45),
      event("heartbeat", 46),
    ]);
    // 5 min before the background + 1 min after the return.
    expect(msToMinutes(rollup.foregroundMs)).toBe(6);
    expect(msToMinutes(rollup.unattributedBackgroundMs)).toBe(40);
  });

  test("a lost-heartbeat gap is capped, and the excess is unattributed", () => {
    // One heartbeat, then silence for an hour, then a background.
    const rollup = rollupDeviceActivityDay([
      event("heartbeat", 0),
      event("app_background", 60),
    ]);
    expect(rollup.foregroundMs).toBe(FOREGROUND_PRESENCE_GAP_MS);
    expect(rollup.unattributedBackgroundMs).toBe(
      60 * MINUTE - FOREGROUND_PRESENCE_GAP_MS,
    );
    // A gap we could not vouch for is NOT an estimate — it is simply not ours.
    expect(rollup.totals.estimatedMs).toBe(0);
  });

  test("a launch that returns is measured in full", () => {
    const rollup = rollupDeviceActivityDay([
      event("app_foreground", 0),
      event("external_launch", 5, { externalAppId: "spike" }),
      event("external_return", 35, { externalAppId: "spike" }),
      event("app_background", 40),
    ]);
    expect(msToMinutes(rollup.foregroundMs)).toBe(10); // 0→5 and 35→40
    expect(rollup.apps).toHaveLength(1);
    expect(rollup.apps[0]).toMatchObject({
      externalAppId: "spike",
      estimatedMs: 0,
      estimatedIntervals: 0,
    });
    expect(msToMinutes(rollup.apps[0].measuredMs)).toBe(30);
    expect(msToMinutes(rollup.totals.measuredMs)).toBe(40);
    expect(rollup.totals.estimatedMs).toBe(0);
    expect(rollup.estimatedIntervals).toBe(0);
  });

  test("THE ESTIMATE RULE: a launch with no return is capped, not attributed", () => {
    // The end-of-day case: into an external app at 14:00, iPad locked, back the
    // next morning. Attributing the whole gap would book ~18 hours.
    const rollup = rollupDeviceActivityDay([
      event("app_foreground", 0),
      ...heartbeats(1, 9),
      event("external_launch", 10, { externalAppId: "spike" }),
      event("app_foreground", 10 + 18 * 60),
    ]);
    expect(rollup.apps[0].measuredMs).toBe(0);
    expect(rollup.apps[0].estimatedMs).toBe(
      UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
    );
    expect(rollup.apps[0].estimatedIntervals).toBe(1);
    expect(rollup.estimatedIntervals).toBe(1);
    // Measured stays honest: only the 10 minutes of real foreground.
    expect(msToMinutes(rollup.totals.measuredMs)).toBe(10);
    expect(msToMinutes(rollup.totals.estimatedMs)).toBe(10);
    // The rest of the gap is declared unattributed rather than invented.
    expect(msToMinutes(rollup.unattributedBackgroundMs)).toBe(
      18 * 60 - msToMinutes(UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS),
    );
  });

  test("a return just outside the window is an estimate, just inside is measured", () => {
    const justInside = rollupDeviceActivityDay([
      event("external_launch", 0, { externalAppId: "sheets" }),
      {
        kind: "external_return",
        clientAt: T0 + EXTERNAL_RETURN_WINDOW_MS,
        context: "core_day",
        externalAppId: "sheets",
      },
    ]);
    expect(justInside.apps[0].measuredMs).toBe(EXTERNAL_RETURN_WINDOW_MS);
    expect(justInside.estimatedIntervals).toBe(0);

    const justOutside = rollupDeviceActivityDay([
      event("external_launch", 0, { externalAppId: "sheets" }),
      {
        kind: "external_return",
        clientAt: T0 + EXTERNAL_RETURN_WINDOW_MS + 1,
        context: "core_day",
        externalAppId: "sheets",
      },
    ]);
    expect(justOutside.apps[0].measuredMs).toBe(0);
    expect(justOutside.apps[0].estimatedMs).toBe(
      UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
    );
    expect(justOutside.estimatedIntervals).toBe(1);
  });

  test("a launch that is the last event of the day is still capped", () => {
    const rollup = rollupDeviceActivityDay([
      event("app_foreground", 0),
      event("external_launch", 5, { externalAppId: "stopmotion" }),
    ]);
    expect(rollup.apps[0].estimatedMs).toBe(
      UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
    );
    expect(rollup.estimatedIntervals).toBe(1);
    // No successor means no observed residual to declare unattributed.
    expect(rollup.unattributedBackgroundMs).toBe(0);
  });

  test("measured and estimated stay in separate columns per app", () => {
    const rollup = rollupDeviceActivityDay([
      event("external_launch", 0, { externalAppId: "spike" }),
      event("external_return", 20, { externalAppId: "spike" }),
      event("external_launch", 25, { externalAppId: "spike" }),
      event("app_foreground", 25 + 10 * 60),
    ]);
    const spike = rollup.apps[0];
    expect(msToMinutes(spike.measuredMs)).toBe(20);
    expect(msToMinutes(spike.estimatedMs)).toBe(10);
    expect(spike.estimatedIntervals).toBe(1);
    expect(msToMinutes(rollup.totals.measuredMs)).toBe(25); // 20 app + 5 foreground
    expect(msToMinutes(rollup.totals.estimatedMs)).toBe(10);
  });

  test("apps are reported separately and ordered by attributed time", () => {
    const rollup = rollupDeviceActivityDay([
      event("external_launch", 0, { externalAppId: "sheets" }),
      event("external_return", 5, { externalAppId: "sheets" }),
      event("external_launch", 10, { externalAppId: "spike" }),
      event("external_return", 40, { externalAppId: "spike" }),
    ]);
    expect(rollup.apps.map((a) => a.externalAppId)).toEqual(["spike", "sheets"]);
  });

  test("time is split by the context tag of the interval that opened it", () => {
    const rollup = rollupDeviceActivityDay([
      event("app_foreground", 0, { context: "core_day" }),
      event("app_background", 4, { context: "core_day" }),
      event("app_foreground", 100, { context: "extended_ed" }),
      event("external_launch", 103, {
        context: "extended_ed",
        externalAppId: "spike",
      }),
      event("external_return", 113, {
        context: "extended_ed",
        externalAppId: "spike",
      }),
      event("app_background", 115, { context: "extended_ed" }),
    ]);
    expect(msToMinutes(rollup.byContext.core_day.measuredMs)).toBe(4);
    // 3 min foreground + 10 min in SPIKE + 2 min back in Rabbithole.
    expect(msToMinutes(rollup.byContext.extended_ed.measuredMs)).toBe(15);
  });

  test("estimated minutes are booked against the launching interval's context", () => {
    const rollup = rollupDeviceActivityDay([
      event("external_launch", 0, {
        context: "homework",
        externalAppId: "sheets",
      }),
      event("app_foreground", 12 * 60, { context: "core_day" }),
    ]);
    expect(rollup.byContext.homework.estimatedMs).toBe(
      UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
    );
    expect(rollup.byContext.homework.measuredMs).toBe(0);
  });

  test("events may arrive out of order and duplicated", () => {
    const ordered = rollupDeviceActivityDay([
      event("app_foreground", 0),
      event("heartbeat", 1),
      event("app_background", 2),
    ]);
    const shuffled = rollupDeviceActivityDay([
      event("app_background", 2),
      event("app_foreground", 0),
      event("heartbeat", 1),
    ]);
    expect(shuffled.foregroundMs).toBe(ordered.foregroundMs);

    // A duplicated row is a zero-length gap: it contributes nothing.
    const duplicated = rollupDeviceActivityDay([
      event("app_foreground", 0),
      event("heartbeat", 1),
      event("heartbeat", 1),
      event("app_background", 2),
    ]);
    expect(duplicated.foregroundMs).toBe(ordered.foregroundMs);
  });

  test("a launch with no app id still counts toward the day totals", () => {
    const rollup = rollupDeviceActivityDay([
      event("external_launch", 0),
      event("external_return", 15),
    ]);
    expect(rollup.apps).toEqual([]);
    expect(msToMinutes(rollup.totals.measuredMs)).toBe(15);
  });

  test("diagnostic kinds never move a usage number (TRA-331)", () => {
    const usage = [
      event("app_foreground", 0),
      ...heartbeats(1, 4),
      event("external_launch", 5, { externalAppId: "spike" }),
      event("external_return", 20, { externalAppId: "spike" }),
      event("app_background", 22),
      event("app_foreground", 40),
      event("heartbeat", 41),
    ];
    // Each diagnostic lands INSIDE a span the roll-up books: a lock change
    // between a foreground and its heartbeat, one right after a launch (where
    // the adjacent-event rule decides measured vs. estimated), and a
    // stuck-inactive report + its end inside a background stretch.
    const withDiagnostics = [
      ...usage,
      event("asam_exit", 0.5),
      event("asam_enter", 5.5),
      event("app_stuck_inactive", 22),
      event("app_stuck_inactive", 22),
      event("app_stuck_inactive_end", 39),
      event("asam_enter", 40.5),
    ];
    expect(rollupDeviceActivityDay(withDiagnostics)).toEqual(
      rollupDeviceActivityDay(usage),
    );
  });
});

describe("msToMinutes", () => {
  test("reports one decimal place", () => {
    expect(msToMinutes(0)).toBe(0);
    expect(msToMinutes(30_000)).toBe(0.5);
    expect(msToMinutes(65_000)).toBe(1.1);
  });
});
