import { describe, expect, test } from "vitest";
import { isValidCardQuestion } from "../../../shared/questionCard";
import { MATH_CROSS_DOMAIN_SEEDS } from "../practice/crossDomainSeeds";
import { SEED_CARD_QUESTIONS } from "../practice/seedCardQuestions";

const words = (text: string) => text.trim().split(/\s+/).length;

// The approved penny example's second choice ("1 penny, doubled daily for 30
// days") is 7 words. It was signed off verbatim, so it alone may run one over.
describe("SEED_CARD_QUESTIONS", () => {
  const topics = new Set(MATH_CROSS_DOMAIN_SEEDS.map((s) => s.topic));

  test("every cross-domain seed has a question", () => {
    const missing = [...topics].filter((t) => !(t in SEED_CARD_QUESTIONS));
    expect(missing).toEqual([]);
  });

  test("every key is a real seed topic (topic is the immutable identity)", () => {
    const orphans = Object.keys(SEED_CARD_QUESTIONS).filter((k) => !topics.has(k));
    expect(orphans).toEqual([]);
  });

  test.each(Object.entries(SEED_CARD_QUESTIONS))("%s fits the card", (topic, q) => {
    expect(isValidCardQuestion(q)).toBe(true);
    expect(words(q.prompt)).toBeLessThanOrEqual(25);
    for (const choice of q.choices) expect(words(choice)).toBeLessThanOrEqual(6);
    expect(words(q.reveal)).toBeLessThanOrEqual(14);
  });
});
