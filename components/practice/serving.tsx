"use client";

/**
 * serving.tsx — the derived mastery/checkpoint helper for a scholar's
 * relationship to a DOMAIN in the Math Skills studio. The old serving/access
 * vocabulary (primary/secondary/not-serving, `ServingAvatar`, `ServingToggle`,
 * `PrimaryRankMark`) has been removed; mastery surfaces now render neutral
 * avatars and only carry a mastery-derived "complete" signal.
 */

import type { MasteryState } from "@/components/KnowledgeNodeDial";

/**
 * Complete = the scholar has no skill left to work on in the domain: every own
 * reading is placed-out or mastered (nothing sitting at locked/frontier). A
 * node with no reading counts as not-done, so a partially-read domain is never
 * falsely "complete". Derived per-domain from the matrix `readings`.
 */
export function isDomainComplete(
  readings: { mastery: MasteryState }[],
): boolean {
  if (readings.length === 0) return false;
  return readings.every(
    (r) =>
      r.mastery === "placed" ||
      r.mastery === "fluent" ||
      r.mastery === "overlearned",
  );
}
