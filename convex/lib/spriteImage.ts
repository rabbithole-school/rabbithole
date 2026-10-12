"use node";

// Sprite post-processing for the generative art layers (quest badges,
// manipulative theme icons, world species sprites, earned flair).
//
// This module used to own a chroma keyer: the image model could not emit an
// alpha channel, so every sprite was rendered on a flat green (or magenta)
// screen and stripped here — with island removal and backdrop-rejection
// heuristics to catch the cases where the model painted a scene anyway.
// GPT-Image-2.5 returns real, antialiased alpha (convex/lib/openaiImage.ts), so
// all of that is gone and only the size cap remains. PNG decode + re-encode
// needs Node's zlib via pngjs, so importers are "use node" actions.

import { PNG } from "pngjs";

/**
 * Reject a sprite that arrived with a PAINTED backdrop.
 *
 * `background: "transparent"` makes the API hand back an alpha channel, but it
 * cannot stop the MODEL from drawing an opaque panel, tile, or card that fills
 * the canvas — and that art is then perfectly valid alpha-wise while being
 * unusable as a sprite. The prompts forbid it; this is the enforcement, and it
 * replaces the `requireTransparentBackdrop` option the deleted chroma keyer
 * carried for exactly this failure.
 *
 * The test is the 1px border ring: a real sprite is centred with a margin, so
 * its border is ~100% clear, while a painted tile's border is ~100% opaque.
 * Throws; callers decide whether that fails the row.
 */
export function assertTransparentBackdrop(
  bytes: Uint8Array,
  { maxOpaqueBorderFraction = 0.1 }: { maxOpaqueBorderFraction?: number } = {},
): void {
  const png = PNG.sync.read(Buffer.from(bytes));
  const alphaAt = (x: number, y: number) => png.data[(y * png.width + x) * 4 + 3];
  let border = 0;
  let opaque = 0;
  const tally = (x: number, y: number) => {
    border += 1;
    if (alphaAt(x, y) > 16) opaque += 1;
  };
  for (let x = 0; x < png.width; x++) {
    tally(x, 0);
    if (png.height > 1) tally(x, png.height - 1);
  }
  for (let y = 1; y < png.height - 1; y++) {
    tally(0, y);
    if (png.width > 1) tally(png.width - 1, y);
  }
  if (border === 0) return;
  const fraction = opaque / border;
  if (fraction > maxOpaqueBorderFraction) {
    throw new Error(
      `Generated sprite has a painted backdrop (${(fraction * 100).toFixed(0)}% of its border is opaque)`,
    );
  }
}

/**
 * Downscale a transparent RGBA PNG to a longer-edge cap, preserving its art.
 *
 * The image model emits ~1024px, which is right for a badge shown large but
 * 16–32x oversized for a sprite tiled at ~30–64px — a needless hundreds-of-KB
 * download that stalls first paint and whose detail is invisible anyway.
 * Returns the input unchanged when it already fits under the cap.
 */
export function downscaleTransparentPng(
  bytes: Uint8Array,
  maxDim: number,
): Uint8Array {
  const png = PNG.sync.read(Buffer.from(bytes));
  // A non-positive cap means "no cap". Without this it would scale every image
  // down to a 1x1 pixel, since the dimensions are clamped to a minimum of 1.
  if (!(maxDim > 0)) return bytes;
  if (Math.max(png.width, png.height) <= maxDim) return bytes;
  const scaled = downscaleRgbaPremultiplied(png.data, png.width, png.height, maxDim);
  const out = new PNG({ width: scaled.width, height: scaled.height });
  out.data = Buffer.from(scaled.data);
  return PNG.sync.write(out);
}

/**
 * Area-average downscale of an RGBA buffer with a longer-edge cap, using
 * PREMULTIPLIED alpha. A transparent pixel still carries RGB, so a plain box
 * average would bleed that invisible colour into the sprite rim; premultiplying
 * weights each pixel's colour by its own alpha, so a fully transparent pixel
 * contributes nothing. Un-premultiplying at the end restores straight-alpha
 * RGBA (what PNG stores), with a clean anti-aliased edge.
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
