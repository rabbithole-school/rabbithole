import { describe, expect, it } from "vitest";

import { shouldRenderSlideImage } from "./slideImageFallback";

describe("shouldRenderSlideImage", () => {
  it("uses the labelled placeholder after a resolved URL fails", () => {
    const source = "https://storage.example.test/expired";

    expect(shouldRenderSlideImage(source, source)).toBe(false);
  });

  it("retries when the same asset resolves to a fresh URL", () => {
    expect(
      shouldRenderSlideImage(
        "https://storage.example.test/fresh",
        "https://storage.example.test/expired",
      ),
    ).toBe(true);
  });

  it("uses the existing placeholder while an asset is unresolved", () => {
    expect(shouldRenderSlideImage(null, null)).toBe(false);
  });
});
