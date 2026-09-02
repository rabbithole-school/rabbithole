/**
 * Pure prompt-builder guardrails for the curriculum simulation
 * (convex/lib/curriculumSimShared.ts). Grounding hygiene #6: the [[DONE]]
 * sentinel may only fire after the sim kid explains the goal in its OWN
 * words, and the judge's goalAttainment rubric scores whether that
 * declaration was EARNED. These assert the load-bearing language survives
 * edits — they don't call any model.
 */
import { describe, expect, test } from "vitest";
import {
  DONE,
  JUDGE_RUBRIC,
  JUDGE_TOOL,
  formatSessionForJudge,
  buildKidSystem,
  type SimActivity,
  type SimProfile,
} from "../lib/curriculumSimShared";
import {
  DESIGN_JUDGE_RUBRIC,
  DESIGN_JUDGE_TOOL,
  INVESTIGATION_BAR_RUBRIC,
  formatUnitDesignForJudge,
} from "../lib/curriculumJudge";

const profile: SimProfile = {
  name: "Cog",
  readingLevel: "Grade 4",
  dossier: "reads well, shaky with number sense",
  traits: ["goes off on tangents"],
};

const activity: SimActivity = {
  title: "Fraction Sense",
  kind: "online",
  systemPrompt: "Guide the scholar to see fractions as parts of a whole.",
  learningGoal: "understand that a fraction names a part of a whole",
  deliverablePrompt: null,
};

describe("buildKidSystem — [[DONE]] contract", () => {
  const sys = buildKidSystem(profile, activity);

  test("still tells the kid to end with the DONE sentinel on its own line", () => {
    expect(sys).toContain(DONE);
    expect(sys).toContain("on its own line");
  });

  test("requires an own-words goal explanation before the sentinel fires", () => {
    expect(sys).toMatch(/do NOT end with \[\[DONE\]\] until/i);
    expect(sys).toMatch(/own words/i);
    // A bare acknowledgement is explicitly ruled out.
    expect(sys).toMatch(/I get it/i);
    expect(sys).toMatch(/is NOT enough/i);
  });
});

describe("JUDGE_RUBRIC — goalAttainment scores an EARNED declaration", () => {
  test("rubric rewards articulating in own words and penalizes a hollow sign-off", () => {
    expect(JUDGE_RUBRIC).toMatch(/EARNED/);
    expect(JUDGE_RUBRIC).toMatch(/own words/i);
    expect(JUDGE_RUBRIC).toMatch(/hollow|parroted|unexplained/i);
    expect(JUDGE_RUBRIC).toMatch(/declared an understanding they never\s+demonstrated/i);
  });

  test("judge payload includes full unit design and sanitizes tool artifacts", () => {
    const payload = formatSessionForJudge(
      { ...activity, unitDesign: "Unit: Fraction Sense\nBig Idea: Fairness" },
      profile,
      [
        {
          role: "tutor",
          content: '<invoke name="generate_image">{"prompt":"halves"}</invoke>',
        },
      ],
      "maxTurns",
    );
    expect(payload).toContain("## Unit design");
    expect(payload).toContain("Big Idea: Fairness");
    expect(payload).toContain(
      "[The tutor generated an image and showed it to the scholar here.]",
    );
    expect(payload).not.toContain("<invoke");
  });

  test("canonical rubric and tool include the diagnosis-only investigation bar", () => {
    expect(JUDGE_TOOL.name).toBe("record_session_verdict");
    expect(JUDGE_RUBRIC).toMatch(/INVESTIGATION BAR/);
    expect(JUDGE_RUBRIC).toMatch(/measured, not gating/i);
    for (const key of [
      "goalAttainment",
      "deliverableReach",
      "productiveStruggle",
      "depth",
      "complexity",
      "abstraction",
      "inquiry",
      "authenticity",
      "singleSpine",
      "discoveryArc",
      "handsOnMission",
      "earnedPayoff",
      "socratic",
      "cognitiveOffloading",
      "noSpoilers",
      "sycophancy",
      "ageFit",
      "stallPoint",
      "promptAttribution",
      "summary",
    ]) {
      expect(JUDGE_TOOL.input_schema.required).toContain(key);
      expect(JUDGE_TOOL.input_schema.properties).toHaveProperty(key);
    }
  });

  test("design-only judge reuses the canonical investigation bar and requires no transcript dims", () => {
    expect(DESIGN_JUDGE_RUBRIC).toContain(INVESTIGATION_BAR_RUBRIC);
    expect(DESIGN_JUDGE_TOOL.name).toBe("record_design_verdict");
    expect(DESIGN_JUDGE_TOOL.input_schema.required).toEqual([
      "singleSpine",
      "discoveryArc",
      "handsOnMission",
      "earnedPayoff",
      "designDiagnosis",
    ]);
    expect(DESIGN_JUDGE_TOOL.input_schema.properties).not.toHaveProperty(
      "goalAttainment",
    );

    const payload = formatUnitDesignForJudge(
      "Fraction Quest",
      "Unit: Fraction Quest\nBig Idea: Fairness",
    );
    expect(payload).toContain("## QUEST: Fraction Quest");
    expect(payload).toContain("Big Idea: Fairness");
    expect(payload).not.toContain("Transcript");
  });
});
