/**
 * EXIF orientation for JPEGs: read the tag, and bake it into the pixels.
 *
 * A phone stores a portrait photo as LANDSCAPE pixels plus an EXIF Orientation
 * tag (6 = "rotate 90° clockwise to display"). Viewers disagree about honoring
 * that tag — X ignores it, Instagram honors it (observed 2026-10-08) — and
 * photon's decoder ignores it while its JPEG encoder writes no metadata, so a
 * re-encode silently turns a tagged-portrait photo into an untagged sideways
 * one. The only representation every consumer agrees on is upright pixels with
 * no tag, which is what `convex/slackImageResize.ts` produces with these.
 *
 * Both functions are pure (no photon, no ctx) so they run in either Convex
 * runtime and unit-test directly.
 */

/** EXIF Orientation (1–8) of a JPEG, or 1 when absent/unreadable/not a JPEG. */
export function readJpegExifOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return 1;
    const marker = bytes[p + 1];
    // Start of scan / end of image: metadata segments all precede these.
    if (marker === 0xda || marker === 0xd9) return 1;
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (len < 2) return 1;
    const start = p + 4;
    const end = p + 2 + len;
    if (end > bytes.length) return 1;
    if (
      marker === 0xe1 &&
      len >= 8 &&
      bytes[start] === 0x45 && // "Exif\0\0"
      bytes[start + 1] === 0x78 &&
      bytes[start + 2] === 0x69 &&
      bytes[start + 3] === 0x66 &&
      bytes[start + 4] === 0 &&
      bytes[start + 5] === 0
    ) {
      return orientationFromTiff(bytes.subarray(start + 6, end));
    }
    p = end;
  }
  return 1;
}

function orientationFromTiff(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49; // "II"
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d; // "MM"
  if (!little && !big) return 1;
  const u16 = (o: number) =>
    little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1];
  const u32 = (o: number) =>
    little
      ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
      : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (u16(entry) !== 0x0112) continue;
    // Orientation is a SHORT (type 3); its value sits left-justified in the
    // 4-byte value field.
    if (u16(entry + 2) !== 3) return 1;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/**
 * Remap RGBA pixels so an image stored with EXIF `orientation` displays
 * upright with no tag. Orientations 5–8 swap width and height.
 */
export function orientRgba(
  pixels: Uint8Array,
  width: number,
  height: number,
  orientation: number,
): { pixels: Uint8Array; width: number; height: number } {
  if (orientation < 2 || orientation > 8) return { pixels, width, height };
  const swap = orientation >= 5;
  const outW = swap ? height : width;
  const outH = swap ? width : height;
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2: dx = width - 1 - x; dy = y; break; // mirror horizontal
        case 3: dx = width - 1 - x; dy = height - 1 - y; break; // rotate 180
        case 4: dx = x; dy = height - 1 - y; break; // mirror vertical
        case 5: dx = y; dy = x; break; // transpose
        case 6: dx = height - 1 - y; dy = x; break; // rotate 90 CW
        case 7: dx = height - 1 - y; dy = width - 1 - x; break; // transverse
        default: dx = y; dy = width - 1 - x; break; // 8: rotate 90 CCW
      }
      const s = (y * width + x) * 4;
      const d = (dy * outW + dx) * 4;
      out[d] = pixels[s];
      out[d + 1] = pixels[s + 1];
      out[d + 2] = pixels[s + 2];
      out[d + 3] = pixels[s + 3];
    }
  }
  return { pixels: out, width: outW, height: outH };
}
