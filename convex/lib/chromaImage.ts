"use node";

// Shared image post-processing for the generative art layers (quest badges +
// manipulative theme icons). The image model can't emit a true alpha channel,
// so generated assets are rendered on a flat chroma screen and stripped here to
// real transparency. PNG/JPEG decode + re-encode needs Node's
// zlib via pngjs, so importers are "use node" actions.

import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { keyOutGreen, type KeyOptions } from "./badgeChroma";

export type RemoveChromaScreenOptions = KeyOptions & {
  /**
   * Cap the longer edge of the output at this many pixels (area-averaged
   * downscale, aspect preserved). Omit to keep the model's native resolution.
   *
   * The image model emits ~1024px, which is right for a badge shown large but
   * ~16–32× oversized for a theme icon tiled at ~30–64px — a needless
   * hundreds-of-KB download that stalls the sprite's first paint and whose
   * detail is invisible anyway. Theme icons pass a small cap; badges don't.
   */
  maxDim?: number;
  /**
   * Remove disconnected opaque islands smaller than this fraction of the source
   * canvas. Useful for generated sprites where the model adds stray rubble or
   * paint flecks that are not screen-colored, so chroma keying alone correctly
   * leaves them behind. Omit to preserve every component (the historical path).
   */
  minAlphaComponentFraction?: number;
  /**
   * Reject output that still has an opaque border or a substantial amount of
   * the requested screen color. Generated sprites can occasionally ignore the
   * flat-screen instruction and draw a chroma-colored app tile on another
   * background; publishing that would expose the key color in the UI.
   */
  requireTransparentBackdrop?: boolean;
};

export type RemoveGreenScreenOptions = RemoveChromaScreenOptions;

/**
 * Backward-compatible green-screen entry point. Defaults preserve the original
 * edge-connected green key exactly; callers that need another chroma strategy
 * should prefer removeChromaScreen.
 */
export function removeGreenScreen(
  bytes: Uint8Array,
  opts: RemoveGreenScreenOptions = {},
): Uint8Array {
  return removeChromaScreen(bytes, opts);
}

/**
 * Decode the model's image (JPEG or PNG — Gemini returns JPEG today) to RGBA,
 * chroma-key the selected screen, optionally downscale to a sprite-sized cap,
 * and re-encode as a transparent PNG. Throws if decode fails; callers decide
 * whether to fall back to the raw bytes.
 */
export function removeChromaScreen(
  bytes: Uint8Array,
  opts: RemoveChromaScreenOptions = {},
): Uint8Array {
  const buf = Buffer.from(bytes);
  const isPng = buf[0] === 0x89 && buf[1] === 0x50; // \x89 P N G
  let width: number;
  let height: number;
  let data: Uint8Array;
  if (isPng) {
    const png = PNG.sync.read(buf);
    width = png.width;
    height = png.height;
    data = png.data;
  } else {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    width = img.width;
    height = img.height;
    data = img.data;
  }
  keyOutGreen(data, width, height, opts);
  const minAlphaComponentFraction = opts.minAlphaComponentFraction;
  if (minAlphaComponentFraction && minAlphaComponentFraction > 0) {
    removeSmallAlphaComponents(
      data,
      width,
      height,
      minAlphaComponentFraction,
    );
  }

  const cap = opts.maxDim;
  if (cap && cap > 0 && Math.max(width, height) > cap) {
    const scaled = downscaleRgbaPremultiplied(data, width, height, cap);
    data = scaled.data;
    width = scaled.width;
    height = scaled.height;
  }
  // Area averaging can leave a new one-pixel alpha island where a removed
  // component's feather met an output sample. Re-apply the same ratio after the
  // resize so the final PNG honors the component-size contract too.
  if (minAlphaComponentFraction && minAlphaComponentFraction > 0) {
    removeSmallAlphaComponents(
      data,
      width,
      height,
      minAlphaComponentFraction,
    );
  }
  if (opts.requireTransparentBackdrop) {
    assertTransparentBackdrop(data, width, height, opts.screen ?? "green");
  }

  const out = new PNG({ width, height });
  out.data = Buffer.from(data);
  return PNG.sync.write(out);
}

function assertTransparentBackdrop(
  data: Uint8Array,
  width: number,
  height: number,
  screen: NonNullable<KeyOptions["screen"]>,
): void {
  const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];
  for (let x = 0; x < width; x++) {
    if (alphaAt(x, 0) > 8 || alphaAt(x, height - 1) > 8) {
      throw new Error("Chroma-key output retained an opaque border");
    }
  }
  for (let y = 0; y < height; y++) {
    if (alphaAt(0, y) > 8 || alphaAt(width - 1, y) > 8) {
      throw new Error("Chroma-key output retained an opaque border");
    }
  }

  let residualScreenPixels = 0;
  const maxResidualScreenPixels = Math.ceil(width * height * 0.005);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 32) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const isScreenColor =
      screen === "magenta"
        ? r > 160 && b > 160 && Math.min(r, b) - g > 60
        : screen === "green"
          ? g > 100 && g - Math.max(r, b) > 50
          : screen === "blue"
            ? b > 100 && b - Math.max(r, g) > 50
            : r > 100 && r - Math.max(g, b) > 50;
    if (isScreenColor) residualScreenPixels += 1;
    if (residualScreenPixels > maxResidualScreenPixels) {
      throw new Error("Chroma-key output retained the screen color");
    }
  }
}

function removeSmallAlphaComponents(
  data: Uint8Array,
  width: number,
  height: number,
  minFraction: number,
): void {
  const minPixels = Math.max(1, Math.ceil(width * height * minFraction));
  const seen = new Uint8Array(width * height);
  const neighbors = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const;
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || data[start * 4 + 3] === 0) continue;
    const component: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const pixel = stack.pop()!;
      component.push(pixel);
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (seen[next] || data[next * 4 + 3] === 0) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (component.length >= minPixels) continue;
    for (const pixel of component) data[pixel * 4 + 3] = 0;
  }
}

/**
 * Downscale an ALREADY-transparent RGBA PNG (one this module keyed earlier) to a
 * longer-edge cap, preserving its exact art — no chroma-key re-run. Use this to
 * shrink assets already cached at native resolution; do NOT feed it a raw
 * green-screen image (that needs removeGreenScreen to strip the background
 * first). Returns the input unchanged when it already fits under the cap.
 */
export function downscaleTransparentPng(
  bytes: Uint8Array,
  maxDim: number,
): Uint8Array {
  const png = PNG.sync.read(Buffer.from(bytes));
  if (Math.max(png.width, png.height) <= maxDim) return bytes;
  const scaled = downscaleRgbaPremultiplied(png.data, png.width, png.height, maxDim);
  const out = new PNG({ width: scaled.width, height: scaled.height });
  out.data = Buffer.from(scaled.data);
  return PNG.sync.write(out);
}

/**
 * Area-average downscale of an RGBA buffer with a longer-edge cap, using
 * PREMULTIPLIED alpha. keyOutGreen leaves background pixels at alpha 0 but keeps
 * their green RGB, so a plain box average would bleed that green into the sprite
 * rim; premultiplying weights each pixel's colour by its own alpha, so fully
 * transparent green contributes nothing. Un-premultiplying at the end restores
 * straight-alpha RGBA (what PNG stores), with a clean anti-aliased edge.
 */
function downscaleRgbaPremultiplied(
  data: Uint8Array,
  width: number,
  height: number,
  maxDim: number,
): { data: Uint8Array; width: number; height: number } {
  const scale = maxDim / Math.max(width, height);
  const dstW = Math.max(1, Math.round(width * scale));
  const dstH = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(dstW * dstH * 4);
  const sx = width / dstW;
  const sy = height / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * sy);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((dy + 1) * sy)));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((dx + 1) * sx)));
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const a = data[i + 3] / 255;
          pr += data[i] * a;
          pg += data[i + 1] * a;
          pb += data[i + 2] * a;
          pa += a;
          count += 1;
        }
      }
      const o = (dy * dstW + dx) * 4;
      if (pa > 0) {
        out[o] = Math.round(pr / pa);
        out[o + 1] = Math.round(pg / pa);
        out[o + 2] = Math.round(pb / pa);
        out[o + 3] = Math.round((pa / count) * 255);
      }
      // else: fully transparent (out stays 0,0,0,0)
    }
  }
  return { data: out, width: dstW, height: dstH };
}
