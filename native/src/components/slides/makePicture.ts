/**
 * Pure logic for the "Make a picture" media source — an illustration engine,
 * not a photo search. Kept out of the dialog and editor components so the
 * result-folding is testable without a device.
 *
 * COPY, ALT DERIVATION AND PLACEMENT LIVE IN `shared/slidesScene` (vendored
 * here) and are re-exported. Native and web were built in parallel and
 * independently invented different wording, two different alt rules and two
 * different cascade steps; scholar-facing parity is the EXPERIENCE, so both
 * surfaces read the same constants. Do not re-add local copies.
 */
export {
  MAKE_PICTURE_COPY,
  MAKE_PICTURE_MAX_PROMPT,
  MAKE_PICTURE_MAX_ALT,
  PLACEHOLDER_CASCADE_STEP,
  deriveSlideImageAlt,
  canSubmitMakePicture,
  resolveMakePictureResult as resolveGenerateResult,
  placeholderFrameForSlot,
  resolvedImageFrame,
  nextCascadeSlot,
  type MakePictureResult as GenerateResult,
  type MakePictureOutcome,
} from "../../../vendor/shared/slidesScene";
