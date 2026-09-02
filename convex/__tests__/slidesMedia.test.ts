import { describe, expect, test } from "vitest";
import { detectSlideImageMime, detectSlideVideoMime } from "../lib/slidesMedia";

const isoBaseMediaHeader = new Uint8Array([
  0, 0, 0, 24,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
]);

describe("slide video media", () => {
  test("accepts supported ISO base media video containers", () => {
    expect(detectSlideVideoMime(isoBaseMediaHeader, "video/mp4")).toBe("video/mp4");
    expect(detectSlideVideoMime(isoBaseMediaHeader, "video/quicktime; codecs=hvc1"))
      .toBe("video/quicktime");
    expect(detectSlideVideoMime(isoBaseMediaHeader, "video/x-m4v")).toBe("video/x-m4v");
  });

  test("rejects mislabeled or unsupported video uploads", () => {
    expect(() => detectSlideVideoMime(new Uint8Array([1, 2, 3]), "video/mp4"))
      .toThrow("unsupported or unrecognized");
    expect(() => detectSlideVideoMime(isoBaseMediaHeader, "video/webm"))
      .toThrow("unsupported or unrecognized");
  });
});

describe("slide image media", () => {
  test.each([
    {
      name: "PNG",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      declared: "image/png",
      mime: "image/png",
    },
    {
      name: "JPEG normalizes image/jpg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      declared: "image/jpg",
      mime: "image/jpeg",
    },
    {
      name: "GIF",
      bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
      declared: "image/gif",
      mime: "image/gif",
    },
    {
      name: "WEBP",
      bytes: new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
      declared: "image/webp",
      mime: "image/webp",
    },
  ])("derives $name from recognized bytes", ({ bytes, declared, mime }) => {
    expect(detectSlideImageMime(bytes, declared)).toBe(mime);
  });

  test("does not allow arbitrary bytes declared as an image", () => {
    expect(() => detectSlideImageMime(new Uint8Array([1, 2, 3]), "image/png"))
      .toThrow("unsupported or unrecognized");
  });

  test("does not let a declared MIME override recognized bytes", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectSlideImageMime(png, "image/jpeg")).toBe("image/png");
  });

  test.each([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]),
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42]),
  ])("rejects truncated image signatures", (bytes) => {
    expect(() => detectSlideImageMime(bytes, "image/png"))
      .toThrow("unsupported or unrecognized");
  });

  test("rejects HEIC-like and unknown image bytes", () => {
    const heic = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(() => detectSlideImageMime(heic, "image/heic"))
      .toThrow("unsupported or unrecognized");
  });
});
