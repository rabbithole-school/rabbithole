/**
 * PCM (Parallel Curriculum Model) — shared constants + helpers for the
 * narrative-assessment feature. See review/assessment-and-goals-plan.html.
 *
 * The four dimensions are Carl's assessment axes; they mirror the four
 * `lessons.strand` values on purpose. This module is the single source of
 * truth for the dimension keys, their human labels, and the 1–7 rubric bands
 * (Carl's two-numbers-per-level modification). Pure module (no "use node", no
 * Convex ctx) so the composer UI, the observer, the binder, and the eval
 * harness all import the exact same definitions.
 */
import { v } from "convex/values";

export const PCM_DIMENSIONS = [
  "core",
  "connections",
  "practice",
  "identity",
] as const;

export type PcmDimension = (typeof PCM_DIMENSIONS)[number];

/** Convex validator — reused by the observer record mutations. */
export const pcmDimensionValidator = v.union(
  v.literal("core"),
  v.literal("connections"),
  v.literal("practice"),
  v.literal("identity"),
);

/** Short human label + one-line meaning for each dimension. */
export const PCM_META: Record<
  PcmDimension,
  { label: string; blurb: string }
> = {
  core: {
    label: "Core",
    blurb: "essential knowledge & skills",
  },
  connections: {
    label: "Connections",
    blurb: "interdisciplinary transfer, systems thinking",
  },
  practice: {
    label: "Practice",
    blurb: "thinking & working like a practitioner",
  },
  identity: {
    label: "Identity",
    blurb: "self-awareness, interests, the field's meaning",
  },
};

/**
 * Per-strand teaching stance, injected into the tutor's system prompt when a
 * lesson carries a PCM strand tag. Each of Carl's four parallels is meant to be
 * taught with a DIFFERENT instructional stance — this is the one-line steer that
 * makes a Connections lesson feel different from a Core one. It's stance, not a
 * character: the tutor stays the Socratic tutor (anti-parasocial), it just knows
 * HOW to steer a lesson of this strand.
 */
export const PCM_STRAND_STANCE: Record<PcmDimension, string> = {
  core:
    "This is a Core lesson — the essential knowledge and skill. Help the scholar surface and consolidate the central idea in their own words, and make sure it's solid before layering more on top.",
  connections:
    "This is a Connections lesson — the job is transfer, not new facts. Help the scholar find how this idea shows up in other domains and systems (\"where else have you seen this?\"), and reward the cross-disciplinary leap.",
  practice:
    "This is a Practice lesson — have the scholar work like a real practitioner in the field: asking their own questions, gathering and weighing evidence, using the discipline's methods, and revising — not just learning ABOUT it.",
  identity:
    "This is an Identity lesson — connect the field to who the scholar is and why it might matter to them: their interests, their values, and what it would mean to see themselves doing this kind of work.",
};

/**
 * Carl's master rubric. Each named level spans TWO numbers so a teacher can
 * place a child who has ENTERED a level but isn't yet SECURE in it: the higher
 * number = secure in the band, the lower = just entered it. The `reading`
 * exemplar is the Connections column (the doc's worked example).
 */
export interface RubricBand {
  band: "Emerging" | "Developing" | "Proficient" | "Exemplary";
  numbers: number[];
  /** Connections-column descriptor (the exemplar). */
  descriptor: string;
}

export const RUBRIC_BANDS: RubricBand[] = [
  {
    band: "Exemplary",
    numbers: [6, 7],
    descriptor:
      "Consistently identifies meaningful patterns and interdisciplinary relationships; transfers learning across multiple contexts independently.",
  },
  {
    band: "Proficient",
    numbers: [4, 5],
    descriptor:
      "Regularly recognizes important relationships among ideas and makes thoughtful interdisciplinary connections.",
  },
  {
    band: "Developing",
    numbers: [2, 3],
    descriptor:
      "Identifies some connections among ideas when prompted; developing the ability to transfer learning.",
  },
  {
    band: "Emerging",
    numbers: [1],
    descriptor:
      "Begins recognizing simple relationships among concepts with considerable teacher guidance.",
  },
];

/** Which band a 1–7 rating falls in, plus whether it's "entered" vs "secure". */
export function bandForRating(rating: number): {
  band: RubricBand["band"];
  posture: "entered" | "secure";
} | null {
  if (!Number.isFinite(rating) || rating < 1 || rating > 7) return null;
  const b = RUBRIC_BANDS.find((x) => x.numbers.includes(Math.round(rating)));
  if (!b) return null;
  // The higher number in a 2-number band = secure; the lower = entered.
  const secure = rating === Math.max(...b.numbers);
  return { band: b.band, posture: secure ? "secure" : "entered" };
}

/** Valid rating range guard (1–7 integers). */
export function isValidRating(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 7;
}
