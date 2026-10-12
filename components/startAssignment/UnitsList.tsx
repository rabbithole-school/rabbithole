// The Unit column body of StartAssignmentDialog — the shared hierarchy
// primitive both modes open into. Only assignable units (active + ≥1 lesson)
// show; author/subject filters default to the picked unit's author.

import { HStack, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { EmojiPlaceholder, HierarchyRow } from "@/components/hierarchy";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  SubjectFilterChips,
  UnitAuthorFilterMenu,
  unitAuthorOptions,
  unitMatchesFilters,
} from "@/components/SubjectFilterChips";
import { uniqueSubjects } from "@/lib/subjects";
import { ColumnSpinner } from "./primitives";

export function UnitsList({
  units,
  pickedUnitId,
  authorFilterOverride,
  onAuthorFilterChange,
  selectedSubject,
  onSubjectChange,
  onPick,
  curriculumAccessDenied,
}: {
  units:
    | NonNullable<ReturnType<typeof useQuery<typeof api.units.list>>>
    | undefined;
  pickedUnitId: Id<"units"> | null;
  authorFilterOverride: string | null;
  onAuthorFilterChange: (value: string) => void;
  selectedSubject: string | null;
  onSubjectChange: (value: string | null) => void;
  onPick: (id: Id<"units">) => void;
  /** Program mode only: set once we know the caller lacks curriculum access
   *  at the program group's school, so an empty `units` list can name the
   *  reason instead of reading as "no units yet" (TRA-327). */
  curriculumAccessDenied?: { institutionName: string } | null;
}) {
  const { user: currentUser, isLoading: currentUserLoading } = useCurrentUser();

  if (units === undefined || currentUserLoading) return <ColumnSpinner />;
  if (curriculumAccessDenied) {
    return (
      <Stack gap={1} align="center" py={6} px={3} color="charcoal.400" textAlign="center">
        <Text fontFamily="heading" fontSize="sm" fontWeight="600">
          No curriculum access
        </Text>
        <Text fontSize="xs" fontFamily="body">
          You don’t have curriculum access at{" "}
          {curriculumAccessDenied.institutionName}, so you can’t add existing
          work here. Ask an admin for curriculum access.
        </Text>
      </Stack>
    );
  }
  const allActive = units.filter(
    (u) => u.isActive && (u.lessonCount ?? 0) > 0,
  );
  const meId = currentUser?._id ? String(currentUser._id) : "";
  const pickedUnit = allActive.find((unit) => unit._id === pickedUnitId);
  const defaultAuthorId =
    pickedUnit && String(pickedUnit.teacherId) !== meId
      ? String(pickedUnit.teacherId)
      : meId || "all";
  const authorFilter = authorFilterOverride ?? defaultAuthorId;
  const authors = unitAuthorOptions(allActive);
  const subjects = uniqueSubjects(allActive);
  const activeUnits = allActive.filter((unit) =>
    unitMatchesFilters(unit, authorFilter, selectedSubject),
  );
  if (allActive.length === 0) {
    // Only assignable units (active + ≥1 lesson) show here. Distinguish
    // "you have no units at all" from "you have units but none with
    // lessons yet" — the old copy claimed the former even when 35 empty
    // units existed.
    const hasAnyUnits = units.length > 0;
    return (
      <Stack gap={1} align="center" py={6} px={3} color="charcoal.400" textAlign="center">
        <Text fontFamily="heading" fontSize="sm" fontWeight="600">
          {hasAnyUnits ? "No units with lessons yet" : "No units yet"}
        </Text>
        <Text fontSize="xs" fontFamily="body">
          {hasAnyUnits
            ? "A unit needs at least one lesson before you can assign it. Add lessons in Curriculum."
            : "Create one in Curriculum."}
        </Text>
      </Stack>
    );
  }
  return (
    <>
      <HStack px={2} py={2} gap={1} flexWrap="wrap">
        <UnitAuthorFilterMenu
          authors={authors}
          value={authorFilter}
          onChange={onAuthorFilterChange}
          meId={meId}
          meName={currentUser?.name ?? undefined}
        />
        <SubjectFilterChips
          subjects={subjects}
          selected={selectedSubject}
          onSelect={onSubjectChange}
        />
      </HStack>
      {activeUnits.length === 0 ? (
        <Stack gap={1} align="center" py={4} color="charcoal.400">
          <Text fontSize="xs" fontFamily="body" fontStyle="italic">
            {selectedSubject
              ? "No units match these filters."
              : authorFilter === meId
                ? "No units authored by you."
                : "No units by this author."}
          </Text>
        </Stack>
      ) : (
        activeUnits.map((u) => (
          <HierarchyRow
            key={u._id}
            leading={u.emoji ? u.emoji : <EmojiPlaceholder />}
            selected={pickedUnitId === u._id}
            onClick={() => onPick(u._id)}
            label={u.title}
            sublabel={`${u.lessonCount} lesson${u.lessonCount === 1 ? "" : "s"}`}
            trailing={{ kind: "chevron" }}
          />
        ))
      )}
    </>
  );
}
