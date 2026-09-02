import { describe, expect, test } from "vitest";
import {
  TOOL_ACTION_DISCRIMINATORS,
  hasToolRowDisplay,
  isToolActivityLabel,
  toolRowDisplay,
} from "../toolActivity";

describe("isToolActivityLabel", () => {
  test("a whisper is never a scholar-facing activity line", () => {
    // The one that matters: whispers carry a teacher's private guidance in
    // `content`, so admitting them into the transcript would show a scholar
    // coaching written about them.
    expect(isToolActivityLabel("whisper")).toBe(false);
  });

  test("discriminators with their own renderer are not activity lines", () => {
    for (const action of TOOL_ACTION_DISCRIMINATORS) {
      expect(isToolActivityLabel(action)).toBe(false);
    }
  });

  test("a discriminator stays excluded under case and whitespace variance", () => {
    // `toolAction` is typed as a free string, so nothing structurally forces
    // the canonical spelling. An exact-match denylist would let any of these
    // through, and for `whisper` that means rendering a teacher's private
    // guidance to the scholar.
    for (const action of TOOL_ACTION_DISCRIMINATORS) {
      for (const variant of [
        action.toUpperCase(),
        ` ${action} `,
        `${action}\n`,
        `\t${action}`,
      ]) {
        expect(isToolActivityLabel(variant)).toBe(false);
      }
    }
  });

  test("human-readable receipts are activity lines", () => {
    for (const action of [
      "Wrote down your words",
      "Edited document",
      "Created document",
      "Created code artifact",
      "Reviewed work",
      "Generated image",
      "Earned flair",
    ]) {
      expect(isToolActivityLabel(action)).toBe(true);
    }
  });

  test("a blank toolAction is not an activity line", () => {
    // An empty toolAction means "split the stream silently" — no row is
    // persisted, but defend against one that is.
    expect(isToolActivityLabel("")).toBe(false);
    expect(isToolActivityLabel("   ")).toBe(false);
    expect(isToolActivityLabel(undefined)).toBe(false);
    expect(isToolActivityLabel(null)).toBe(false);
  });

  test("the human-readable receipt and its discriminator are distinguishable", () => {
    // "Generated image" is the receipt; "generate_image" is the discriminator.
    // They differ, and only the receipt renders.
    expect(isToolActivityLabel("Generated image")).toBe(true);
    expect(isToolActivityLabel("generate_image")).toBe(false);
  });
});

describe("toolRowDisplay", () => {
  test("a generated image renders BOTH its picture and its receipt", () => {
    // The bug: `generate_image` writes one tool row carrying an imageId AND the
    // "Generated image" receipt. A renderer that treated the receipt branch as
    // terminal showed a scholar the caption with no picture under it.
    expect(
      toolRowDisplay({ toolAction: "Generated image", imageId: "kg2aay61" }),
    ).toEqual({
      imageId: "kg2aay61",
      label: "Generated image",
      sourceHost: null,
    });
  });

  test("an image with no receipt label still renders the image", () => {
    // finalizeAndSplit persists a row when `toolAction.trim() || imageId`, so a
    // blank label with an image is a real shape.
    expect(toolRowDisplay({ toolAction: "", imageId: "img1" })).toEqual({
      imageId: "img1",
      label: null,
      sourceHost: null,
    });
  });

  test("a receipt with no image renders just the line", () => {
    expect(toolRowDisplay({ toolAction: "Wrote down your words" })).toEqual({
      imageId: null,
      label: "Wrote down your words",
      sourceHost: null,
    });
  });

  test("a discriminator never leaks as a label", () => {
    for (const action of TOOL_ACTION_DISCRIMINATORS) {
      expect(toolRowDisplay({ toolAction: action }).label).toBeNull();
    }
  });

  test("a found image carries its source into the receipt line", () => {
    // A searched image is a real photograph or published diagram, so its
    // provenance has to travel with it. Composing the line HERE rather than in
    // each frontend is what stops web and native from attributing differently.
    expect(
      toolRowDisplay({
        toolAction: "Found image",
        imageId: "img1",
        imageSourceHost: "wikimedia.org",
      }),
    ).toEqual({
      imageId: "img1",
      label: "Found image \u00b7 wikimedia.org",
      sourceHost: "wikimedia.org",
    });
  });

  test("attribution without a picture is dropped", () => {
    // A source host with no image is meaningless — and rendering it would put a
    // bare domain name in a child's transcript with nothing to attribute.
    expect(
      toolRowDisplay({ toolAction: "Found image", imageSourceHost: "a.com" }),
    ).toEqual({ imageId: null, label: "Found image", sourceHost: null });
  });

  test("a generated image is never attributed to a source", () => {
    // The whole point of the pair is that a reader can tell "the model drew
    // this" from "the web published this".
    const display = toolRowDisplay({
      toolAction: "Generated image",
      imageId: "img1",
    });
    expect(display.sourceHost).toBeNull();
    expect(display.label).toBe("Generated image");
  });

  test("a blank or whitespace source host is not rendered", () => {
    expect(
      toolRowDisplay({
        toolAction: "Found image",
        imageId: "img1",
        imageSourceHost: "   ",
      }).sourceHost,
    ).toBeNull();
  });

  test("a row with neither is not renderable", () => {
    const display = toolRowDisplay({ toolAction: "whisper" });
    expect(display.imageId).toBeNull();
    expect(display.label).toBeNull();
  });
});

describe("hasToolRowDisplay", () => {
  test("an image-only row is renderable even with no receipt", () => {
    expect(hasToolRowDisplay({ toolAction: "", imageId: "img1" })).toBe(true);
  });

  test("a receipt-only row is renderable", () => {
    expect(hasToolRowDisplay({ toolAction: "Edited document" })).toBe(true);
  });

  test("a whisper is never renderable to a scholar", () => {
    expect(hasToolRowDisplay({ toolAction: "whisper" })).toBe(false);
  });
});
