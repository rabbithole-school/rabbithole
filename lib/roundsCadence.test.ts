import { describe, expect, it } from "vitest";
import {
  assertValidRoundsCadences,
  DEFAULT_ROUNDS_ANCHOR,
  explicitRoundsCadencesFor,
  parseRoundsCadenceParam,
  roundsAnchorFor,
  roundsCadencesFor,
  roundsWeekKey,
  alignRoundsWeekKey,
  roundsWeekKeyForDay,
  roundsWeekLabel,
  roundsWeekStartMs,
  roundsWeekWindow,
  shiftRoundsWeekKey,
  type RoundsAnchor,
} from "./roundsCadence";
// The learner's weekly-goal week is `convex/weeklyGoals.ts → mondayWeekOf`,
// which is a one-line delegation to this primitive. Importing the primitive
// keeps this a pure unit test while asserting against the same arithmetic.
import { mondayDayKeyForTimezone } from "../shared/institutionDay";

const weeklyGoalWeekOf = (atMs: number, timeZone: string) =>
  mondayDayKeyForTimezone(atMs, 0, timeZone);

/** Primary-school fixture anchor: Thursday 15:00, end of the school day. */
const THURSDAY_3PM: RoundsAnchor = { weekday: 4, minutes: 900 };
/** A school that meets on a Tuesday morning — no code change required. */
const TUESDAY_9AM: RoundsAnchor = { weekday: 2, minutes: 540 };

describe("Rounds cadence — default anchor", () => {
  it("keys a week by its institution-local Monday", () => {
    // Wednesday evening in Honolulu, Thursday morning in UTC.
    const at = Date.parse("2026-08-20T05:00:00.000Z");
    expect(roundsWeekKey(at, "Pacific/Honolulu")).toBe("2026-08-17");
  });

  it("does not let a daylight-saving transition change the week", () => {
    const before = Date.parse("2026-03-08T06:59:00.000Z");
    const after = Date.parse("2026-03-09T05:01:00.000Z");
    expect(roundsWeekKey(before, "America/New_York")).toBe("2026-03-02");
    expect(roundsWeekKey(after, "America/New_York")).toBe("2026-03-09");
  });

  it("shifts persisted agenda keys by calendar weeks", () => {
    expect(shiftRoundsWeekKey("2026-12-28", 1)).toBe("2027-01-04");
    expect(shiftRoundsWeekKey("2027-01-04", -1)).toBe("2026-12-28");
  });

  /**
   * The regression guard for every `weekKey` already stored: an institution
   * with no anchor configured must produce exactly the keys the Monday-00:00
   * implementation produced, in every timezone, on every day of the week.
   */
  it("reproduces the historical Monday 00:00 keys for an unconfigured school", () => {
    for (const timeZone of [
      "Pacific/Honolulu",
      "America/New_York",
      "Europe/London",
      "Pacific/Auckland",
    ]) {
      for (let day = 0; day < 21; day += 1) {
        for (const hourUtc of [0, 6, 13, 23]) {
          const at =
            Date.parse("2026-03-01T00:00:00.000Z") +
            day * 86_400_000 +
            hourUtc * 3_600_000;
          const anchored = roundsWeekKey(at, timeZone, DEFAULT_ROUNDS_ANCHOR);
          expect(anchored).toBe(weeklyGoalWeekOf(at, timeZone));
          // …and the default argument must BE the default anchor.
          expect(roundsWeekKey(at, timeZone)).toBe(anchored);
        }
      }
    }
  });
});

describe("Rounds cadence — configured anchors", () => {
  it("resolves each kind independently, with legacy fallback only for academic", () => {
    const institution = {
      roundsCadences: [
        { kind: "academic" as const, weekday: 2, minutes: 900 },
        { kind: "sel" as const, weekday: 4, minutes: 840 },
      ],
      roundsAnchorWeekday: 5,
      roundsAnchorMinutes: 600,
    };
    expect(roundsAnchorFor(institution, "academic")).toEqual({
      weekday: 2,
      minutes: 900,
    });
    expect(roundsAnchorFor(institution, "sel")).toEqual({
      weekday: 4,
      minutes: 840,
    });
    expect(roundsCadencesFor(institution)).toEqual(institution.roundsCadences);

    const legacy = { roundsAnchorWeekday: 5, roundsAnchorMinutes: 600 };
    expect(roundsAnchorFor(legacy, "academic")).toEqual({
      weekday: 5,
      minutes: 600,
    });
    expect(roundsAnchorFor(legacy, "sel")).toBeNull();
    expect(roundsCadencesFor(legacy)).toEqual([
      { kind: "academic", weekday: 5, minutes: 600 },
    ]);

    expect(roundsAnchorFor({}, "academic")).toEqual(DEFAULT_ROUNDS_ANCHOR);
    expect(roundsAnchorFor({}, "sel")).toBeNull();
  });

  it("rejects duplicate kinds and invalid stored values", () => {
    expect(() =>
      assertValidRoundsCadences([
        { kind: "academic", weekday: 2, minutes: 900 },
        { kind: "academic", weekday: 4, minutes: 900 },
      ]),
    ).toThrow(/at most one academic/);
    expect(() =>
      assertValidRoundsCadences([
        { kind: "sel", weekday: 7, minutes: 900 },
      ]),
    ).toThrow(/Rounds anchor weekday/);
    expect(() => assertValidRoundsCadences([])).toThrow(/one academic entry/);
    expect(() =>
      assertValidRoundsCadences([
        { kind: "sel", weekday: 4, minutes: 900 },
      ]),
    ).toThrow(/one academic entry/);
  });

  it("distinguishes explicit cadence config from the compatibility default", () => {
    expect(explicitRoundsCadencesFor({})).toEqual([]);
    expect(
      explicitRoundsCadencesFor({
        roundsAnchorWeekday: 2,
        roundsAnchorMinutes: 900,
      }),
    ).toEqual([{ kind: "academic", weekday: 2, minutes: 900 }]);
    expect(
      explicitRoundsCadencesFor({
        roundsCadences: [
          { kind: "academic", weekday: 3, minutes: 840 },
          { kind: "sel", weekday: 5, minutes: 900 },
        ],
        roundsAnchorWeekday: 2,
        roundsAnchorMinutes: 900,
      }),
    ).toEqual([
      { kind: "academic", weekday: 3, minutes: 840 },
      { kind: "sel", weekday: 5, minutes: 900 },
    ]);
  });

  it("turns the week over at the anchor minute, not at midnight", () => {
    // 2026-08-20 is a Thursday. 14:59 local still belongs to the week that
    // opened the PREVIOUS Thursday; 15:01 opens the new one.
    const tz = "Pacific/Honolulu";
    const before = Date.parse("2026-08-21T00:59:00.000Z"); // Thu 14:59 HST
    const after = Date.parse("2026-08-21T01:01:00.000Z"); // Thu 15:01 HST
    expect(roundsWeekKey(before, tz, THURSDAY_3PM)).toBe("2026-08-13");
    expect(roundsWeekKey(after, tz, THURSDAY_3PM)).toBe("2026-08-20");
  });

  it("holds the boundary at local 15:00 across a spring-forward transition", () => {
    // US DST begins Sunday 2026-03-08. The Rounds weeks either side of it must
    // both turn over at 15:00 New York local, not at a fixed UTC offset.
    const tz = "America/New_York";
    // Thursday 2026-03-05 (EST, UTC−5): 15:00 local == 20:00Z.
    expect(
      roundsWeekKey(Date.parse("2026-03-05T19:59:00.000Z"), tz, THURSDAY_3PM),
    ).toBe("2026-02-26");
    expect(
      roundsWeekKey(Date.parse("2026-03-05T20:01:00.000Z"), tz, THURSDAY_3PM),
    ).toBe("2026-03-05");
    // Thursday 2026-03-12 (EDT, UTC−4): 15:00 local == 19:00Z.
    expect(
      roundsWeekKey(Date.parse("2026-03-12T18:59:00.000Z"), tz, THURSDAY_3PM),
    ).toBe("2026-03-05");
    expect(
      roundsWeekKey(Date.parse("2026-03-12T19:01:00.000Z"), tz, THURSDAY_3PM),
    ).toBe("2026-03-12");
    // The week containing the transition is one hour SHORT of 7×24h, and both
    // ends sit at 15:00 local.
    const { startMs, endMs } = roundsWeekWindow("2026-03-05", tz, THURSDAY_3PM);
    expect(endMs - startMs).toBe(7 * 86_400_000 - 3_600_000);
    expect(startMs).toBe(Date.parse("2026-03-05T20:00:00.000Z"));
    expect(endMs).toBe(Date.parse("2026-03-12T19:00:00.000Z"));
  });

  it("works for a Tuesday-morning school with no code change", () => {
    const tz = "Pacific/Honolulu";
    // 2026-08-18 is a Tuesday. 08:59 local belongs to the previous week.
    expect(
      roundsWeekKey(Date.parse("2026-08-18T18:59:00.000Z"), tz, TUESDAY_9AM),
    ).toBe("2026-08-11");
    expect(
      roundsWeekKey(Date.parse("2026-08-18T19:01:00.000Z"), tz, TUESDAY_9AM),
    ).toBe("2026-08-18");
    // Mid-week reads land in the open week regardless of hour.
    expect(
      roundsWeekKey(Date.parse("2026-08-21T09:00:00.000Z"), tz, TUESDAY_9AM),
    ).toBe("2026-08-18");
  });

  it("covers every instant exactly once — no gap, no overlap", () => {
    const tz = "America/New_York";
    for (const anchor of [DEFAULT_ROUNDS_ANCHOR, THURSDAY_3PM, TUESDAY_9AM]) {
      let key = roundsWeekKey(Date.parse("2026-02-20T12:00:00.000Z"), tz, anchor);
      for (let week = 0; week < 6; week += 1) {
        const { startMs, endMs } = roundsWeekWindow(key, tz, anchor);
        expect(roundsWeekKey(startMs, tz, anchor)).toBe(key);
        expect(roundsWeekKey(endMs - 1, tz, anchor)).toBe(key);
        const next = shiftRoundsWeekKey(key, 1);
        expect(roundsWeekKey(endMs, tz, anchor)).toBe(next);
        expect(roundsWeekStartMs(next, tz, anchor)).toBe(endMs);
        key = next;
      }
    }
  });

  it("falls back to the historical anchor for missing or nonsense config", () => {
    expect(roundsAnchorFor(undefined)).toEqual(DEFAULT_ROUNDS_ANCHOR);
    expect(roundsAnchorFor(null)).toEqual(DEFAULT_ROUNDS_ANCHOR);
    expect(roundsAnchorFor({})).toEqual(DEFAULT_ROUNDS_ANCHOR);
    expect(roundsAnchorFor({ roundsAnchorWeekday: 7 })).toEqual(DEFAULT_ROUNDS_ANCHOR);
    expect(roundsAnchorFor({ roundsAnchorMinutes: 1440 })).toEqual(
      DEFAULT_ROUNDS_ANCHOR,
    );
    expect(roundsAnchorFor({ roundsAnchorMinutes: -1 })).toEqual(DEFAULT_ROUNDS_ANCHOR);
    expect(roundsAnchorFor({ roundsAnchorWeekday: 4.5 })).toEqual(
      DEFAULT_ROUNDS_ANCHOR,
    );
    // A partially configured school keeps the default for the missing half.
    expect(roundsAnchorFor({ roundsAnchorWeekday: 4 })).toEqual({
      weekday: 4,
      minutes: 0,
    });
    expect(
      roundsAnchorFor({ roundsAnchorWeekday: 4, roundsAnchorMinutes: 900 }),
    ).toEqual(THURSDAY_3PM);
  });
});

/**
 * Weekly goals and Rounds used to produce the same Monday string, so anything
 * comparing them appeared to join. Nothing in the repo actually joined them —
 * this pins the intended relationship so a future reader does not "restore" a
 * coincidence. Weekly goals stay on the learner's Monday week; Rounds follows
 * the school's meeting anchor.
 */
describe("Rounds week vs the learner's weekly-goal week", () => {
  const tz = "Pacific/Honolulu";
  const midWeek = Date.parse("2026-08-19T20:00:00.000Z"); // Wed 10:00 HST

  it("coincides only while the school is on the default anchor", () => {
    expect(roundsWeekKey(midWeek, tz, DEFAULT_ROUNDS_ANCHOR)).toBe(
      weeklyGoalWeekOf(midWeek, tz),
    );
  });

  it("deliberately diverges once the school anchors its own meeting", () => {
    expect(weeklyGoalWeekOf(midWeek, tz)).toBe("2026-08-17");
    expect(roundsWeekKey(midWeek, tz, THURSDAY_3PM)).toBe("2026-08-13");
    // The Rounds week straddles two goal weeks — the intended shape, not
    // drift: the adults' window is meeting-to-meeting.
    const { startMs, endMs } = roundsWeekWindow("2026-08-13", tz, THURSDAY_3PM);
    expect(weeklyGoalWeekOf(startMs, tz)).toBe("2026-08-10");
    expect(weeklyGoalWeekOf(endMs - 1, tz)).toBe("2026-08-17");
  });
});

describe("Rounds week labels", () => {
  it("labels a week from the key's own digits, never through a Date", () => {
    expect(roundsWeekLabel("2026-08-20")).toBe("20 Aug");
    expect(roundsWeekLabel("2026-01-05")).toBe("5 Jan");
    expect(roundsWeekLabel("2026-12-28")).toBe("28 Dec");
  });

  describe("Rounds cadence deep links", () => {
    it("defaults unknown values to academic and accepts SEL explicitly", () => {
      expect(parseRoundsCadenceParam(undefined)).toBe("academic");
      expect(parseRoundsCadenceParam("academic")).toBe("academic");
      expect(parseRoundsCadenceParam("junk")).toBe("academic");
      expect(parseRoundsCadenceParam("sel")).toBe("sel");
    });
  });

  it("never names a weekday, and passes malformed keys straight through", () => {
    expect(roundsWeekLabel("2026-08-17")).not.toMatch(
      /Mon|Tue|Wed|Thu|Fri|Sat|Sun/i,
    );
    expect(roundsWeekLabel("not-a-key")).toBe("not-a-key");
    expect(roundsWeekLabel("2026-13-01")).toBe("2026-13-01");
    expect(roundsWeekLabel("")).toBe("");
  });
});

describe("roundsWeekKeyForDay — a picked day → its Rounds week", () => {
  // "2026-08-20" is a Thursday, so it stands in for the fixture's Thursday
  // anchor; every day in the Thu→Wed window maps back to that Thursday.
  const thuRef = "2026-08-20";

  it("maps any day in the anchor's week back to the anchor day", () => {
    expect(roundsWeekKeyForDay("2026-08-20", thuRef)).toBe("2026-08-20"); // Thu
    expect(roundsWeekKeyForDay("2026-08-24", thuRef)).toBe("2026-08-20"); // Mon
    expect(roundsWeekKeyForDay("2026-08-26", thuRef)).toBe("2026-08-20"); // Wed (last day)
  });

  it("crosses to the next/previous week at the anchor weekday", () => {
    expect(roundsWeekKeyForDay("2026-08-27", thuRef)).toBe("2026-08-27"); // next Thu
    expect(roundsWeekKeyForDay("2026-08-19", thuRef)).toBe("2026-08-13"); // Wed before
  });

  it("reads the anchor weekday from the reference key, not a fixed Monday", () => {
    // A Monday-anchored reference: a Thursday now lands in that Monday's week.
    const monRef = "2026-08-17";
    expect(roundsWeekKeyForDay("2026-08-20", monRef)).toBe("2026-08-17");
    expect(roundsWeekKeyForDay("2026-08-23", monRef)).toBe("2026-08-17"); // Sun
    expect(roundsWeekKeyForDay("2026-08-24", monRef)).toBe("2026-08-24"); // next Mon
  });

  it("agrees with shiftRoundsWeekKey at the week boundaries", () => {
    // The day exactly one week after the anchor is the next week's key.
    expect(roundsWeekKeyForDay(shiftRoundsWeekKey(thuRef, 1), thuRef)).toBe(
      shiftRoundsWeekKey(thuRef, 1),
    );
    // A picked anchor day is idempotent — it names its own week.
    expect(roundsWeekKeyForDay(thuRef, thuRef)).toBe(thuRef);
  });
});

describe("alignRoundsWeekKey — carry a viewed week across a cadence switch", () => {
  // The live config: academic anchors Tue (2026-08-18), SEL anchors Thu
  // (2026-08-20). Same school week, different anchor weekdays.
  const tueCurrent = "2026-08-18";
  const thuCurrent = "2026-08-20";

  it("maps this week to this week in both directions", () => {
    expect(alignRoundsWeekKey(tueCurrent, thuCurrent)).toBe(thuCurrent);
    expect(alignRoundsWeekKey(thuCurrent, tueCurrent)).toBe(tueCurrent);
  });

  it("keeps the relative offset — last week stays last week", () => {
    expect(alignRoundsWeekKey("2026-08-11", thuCurrent)).toBe("2026-08-13");
    expect(alignRoundsWeekKey("2026-08-25", thuCurrent)).toBe("2026-08-27");
    expect(alignRoundsWeekKey("2026-08-04", thuCurrent)).toBe("2026-08-06");
  });

  it("is the identity for an already-aligned key", () => {
    expect(alignRoundsWeekKey("2026-08-13", thuCurrent)).toBe("2026-08-13");
    expect(alignRoundsWeekKey(thuCurrent, thuCurrent)).toBe(thuCurrent);
  });
});
