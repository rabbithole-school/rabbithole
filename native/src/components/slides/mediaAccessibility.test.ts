import { describe, expect, test } from "vitest";

import { mediaAccessibility } from "./mediaAccessibility";

describe("mediaAccessibility", () => {
  test("handles a resolved image with whitespace-only alt text", () => {
    expect(mediaAccessibility(" \n\t ", true, "image", "resolved")).toEqual({
      alt: "",
      imageAlt: "",
      ariaHidden: true,
      accessibilityLabel: undefined,
      fallbackLabel: "Image",
    });
  });

  test("uses a trimmed label for an image fallback", () => {
    expect(mediaAccessibility("  A mountain  ", true, "image", "fallback")).toEqual({
      alt: "A mountain",
      imageAlt: "A mountain",
      ariaHidden: false,
      accessibilityLabel: "A mountain",
      fallbackLabel: "A mountain",
    });
  });

  test("uses the default label for a resolved video with whitespace-only alt text", () => {
    expect(mediaAccessibility(" \t ", true, "video", "resolved")).toEqual({
      alt: "",
      imageAlt: "",
      ariaHidden: undefined,
      accessibilityLabel: "Video. Play",
      fallbackLabel: "Video",
    });
  });

  test("uses a trimmed label for a video fallback", () => {
    expect(mediaAccessibility("  A waterfall  ", true, "video", "fallback")).toEqual({
      alt: "A waterfall",
      imageAlt: "",
      ariaHidden: undefined,
      accessibilityLabel: "A waterfall",
      fallbackLabel: "A waterfall",
    });
  });

  test("omits accessibility labels when media accessibility is disabled", () => {
    expect(mediaAccessibility("A mountain", false, "image", "resolved")).toEqual({
      alt: "A mountain",
      imageAlt: "",
      ariaHidden: true,
      accessibilityLabel: undefined,
      fallbackLabel: "A mountain",
    });
    expect(mediaAccessibility("A waterfall", false, "video", "fallback")).toMatchObject({
      accessibilityLabel: undefined,
      fallbackLabel: "A waterfall",
    });
  });
});
