"use client";

/**
 * Curriculum tab — the unit index.
 *
 * A single list of units (filter by author / subject / grade, show-archived and
 * show-scholar-quests toggles, New unit), plus the header door into the
 * Components library
 * (perspectives / processes — flat lists that don't fit the unit tree).
 * Clicking a unit opens the unit surface at
 * /teacher/curriculum/<id> — the read view (summary), with Edit and Preflight
 * a tab away. The old in-dashboard read-only preview pane was retired
 * when the preview route folded into that unit surface as tabs; the
 * preview content now lives in UnitSummary (the Summary tab). See
 * review/curriculum-rehearse-and-maturity.md and
 * review/design-vs-execution-split.md.
 *
 * The list follows the institution switcher (`?inst=`), like the Quests
 * board: `units.listForBrowser` scopes scholar-authored (independent-study)
 * units to the active institution lens.
 *
 * Infinite scroll (TRA-468): the catalog arrives a page at a time, newest
 * first, and the next page loads as a sentinel below the last row nears the
 * viewport — no page controls. The Author / Subject / Grade / Archived /
 * scholar-quest filters are server-side args, so every page is already
 * filtered. Each row's second line names its subject and grade, so two
 * versions of one topic can be told apart without a class name in the title.
 *
 * Scholars' own Quests are hidden until the viewer asks for them: their home
 * is the Quests tab, and mixed in here they buried the reusable teacher units.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
// The convex-helpers hook, not convex/react's: `units.listForBrowser` paginates
// a filtered stream, which needs `endCursor` threaded back to keep reactive
// pages contiguous.
import { usePaginatedQuery } from "convex-helpers/react";
import {
  Box,
  Flex,
  HStack,
  IconButton,
  Portal,
  Stack,
  Tooltip,
} from "@chakra-ui/react";
import { PuzzlePiece } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ColumnHeader,
  EmojiPlaceholder,
  HierarchyListSkeleton,
  HierarchyRow,
} from "@/components/hierarchy";
import { Avatar } from "@/components/Avatar";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { isCurriculumRole, ROLES } from "@/convex/lib/roles";
import { subjectFilterKey } from "@/lib/subjects";
import { unitGradeDisplay } from "@/shared/unitGrade";
import {
  GradeFilterMenu,
  SubjectFilterChips,
  UnitAuthorFilterMenu,
} from "@/components/SubjectFilterChips";

/** Rows per fetch. A screenful-and-a-bit, so the first paint fills the column
 *  and the next page is usually in hand before the scroll reaches it. */
const PAGE_SIZE = 30;

export function CurriculumUnitsBrowser({
  leading,
  selectedUnitId,
  onOpenComponents,
}: {
  /** Left-aligned slot in the column header — e.g. the collapse chevron the
   *  column-view supplies once a unit is open. */
  leading?: ReactNode;
  /** The currently-open unit, highlighted in the list (Finder-style). */
  selectedUnitId?: Id<"units"> | null;
  /** Opens the Components library (perspectives / processes), owned by the
   *  Curriculum root. Omitted → the header action is not offered. */
  onOpenComponents?: () => void;
} = {}) {
  const router = useRouter();
  const { scopeParam } = useActiveInstitution();
  const { user: currentUser, isLoading: userLoading } = useCurrentUser();
  const [showArchived, setShowArchived] = useState(false);
  const [showScholarQuests, setShowScholarQuests] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [selectedGrade, setSelectedGrade] = useState<string | null>(null);
  // Derive the role-appropriate default until the viewer explicitly chooses a
  // filter. This avoids a transient "all" selection while auth resolves.
  const [authorFilterOverride, setAuthorFilterOverride] = useState<string | null>(
    null,
  );
  const meId = currentUser?._id ? String(currentUser._id) : "";
  const defaultsToOwnUnits =
    !!meId &&
    (currentUser?.role === ROLES.TEACHER ||
      (!!currentUser?.hasCurriculumAccess &&
        !isCurriculumRole(currentUser.role)));
  const createUnit = useMutation(api.units.create);

  // Menu options + the toggle counts come from a slim companion query, so
  // the menus span the whole catalog rather than just the loaded pages.
  // Subjects and authors only offer ones with a unit visible under the
  // archived and scholar-quest toggles.
  const filterOptions = useQuery(api.units.browserFilterOptions, {
    scope: scopeParam,
    showArchived,
    showScholarQuests,
  });
  const subjects = filterOptions?.subjects ?? [];
  const grades = filterOptions?.grades ?? [];
  const authorList = filterOptions?.authors ?? [];
  const archivedCount = filterOptions?.archivedCount ?? 0;
  const scholarQuestCount = filterOptions?.scholarQuestCount ?? 0;

  // Drop a pick the menus no longer offer once the options for the current
  // toggles arrive: hiding Quests removes their scholar authors (and any
  // subject only Quests had), and a stale pick would filter the list to
  // nothing under an "All authors" label or a hidden Subject menu. Reset
  // during render, not in an effect (`react-hooks/set-state-in-effect`).
  // A teacher's "Me" is always on the menu; an admin's only when they
  // author something visible.
  if (
    filterOptions &&
    authorFilterOverride !== null &&
    authorFilterOverride !== "all" &&
    !(defaultsToOwnUnits && authorFilterOverride === meId) &&
    !authorList.some((author) => author.id === authorFilterOverride)
  ) {
    setAuthorFilterOverride(null);
  }
  // A subject pick follows its subject when the menu relabels it (another
  // spelling became the most common) and is dropped when the menu no longer
  // offers it, or no longer shows (fewer than two subjects).
  if (filterOptions && selectedSubject !== null) {
    const key = subjectFilterKey(selectedSubject);
    const offered =
      subjects.length >= 2
        ? subjects.find((subject) => subjectFilterKey(subject) === key)
        : undefined;
    if (offered !== selectedSubject) setSelectedSubject(offered ?? null);
  }
  // Same for a grade: dropped when the menu no longer offers it or hides.
  if (
    filterOptions &&
    selectedGrade !== null &&
    !(grades.length >= 2 && grades.includes(selectedGrade))
  ) {
    setSelectedGrade(null);
  }
  const authorFilter =
    authorFilterOverride ?? (defaultsToOwnUnits ? meId : "all");
  // A Quest's author is its scholar, so under one staff author (a teacher's
  // default "Me") the toggle would reveal nothing. Still offered while on,
  // so it can be turned off.
  const offerScholarQuests =
    !!filterOptions?.hasScholarQuests &&
    (authorFilter === "all" || showScholarQuests);

  // Held until the viewer resolves: the author default depends on who they
  // are, and starting on "all" would fetch a page only to throw it away.
  const {
    results: visibleUnits,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.units.listForBrowser,
    userLoading
      ? "skip"
      : {
          scope: scopeParam,
          authorId:
            authorFilter === "all"
              ? undefined
              : (authorFilter as Id<"users">),
          subject: selectedSubject ?? undefined,
          grade: selectedGrade ?? undefined,
          showArchived,
          showScholarQuests,
        },
    { initialNumItems: PAGE_SIZE },
  );
  const firstPageLoading = userLoading || status === "LoadingFirstPage";

  // Infinite scroll: whenever the sentinel under the last row is within a
  // few rows of the column's viewport and more exist, fetch the next page.
  // Re-checked on every status change, so a short page (a filter that
  // matches sparsely) keeps loading until the column is full or exhausted.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [sentinelNear, setSentinelNear] = useState(false);
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setSentinelNear(entry.isIntersecting),
      { root, rootMargin: "0px 0px 320px 0px" },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      setSentinelNear(false);
    };
  }, [firstPageLoading]);
  useEffect(() => {
    if (sentinelNear && status === "CanLoadMore") loadMore(PAGE_SIZE);
  }, [sentinelNear, status, loadMore]);

  // Each unit row is a real link into the Curriculum column-view surface
  // (cmd-click opens a new tab). Existing units open on Summary (the bare
  // unit path); a brand-new unit opens on Edit (its Summary would be empty,
  // and the title field lives there now that the header's gone).
  const unitHref = (id: Id<"units">) => `/teacher/curriculum/${id}`;

  const handleCreateUnit = async () => {
    const id = await createUnit({ title: "Untitled unit" });
    router.push(`/teacher/curriculum/${id}/edit`);
  };

  return (
    <Flex
      direction="column"
      h="full"
      minH={0}
      bg="white"
      overflow="hidden"
      data-testid="curriculum-units-column"
    >
      {/* Author is the scope switch and sits in the header beside the
          Components door. Subject and Grade narrow within it on their own
          row, which can wrap: three menus and the door don't fit the
          header of a column this narrow. */}
      <ColumnHeader>
        <HStack gap={1} flex={1} minW={0}>
          {leading}
          <UnitAuthorFilterMenu
            authors={authorList}
            value={authorFilter}
            onChange={setAuthorFilterOverride}
            meId={defaultsToOwnUnits ? meId : ""}
            meName={currentUser?.name ?? undefined}
          />
          <Box flex={1} />
          {/* Components — the perspectives / processes library. Flat lists,
              not part of the unit tree, so they open as a drawer from here
              rather than claiming a column. No count: it's a door, not a
              metric. */}
          {onOpenComponents && (
            <Tooltip.Root openDelay={400} closeDelay={0}>
              <Tooltip.Trigger asChild>
                <IconButton
                  aria-label="Components"
                  size="xs"
                  variant="ghost"
                  color="charcoal.500"
                  _hover={{ color: "violet.600", bg: "gray.100" }}
                  onClick={onOpenComponents}
                >
                  <PuzzlePiece size={16} />
                </IconButton>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content fontFamily="heading" fontSize="xs">
                    Components — perspectives, processes
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          )}
        </HStack>
      </ColumnHeader>
      {(subjects.length >= 2 || grades.length >= 2) && (
        <Flex wrap="wrap" gap={1} px={2} pb={1} flexShrink={0}>
          <SubjectFilterChips
            subjects={subjects}
            selected={selectedSubject}
            onSelect={setSelectedSubject}
          />
          <GradeFilterMenu
            grades={grades}
            selected={selectedGrade}
            onSelect={setSelectedGrade}
          />
        </Flex>
      )}
      <Box ref={scrollRef} flex={1} minH={0} overflowY="auto" p={1.5}>
        {firstPageLoading ? (
          <HierarchyListSkeleton rows={6} />
          ) : (
            <Stack gap={0.5}>
              <Box minH="48px" display="flex" alignItems="stretch">
                <HierarchyRow
                  variant="create"
                  label="New unit"
                  onClick={handleCreateUnit}
                />
              </Box>
              {visibleUnits.length === 0 && status === "Exhausted" && (
                <HierarchyRow
                  variant="empty"
                  label={
                    selectedSubject || selectedGrade
                      ? "(no matching units)"
                      : "(no units yet)"
                  }
                />
              )}
              {visibleUnits.map((u) => (
                <HierarchyRow
                  key={u._id}
                  selected={u._id === selectedUnitId}
                  leading={u.emoji ? u.emoji : <EmojiPlaceholder />}
                  label={u.title}
                  sublabel={unitSublabel(u)}
                  accentBadge={
                    authorFilter === "all" && u.teacherId ? (
                      <Box
                        display="flex"
                        title={
                          u.teacherName ? `Authored by ${u.teacherName}` : undefined
                        }
                      >
                        <Avatar
                          name={u.teacherName ?? "?"}
                          colorKey={String(u.teacherId)}
                          size="2xs"
                        />
                      </Box>
                    ) : undefined
                  }
                  href={unitHref(u._id)}
                  trailing={{ kind: "chevron" }}
                />
              ))}
              {/* Infinite-scroll sentinel; the placeholder rows keep the
                  column from looking finished while the next page is out. */}
              <Box ref={sentinelRef} h="1px" aria-hidden />
              {status !== "Exhausted" && <HierarchyListSkeleton rows={2} />}
              {/* Shown whenever anything sits behind a toggle, even when its
                  count under the other toggle is zero (archived Quests only
                  appear with both on). */}
              {status === "Exhausted" &&
                (filterOptions?.hasArchived || offerScholarQuests) && (
                  <Flex justify="center" gap={4} pt={3} pb={2}>
                    {offerScholarQuests && (
                      <ListFooterToggle
                        on={showScholarQuests}
                        onToggle={() => setShowScholarQuests((v) => !v)}
                        label={
                          showScholarQuests
                            ? "Hide scholar quests"
                            : withCount("Show scholar quests", scholarQuestCount)
                        }
                      />
                    )}
                    {filterOptions?.hasArchived && (
                      <ListFooterToggle
                        on={showArchived}
                        onToggle={() => setShowArchived((v) => !v)}
                        label={
                          showArchived
                            ? "Hide archived"
                            : withCount("Show archived", archivedCount)
                        }
                      />
                    )}
                  </Flex>
                )}
            </Stack>
          )}
      </Box>
    </Flex>
  );
}

/** A row's second line: status when it isn't plain live, then subject,
 *  grade and lesson count ("Science · Grade 3–5 · 4 lessons"). */
function unitSublabel(unit: {
  isActive: boolean;
  unpublished: boolean;
  subject: string | null;
  gradeLevel: string | null;
  lessonCount: number;
}): string {
  const status = !unit.isActive
    ? "Archived"
    : unit.unpublished
      ? "Unpublished"
      : null;
  const lessons = unit.isActive
    ? `${unit.lessonCount} lesson${unit.lessonCount === 1 ? "" : "s"}`
    : null;
  return [status, unit.subject, unitGradeDisplay(unit.gradeLevel), lessons]
    .filter(Boolean)
    .join(" · ");
}

/** "Show archived (3)"; no "(0)" when this toggle alone reveals nothing. */
function withCount(label: string, count: number): string {
  return count > 0 ? `${label} (${count})` : label;
}

/** A quiet show/hide link under the last row (archived, scholar quests). */
function ListFooterToggle({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <Box
      as="button"
      onClick={onToggle}
      fontSize="2xs"
      color={on ? "violet.600" : "charcoal.400"}
      fontFamily="heading"
      fontWeight="600"
      _hover={{ color: "violet.700" }}
    >
      {label}
    </Box>
  );
}
