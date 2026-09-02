"use client";

import { useEffect, useRef } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import {
  defaultGroupForTeacher,
  groupMatchesParticipation,
} from "@/shared/scholarGroupRouting";

/**
 * Open a group-scoped surface on the caller's OWN group.
 *
 * A teacher who runs a cohort (`scholarGroups.ownerId`) almost always means
 * that cohort when they open the Scholars tab or the Math Skills studio —
 * "all scholars" is the school's view, not theirs. This applies their owned
 * group as the surface's INITIAL scope, once, as soon as the roster lands.
 *
 * Deliberately a default, not a preference:
 *   - `enabled` is false when the URL already carries an explicit scope, so a
 *     deep link / shared link always wins.
 *   - it fires at most once per mount (hit or miss), so switching to "All
 *     scholars" sticks for the rest of the session instead of snapping back.
 *   - a teacher who owns no group gets nothing applied, and the surface keeps
 *     its existing all-scholars default.
 *
 * `subject` narrows to a subject cohort first (the Math Skills studio passes
 * "math"); see `defaultGroupForTeacher` for the full fallback chain. The
 * roster query is shared with every other mounted consumer — Convex dedupes
 * the subscription — so calling this alongside `useScholarRoster` is free.
 */
export function useDefaultGroupScope({
  enabled,
  subject,
  apply,
  includeProgramGuests = true,
}: {
  /** False once the surface's scope came from the URL. */
  enabled: boolean;
  /** Subject key to prefer, e.g. "math". Omit for an unscoped surface. */
  subject?: string | null;
  /** Called at most once, with the resolved group id. */
  apply: (groupId: string) => void;
  /**
   * Whether a guest-inclusive group may be the default. A host whose
   * participation filter starts enrolled-only AND cannot widen it on apply
   * (the Math Skills studio) passes false, so it never defaults to a scope
   * its own filter hides. The Scholars tab keeps the default (true): its
   * apply callback widens participation instead, so a teacher whose own
   * cohort is guest-inclusive still auto-opens on it.
   */
  includeProgramGuests?: boolean;
}) {
  const { user } = useCurrentUser();
  const { groups, isLoading } = useScholarRoster();

  // Latched inside the effect, so a call site that rebuilds `apply` every
  // render just re-runs a guarded no-op rather than re-defaulting the scope.
  const appliedRef = useRef(false);

  useEffect(() => {
    if (appliedRef.current || !enabled) return;
    if (isLoading || !user) return;
    appliedRef.current = true;
    const candidateGroups = groups.filter((group) =>
      groupMatchesParticipation(group, includeProgramGuests),
    );
    const group = defaultGroupForTeacher(candidateGroups, user._id, subject);
    if (group) apply(group.id);
  }, [apply, enabled, groups, includeProgramGuests, isLoading, subject, user]);
}
