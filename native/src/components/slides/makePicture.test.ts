import { describe, expect, test } from "vitest";

import {
  MAKE_PICTURE_COPY,
  MAKE_PICTURE_MAX_PROMPT,
  MAKE_PICTURE_MAX_ALT,
  PLACEHOLDER_CASCADE_STEP,
  canSubmitMakePicture,
  deriveSlideImageAlt,
  placeholderFrameForSlot,
  resolveGenerateResult,
  resolvedImageFrame,
} from "./makePicture";
import {
  CANVAS_H,
  CANVAS_W,
  NEW_ELEMENT_PRESETS,
  imageFrameForSize,
} from "../../../vendor/shared/slidesScene";

const IMAGE_PRESET = NEW_ELEMENT_PRESETS.image("").frame;

describe("deriveSlideImageAlt", () => {
  test("uses the scholar's prompt as a captioned label", () => {
    expect(deriveSlideImageAlt("a friendly robot watering a garden")).toBe(
      "A friendly robot watering a garden",
    );
  });

  test("collapses whitespace and trims", () => {
    expect(deriveSlideImageAlt("  a  red\n\tkite   ")).toBe("A red kite");
  });

  test("keeps an already-capitalised or proper-noun prompt intact past the first letter", () => {
    expect(deriveSlideImageAlt("Mount Fuji at sunrise")).toBe(
      "Mount Fuji at sunrise",
    );
  });

  test("never ships a bare image — empty or whitespace-only falls back", () => {
    expect(deriveSlideImageAlt("")).toBe("An image");
    expect(deriveSlideImageAlt("   \n\t ")).toBe("An image");
  });

  // Alt text caps at MAKE_PICTURE_MAX_ALT, not the backend's prompt limit: a
  // label is a caption, not a paragraph. The rule is shared with web so both
  // surfaces cap identically.
  test("caps the label to the shared alt limit", () => {
    const long = "x".repeat(MAKE_PICTURE_MAX_PROMPT + 50);
    expect(deriveSlideImageAlt(long)).toHaveLength(MAKE_PICTURE_MAX_ALT);
  });
});

describe("canSubmitMakePicture", () => {
  test("blocks an empty or whitespace-only prompt", () => {
    expect(canSubmitMakePicture("", false)).toBe(false);
    expect(canSubmitMakePicture("   ", false)).toBe(false);
  });

  test("allows a real prompt when idle", () => {
    expect(canSubmitMakePicture("a cat", false)).toBe(true);
  });

  test("blocks while a generation is already in flight (double-tap is a no-op)", () => {
    expect(canSubmitMakePicture("a cat", true)).toBe(false);
  });
});

describe("resolveGenerateResult", () => {
  test("turns a storage id into an image element with prompt-derived alt", () => {
    expect(
      resolveGenerateResult(
        { status: "generated", storageId: "kg123" },
        "a volcano erupting",
      ),
    ).toEqual({
      status: "success",
      assetId: "kg123",
      alt: "A volcano erupting",
      width: undefined,
      height: undefined,
    });
  });

  test("passes the real pixel size through so the element is sized to the image", () => {
    expect(
      resolveGenerateResult(
        { status: "generated", storageId: "kg9", width: 1408, height: 768 },
        "a wide banner",
      ),
    ).toEqual({
      status: "success",
      assetId: "kg9",
      alt: "A wide banner",
      width: 1408,
      height: 768,
    });
  });

  test("surfaces the backend's kid-readable error and leaves the deck untouched", () => {
    expect(
      resolveGenerateResult(
        {
          status: "error",
          error: "I couldn't make that picture. Try again.",
        },
        "a volcano",
      ),
    ).toEqual({
      status: "error",
      message: "I couldn't make that picture. Try again.",
    });
  });

  test("falls back to a generic message when the failure carries none", () => {
    expect(resolveGenerateResult({ status: "error", error: "" }, "a volcano")).toEqual({
      status: "error",
      message: MAKE_PICTURE_COPY.errorFallback,
    });
    expect(
      resolveGenerateResult({ status: "error", error: "   " }, "a volcano"),
    ).toEqual({
      status: "error",
      message: MAKE_PICTURE_COPY.errorFallback,
    });
  });

});

describe("placeholderFrameForSlot", () => {
  test("slot 0 sits exactly on the shared image preset box", () => {
    expect(placeholderFrameForSlot(0)).toEqual({
      x: IMAGE_PRESET.x,
      y: IMAGE_PRESET.y,
      w: IMAGE_PRESET.w,
      h: IMAGE_PRESET.h,
      rotation: 0,
    });
  });

  test("cascades each concurrent placeholder down-and-right so they don't stack", () => {
    const first = placeholderFrameForSlot(0);
    const second = placeholderFrameForSlot(1);
    expect(second.x).toBe(first.x + PLACEHOLDER_CASCADE_STEP);
    expect(second.y).toBe(first.y + PLACEHOLDER_CASCADE_STEP);
    // Same box size — only the origin cascades.
    expect(second.w).toBe(first.w);
    expect(second.h).toBe(first.h);
  });

  test("clamps a far slot inside the canvas rather than running off the edge", () => {
    const frame = placeholderFrameForSlot(1000);
    expect(frame.x).toBe(CANVAS_W - IMAGE_PRESET.w);
    expect(frame.y).toBe(CANVAS_H - IMAGE_PRESET.h);
    expect(frame.x + frame.w).toBeLessThanOrEqual(CANVAS_W);
    expect(frame.y + frame.h).toBeLessThanOrEqual(CANVAS_H);
  });
});

describe("resolvedImageFrame", () => {
  const centreOf = (f: { x: number; y: number; w: number; h: number }) => ({
    cx: f.x + f.w / 2,
    cy: f.y + f.h / 2,
  });

  test("fits a wide image to its real aspect (no letterbox) and centres it on the placeholder", () => {
    const placeholder = placeholderFrameForSlot(0);
    const frame = resolvedImageFrame(placeholder, 1408, 768);
    const fitted = imageFrameForSize(1408, 768);
    // Sized by the shared fit helper — the letterbox fix.
    expect(frame.w).toBe(fitted.w);
    expect(frame.h).toBe(fitted.h);
    expect(frame.h).toBeLessThan(placeholder.h);
    // Lands where the spinner was, not snapped back to the preset centre.
    const a = centreOf(placeholder);
    const b = centreOf(frame);
    expect(Math.abs(a.cx - b.cx)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.cy - b.cy)).toBeLessThanOrEqual(1);
  });

  test("a cascaded placeholder keeps its offset centre when the image lands", () => {
    const placeholder = placeholderFrameForSlot(2);
    const frame = resolvedImageFrame(placeholder, 512, 512);
    const a = centreOf(placeholder);
    const b = centreOf(frame);
    expect(Math.abs(a.cx - b.cx)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.cy - b.cy)).toBeLessThanOrEqual(1);
  });

  test("unknown pixel size falls back to the placeholder's own frame", () => {
    const placeholder = placeholderFrameForSlot(1);
    expect(resolvedImageFrame(placeholder)).toEqual(placeholder);
    expect(resolvedImageFrame(placeholder, 0, 0)).toEqual(placeholder);
  });
});
