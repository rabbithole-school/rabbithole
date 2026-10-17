import { describe, expect, test } from "vitest";
import { buildStageCheck } from "../lib/bake";
import type { BakedActivity } from "../lib/arms";

type Act = BakedActivity["design"]["lessons"][number]["activities"][number];

function design(activities: Partial<Act>[]): BakedActivity["design"] {
  return {
    title: "Why do long bridges sag?",
    description: null,
    systemPrompt: null,
    bigIdea: null,
    essentialQuestions: [],
    enduringUnderstandings: [],
    lessons: [
      {
        title: "Loads and spans",
        systemPrompt: null,
        durationMinutes: null,
        activities: activities.map((a, i) => ({
          title: `Step ${i + 1}`,
          description: null,
          kind: "online",
          systemPrompt: null,
          durationMinutes: null,
          deliverable: null,
          ...a,
        })),
      },
    ],
  };
}

describe("buildStageCheck (TRA-519 B4)", () => {
  test("ok only when the last activity is an app with a contract", () => {
    expect(
      buildStageCheck(design([{}, {}, {}, { appActivity: true, hasContract: true }])),
    ).toEqual({ app: true, contract: true, ok: true });
    expect(buildStageCheck(design([{}, {}, {}, { appActivity: true }])).ok).toBe(false);
    expect(buildStageCheck(design([{ appActivity: true, hasContract: true }, {}])).ok).toBe(
      false,
    );
  });
});
