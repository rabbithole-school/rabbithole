import { describe, expect, test } from "vitest";
import {
  APP_CHECKIN_FRESH_MS,
  MDM_READING_FRESH_MS,
  chargeReminderKeyword,
  chargeReminderText,
  chargeReminderVerdict,
  type BatteryEvidence,
} from "../chargeReminder";

const NOW = Date.parse("2026-11-05T06:00:00.000Z"); // 20:00 HST
const MIN = 60_000;

const evidence = (e: Partial<BatteryEvidence>): BatteryEvidence => ({
  app: null,
  mdm: null,
  ...e,
});

describe("chargeReminderVerdict", () => {
  test("texts a low battery with no app check-in (a closed lid is not a charger)", () => {
    expect(
      chargeReminderVerdict(evidence({ mdm: { at: NOW - 40 * MIN, level: 14 } }), NOW),
    ).toEqual({ send: true, level: 14 });
  });

  test("texts a low battery whose fresh check-in says unplugged", () => {
    expect(
      chargeReminderVerdict(
        evidence({ app: { at: NOW - 2 * MIN, level: 11, state: "unplugged" } }),
        NOW,
      ),
    ).toEqual({ send: true, level: 11 });
  });

  test("skips a low battery whose fresh check-in says charging or full", () => {
    for (const state of ["charging", "full"] as const) {
      expect(
        chargeReminderVerdict(
          evidence({
            app: { at: NOW - 2 * MIN, level: 12, state },
            mdm: { at: NOW - 40 * MIN, level: 9 },
          }),
          NOW,
        ),
      ).toEqual({ send: false, reason: "charging" });
    }
  });

  test("a stale 'charging' check-in counts for nothing", () => {
    expect(
      chargeReminderVerdict(
        evidence({
          app: { at: NOW - APP_CHECKIN_FRESH_MS - 1, level: 12, state: "charging" },
          mdm: { at: NOW - 40 * MIN, level: 9 },
        }),
        NOW,
      ),
    ).toEqual({ send: true, level: 9 });
  });

  test("never texts a battery that isn't low", () => {
    expect(
      chargeReminderVerdict(evidence({ mdm: { at: NOW - 40 * MIN, level: 20 } }), NOW),
    ).toEqual({ send: false, reason: "not-low" });
    expect(
      chargeReminderVerdict(
        evidence({ app: { at: NOW - MIN, level: 62, state: "unplugged" } }),
        NOW,
      ),
    ).toEqual({ send: false, reason: "not-low" });
  });

  test("the fresh app level wins over SimpleMDM's", () => {
    expect(
      chargeReminderVerdict(
        evidence({
          app: { at: NOW - MIN, level: 45, state: "unplugged" },
          mdm: { at: NOW - 40 * MIN, level: 10 },
        }),
        NOW,
      ),
    ).toEqual({ send: false, reason: "not-low" });
  });

  test("no fresh reading at all means no text", () => {
    expect(chargeReminderVerdict(evidence({}), NOW)).toEqual({
      send: false,
      reason: "no-reading",
    });
    expect(
      chargeReminderVerdict(
        evidence({ mdm: { at: NOW - MDM_READING_FRESH_MS - 1, level: 5 } }),
        NOW,
      ),
    ).toEqual({ send: false, reason: "no-reading" });
    // A fresh check-in without a level (iOS reported -1) falls back to MDM.
    expect(
      chargeReminderVerdict(
        evidence({ app: { at: NOW - MIN, level: null, state: "unplugged" } }),
        NOW,
      ),
    ).toEqual({ send: false, reason: "no-reading" });
  });
});

describe("chargeReminderText", () => {
  const isGsm = (s: string) => /^[\x20-\x7e]*$/.test(s);

  test("every variant is plain GSM and fits one segment for a typical name", () => {
    const one = [{ name: "Juniper", level: 14 }];
    const two = [
      { name: "Juniper", level: 14 },
      { name: "Ollie", level: 9 },
    ];
    for (const kids of [one, two]) {
      for (const afterBreak of [false, true]) {
        const text = chargeReminderText({
          schoolName: "Seaside School",
          kids,
          afterBreak,
        });
        expect(isGsm(text)).toBe(true);
        expect(text.length).toBeLessThanOrEqual(160);
        expect(text).toContain("NO REMINDERS");
        expect(text.startsWith("Seaside School: ")).toBe(true);
      }
    }
  });

  test("one kid carries the percent; several are listed by name", () => {
    expect(
      chargeReminderText({
        schoolName: "Moli School",
        kids: [{ name: "Kai", level: 14 }],
        afterBreak: false,
      }),
    ).toContain("Kai's BunnyPad is at 14%");
    expect(
      chargeReminderText({
        schoolName: "Moli School",
        kids: [
          { name: "Ada", level: 3 },
          { name: "Kai", level: 14 },
          { name: "Noe", level: 9 },
        ],
        afterBreak: false,
      }),
    ).toContain("Ada's, Kai's and Noe's BunnyPads");
  });

  test("the night before school resumes says so", () => {
    expect(
      chargeReminderText({
        schoolName: "Moli School",
        kids: [{ name: "Kai", level: 14 }],
        afterBreak: true,
      }),
    ).toContain("School starts again tomorrow!");
  });
});

describe("chargeReminderKeyword", () => {
  test("whole-text switches only", () => {
    for (const off of ["NO REMINDERS", "no reminders.", "Stop reminders", "reminders off", "No reminder!"]) {
      expect(chargeReminderKeyword(off)).toBe("off");
    }
    for (const on of ["REMINDERS ON", "start reminders", "Reminders on!"]) {
      expect(chargeReminderKeyword(on)).toBe("on");
    }
    for (const other of [
      "stop",
      "can you stop the reminders on weekends?",
      "no reminders for Kai please",
      "reminders",
    ]) {
      expect(chargeReminderKeyword(other)).toBeNull();
    }
  });
});
