import { describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { assertTransparentBackdrop, downscaleTransparentPng } from "../lib/spriteImage";

/**
 * What the image model now hands us: an opaque red square on REAL
 * transparency, not on a chroma screen. The transparent pixels deliberately
 * keep a loud green RGB — a real model PNG carries arbitrary colour under
 * alpha 0, and a naive box average would smear it into the sprite's rim.
 * That is the regression this file exists to catch.
 */
function transparentCanvasWithRedSquare(size: number): Uint8Array {
  const png = new PNG({ width: size, height: size });
  const d = png.data;
  const q = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inSquare = x >= q && x < size - q && y >= q && y < size - q;
      d[i] = inSquare ? 220 : 0;
      d[i + 1] = inSquare ? 30 : 177;
      d[i + 2] = inSquare ? 30 : 64;
      d[i + 3] = inSquare ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

const px = (png: PNG, x: number, y: number) => {
  const i = (y * png.width + x) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3] };
};

/** What a model that ignored the no-backdrop instruction returns: a fully
 *  opaque painted tile. Valid alpha-wise, unusable as a sprite. */
function opaqueTile(size: number): Uint8Array {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 90;
    png.data[i + 1] = 140;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("assertTransparentBackdrop", () => {
  test("accepts a centred sprite on transparency", () => {
    expect(() =>
      assertTransparentBackdrop(transparentCanvasWithRedSquare(64)),
    ).not.toThrow();
  });

  test("rejects a painted backdrop the model drew into the alpha", () => {
    // `background: "transparent"` guarantees an alpha channel, not that the
    // model left it empty — this is the guard that keeps a solid rectangle out
    // of the flair chip row.
    expect(() => assertTransparentBackdrop(opaqueTile(64))).toThrow(
      /painted backdrop/i,
    );
  });

  test("tolerates a sprite that grazes the frame", () => {
    // A few opaque border pixels are bleed, not a backdrop; only a wholesale
    // fill should fail.
    const png = PNG.sync.read(Buffer.from(transparentCanvasWithRedSquare(64)));
    for (let x = 0; x < 4; x++) png.data[x * 4 + 3] = 255;
    expect(() => assertTransparentBackdrop(PNG.sync.write(png))).not.toThrow();
  });
});

describe("downscaleTransparentPng", () => {
  test("treats a non-positive cap as no cap, never a 1x1 pixel", () => {
    const input = transparentCanvasWithRedSquare(64);
    expect(downscaleTransparentPng(input, 0)).toBe(input);
    expect(downscaleTransparentPng(input, -8)).toBe(input);
  });

  test("caps the longer edge and preserves the square aspect", () => {
    const out = PNG.sync.read(
      Buffer.from(downscaleTransparentPng(transparentCanvasWithRedSquare(512), 64)),
    );
    expect(Math.max(out.width, out.height)).toBe(64);
    expect(out.width).toBe(out.height);
  });

  test("returns the input untouched when it already fits under the cap", () => {
    const input = transparentCanvasWithRedSquare(48);
    const out = downscaleTransparentPng(input, 256);
    expect(out).toBe(input);
  });

  test("premultiplied downscale leaves NO colour fringe on the sprite edge", () => {
    const out = PNG.sync.read(
      Buffer.from(downscaleTransparentPng(transparentCanvasWithRedSquare(512), 64)),
    );
    // The background stays fully transparent.
    expect(px(out, 0, 0).a).toBe(0);
    // The sprite core stays opaque and red-dominant.
    const core = px(out, 32, 32);
    expect(core.a).toBeGreaterThan(200);
    expect(core.r).toBeGreaterThan(core.g);
    // Every partially-transparent EDGE pixel must blend red→clear rather than
    // pick up the green that was hiding under alpha 0.
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const p = px(out, x, y);
        if (p.a === 0 || p.a === 255) continue;
        expect(p.g).toBeLessThan(p.r);
      }
    }
  });
});
