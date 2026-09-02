import { describe, expect, test } from "vitest";
import {
  budgetMinutes,
  turnsForMinutes,
  MIN_TURNS,
  MAX_TURNS,
  DEFAULT_MINUTES,
  MINUTES_PER_TURN,
} from "../rehearsalBudget";

describe("turnsForMinutes — duration-grounded sim turn budget", () => {
  test("a typical 25-min activity → its minutes / MINUTES_PER_TURN", () => {
    expect(turnsForMinutes(25)).toBe(Math.round(25 / MINUTES_PER_TURN)); // 10
    expect(turnsForMinutes(30)).toBe(Math.round(30 / MINUTES_PER_TURN)); // 12
  });

  test("no duration → the default-minutes budget (not the old flat 8)", () => {
    const def = turnsForMinutes(undefined);
    expect(def).toBe(Math.round(DEFAULT_MINUTES / MINUTES_PER_TURN)); // 10
    expect(turnsForMinutes(null)).toBe(def);
    expect(turnsForMinutes(0)).toBe(def);
    expect(def).toBeGreaterThan(8); // a genuine bump over the old cap
  });

  test("short activities are floored (still enough turns to land)", () => {
    expect(turnsForMinutes(5)).toBe(MIN_TURNS); // 5/2.5=2 → floored
    expect(turnsForMinutes(1)).toBe(MIN_TURNS);
  });

  test("long activities are capped (cost bound)", () => {
    expect(turnsForMinutes(100)).toBe(MAX_TURNS);
    expect(turnsForMinutes(60)).toBe(
      Math.min(MAX_TURNS, Math.round(60 / MINUTES_PER_TURN)),
    ); // 24
  });

  test("monotonic non-decreasing across positive durations", () => {
    // (0 / null mean "no Duration set" → the default budget, deliberately
    // NOT "zero minutes", so start at a real positive duration.)
    let prev = 0;
    for (let m = 5; m <= 120; m += 5) {
      const t = turnsForMinutes(m);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});

describe("budgetMinutes — what the teacher sees", () => {
  test("uses the activity Duration, else the default", () => {
    expect(budgetMinutes(40)).toBe(40);
    expect(budgetMinutes(undefined)).toBe(DEFAULT_MINUTES);
    expect(budgetMinutes(0)).toBe(DEFAULT_MINUTES);
  });
});
