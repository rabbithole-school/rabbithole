import { describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { removeChromaScreen, removeGreenScreen } from "../lib/chromaImage";

// A flat chroma-green canvas (#00B140) with an opaque red square in the middle
// that does NOT touch the border — the classic keyed-sprite shape. Encoded to
// PNG bytes, the form removeGreenScreen actually consumes.
function greenCanvasWithRedSquare(size: number): Uint8Array {
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
      d[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function blueCanvasWithGreenRing(size: number): Uint8Array {
  const png = new PNG({ width: size, height: size });
  const d = png.data;
  const q = size / 4;
  const center = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inSquare = x >= q && x < size - q && y >= q && y < size - q;
      const enclosedBlue = x === center && y === center;
      d[i] = inSquare && !enclosedBlue ? 44 : 0;
      d[i + 1] = inSquare && !enclosedBlue ? 190 : 71;
      d[i + 2] = inSquare && !enclosedBlue ? 76 : 187;
      d[i + 3] = 255;
    }

  }
  return PNG.sync.write(png);
}

function greenCanvasWithRedSquareAndBlueDebris(size: number): Uint8Array {
  const png = PNG.sync.read(Buffer.from(greenCanvasWithRedSquare(size)));
  for (let y = 2; y < 4; y++) {
    for (let x = size - 4; x < size - 2; x++) {
      const i = (y * size + x) * 4;
      png.data[i] = 20;
      png.data[i + 1] = 80;
      png.data[i + 2] = 210;
      png.data[i + 3] = 255;
    }

  }
  return PNG.sync.write(png);
}

function redCanvasWithTealSquare(size: number): Uint8Array {
  const png = new PNG({ width: size, height: size });
  const q = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inSquare = x >= q && x < size - q && y >= q && y < size - q;
      png.data[i] = inSquare ? 20 : 255;
      png.data[i + 1] = inSquare ? 130 : 0;
      png.data[i + 2] = inSquare ? 145 : 0;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function whiteCanvasWithMagentaTile(size: number): Uint8Array {
  const png = new PNG({ width: size, height: size });
  const q = size / 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inTile = x >= q && x < size - q && y >= q && y < size - q;
      png.data[i] = inTile ? 254 : 255;
      png.data[i + 1] = inTile ? 37 : 255;
      png.data[i + 2] = inTile ? 252 : 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const px = (png: PNG, x: number, y: number) => {
  const i = (y * png.width + x) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3] };
};

describe("removeGreenScreen — maxDim downscale", () => {
  test("caps the longer edge and preserves the square aspect", () => {
    const out = PNG.sync.read(
      Buffer.from(removeGreenScreen(greenCanvasWithRedSquare(512), { maxDim: 64 })),
    );
    expect(Math.max(out.width, out.height)).toBe(64);
    expect(out.width).toBe(out.height);
  });

  test("no downscale when the image already fits under the cap", () => {
    const out = PNG.sync.read(
      Buffer.from(removeGreenScreen(greenCanvasWithRedSquare(48), { maxDim: 256 })),
    );
    expect(out.width).toBe(48);
  });

  test("omitting maxDim keeps native resolution", () => {
    const out = PNG.sync.read(
      Buffer.from(removeGreenScreen(greenCanvasWithRedSquare(256))),
    );
    expect(out.width).toBe(256);
  });

  test("premultiplied downscale leaves NO green fringe on the sprite edge", () => {
    const out = PNG.sync.read(
      Buffer.from(removeGreenScreen(greenCanvasWithRedSquare(512), { maxDim: 64 })),
    );
    // The background (corner) is fully transparent.
    expect(px(out, 0, 0).a).toBe(0);
    // The sprite core is opaque and red-dominant.
    const core = px(out, 32, 32);
    expect(core.a).toBeGreaterThan(200);
    expect(core.r).toBeGreaterThan(core.g);
    // Every partially-transparent EDGE pixel must blend red→clear, never pick up
    // the keyed-out green (which a straight box average would bleed in). Guard:
    // no opaque-ish pixel is green-dominant.
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const p = px(out, x, y);
        if (p.a > 20) {
          expect(p.g).toBeLessThanOrEqual(p.r + 8);
        }
      }
    }
  });

  test("threads global blue options through both public names", () => {
    const input = blueCanvasWithGreenRing(20);
    const options = { mode: "global", screen: "blue" } as const;
    const named = removeGreenScreen(input, options);
    const alias = removeChromaScreen(input, options);
    const out = PNG.sync.read(Buffer.from(named));

    expect(named).toEqual(alias);
    expect(px(out, 0, 0).a).toBe(0);
    expect(px(out, 6, 6)).toEqual({ r: 44, g: 190, b: 76, a: 255 });
    expect(px(out, 10, 10).a).toBe(0);
  });

  test("optionally removes tiny disconnected non-screen debris", () => {
    const input = greenCanvasWithRedSquareAndBlueDebris(32);
    const preserved = PNG.sync.read(Buffer.from(removeGreenScreen(input)));
    const cleaned = PNG.sync.read(
      Buffer.from(
        removeGreenScreen(input, {
          minAlphaComponentFraction: 0.01,
        }),
      ),
    );
    expect(px(preserved, 29, 2).a).toBe(255);
    expect(px(cleaned, 29, 2).a).toBe(0);
    expect(px(cleaned, 16, 16).a).toBe(255);
  });

  test("supports a red screen for blue-green subjects", () => {
    const out = PNG.sync.read(
      Buffer.from(
        removeChromaScreen(redCanvasWithTealSquare(24), {
          mode: "global",
          screen: "red",
        }),
      ),
    );
    expect(px(out, 0, 0).a).toBe(0);
    expect(px(out, 12, 12)).toEqual({ r: 20, g: 130, b: 145, a: 255 });
  });

  test("rejects a generated app tile that retains the magenta screen", () => {
    expect(() =>
      removeChromaScreen(whiteCanvasWithMagentaTile(32), {
        screen: "magenta",
        requireTransparentBackdrop: true,
      }),
    ).toThrow("Chroma-key output retained the screen color");
  });

  test("accepts a clean transparent sprite when backdrop validation is required", () => {
    expect(() =>
      removeChromaScreen(greenCanvasWithRedSquare(32), {
        requireTransparentBackdrop: true,
      }),
    ).not.toThrow();
  });
});
