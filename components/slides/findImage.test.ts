import { describe, expect, it } from "vitest";
import {
  IMAGE_SEARCH_PAGE_SIZE,
  WEB_IMAGE_SHAPES,
  canSubmitImageSearch,
  deriveFoundImageAlt,
  filterImagesByShape,
  hasMoreResults,
  imageSearchView,
  nextShownCount,
  webImageShapeLabel,
  type WebImageSearchResult,
  type WebImageShape,
} from "./findImage";
import { FIND_IMAGE_COPY } from "@/shared/slidesScene";

function result(resultId: string): WebImageSearchResult {
  return {
    resultId,
    thumbnailUrl: `https://proxy.example/${resultId}.jpg`,
    imageUrl: `https://origin.example/${resultId}.jpg`,
    pickToken: `token-${resultId}`,
  };
}

function sized(
  resultId: string,
  width: number,
  height: number,
): WebImageSearchResult {
  return { ...result(resultId), width, height };
}

describe("imageSearchView (search response → dialog state)", () => {
  it("renders a non-empty result set as the grid", () => {
    const results = [result("a"), result("b")];
    expect(imageSearchView({ status: "results", results })).toEqual({
      kind: "results",
      results,
    });
  });

  it("folds an empty result set into its own empty state, never a zero-tile grid", () => {
    expect(imageSearchView({ status: "results", results: [] })).toEqual({
      kind: "empty",
    });
  });

  it("maps the fail-closed and cap states straight through", () => {
    expect(imageSearchView({ status: "capped" })).toEqual({ kind: "capped" });
    expect(imageSearchView({ status: "unavailable" })).toEqual({
      kind: "unavailable",
    });
    expect(imageSearchView({ status: "error", error: "boom" })).toEqual({
      kind: "error",
    });
  });
});

describe("canSubmitImageSearch (double-submit / empty-query gate)", () => {
  it("allows a real query with nothing in flight", () => {
    expect(canSubmitImageSearch("saturn v", false)).toBe(true);
  });

  it("blocks an empty or whitespace-only query", () => {
    expect(canSubmitImageSearch("", false)).toBe(false);
    expect(canSubmitImageSearch("   \n ", false)).toBe(false);
  });

  it("blocks a second search while one is already running", () => {
    expect(canSubmitImageSearch("saturn v", true)).toBe(false);
  });
});

describe("deriveFoundImageAlt (honest alt from the query)", () => {
  it("uses the scholar's query, capitalized, as the alt text", () => {
    expect(deriveFoundImageAlt("saturn v rocket launch")).toBe(
      "Saturn v rocket launch",
    );
  });

  it("falls back to the shared copy for an empty query", () => {
    expect(deriveFoundImageAlt("   ")).toBe(FIND_IMAGE_COPY.altFallback);
  });
});

describe("client-side paging (the More images affordance)", () => {
  it("reveals a page at a time, clamped to the total", () => {
    expect(nextShownCount(IMAGE_SEARCH_PAGE_SIZE, 50)).toBe(
      IMAGE_SEARCH_PAGE_SIZE * 2,
    );
    expect(nextShownCount(45, 50)).toBe(50);
    expect(nextShownCount(50, 50)).toBe(50);
  });

  it("shows More only while thumbnails remain hidden", () => {
    expect(hasMoreResults(IMAGE_SEARCH_PAGE_SIZE, 50)).toBe(true);
    expect(hasMoreResults(50, 50)).toBe(false);
    expect(hasMoreResults(3, 3)).toBe(false);
  });
});

describe("shape filter re-exports (shared, so web + native narrow identically)", () => {
  it("re-exports the shared shape list in order", () => {
    expect(WEB_IMAGE_SHAPES).toEqual(["any", "square", "wide", "tall"]);
  });

  it("labels each shape with the shared verbatim copy", () => {
    const labels: Record<WebImageShape, string> = {
      any: FIND_IMAGE_COPY.shapeAny,
      square: FIND_IMAGE_COPY.shapeSquare,
      wide: FIND_IMAGE_COPY.shapeWide,
      tall: FIND_IMAGE_COPY.shapeTall,
    };
    for (const shape of WEB_IMAGE_SHAPES) {
      expect(webImageShapeLabel(shape)).toBe(labels[shape]);
    }
  });

  it("'any' passes every result through unchanged", () => {
    const results = [sized("a", 100, 100), sized("b", 400, 100)];
    expect(filterImagesByShape(results, "any")).toEqual(results);
  });

  it("narrows to a specific aspect and drops undimensioned results", () => {
    const square = sized("sq", 100, 100);
    const wide = sized("wide", 400, 100);
    const tall = sized("tall", 100, 400);
    const noDims = result("nd");
    const all = [square, wide, tall, noDims];
    expect(filterImagesByShape(all, "square")).toEqual([square]);
    expect(filterImagesByShape(all, "wide")).toEqual([wide]);
    expect(filterImagesByShape(all, "tall")).toEqual([tall]);
  });
});
