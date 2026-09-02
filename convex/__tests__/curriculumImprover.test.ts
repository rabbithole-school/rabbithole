/**
 * Pure Improver prompt assembly (convex/lib/curriculumImprover.ts). No model
 * call — we only assert the user message folds in the fixed goal, the current
 * prompt, the aggregate, and every per-scholar diagnosis (the signal the
 * Improver reasons over). Twin behavior of evals/curriculum-sim/lib/improver.ts.
 */
import { describe, expect, test } from "vitest";
import {
  buildImproverUserMessage,
  type ImproverDiagnosis,
} from "../lib/curriculumImprover";
import { aggregate } from "../lib/curriculumScore";
import type { SimActivity } from "../lib/curriculumSimShared";

const ACTIVITY: SimActivity = {
  title: "Halving Shapes",
  kind: "online",
  systemPrompt: "Guide them to discover halves. Wait for a number.",
  learningGoal: "Understand that half = two equal parts.",
  deliverablePrompt: "Describe one shape split into equal halves.",
};

const VERDICT = {
  goalAttainment: 5,
  deliverableReach: 4,
  productiveStruggle: 4,
  socratic: 5,
  cognitiveOffloading: 4,
  noSpoilers: 4,
  sycophancy: 4,
  ageFit: 5,
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
  summary: "ok",
};

const DIAGNOSES: ImproverDiagnosis[] = [
  {
    name: "Maya",
    readingLevel: "Grade 2",
    stopReason: "stuck",
    goalAttainment: 2,
    productiveStruggle: 2,
    stallPoint: "froze when asked for a number after drawing the answer",
    promptAttribution: "prompt told the tutor to wait for a number",
  },
  {
    name: "Sam",
    readingLevel: "Kindergarten",
    stopReason: "goal",
    goalAttainment: 4,
    productiveStruggle: 4,
    stallPoint: "none",
    promptAttribution: "none",
  },
];

describe("buildImproverUserMessage", () => {
  test("includes the fixed goal, current prompt, aggregate, and every diagnosis", () => {
    const agg = aggregate([VERDICT, VERDICT]);
    const msg = buildImproverUserMessage(ACTIVITY, agg, DIAGNOSES);

    expect(msg).toContain("FIXED learning goal: Understand that half = two equal parts.");
    expect(msg).toContain("Wait for a number."); // current prompt echoed
    expect(msg).toContain("n=2");
    // Each scholar's stall + attribution must reach the Improver.
    expect(msg).toContain("Maya");
    expect(msg).toContain("wait for a number");
    expect(msg).toContain("Sam");
    expect(msg).toContain("attribution: none");
    // The gifted lens is surfaced + flagged as guarded, and the turn cap is
    // reframed so the Improver doesn't "fix" maxTurns by speeding the tutor up.
    expect(msg).toContain("gifted lens");
    expect(msg).toMatch(/GUARDED — your edit may not lower them/);
    expect(msg).toMatch(/maxTurns[\s\S]*not a failure/);
    expect(msg).toContain("goal-reached 100%");
    expect(msg).not.toContain("goalAttainment ");
    expect(msg).not.toMatch(
      /singleSpine|discoveryArc|handsOnMission|earnedPayoff/,
    );
  });

  test("renders '(none)' when the activity has no deliverable", () => {
    const agg = aggregate([VERDICT]);
    const msg = buildImproverUserMessage(
      { ...ACTIVITY, deliverablePrompt: null },
      agg,
      DIAGNOSES,
    );
    expect(msg).toContain("Deliverable: (none)");
  });
});
