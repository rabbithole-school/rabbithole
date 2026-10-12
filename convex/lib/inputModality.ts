import { v, type Infer } from "convex/values";

export const inputModalityValidator = v.union(
  v.literal("typed"),
  v.literal("spoken"),
  v.literal("app"),
);

export type InputModality = Infer<typeof inputModalityValidator>;

/**
 * Whether a user turn's `content` is text the scholar typed — the only input a
 * writing-derived readability measure (the AI reading-level estimate, the
 * Flesch–Kincaid trend) may score. Speech-to-text output arrives fully
 * punctuated and spelled, so scoring it measures the transcription engine, not
 * the child; an `"app"` turn is a button the embedded app pressed, not prose.
 *
 * An ABSENT modality counts as typed. The field was added 2026-08-20 (#2551)
 * and is still optional for older native clients, so a missing value cannot be
 * proven spoken; dropping every legacy row would blank the history these
 * measures are built from. The residual error (a pre-#2551 dictated turn read
 * as typed) shrinks as those rows age out of the 30/90-day windows.
 */
export function isTypedScholarText(message: {
  inputModality?: InputModality;
}): boolean {
  return message.inputModality === undefined || message.inputModality === "typed";
}
