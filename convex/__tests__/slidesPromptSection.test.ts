import { describe, expect, test } from "vitest";
import { buildSlidesSection } from "../sessionHelpers";
import type { ArtifactData } from "../sessionHelpers";
import { applySlideOps, emptyDeck, MAX_TEXT_LENGTH, SLIDES_COPY } from "../../shared/slidesScene";
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
  });

  test("carries slide text well past the 60-char tool-read preview cap", () => {
    const long = "A".repeat(400);
    const section = buildSlidesSection([slidesArtifact(deckWithText(long))]);
    expect(section).toContain(long);
  });

  // TRA-702: a long Procedure box was cut at 600 characters with no marker, so
  // a sentence the scholar appended to the end never reached the tutor, which
  // kept saying the slide "still reads the same".
  test("shows the end of a long text box, where scholars append new sentences", () => {
    const procedure =
      "We will test the tank water every Monday, Wednesday, and Friday. ".repeat(12) +
      "Make sure to keep the fish food, temperature, and number of fish the same.";
    expect(procedure.length).toBeGreaterThan(600);
    const section = buildSlidesSection([slidesArtifact(deckWithText(procedure))]);
    expect(section).toContain(
      "Make sure to keep the fish food, temperature, and number of fish the same.",
    );
    expect(section).not.toContain("more characters not shown");
  });

  test("carries a text box at the editor's maximum length in full", () => {
    const max = "B".repeat(MAX_TEXT_LENGTH);
    const section = buildSlidesSection([slidesArtifact(deckWithText(max))]);
    expect(section).toContain(max);
  });

  test("tells the tutor the text is complete, so it never blames a cropped view", () => {
    const section = buildSlidesSection([slidesArtifact(deckWithText("Hello"))]);
    expect(section).toContain("shown in FULL");
    expect(section).toContain("never ask them to paste slide text into the chat");
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

  test("tells the tutor how a scholar brings slides from an earlier session (TRA-704)", () => {
    const section = buildSlidesSection([slidesArtifact(deckWithText("My hypothesis"))]);
    // The tutor can't read other sessions' decks; it must route the scholar to
    // the real Copy/Paste menu items rather than "ask your teacher".
    expect(section).toContain(`"${SLIDES_COPY.copyAllSlides}"`);
    expect(section).toContain(`"${SLIDES_COPY.pasteSlidesAfter(1)}"`);
    expect(section).toContain("moveSlide");
    // The tutor repeats this line to scholars, so it names their device.
    expect(section).toContain("BunnyPad");
    expect(section).not.toMatch(/\biPad\b/);
  });
});
