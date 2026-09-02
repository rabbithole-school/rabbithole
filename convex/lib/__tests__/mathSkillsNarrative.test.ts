import { describe, expect, test } from "vitest";
import {
  applyMathSkillsNarratives,
  buildMathSkillsNarrativeUserMessage,
  collectMathSkillsNarrativeCandidates,
  parseMathSkillsNarrativeToolInput,
} from "../practice/mathSkillsNarrative";
import type { PracticeCohortDigestRow } from "../practiceDigest";

const cohorts: PracticeCohortDigestRow[] = [
  {
    title: "Geckos",
    scholars: [
      {
        scholarId: "scholar-1",
        domain: "whole-number-arithmetic",
        name: "Scholar",
        needsPlacement: false,
        practicedDays: 2,
        skillsTurnedFluent: 3,
        turnedFluentLabels: ["Adding fractions", "Equivalent fractions", "Decimals"],
        skillsAdvanced: 0,
        frontierLabels: ["Long division", "Rounding", "Exponents"],
        dueReviews: 0,
        misconceptionFlags: 1,
        priorityTopics: [
          {
            domain: "whole-number-arithmetic",
            nodeKey: "grouping",
            label: "Order of operations",
            tier: "sustained",
            pattern: "REVERSED_OPERANDS",
            patternDescription: "Order of the operation isn't yet anchored.",
            attemptCount: 6,
            missCount: 4,
            correctCount: 2,
            missSittingCount: 2,
            dayCount: 2,
            dayLabels: ["Tuesday", "Thursday"],
            latestAttemptCorrect: false,
            trailingCorrectCount: 0,
            breakerCount: 1,
            missExamples: [
              {
                stem: "8 + 2 × 3",
                learnerAnswer: "30",
                expectedAnswer: "14",
                isDontKnow: false,
              },
            ],
            reason:
              "4 misses in 6 attempts across 2 sittings; latest attempt was missed",
          },
        ],
      },
    ],
  },
];

describe("math skills narratives", () => {
  test("builds evidence-only model input without scholar identity", () => {
    const candidates = collectMathSkillsNarrativeCandidates(cohorts);
    const prompt = buildMathSkillsNarrativeUserMessage(candidates);

    expect(candidates).toHaveLength(1);
    expect(prompt).toContain("Order of operations");
    expect(prompt).toContain('"learnerAnswer": "30"');
    expect(prompt).toContain('"missSittingCount": 2');
    expect(prompt).toContain('"weekPracticedDays": 2');
    expect(prompt).toContain('"weekFrontierSkills"');
    expect(prompt).toContain("Equivalent fractions");
    expect(prompt).toContain("Rounding");
    expect(prompt).not.toContain("Decimals");
    expect(prompt).not.toContain("Exponents");
    expect(prompt).not.toContain("scholar-1");
  });

  test("accepts a complete bounded response and applies it to the matching topic", () => {
    const candidates = collectMathSkillsNarrativeCandidates(cohorts);
    const narratives = parseMathSkillsNarrativeToolInput(
      {
        items: [
          {
            id: "topic-1",
            prose:
              "The examples show multiplication being applied after combining both addends, and that move returned in later practice.",
          },
        ],
      },
      candidates,
    );

    expect(narratives).not.toBeNull();
    expect(
      applyMathSkillsNarratives(cohorts, candidates, narratives!)
        [0].scholars[0].priorityTopics?.[0].narrative,
    ).toContain("returned in later practice");
  });

  test("rejects structurally invalid output", () => {
    expect(
      parseMathSkillsNarrativeToolInput(
        {
          items: [
            {
              id: "unknown",
              prose:
                "The same operation-order pattern returned in later practice and remained on the latest attempt.",
            },
          ],
        },
        collectMathSkillsNarrativeCandidates(cohorts),
      ),
    ).toBeNull();
  });

  test.each([
    "The teacher should reteach this urgently.",
    "See [this link](https://example.test) for the operation-order pattern.",
  ])("drops unsupported prose without discarding valid sibling items", (badProse) => {
    const twoTopics = structuredClone(cohorts);
    twoTopics[0].scholars[0].priorityTopics!.push({
      ...twoTopics[0].scholars[0].priorityTopics![0],
      nodeKey: "fractions",
      label: "Add fractions",
      tier: "practice",
    });
    const candidates = collectMathSkillsNarrativeCandidates(twoTopics);
    const narratives = parseMathSkillsNarrativeToolInput(
      {
        items: [
          {
            id: "topic-1",
            prose:
              "The examples show multiplication being applied after combining both addends, and that move returned in later practice.",
          },
          { id: "topic-2", prose: badProse },
        ],
      },
      candidates,
    );
    expect(narratives).not.toBeNull();
    expect(narratives).toHaveLength(1);
    expect(narratives?.get("topic-1")).toContain("returned in later practice");
  });
});
