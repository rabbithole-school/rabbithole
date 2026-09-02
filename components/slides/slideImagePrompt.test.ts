import { describe, expect, it } from "vitest";
import {
  MAX_ALT_LENGTH,
  canMakePicture,
  deriveAltText,
  generatedImageFrame,
  normalizePrompt,
  placeholderFrame,
  placeholderSlotOffset,
  resolveMakePictureResult,
} from "./slideImagePrompt";
import {
  NEW_ELEMENT_PRESETS,
  imageFrameForSize,
  CANVAS_W,
  CANVAS_H,
} from "@/shared/slidesScene";

describe("normalizePrompt", () => {
  it("trims and collapses interior whitespace", () => {
    expect(normalizePrompt("  a red \n dragon\t flying  ")).toBe("a red dragon flying");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizePrompt("   \n\t ")).toBe("");
  });
});

describe("deriveAltText", () => {
  it("uses the scholar's cleaned prompt as the alt text", () => {
    // Capitalized: alt text reads as a caption, and the rule is shared with
    // native so both surfaces label a generated image identically.
    expect(deriveAltText("a friendly robot watering a garden")).toBe(
      "A friendly robot watering a garden",
    );
  });

  it("collapses whitespace so the label is a tidy caption", () => {
    expect(deriveAltText("  a   volcano\n\nerupting  ")).toBe("A volcano erupting");
  });

  it("caps a very long prompt at a word boundary within the max length", () => {
    const prompt = "painting of ".repeat(40); // far longer than MAX_ALT_LENGTH
    const alt = deriveAltText(prompt);
    expect(alt.length).toBeLessThanOrEqual(MAX_ALT_LENGTH);
    // Cut on a boundary, never mid-word, and with no trailing space.
    expect(alt).toBe(alt.trimEnd());
    expect(alt.endsWith("of") || alt.endsWith("painting")).toBe(true);
  });

  it("never returns alt text longer than the max even without spaces", () => {
    const alt = deriveAltText("x".repeat(MAX_ALT_LENGTH + 50));
    expect(alt.length).toBe(MAX_ALT_LENGTH);
  });
});

describe("canMakePicture (the disabled/in-progress state machine)", () => {
  it("allows making a picture with a real prompt and nothing in flight", () => {
    expect(canMakePicture("a dragon", false)).toBe(true);
  });

  describe("resolveMakePictureResult", () => {
    it("turns a generated image into a prompt-labelled element", () => {
      expect(
        resolveMakePictureResult(
          { status: "generated", storageId: "asset-1", width: 1408, height: 768 },
          "a backwards carbon cycle",
        ),
      ).toEqual({
        status: "success",
        assetId: "asset-1",
        alt: "A backwards carbon cycle",
        width: 1408,
        height: 768,
      });
    });
  });

  it("blocks an empty or whitespace-only prompt", () => {
    expect(canMakePicture("", false)).toBe(false);
    expect(canMakePicture("   \n ", false)).toBe(false);
  });

  it("blocks a second request while one is already generating (double-click safe)", () => {
    expect(canMakePicture("a dragon", true)).toBe(false);
  });
});

describe("placeholder cascade (concurrent generations)", () => {
  const preset = NEW_ELEMENT_PRESETS.image("").frame;

  it("puts the first placeholder exactly on the preset image box", () => {
    expect(placeholderSlotOffset(0)).toEqual({ dx: 0, dy: 0 });
    expect(placeholderFrame(0)).toEqual({ ...preset });
  });

  it("cascades each later slot away from the previous so they don't stack", () => {
    const a = placeholderFrame(0);
    const b = placeholderFrame(1);
    const c = placeholderFrame(2);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);
    expect(c.x).toBeGreaterThan(b.x);
    // Same box size at every slot — only the position shifts.
    expect(b.w).toBe(preset.w);
    expect(b.h).toBe(preset.h);
  });

  // Shared with native, which clamps rather than wrapping: a far slot stops at
  // the canvas edge instead of marching off it (and instead of silently landing
  // back on slot 0, which an in-flight placeholder may still be holding).
  it("clamps a far slot inside the canvas instead of marching off-canvas", () => {
    const far = placeholderFrame(50);
    expect(far.x + far.w).toBeLessThanOrEqual(CANVAS_W);
    expect(far.y + far.h).toBeLessThanOrEqual(CANVAS_H);
    // It really is pinned at the edge, not merely inside it.
    expect(placeholderFrame(50)).toEqual(placeholderFrame(100));
  });

});

describe("generatedImageFrame (final image placement)", () => {
  it("fits a wide image inside the preset box with no letterbox bands", () => {
    // A 1408x768 illustration in a 500x380 box would letterbox top/bottom; the
    // fitted frame is the picture itself, centred on the same point.
    const frame = generatedImageFrame(1408, 768, 0);
    const fitted = imageFrameForSize(1408, 768);
    expect(frame).toEqual(fitted);
    expect(frame.h).toBeLessThan(NEW_ELEMENT_PRESETS.image("").frame.h);
  });

  it("centres the final image on the same point its placeholder occupied", () => {
    const slot = 2;
    const ph = placeholderFrame(slot);
    const img = generatedImageFrame(1408, 768, slot);
    const phCentreX = ph.x + ph.w / 2;
    const phCentreY = ph.y + ph.h / 2;
    const imgCentreX = img.x + img.w / 2;
    const imgCentreY = img.y + img.h / 2;
    // Within a rounding pixel — the image only resizes to fit, never jumps.
    expect(Math.abs(imgCentreX - phCentreX)).toBeLessThanOrEqual(1);
    expect(Math.abs(imgCentreY - phCentreY)).toBeLessThanOrEqual(1);
  });

  it("falls back to the preset box (cascaded) when dimensions are unreadable", () => {
    const slot = 1;
    expect(generatedImageFrame(undefined, undefined, slot)).toEqual(placeholderFrame(slot));
  });
});
