import { describe, expect, test } from "vitest";

import {
  base64ToBytes,
  imageBytesToContentPart,
  isIntactImage,
  MAX_MODEL_IMAGE_BYTES,
} from "../lib/imageBytes";

/** A minimal JPEG header. JPEG gets no integrity check (see isIntactImage). */
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

/** Real, decodable 2x2 images. */
const VALID_PNG = base64ToBytes(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM8EaDBwMDAxAAGAA/KAUR0s/I7AAAAAElFTkSuQmCC",
);
const VALID_WEBP = base64ToBytes(
  "UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+6Di/+YJX5Bu1D/7B384D84D+igAA",
);
const VALID_GIF = base64ToBytes(
  "R0lGODdhAgACAIEAAMhQKAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7",
);

/**
 * The exact bytes a hotlink-blocked search_image result stored in production
 * (2026-09-21): a 1x1 PNG whose IDAT CRC and zlib checksum are both wrong.
 * Anthropic answers it with "Could not process image".
 */
const HOTLINK_PLACEHOLDER_PNG = base64ToBytes(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sXsdrgAAAAASUVORK5CYII=",
);

function bytesWith(magic: number[], totalLength = 64): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  bytes.set(magic, 0);
  return bytes;
}

describe("imageBytesToContentPart", () => {
  // This is the seam that lets the tutor LOOK at a picture search_image found
  // before it describes it. Without it the model can only narrate its hopes,
  // which is the exact confidently-wrong failure the tool exists to prevent.
  test("builds an Anthropic base64 image block", () => {
    const part = imageBytesToContentPart(VALID_PNG);
    expect(part).not.toBeNull();
    expect(part?.type).toBe("image");
    expect(part?.source.type).toBe("base64");
    expect(typeof part?.source.data).toBe("string");
    expect(part?.source.data.length).toBeGreaterThan(0);
  });

  test("sniffs the real MIME rather than trusting the caller", () => {
    // A Blob's `type` and a content-type header are both frequently wrong or
    // absent on the open web, and Anthropic rejects a block whose declared
    // type does not match its payload — so the magic bytes are the ONLY
    // source of truth. No caller can override them.
    expect(imageBytesToContentPart(VALID_PNG)?.source.media_type)
      .toBe("image/png");
    expect(imageBytesToContentPart(bytesWith(JPEG_MAGIC))?.source.media_type)
      .toBe("image/jpeg");
  });

  test("refuses bytes that are not a supported raster type", () => {
    // The live bug this guards against: a real search_image call for a sucrose
    // diagram returned an SVG, which has no raster magic-byte signature. The
    // old code declared it image/jpeg anyway on the strength of the response's
    // content-type header, Anthropic 400'd the ENTIRE request, and the tutor's
    // reply died mid-turn with no text at all. Web results for chemistry and
    // biology diagrams are routinely SVG, so this is the common path, not a
    // corner. Null lets the caller degrade to text, exactly like oversize.
    expect(imageBytesToContentPart(new Uint8Array(32))).toBeNull();

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(imageBytesToContentPart(svg)).toBeNull();
  });

  test("refuses an image too large to send", () => {
    // Anthropic caps a base64 image at 5 MB and base64 inflates by 4/3, so an
    // oversize block fails the WHOLE request. Returning null lets the caller
    // degrade to text instead of killing the tutor's turn mid-sentence.
    const huge = new Uint8Array(MAX_MODEL_IMAGE_BYTES + 1);
    huge.set(JPEG_MAGIC, 0);
    expect(imageBytesToContentPart(huge)).toBeNull();
  });

  test("accepts an image exactly at the ceiling", () => {
    const atLimit = new Uint8Array(MAX_MODEL_IMAGE_BYTES);
    atLimit.set(JPEG_MAGIC, 0);
    expect(imageBytesToContentPart(atLimit)).not.toBeNull();
  });

  test("stays under Anthropic's 5 MB wire limit once base64-encoded", () => {
    // The ceiling is only correct if the ENCODED size fits; base64 is what
    // actually travels. Guards against someone raising the raw limit without
    // redoing the 4/3 arithmetic.
    const atLimit = new Uint8Array(MAX_MODEL_IMAGE_BYTES);
    atLimit.set(JPEG_MAGIC, 0);
    const part = imageBytesToContentPart(atLimit);
    expect(part?.source.data.length).toBeLessThan(5_000_000);
  });
});

describe("isIntactImage", () => {
  // Anthropic 400s the whole request on an undecodable image, and image rows
  // replay into every later turn — so one corrupt picture silences a session
  // permanently. Each case below was checked against the live API.
  test("accepts real images of every checked type", () => {
    expect(isIntactImage(VALID_PNG)).toBe(true);
    expect(isIntactImage(VALID_WEBP)).toBe(true);
    expect(isIntactImage(VALID_GIF)).toBe(true);
  });

  test("rejects the hotlink placeholder that silenced a session", () => {
    expect(isIntactImage(HOTLINK_PLACEHOLDER_PNG)).toBe(false);
    expect(imageBytesToContentPart(HOTLINK_PLACEHOLDER_PNG)).toBeNull();
  });

  test("rejects a truncated PNG", () => {
    expect(isIntactImage(VALID_PNG.subarray(0, VALID_PNG.length - 12))).toBe(false);
    expect(isIntactImage(VALID_PNG.subarray(0, 40))).toBe(false);
  });

  test("rejects a PNG whose chunk CRC does not match", () => {
    const flipped = VALID_PNG.slice();
    flipped[40] ^= 0xff; // inside the IDAT payload
    expect(isIntactImage(flipped)).toBe(false);
  });

  test("rejects a truncated WebP", () => {
    expect(isIntactImage(VALID_WEBP.subarray(0, 40))).toBe(false);
  });

  test("judges a GIF by whether its first frame is complete", () => {
    // Measured live: cut inside the first frame is rejected; missing only the
    // trailer (or anything after a complete first frame) is decoded fine.
    expect(isIntactImage(VALID_GIF.subarray(0, 30))).toBe(false);
    expect(isIntactImage(VALID_GIF.subarray(0, VALID_GIF.length - 1))).toBe(true);
    expect(isIntactImage(new Uint8Array([...VALID_GIF, 0, 0, 0]))).toBe(true);
    expect(isIntactImage(new Uint8Array([0x47, 0x49, 0x3b]))).toBe(false);
  });

  test("leaves JPEG alone, because the API decodes a truncated one", () => {
    expect(isIntactImage(bytesWith(JPEG_MAGIC))).toBe(true);
  });
});
