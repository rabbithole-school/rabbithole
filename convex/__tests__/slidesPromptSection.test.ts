import { describe, expect, test } from "vitest";
import { buildSlidesSection } from "../sessionHelpers";
import type { ArtifactData } from "../sessionHelpers";
import { applySlideOps, emptyDeck } from "../../shared/slidesScene";
import type { Deck } from "../../shared/slidesScene";

/**
 * Guards the fix for the observer report where the tutor kept telling a scholar
 * a slide deck they had filled in was "still blank." Rabbit Slides are NOT text
 * artifacts, so slide copy is not carried by buildArtifactSection — this section
 * is what puts the deck's live content into the tutor's prompt every turn.
 */

let idCounter = 0;
const mintId = () => `id${++idCounter}`;

/** A one-slide deck carrying a text element with real scholar copy. */
function deckWithText(text: string): Deck {
  const base = emptyDeck("Research & Teaching Slide", "s1");
  const result = applySlideOps(
    base,
    [
      {
        op: "addElement",
        slideId: "s1",
        element: {
          type: "text",
          frame: { x: 40, y: 40, w: 600, h: 120 },
          text,
        },
      },
    ],
    mintId,
  );
  if ("error" in result) throw new Error(result.error);
  return result.deck;
}

function slidesArtifact(deck: Deck): ArtifactData {
  return {
    id: "a1",
    title: deck.title,
    content: JSON.stringify(deck),
    lastEditedBy: "scholar",
    revision: deck.revision,
    type: "slides",
  };
}

describe("buildSlidesSection", () => {
  test("injects the scholar's slide text as the live source of truth", () => {
    const copy =
      "Sci-fi thrives on the unknown: it asks what a new technology does to people.";
    const section = buildSlidesSection([slidesArtifact(deckWithText(copy))]);
    expect(section).toContain("SLIDE DECK");
    expect(section).toContain(copy);
    // The anti-gaslighting guardrail must be present.
    expect(section).toContain("source of truth");
    expect(section).toMatch(/NEVER tell the scholar their deck is blank/i);
  });

  test("carries slide text well past the 60-char tool-read preview cap", () => {
    const long = "A".repeat(400);
    const section = buildSlidesSection([slidesArtifact(deckWithText(long))]);
    expect(section).toContain(long);
  });

  test("returns empty string when the session has no deck", () => {
    expect(buildSlidesSection(null)).toBe("");
    expect(
      buildSlidesSection([
        {
          id: "d1",
          title: "Doc",
          content: "hello",
          lastEditedBy: "scholar",
          revision: 0,
          type: "text",
        },
      ]),
    ).toBe("");
  });

  test("returns empty string when the deck content is unparseable", () => {
    expect(
      buildSlidesSection([
        {
          id: "a1",
          title: "Broken",
          content: "{not json",
          lastEditedBy: "scholar",
          revision: 0,
          type: "slides",
        },
      ]),
    ).toBe("");
  });
});
