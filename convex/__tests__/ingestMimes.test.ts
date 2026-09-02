import { describe, expect, test } from "vitest";
import {
  INGESTIBLE_MIMES,
  isIngestibleMime,
  imageMediaType,
} from "../lib/ingestMimes";

describe("ingestMimes — single source of truth for scanner-pipeline types", () => {
  test("accepts PDF and the four Claude-supported image types", () => {
    for (const mime of [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]) {
      expect(isIngestibleMime(mime)).toBe(true);
    }
  });

  // Regression: HEIC/HEIF were previously in the upload allow-list but
  // unhandled by imageMediaType, so every iPhone .heic upload passed the gate
  // and then failed extraction (sent to Claude mislabeled as a PDF).
  test("rejects HEIC/HEIF and other types the pipeline can't read", () => {
    for (const mime of [
      "image/heic",
      "image/heif",
      "image/tiff",
      "image/bmp",
      "image/svg+xml",
      "application/zip",
      "text/plain",
      undefined,
      null,
    ]) {
      expect(isIngestibleMime(mime)).toBe(false);
    }
  });

  // The watch path and the upload/pick path must agree on what's ingestible,
  // and that set must equal PDF + exactly the image types imageMediaType maps.
  // If these ever drift, a file can pass the gate and then fail extraction.
  test("every ingestible image type maps to a Claude media_type", () => {
    for (const mime of INGESTIBLE_MIMES) {
      if (mime === "application/pdf") {
        expect(imageMediaType(mime)).toBeNull();
      } else {
        expect(imageMediaType(mime)).toBe(mime);
      }
    }
  });

  test("imageMediaType returns null for non-image / unsupported types", () => {
    expect(imageMediaType("application/pdf")).toBeNull();
    expect(imageMediaType("image/heic")).toBeNull();
    expect(imageMediaType("image/tiff")).toBeNull();
  });
});
