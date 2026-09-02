/**
 * The letterbox fix: a slide image element must be sized to the picture it
 * holds, not to a fixed preset box.
 *
 * Andy spotted white bands above and below a generated illustration. Cause: the
 * shared NEW_ELEMENT_PRESETS.image frame is a fixed 500x380 and the canvas
 * draws images with `object-fit: contain`, so a 1408x768 image fitted to width
 * and left ~53px ofwhite space top and bottom. These tests pin both halves of the
 * fix — reading the real pixel size, and fitting a frame to it.
 */
import { describe, expect, test } from "vitest";
import { readImageSize } from "../lib/imageBytes";
import {
  imageFrameForSize,
  NEW_ELEMENT_PRESETS,
  nextCascadeSlot,
  placeholderFrameForSlot,
} from "../../shared/slidesScene";

/** Minimal PNG header: signature + IHDR length/type + width + height. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Minimal JPEG: SOI, a skippable APP0, then an SOF0 carrying the size. */
function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xe0], 2);
  // A segment's length field COUNTS ITSELF, so 2 means "no payload" and the
  // next marker begins immediately after it.
  view.setUint16(4, 2);
  bytes.set([0xff, 0xc0], 6); // SOF0
  view.setUint16(8, 11);
  bytes[10] = 8; // sample precision
  view.setUint16(11, height);
  view.setUint16(13, width);
  return bytes;
}

describe("readImageSize", () => {
  test("reads PNG dimensions — the real generated case", () => {
    expect(readImageSize(pngHeader(1408, 768))).toEqual({
      width: 1408,
      height: 768,
    });
  });

  test("reads JPEG dimensions past a skippable segment", () => {
    expect(readImageSize(jpegHeader(640, 480))).toEqual({
      width: 640,
      height: 480,
    });
  });

  test("returns null for bytes that are not a readable image", () => {
    expect(readImageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    // Truncated PNG: the signature matches but IHDR is not there yet.
    expect(readImageSize(pngHeader(10, 10).slice(0, 12))).toBeNull();
  });
});

describe("imageFrameForSize", () => {
  const preset = NEW_ELEMENT_PRESETS.image("").frame;

  test("a wide image gets a frame with the image's aspect, not the preset's", () => {
    const frame = imageFrameForSize(1408, 768);
    // The defect: 500x380 (1.316) around a 1.833 image left white bands.
    expect(frame.w / frame.h).toBeCloseTo(1408 / 768, 2);
    expect(frame.h).toBeLessThan(preset.h);
  });

  test("the fitted frame never exceeds the preset box", () => {
    for (const [w, h] of [[1408, 768], [768, 1408], [1024, 1024], [4000, 10]]) {
      const frame = imageFrameForSize(w, h);
      expect(frame.w).toBeLessThanOrEqual(preset.w);
      expect(frame.h).toBeLessThanOrEqual(preset.h);
    }
  });

  test("stays centred on the preset box so the image lands where the placeholder was", () => {
    const frame = imageFrameForSize(1408, 768);
    // Frames are integers, so a half-pixel offset is expected and invisible.
    expect(Math.abs(frame.x + frame.w / 2 - (preset.x + preset.w / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.y + frame.h / 2 - (preset.y + preset.h / 2))).toBeLessThanOrEqual(1);
  });

  test("falls back to the preset box when the size is unknown or nonsense", () => {
    expect(imageFrameForSize(0, 0)).toEqual({ ...preset });
    expect(imageFrameForSize(-5, 100)).toEqual({ ...preset });
  });
});

describe("nextCascadeSlot", () => {
  test("a second picture made AFTER the first finished does not stack on it", () => {
    // The live bug: with no placeholder in flight, the slot freed and the next
    // generation reused slot 0, landing pixel-for-pixel on the previous image.
    const slot = nextCascadeSlot([], 1);
    expect(slot).toBe(1);
    expect(placeholderFrameForSlot(slot)).not.toEqual(placeholderFrameForSlot(0));
  });

  test("still avoids slots held by generations that are in flight", () => {
    expect(nextCascadeSlot([0, 1], 0)).toBe(2);
    // In-flight and existing images are both occupied.
    expect(nextCascadeSlot([2], 2)).toBe(3);
  });

  test("an empty slide with nothing in flight starts at the first slot", () => {
    expect(nextCascadeSlot([], 0)).toBe(0);
  });

  test("fills a gap left by a finished generation before growing the cascade", () => {
    expect(nextCascadeSlot([2], 0)).toBe(0);
  });
});
