import { describe, expect, it } from "vitest";
import { storyMomentForRehearsal } from "../storyRehearse";

describe("storyMomentForRehearsal", () => {
  it("adapts the authored edge into the same scholar reveal payload", () => {
    const moment = storyMomentForRehearsal({
      fromKey: "fractions.equal-parts",
      toKey: "music.meter",
      fromLabel: "Equal parts",
      hook: "A measure is divided the same way.",
      narrative: "The full story.",
      teaser: "Two quarter notes make half a measure.",
      visualEmoji: "🎵",
      artUrl: "https://example.test/story.png",
      probe: "What else divides time into equal parts?",
    });

    expect(moment).toMatchObject({
      fromKey: "fractions.equal-parts",
      toKey: "music.meter",
      skillLabel: "Equal parts",
      hook: "A measure is divided the same way.",
      narrative: "The full story.",
      teaser: "Two quarter notes make half a measure.",
      visualEmoji: "🎵",
      artUrl: "https://example.test/story.png",
      probe: "What else divides time into equal parts?",
    });
  });

  it("never carries a scholar or ledger identity into rehearsal", () => {
    const moment = storyMomentForRehearsal({
      fromKey: "a",
      toKey: "b",
      fromLabel: "A",
      hook: "Hook",
      narrative: "Narrative",
    });

    expect(moment).not.toHaveProperty("scholarId");
    expect(moment).not.toHaveProperty("eventId");
    expect(moment).not.toHaveProperty("seedId");
  });
});
