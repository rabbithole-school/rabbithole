import { describe, expect, it } from "vitest";
import {
  classifyWebImageShape,
  filterImagesByShape,
  webImageShapeLabel,
  type WebImageSearchResult,
} from "./slidesScene";

function result(
  id: string,
  width?: number,
  height?: number,
): WebImageSearchResult {
  return {
    resultId: id,
    thumbnailUrl: `https://proxy/${id}.jpg`,
    imageUrl: `https://origin/${id}.jpg`,
    pickToken: `t-${id}`,
    width,
    height,
  };
}

describe("classifyWebImageShape", () => {
  it("calls near-1:1 square (within tolerance)", () => {
    expect(classifyWebImageShape({ width: 800, height: 800 })).toBe("square");
    expect(classifyWebImageShape({ width: 900, height: 800 })).toBe("square"); // 1.125
  });

  it("calls clearly-landscape wide and clearly-portrait tall", () => {
    expect(classifyWebImageShape({ width: 1920, height: 1080 })).toBe("wide"); // 1.78
    expect(classifyWebImageShape({ width: 800, height: 1200 })).toBe("tall"); // 0.67
    // 4:3 and 3:4 are past the square tolerance, so they read as wide / tall.
    expect(classifyWebImageShape({ width: 1024, height: 768 })).toBe("wide");
    expect(classifyWebImageShape({ width: 768, height: 1024 })).toBe("tall");
  });

  it("returns null when dimensions are missing or non-positive", () => {
    expect(classifyWebImageShape({})).toBeNull();
    expect(classifyWebImageShape({ width: 0, height: 100 })).toBeNull();
    expect(classifyWebImageShape({ width: 100, height: -1 })).toBeNull();
  });
});

describe("filterImagesByShape", () => {
  const set = [
    result("sq", 500, 500),
    result("wide", 1600, 900),
    result("tall", 600, 900),
    result("nodim"),
  ];

  it("'any' passes everything, including dimensionless results", () => {
    expect(filterImagesByShape(set, "any").map((r) => r.resultId)).toEqual([
      "sq",
      "wide",
      "tall",
      "nodim",
    ]);
  });

  it("a specific shape keeps only that shape and drops the unclassifiable", () => {
    expect(filterImagesByShape(set, "square").map((r) => r.resultId)).toEqual([
      "sq",
    ]);
    expect(filterImagesByShape(set, "wide").map((r) => r.resultId)).toEqual([
      "wide",
    ]);
    expect(filterImagesByShape(set, "tall").map((r) => r.resultId)).toEqual([
      "tall",
    ]);
    // "nodim" (no dimensions) never appears under a specific shape.
    for (const shape of ["square", "wide", "tall"] as const) {
      expect(
        filterImagesByShape(set, shape).some((r) => r.resultId === "nodim"),
      ).toBe(false);
    }
  });

  it("does not mutate the input array", () => {
    const input = [...set];
    filterImagesByShape(input, "square");
    expect(input).toHaveLength(set.length);
  });
});

describe("webImageShapeLabel", () => {
  it("maps every shape to sentence-case copy", () => {
    expect(webImageShapeLabel("any")).toBe("Any");
    expect(webImageShapeLabel("square")).toBe("Square");
    expect(webImageShapeLabel("wide")).toBe("Wide");
    expect(webImageShapeLabel("tall")).toBe("Tall");
  });
});
