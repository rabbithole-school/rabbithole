"use client";

/**
 * Single source of truth for the glyph that represents the "scholar
 * angles" concept — each scholar's own angle on a `hasScholarAngles`
 * activity. Rendered by the scholar-facing banner (ScholarAngleBanner),
 * the teacher-facing angles panel (ActivityDetailPanels), and the
 * activity-designer toggle (ActivityFields) so the concept reads the
 * same everywhere and the iconography can't fragment (cf. activityMode's
 * one-icon-per-concept rule).
 *
 * Canonical glyph: Phosphor FlowArrow — one activity branching into
 * many scholar-chosen paths.
 */
import { FlowArrow, type IconWeight } from "@phosphor-icons/react";

export function ScholarAngleIcon({
  size = 14,
  weight = "regular",
  color,
}: {
  size?: number;
  weight?: IconWeight;
  color?: string;
}) {
  return <FlowArrow size={size} weight={weight} color={color} />;
}
