import { describe, expect, test } from "vitest";
import {
  MATH_CROSS_DOMAIN_SEEDS,
  seedCardCopy,
} from "../practice/crossDomainSeeds";

const words = (text: string) => text.trim().split(/\s+/).length;

describe("MATH_CROSS_DOMAIN_SEEDS card copy", () => {
  test("topics are unique (topic is the minting idempotency key)", () => {
    const topics = MATH_CROSS_DOMAIN_SEEDS.map((s) => s.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });

  test.each(MATH_CROSS_DOMAIN_SEEDS.map((s) => [s.topic, s] as const))(
    "%s has a short title, an emoji and a short teaser",
    (_topic, seed) => {
      expect(words(seed.cardTitle)).toBeLessThanOrEqual(7);
      expect(seed.cardTitle).not.toContain("→");
      expect(seed.visualEmoji.trim()).not.toBe("");
      expect(words(seed.scholarInvitation)).toBeLessThanOrEqual(30);
    },
  );
});

describe("seedCardCopy", () => {
  const def = MATH_CROSS_DOMAIN_SEEDS[0];

  test("a cross-domain row minted with old copy resolves to the registry's card", () => {
    expect(
      seedCardCopy({
        topic: def.topic,
        suggestionType: "cross_domain",
        scholarInvitation: "OLD_INVITATION",
        rationale: "ROW_RATIONALE",
      }),
    ).toEqual({
      title: def.cardTitle,
      teaser: def.scholarInvitation,
      visualEmoji: def.visualEmoji,
    });
  });

  test("an unknown topic falls back to the row", () => {
    expect(
      seedCardCopy({
        topic: "ROW_TOPIC",
        suggestionType: "cross_domain",
        scholarInvitation: "ROW_INVITATION",
        rationale: "ROW_RATIONALE",
      }),
    ).toEqual({ title: "ROW_TOPIC", teaser: "ROW_INVITATION" });
    expect(
      seedCardCopy({
        topic: "ROW_TOPIC",
        suggestionType: "cross_domain",
        rationale: "ROW_RATIONALE",
      }),
    ).toEqual({ title: "ROW_TOPIC", teaser: "ROW_RATIONALE" });
  });

  test("a non-cross-domain seed never borrows registry copy", () => {
    expect(
      seedCardCopy({
        topic: def.topic,
        suggestionType: "interest",
        scholarInvitation: "ROW_INVITATION",
        rationale: "ROW_RATIONALE",
      }),
    ).toEqual({ title: def.topic, teaser: "ROW_INVITATION" });
  });
});
