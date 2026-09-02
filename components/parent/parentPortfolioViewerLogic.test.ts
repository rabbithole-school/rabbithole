import { describe, expect, test } from "vitest";

import {
  isVideoMedia,
  pageCountForRange,
  viewerIndexForKey,
} from "./parentPortfolioViewerLogic";

describe("parent portfolio viewer navigation", () => {
  test("moves between items without wrapping", () => {
    expect(viewerIndexForKey("ArrowLeft", 0, 3)).toBe(0);
    expect(viewerIndexForKey("ArrowRight", 1, 3)).toBe(2);
    expect(viewerIndexForKey("ArrowRight", 2, 3)).toBe(2);
  });

  test("jumps to the first and last item", () => {
    expect(viewerIndexForKey("Home", 2, 3)).toBe(0);
    expect(viewerIndexForKey("End", 0, 3)).toBe(2);
    expect(viewerIndexForKey("Escape", 0, 3)).toBeNull();
  });

  test("recognizes only video MIME types as video media", () => {
    expect(isVideoMedia("video/mp4")).toBe(true);
    expect(isVideoMedia("image/jpeg")).toBe(false);
    expect(isVideoMedia(undefined)).toBe(false);
  });

  test("derives page counts from inclusive scan ranges", () => {
    expect(pageCountForRange({ start: 1, end: 1 })).toBe(1);
    expect(pageCountForRange({ start: 4, end: 6 })).toBe(3);
    expect(pageCountForRange({ start: 0, end: 1 })).toBeNull();
    expect(pageCountForRange({ start: 3, end: 2 })).toBeNull();
    expect(pageCountForRange(undefined)).toBeNull();
  });
});
