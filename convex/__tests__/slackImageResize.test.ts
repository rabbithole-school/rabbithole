import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/api";
import { orientRgba, readJpegExifOrientation } from "../lib/exifOrientation";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/** A minimal EXIF APP1 segment: big-endian TIFF, IFD0 = one Orientation SHORT. */
function exifApp1(orientation: number): Uint8Array {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // "MM", 42, IFD0 at offset 8
    0, 1, // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation SHORT
    0, 0, 0, 0, // no next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0"
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

/**
 * What a phone camera writes for a portrait photo: LANDSCAPE pixels (40x20,
 * left half red, right half blue) + EXIF Orientation 6. Laid out like a camera
 * file — SOI, then APP1 Exif in place of photon's APP0 JFIF.
 */
async function phonePortraitJpeg(orientation = 6): Promise<Uint8Array> {
  const photon = await import("@cf-wasm/photon/node");
  const w = 40;
  const h = 20;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < w / 2) px[i] = 255;
      else px[i + 2] = 255;
      px[i + 3] = 255;
    }
  }
  const img = new photon.PhotonImage(px, w, h);
  const jpeg = img.get_bytes_jpeg(95);
  img.free();
  const app0Len = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 2 + ((jpeg[4] << 8) | jpeg[5]) : 0;
  const rest = jpeg.subarray(2 + app0Len);
  const app1 = exifApp1(orientation);
  const out = new Uint8Array(2 + app1.length + rest.length);
  out.set(jpeg.subarray(0, 2));
  out.set(app1, 2);
  out.set(rest, 2 + app1.length);
  return out;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchAndDownscale bakes EXIF orientation into the pixels", () => {
  test("a landscape-pixel JPEG tagged orientation 6 comes out upright and untagged", async () => {
    const fixture = await phonePortraitJpeg(6);
    expect(readJpegExifOrientation(fixture)).toBe(6);
    globalThis.fetch = (async () =>
      new Response(fixture.buffer as ArrayBuffer, { status: 200 })) as typeof fetch;

    const t = convexTest(schema, modules);
    const out = await t.action(internal.slackImageResize.fetchAndDownscale, {
      url: "https://files.slack.com/files-pri/T/IMG_0001.jpg",
      token: "xoxb-test",
    });
    expect(out?.mediaType).toBe("image/jpeg");
    const bytes = new Uint8Array(Buffer.from(out!.dataBase64, "base64"));

    // No tag left for a viewer to apply (or ignore) a second time.
    expect(readJpegExifOrientation(bytes)).toBe(1);
    const photon = await import("@cf-wasm/photon/node");
    const img = photon.PhotonImage.new_from_byteslice(bytes);
    try {
      // Raw dimensions are portrait: the rotation lives in the pixels now.
      expect([img.get_width(), img.get_height()]).toEqual([20, 40]);
      // Rotating 90° clockwise puts the stored LEFT (red) half on top.
      const px = img.get_raw_pixels();
      const at = (x: number, y: number) => px.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 3);
      const top = at(10, 5);
      const bottom = at(10, 34);
      expect(top[0]).toBeGreaterThan(200);
      expect(top[2]).toBeLessThan(60);
      expect(bottom[2]).toBeGreaterThan(200);
      expect(bottom[0]).toBeLessThan(60);
    } finally {
      img.free();
    }
  });

  test("an untagged JPEG keeps its dimensions", async () => {
    const fixture = await phonePortraitJpeg(1);
    globalThis.fetch = (async () =>
      new Response(fixture.buffer as ArrayBuffer, { status: 200 })) as typeof fetch;
    const t = convexTest(schema, modules);
    const out = await t.action(internal.slackImageResize.fetchAndDownscale, {
      url: "https://files.slack.com/files-pri/T/IMG_0002.jpg",
      token: "xoxb-test",
    });
    const photon = await import("@cf-wasm/photon/node");
    const img = photon.PhotonImage.new_from_byteslice(
      new Uint8Array(Buffer.from(out!.dataBase64, "base64")),
    );
    expect([img.get_width(), img.get_height()]).toEqual([40, 20]);
    img.free();
  });
});

describe("readJpegExifOrientation", () => {
  test("reads little-endian TIFF too", () => {
    const tiff = [
      0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0,
      1, 0,
      0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0,
      0, 0, 0, 0,
    ];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = body.length + 2;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...body, 0xff, 0xd9]);
    expect(readJpegExifOrientation(jpeg)).toBe(8);
  });

  test("defaults to 1 for non-JPEG, missing, or truncated metadata", () => {
    expect(readJpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
    expect(readJpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(1);
    expect(readJpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x45]))).toBe(1);
  });
});

describe("orientRgba", () => {
  // A 3x2 image whose pixel "values" are 1..6 in reading order:
  //   1 2 3
  //   4 5 6
  const grid = () => {
    const px = new Uint8Array(3 * 2 * 4);
    for (let i = 0; i < 6; i++) px[i * 4] = i + 1;
    return px;
  };
  const rows = (o: ReturnType<typeof orientRgba>) => {
    const out: number[][] = [];
    for (let y = 0; y < o.height; y++) {
      out.push([]);
      for (let x = 0; x < o.width; x++) out[y].push(o.pixels[(y * o.width + x) * 4]);
    }
    return out;
  };

  test.each([
    [1, [[1, 2, 3], [4, 5, 6]]],
    [2, [[3, 2, 1], [6, 5, 4]]],
    [3, [[6, 5, 4], [3, 2, 1]]],
    [4, [[4, 5, 6], [1, 2, 3]]],
    [5, [[1, 4], [2, 5], [3, 6]]],
    [6, [[4, 1], [5, 2], [6, 3]]],
    [7, [[6, 3], [5, 2], [4, 1]]],
    [8, [[3, 6], [2, 5], [1, 4]]],
  ])("orientation %i displays upright", (orientation, expected) => {
    expect(rows(orientRgba(grid(), 3, 2, orientation))).toEqual(expected);
  });
});
