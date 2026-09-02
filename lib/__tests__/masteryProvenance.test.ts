import { describe, expect, it } from "vitest";
import {
  evidenceExcerptLabel,
  evidenceSourcePhrase,
} from "../masteryProvenance";

describe("mastery provenance", () => {
  it.each([
    ["game_session", "read off the game round", "Game round"],
    ["portfolio_scan", "read off scanned work", "Scanned work"],
    ["reflection", "read off the scholar's reflection", "Reflection"],
    ["session", "read off the session transcript", "Transcript"],
    [undefined, "read off the session transcript", "Transcript"],
  ])(
    "labels %s evidence accurately",
    (attemptContext, sourcePhrase, excerptLabel) => {
      const observation = { attemptContext };

      expect(evidenceSourcePhrase(observation)).toBe(sourcePhrase);
      expect(evidenceExcerptLabel(observation)).toBe(excerptLabel);
    },
  );
});
