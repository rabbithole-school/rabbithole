// Chroma-key background removal for generated art.
//
// WHY: the image model (gemini-3-pro-image-preview / "Nano Banana Pro") can't
// emit a true alpha channel — asking for "transparent" yields a solid fill or a
// *painted* checkerboard. So art is generated on a flat chroma screen and this
// strips it to real transparency:
//   1. sample the four corners for the actual key color (robust to model drift),
//   2. remove matching pixels globally or only from the edge-connected backdrop,
//   3. despill + feather the subject's anti-aliased rim.
//
// Pure (operates on an in-place RGBA buffer) so it's unit-testable without a PNG
// codec; the "use node" action (badgeArtActions.ts) wraps it with pngjs
// decode/encode.

export type RgbaBuffer = Uint8Array | Uint8ClampedArray;

export type KeyOptions = {
  /** Edge-connected preserves enclosed screen-colored subject pixels. */
  mode?: "edge-connected" | "global";
  /**
   * Which channel to despill. Keying is driven by the sampled corner color
   * (`matchesScreenHue`), not by `screen`; this only selects the channel whose
   * spill gets suppressed on the subject's rim. A wrong `screen` value can leave
   * a halo even though the background is still removed.
   */
  screen?: "green" | "blue" | "red" | "magenta";
  /** A pixel within this Euclidean RGB distance of the key color is background. */
  tolerance?: number;
  /** Edge pixels within this distance get a feathered alpha (anti-alias the cut). */
  feather?: number;
};

const DEFAULT_TOLERANCE = 95;
const DEFAULT_FEATHER = 150;

/**
 * Remove a flat chroma-screen background in place. `data` is RGBA (4 bytes/px),
 * row-major, length === width * height * 4. Mutates `data` (alpha + despill).
 *
 * The public name is retained for existing consumers. Defaults remain the
 * original edge-connected green-screen behavior.
 */
export function keyOutGreen(
  data: RgbaBuffer,
  width: number,
  height: number,
  opts: KeyOptions = {},
): void {
  const mode = opts.mode ?? "edge-connected";
  const screen = opts.screen ?? "green";
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const feather = Math.max(opts.feather ?? DEFAULT_FEATHER, tol + 1);
  const idx = (x: number, y: number) => (y * width + x) * 4;

  // 1. Key color = average of the four corner pixels (the model's actual green).
  let kr = 0;
  let kg = 0;
  let kb = 0;
  const corners: Array<[number, number]> = [
    [1, 1],
    [width - 2, 1],
    [1, height - 2],
    [width - 2, height - 2],
  ];
  for (const [cx, cy] of corners) {
    const i = idx(cx, cy);
    kr += data[i];
    kg += data[i + 1];
    kb += data[i + 2];
  }
  kr /= corners.length;
  kg /= corners.length;
  kb /= corners.length;

  const dist = (i: number) =>
    Math.hypot(data[i] - kr, data[i + 1] - kg, data[i + 2] - kb);
  const matchesScreenHue = (i: number) => dist(i) <= tol;

  // 2. Select either every near-key pixel or only the backdrop connected to an
  //    edge. Both modes use the same sampled-color hue test.
  const removed = new Uint8Array(width * height);
  if (mode === "global") {
    for (let p = 0; p < width * height; p++) {
      if (matchesScreenHue(p * 4)) removed[p] = 1;
    }
  } else {
    const stack: number[] = [];
    const push = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const p = y * width + x;
      if (removed[p]) return;
      if (!matchesScreenHue(idx(x, y))) return;
      removed[p] = 1;
      stack.push(p);
    };
    for (let x = 0; x < width; x++) {
      push(x, 0);
      push(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      push(0, y);
      push(width - 1, y);
    }
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % width;
      const y = (p - x) / width;
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
    }
  }

  // 3. Apply. Removed → transparent. Surviving pixels that border a removed one
  //    get a feathered alpha + screen-channel despill to kill the halo.
  const screenChannel =
    screen === "green" ? 1 : screen === "blue" ? 2 : screen === "red" ? 0 : null;
  const otherChannels =
    screen === "green"
      ? ([0, 2] as const)
      : screen === "blue"
        ? ([0, 1] as const)
        : ([1, 2] as const);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = idx(x, y);
      if (removed[p]) {
        data[i + 3] = 0;
        continue;
      }
      let border = false;
      if (x + 1 < width && removed[p + 1]) border = true;
      else if (x - 1 >= 0 && removed[p - 1]) border = true;
      else if (y + 1 < height && removed[p + width]) border = true;
      else if (y - 1 >= 0 && removed[p - width]) border = true;
      if (!border) continue;

      const d = dist(i);
      if (d < feather) {
        data[i + 3] = Math.round(
          255 * Math.min(1, Math.max(0, (d - tol) / (feather - tol))),
        );
      }
      if (screenChannel === null) {
        if (d < feather) {
          const spillCeiling = data[i + 1] + 12;
          if (data[i] > spillCeiling) data[i] = Math.round(spillCeiling);
          if (data[i + 2] > spillCeiling) {
            data[i + 2] = Math.round(spillCeiling);
          }
        }
      } else {
        const spillCeiling =
          (data[i + otherChannels[0]] + data[i + otherChannels[1]]) / 2 + 12;
        if (data[i + screenChannel] > spillCeiling) {
          data[i + screenChannel] = Math.round(spillCeiling);
        }
      }
    }
  }
}
