"use client";

/**
 * Curriculum tab — the unit index.
 *
 * A single list of units (filter by subject / author, show-archived
 * toggle, New unit), plus the header door into the Components library
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
 * viewport — no page controls. The Author / Subject / Archived filters are
 * server-side args, so every page is already filtered.
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
import {
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
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
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
  const authorFilter =
    authorFilterOverride ?? (defaultsToOwnUnits ? meId : "all");
  const createUnit = useMutation(api.units.create);

  // Menu options + the archived count come from a slim companion query, so
  // the menus span the whole catalog rather than just the loaded pages.
  // Subjects only offer ones with a unit visible under the archived toggle.
  const filterOptions = useQuery(api.units.browserFilterOptions, {
    scope: scopeParam,
    showArchived,
  });
  const subjects = filterOptions?.subjects ?? [];
  const authorList = filterOptions?.authors ?? [];
  const archivedCount = filterOptions?.archivedCount ?? 0;

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
          showArchived,
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
      <ColumnHeader
        leading={leading}
        action={
          <HStack gap={3}>
            <UnitAuthorFilterMenu
              authors={authorList}
              value={authorFilter}
              onChange={setAuthorFilterOverride}
              meId={defaultsToOwnUnits ? meId : ""}
              meName={currentUser?.name ?? undefined}
            />
            <HStack gap={1}>
              <SubjectFilterChips
                subjects={subjects}
                selected={selectedSubject}
                onSelect={setSelectedSubject}
              />
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
          </HStack>
        }
      />
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
                    selectedSubject ? "(no units in subject)" : "(no units yet)"
                  }
                />
              )}
              {visibleUnits.map((u) => (
                <HierarchyRow
                  key={u._id}
                  selected={u._id === selectedUnitId}
                  leading={u.emoji ? u.emoji : <EmojiPlaceholder />}
                  label={u.title}
                  sublabel={
                    u.isActive
                      ? `${u.unpublished ? "Unpublished · " : ""}${u.lessonCount} lesson${u.lessonCount === 1 ? "" : "s"}`
                      : "archived"
                  }
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
              {status === "Exhausted" && archivedCount > 0 && (
                <Flex justify="center" pt={3} pb={2}>
                  <Box
                    as="button"
                    onClick={() => setShowArchived((v) => !v)}
                    fontSize="2xs"
                    color={showArchived ? "violet.600" : "charcoal.400"}
                    fontFamily="heading"
                    fontWeight="600"
                    _hover={{ color: "violet.700" }}
                  >
                    {showArchived
                      ? "Hide archived"
                      : `Show archived (${archivedCount})`}
                  </Box>
                </Flex>
              )}
            </Stack>
          )}
      </Box>
    </Flex>
  );
}
