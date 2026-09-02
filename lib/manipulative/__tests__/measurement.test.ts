/**
 * The four measurement kinds — `ruler`, `clock`, `liquid`, `money`.
 *
 * Each block pins the same three things the older per-kind suites do: the pure
 * self-check (including the near-misses a renderer could otherwise wave
 * through), the authoring guard (an unsolvable or already-solved spec must be
 * REJECTED, not silently shipped), and the tutor describers (state the task and
 * the visible board, never a value the scholar was asked to compute).
 */

import { describe, expect, it } from "vitest";
import {
  clockMinutesOf,
  CLOCK_DIAL_MINUTES,
  clockMinutesFromTurned,
  clockNormalize,
  clockReading,
  clockSolved,
  clockTargetMinutes,
  describeState,
  formatClockTime,
  goalText,
  initialClock,
  initialLiquid,
  initialMoney,
  initialRuler,
  isSolved,
  liquidSolved,
  liquidTotal,
  liveReadoutPolicy,
  moneyAmountReachableWithCount,
  moneyFewestPieces,
  moneyPieceTotal,
  moneySolved,
  moneyTotalCents,
  rulerLength,
  rulerSolved,
} from "../logic";
import { assertGradableManipulative, assertRenderableManipulative, isGradableManipulative } from "../authoring";
import { formatMoney, MONEY_PIECES, moneyPieceSize } from "../currency";
import type { ClockSpec, LiquidSpec, ManipulativeSpec, MoneySpec, RulerSpec } from "../types";

// ── ruler ────────────────────────────────────────────────────────────────────

const ruler: RulerSpec = {
  kind: "ruler",
  id: "ruler-5cm-from-3",
  concept: "Length",
  prompt: "Make the bar 5 cm long.",
  unit: "cm",
  length: 12,
  startAt: 3,
  startEnd: 4,
  goal: { type: "lengthEquals", value: 5 },
};

describe("ruler", () => {
  it("measures LENGTH (end − start), not the end position", () => {
    // The broken-ruler case: the bar's end reads 8, but the bar is 5 long.
    expect(rulerLength(ruler, { end: 8 })).toBe(5);
    expect(rulerSolved(ruler, { end: 8 })).toBe(true);
    // Dragging the end to the target NUMBER is the classic misconception, and
    // it must NOT pass: a bar from 3 to 5 is only 2 long.
    expect(rulerSolved(ruler, { end: 5 })).toBe(false);
  });

  it("grades a forged sub-gradation submission at the mark the drag could reach", () => {
    // 8.03 snaps to 8 on a whole-unit scale, so it grades as the bar the
    // scholar could actually have built.
    expect(rulerSolved(ruler, { end: 8.03 })).toBe(true);
    expect(rulerSolved(ruler, { end: 8.6 })).toBe(false);
  });

  it("supports a quarter-inch scale", () => {
    const quarters: RulerSpec = {
      ...ruler,
      id: "ruler-quarter",
      unit: "in",
      length: 6,
      precision: 0.25,
      startAt: 0,
      startEnd: 1,
      goal: { type: "lengthEquals", value: 2.75 },
    };
    expect(rulerSolved(quarters, { end: 2.75 })).toBe(true);
    expect(rulerSolved(quarters, { end: 2.5 })).toBe(false);
    expect(isGradableManipulative(quarters)).toBe(true);
  });

  it("rejects a spec that starts already solved", () => {
    const solvedAtStart: RulerSpec = { ...ruler, id: "ruler-pre-solved", startEnd: 8 };
    expect(rulerSolved(solvedAtStart, initialRuler(solvedAtStart))).toBe(true);
    expect(isGradableManipulative(solvedAtStart)).toBe(false);
    expect(() => assertGradableManipulative(solvedAtStart)).toThrow(/Ungradable/);
  });

  it("rejects a target that cannot fit to the right of the pinned start", () => {
    // A 10 cm bar cannot be built on a 12 cm ruler starting at 3.
    expect(isGradableManipulative({ ...ruler, id: "ruler-too-long", goal: { type: "lengthEquals", value: 10 } })).toBe(false);
  });

  it("rejects a target off the scale's gradations", () => {
    const offGrid: RulerSpec = { ...ruler, id: "ruler-off-grid", goal: { type: "lengthEquals", value: 5.5 } };
    expect(isGradableManipulative(offGrid)).toBe(false);
  });

  it("names the target length and the pinned start, never just the end number", () => {
    const text = goalText(ruler);
    expect(text).toContain("5 centimeters");
    expect(text).toContain("pinned at 3");
    // The end position that solves it (8) is the scholar's work — never stated.
    expect(text).not.toContain(" 8 ");
  });

  it("describes the visible bar as a subtraction", () => {
    expect(describeState(ruler, JSON.stringify({ end: 7 }))).toBe(
      "The bar runs from 3 to 7 on the centimeters ruler, so right now it measures 4 centimeters.",
    );
  });
});

// ── clock ────────────────────────────────────────────────────────────────────

const showTime: ClockSpec = {
  kind: "clock",
  id: "clock-345",
  concept: "Time",
  prompt: "Show 3:45.",
  startHour: 9,
  startMinute: 0,
  snapMinutes: 5,
  goal: { type: "showTime", hour: 3, minute: 45 },
};

const elapsed: ClockSpec = {
  kind: "clock",
  id: "clock-elapsed",
  concept: "Elapsed time",
  prompt: "Move on by 20 minutes.",
  startHour: 2,
  startMinute: 50,
  snapMinutes: 5,
  goal: { type: "advanceBy", minutes: 20 },
};

describe("clock", () => {
  it("reads one dial position as both hands", () => {
    expect(clockMinutesOf(3, 45)).toBe(225);
    expect(clockReading(225)).toEqual({ hour: 3, minute: 45 });
    // 12 o'clock is dial position 0, not 720.
    expect(clockMinutesOf(12, 20)).toBe(20);
    expect(clockReading(0)).toEqual({ hour: 12, minute: 0 });
    expect(formatClockTime(225)).toBe("3:45");
  });

  it("wraps a dial position onto 0..719 in both directions", () => {
    expect(clockNormalize(725)).toBe(5);
    expect(clockNormalize(-5)).toBe(715);
  });

  it("winds the dial by the rotation the drag accumulated", () => {
    // A quarter turn forward from 3:00 is fifteen minutes.
    expect(clockMinutesFromTurned(clockMinutesOf(3, 0), 0.25, 5)).toBe(clockMinutesOf(3, 15));
    // Past 12 and on into the next hour, rather than rewinding eleven.
    expect(clockMinutesFromTurned(clockMinutesOf(11, 55), 10 / 60, 5)).toBe(clockMinutesOf(12, 5));
    // Backwards unwinds symmetrically.
    expect(clockMinutesFromTurned(clockMinutesOf(12, 5), -10 / 60, 5)).toBe(clockMinutesOf(11, 55));
    // Winding several times round keeps adding hours.
    expect(clockMinutesFromTurned(clockMinutesOf(1, 0), 3, 5)).toBe(clockMinutesOf(4, 0));
  });

  it("turns the hour over on the COARSE dials, where a nearest-angle hand would stick", () => {
    // A half-hour dial reads only :00 and :30, so a hand snapped to the
    // pointer's absolute angle could never resolve which way to cross 12 and
    // the hour froze. Accumulated rotation carries it.
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 0.5, 30)).toBe(clockMinutesOf(12, 30));
    expect(clockMinutesFromTurned(clockMinutesOf(12, 30), 0.5, 30)).toBe(clockMinutesOf(1, 0));
    // The half-past-4 gallery challenge has to be reachable from 12:00.
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 4.5, 30)).toBe(clockMinutesOf(4, 30));
    // An hour dial reads :00 everywhere on the rim; only rotation moves it.
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 1, 60)).toBe(clockMinutesOf(1, 0));
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 3, 60)).toBe(clockMinutesOf(3, 0));
  });

  it("gears the hour hand to the whole dial, so it is a coarse control on the same reading", () => {
    const dial = CLOCK_DIAL_MINUTES;
    // A twelfth of a turn of the HOUR hand is one hour, where the same
    // rotation of the minute hand would be only five minutes.
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 1 / 12, 5, dial)).toBe(clockMinutesOf(1, 0));
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 1 / 12, 5)).toBe(clockMinutesOf(12, 5));
    // Half-past-4 from 12:00 is a bit over a third of ONE hour-hand sweep,
    // instead of four and a half revolutions of the minute hand.
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 4.5 / 12, 30, dial)).toBe(clockMinutesOf(4, 30));
    // A whole turn of the hour hand is a whole dial, and lands back where it
    // started rather than accumulating a spurious offset.
    expect(clockMinutesFromTurned(clockMinutesOf(2, 15), 1, 5, dial)).toBe(clockMinutesOf(2, 15));
    // Backwards unwinds symmetrically.
    expect(clockMinutesFromTurned(clockMinutesOf(4, 0), -2 / 12, 5, dial)).toBe(clockMinutesOf(2, 0));
    // The coarse dials still work on the hour hand: every reachable reading
    // stays on the spec's gradation, so no illegal in-between time appears.
    expect(clockMinutesFromTurned(clockMinutesOf(12, 0), 1 / 24, 30, dial)).toBe(clockMinutesOf(12, 30));
  });

  it("solves showTime only on the exact reading", () => {
    expect(clockSolved(showTime, { minutes: 225 })).toBe(true);
    // The right minutes on the wrong hour is a different time, and the geared
    // dial can tell them apart because both hands come from this one number.
    expect(clockSolved(showTime, { minutes: 225 + 60 })).toBe(false);
    expect(clockSolved(showTime, { minutes: 220 })).toBe(false);
  });

  it("derives an advanceBy target across the hour boundary", () => {
    // 2:50 + 20 = 3:10.
    expect(clockTargetMinutes(elapsed)).toBe(clockMinutesOf(3, 10));
    expect(clockSolved(elapsed, { minutes: clockMinutesOf(3, 10) })).toBe(true);
    expect(clockSolved(elapsed, { minutes: clockMinutesOf(2, 10) })).toBe(false);
  });

  it("wraps an advanceBy target past 12", () => {
    const wrap: ClockSpec = { ...elapsed, id: "clock-wrap", startHour: 11, startMinute: 45, goal: { type: "advanceBy", minutes: 30 } };
    expect(clockTargetMinutes(wrap)).toBe(clockMinutesOf(12, 15));
  });

  it("rejects a target off the snap gradations", () => {
    const offSnap: ClockSpec = { ...showTime, id: "clock-off-snap", goal: { type: "showTime", hour: 3, minute: 43 } };
    // 43 is unreachable on a five-minute dial, so the puzzle is impossible.
    expect(isGradableManipulative(offSnap)).toBe(false);
  });

  it("rejects a spec that starts already solved and a full-turn advance", () => {
    expect(isGradableManipulative({ ...showTime, id: "clock-pre", startHour: 3, startMinute: 45 })).toBe(false);
    expect(isGradableManipulative({ ...elapsed, id: "clock-full-turn", goal: { type: "advanceBy", minutes: 720 } })).toBe(false);
  });

  it("names a showTime target but never an advanceBy result", () => {
    expect(goalText(showTime)).toContain("3:45");
    const text = goalText(elapsed);
    expect(text).toContain("2:50");
    expect(text).toContain("20 minutes");
    // 3:10 is the answer — it must not leak into the restated task.
    expect(text).not.toContain("3:10");
  });

  it("describes only where the hands are", () => {
    expect(describeState(elapsed, JSON.stringify({ minutes: clockMinutesOf(2, 55) }))).toBe(
      "The clock's hands are showing 2:55 right now.",
    );
  });
});

// ── liquid ───────────────────────────────────────────────────────────────────

const fillTo: LiquidSpec = {
  kind: "liquid",
  id: "liquid-fill-3",
  concept: "Liquid volume",
  prompt: "Fill the tall jar to 3 cups.",
  unit: "cup",
  vessels: [{ capacity: 4, label: "Tall jar" }],
  goal: { type: "fillTo", vessel: 0, value: 3 },
};

const totalEquals: LiquidSpec = {
  kind: "liquid",
  id: "liquid-total-5",
  concept: "Composing measures",
  prompt: "Get 5 cups altogether.",
  unit: "cup",
  vessels: [
    { capacity: 4, label: "Tall jar" },
    { capacity: 2, label: "Short jar" },
  ],
  goal: { type: "totalEquals", value: 5 },
};

describe("liquid", () => {
  it("solves fillTo on the named jar only", () => {
    expect(liquidSolved(fillTo, { levels: [3] })).toBe(true);
    expect(liquidSolved(fillTo, { levels: [2] })).toBe(false);
  });

  it("solves totalEquals on the sum across jars", () => {
    expect(liquidTotal(totalEquals, { levels: [4, 1] })).toBe(5);
    expect(liquidSolved(totalEquals, { levels: [4, 1] })).toBe(true);
    expect(liquidSolved(totalEquals, { levels: [3, 2] })).toBe(true);
    expect(liquidSolved(totalEquals, { levels: [4, 2] })).toBe(false);
  });

  it("clamps a forged over-capacity level to what the jar can hold", () => {
    // 9 cups in a 4-cup jar grades as 4 — the level the drag could reach — so a
    // forged submission can't manufacture a total the board never showed.
    expect(liquidTotal(totalEquals, { levels: [9, 1] })).toBe(5);
  });

  it("rejects a totalEquals that one jar could satisfy alone", () => {
    // 3 cups fits in the 4-cup jar, so nothing forces the amount to be shared —
    // that is `fillTo` in a costume, and the guard says so.
    const soloable: LiquidSpec = { ...totalEquals, id: "liquid-soloable", goal: { type: "totalEquals", value: 3 } };
    expect(isGradableManipulative(soloable)).toBe(false);
    expect(isGradableManipulative(totalEquals)).toBe(true);
  });

  it("rejects a target beyond the jars' combined capacity and one off the marks", () => {
    expect(isGradableManipulative({ ...totalEquals, id: "l-big", goal: { type: "totalEquals", value: 7 } })).toBe(false);
    expect(isGradableManipulative({ ...fillTo, id: "l-off", goal: { type: "fillTo", vessel: 0, value: 2.5 } })).toBe(false);
  });

  it("rejects a spec that starts already solved", () => {
    const pre: LiquidSpec = { ...fillTo, id: "liquid-pre", vessels: [{ capacity: 4, start: 3, label: "Tall jar" }] };
    expect(liquidSolved(pre, initialLiquid(pre))).toBe(true);
    expect(isGradableManipulative(pre)).toBe(false);
  });

  it("states the total and the jars' capacities, and describes the visible levels", () => {
    expect(goalText(totalEquals)).toContain("5 cups ALTOGETHER");
    expect(describeState(totalEquals, JSON.stringify({ levels: [2, 1] }))).toBe(
      "Right now Tall jar holds 2 of its 4 and Short jar holds 1 of its 2 — 3 cups altogether.",
    );
  });
});

// ── money ────────────────────────────────────────────────────────────────────

const coins = ["penny", "nickel", "dime", "quarter"] as const;

const amount: MoneySpec = {
  kind: "money",
  id: "money-47",
  concept: "Counting money",
  prompt: "Make 47¢.",
  available: [...coins],
  goal: { type: "amountEquals", cents: 47 },
};

describe("money", () => {
  it("totals the tray in cents and formats it as kid-facing money", () => {
    // 1 quarter + 2 dimes + 2 pennies = 47¢
    expect(moneyTotalCents(amount, [2, 0, 2, 1])).toBe(47);
    expect(moneyPieceTotal([2, 0, 2, 1])).toBe(5);
    expect(formatMoney(47)).toBe("47¢");
    expect(formatMoney(135)).toBe("$1.35");
    expect(formatMoney(200)).toBe("$2.00");
  });

  it("solves amountEquals for ANY combination worth the target", () => {
    expect(moneySolved(amount, { counts: [2, 0, 2, 1] })).toBe(true); // 2¢ + 2 dimes + quarter
    expect(moneySolved(amount, { counts: [2, 5, 2, 0] })).toBe(true); // 2¢ + 5 nickels + 2 dimes
    expect(moneySolved(amount, { counts: [1, 0, 2, 1] })).toBe(false);
  });

  it("rejects a tray holding more of one piece than the tray cap allows", () => {
    // 47 pennies is worth 47¢ but exceeds the default 20-per-denomination cap,
    // so it is not a tray the renderer could have produced.
    expect(moneySolved(amount, { counts: [47, 0, 0, 0] })).toBe(false);
    const roomy: MoneySpec = { ...amount, id: "money-roomy", maxPerDenomination: 50 };
    expect(moneySolved(roomy, { counts: [47, 0, 0, 0] })).toBe(true);
  });

  it("solves amountEqualsWithCount only at the exact piece count", () => {
    // 30¢ in exactly 4 coins: 25 + 5 · 1? no — quarter+nickel is 2. The
    // 4-coin solutions are 10+10+5+5 and 25+1+1+... (no). Check the real one.
    const withCount: MoneySpec = { ...amount, id: "money-30-in-4", goal: { type: "amountEqualsWithCount", cents: 30, count: 4 } };
    expect(moneySolved(withCount, { counts: [0, 2, 2, 0] })).toBe(true); // 5+5+10+10
    expect(moneySolved(withCount, { counts: [0, 1, 0, 1] })).toBe(false); // right value, 2 coins
    expect(moneySolved(withCount, { counts: [0, 0, 3, 0] })).toBe(false); // right value, 3 coins
  });

  it("computes the true minimum with a table, not greedy", () => {
    expect(moneyFewestPieces([...coins], 63, 20)).toBe(6); // 25+25+10+1+1+1
    expect(moneyFewestPieces(["penny", "nickel"], 8, 20)).toBe(4); // 5+1+1+1
    expect(moneyFewestPieces(["nickel", "dime"], 7, 20)).toBe(null); // unreachable
  });

  it("respects the per-denomination cap the tray actually enforces", () => {
    // Both of these shipped as accepted-but-unsolvable specs until the DP was
    // made cap-aware (found in review). The cap is what the renderer and
    // `moneySolved` enforce, so an UNBOUNDED minimum is a number no scholar can
    // reach.
    // 40 half dollars would make $20, but a 20-piece cap tops the tray out at $10.
    expect(moneyFewestPieces(["halfDollar"], 2000, 20)).toBe(null);
    expect(moneyFewestPieces(["halfDollar"], 1000, 20)).toBe(20);
    // 90¢ from quarters+dimes needs 2 quarters + 4 dimes; capped at 3 each, no
    // combination reaches it — even though 6 pieces "fits" an aggregate 3x2 bound.
    expect(moneyFewestPieces(["quarter", "dime"], 90, 3)).toBe(null);
    expect(moneyFewestPieces(["quarter", "dime"], 90, 4)).toBe(6);
  });

  it("rejects a goal that is unreachable under the tray cap", () => {
    const capped: MoneySpec = {
      ...amount,
      id: "money-cap-unreachable",
      available: ["halfDollar"],
      goal: { type: "amountEquals", cents: 2000 },
    };
    expect(isGradableManipulative(capped)).toBe(false);
    const fewestCapped: MoneySpec = {
      ...amount,
      id: "money-cap-fewest",
      available: ["quarter", "dime"],
      maxPerDenomination: 3,
      goal: { type: "fewestPieces", cents: 90 },
    };
    expect(isGradableManipulative(fewestCapped)).toBe(false);
  });

  it("solves fewestPieces only at the provable minimum", () => {
    const fewest: MoneySpec = { ...amount, id: "money-fewest-63", goal: { type: "fewestPieces", cents: 63 } };
    expect(moneySolved(fewest, { counts: [3, 0, 1, 2] })).toBe(true); // 6 pieces
    expect(moneySolved(fewest, { counts: [3, 1, 0, 2] })).toBe(false); // 63¢ in 6? 25+25+5+1+1+1+1 = 7
    expect(moneySolved(fewest, { counts: [63, 0, 0, 0] })).toBe(false); // right value, 63 pieces
  });

  it("checks exact-count reachability so an impossible puzzle can't ship", () => {
    expect(moneyAmountReachableWithCount([...coins], 30, 4, 20)).toBe(true);
    expect(moneyAmountReachableWithCount([...coins], 30, 2, 20)).toBe(true); // 25+5
    // 30¢ from exactly 1 coin is impossible (no 30¢ piece).
    expect(moneyAmountReachableWithCount([...coins], 30, 1, 20)).toBe(false);
    // …and 3 dimes is impossible once the cap is 2 per denomination.
    expect(moneyAmountReachableWithCount(["dime"], 30, 3, 2)).toBe(false);
    expect(moneyAmountReachableWithCount(["dime"], 30, 3, 3)).toBe(true);
    expect(isGradableManipulative({ ...amount, id: "m-imp", goal: { type: "amountEqualsWithCount", cents: 30, count: 1 } })).toBe(false);
  });

  it("rejects an amount the bank cannot make", () => {
    const noPennies: MoneySpec = { ...amount, id: "money-27-no-pennies", available: ["nickel", "dime", "quarter"], goal: { type: "amountEquals", cents: 27 } };
    expect(isGradableManipulative(noPennies)).toBe(false);
  });

  it("rejects fewestPieces over a single-denomination bank", () => {
    // With one denomination every correct total is already the minimum, so the
    // goal makes a claim with no work behind it.
    const oneKind: MoneySpec = { ...amount, id: "money-one-kind", available: ["dime"], goal: { type: "fewestPieces", cents: 30 } };
    expect(isGradableManipulative(oneKind)).toBe(false);
  });

  it("rejects a spec that starts already solved", () => {
    const pre: MoneySpec = { ...amount, id: "money-pre", start: [2, 0, 2, 1] };
    expect(moneySolved(pre, initialMoney(pre))).toBe(true);
    expect(isGradableManipulative(pre)).toBe(false);
  });

  it("never names the minimum for a fewestPieces goal", () => {
    const fewest: MoneySpec = { ...amount, id: "money-fewest-63b", goal: { type: "fewestPieces", cents: 63 } };
    const text = goalText(fewest);
    expect(text).toContain("63¢");
    expect(text).toContain("as FEW");
    expect(text).not.toMatch(/\b6 coins\b/);
  });

  it("describes the tray's pieces and its value", () => {
    expect(describeState(amount, JSON.stringify({ counts: [2, 0, 2, 1] }))).toBe(
      "The tray holds 2 pennies, 2 dimes, and 1 quarter right now, which comes to 47¢.",
    );
    expect(describeState(amount, JSON.stringify({ counts: [0, 0, 0, 0] }))).toBe(
      "The tray is empty — no coins have been added yet.",
    );
  });

  it("scales coins off their REAL diameters, so a dime draws smaller than a nickel", () => {
    const dime = moneyPieceSize("dime", 60).width;
    const nickel = moneyPieceSize("nickel", 60).width;
    const quarter = moneyPieceSize("quarter", 60).width;
    expect(dime).toBeLessThan(nickel);
    expect(nickel).toBeLessThan(quarter);
    // …even though the dime is worth twice the nickel — the clash is the point.
    expect(MONEY_PIECES.dime.cents).toBeGreaterThan(MONEY_PIECES.nickel.cents);
  });
});

// ── the live-readout policy ──────────────────────────────────────────────────

describe("liveReadoutPolicy — never print a value the goal already names", () => {
  it("withholds the graded quantity under a named-target goal", () => {
    // Each of these NAMES its target in the prompt, so a live readout would let
    // the scholar drag/pour/tap until the widget matched the number instead of
    // reading the scale — the skill in every case.
    expect(liveReadoutPolicy(ruler).showValue).toBe(false);
    expect(liveReadoutPolicy(showTime).showValue).toBe(false);
    expect(liveReadoutPolicy(fillTo).showValue).toBe(false);
    expect(liveReadoutPolicy(totalEquals).showValue).toBe(false);
    expect(liveReadoutPolicy(amount).showValue).toBe(false);
  });

  it("keeps the readout for a compute-style goal, whose answer is never named", () => {
    // `advanceBy` states the start and the elapsed minutes but NOT where you
    // land, so the face's current reading is visible state, not the answer.
    expect(liveReadoutPolicy(elapsed).showValue).toBe(true);
  });

  it("keeps the readout for a free explorer, which has nothing to give away", () => {
    const explore: RulerSpec = { ...ruler, id: "ruler-explore", goal: undefined };
    expect(liveReadoutPolicy(explore).showValue).toBe(true);
  });

  it("hides the piece count only when the goal names it", () => {
    const withCount: MoneySpec = {
      ...amount,
      id: "money-count-policy",
      goal: { type: "amountEqualsWithCount", cents: 30, count: 4 },
    };
    const fewest: MoneySpec = { ...amount, id: "money-fewest-policy", goal: { type: "fewestPieces", cents: 63 } };
    expect(liveReadoutPolicy(withCount).showCount).toBe(false);
    // Under `fewestPieces` the count is what the scholar is minimising — it is
    // the discovery, not a given, so showing it is the point.
    expect(liveReadoutPolicy(fewest).showCount).toBe(true);
  });

  it("matches goalText: a named value is stated, a withheld readout is computed", () => {
    // The policy and the describer must use the SAME discriminator, or a kind
    // could state its target in prose while hiding it on screen (or worse, the
    // reverse). Spot-check both directions.
    expect(goalText(showTime)).toContain("3:45");
    expect(liveReadoutPolicy(showTime).showValue).toBe(false);
    expect(goalText(elapsed)).not.toContain("3:10");
    expect(liveReadoutPolicy(elapsed).showValue).toBe(true);
  });
});

// ── the goal-union trapdoor ──────────────────────────────────────────────────

describe("goal unions are consumed exhaustively, never by an implicit else", () => {
  // The failure this guards is silent, which is what makes it worth a test: a
  // consumer that handles the known members and lets the last fall out of an
  // `else` grades a LATER-added member as whichever branch the else happened to
  // be. No throw, no type error — the item simply never solves, and the tutor
  // describer feeds `undefined` to the model. Diagnosed on `NumberLineGoal`,
  // whose three consumers all share one implicit `else = placeFraction`
  // (review/lcm-manipulative-redesign.html). The compiler is the real guard
  // here — `assertNoUnhandledGoal` takes `never`, so growing a union stops
  // typechecking until every consumer is visited. These cases pin the runtime
  // half: a forged goal type must fall through to the safe answer, never be
  // mistaken for a sibling member.
  const forged = (base: ManipulativeSpec, goal: unknown): ManipulativeSpec =>
    ({ ...base, goal } as unknown as ManipulativeSpec);

  it("grades an unknown clock goal as unsolved rather than as advanceBy", () => {
    const spec = forged(showTime, { type: "showTimeOnMars", hour: 3, minute: 45 });
    expect(isSolved(spec, { minutes: 225 })).toBe(false);
    expect(isSolved(spec, { minutes: 0 })).toBe(false);
  });

  it("grades an unknown liquid goal as unsolved rather than as totalEquals", () => {
    const spec = forged(totalEquals, { type: "siphonInto", value: 5 });
    // 4 + 1 = 5 would pass the real `totalEquals`; the forged member must not
    // inherit it.
    expect(isSolved(spec, { levels: [4, 1] })).toBe(false);
  });

  it("grades an unknown money goal as unsolved rather than as fewestPieces", () => {
    const spec = forged(amount, { type: "amountEqualsInBills", cents: 47 });
    expect(isSolved(spec, { counts: [2, 0, 2, 1] })).toBe(false);
  });

  it("still solves every REAL goal member — the guard costs nothing", () => {
    expect(isSolved(showTime, { minutes: clockMinutesOf(3, 45) })).toBe(true);
    expect(isSolved(elapsed, { minutes: clockMinutesOf(3, 10) })).toBe(true);
    expect(isSolved(fillTo, { levels: [3] })).toBe(true);
    expect(isSolved(totalEquals, { levels: [4, 1] })).toBe(true);
    expect(isSolved(amount, { counts: [2, 0, 2, 1] })).toBe(true);
    expect(isSolved(ruler, { end: 8 })).toBe(true);
  });
});

// ── cross-kind: the dispatchers stay total ───────────────────────────────────

describe("the four measurement kinds route through the shared dispatchers", () => {
  const specs: ManipulativeSpec[] = [ruler, showTime, elapsed, fillTo, totalEquals, amount];

  it("isSolved dispatches each kind and never throws on garbage state", () => {
    for (const spec of specs) {
      expect(typeof isSolved(spec, {})).toBe("boolean");
      expect(typeof isSolved(spec, null)).toBe("boolean");
      expect(isSolved(spec, undefined)).toBe(false);
    }
  });

  it("describeState is total against malformed JSON", () => {
    for (const spec of specs) {
      expect(typeof describeState(spec, "not json")).toBe("string");
      expect(typeof describeState(spec, JSON.stringify({ nonsense: true }))).toBe("string");
    }
  });

  it("every gallery spec of these kinds is gradable and renderable", async () => {
    const { ALL_SPECS } = await import("@/components/manipulative/library");
    const kinds = new Set(["ruler", "clock", "liquid", "money"]);
    const authored = ALL_SPECS.filter((s) => kinds.has(s.kind));
    // Sanity: the gallery really did author these — an empty list would make
    // this guard vacuous.
    expect(authored.length).toBeGreaterThanOrEqual(12);
    expect(new Set(authored.map((s) => s.kind))).toEqual(kinds);
    for (const spec of authored) {
      expect(() => assertRenderableManipulative(spec)).not.toThrow();
      const hasGoal = "goal" in spec && spec.goal != null;
      if (!hasGoal) continue;
      expect(isGradableManipulative(spec), spec.id).toBe(true);
      expect(() => assertGradableManipulative(spec)).not.toThrow();
    }
  });

  it("the initial state of every gallery challenge is NOT already solved", async () => {
    const { ALL_SPECS } = await import("@/components/manipulative/library");
    const kinds = new Set(["ruler", "clock", "liquid", "money"]);
    for (const spec of ALL_SPECS.filter((s) => kinds.has(s.kind))) {
      if (!("goal" in spec) || spec.goal == null) continue;
      const initial =
        spec.kind === "ruler"
          ? initialRuler(spec)
          : spec.kind === "clock"
            ? initialClock(spec)
            : spec.kind === "liquid"
              ? initialLiquid(spec)
              : initialMoney(spec as MoneySpec);
      expect(isSolved(spec, initial), `${spec.id} starts solved`).toBe(false);
    }
  });
});
