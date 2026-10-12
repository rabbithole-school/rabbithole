import { describe, expect, it } from "vitest";

import {
  decodedSideways,
  downscaleTarget,
  MODEL_IMAGE_MAX_EDGE_PX,
} from "./imageDownscale";

describe("downscaleTarget", () => {
  it("caps a landscape iPad photo's long edge and keeps its aspect ratio", () => {
    expect(downscaleTarget({ width: 4032, height: 3024 })).toEqual({
      width: MODEL_IMAGE_MAX_EDGE_PX,
      height: 1176,
    });
  });

  it("caps a portrait photo on its height", () => {
    expect(downscaleTarget({ width: 3024, height: 4032 })).toEqual({
      width: 1176,
      height: MODEL_IMAGE_MAX_EDGE_PX,
    });
  });

  it("caps a square photo on both edges", () => {
    expect(downscaleTarget({ width: 3000, height: 3000 })).toEqual({
      width: MODEL_IMAGE_MAX_EDGE_PX,
      height: MODEL_IMAGE_MAX_EDGE_PX,
    });
  });

  it("never upscales, and leaves an image exactly at the cap alone", () => {
    expect(downscaleTarget({ width: 800, height: 600 })).toBeNull();
    expect(downscaleTarget({ width: MODEL_IMAGE_MAX_EDGE_PX, height: 900 })).toBeNull();
  });

  it("keeps a very thin panorama at least one pixel tall", () => {
    expect(downscaleTarget({ width: 40000, height: 10 })).toEqual({
      width: MODEL_IMAGE_MAX_EDGE_PX,
      height: 1,
    });
  });

  it("refuses unusable dimensions rather than guessing", () => {
    expect(downscaleTarget({ width: 0, height: 3024 })).toBeNull();
    expect(downscaleTarget({ width: Number.NaN, height: 3024 })).toBeNull();
    expect(downscaleTarget({ width: Infinity, height: 3024 })).toBeNull();
  });

  it("honours a caller's own cap", () => {
    expect(downscaleTarget({ width: 2000, height: 1000 }, 500)).toEqual({
      width: 500,
      height: 250,
    });
  });
});

describe("decodedSideways", () => {
  it("flags a decode a quarter turn from what the picker displayed", () => {
    expect(
      decodedSideways({ width: 4032, height: 3024 }, { width: 3024, height: 4032 }),
    ).toBe(true);
    expect(
      decodedSideways({ width: 3024, height: 4032 }, { width: 4032, height: 3024 }),
    ).toBe(true);
  });

  it("passes a decode that matches, and a square it can't judge", () => {
    expect(
      decodedSideways({ width: 4032, height: 3024 }, { width: 4032, height: 3024 }),
    ).toBe(false);
    expect(
      decodedSideways({ width: 3000, height: 3000 }, { width: 3000, height: 3000 }),
    ).toBe(false);
  });
});
