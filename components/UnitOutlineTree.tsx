"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import NextLink from "next/link";
import {
  Box,
  Flex,
  HStack,
  Menu,
  Spinner,
  Stack,
  VStack,
  Text,
  Badge,
  Tooltip,
  Portal,
} from "@chakra-ui/react";
import { CaretDown, CaretRight, FileText, Plus } from "@phosphor-icons/react";
import { STRAND_CONFIG, type Strand } from "@/lib/constants";
import { HierarchyTreeSkeleton } from "@/components/hierarchy";
import { NO_PROMPT_WARNING, type ActivityKind } from "@/lib/activityKinds";
import { ActivityKindIcon } from "./ActivityKindIcon";
import {
  ResourceShareCard,
  type ResourceShare,
} from "./ResourceShareCard";
import { DashedStatusCircle } from "./MaturityStatusDot";
import { ReadinessDot } from "./curriculumDoc/ReadinessGate";
import type { Readiness } from "@/convex/lib/unitMaturity";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { haptic } from "@/lib/native";
import { toaster } from "@/lib/toaster";

const STRAND_KEYS = ["core", "connections", "practice", "identity"] as const;
const OUTLINE_INDENT_PX = 24;
const OUTLINE_CHEVRON_W_PX = 20;
const OUTLINE_ICON_W_PX = 20;

export type ActivityCreationPreset = "activity" | "handout";
const OUTLINE_GAP_PX = 4;

export type TreeSelection =
  | { type: "unit"; unitId: Id<"units"> }
  | {
      type: "lesson";
      unitId: Id<"units">;
      lessonId: Id<"lessons">;
    }
  | {
      type: "activity";
      unitId: Id<"units">;
      lessonId: Id<"lessons">;
      activityId: Id<"activities">;
      kind?: ActivityKind;
      title?: string;
      description?: string | null;
    };

interface ActivityNode {
  _id: Id<"activities">;
  title: string;
  description: string | null;
  kind: ActivityKind;
  durationMinutes: number | null;
  hasPrompt: boolean;
  archivedAt?: number | null;
  resources?: Array<ResourceShare & { _id: Id<"activityResources"> }>;
}

interface LessonWithMeta {
  _id: Id<"lessons">;
  title: string;
  strand: string | null;
  order: number;
  processTitle: string | null;
  processEmoji: string | null;
  durationMinutes: number | null;
}

interface UnitOutlineTreeProps {
  unitId: Id<"units">;
  /** "design" lets the teacher click any node; "pick" is for scholars selecting a starting point. */
  mode: "design" | "pick";
  /** Currently focused node — drives the highlighted row in design mode. */
  selected?: TreeSelection | null;
  onSelect: (sel: TreeSelection) => void;
  /**
   * Optional: when provided, rows render as Next.js `<Link>` elements
   * with the returned href. Cmd/ctrl-click opens the row in a new tab.
   * Regular click navigates via the router AND fires onSelect (so any
   * side-effects like auto-expanding a lesson still run).
   */
  getHref?: (sel: TreeSelection) => string;
  /** Optional: in design mode, a callback to add a lesson to the unit (rendered as the "+ New lesson" button). New lessons are untagged; the teacher can tag a strand afterward. */
  onAddLesson?: () => void;
  /** Optional: in design mode, callback to add an activity under a lesson. */
  onAddActivity?: (
    lessonId: Id<"lessons">,
    preset: ActivityCreationPreset,
  ) => Promise<Id<"activities">>;
  /** Show "Independent Study" option as a sibling of the unit (pick mode only). */
  showIndependentStudy?: boolean;
  onIndependentStudy?: () => void;
  /** Scholar whose completions drive the checkmarks. Omit = current user. */
  scholarId?: Id<"users"> | null;
  /** Optional assignment scope for completion checkmarks. */
  assignmentId?: Id<"assignments"> | null;
  /**
   * When true (and mode="pick"), offline activities are clickable and emit
   * onSelect with kind="offline". The consumer is expected to route to a
   * "mark complete" UI rather than starting a project.
   */
  enableOfflinePick?: boolean;
  /**
   * When true, every lesson is rendered expanded with its activities and
   * the per-lesson collapse chevron is hidden. Useful for surfaces (like the
   * scholar nav modal) where the user picked "show me everything".
   */
  alwaysExpanded?: boolean;
  /**
   * Show the per-node maturity status dot (in place of the duration tag)
   * on the unit / lesson / activity rows. Drives a `getNodeStatuses`
   * subscription, which requires unit-edit access — so the designer only
   * sets this for curriculum roles (`!hideBot`), never a scholar editing
   * their own IS unit. Design mode only.
   */
  showStatus?: boolean;
  /**
   * Optional actions rendered on the unit row (design mode) — the unit's
   * lifecycle ⋮ menu, rehomed here from the retired chunky header.
   */
  unitActions?: React.ReactNode;
  /**
   * Hide the top-level unit row entirely (design mode). Used by the curriculum
   * document view, where the unit's identity lives in a sticky doc header and
   * its overview is the first full-bleed page — so the rail is just the
   * lessons/activities, one level shallower.
   */
  hideUnitRow?: boolean;
}

// Drag item id formats:
//   lesson:<lessonId>
//   activity:<activityId>
// Sortable container ids:
//   lessons:<unitId>       (all lessons in the unit — one flat list)
//   activities:<lessonId>
function lessonDragId(id: Id<"lessons">) {
  return `lesson:${String(id)}`;
}
function activityDragId(id: Id<"activities">) {
  return `activity:${String(id)}`;
}

export function UnitOutlineTree({
  unitId,
  mode,
  selected,
  onSelect,
  getHref,
  onAddLesson,
  onAddActivity,
  showIndependentStudy,
  onIndependentStudy,
  scholarId,
  assignmentId,
  enableOfflinePick,
  alwaysExpanded,
  showStatus,
  unitActions,
  hideUnitRow,
}: UnitOutlineTreeProps) {
  const unit = useQuery(api.units.get, { id: unitId });
  // Per-node maturity status for the dots — only when the designer asks
  // (curriculum roles; scholar-authored IS units skip it, see prop doc).
  const nodeStatuses = useQuery(
    api.unitMaturity.getNodeStatuses,
    showStatus && mode === "design" ? { unitId } : "skip",
  );
  const lessons = useQuery(api.lessons.listByUnitPublic, { unitId }) as
    | LessonWithMeta[]
    | undefined;
  // Single query for ALL activities in the unit, grouped client-side. Avoids
  // N+1 (was: one query per LessonGroup). Design surfaces include archived
  // activities (rendered dimmed, collapsed behind a per-lesson toggle); scholar
  // "pick" surfaces omit them so archived work never appears as startable.
  const includeArchived = mode === "design";
  const activityQueryArgs = {
    unitId,
    ...(assignmentId ? { assignmentId } : {}),
    ...(includeArchived ? { includeArchived: true } : {}),
    ...(mode === "pick" ? { includeResources: true } : {}),
  };
  const allActivities = useQuery(
    api.activities.listByUnitPublic,
    activityQueryArgs,
  );

  // Convex optimistic updates: write the new order directly into the local
  // query cache so `useQuery` returns the reordered list synchronously on
  // drop. Avoids the flicker between manual local state and the server-
  // confirmed query result. The cached value is automatically reverted if
  // the mutation fails.
  const reorderLessons = useMutation(api.lessons.reorder).withOptimisticUpdate(
    (localStore, args) => {
      const current = localStore.getQuery(api.lessons.listByUnitPublic, {
        unitId,
      });
      if (!current) return;
      const byId = new Map(current.map((l) => [String(l._id), l]));
      // Apply strand updates first.
      if (args.strandUpdates) {
        for (const u of args.strandUpdates) {
          const l = byId.get(String(u.id));
          if (l) byId.set(String(u.id), { ...l, strand: u.strand });
        }
      }
      // Build the new ordered list. Preserve any lessons not in lessonIds
      // (defensive; in practice the client always sends a complete list).
      const ordered: typeof current = [];
      const seen = new Set<string>();
      args.lessonIds.forEach((id, i) => {
        const l = byId.get(String(id));
        if (l) {
          ordered.push({ ...l, order: i });
          seen.add(String(id));
        }
      });
      for (const l of current) {
        if (!seen.has(String(l._id))) ordered.push(l);
      }
      localStore.setQuery(
        api.lessons.listByUnitPublic,
        { unitId },
        ordered,
      );
    },
  );

  const reorderActivities = useMutation(
    api.activities.reorder,
  ).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(
      api.activities.listByUnitPublic,
      activityQueryArgs,
    );
    if (!current) return;
    const byId = new Map(current.map((a) => [String(a._id), a]));
    const reorderIds = new Set(args.activityIds.map(String));
    // The reordered list applies only to activities sharing one lesson; we
    // need to find that lesson and replace its slice with the new ordering,
    // leaving every other activity alone.
    const firstId = args.activityIds[0];
    const firstAct = firstId ? byId.get(String(firstId)) : undefined;
    if (!firstAct) return;
    const lessonId = firstAct.lessonId;
    const next = current.map((a) => {
      if (String(a.lessonId) !== String(lessonId)) return a;
      if (!reorderIds.has(String(a._id))) return a;
      const idx = args.activityIds.findIndex(
        (id) => String(id) === String(a._id),
      );
      return idx >= 0 ? { ...a, order: idx } : a;
    });
    next.sort((a, b) => a.order - b.order);
    localStore.setQuery(
      api.activities.listByUnitPublic,
      activityQueryArgs,
      next,
    );
  });

  const activitiesByLesson = useMemo(() => {
    const m = new Map<string, ActivityNode[]>();
    for (const a of allActivities ?? []) {
      const key = String(a.lessonId);
      const list = m.get(key);
      if (list) list.push(a);
      else m.set(key, [a]);
    }
    return m;
  }, [allActivities]);
  const completions = useQuery(api.activityCompletions.listForScholarInUnit, {
    unitId,
    scholarId: scholarId ?? undefined,
    assignmentId: assignmentId ?? undefined,
  });
  const completedSet = useMemo(() => {
    const s = new Set<string>();
    for (const c of completions ?? []) s.add(String(c.activityId));
    return s;
  }, [completions]);

  // Lessons start expanded by default. Once the user explicitly collapses any
  // lesson we stop auto-populating from new server data, so their interaction
  // sticks. Selecting an activity always re-expands its parent lesson.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const userTouchedRef = useRef(false);
  useEffect(() => {
    if (userTouchedRef.current) return;
    if (!lessons) return;
    // Auto-expand all lessons until user explicitly collapses one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(new Set(lessons.map((l) => String(l._id))));
  }, [lessons]);
  useEffect(() => {
    if (selected?.type === "activity") {
      // Re-expand parent lesson when an activity is selected.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(String(selected.lessonId));
        return next;
      });
    }
  }, [selected]);

  const toggleLesson = (lessonId: Id<"lessons">) => {
    userTouchedRef.current = true;
    setExpanded((prev) => {
      const next = new Set(prev);
      const key = String(lessonId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const sortedLessons = useMemo(() => {
    if (!lessons) return [];
    return [...lessons].sort((a, b) => a.order - b.order);
  }, [lessons]);

  // Drag enabled only for design mode.
  const dragEnabled = mode === "design";
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 5px movement before activating, so single clicks still register.
      activationConstraint: { distance: 5 },
    }),
    // Keyboard support: focus a sortable row, press Space/Enter to pick up,
    // arrow keys to move, Space/Enter to drop, Esc to cancel.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function findLessonById(id: string): LessonWithMeta | undefined {
    return lessons?.find((l) => String(l._id) === id);
  }
  function findActivityById(id: string) {
    return allActivities?.find((a) => String(a._id) === id);
  }

  // Track the currently dragged item so we can render a clone in the
  // <DragOverlay>. The overlay clone is what visually follows the pointer
  // and animates into place on drop — the underlying sortable item stays
  // dimmed in its slot, and dnd-kit's built-in drop animation handles the
  // glide-into-place without us managing transforms by hand.
  const [activeDrag, setActiveDrag] = useState<
    | { kind: "lesson"; lesson: LessonWithMeta }
    | { kind: "activity"; act: ActivityNode }
    | null
  >(null);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith("lesson:")) {
      const lesson = findLessonById(id.slice("lesson:".length));
      if (lesson) setActiveDrag({ kind: "lesson", lesson });
    } else if (id.startsWith("activity:")) {
      const act = findActivityById(id.slice("activity:".length));
      if (act) setActiveDrag({ kind: "activity", act });
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;
    haptic("selection"); // reorder landed

    if (activeId.startsWith("lesson:")) {
      // Reorder lessons within the unit's single flat list. Strand is a
      // free tag now, not a bucket — dragging never changes a lesson's
      // strand, only its `order`.
      const movedId = activeId.slice("lesson:".length);
      const fromIndex = sortedLessons.findIndex(
        (l) => String(l._id) === movedId,
      );
      if (fromIndex < 0) return;

      // The drop target is another lesson row (drop before/at its slot) or
      // the whole-list container (drop at the end).
      let toIndex = sortedLessons.length - 1;
      if (overId.startsWith("lesson:")) {
        const overLessonId = overId.slice("lesson:".length);
        const idx = sortedLessons.findIndex(
          (l) => String(l._id) === overLessonId,
        );
        if (idx >= 0) toIndex = idx;
      } else if (!overId.startsWith("lessons:")) {
        return;
      }

      const reordered = arrayMove(sortedLessons, fromIndex, toIndex);
      const ids = reordered.map((l) => l._id);

      // Convex's withOptimisticUpdate handles the cache update synchronously,
      // so useQuery returns the new order immediately on drop. No flicker
      // when the server confirms.
      try {
        await reorderLessons({ lessonIds: ids });
      } catch (err) {
        console.error("[UnitOutlineTree] lessons.reorder failed", err);
      }
      return;
    }

    if (activeId.startsWith("activity:")) {
      const movedId = activeId.slice("activity:".length);
      const moved = findActivityById(movedId);
      if (!moved || !allActivities) return;

      // Activities only reorder within their own lesson.
      let overLessonScope: Id<"lessons"> | null = null;
      let overActivityId: string | null = null;
      if (overId.startsWith("activity:")) {
        overActivityId = overId.slice("activity:".length);
        const overAct = findActivityById(overActivityId);
        if (!overAct) return;
        // Reorder is lesson-scoped — skip if the target activity is quest-only.
        if (!overAct.lessonId) return;
        overLessonScope = overAct.lessonId;
      } else if (overId.startsWith("activities:")) {
        overLessonScope = overId.slice(
          "activities:".length,
        ) as Id<"lessons">;
      } else {
        return;
      }

      // Cross-lesson activity drags are not supported (yet); ignore.
      if (String(overLessonScope) !== String(moved.lessonId)) return;

      const within = (allActivities ?? [])
        .filter((a) => String(a.lessonId) === String(moved.lessonId))
        // Archived rows live outside the ordered list (not draggable, hidden
        // behind the toggle) — reordering actives must not renumber them.
        .filter((a) => !a.archivedAt)
        .slice()
        .sort((a, b) => a.order - b.order);

      // Use arrayMove instead of filter-then-splice; the latter has an
      // off-by-one bug for downward drags (over-index shifts after remove).
      const fromIndex = within.findIndex((a) => String(a._id) === movedId);
      let toIndex = within.length - 1;
      if (overActivityId && overActivityId !== movedId) {
        const idx = within.findIndex((a) => String(a._id) === overActivityId);
        if (idx >= 0) toIndex = idx;
      }
      if (fromIndex < 0) return;
      const reordered = arrayMove(within, fromIndex, toIndex);

      const newWithin = reordered.map((a, i) => ({ ...a, order: i }));

      try {
        await reorderActivities({
          activityIds: newWithin.map((a) => a._id),
        });
      } catch (err) {
        console.error("[UnitOutlineTree] activities.reorder failed", err);
      }
      return;
    }
  };

  if (unit === undefined || lessons === undefined) {
    return <HierarchyTreeSkeleton />;
  }
  if (unit === null) return null;

  const isUnitSelected = selected?.type === "unit" && selected.unitId === unitId;

  // Empty-unit recovery for scholars: in pick mode, if the unit has
  // no lessons at all there's nothing to render and no path to a
  // tutor session. The teacher set a focus on a unit they haven't
  // populated yet. Surface that explicitly instead of leaving a
  // dead-end "Pick an activity" button.
  if (mode === "pick" && lessons.length === 0 && !showIndependentStudy) {
    return (
      <VStack align="center" gap={2} py={8} px={6} textAlign="center">
        <Text fontSize="2xl">🚧</Text>
        <Text
          fontFamily="heading"
          fontWeight="700"
          color="navy.500"
          fontSize="md"
        >
          {unit.title} doesn&apos;t have any activities yet
        </Text>
        <Text
          fontSize="sm"
          color="charcoal.400"
          fontFamily="body"
          maxW="360px"
        >
          Your teacher hasn&apos;t added work to this unit yet. Ask
          them to fill it in — or pick something else to work on.
        </Text>
      </VStack>
    );
  }

  const tree = (
    <VStack align="stretch" gap={0} px={2} py={2}>
      {/* Unit-level row — click to edit unit fields (subject, big idea, EQs, EUs).
          Hidden in pick mode where it would just duplicate the modal title, and
          hidden when the consumer owns the unit header itself (hideUnitRow). */}
      {mode === "design" && !hideUnitRow && (
        <NodeRow
          kind="unit"
          title={unit.title}
          subtitle="Unit-level summary"
          selected={isUnitSelected}
          depth={0}
          prominent
          onClick={() => onSelect({ type: "unit", unitId })}
          href={getHref ? getHref({ type: "unit", unitId }) : undefined}
          rightSlot={
            nodeStatuses || unitActions ? (
              <HStack gap={1} flexShrink={0}>
                {nodeStatuses && (
                  <ReadinessDot readiness={nodeStatuses.readiness.unit} />
                )}
                {unitActions}
              </HStack>
            ) : undefined
          }
        />
      )}

      {showIndependentStudy && onIndependentStudy && (
        <NodeRow
          kind="independent"
          title="Independent Study"
          emoji="🌱"
          subtitle="Open-ended exploration with this unit"
          depth={1}
          selected={false}
          onClick={onIndependentStudy}
        />
      )}

      {/* Lessons as one flat, freely-ordered list. Strand is a per-lesson
          tag (a chip on the row), not a section — lessons can be sequenced
          in any order. A single quiet "New lesson" row sits at the bottom. */}
      {(() => {
        const lessonRows = (
          <VStack align="stretch" gap={0} mt={1}>
            {sortedLessons.map((lesson) => (
              <LessonGroup
                key={String(lesson._id)}
                unitId={unitId}
                lesson={lesson}
                activities={
                  allActivities === undefined
                    ? undefined
                    : activitiesByLesson.get(String(lesson._id)) ?? []
                }
                expanded={alwaysExpanded || expanded.has(String(lesson._id))}
                onToggle={() => toggleLesson(lesson._id)}
                selected={selected}
                onSelect={onSelect}
                getHref={getHref}
                mode={mode}
                onAddActivity={onAddActivity}
                completedSet={completedSet}
                enableOfflinePick={enableOfflinePick}
                hideChevron={alwaysExpanded}
                dragEnabled={dragEnabled}
                lessonReadiness={
                  nodeStatuses?.readiness.lessons[String(lesson._id)]
                }
                activityReadiness={nodeStatuses?.readiness.activities}
              />
            ))}
          </VStack>
        );
        return (
          <Box>
            {dragEnabled ? (
              <SortableContext
                id={`lessons:${String(unitId)}`}
                items={sortedLessons.map((l) => lessonDragId(l._id))}
                strategy={verticalListSortingStrategy}
              >
                {lessonRows}
              </SortableContext>
            ) : (
              lessonRows
            )}
            {mode === "design" && onAddLesson && (
              <AddRow label="New lesson" depth={0} onClick={onAddLesson} />
            )}
          </Box>
        );
      })()}
    </VStack>
  );

  if (!dragEnabled) return tree;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      {tree}
      <DragOverlay>
        {activeDrag?.kind === "lesson" ? (
          <LessonRowPreview
            lesson={activeDrag.lesson}
            activities={
              activitiesByLesson.get(String(activeDrag.lesson._id)) ?? []
            }
          />
        ) : activeDrag?.kind === "activity" ? (
          <ActivityRowPreview act={activeDrag.act} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ── Strand chip ───────────────────────────────────────────────────────────
// Compact per-lesson tag chip. Strand is a free label now (no section
// headers), so each tagged lesson wears its strand as a small tinted chip.
function StrandChip({ strand }: { strand: Strand }) {
  const cfg = STRAND_CONFIG[strand];
  const Icon = cfg.icon;
  return (
    <Badge
      bg="white"
      color="gray.600"
      fontFamily="heading"
      fontSize="2xs"
      flexShrink={0}
      display="inline-flex"
      alignItems="center"
      gap={1}
    >
      <Icon size={10} weight="bold" />
      {cfg.label}
    </Badge>
  );
}

// ── DragOverlay clones ────────────────────────────────────────────────────
// Plain (non-sortable) renders of the lesson row and activity row used as
// the dragged clone in <DragOverlay>. The overlay handles its own
// positioning + drop animation, so these don't need useSortable wiring.

function LessonRowPreview({
  lesson,
  activities,
}: {
  lesson: LessonWithMeta;
  activities: ActivityNode[];
}) {
  return (
    <Box bg="white" boxShadow="lg" borderRadius="md" opacity={0.95}>
      <NodeRow
        kind="lesson"
        title={lesson.title}
        selected={false}
        depth={0}
        chevron={null}
        onClick={() => {}}
        rightSlot={
          <HStack gap={1} flexShrink={0}>
            {(STRAND_KEYS as readonly string[]).includes(
              lesson.strand ?? "",
            ) && <StrandChip strand={lesson.strand as Strand} />}
            {lesson.durationMinutes && (
              <Badge bg="gray.100" color="charcoal.500" fontSize="2xs">
                {lesson.durationMinutes}m
              </Badge>
            )}
          </HStack>
        }
      />
      {activities.map((act) => (
        <NodeRow
          key={String(act._id)}
          kind={
            act.kind === "online"
              ? "activity-online"
              : act.kind === "shareBack"
                ? "activity-shareback"
                : "activity-offline"
          }
          title={act.title}
          selected={false}
          depth={1}
          onClick={() => {}}
        />
      ))}
    </Box>
  );
}

function ActivityRowPreview({ act }: { act: ActivityNode }) {
  return (
    <Box bg="white" boxShadow="lg" borderRadius="md" opacity={0.95}>
      <NodeRow
        kind={
          act.kind === "online"
            ? "activity-online"
            : act.kind === "shareBack"
              ? "activity-shareback"
              : "activity-offline"
        }
        title={act.title}
        selected={false}
        depth={1}
        onClick={() => {}}
      />
    </Box>
  );
}

// ── Lesson + its activities ─────────────────────────────────────────────

interface LessonGroupProps {
  unitId: Id<"units">;
  lesson: LessonWithMeta;
  /** Pre-fetched and pre-filtered for this lesson by the parent
   *  UnitOutlineTree (single unit-wide query, see `listByUnitPublic`). */
  activities: ActivityNode[] | undefined;
  expanded: boolean;
  onToggle: () => void;
  selected?: TreeSelection | null;
  onSelect: (sel: TreeSelection) => void;
  getHref?: (sel: TreeSelection) => string;
  mode: "design" | "pick";
  onAddActivity?: (
    lessonId: Id<"lessons">,
    preset: ActivityCreationPreset,
  ) => Promise<Id<"activities">>;
  completedSet: Set<string>;
  enableOfflinePick?: boolean;
  hideChevron?: boolean;
  dragEnabled?: boolean;
  /** Design-mode readiness micro-strip for this lesson (matches the header pill). */
  lessonReadiness?: Readiness;
  /** Per-activity readiness keyed by activity id — drives each row's micro-strip. */
  activityReadiness?: Record<string, Readiness>;
}

function LessonGroup({
  unitId,
  lesson,
  activities,
  expanded,
  onToggle,
  selected,
  onSelect,
  getHref,
  mode,
  onAddActivity,
  completedSet,
  enableOfflinePick,
  hideChevron,
  dragEnabled,
  lessonReadiness,
  activityReadiness,
}: LessonGroupProps) {
  const isLessonSelected =
    selected?.type === "lesson" && selected.lessonId === lesson._id;
  // Archived activities (design mode only) start collapsed behind a toggle.
  const [showArchived, setShowArchived] = useState(false);
  const [creatingPreset, setCreatingPreset] =
    useState<ActivityCreationPreset | null>(null);

  const createFromPreset = async (preset: ActivityCreationPreset) => {
    if (!onAddActivity || creatingPreset) return;
    setCreatingPreset(preset);
    try {
      await onAddActivity(lesson._id, preset);
    } catch (error) {
      toaster.error({
        title: preset === "handout" ? "Couldn’t create handout" : "Couldn’t create activity",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreatingPreset(null);
    }
  };

  const lessonCompletionCount = (activities ?? []).filter((a) =>
    completedSet.has(String(a._id)),
  ).length;
  const lessonTotalCount = activities?.length ?? 0;
  const lessonAllDone =
    lessonTotalCount > 0 && lessonCompletionCount === lessonTotalCount;

  // Strand is an optional tag now; coerce an unknown/empty value to null so
  // an untagged lesson simply shows no chip.
  const strand: Strand | null = (STRAND_KEYS as readonly string[]).includes(
    lesson.strand ?? "",
  )
    ? (lesson.strand as Strand)
    : null;

  const handleLessonRowClick = () => {
    onSelect({
      type: "lesson",
      unitId,
      lessonId: lesson._id,
    });
    if (!hideChevron && !expanded) onToggle();
  };

  // Sortable wiring for the lesson row.
  const sortable = useSortable({
    id: lessonDragId(lesson._id),
    disabled: !dragEnabled,
  });
  const lessonRowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.5 : 1,
  };

  const activeActs = (activities ?? []).filter((a) => !a.archivedAt);
  const archivedActs = (activities ?? []).filter((a) => !!a.archivedAt);
  const selectedArchivedActivityId =
    selected?.type === "activity" &&
    archivedActs.some((a) => a._id === selected.activityId)
      ? selected.activityId
      : null;
  useEffect(() => {
    if (selectedArchivedActivityId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- selecting an archived row permanently reveals archived activities for this lesson.
      setShowArchived(true);
    }
  }, [selectedArchivedActivityId]);
  const activityIds = activeActs.map((a) => activityDragId(a._id));

  const renderActivityRow = (act: ActivityNode) => {
    const isActSelected =
      selected?.type === "activity" && selected.activityId === act._id;
    const pickable =
      mode === "design" || act.kind === "online" || !!enableOfflinePick;
    const isCompleted = completedSet.has(String(act._id));
    const sel: TreeSelection = {
      type: "activity",
      unitId,
      lessonId: lesson._id,
      activityId: act._id,
      kind: act.kind,
      title: act.title,
      description: act.description ?? null,
    };
    return (
      <ActivityRow
        key={String(act._id)}
        act={act}
        isSelected={isActSelected}
        isCompleted={isCompleted}
        pickable={pickable}
        // Archived rows are never draggable (they live outside the ordered list).
        dragEnabled={!!dragEnabled && !act.archivedAt}
        readiness={activityReadiness?.[String(act._id)]}
        onClick={pickable ? () => onSelect(sel) : undefined}
        href={pickable && getHref ? getHref(sel) : undefined}
      />
    );
  };

  const activitiesBody = (
    <VStack align="stretch" gap={0} mt={0.5} mb={1}>
      {activeActs.map(renderActivityRow)}
      {mode === "design" && onAddActivity && (
        <AddActivityMenu
          depth={1}
          creatingPreset={creatingPreset}
          onCreate={createFromPreset}
        />
      )}
      {archivedActs.length > 0 && (
        <>
          <ArchivedToggleRow
            count={archivedActs.length}
            open={showArchived}
            onToggle={() => setShowArchived((v) => !v)}
          />
          {showArchived && archivedActs.map(renderActivityRow)}
        </>
      )}
    </VStack>
  );

  // Visual transform on the OUTER Box so the whole group (header +
  // activities) lifts/shifts together during drag. setNodeRef stays on
  // the INNER header so dnd-kit measures only the header rect for
  // collision detection — otherwise closestCenter targets the middle
  // of the entire (tall) group rather than the header line, which
  // skews drop targeting downward. Listeners are on the header Box so
  // clicking/dragging an activity row below doesn't initiate a
  // lesson-level drag.
  return (
    <Box style={lessonRowStyle}>
      {/* dnd-kit's useSortable hook returns ref/attributes/listeners that must be
          attached during render. The eslint react-hooks/refs rule misfires here. */}
      <Box
        // eslint-disable-next-line react-hooks/refs
        ref={sortable.setNodeRef}
        // eslint-disable-next-line react-hooks/refs
        {...(dragEnabled ? sortable.attributes : {})}
        // eslint-disable-next-line react-hooks/refs
        {...(dragEnabled ? sortable.listeners : {})}
      >
        <NodeRow
          kind="lesson"
          title={lesson.title}
          selected={isLessonSelected}
          depth={0}
          chevron={
            hideChevron
              ? undefined
              : activities === undefined
              ? null
              : expanded
                ? <CaretDown size={12} />
                : <CaretRight size={12} />
          }
          onChevronClick={hideChevron ? undefined : onToggle}
          onClick={handleLessonRowClick}
          href={
            getHref
              ? getHref({
                  type: "lesson",
                  unitId,
                  lessonId: lesson._id,
                })
              : undefined
          }
          rightSlot={
            <HStack gap={1} flexShrink={0}>
              {/* Strand is a free tag — surface it as a chip on the row
                  itself (there are no strand section headers anymore). */}
              {strand && <StrandChip strand={strand} />}
              {/* Completion count is a scholar concept — only show in pick mode. */}
              {mode === "pick" && activities && activities.length > 0 && (
                <Badge
                  bg={lessonAllDone ? "green.100" : "gray.100"}
                  color={lessonAllDone ? "green.700" : "charcoal.500"}
                  fontSize="2xs"
                >
                  {lessonAllDone ? "✓ " : ""}
                  {lessonCompletionCount}/{lessonTotalCount}
                </Badge>
              )}
              {/* Design mode shows the maturity dot in place of the duration
                  tag; pick mode (scholars) keeps the duration. */}
              {mode === "design" ? (
                lessonReadiness ? (
                  <ReadinessDot readiness={lessonReadiness} />
                ) : null
              ) : (
                lesson.durationMinutes && (
                  <Badge bg="gray.100" color="charcoal.500" fontSize="2xs">
                    {lesson.durationMinutes}m
                  </Badge>
                )
              )}
            </HStack>
          }
        />
      </Box>
      {expanded && activities && (
        dragEnabled ? (
          <SortableContext
            id={`activities:${String(lesson._id)}`}
            items={activityIds}
            strategy={verticalListSortingStrategy}
          >
            {activitiesBody}
          </SortableContext>
        ) : (
          activitiesBody
        )
      )}
    </Box>
  );
}

// ── Activity row (sortable wrapper) ─────────────────────────────────────

function ActivityRow({
  act,
  isSelected,
  isCompleted,
  pickable,
  dragEnabled,
  readiness,
  onClick,
  href,
}: {
  act: ActivityNode;
  isSelected: boolean;
  isCompleted: boolean;
  pickable: boolean;
  dragEnabled: boolean;
  /** Design-mode readiness micro-strip (replaces the duration tag). Undefined in
   *  pick mode and while the status query is still loading. */
  readiness?: Readiness;
  onClick?: () => void;
  href?: string;
}) {
  const sortable = useSortable({
    id: activityDragId(act._id),
    disabled: !dragEnabled,
  });
  const isArchived = !!act.archivedAt;
  const showPromptWarning =
    !isArchived && !isCompleted && act.kind === "online" && !act.hasPrompt;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.5 : isArchived ? 0.55 : 1,
  };
  return (
    // dnd-kit useSortable: ref/attributes/listeners read during render is idiomatic.
    <Box
      // eslint-disable-next-line react-hooks/refs
      ref={sortable.setNodeRef}
      style={style}
      // eslint-disable-next-line react-hooks/refs
      {...(dragEnabled ? sortable.attributes : {})}
      // eslint-disable-next-line react-hooks/refs
      {...(dragEnabled ? sortable.listeners : {})}
    >
      <NodeRow
        kind={
          act.kind === "online"
            ? "activity-online"
            : act.kind === "shareBack"
              ? "activity-shareback"
              : "activity-offline"
        }
        title={act.title}
        selected={isSelected}
        completed={isCompleted}
        depth={1}
        disabled={!pickable}
        onClick={onClick}
        href={href}
        rightSlot={
          <HStack gap={1} flexShrink={0}>
            {/* 🏠 chip dropped — homework is now a property of the
                push (focusSettings.isHomework), not the activity. */}
            {isArchived && (
              <Badge bg="gray.200" color="charcoal.500" fontSize="2xs">
                Archived
              </Badge>
            )}
            {isCompleted && (
              <Badge bg="green.100" color="green.700" fontSize="2xs">
                ✓ done
              </Badge>
            )}
            {/* Warning supersedes the regular maturity/duration indicator. */}
            {showPromptWarning ? (
              <Tooltip.Root openDelay={200} closeDelay={0}>
                <Tooltip.Trigger asChild>
                  <Box
                    cursor="help"
                  >
                    <DashedStatusCircle size={12} />
                  </Box>
                </Tooltip.Trigger>
                <Portal>
                  <Tooltip.Positioner>
                    <Tooltip.Content>{NO_PROMPT_WARNING}</Tooltip.Content>
                  </Tooltip.Positioner>
                </Portal>
              </Tooltip.Root>
            ) : readiness !== undefined ? (
              <ReadinessDot readiness={readiness} />
            ) : (
              act.durationMinutes && (
                <Badge bg="gray.100" color="charcoal.500" fontSize="2xs">
                  {act.durationMinutes}m
                </Badge>
              )
            )}
          </HStack>
        }
      />
      {act.resources && act.resources.length > 0 && (
        <VStack align="stretch" gap={0} pl="68px" pr={2} pb={1}>
          {act.resources.map((resource) => (
            <ResourceShareCard
              key={String(resource._id)}
              resource={resource}
              compact
            />
          ))}
        </VStack>
      )}
    </Box>
  );
}

// ── New-sibling affordance ──────────────────────────────────────────────
// Quiet, gray, grid-aligned "+ New lesson / + New activity" row. The "+"
// rides the same leading column as the chevron (lessons) / activity icon
// (activities) above it, and the label rides the title column — so each
// add row tucks directly under its level, reinforcing the hierarchy.
// depth 0 = lesson level, depth 1 = activity level (mirrors NodeRow).
function AddRow({
  label,
  depth,
  onClick,
}: {
  label: string;
  depth: number;
  onClick: () => void;
}) {
  const indent = depth * OUTLINE_INDENT_PX;
  return (
    <Flex
      as="button"
      align="center"
      gap={`${OUTLINE_GAP_PX}px`}
      pl={`${indent + 8}px`}
      pr={2}
      py={1}
      borderRadius="md"
      cursor="pointer"
      color="charcoal.400"
      transition="background 0.1s, color 0.1s"
      _hover={{ bg: "gray.100", color: "charcoal.600" }}
      onClick={onClick}
      w="full"
      textAlign="left"
    >
      <Box
        w={`${OUTLINE_ICON_W_PX}px`}
        flexShrink={0}
        display="flex"
        alignItems="center"
        justifyContent="center"
        fontSize="xs"
        lineHeight="1"
      >
        ＋
      </Box>
      <Text fontSize="xs" fontFamily="heading" fontWeight="500">
        {label}
      </Text>
    </Flex>
  );
}

function AddActivityMenu({
  depth,
  creatingPreset,
  onCreate,
}: {
  depth: number;
  creatingPreset: ActivityCreationPreset | null;
  onCreate: (preset: ActivityCreationPreset) => Promise<void>;
}) {
  const indent = depth * OUTLINE_INDENT_PX;
  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger
        display="flex"
        alignItems="center"
        gap={`${OUTLINE_GAP_PX}px`}
        pl={`${indent + 8}px`}
        pr={2}
        py={1}
        borderRadius="md"
        cursor="pointer"
        color="charcoal.400"
        transition="background 0.1s, color 0.1s"
        _hover={{ bg: "gray.100", color: "charcoal.600" }}
        w="full"
        textAlign="left"
        disabled={creatingPreset !== null}
      >
        <Box
          w={`${OUTLINE_ICON_W_PX}px`}
          flexShrink={0}
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          {creatingPreset ? <Spinner size="xs" /> : <Plus size={12} />}
        </Box>
        <Text fontSize="xs" fontFamily="heading" fontWeight="500" flex={1}>
          New activity
        </Text>
        <CaretDown size={11} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="250px">
            <Menu.Item
              value="activity"
              cursor="pointer"
              onClick={() => void onCreate("activity")}
            >
              <Plus size={15} />
              <Stack gap={0} ml={2}>
                <Text fontFamily="heading" fontSize="sm" fontWeight="600">
                  Activity
                </Text>
                <Text fontSize="xs" color="charcoal.400">
                  Plan something scholars do
                </Text>
              </Stack>
            </Menu.Item>
            <Menu.Item
              value="handout"
              cursor="pointer"
              onClick={() => void onCreate("handout")}
            >
              <FileText size={15} />
              <Stack gap={0} ml={2}>
                <Text fontFamily="heading" fontSize="sm" fontWeight="600">
                  Handout
                </Text>
                <Text fontSize="xs" color="charcoal.400">
                  Share files, links, or videos
                </Text>
              </Stack>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

// Per-lesson "N archived" disclosure row — collapses archived activities so the
// active list stays clean while keeping them one click away on design surfaces.
function ArchivedToggleRow({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap={`${OUTLINE_GAP_PX}px`}
      pl={`${OUTLINE_INDENT_PX + 8}px`}
      pr={2}
      py={1}
      borderRadius="md"
      cursor="pointer"
      color="charcoal.400"
      transition="background 0.1s, color 0.1s"
      _hover={{ bg: "gray.100", color: "charcoal.600" }}
      onClick={onToggle}
      w="full"
      textAlign="left"
    >
      <Box
        w={`${OUTLINE_ICON_W_PX}px`}
        flexShrink={0}
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
      </Box>
      <Text fontSize="xs" fontFamily="heading" fontWeight="500">
        {count} archived
      </Text>
    </Flex>
  );
}

// ── Generic node row ────────────────────────────────────────────────────

interface NodeRowProps {
  kind:
    | "unit"
    | "lesson"
    | "activity-online"
    | "activity-offline"
    | "activity-shareback"
    | "independent";
  title: string;
  subtitle?: string;
  emoji?: string;
  selected: boolean;
  completed?: boolean;
  depth: number;
  disabled?: boolean;
  prominent?: boolean;
  chevron?: React.ReactNode;
  onChevronClick?: () => void;
  onClick?: () => void;
  /** When set, the row is wrapped in a Next.js Link so cmd-click opens
   *  the destination in a new tab. onClick still fires on regular click
   *  for any side-effects (like auto-expanding a lesson). */
  href?: string;
  rightSlot?: React.ReactNode;
}

function NodeRow({
  kind,
  title,
  subtitle,
  emoji,
  selected,
  completed,
  depth,
  disabled,
  prominent,
  chevron,
  onChevronClick,
  onClick,
  href,
  rightSlot,
}: NodeRowProps) {
  const indent = depth * OUTLINE_INDENT_PX;

  // Visual style by kind. Selection is borderless (June 2026): a faint
  // violet.50 tint + a violet.700 label — no border. The label color is
  // what makes the selection legible, since violet.50 is nearly white.
  // Matches `selectedListRowProps` / HierarchyRow so every list is uniform.
  const styles = selected
    ? { bg: "violet.50", borderColor: "transparent", color: "violet.700" }
    : (() => {
        switch (kind) {
          case "activity-offline":
          case "activity-shareback":
            return { bg: "transparent", borderColor: "transparent", color: "charcoal.400" };
          case "activity-online":
            return { bg: "transparent", borderColor: "transparent", color: "charcoal.500" };
          case "lesson":
          case "independent":
            return { bg: "transparent", borderColor: "transparent", color: "charcoal.700" };
          case "unit":
          default:
            return { bg: "transparent", borderColor: "transparent", color: "navy.500" };
        }
      })();

  // A real 3-step type ramp by altitude — unit (anchor) › lesson ›
  // activity descend in size AND weight so the hierarchy reads at a
  // glance, instead of the old flat 12px/600 across every level.
  const titleSize =
    prominent
      ? "0.9375rem"
      : kind === "unit"
      ? "sm"
      : kind === "lesson" || kind === "independent"
        ? "0.8125rem"
        : "xs";
  const titleWeight =
    kind === "unit"
      ? "700"
      : kind === "lesson" || kind === "independent"
        ? "600"
        : "500";

  const activityKind: ActivityKind | null =
    kind === "activity-online"
      ? "online"
      : kind === "activity-offline"
        ? "offline"
        : kind === "activity-shareback"
          ? "shareBack"
          : null;
  const hasChevronSlot = chevron !== undefined;
  const hasIconSlot = !!emoji || !!activityKind;

  const interactive = !disabled && (!!onClick || !!href);
  const rowFlex = (
    <Flex
      align="center"
      gap={`${OUTLINE_GAP_PX}px`}
      pl={`${indent + 8}px`}
      pr={2}
      py={prominent ? 1.5 : 1}
      borderRadius="md"
      borderWidth="1px"
      borderColor={styles.borderColor}
      bg={styles.bg}
      cursor={disabled ? "not-allowed" : interactive ? "pointer" : "default"}
      opacity={disabled ? 0.55 : 1}
      transition="background 0.1s, border-color 0.1s"
      _hover={
        // Match the HierarchyRow primitive's hover so the outline rows
        // and the column-view rows read as the same family.
        interactive && !selected ? { bg: "gray.100" } : undefined
      }
      onClick={
        disabled || !onClick
          ? undefined
          : (e) => {
              // When wrapped in a NextLink, the browser already opens
              // a new tab/window for cmd/ctrl/shift/middle-click. Bail
              // out of our same-tab onClick (which calls router.push)
              // so we don't navigate the current tab AND open a new
              // one. Plain left-clicks still flow through to onClick
              // for any side-effects (lesson auto-expand etc.).
              if (
                href &&
                (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)
              ) {
                return;
              }
              onClick();
            }
      }
    >
      {hasChevronSlot && (
        <Box
          color="charcoal.400"
          flexShrink={0}
          onClick={
            onChevronClick
              ? (e) => {
                  // Prevent the wrapping <Link>'s default navigation
                  // when the chevron is clicked — chevron is a row-
                  // local toggle, not a row activation.
                  e.preventDefault();
                  e.stopPropagation();
                  onChevronClick();
                }
              : undefined
          }
          cursor={onChevronClick ? "pointer" : "default"}
          w={`${OUTLINE_CHEVRON_W_PX}px`}
          textAlign="center"
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          {chevron}
        </Box>
      )}
      {hasIconSlot && (
        <Box
          w={`${OUTLINE_ICON_W_PX}px`}
          flexShrink={0}
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          {emoji ? (
            <Text fontSize="sm" lineHeight="1">
              {emoji}
            </Text>
          ) : activityKind ? (
            <ActivityKindIcon kind={activityKind} completed={completed} />
          ) : null}
        </Box>
      )}
      <VStack align="start" gap={0} flex={1} minW={0}>
        <Text
          fontSize={titleSize}
          fontFamily="heading"
          fontWeight={titleWeight}
          color={styles.color}
          truncate
          w="full"
        >
          {title}
        </Text>
        {subtitle && (
          <Text fontSize="2xs" color="charcoal.400" truncate w="full">
            {subtitle}
          </Text>
        )}
      </VStack>
      {rightSlot}
    </Flex>
  );

  if (href && !disabled) {
    return (
      <NextLink
        href={href}
        style={{ display: "block", textDecoration: "none", color: "inherit" }}
      >
        {rowFlex}
      </NextLink>
    );
  }
  return rowFlex;
}
