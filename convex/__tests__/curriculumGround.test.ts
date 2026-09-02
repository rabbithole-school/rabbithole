/**
 * Phase-4 sim-to-real calibration (convex/lib/curriculumGround.ts) — pure, no
 * model calls. Twin of evals/curriculum-sim/__tests__/ground.test.ts.
 */
import { describe, expect, test } from "vitest";
import { aggregate, type SessionVerdict } from "../lib/curriculumScore";
import { calibrate, realMessagesToTranscript } from "../lib/curriculumGround";

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

describe("realMessagesToTranscript", () => {
  test("maps assistant→tutor / user→scholar and drops system/tool", () => {
    const turns = realMessagesToTranscript([
      { role: "assistant", content: "hi" },
      { role: "user", content: "hello" },
      { role: "system", content: "ignore me" },
      { role: "tool", content: "tool junk" },
      { role: "assistant", content: "bye" },
    ]);
    expect(turns).toEqual([
      { role: "tutor", content: "hi" },
      { role: "scholar", content: "hello" },
      { role: "tutor", content: "bye" },
    ]);
  });

  test("annotates a tutor turn a scholar flagged as wrong (with reason)", () => {
    const turns = realMessagesToTranscript([
      {
        role: "assistant",
        content: "2 + 2 = 5.",
        scholarFlaggedWrong: true,
        scholarFlagReason: "it's 4",
      },
      { role: "user", content: "no it's not" },
    ]);
    expect(turns[0].role).toBe("tutor");
    expect(turns[0].content).toContain("2 + 2 = 5.");
    expect(turns[0].content).toContain("flagged this response as wrong");
    expect(turns[0].content).toContain('"it\'s 4"');
    // The scholar turn is untouched.
    expect(turns[1]).toEqual({ role: "scholar", content: "no it's not" });
  });

  test("annotates a flagged tutor turn even with no reason given", () => {
    const turns = realMessagesToTranscript([
      { role: "assistant", content: "wrong thing", scholarFlaggedWrong: true },
    ]);
    expect(turns[0].content).toContain("wrong thing");
    expect(turns[0].content).toContain("flagged this response as wrong");
    expect(turns[0].content).not.toContain('":');
  });

  test("a scholar-role turn marked flagged is NOT annotated (tutor-only)", () => {
    const turns = realMessagesToTranscript([
      { role: "user", content: "my answer", scholarFlaggedWrong: true },
    ]);
    expect(turns[0]).toEqual({ role: "scholar", content: "my answer" });
  });
});

describe("calibrate", () => {
  test("close sim ⇒ trustworthy", () => {
    const sim = aggregate([verdict({ goalAttainment: 4 })]);
    const real = aggregate([verdict({ goalAttainment: 4 })]);
    const c = calibrate(sim, real, 0.75);
    expect(c.trustworthy).toBe(true);
    expect(c.fitnessDelta).toBeCloseTo(0, 5);
    expect(c.realN).toBe(1);
    expect(c.note).toMatch(/directional proxy/);
  });

  test("optimistic sim beyond threshold ⇒ not trustworthy, flagged optimistic", () => {
    // sim much higher fitness than real.
    const sim = aggregate([
      verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 5 }),
    ]);
    const real = aggregate([
      verdict({ goalAttainment: 2, deliverableReach: 2, productiveStruggle: 2 }),
    ]);
    const c = calibrate(sim, real, 0.75);
    expect(c.trustworthy).toBe(false);
    expect(c.fitnessDelta).toBeGreaterThan(0.75);
    expect(c.note).toMatch(/optimistic/);
    expect(c.note).toMatch(/DO NOT promote/);
  });

  test("per-dim deltas expose where the sim diverges", () => {
    const sim = aggregate([verdict({ socratic: 5 })]);
    const real = aggregate([verdict({ socratic: 3 })]);
    const c = calibrate(sim, real, 0.75);
    expect(c.perDim.socratic.sim).toBe(5);
    expect(c.perDim.socratic.real).toBe(3);
    expect(c.perDim.socratic.delta).toBe(2);
  });
});

describe("calibrate — goalAttainment grounding hygiene", () => {
  test("sim over-scores goalAttainment beyond threshold ⇒ flagged optimistic + note", () => {
    // goalAttainment runs hot (sim 5 vs real 2 = Δ3) but the rest of fitness is
    // matched, so overall fitness could still look fine — the dedicated dim
    // flag catches what fitnessDelta alone would miss.
    const sim = aggregate([verdict({ goalAttainment: 5 })]);
    const real = aggregate([verdict({ goalAttainment: 2 })]);
    const c = calibrate(sim, real, 0.75);
    expect(c.goalAttainmentDelta).toBe(3);
    expect(c.goalAttainmentOptimistic).toBe(true);
    expect(c.goalAttainmentNote).toMatch(/optimistic/);
    expect(c.goalAttainmentNote).toMatch(/\[\[DONE\]\]/);
    expect(c.goalAttainmentThreshold).toBe(0.75);
  });

  test("sim ≈ real goalAttainment ⇒ not flagged, note null", () => {
    const sim = aggregate([verdict({ goalAttainment: 4 })]);
    const real = aggregate([verdict({ goalAttainment: 4 })]);
    const c = calibrate(sim, real, 0.75);
    expect(c.goalAttainmentDelta).toBe(0);
    expect(c.goalAttainmentOptimistic).toBe(false);
    expect(c.goalAttainmentNote).toBeNull();
  });

  test("PESSIMISTIC goalAttainment (real > sim) is NOT flagged — only the hot direction", () => {
    const sim = aggregate([verdict({ goalAttainment: 2 })]);
    const real = aggregate([verdict({ goalAttainment: 5 })]);
    const c = calibrate(sim, real, 0.75);
    expect(c.goalAttainmentDelta).toBe(-3);
    expect(c.goalAttainmentOptimistic).toBe(false);
    expect(c.goalAttainmentNote).toBeNull();
  });

  test("goalAttainmentThreshold is independent of the fitness threshold", () => {
    // Δ = 1: over a tight 0.5 goal threshold, under the loose 2.0 fitness one.
    const sim = aggregate([verdict({ goalAttainment: 4 })]);
    const real = aggregate([verdict({ goalAttainment: 3 })]);
    const c = calibrate(sim, real, 2.0, 0.5);
    expect(c.goalAttainmentDelta).toBe(1);
    expect(c.goalAttainmentOptimistic).toBe(true);
    // A borderline delta exactly at the threshold does NOT trip it (strict >).
    const cEq = calibrate(sim, real, 2.0, 1.0);
    expect(cEq.goalAttainmentOptimistic).toBe(false);
  });

  test("goalAttainmentThreshold defaults to the fitness threshold when omitted", () => {
    const sim = aggregate([verdict({ goalAttainment: 5 })]);
    const real = aggregate([verdict({ goalAttainment: 4 })]);
    // Δ = 1: with the single 0.75 threshold it trips.
    expect(calibrate(sim, real, 0.75).goalAttainmentOptimistic).toBe(true);
    // With a loose 1.5 threshold it doesn't.
    expect(calibrate(sim, real, 1.5).goalAttainmentOptimistic).toBe(false);
  });
});
