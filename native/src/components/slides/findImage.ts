/**
 * Pure logic for the "Find an image" media source — a web image search (Brave),
 * not the illustration engine. Kept out of the sheet and editor components so
 * the copy, submit gating, alt derivation, and placement stay testable without
 * a device.
 *
 * COPY, ALT DERIVATION AND PLACEMENT LIVE IN `shared/slidesScene` (vendored
 * here) and are re-exported — the SAME discipline `makePicture.ts` documents:
 * native and web were built in parallel and independently invented different
 * wording, alt rules and cascade steps, so both surfaces read the same
 * constants. Do not re-add local copies.
 *
 * The search/pick actions already fold their contracts to the states both
 * surfaces render (`WebImageSearchResponse` / `WebImagePickResult`), so there is
 * no result-folding to do here — the placement helpers below are the ones the
 * host reuses when the editor unmounts mid-pick, exactly like generation.
 */
export {
  FIND_IMAGE_COPY,
  FIND_IMAGE_MAX_QUERY,
  WEB_IMAGE_SHAPES,
  canSubmitImageSearch,
  deriveFoundImageAlt,
  filterImagesByShape,
  webImageShapeLabel,
  placeholderFrameForSlot,
  resolvedImageFrame,
  type WebImageSearchResult,
  type WebImageSearchResponse,
  type WebImagePickResult,
  type WebImageShape,
} from "../../../vendor/shared/slidesScene";
