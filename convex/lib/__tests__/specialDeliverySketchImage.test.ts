import { describe, expect, test } from "vitest";
import { normalizeSketchPixels } from "../specialDeliverySketchImage";

describe("normalizeSketchPixels", () => {
  test("makes near-white and colored paper backgrounds pure white", () => {
    const pixels = new Uint8Array([
      235, 225, 205, 255, // warm cream
      215, 220, 225, 128, // cool gray with alpha
    ]);

    expect(Array.from(normalizeSketchPixels(pixels))).toEqual([
      255, 255, 255, 255, 255, 255, 255, 255,
    ]);
  });

  test("makes linework neutral, opaque, and high-contrast", () => {
    const pixels = new Uint8Array([
      80, 90, 100, 255, // dark colored stroke
      180, 180, 180, 255, // antialiased light edge
    ]);

    const normalized = normalizeSketchPixels(pixels);
    expect(normalized[0]).toBe(normalized[1]);
    expect(normalized[1]).toBe(normalized[2]);
    expect(normalized[0]).toBeLessThan(110);
    expect(normalized[4]).toBe(normalized[5]);
    expect(normalized[5]).toBe(normalized[6]);
    expect(normalized[4]).toBeLessThan(170);
    expect(normalized[3]).toBe(255);
    expect(normalized[7]).toBe(255);
  });
});
