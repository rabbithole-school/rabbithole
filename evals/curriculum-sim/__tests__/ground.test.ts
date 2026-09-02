import { describe, expect, test } from "vitest";
import { aggregate, type SessionVerdict } from "../lib/score";
import { calibrate, realTranscriptToSession } from "../lib/ground";

function verdict(o: Partial<SessionVerdict> = {}): SessionVerdict {
  return {
    goalAttainment: 3,
    deliverableReach: 3,
    productiveStruggle: 3,
    socratic: 4,
    cognitiveOffloading: 4,
    noSpoilers: 4,
    sycophancy: 4,
    ageFit: 4,
    depth: 4,
    complexity: 4,
    abstraction: 4,
    inquiry: 4,
    authenticity: 4,
    singleSpine: 4,
    discoveryArc: 4,
    handsOnMission: 4,
    earnedPayoff: 4,
    stallPoint: "none",
    promptAttribution: "none",
    summary: "t",
    ...o,
  };
}

describe("realTranscriptToSession", () => {
  test("maps assistant→tutor and user→scholar", () => {
    const s = realTranscriptToSession({
      scholarName: "Kai",
      readingLevel: "Grade 3",
      turns: [
        { role: "assistant", content: "hi" },
        { role: "user", content: "hello" },
      ],
    });
    expect(s.turns.map((t) => t.role)).toEqual(["tutor", "scholar"]);
    expect(s.profile.name).toBe("Kai");
  });
});

describe("calibrate", () => {
  test("flags trustworthy when sim tracks reality", () => {
    const sim = aggregate([verdict({ goalAttainment: 4 })]);
    const real = aggregate([verdict({ goalAttainment: 4 })]);
    const c = calibrate(sim, real);
    expect(c.trustworthy).toBe(true);
    expect(c.fitnessDelta).toBeCloseTo(0, 5);
  });

  test("flags UNtrustworthy + optimistic when the sim overstates outcomes", () => {
    const sim = aggregate([verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 5 })]);
    const real = aggregate([verdict({ goalAttainment: 2, deliverableReach: 2, productiveStruggle: 2 })]);
    const c = calibrate(sim, real);
    expect(c.trustworthy).toBe(false);
    expect(c.fitnessDelta).toBeGreaterThan(0); // optimistic
    expect(c.note).toMatch(/optimistic/);
  });
});

describe("calibrate — goalAttainment grounding hygiene", () => {
  test("hot goalAttainment (sim > real) ⇒ flagged optimistic + [[DONE]] note", () => {
    const sim = aggregate([verdict({ goalAttainment: 5 })]);
    const real = aggregate([verdict({ goalAttainment: 2 })]);
    const c = calibrate(sim, real, 0.75);
    expect(c.goalAttainmentDelta).toBe(3);
    expect(c.goalAttainmentOptimistic).toBe(true);
    expect(c.goalAttainmentNote).toMatch(/\[\[DONE\]\]/);
  });

  test("matched goalAttainment ⇒ not flagged, note null", () => {
    const c = calibrate(
      aggregate([verdict({ goalAttainment: 4 })]),
      aggregate([verdict({ goalAttainment: 4 })]),
      0.75,
    );
    expect(c.goalAttainmentOptimistic).toBe(false);
    expect(c.goalAttainmentNote).toBeNull();
  });

  test("pessimistic goalAttainment (real > sim) is NOT flagged", () => {
    const c = calibrate(
      aggregate([verdict({ goalAttainment: 2 })]),
      aggregate([verdict({ goalAttainment: 5 })]),
      0.75,
    );
    expect(c.goalAttainmentDelta).toBe(-3);
    expect(c.goalAttainmentOptimistic).toBe(false);
  });
});
