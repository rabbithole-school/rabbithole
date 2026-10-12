import { describe, expect, test } from "vitest";
import { isValidCardQuestion } from "../../../shared/questionCard";
import { STORY_CARD_QUESTIONS, storyEdgeKey } from "../practice/storyCardQuestions";
import { STORY_REGISTRY } from "../practice/storyRegistry";

/** Words a reader actually reads: whitespace tokens carrying a letter or digit
 *  (so "+", "×", "—" and "=" don't count against the budget). */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

const registryKeys = new Set(STORY_REGISTRY.map((s) => storyEdgeKey(s.fromKey, s.toKey)));
const entries = Object.entries(STORY_CARD_QUESTIONS);

describe("STORY_CARD_QUESTIONS", () => {
  test("every key names a real STORY_REGISTRY edge", () => {
    const orphans = entries.map(([key]) => key).filter((key) => !registryKeys.has(key));
    expect(orphans).toEqual([]);
  });

  test.each(entries)("%s is a valid card question within the copy budgets", (_key, q) => {
    expect(isValidCardQuestion(q)).toBe(true);
    expect(wordCount(q.prompt)).toBeLessThanOrEqual(25);
    for (const choice of q.choices) expect(wordCount(choice)).toBeLessThanOrEqual(6);
    expect(wordCount(q.reveal)).toBeLessThanOrEqual(14);
  });

  test("covers at least 90% of registry stories", () => {
    const covered = [...registryKeys].filter((key) => key in STORY_CARD_QUESTIONS).length;
    const coverage = covered / registryKeys.size;
    console.info(`story card questions: ${covered}/${registryKeys.size} registry stories`);
    expect(coverage).toBeGreaterThanOrEqual(0.9);
  });
});
