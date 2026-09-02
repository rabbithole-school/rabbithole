/**
 * Pure helpers for the "Find an image" flow — a scholar types a query, the
 * backend searches the web (Brave, safesearch=strict) and returns a thumbnail
 * grid, and the picked result is re-hosted in Convex and lands on the slide as
 * an ordinary image element. Kept framework-free so the response→view-state
 * mapping and the client-side paging are unit-testable without a DOM (mirrors
 * how {@link ./slideImagePrompt} isolates the "Make an image" logic).
 *
 * Copy, the submit gate, and the alt derivation live in `shared/slidesScene`
 * and are delegated to here, so the web and native surfaces cannot word or gate
 * the same feature differently — the two sources already proved they diverge
 * when left to invent their own strings.
 */
import {
  FIND_IMAGE_COPY,
  FIND_IMAGE_MAX_QUERY,
  WEB_IMAGE_SHAPES,
  canSubmitImageSearch,
  deriveFoundImageAlt,
  filterImagesByShape,
  webImageShapeLabel,
  type WebImageSearchResponse,
  type WebImageSearchResult,
  type WebImagePickResult,
  type WebImageShape,
} from "@/shared/slidesScene";

export {
  FIND_IMAGE_COPY,
  FIND_IMAGE_MAX_QUERY,
  WEB_IMAGE_SHAPES,
  canSubmitImageSearch,
  deriveFoundImageAlt,
  filterImagesByShape,
  webImageShapeLabel,
};
export type {
  WebImageSearchResponse,
  WebImageSearchResult,
  WebImagePickResult,
  WebImageShape,
};

/**
 * The view the dialog renders, folded from the search action's response. The
 * one derivation the response itself doesn't carry: an empty `results` array is
 * its own `empty` view, so the dialog never draws a headerless zero-tile grid.
 */
export type ImageSearchView =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "results"; results: WebImageSearchResult[] }
  | { kind: "empty" }
  | { kind: "capped" }
  | { kind: "unavailable" }
  | { kind: "error" };

/** Map one search response to the view the grid renders. */
export function imageSearchView(response: WebImageSearchResponse): ImageSearchView {
  switch (response.status) {
    case "results":
      return response.results.length > 0
        ? { kind: "results", results: response.results }
        : { kind: "empty" };
    case "capped":
      return { kind: "capped" };
    case "unavailable":
      return { kind: "unavailable" };
    case "error":
      return { kind: "error" };
  }
}

/** How many thumbnails a fresh result set reveals before "More images". */
export const IMAGE_SEARCH_PAGE_SIZE = 12;

/** The next reveal count when "More images" is tapped, clamped to the total. */
export function nextShownCount(
  shown: number,
  total: number,
  pageSize: number = IMAGE_SEARCH_PAGE_SIZE,
): number {
  return Math.min(shown + pageSize, Math.max(0, total));
}

/** Whether a "More images" affordance should show for the current reveal. */
export function hasMoreResults(shown: number, total: number): boolean {
  return shown < total;
}
