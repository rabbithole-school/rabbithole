"use client";

/**
 * The Curriculum surface — a Finder column-view that unifies the old
 * `/teacher/curriculum` units list and the `/teacher/unit/[id]` designer
 * into one spatial world: Units · Outline · Detail · Curriculum Bot. See
 * review/curriculum-rehearse-and-maturity.md.
 *
 * State is the URL path (`/teacher/curriculum[/unitId[/pane]]` + ?lesson/
 * ?activity), parsed here. Rendered by `app/teacher/curriculum/layout.tsx`
 * (NOT the page) so it never remounts as the path changes — the columns
 * slide instead of flashing, and unit→unit switching keeps the panes/bot/
 * subscriptions alive.
 *
 * The Units column is a CONTROLLED Chakra Splitter panel (the same splitter
 * idiom the designer's own columns use): drag its handle to resize, drag it
 * past the min to snap it to a chevron rail, drag/chevron it back to expand.
 * Because the splitter is controlled, the size also animates on programmatic
 * changes — opening a unit collapses the column, returning to the landing
 * re-expands it, and the chevrons toggle it, all gliding (flex-grow
 * transition); only live drag is instant. No unit → the designer panel shows
 * a plain empty state (pick a unit, or use the header Robot to draft a new
 * one — the general Curriculum Assistant now lives in the global dock). There's
 * no chunky unit header — "back" is the rail, the unit's identity + lifecycle
 * live on the outline's top row, and every column's header shares one height
 * (COLUMN_HEADER_HEIGHT) so their tops align.
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import {
  Box,
  Button,
  Flex,
  IconButton,
  Splitter,
} from "@chakra-ui/react";
import { CaretLeft, CaretRight, BookOpen, Robot, Plus } from "@phosphor-icons/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { COLUMN_HEADER_HEIGHT } from "@/components/hierarchy";
import { CurriculumUnitsBrowser } from "./CurriculumUnitsBrowser";
import { UnitDesigner, type UnitTab } from "./UnitDesigner";
import { CurriculumDocumentView } from "./curriculumDoc/CurriculumDocumentView";
import { parseEditMode } from "./curriculumDoc/types";
import { useAideDock } from "./aide/AideDockProvider";
import { Surface } from "@/components/ui/Surface";
import { EmptyState } from "@/components/ui/EmptyState";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isCurriculumRole } from "@/convex/lib/roles";

/** The Components library (perspectives / processes) — a flat, non-hierarchical
 *  sibling of the unit tree, so it opens as a drawer from the Units column
 *  header rather than occupying a column. Loaded on demand: most Curriculum
 *  visits never open it. */
const ComponentsDrawer = dynamic(
  () => import("@/components/ComponentsDrawer").then((mod) => mod.ComponentsDrawer),
  { ssr: false },
);

/** The describe-a-unit prompt the Curriculum landing's "Ask the bot" door
 *  seeds into the global chat composer (prefill only — the teacher edits/sends). */
const DRAFT_UNIT_SEED =
  "Draft a new curriculum unit for me. I'm thinking about ";

const PANES: readonly UnitTab[] = [
  "summary",
  "edit",
  "preflight",
  "assign",
  "debrief",
];

function parsePane(seg: string | null): UnitTab {
  return (PANES as readonly string[]).includes(seg ?? "")
    ? (seg as UnitTab)
    : "summary";
}

export interface CurriculumSelection {
  unitId: Id<"units"> | null;
  pane: UnitTab;
}

/** Parse `/teacher/curriculum`, `/teacher/curriculum/<unitId>`,
 *  `/teacher/curriculum/<unitId>/<pane>`. Node selection (lesson/activity)
 *  rides query params, read separately. */
export function parseCurriculumPath(pathname: string): CurriculumSelection {
  const rest = pathname.replace(/^\/teacher\/curriculum\/?/, "");
  const parts = rest.split("/").filter(Boolean);
  return {
    unitId: (parts[0] as Id<"units">) ?? null,
    pane: parsePane(parts[1] ?? null),
  };
}

// The Units column is a Splitter panel sized in PERCENTAGES of the surface
// (Chakra's Splitter is percentage-based). The Splitter is CONTROLLED (we own
// `sizes`) so collapse/expand can be driven programmatically AND animate: the
// panel size rides flex-grow, so a `flex-grow` transition makes the chevrons,
// a unit-pick, and the return-to-landing all glide — while live drag stays
// instant (Ark flags the panel `data-dragging`, which switches the transition
// off). Dragging past the min still snaps to the rail (collapsible).
const UNITS_EXPANDED_PCT = 20;
const UNITS_MIN_PCT = 14; // drag below this snaps to the rail
const UNITS_MAX_PCT = 34;
const UNITS_RAIL_PCT = 3; // collapsed (chevron rail) width
const UNITS_RAIL_THRESHOLD_PCT = 8; // render the rail at/below this size

const EXPANDED_SIZES = [UNITS_EXPANDED_PCT, 100 - UNITS_EXPANDED_PCT];
const COLLAPSED_SIZES = [UNITS_RAIL_PCT, 100 - UNITS_RAIL_PCT];

// Animate programmatic size changes (chevron, unit-pick, landing) but not live
// drag — Ark sets the panel size via flex-grow and flags it data-dragging
// while the user drags the handle.
const PANEL_TRANSITION = "flex-grow 0.2s ease";
const NO_ANIM_WHILE_DRAGGING = { "&[data-dragging]": { transition: "none" } };

export function CurriculumColumnView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const createUnit = useMutation(api.units.create);
  const { seedComposer } = useAideDock();
  const { user } = useCurrentUser();
  const supplementalCurriculumAccess =
    !!user?.hasCurriculumAccess && !isCurriculumRole(user.role);
  const { unitId, pane } = parseCurriculumPath(pathname);
  const lessonParam = searchParams.get("lesson");
  const activityParam = searchParams.get("activity");
  const lessonId = lessonParam ? (lessonParam as Id<"lessons">) : undefined;
  const activityId = activityParam
    ? (activityParam as Id<"activities">)
    : undefined;

  // Which unit surface to render (D2: the document view is the default / the
  // replacement). `?surface=columns` falls back to the classic tabbed designer
  // — kept as an escape hatch. The document view keeps maturity actions in-place
  // (bot prompt or modal overlay). `?edit=` A/B's the doc view's edit interaction:
  // `inline` (grow-in-place, default) vs `focus` (chrome-free full-screen). See
  // components/curriculumDoc/*.
  const surface = searchParams.get("surface");
  const useDocView = surface !== "columns" && !supplementalCurriculumAccess;
  const editMode = parseEditMode(searchParams.get("edit"));

  // The column auto-collapses to the rail when a unit opens (or you switch
  // units) and re-expands on the landing — derived from the route via the
  // "adjust state when a prop changes" pattern (setState during render, no
  // effect), so it stays in lockstep with navigation and animates. The
  // chevrons and drag override it freely afterward (they don't touch the
  // route, so this block won't re-fire).
  const [sizes, setSizes] = useState<number[]>(() =>
    unitId ? COLLAPSED_SIZES : EXPANDED_SIZES,
  );
  const [routeUnit, setRouteUnit] = useState(unitId);
  if (unitId !== routeUnit) {
    setRouteUnit(unitId);
    setSizes(unitId ? COLLAPSED_SIZES : EXPANDED_SIZES);
  }
  const collapseUnits = () => setSizes(COLLAPSED_SIZES);
  const expandUnits = () => setSizes(EXPANDED_SIZES);

  // The Components library lives at the Curriculum root (not inside the Units
  // column) so it survives unit→unit navigation and opens with or without a
  // unit selected; the Units column header owns its only trigger.
  const [componentsOpen, setComponentsOpen] = useState(false);

  // The Curriculum landing's two doors (FIX 5). Primary: the ordinary create
  // path (a blank unit, opened on Edit — mirrors the Units column's "New
  // unit"). Secondary: hand off to the global chat, seeding the composer with a
  // describe-a-unit prompt (prefill only, no auto-send — the teacher fills in
  // the topic and sends; the bot builds a real unit that shows up live in the
  // Units column).
  const handleNewUnit = async () => {
    const id = await createUnit({ title: "Untitled unit" });
    router.push(`/teacher/curriculum/${id}/edit`);
  };
  const handleAskBotToDraft = () => seedComposer(DRAFT_UNIT_SEED);

  const unitsCollapsed = sizes[0] <= UNITS_RAIL_THRESHOLD_PCT;

  // Measure the splitter's width (stable — it only changes on window resize,
  // NOT when panels resize) so the units list can be pinned to its EXPANDED
  // pixel width while collapsing. Pinned + clipped by the panel's overflow, it
  // CROPS + fades under the narrowing edge (object permanence) instead of
  // vanishing the instant the size state flips to the rail.
  const splitterRef = useRef<HTMLDivElement>(null);
  const [rootWidth, setRootWidth] = useState(0);
  useEffect(() => {
    const el = splitterRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setRootWidth(el.getBoundingClientRect().width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const expandedListPx = rootWidth
    ? Math.round((rootWidth * UNITS_EXPANDED_PCT) / 100)
    : null;

  return (
    <Splitter.Root
      ref={splitterRef}
      flex={1}
      minW={0}
      minH={0}
      overflow="hidden"
      size={sizes}
      onResize={(e) => setSizes(e.size)}
      panels={[
        {
          id: "units",
          collapsible: true,
          collapsedSize: UNITS_RAIL_PCT,
          // zag-splitter ≥1.41 emits the panel's minSize as a hard inline CSS
          // `min-width` (1.40 didn't), which would floor the collapsed rail at
          // UNITS_MIN_PCT (14%) even though its flex-grow size is the 3% rail.
          // Drop the min to the rail width while collapsed so the rail renders
          // at 3%; restore the 14% drag-floor once expanded. (The collapse
          // SNAP still works: a drag below the (collapsedSize+minSize)/2 point
          // sets sizes→3, which flips this to UNITS_RAIL_PCT.)
          minSize: unitsCollapsed ? UNITS_RAIL_PCT : UNITS_MIN_PCT,
          maxSize: UNITS_MAX_PCT,
        },
        { id: "designer", minSize: 50 },
      ]}
    >
      <Splitter.Panel
        id="units"
        position="relative"
        minW={0}
        overflow="hidden"
        bg="white"
        transition={PANEL_TRANSITION}
        css={NO_ANIM_WHILE_DRAGGING}
      >
        {/* List layer — while collapsing it's pinned to its expanded pixel
            width and clipped by the panel's overflow, so it CROPS + fades
            under the narrowing edge (object permanence) rather than vanishing
            the instant the size flips. */}
        <Box
          position="absolute"
          top={0}
          bottom={0}
          left={0}
          w={unitsCollapsed && expandedListPx ? `${expandedListPx}px` : "100%"}
          display="flex"
          flexDirection="column"
          opacity={unitsCollapsed ? 0 : 1}
          pointerEvents={unitsCollapsed ? "none" : "auto"}
          transition="opacity 0.2s ease"
          aria-hidden={unitsCollapsed}
          inert={unitsCollapsed || undefined}
        >
          <CurriculumUnitsBrowser
            selectedUnitId={unitId}
            onOpenComponents={() => setComponentsOpen(true)}
            leading={
              unitId ? (
                <IconButton
                  aria-label="Collapse units"
                  variant="ghost"
                  size="xs"
                  color="charcoal.500"
                  _hover={{ bg: "gray.100" }}
                  onClick={collapseUnits}
                >
                  <CaretLeft size={14} />
                </IconButton>
              ) : undefined
            }
          />
        </Box>

        {/* Rail expand chevron — fades in as the list fades/crops out, sharing
            the header-height band so its top aligns with the other columns. */}
        <Flex
          position="absolute"
          top={0}
          left={0}
          right={0}
          h={COLUMN_HEADER_HEIGHT}
          align="center"
          justify="center"
          bg="white"
          opacity={unitsCollapsed ? 1 : 0}
          pointerEvents={unitsCollapsed ? "auto" : "none"}
          transition="opacity 0.2s ease"
          aria-hidden={!unitsCollapsed}
          inert={!unitsCollapsed || undefined}
        >
          <IconButton
            aria-label="Show all units"
            variant="ghost"
            size="sm"
            color="charcoal.500"
            _hover={{ bg: "gray.100" }}
            onClick={expandUnits}
          >
            <CaretRight size={16} />
          </IconButton>
        </Flex>
      </Splitter.Panel>

      <Splitter.ResizeTrigger
        id="units:designer"
        css={{
          "--splitter-border-size": "0.5px",
          position: "relative",
          zIndex: 3,
        }}
      />

      <Splitter.Panel
        id="designer"
        minW={0}
        overflow="hidden"
        transition={PANEL_TRANSITION}
        css={NO_ANIM_WHILE_DRAGGING}
      >
        {unitId ? (
          useDocView ? (
            <CurriculumDocumentView
              unitId={unitId}
              selectedLessonId={lessonId}
              selectedActivityId={activityId}
              editMode={editMode}
            />
          ) : (
            <UnitDesigner
              unitId={unitId}
              tab={pane}
              selectedLessonId={lessonId}
              selectedActivityId={activityId}
            />
          )
        ) : (
          // Landing (no unit): an empty state with two doors — create a blank
          // unit yourself, or ask the global chat to draft one. The unit either
          // door produces appears live in the Units column (reactive). FIX 5.
          // Content lives on a white Surface, not directly on the gray shoulder
          // (visual-design: "No bare text on the gray shoulder"). FIX C.
          <Flex h="full" w="full" align="center" justify="center" px={8} bg="gray.50">
            <Surface px={{ base: 8, md: 10 }} py={{ base: 8, md: 10 }} maxW="480px" w="full">
              <Flex direction="column" align="center" gap={2}>
                <EmptyState
                  size="lg"
                  icon={<BookOpen weight="duotone" />}
                  title="Pick a unit to design"
                  hint="Choose a unit from the list on the left to open its outline — or start a new one."
                />
                <Flex align="center" gap={3}>
                  <Button
                    size="sm"
                    bg="violet.500"
                    color="white"
                    fontFamily="heading"
                    fontWeight="600"
                    _hover={{ bg: "violet.600" }}
                    onClick={() => void handleNewUnit()}
                  >
                    <Plus size={16} weight="bold" style={{ marginRight: "6px" }} />
                    New unit
                  </Button>
                  {!supplementalCurriculumAccess && (
                    <Button
                      size="sm"
                      variant="ghost"
                      color="violet.500"
                      fontFamily="heading"
                      fontWeight="600"
                      _hover={{ bg: "violet.50" }}
                      onClick={handleAskBotToDraft}
                    >
                      <Robot size={16} weight="duotone" style={{ marginRight: "6px" }} />
                      Ask the bot to draft one →
                    </Button>
                  )}
                </Flex>
              </Flex>
            </Surface>
          </Flex>
        )}
      </Splitter.Panel>

      {/* Renders no DOM inside the splitter: Drawer.Root is a context provider
          and its content is portaled to the body. */}
      <ComponentsDrawer open={componentsOpen} onClose={() => setComponentsOpen(false)} />
    </Splitter.Root>
  );
}
