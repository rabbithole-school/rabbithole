import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, test } from "vitest";

import { SlideList } from "@/components/slides/SlideList";
import { system } from "@/lib/theme";
import { emptyDeck, emptySlide, type Deck } from "@/shared/slidesScene";

/**
 * The chat-side panel VIEWS a deck; the cover dialog EDITS it. These assertions
 * are the line between the two: `SlideList` is what the panel mounts, so any
 * editing affordance appearing in this markup means the crowded toolbar has
 * crept back into a 25%-wide splitter pane.
 */

function deckOf(...notes: Array<string | undefined>): Deck {
  const base = emptyDeck("Pizza talk", "s1");
  return {
    ...base,
    slides: notes.map((speakerNotes, i) => ({
      ...emptySlide(`s${i + 1}`),
      ...(speakerNotes === undefined ? {} : { speakerNotes }),
    })),
  };
}

function render(deck: Deck, onEditSlide?: (index: number) => void) {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
    createElement(ChakraProvider, {
      value: system,
      children: createElement(SlideList, { deck, onEditSlide }),
    }),
  );
}

describe("SlideList — the read-only chat-side deck", () => {
  test("renders every slide, in deck order, and nothing that edits one", () => {
    const html = render(deckOf(undefined, undefined, undefined));

    // One list item per slide, numbered in order.
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html.indexOf(">1<")).toBeLessThan(html.indexOf(">2<"));
    expect(html.indexOf(">2<")).toBeLessThan(html.indexOf(">3<"));

    // The editing chrome that used to ship in the narrow panel.
    for (const affordance of [
      "Rectangle",
      "Ellipse",
      "Image",
      "PowerPoint",
      "Delete text",
      "Add slide",
      "Delete slide",
      "Add speaker notes",
      "Undo",
      "Redo",
    ]) {
      expect(html).not.toContain(affordance);
    }
    expect(html).not.toContain("<textarea");
  });

  test("shows speaker notes as text, with no way to type into them", () => {
    const html = render(deckOf("Ask about equal parts", ""));

    expect(html).toContain("Ask about equal parts");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("contenteditable");
  });

  test("offers the full editor per slide only when the deck is the viewer's", () => {
    const editable = render(deckOf(undefined, undefined), () => {});
    expect(editable.match(/<button/g)).toHaveLength(2);
    expect(editable).toContain('aria-label="Edit slide 1"');
    expect(editable).toContain('aria-label="Edit slide 2"');

    // Teacher remote view (non-owner): the same slides, no controls at all.
    const readOnly = render(deckOf(undefined, undefined));
    expect(readOnly).not.toContain("<button");
    expect(readOnly).not.toContain("Edit slide");
    expect(readOnly.match(/<li/g)).toHaveLength(2);
  });

  test("the chat panel mounts the editor only inside the full-size dialog", () => {
    const source = readFileSync(
      join(__dirname, "SlidesArtifactView.tsx"),
      "utf8",
    );

    expect(source).toContain("<SlideList");
    const editorMatches = [...source.matchAll(/<SlidesEditor(?=\s)/g)];
    expect(editorMatches).toHaveLength(1);
    const editorAt = editorMatches[0].index;
    expect(source.indexOf("<SlidesEditorDialogFrame")).toBeLessThan(editorAt);
    expect(source.indexOf("</SlidesEditorDialogFrame>")).toBeGreaterThan(editorAt);
    expect(source).toContain('size="full"');
  });

  /**
   * The artifact panel around this list is the scroll surface. A second
   * same-axis scroller here is what makes the list jump when the editor opens
   * and closes, so the list grows and lets the panel scroll it — the same
   * posture the native compact panel takes.
   */
  test("the list is not its own scroll container", () => {
    const source = readFileSync(join(__dirname, "SlideList.tsx"), "utf8");

    expect(source).not.toMatch(/overflowY/);
    expect(source).not.toMatch(/scrollIntoView/);
    expect(source).not.toMatch(/scrollTop/);
  });
});
