/**
 * Pure helpers for the "Make a picture" flow — a scholar types a short
 * description, the backend generates an illustration, and it lands on the slide
 * as an ordinary image element. Kept framework-free so the prompt→alt-text
 * derivation, the placement maths and the submit state machine are unit-testable
 * without a DOM (mirrors how {@link ./imageFilePicker} isolates its logic).
 *
 * Copy, alt derivation and placement live in `shared/slidesScene` and are
 * delegated to here, so the web and native surfaces cannot word or place the
 * same feature differently — they already diverged once on both.
 */
import {
  MAKE_PICTURE_COPY,
  MAKE_PICTURE_MAX_ALT,
  MAKE_PICTURE_MAX_PROMPT,
  PLACEHOLDER_CASCADE_STEP,
  deriveSlideImageAlt,
  canSubmitMakePicture,
  resolveMakePictureResult,
  placeholderFrameForSlot,
  resolvedImageFrame,
  nextCascadeSlot,
  type MakePictureResult,
  type MakePictureOutcome,
  type Frame,
} from "@/shared/slidesScene";

export {
  MAKE_PICTURE_COPY,
  MAKE_PICTURE_MAX_PROMPT,
  deriveSlideImageAlt,
  resolveMakePictureResult,
};
export type { MakePictureResult, MakePictureOutcome };

/** Longest alt text we derive. Shared with native so both cap identically. */
export const MAX_ALT_LENGTH = MAKE_PICTURE_MAX_ALT;

/** Collapse a scholar's prompt into clean, single-spaced, trimmed text. */
export function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

/**
 * The prompt the scholar typed IS a description of the picture, so it makes
 * honest alt text. Every generated image gets it — we never ship an unlabeled
 * image, and the shared image preset's default alt is a useless "Photo".
 */
export function deriveAltText(prompt: string): string {
  return deriveSlideImageAlt(prompt);
}

/**
 * Can the submit action fire? Only with a non-empty prompt and no generation
 * already in flight for THIS prompt — what makes a double-click (or a second
 * Enter) harmless.
 */
export function canMakePicture(prompt: string, generating: boolean): boolean {
  return canSubmitMakePicture(prompt, generating);
}

/**
 * The x/y shift a cascade slot applies, so several in-flight placeholders sit
 * at visibly different spots rather than on top of one another.
 */
export function placeholderSlotOffset(slot: number): { dx: number; dy: number } {
  const base = placeholderFrameForSlot(0);
  const at = placeholderFrameForSlot(slot);
  return { dx: at.x - base.x, dy: at.y - base.y };
}

/**
 * The frame a placeholder occupies: the preset image box (the generated image's
 * aspect is unknowable until it exists), cascaded by its slot. Shared with
 * native so both surfaces cascade identically.
 */
export function placeholderFrame(slot: number): Frame {
  return placeholderFrameForSlot(slot);
}

/**
 * The frame for the FINAL image: fitted to the real pixel size (which is what
 * kills the white letterbox) and re-centred on the placeholder that stood in
 * for it, so it lands where the spinner sat rather than snapping to the preset
 * centre. Missing dimensions fall back to the preset box.
 */
export function generatedImageFrame(
  width: number | undefined,
  height: number | undefined,
  slot: number,
): Frame {
  return resolvedImageFrame(placeholderFrameForSlot(slot), width, height);
}


export { PLACEHOLDER_CASCADE_STEP, nextCascadeSlot };
