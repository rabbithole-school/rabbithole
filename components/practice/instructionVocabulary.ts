/**
 * ONE vocabulary for instructional content types — the atom kinds and the
 * segment medium — shared by every teacher surface that names them.
 *
 * Why this file exists: the same vocabulary was written twice and the copies
 * had already forked. `InstructionLaunchpadDetail` kept a complete, type-safe
 * `Record<InstructionAtom["kind"], string>`; `InstructionInventoryTable` kept a
 * loose `Record<string, string>` holding only three of the six kinds, with an
 * `ATOM_LABEL[kind] ?? kind` fallback. So the two NEWEST content types — the
 * guided manipulative and the video — rendered in the cross-domain inventory as
 * raw keys, and `try_it` rendered with its underscore showing. A loose map does
 * not fail when a kind is added; it silently degrades, and it degrades exactly
 * on the newest content, which is the content a teacher is most likely to be
 * looking for.
 *
 * Both maps below are keyed on the CLOSED unions, so adding an atom kind or a
 * medium without a label here is a COMPILE ERROR rather than a raw string
 * leaking into the UI.
 */

import type { InstructionMedium } from "@/convex/instruction";
import type { InstructionAtom } from "@/convex/lib/practice/instructionEntries";

export type InstructionAtomKind = InstructionAtom["kind"];

/** Teacher-facing name for each atom kind. Sentence case (house rule). */
export const INSTRUCTION_ATOM_LABEL: Record<InstructionAtomKind, string> = {
  story_hook: "Story hook",
  micro_explain: "Explain",
  worked_example: "Worked example",
  try_it: "Try it",
  manipulative: "Manipulative",
  video: "Video",
};

/**
 * Teacher-facing name for a segment's MEDIUM — the one-word answer to "what
 * kind of instruction is this?". Derived by `instructionMedium()`
 * (convex/instruction.ts): a segment containing a manipulative is
 * manipulative-led, else one containing a video is video-led, else text.
 */
export const INSTRUCTION_MEDIUM_LABEL: Record<InstructionMedium, string> = {
  manipulative: "Manipulative-led",
  video: "Video-led",
  text: "Text",
};

/**
 * The medium's colour. This is the one signal a teacher scans a whole domain
 * for, so the three media must be separable WITHOUT reading the label.
 *
 * `manipulative` is teal deliberately: teal already means "hands-on" in the
 * Questions facet and on every practice item row, and a manipulative-led
 * segment is the same idea one layer up. Keeping one hue for one meaning across
 * the two surfaces is the point (visual-design.md); giving instruction its own
 * private palette would make teal mean two things.
 */
export function instructionMediumPalette(
  medium: InstructionMedium,
): "teal" | "blue" | "gray" {
  if (medium === "manipulative") return "teal";
  if (medium === "video") return "blue";
  return "gray";
}

/**
 * An atom badge's colour. Deliberately quieter than the medium badge: within a
 * segment the atoms are a composition, not a classification, so only the two
 * that change what a scholar DOES get a hue — `manipulative` (they act) and
 * `video` (they watch). Everything else is gray, including `worked_example`,
 * which used to be teal here and now cedes that hue to the medium badge so teal
 * keeps meaning exactly one thing on this surface.
 */
export function instructionAtomPalette(
  kind: InstructionAtomKind,
): "teal" | "blue" | "gray" {
  if (kind === "manipulative") return "teal";
  if (kind === "video") return "blue";
  return "gray";
}
