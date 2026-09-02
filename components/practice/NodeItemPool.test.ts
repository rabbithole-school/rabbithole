import { describe, expect, test } from "vitest";
import { provenanceBadge } from "./NodeItemPool";

function item(overrides: { source: string; model?: string | null }) {
  return {
    id: "id" as never,
    stem: "stem",
    answerType: "integer",
    answer: "1",
    answerUnit: null,
    verifierKind: "arithmetic",
    manipulativeSpec: null,
    model: overrides.model ?? null,
    verifiedAt: 0,
    tier: null,
    source: overrides.source,
  };
}

describe("provenanceBadge", () => {
  // "authored" is the item editor's own save tag (practiceItemPool.ts) —
  // a human wrote/edited this row directly.
  test("is silent for a human-authored row", () => {
    expect(provenanceBadge(item({ source: "authored" }))).toBeNull();
  });

  // "registry" is the story-registry seeder's tag (convex/edgeStories.ts,
  // seedRegistryQuestions) — hand-written, human-reviewed application
  // questions, not model output. Regression guard: this seeder used to share
  // the "authored" tag with the item editor; renaming it (to make teacher
  // overrides distinguishable from untouched seeded rows) must not make the
  // UI mistake these for LLM-generated content.
  test("is silent for a registry-seeded row", () => {
    expect(provenanceBadge(item({ source: "registry" }))).toBeNull();
  });

  test("shows the AI badge for a model-generated row", () => {
    expect(provenanceBadge(item({ source: "practice-gen" }))).toBe("Generated");
  });

  test("shows the verified badge for a model-generated + verified row", () => {
    expect(provenanceBadge(item({ source: "practice-gen", model: "claude" }))).toBe(
      "AI · verified",
    );
  });
});
