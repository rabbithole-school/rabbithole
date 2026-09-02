import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { keyOutGreen } from "../lib/badgeChroma";

type Rgb = readonly [number, number, number];

function fixture(
  size = 20,
  background: Rgb = [0, 177, 64],
  subject: Rgb = [220, 30, 30],
) {
  const png = new PNG({ width: size, height: size });
  const data = png.data;
  const set = (x: number, y: number, color: Rgb) => {
    const i = (y * size + x) * 4;
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) set(x, y, background);
  }
  for (let y = 6; y <= 13; y++) {
    for (let x = 6; x <= 13; x++) set(x, y, subject);
  }
  set(10, 10, background);
  return { data, width: size, height: size, set };
}

const rgba = (data: Uint8Array, width: number, x: number, y: number) => {
  const i = (y * width + x) * 4;
  return [...data.subarray(i, i + 4)];
};

/**
 * Frozen copy of the pre-options implementation. This is deliberately local to
 * the regression test so the expected bytes do not depend on the new keyer.
 */
function legacyKeyOutGreen(
  data: Uint8Array,
  width: number,
  height: number,
): void {
  const tol = 95;
  const feather = 150;
  const idx = (x: number, y: number) => (y * width + x) * 4;
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
  const removed = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (removed[p]) return;
    if (dist(idx(x, y)) > tol) return;
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
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const rb = (r + b) / 2 + 12;
      if (g > rb) data[i + 1] = Math.round(rb);
    }
  }
}

const checksum = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

describe("keyOutGreen — green-screen badge background removal", () => {
  test("removes the edge-connected green and keeps the badge", () => {
    const { data, width, height } = fixture();
    keyOutGreen(data, width, height);

    expect(rgba(data, width, 0, 0)[3]).toBe(0);
    expect(rgba(data, width, width - 1, height - 1)[3]).toBe(0);
    expect(rgba(data, width, 8, 8)[3]).toBe(255);
  });

  test("enclosed green survives edge-connected mode but global mode removes it", () => {
    const edge = fixture();
    const global = fixture();
    keyOutGreen(edge.data, edge.width, edge.height, {
      mode: "edge-connected",
      screen: "green",
    });
    keyOutGreen(global.data, global.width, global.height, {
      mode: "global",
      screen: "green",
    });

    expect(rgba(edge.data, edge.width, 10, 10)[3]).toBe(255);
    expect(rgba(global.data, global.width, 10, 10)[3]).toBe(0);
  });

  test("global blue keys the screen while leaving a green subject untouched", () => {
    const blue: Rgb = [0, 71, 187];
    const green: Rgb = [44, 190, 76];
    const { data, width, height } = fixture(20, blue, green);
    keyOutGreen(data, width, height, { mode: "global", screen: "blue" });

    expect(rgba(data, width, 0, 0)).toEqual([0, 71, 187, 0]);
    expect(rgba(data, width, 8, 8)).toEqual([44, 190, 76, 255]);
  });

  test("the default call is byte-identical to the pre-options algorithm", () => {
    const legacy = fixture();
    const current = fixture();
    legacy.set(6, 8, [110, 170, 90]);
    current.set(6, 8, [110, 170, 90]);

    legacyKeyOutGreen(legacy.data, legacy.width, legacy.height);
    keyOutGreen(current.data, current.width, current.height);

    const legacyChecksum = checksum(legacy.data);
    expect(rgba(legacy.data, legacy.width, 6, 8)).toEqual([110, 112, 90, 85]);
    expect(legacyChecksum).toBe(
      "a6f9f2f6bac79db7cefec2283a2b331792dced82400cc9905129ddffb4e1a89c",
    );
    expect(checksum(current.data)).toBe(legacyChecksum);
    expect(current.data).toEqual(legacy.data);
  });

  test("despill clamps the blue axis on a feathered blue-screen edge", () => {
    const blue: Rgb = [0, 71, 187];
    const { data, width, height, set } = fixture(20, blue, [220, 30, 30]);
    set(6, 8, [100, 80, 220]);
    keyOutGreen(data, width, height, { mode: "global", screen: "blue" });

    const pixel = rgba(data, width, 6, 8);
    expect(pixel[0]).toBe(100);
    expect(pixel[1]).toBe(80);
    expect(pixel[2]).toBe(102);
    expect(pixel[3]).toBeGreaterThan(0);
    expect(pixel[3]).toBeLessThan(255);
  });

  test("magenta keying preserves the Bold flair palette", () => {
    const magenta: Rgb = [255, 0, 255];
    const palette: Rgb[] = [
      [255, 198, 77],
      [255, 107, 87],
      [90, 169, 245],
      [127, 211, 232],
      [255, 246, 233],
      [23, 23, 28],
    ];

    for (const color of palette) {
      const keyed = fixture(20, magenta, color);
      keyOutGreen(keyed.data, keyed.width, keyed.height, {
        screen: "magenta",
      });
      expect(rgba(keyed.data, keyed.width, 0, 0)[3]).toBe(0);
      expect(rgba(keyed.data, keyed.width, 6, 8)).toEqual([
        ...color,
        255,
      ]);
    }
  });
});
