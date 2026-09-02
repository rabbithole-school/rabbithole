import { describe, expect, test } from "vitest";

import {
  FIND_IMAGE_COPY,
  FIND_IMAGE_MAX_QUERY,
  canSubmitImageSearch,
  deriveFoundImageAlt,
} from "./findImage";

describe("FIND_IMAGE_COPY", () => {
  test("uses the 'image' noun and the 'Find' verb, never picture/photo", () => {
    expect(FIND_IMAGE_COPY.action).toBe("Find an image");
    // "image" everywhere (Andy, 2026-08-25) — the source never says picture/photo.
    for (const value of Object.values(FIND_IMAGE_COPY)) {
      expect(value.toLowerCase()).not.toContain("picture");
      expect(value.toLowerCase()).not.toContain("photo");
    }
  });

  test("carries every folded search state's copy", () => {
    expect(FIND_IMAGE_COPY.busy).toBeTruthy();
    expect(FIND_IMAGE_COPY.empty).toBeTruthy();
    expect(FIND_IMAGE_COPY.capped).toBeTruthy();
    expect(FIND_IMAGE_COPY.unavailable).toBeTruthy();
    expect(FIND_IMAGE_COPY.errorFallback).toBeTruthy();
    expect(FIND_IMAGE_COPY.insertErrorFallback).toBeTruthy();
  });
});

describe("canSubmitImageSearch", () => {
  test("blocks an empty or whitespace-only query", () => {
    expect(canSubmitImageSearch("", false)).toBe(false);
    expect(canSubmitImageSearch("   ", false)).toBe(false);
  });

  test("allows a real query when idle", () => {
    expect(canSubmitImageSearch("saturn v rocket", false)).toBe(true);
  });

  test("blocks while a search is already in flight (double-submit is a no-op)", () => {
    expect(canSubmitImageSearch("saturn v rocket", true)).toBe(false);
  });
});

describe("deriveFoundImageAlt", () => {
  test("captions the image with the scholar's query", () => {
    expect(deriveFoundImageAlt("saturn v rocket launch")).toBe(
      "Saturn v rocket launch",
    );
  });

  test("falls back to the shared alt for an empty query, never a bare image", () => {
    expect(deriveFoundImageAlt("")).toBe(FIND_IMAGE_COPY.altFallback);
    expect(deriveFoundImageAlt("   \n\t ")).toBe(FIND_IMAGE_COPY.altFallback);
  });

  test("caps a long query the same way a generation prompt is capped", () => {
    const long = "x".repeat(FIND_IMAGE_MAX_QUERY + 50);
    // Capped to the shared alt limit (a caption, not a paragraph).
    expect(deriveFoundImageAlt(long).length).toBeLessThanOrEqual(120);
  });
});
