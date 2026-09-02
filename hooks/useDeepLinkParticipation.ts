"use client";

import { useEffect, useRef } from "react";
import type { EnrollmentStanding } from "@/convex/lib/enrollmentStanding";
import type { ScholarGroupParticipation } from "@/shared/scholarGroupRouting";
import { deepLinkIncludesExtendedEducation } from "@/shared/scholarParticipation";

/**
 * Widen the Scholars-tab participation filter to include Extended Education when
 * the URL a visit ARRIVED on already points at a program guest — a deep/shared
 * link into an Extended-Education scholar, or into a guest-inclusive group.
 *
 * The enrolled-only default otherwise hides both signals: the roster omits every
 * program guest, so the rail renders empty even though the link named real
 * people the visitor can access. `useDefaultGroupScope` only covers the
 * auto-default path (it disables the moment the URL carries a group/scholar), so
 * this is its explicit-deep-link twin.
 *
 * Deliberately a default, not a lock — the mirror of `useDefaultGroupScope`:
 *   - fires at most once per mount (hit or miss), so a user's own later toggling
 *     of the Participation filter wins for the rest of the session;
 *   - waits for the signals it depends on to settle first — `groups` (each
 *     group's participation, off the ungated `scholarGroups.list`, so it is
 *     known while the roster is still enrolled-only) and, when the path names a
 *     scholar, that scholar's resolved standing.
 */

/**
 * Map the `scholars.resolveSlug` query result to a settled/loading standing.
 *
 * CRITICAL three-state distinction: `resolveSlug` returns `undefined` while the
 * query is IN FLIGHT and `null` when it RESOLVED to a miss (unknown / stale /
 * out-of-context slug). Optional-chaining `slugResolution?.enrollmentStanding`
 * collapses BOTH to `undefined`, so a resolved miss looks like "still loading"
 * and the widen never latches — a guest-inclusive `?group=` plus a bad scholar
 * slug then leaves the rail empty forever. Preserve `null` for a resolved miss.
 */
export function resolvedEnrollmentStanding(
  slugResolution:
    | { enrollmentStanding: EnrollmentStanding }
    | null
    | undefined,
): EnrollmentStanding | null | undefined {
  if (slugResolution === undefined) return undefined; // query in flight
  if (slugResolution === null) return null; // resolved to a miss
  return slugResolution.enrollmentStanding; // resolved to a scholar
}

type DeepLinkParticipationInputs = {
  enabled: boolean;
  scholarSlugPresent: boolean;
  /** `undefined` = still resolving; `null` = resolved miss; else the standing. */
  scholarEnrollmentStanding: EnrollmentStanding | null | undefined;
  groupId: string | null;
  groups: readonly { id: string; participation: ScholarGroupParticipation }[];
  rosterLoading: boolean;
};

/** "wait" = signals not settled; "widen" = latch and widen; "settle" = latch, no-op. */
export type DeepLinkParticipationDecision = "wait" | "widen" | "settle";

/**
 * Pure decision the effect below drives. Extracted so the resolved-miss-vs-
 * loading behavior is unit-testable without a DOM.
 */
export function decideDeepLinkParticipation({
  enabled,
  scholarSlugPresent,
  scholarEnrollmentStanding,
  groupId,
  groups,
  rosterLoading,
}: DeepLinkParticipationInputs): DeepLinkParticipationDecision {
  if (!enabled) return "wait";
  if (rosterLoading) return "wait";
  // Only `undefined` (still resolving) is "not settled". A resolved miss (null)
  // is settled — we latch and decide on the group signal alone.
  if (scholarSlugPresent && scholarEnrollmentStanding === undefined) {
    return "wait";
  }
  const scopedGroup =
    groupId && groupId !== "mine"
      ? groups.find((group) => group.id === groupId) ?? null
      : null;
  return deepLinkIncludesExtendedEducation({
    scholarEnrollmentStanding: scholarSlugPresent
      ? scholarEnrollmentStanding ?? null
      : null,
    scopedGroupParticipation: scopedGroup?.participation ?? null,
  })
    ? "widen"
    : "settle";
}

export function useDeepLinkParticipation({
  enabled = true,
  scholarSlugPresent,
  scholarEnrollmentStanding,
  groupId,
  groups,
  rosterLoading,
  apply,
}: {
  /** False when this surface must not widen (e.g. no deep-link context). */
  enabled?: boolean;
  /** Whether the path carries a scholar slug at all. */
  scholarSlugPresent: boolean;
  /** `undefined` while resolving, `null` on a resolved miss, else the standing. */
  scholarEnrollmentStanding: EnrollmentStanding | null | undefined;
  /** The `?group=` value (a group id, `"mine"`, or falsy). */
  groupId: string | null;
  /** The loaded groups, each carrying its participation. */
  groups: readonly { id: string; participation: ScholarGroupParticipation }[];
  /** True while the roster metadata (incl. `groups`) is still loading. */
  rosterLoading: boolean;
  /** Called at most once, only when the URL requires widening. */
  apply: () => void;
}) {
  // Latched inside the effect so a call site that rebuilds `apply` every render
  // just re-runs a guarded no-op rather than re-widening.
  const appliedRef = useRef(false);

  useEffect(() => {
    if (appliedRef.current) return;
    const decision = decideDeepLinkParticipation({
      enabled,
      scholarSlugPresent,
      scholarEnrollmentStanding,
      groupId,
      groups,
      rosterLoading,
    });
    if (decision === "wait") return;
    appliedRef.current = true;
    if (decision === "widen") apply();
  }, [
    apply,
    enabled,
    groupId,
    groups,
    rosterLoading,
    scholarEnrollmentStanding,
    scholarSlugPresent,
  ]);
}
