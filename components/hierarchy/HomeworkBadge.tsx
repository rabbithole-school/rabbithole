"use client";

/**
 * Small "Homework" chip rendered with an activity's metadata. Used wherever an
 * activity surfaces — design-screen outline,
 * scholar progress strip, curriculum browser detail panel — so the
 * homework flag reads identically across every surface.
 *
 * Thin wrapper over the shared `lib/activityMode` source of truth so
 * the icon (Phosphor House) + orange tone stay in lockstep with every
 * other mode indicator. `compact` renders just the icon.
 */
import { ActivityModeBadge, ActivityModeIcon } from "@/lib/activityMode";

export function HomeworkBadge({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return <ActivityModeIcon mode="homework" size={12} />;
  }
  return <ActivityModeBadge mode="homework" variant="soft" />;
}
