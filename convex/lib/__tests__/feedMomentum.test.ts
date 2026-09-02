import { describe, it, expect } from "vitest";
import { computeMomentum, MOMENTUM_WINDOW_DAYS, SKILLS_STRENGTHENED_WINDOW_DAYS } from "../feedMomentum";

const DAY = 86_400_000;
const NOW = 1_000_000 * DAY; // an arbitrary fixed "now" epoch

describe("computeMomentum", () => {
  it("is all-zero with no practice or observation evidence", () => {
    expect(computeMomentum([], [], NOW)).toEqual({
      daysActive: 0,
      windowDays: MOMENTUM_WINDOW_DAYS,
      skillsStrengthened: 0,
    });
  });

  it("counts distinct days active from real ATTEMPTS within the window", () => {
    const rows = [
      { skillKey: "a", repetition: 1, updatedAt: NOW, lastAttemptAt: NOW }, // today
      { skillKey: "b", repetition: 2, updatedAt: NOW, lastAttemptAt: NOW - 2 * DAY }, // 2 days ago
      { skillKey: "c", repetition: 1, updatedAt: NOW, lastAttemptAt: NOW - 2 * DAY }, // same day as b
      { skillKey: "d", repetition: 1, updatedAt: NOW, lastAttemptAt: NOW - 30 * DAY }, // outside window
    ];
    const m = computeMomentum(rows, [], NOW);
    expect(m.daysActive).toBe(2); // today + 2-days-ago (deduped)
  });

  it("does NOT count lastPracticedAt as a practice day — placement and reprobe stamp it too", () => {
    // A scholar who was bulk-placed this week has a fresh spaced-repetition
    // clock on every row and has attempted nothing. The strip must read quiet.
    const rows = [
      { skillKey: "placed-a", repetition: 5, updatedAt: NOW, lastPracticedAt: NOW },
      { skillKey: "placed-b", repetition: 5, updatedAt: NOW, lastPracticedAt: NOW - 2 * DAY },
    ];
    const m = computeMomentum(rows, [], NOW);
    expect(m.daysActive).toBe(0);
    expect(m.skillsStrengthened).toBe(0);
  });

  it("counts a masteryObservation day even with no practiceMastery rows", () => {
    const obs = [{ conceptLabel: "fractions", masteryLevel: 3, observedAt: NOW - 5 * DAY }];
    const m = computeMomentum([], obs, NOW);
    expect(m.daysActive).toBe(1);
  });

  it("counts a skill as strengthened only when a CROSSING stamp lands in the week", () => {
    const rows = [
      // Crossed the demonstrated-fluency bar this week.
      { skillKey: "turned-fluent", repetition: 3, updatedAt: NOW - 2 * DAY, lastAttemptAt: NOW - 2 * DAY, becameFluentAt: NOW - 2 * DAY },
      // Frontier advanced through practice this week — also a real crossing.
      { skillKey: "frontier-moved", repetition: 3, updatedAt: NOW - DAY, lastAttemptAt: NOW - DAY, frontierAdvancedAt: NOW - DAY },
      // Drilled this week, but nothing was crossed. Practice, not a crossing.
      { skillKey: "worked-on", repetition: 2, updatedAt: NOW - DAY, lastAttemptAt: NOW - DAY },
      // Crossed, but weeks ago.
      { skillKey: "stale-crossing", repetition: 4, updatedAt: NOW - 30 * DAY, lastAttemptAt: NOW - 30 * DAY, becameFluentAt: NOW - 30 * DAY },
    ];
    const m = computeMomentum(rows, [], NOW);
    expect(m.skillsStrengthened).toBe(2);
  });

  it("a bulk PLACEMENT row is never 'strengthened', however high its repetition count", () => {
    // The defect this predicate replaced: `repetition > 0 && updatedAt >= since7`
    // was satisfied by placement rows, so an onboarding week rendered as a week
    // of learning. A placement row carries no crossing stamp.
    const rows = [
      { skillKey: "placed-1", repetition: 5, updatedAt: NOW, lastPracticedAt: NOW },
      { skillKey: "placed-2", repetition: 9, updatedAt: NOW, lastPracticedAt: NOW },
      { skillKey: "placed-3", repetition: 4, updatedAt: NOW, lastPracticedAt: NOW },
    ];
    expect(computeMomentum(rows, [], NOW).skillsStrengthened).toBe(0);
  });

  it("counts a chat-demonstrated concept (masteryLevel >= 2.5) observed this week as strengthened", () => {
    const obs = [
      { conceptLabel: "long division", masteryLevel: 2.5, observedAt: NOW - 1 * DAY },
      { conceptLabel: "still shaky", masteryLevel: 1.5, observedAt: NOW - 1 * DAY }, // below the Demonstrated bar
      { conceptLabel: "old news", masteryLevel: 4, observedAt: NOW - 20 * DAY }, // outside the 7-day window
    ];
    const m = computeMomentum([], obs, NOW);
    expect(m.skillsStrengthened).toBe(1);
  });

  it("dedupes the same skill counted from both sources, and blends across sources", () => {
    const rows = [{ skillKey: "multiplication", repetition: 2, updatedAt: NOW - 1 * DAY, lastAttemptAt: NOW - 1 * DAY, becameFluentAt: NOW - 1 * DAY }];
    const obs = [{ conceptLabel: "multiplication", masteryLevel: 3, observedAt: NOW - 2 * DAY }];
    const m = computeMomentum(rows, obs, NOW);
    // Different keys internally ("skill:" vs "concept:") — both are genuine,
    // independent evidence of the same idea, so both count (2), not deduped
    // away to 1. Blending is intentional: see the module doc comment.
    expect(m.skillsStrengthened).toBe(2);
    expect(m.daysActive).toBe(2);
  });

  it("SKILLS_STRENGTHENED_WINDOW_DAYS is narrower than MOMENTUM_WINDOW_DAYS", () => {
    expect(SKILLS_STRENGTHENED_WINDOW_DAYS).toBeLessThan(MOMENTUM_WINDOW_DAYS);
  });

  it("an untouched mastery record does NOT count as a day active", () => {
    // A record with no attempt timestamp is not scholar practice and must not
    // inflate the scholar-facing 'days practiced' count.
    const rows = [
      { skillKey: "pinned-untouched", repetition: 0, updatedAt: NOW }, // no lastAttemptAt
    ];
    const m = computeMomentum(rows, [], NOW);
    expect(m.daysActive).toBe(0);
    expect(m.skillsStrengthened).toBe(0);
  });

  it("ignores a crossing stamp dated in the future", () => {
    const rows = [
      { skillKey: "clock-skew", repetition: 3, updatedAt: NOW, lastAttemptAt: NOW, becameFluentAt: NOW + 5 * DAY },
    ];
    expect(computeMomentum(rows, [], NOW).skillsStrengthened).toBe(0);
  });

  it("a teacher-flagged observation does NOT count as a day active (observer-detected ones do)", () => {
    const teacherFlagged = {
      conceptLabel: "borrowing",
      masteryLevel: 1,
      observedAt: NOW - 1 * DAY,
      attemptContext: "teacher-flagged",
    };
    const observerDetected = {
      conceptLabel: "place value",
      masteryLevel: 3,
      observedAt: NOW - 3 * DAY,
      attemptContext: "chat",
    };
    expect(computeMomentum([], [teacherFlagged], NOW).daysActive).toBe(0);
    expect(computeMomentum([], [observerDetected], NOW).daysActive).toBe(1);
  });
});
