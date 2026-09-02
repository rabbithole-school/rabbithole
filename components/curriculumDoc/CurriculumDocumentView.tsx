"use client";

/**
 * Curriculum DOCUMENT VIEW — the alternative to the tabbed column designer.
 * A unit is a single flush white scroll of read-only "pages" (unit → lessons →
 * activities): no cards, no gray canvas — everything sits on white in a centered
 * reading column with generous side margins. A full-width sticky header carries
 * the unit identity; each lesson header is itself a sticky subhead that pins
 * under it. A Google-Doc-style outline rail scroll-spies the current node.
 * Field-level edits happen inline inside the read views; clicking the
 * surrounding document never swaps a page into a form editor. The Curriculum Bot
 * (global dock) remains the main assisted mutation path. See
 * review/curriculum-document-view-plan.html.
 *
 * The outline rail (drag-reorder, status dots, add affordances) is the shared
 * `UnitOutlineTree`, driven here by scroll position instead of the URL.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  IconButton,
  Text,
} from "@chakra-ui/react";
import { CaretLeft, CaretRight, Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ActivityKind } from "@/lib/activityKinds";
import type { NodeStatus } from "@/convex/lib/unitMaturity";
import {
  UnitOutlineTree,
  type ActivityCreationPreset,
  type TreeSelection,
} from "@/components/UnitOutlineTree";
import { COLUMN_HEADER_HEIGHT } from "@/components/hierarchy";
import {
  useAideDockOptional,
  useSetAideScope,
  type AideScope,
} from "@/components/aide/AideDockProvider";
import { DocPage } from "./DocPage";
import { NodeMaturityControls, RehearseButton } from "./NodeMaturityCta";
import { MaturityHub, type MaturityHubTarget, type HubView } from "./MaturityHub";
import type { RehearseFixField } from "@/components/nodeEditor/rehearseResult";
import { InlineText } from "./InlineEditable";
import {
  LessonReadView,
  LessonPrompt,
  LessonHeaderHeightProvider,
  StickyHeaderRow,
  HeaderMetaCluster,
  UnitHeaderMeta,
  UnitAuthorTag,
  useUnitOptionRows,
  ACTIVITY_STICKY_TOP,
} from "./docReadViews";
import {
  anchorId,
  nodeKey,
  toTreeSelection,
  type DocNode,
} from "./types";
import { UnitLifecycleActions } from "@/components/UnitLifecycleActions";
import { ConfirmDeleteDialog } from "@/components/nodeEditor/shared";
import { StartAssignmentDialog } from "@/components/StartAssignmentDialog";
import { toaster } from "@/lib/toaster";

const RAIL_WIDTH = 236;
// The document is a flush white page; content sits in a centered reading
// column with generous, growing side margins. The header's unit identity and
// every page share this column so they align vertically.
const DOC_MAX_W = "900px";
const DOC_PX = { base: 5, md: 8 } as const;
const PROGRAMMATIC_SCROLL_GUARD_MS = 350;

function selKey(sel: TreeSelection): string {
  if (sel.type === "unit") return `unit:${sel.unitId}`;
  if (sel.type === "lesson") return `lesson:${sel.lessonId}`;
  return `activity:${sel.activityId}`;
}

/**
 * One lesson "section" of the document: a COMPACT sticky lesson subhead (title
 * + right-aligned chips + maturity) that stays pinned while its activities are
 * in view, the lesson's tutor prompt as a NON-sticky block below (so a long
 * prompt scrolls instead of bloating the pinned header — and stays hidden
 * behind an "Add guidance" affordance until it has content), and then the
 * activity pages. Owns the prompt's reveal state so the header button and the
 * body editor stay in sync across the sticky boundary.
 */
function LessonSection({
  section,
  first,
  statusFor,
  registerFor,
  onOpenMaturity,
  onDuplicateLesson,
  onDuplicateActivity,
  onDeleteLesson,
  onDeleteActivity,
  fixTargetFor,
}: {
  section: { lesson: DocNode; activities: DocNode[] };
  first: boolean;
  statusFor: (node: DocNode) => NodeStatus | undefined;
  registerFor: (key: string) => (el: HTMLDivElement | null) => void;
  onOpenMaturity: (node: DocNode, title: string, initialView?: HubView) => void;
  onDuplicateLesson: (lessonId: Id<"lessons">) => Promise<void>;
  onDuplicateActivity: (activityId: Id<"activities">) => Promise<void>;
  onDeleteLesson: (lessonId: Id<"lessons">) => void;
  onDeleteActivity: (activityId: Id<"activities">) => void;
  /** Only a Preflight-finding-fix's target activity gets a non-undefined
   *  result; every other node gets undefined (no highlight). */
  fixTargetFor: (
    node: DocNode,
  ) => { field: RehearseFixField; signal: number } | undefined;
}) {
  const [revealed, setRevealed] = useState(false);
  // Measure the pinned lesson-header height so the activities' slim sticky bars
  // pin flush beneath it (rather than guessing a fixed offset that gets covered).
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const [headerH, setHeaderH] = useState<number>(ACTIVITY_STICKY_TOP);
  useEffect(() => {
    const el = stickyRef.current;
    if (!el) return;
    const measure = () => setHeaderH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lesson = section.lesson;
  if (lesson.kind !== "lesson") return null;
  const lessonKey = nodeKey(lesson);
  return (
    <Box position="relative" mt={first ? 2 : 8}>
      {/* Sticky lesson subhead: pins just under the unit header while its
          section is in view, then the next section pushes it up. */}
      <Box
        ref={stickyRef}
        position="sticky"
        top={0}
        zIndex={3}
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.100"
      >
        {/* Full-bleed white backing: the type label hangs in the left margin
            (outside the reading column), so extend an opaque layer across the
            margins — clipped by the scroll body's overflowX:hidden — to occlude
            the marginalia of the bands scrolling underneath this one. */}
        <Box
          aria-hidden
          position="absolute"
          top={0}
          bottom={0}
          left="-100%"
          right="-100%"
          bg="white"
          zIndex={-1}
          pointerEvents="none"
        />
        <Box
          id={anchorId(lesson)}
          ref={registerFor(lessonKey)}
          scrollMarginTop="0px"
        >
          <Box py={1.5}>
            <LessonReadView
              lessonId={lesson.lessonId}
              unitId={lesson.unitId}
              index={lesson.index}
              status={statusFor(lesson)}
              onOpenMaturity={(title, initialView) =>
                onOpenMaturity(lesson, title, initialView)
              }
              onDuplicate={() => onDuplicateLesson(lesson.lessonId)}
              onDelete={() => onDeleteLesson(lesson.lessonId)}
            />
          </Box>
        </Box>
      </Box>

      <LessonPrompt
        lessonId={lesson.lessonId}
        revealed={revealed}
        onReveal={() => setRevealed(true)}
        onCollapse={() => setRevealed(false)}
      />

      <LessonHeaderHeightProvider value={headerH}>
        {section.activities.map((node, ai) => (
          <DocPage
            key={nodeKey(node)}
            node={node}
            status={statusFor(node)}
            onOpenMaturity={onOpenMaturity}
            onDuplicate={() =>
              node.kind === "activity"
                ? onDuplicateActivity(node.activityId)
                : Promise.resolve()
            }
            onDelete={
              node.kind === "activity"
                ? () => onDeleteActivity(node.activityId)
                : undefined
            }
            registerAnchor={registerFor(nodeKey(node))}
            topDivider={ai > 0}
            fixTarget={fixTargetFor(node)}
          />
        ))}
      </LessonHeaderHeightProvider>
    </Box>
  );
}

export interface CurriculumDocumentViewProps {
  unitId: Id<"units">;
  selectedLessonId?: Id<"lessons">;
  selectedActivityId?: Id<"activities">;
  [legacyProp: string]: unknown;
}

export function CurriculumDocumentView({
  unitId,
  selectedLessonId,
  selectedActivityId,
}: CurriculumDocumentViewProps) {
  const router = useRouter();
  const unit = useQuery(api.units.get, { id: unitId });
  const lessons = useQuery(api.lessons.listByUnitPublic, { unitId });
  // Design surface: include archived activities so their section still renders
  // (dimmed, with the Archived chip) and Unarchive stays reachable.
  const activities = useQuery(api.activities.listByUnitPublic, {
    unitId,
    includeArchived: true,
  });
  const nodeStatuses = useQuery(api.unitMaturity.getNodeStatuses, { unitId });

  const createLesson = useMutation(api.lessons.create);
  const createActivity = useMutation(api.activities.create);
  const duplicateLesson = useMutation(api.lessons.duplicate);
  const duplicateActivity = useMutation(api.activities.duplicate);
  const removeLesson = useMutation(api.lessons.remove);
  const removeActivity = useMutation(api.activities.remove);
  const updateUnit = useMutation(api.units.update);

  const dock = useAideDockOptional();
  const askAi = useCallback((prompt: string) => dock?.send(prompt), [dock]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [pendingScrollKey, setPendingScrollKey] = useState<string | null>(null);
  const [hubTarget, setHubTarget] = useState<MaturityHubTarget | null>(null);
  // Where the hub came FROM when a roll-up row retargeted it to an activity —
  // popped by the hub's Back button so the serial "rehearse each activity"
  // loop returns to the roll-up list, not the activity's own summary.
  const [hubStack, setHubStack] = useState<MaturityHubTarget[]>([]);
  // A Preflight finding's "Fix this" (rehearse-view Results, inside the hub):
  // closes the hub, scrolls to the target activity, and pulses/opens the
  // matching EXISTING editor. `signal` is a monotonically increasing counter
  // so a repeat click on the SAME field still re-triggers the highlight.
  const [fixTarget, setFixTarget] = useState<{
    activityId: Id<"activities">;
    field: RehearseFixField;
    signal: number;
  } | null>(null);
  const fixSignalRef = useRef(0);
  // The node being assigned (opened FROM the hub). StartAssignmentDialog is a
  // sibling of the hub, never stacked over it: the hub closes as this opens, so
  // Ark releases the body lock cleanly (see engineering-principles.md).
  const [assignTarget, setAssignTarget] = useState<DocNode | null>(null);
  // The pending lesson/activity delete, surfaced through ONE stably-mounted
  // ConfirmDeleteDialog at the view root (never remounted via a changing key —
  // see engineering-principles.md on Ark dialog body-lock leaks).
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "lesson"; id: Id<"lessons">; title: string }
    | { kind: "activity"; id: Id<"activities">; title: string }
    | null
  >(null);
  const unitOptionRows = useUnitOptionRows(unitId);

  // ── build the ordered page list: unit → per-lesson (lesson + its activities)
  const nodes = useMemo<DocNode[]>(() => {
    const out: DocNode[] = [{ kind: "unit", unitId }];
    if (!lessons) return out;
    const byLesson = new Map<string, typeof activities>();
    for (const a of activities ?? []) {
      const k = String(a.lessonId);
      if (!byLesson.has(k)) byLesson.set(k, []);
      byLesson.get(k)!.push(a);
    }
    lessons.forEach((l, i) => {
      out.push({ kind: "lesson", unitId, lessonId: l._id, index: i + 1 });
      for (const a of byLesson.get(String(l._id)) ?? []) {
        out.push({
          kind: "activity",
          unitId,
          lessonId: l._id,
          activityId: a._id,
          actKind: a.kind as ActivityKind,
        });
      }
    });
    return out;
  }, [unitId, lessons, activities]);

  // ── scroll-spy: track the node whose top most recently crossed the activation
  //    line near the top of the scroll container, and reflect it in the rail.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const anchorsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const programmaticScrollKeyRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const registerCacheRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  const registerFor = useCallback((key: string) => {
    let fn = registerCacheRef.current.get(key);
    if (!fn) {
      fn = (el: HTMLDivElement | null) => {
        if (el) anchorsRef.current.set(key, el);
        else anchorsRef.current.delete(key);
      };
      registerCacheRef.current.set(key, fn);
    }
    return fn;
  }, []);

  const recomputeActive = useCallback(() => {
    if (programmaticScrollKeyRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const cTop = container.getBoundingClientRect().top;
    const line = cTop + 140; // activation line a bit below the top edge
    let best: string | null = null;
    let bestTop = -Infinity;
    for (const [key, el] of anchorsRef.current) {
      const top = el.getBoundingClientRect().top;
      if (top <= line && top > bestTop) {
        bestTop = top;
        best = key;
      }
    }
    // Before the first node crosses the line, fall back to the first node.
    if (!best && anchorsRef.current.size > 0) {
      best = nodes[0] ? nodeKey(nodes[0]) : null;
    }
    setActiveKey((prev) => (prev === best ? prev : best));
  }, [nodes]);

  const clearProgrammaticScrollGuard = useCallback(() => {
    programmaticScrollKeyRef.current = null;
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }
  }, []);

  const scheduleProgrammaticScrollGuardClear = useCallback(
    (key: string) => {
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
      programmaticScrollTimerRef.current = setTimeout(() => {
        if (programmaticScrollKeyRef.current === key) {
          clearProgrammaticScrollGuard();
        }
      }, PROGRAMMATIC_SCROLL_GUARD_MS);
    },
    [clearProgrammaticScrollGuard],
  );

  const onScroll = useCallback(() => {
    const pinnedKey = programmaticScrollKeyRef.current;
    if (pinnedKey) {
      scheduleProgrammaticScrollGuardClear(pinnedKey);
    }
    requestAnimationFrame(recomputeActive);
  }, [recomputeActive, scheduleProgrammaticScrollGuardClear]);

  const pinProgrammaticScroll = useCallback(
    (key: string) => {
      programmaticScrollKeyRef.current = key;
      setActiveKey(key);
      scheduleProgrammaticScrollGuardClear(key);
    },
    [scheduleProgrammaticScrollGuardClear],
  );

  const scrollToKey = useCallback(
    (key: string, options?: ScrollIntoViewOptions) => {
      pinProgrammaticScroll(key);
      anchorsRef.current
        .get(key)
        ?.scrollIntoView({ block: "start", ...options });
    },
    [pinProgrammaticScroll],
  );

  useEffect(() => {
    return () => clearProgrammaticScrollGuard();
  }, [clearProgrammaticScrollGuard]);

  useEffect(() => {
    recomputeActive();
  }, [recomputeActive, nodes.length]);

  // ── deep-link: on first load, scroll to the URL-selected node.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (nodes.length === 0) return;
    const targetKey = selectedActivityId
      ? `activity:${selectedActivityId}`
      : selectedLessonId
        ? `lesson:${selectedLessonId}`
        : null;
    didInitialScrollRef.current = true;
    if (!targetKey) return;
    // Wait a frame for anchors to mount.
    requestAnimationFrame(() => {
      scrollToKey(targetKey);
    });
  }, [nodes.length, selectedActivityId, selectedLessonId, scrollToKey]);

  // ── a freshly added node: once it mounts, scroll to it.
  useEffect(() => {
    if (!pendingScrollKey) return;
    const exists = nodes.some((n) => nodeKey(n) === pendingScrollKey);
    if (!exists) return;
    const key = pendingScrollKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consumes the pending scroll command only after its newly created node materializes.
    setPendingScrollKey(null);
    requestAnimationFrame(() => {
      scrollToKey(key, { behavior: "smooth" });
    });
  }, [pendingScrollKey, nodes, scrollToKey]);

  const scrollToSelection = useCallback((sel: TreeSelection) => {
    scrollToKey(selKey(sel));
  }, [scrollToKey]);

  const handleAddLesson = useCallback(async () => {
    const lessonId = await createLesson({ unitId, title: "New lesson" });
    setPendingScrollKey(`lesson:${lessonId}`);
  }, [createLesson, unitId]);

  const handleAddActivity = useCallback(
    async (
      lessonId: Id<"lessons">,
      preset: ActivityCreationPreset,
    ) => {
      const activityId = await createActivity({
        lessonId,
        title: preset === "handout" ? "New handout" : "New activity",
        kind: "offline",
        defaultMode: preset === "handout" ? "homework" : undefined,
      });
      setPendingScrollKey(`activity:${activityId}`);
      return activityId;
    },
    [createActivity],
  );

  const handleDuplicateLesson = useCallback(
    async (lessonId: Id<"lessons">) => {
      const copyId = await duplicateLesson({ lessonId });
      setPendingScrollKey(`lesson:${copyId}`);
    },
    [duplicateLesson],
  );

  const handleDuplicateActivity = useCallback(
    async (activityId: Id<"activities">) => {
      const copyId = await duplicateActivity({ activityId });
      setPendingScrollKey(`activity:${copyId}`);
    },
    [duplicateActivity],
  );

  const handleRequestDeleteLesson = useCallback(
    (lessonId: Id<"lessons">) => {
      const title = lessons?.find((l) => l._id === lessonId)?.title ?? "this lesson";
      setDeleteTarget({ kind: "lesson", id: lessonId, title });
    },
    [lessons],
  );

  const handleRequestDeleteActivity = useCallback(
    (activityId: Id<"activities">) => {
      const title =
        activities?.find((a) => a._id === activityId)?.title ?? "this activity";
      setDeleteTarget({ kind: "activity", id: activityId, title });
    },
    [activities],
  );

  // Runs the pending delete; ConfirmDeleteDialog closes itself on success and
  // surfaces an error toast (keeping itself open) on failure. The document just
  // re-renders off Convex reactivity — no navigation.
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "lesson") {
      await removeLesson({ id: deleteTarget.id });
      toaster.success({ title: "Lesson deleted" });
    } else {
      await removeActivity({ id: deleteTarget.id });
      toaster.success({ title: "Activity deleted" });
    }
  }, [deleteTarget, removeLesson, removeActivity]);

  const openMaturity = useCallback(
    (node: DocNode, title: string, initialView?: HubView) => {
      setHubTarget({ node, title, initialView });
      setHubStack([]);
    },
    [],
  );

  // Assign this node to scholars from the hub. Close the hub FIRST, then open
  // StartAssignmentDialog as a sibling — never stack two Ark modals.
  const openAssignFromHub = useCallback((node: DocNode) => {
    setHubTarget(null);
    setAssignTarget(node);
  }, []);

  // A Preflight finding's "Fix this": only meaningful when the hub's current
  // target IS the activity (findings only render in an activity's rehearse
  // Results view). Close the hub, scroll to the activity, and stamp a fresh
  // fixTarget so the matching editor opens/pulses.
  const onFixFinding = useCallback(
    (field: RehearseFixField) => {
      const node = hubTarget?.node;
      if (!node || node.kind !== "activity") return;
      const { activityId } = node;
      setHubTarget(null);
      setHubStack([]);
      fixSignalRef.current += 1;
      setFixTarget({ activityId, field, signal: fixSignalRef.current });
      requestAnimationFrame(() => {
        scrollToKey(`activity:${activityId}`, { behavior: "smooth" });
      });
    },
    [hubTarget, scrollToKey],
  );

  const fixTargetFor = useCallback(
    (node: DocNode) => {
      if (!fixTarget || node.kind !== "activity") return undefined;
      if (node.activityId !== fixTarget.activityId) return undefined;
      return { field: fixTarget.field, signal: fixTarget.signal };
    },
    [fixTarget],
  );

  // ── rail selection + bot scope follow the scroll.
  const currentKey = activeKey;
  const selected: TreeSelection | null = useMemo(() => {
    const n = nodes.find((x) => nodeKey(x) === currentKey);
    return n ? toTreeSelection(n) : { type: "unit", unitId };
  }, [nodes, currentKey, unitId]);

  const aideScope = useMemo<AideScope>(() => {
    const n = nodes.find((x) => nodeKey(x) === currentKey);
    return {
      kind: "unit",
      unitId,
      lessonId:
        n?.kind === "lesson"
          ? n.lessonId
          : n?.kind === "activity"
            ? n.lessonId
            : null,
      activityId: n?.kind === "activity" ? n.activityId : null,
    };
  }, [nodes, currentKey, unitId]);
  useSetAideScope(aideScope);

  if (unit === null) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text fontFamily="heading" color="charcoal.400">
          Unit not found
        </Text>
      </Flex>
    );
  }

  const statusFor = (node: DocNode) => {
    if (!nodeStatuses) return undefined;
    if (node.kind === "lesson") return nodeStatuses.lessons[String(node.lessonId)];
    if (node.kind === "activity")
      return nodeStatuses.activities[String(node.activityId)];
    return undefined;
  };

  const unitNode = nodes[0];
  const bodyNodes = nodes.slice(1);
  // Group the body into lesson sections so each lesson header can be a sticky
  // subhead within its own section (it pins under the unit header, then the
  // next lesson section pushes it up).
  const sections: { lesson: DocNode; activities: DocNode[] }[] = [];
  for (const n of bodyNodes) {
    if (n.kind === "lesson") sections.push({ lesson: n, activities: [] });
    else if (sections.length > 0) sections[sections.length - 1].activities.push(n);
  }

  return (
    <Flex h="full" direction="column" position="relative" overflow="hidden">
      {/* ── FULL-WIDTH DOC HEADER (spans the outline rail + the pages) ────── */}
      <Flex
        h={COLUMN_HEADER_HEIGHT}
        flexShrink={0}
        align="center"
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.200"
        zIndex={5}
      >
        {/* left segment above the rail: label + collapse toggle */}
        <Flex
          w={railCollapsed ? "40px" : `${RAIL_WIDTH}px`}
          flexShrink={0}
          h="full"
          align="center"
          justify={railCollapsed ? "center" : "space-between"}
          px={railCollapsed ? 0 : 3}
          borderRightWidth="1px"
          borderColor="gray.200"
        >
          {!railCollapsed && (
            <Text
              fontFamily="heading"
              fontSize="2xs"
              fontWeight="700"
              letterSpacing="0.08em"
              textTransform="uppercase"
              color="charcoal.400"
            >
              Outline
            </Text>
          )}
          <IconButton
            aria-label={railCollapsed ? "Show outline" : "Hide outline"}
            size="xs"
            variant="ghost"
            color="charcoal.400"
            _hover={{ bg: "gray.100" }}
            onClick={() => setRailCollapsed((v) => !v)}
          >
            {railCollapsed ? <CaretRight size={14} /> : <CaretLeft size={14} />}
          </IconButton>
        </Flex>
        {/* unit identity fills the rest, aligned to the shared doc column */}
        {unit && (
          <Flex flex={1} minW={0} h="full" align="center" overflow="hidden">
            <Flex
              w="full"
              maxW={DOC_MAX_W}
              mx="auto"
              px={DOC_PX}
              minW={0}
              align="center"
            >
              <StickyHeaderRow
                label="Unit"
                title={
                  <InlineText
                    value={unit.title}
                    onCommit={(v) => v.trim() && updateUnit({ id: unitId, title: v })}
                    placeholder="Unit title"
                    ariaLabel="Unit title"
                    textStyle={{
                      fontFamily: "heading",
                      fontWeight: "800",
                      fontSize: { base: "lg", md: "xl" },
                      lineHeight: "1.1",
                      letterSpacing: "-0.01em",
                      color: "navy.500",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  />
                }
                right={
                  <HeaderMetaCluster
                    facts={
                      <>
                        <UnitAuthorTag teacherId={unit.teacherId} />
                        <UnitHeaderMeta unitId={unitId} />
                      </>
                    }
                    workflow={
                      <>
                        {unitNode && (
                          <RehearseButton
                            onOpen={() =>
                              openMaturity(unitNode, unit.title, "rehearse")
                            }
                          />
                        )}
                        {unitNode && (
                          <NodeMaturityControls
                            unitId={unitId}
                            onOpen={() => openMaturity(unitNode, unit.title)}
                          />
                        )}
                        <UnitLifecycleActions
                          unitId={unitId}
                          variant="menu"
                          optionRows={unitOptionRows}
                          onDeleted={() => router.push("/teacher/curriculum")}
                          onDuplicated={(copyId) =>
                            router.push(`/teacher/curriculum/${copyId}`)
                          }
                        />
                      </>
                    }
                  />
                }
              />
            </Flex>
          </Flex>
        )}
      </Flex>

      {/* ── BODY: outline rail + the scroll of pages ─────────────────────── */}
      <Flex flex={1} minH={0} position="relative" overflow="hidden">
        {/* OUTLINE RAIL — tree only; its header now lives in the top bar. */}
        {railCollapsed ? (
          <Box
            w="40px"
            flexShrink={0}
            bg="white"
            borderRightWidth="1px"
            borderColor="gray.200"
          />
        ) : (
          <Flex
            w={`${RAIL_WIDTH}px`}
            flexShrink={0}
            direction="column"
            bg="white"
            borderRightWidth="1px"
            borderColor="gray.200"
            boxShadow="2px 0 8px -6px rgba(24,28,38,0.28)"
            overflow="hidden"
            position="relative"
            zIndex={1}
          >
            <Box flex={1} overflowY="auto">
              <UnitOutlineTree
                unitId={unitId}
                mode="design"
                selected={selected}
                onSelect={scrollToSelection}
                onAddLesson={handleAddLesson}
                onAddActivity={handleAddActivity}
                showStatus
                hideUnitRow
              />
            </Box>
          </Flex>
        )}

      {/* ── THE DOCUMENT: one flush white scroll, no cards, no gray ──────── */}
      <Box
        ref={scrollRef}
        onScroll={onScroll}
        flex={1}
        minW={0}
        overflowY="auto"
        overflowX="hidden"
        bg="white"
      >
        {/* A centered reading column gives everything — unit overview, lessons,
            activities — the same generous, growing left/right margins, aligned
            with the unit title in the header above. */}
        <Box maxW={DOC_MAX_W} mx="auto" px={DOC_PX} pb={2}>
          {/* Unit overview: flush at the top of the document (not sticky). */}
          {unitNode && (
            <DocPage
              node={unitNode}
              onOpenMaturity={openMaturity}
              // eslint-disable-next-line react-hooks/refs -- The callback-ref cache is consulted during render so this anchor retains a stable callback identity.
              registerAnchor={registerFor(nodeKey(unitNode))}
            />
          )}

          {sections.map((section, si) => (
            <LessonSection
              key={nodeKey(section.lesson)}
              section={section}
              first={si === 0}
              statusFor={statusFor}
              registerFor={registerFor}
              onOpenMaturity={openMaturity}
              onDuplicateLesson={handleDuplicateLesson}
              onDuplicateActivity={handleDuplicateActivity}
              onDeleteLesson={handleRequestDeleteLesson}
              onDeleteActivity={handleRequestDeleteActivity}
              fixTargetFor={fixTargetFor}
            />
          ))}

          {lessons && lessons.length === 0 && (
            <Flex
              mt={8}
              borderWidth="1.5px"
              borderStyle="dashed"
              borderColor="gray.300"
              borderRadius="xl"
              bg="whiteAlpha.700"
              direction="column"
              align="center"
              gap={2}
              px={6}
              py={8}
              textAlign="center"
            >
              <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                This unit has no lessons yet. Ask the Curriculum Bot to draft
                one, or add it yourself.
              </Text>
              <Button
                size="sm"
                variant="outline"
                borderColor="violet.300"
                color="violet.600"
                fontFamily="heading"
                fontWeight="600"
                _hover={{ bg: "violet.50" }}
                onClick={() => void handleAddLesson()}
              >
                <Plus size={14} weight="bold" style={{ marginRight: 6 }} />
                Add first lesson
              </Button>
            </Flex>
          )}
          <Box h="40vh" aria-hidden />
        </Box>
      </Box>
      </Flex>

      <MaturityHub
        target={hubTarget}
        askAi={askAi}
        onClose={() => {
          setHubTarget(null);
          setHubStack([]);
        }}
        onAssign={openAssignFromHub}
        onFixFinding={onFixFinding}
        onRetarget={(t) => {
          // Remember the roll-up we came from, pinned to the view the row was
          // clicked in, so popping lands back on that list (not the summary).
          setHubStack((s) =>
            hubTarget ? [...s, { ...hubTarget, initialView: t.initialView }] : s,
          );
          setHubTarget(t);
        }}
        onBack={
          hubStack.length > 0
            ? () => {
                const prev = hubStack[hubStack.length - 1];
                setHubStack((s) => s.slice(0, -1));
                setHubTarget(prev);
              }
            : undefined
        }
      />

      <StartAssignmentDialog
        open={assignTarget !== null}
        onClose={() => setAssignTarget(null)}
        initialUnitId={assignTarget?.unitId}
        initialLessonId={
          assignTarget && assignTarget.kind !== "unit"
            ? assignTarget.lessonId
            : undefined
        }
        initialActivityId={
          assignTarget?.kind === "activity" ? assignTarget.activityId : undefined
        }
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={
          deleteTarget?.kind === "activity" ? "Delete activity?" : "Delete lesson?"
        }
        message={
          deleteTarget?.kind === "activity"
            ? `Delete activity “${deleteTarget.title}”? This cannot be undone.`
            : `Delete lesson “${deleteTarget?.title ?? "this lesson"}” and all its activities? This cannot be undone.`
        }
        confirmLabel={
          deleteTarget?.kind === "activity" ? "Delete activity" : "Delete lesson"
        }
        onConfirm={handleConfirmDelete}
      />
    </Flex>
  );
}
