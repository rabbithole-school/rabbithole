import { describe, expect, test } from "vitest";

import {
  imageBytesToContentPart,
  MAX_MODEL_IMAGE_BYTES,
} from "../lib/imageBytes";

/** Minimal byte headers the MIME sniffer recognizes. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

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
    const part = imageBytesToContentPart(bytesWith(PNG_MAGIC));
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
    expect(imageBytesToContentPart(bytesWith(PNG_MAGIC))?.source.media_type)
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
    huge.set(PNG_MAGIC, 0);
    expect(imageBytesToContentPart(huge)).toBeNull();
  });

  test("accepts an image exactly at the ceiling", () => {
    const atLimit = new Uint8Array(MAX_MODEL_IMAGE_BYTES);
    atLimit.set(PNG_MAGIC, 0);
    expect(imageBytesToContentPart(atLimit)).not.toBeNull();
  });

  test("stays under Anthropic's 5 MB wire limit once base64-encoded", () => {
    // The ceiling is only correct if the ENCODED size fits; base64 is what
    // actually travels. Guards against someone raising the raw limit without
    // redoing the 4/3 arithmetic.
    const atLimit = new Uint8Array(MAX_MODEL_IMAGE_BYTES);
    atLimit.set(PNG_MAGIC, 0);
    const part = imageBytesToContentPart(atLimit);
    expect(part?.source.data.length).toBeLessThan(5_000_000);
  });
});
