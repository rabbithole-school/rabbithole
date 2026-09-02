"use client";

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

// Shared "load + cache the roster" layer behind <ScholarPicker /> and the
// Scholars-tab group/affinity UI. Convex's useQuery dedupes across every
// component that mounts this hook, so calling it from several surfaces is
// cheap — they all share one subscription per underlying query.

export type RosterScholar = {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  readingLevel: string | null;
  /** Teacher-entered "tagged" grade ("K"…"8") from the profile; the soft enrollment notch. */
  gradeLevel: string | null;
  /** ISO "YYYY-MM-DD"; feeds the age-based (chronological) grade derivation client-side. */
  dateOfBirth: string | null;
  lastMessageAt: number | null;
  /** Groups this scholar belongs to (ids, as strings). */
  groupIds: string[];
  /** True if in the current teacher's "my scholars" affinity. */
  isMine: boolean;
  enrollmentStanding: "enrolled" | "program_guest";
};

export type RosterGroup = {
  id: string;
  name: string;
  emoji: string | null;
  scholarIds: string[];
  /** True if this whole group is in the teacher's affinity. */
  isMine: boolean;
  /** Optional tag, e.g. "math" — filters which pills a scoped surface shows. */
  type: string | null;
  /** Whether this group is limited to enrolled scholars or can include
   * Extended Education scholars. */
  participation: "enrolled_only" | "includes_program_guests";
  /** The staff member who runs this group — the default scope of the group-
   *  scoped surfaces they open. Not an ACL. */
  ownerId: string | null;
};

export function useScholarRosterQuery({
  institutionScope,
  includeProgramGuests = false,
  retainEnrolledFallback = true,
  enabled = true,
}: {
  institutionScope: string | undefined;
  includeProgramGuests?: boolean;
  retainEnrolledFallback?: boolean;
  enabled?: boolean;
}) {
  const queryEnabled = enabled && institutionScope !== undefined;
  const enrolledScholars = useQuery(
    api.users.listScholars,
    queryEnabled
      ? { includeProgramGuests: false, institutionScope }
      : "skip",
  );
  const scholarsWithProgramGuests = useQuery(
    api.users.listScholars,
    queryEnabled && includeProgramGuests
      ? { includeProgramGuests: true, institutionScope }
      : "skip",
  );

  // Convex returns undefined while a newly enabled query loads. Keep the
  // enrolled roster visible during that one-way expansion instead of replacing
  // the whole picker with its loading skeleton.
  return includeProgramGuests
    ? (scholarsWithProgramGuests ??
        (retainEnrolledFallback ? enrolledScholars : undefined))
    : enrolledScholars;
}

export function useScholarRoster({
  includeProgramGuests = false,
  retainEnrolledFallback = true,
  enabled = true,
}: {
  includeProgramGuests?: boolean;
  retainEnrolledFallback?: boolean;
  enabled?: boolean;
} = {}) {
  const { activeInstitution } = useActiveInstitution();
  const institutionScope =
    activeInstitution === undefined
      ? undefined
      : activeInstitution.scope === "all"
        ? "all"
        : activeInstitution.institutionSlug ?? "primary";
  const rawScholars = useScholarRosterQuery({
    institutionScope,
    includeProgramGuests,
    retainEnrolledFallback,
    enabled,
  });
  const rawGroups = useQuery(
    api.scholarGroups.list,
    !enabled || institutionScope === undefined ? "skip" : { institutionScope },
  );
  const affinity = useQuery(api.teacherAffinities.getMine, enabled ? {} : "skip");

  const toggleAffinityScholarMut = useMutation(
    api.teacherAffinities.toggleScholar,
  );
  const toggleAffinityGroupMut = useMutation(api.teacherAffinities.toggleGroup);

  const isLoading =
    enabled &&
    (rawScholars === undefined ||
      rawGroups === undefined ||
      affinity === undefined);

  const { scholars, groups, myScholarIds } = useMemo(() => {
    if (!rawScholars || !rawGroups || !affinity) {
      return {
        scholars: [] as RosterScholar[],
        groups: [] as RosterGroup[],
        myScholarIds: new Set<string>(),
      };
    }

    const affinityScholarSet = new Set(affinity.scholarIds.map(String));
    const affinityGroupSet = new Set(affinity.groupIds.map(String));
    const visibleScholarIds = new Set(rawScholars.map((scholar) => String(scholar.id)));

    // Effective "my scholars" = explicitly-marked scholars plus every
    // member of an explicitly-marked group.
    const mine = new Set<string>(affinityScholarSet);
    for (const g of rawGroups) {
      if (affinityGroupSet.has(String(g._id))) {
        for (const sid of g.scholarIds) {
          if (visibleScholarIds.has(String(sid))) mine.add(String(sid));
        }
      }
    }

    // Reverse index: scholar id -> group ids.
    const groupsByScholar = new Map<string, string[]>();
    for (const g of rawGroups) {
      for (const sid of g.scholarIds) {
        const key = String(sid);
        if (!visibleScholarIds.has(key)) continue;
        const arr = groupsByScholar.get(key) ?? [];
        arr.push(String(g._id));
        groupsByScholar.set(key, arr);
      }
    }

    const scholars: RosterScholar[] = rawScholars.map((s) => {
      const id = String(s.id);
      return {
        id,
        name: s.name ?? s.username ?? "(unnamed)",
        username: s.username ?? null,
        image: s.image ?? null,
        readingLevel: s.readingLevel ?? null,
        gradeLevel: s.gradeLevel ?? null,
        dateOfBirth: s.dateOfBirth ?? null,
        lastMessageAt: s.lastMessageAt ?? null,
        groupIds: groupsByScholar.get(id) ?? [],
        isMine: mine.has(id),
        enrollmentStanding: s.enrollmentStanding,
      };
    });

    const groups: RosterGroup[] = rawGroups.map((g) => ({
      id: String(g._id),
      name: g.name,
      emoji: g.emoji,
      scholarIds: g.scholarIds.map(String).filter((id) => visibleScholarIds.has(id)),
      isMine: affinityGroupSet.has(String(g._id)),
      type: g.type ?? null,
      participation: g.participation ?? "enrolled_only",
      ownerId: g.ownerId ? String(g.ownerId) : null,
    }));

    return { scholars, groups, myScholarIds: mine };
  }, [rawScholars, rawGroups, affinity]);

  return {
    isLoading,
    scholars,
    groups,
    myScholarIds,
    toggleAffinityScholar: (scholarId: string) =>
      toggleAffinityScholarMut({ scholarId: scholarId as Id<"users"> }),
    toggleAffinityGroup: (groupId: string) =>
      toggleAffinityGroupMut({ groupId: groupId as Id<"scholarGroups"> }),
  };
}
