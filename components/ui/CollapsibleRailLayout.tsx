"use client";

/**
 * CollapsibleRailLayout — the Units-tab "collapsible left rail" idiom, extracted
 * so more than one full-bleed surface can share it (DRY). It is the same
 * CONTROLLED Chakra `Splitter` pattern `CurriculumColumnView` uses: drag the
 * handle to resize, drag past the min to SNAP to a chevron rail, chevron/drag
 * it back to expand — and because the splitter is controlled, programmatic
 * collapse/expand animate too (flex-grow transition; only live drag is instant).
 *
 * The rail body is a render prop that receives `{ collapse }` so the consumer's
 * own header can carry the collapse chevron (matching the Units column). While
 * collapsing, the expanded body is pinned to its last expanded pixel width and
 * clipped by the panel overflow, so it CROPS + fades under the narrowing edge
 * (object permanence) instead of vanishing the instant the size flips.
 *
 * Sizing is in PERCENTAGES (Chakra's Splitter is percentage-based). Defaults
 * mirror the Units column; override per surface if needed.
 *
 * `overlay` is the narrow-screen form: the rail is always collapsed to the
 * same chevron strip, and expanding it opens the rail body as a modal drawer
 * over the content (scrim, Escape and a click outside close it) instead of
 * pushing the content aside, so a phone keeps the content's width. Following a
 * link inside the drawer closes it. Off by default; the splitter form is
 * unchanged.
 */

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Box, Drawer, Flex, IconButton, Portal, Splitter } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { COLUMN_HEADER_HEIGHT } from "@/components/hierarchy";

const PANEL_TRANSITION = "flex-grow 0.2s ease";
const NO_ANIM_WHILE_DRAGGING = { "&[data-dragging]": { transition: "none" } };

/** Width of the collapsed chevron strip in overlay mode. */
const OVERLAY_STRIP_WIDTH = "40px";
/** Drawer width in overlay mode: a rail's width, never wider than the phone. */
const OVERLAY_DRAWER_WIDTH = "min(280px, 85vw)";

type RailLayoutProps = {
  /** Expanded rail body. Receives `collapse` so its own header can host the
   *  collapse chevron (mirrors the Units column). */
  rail: (api: { collapse: () => void }) => ReactNode;
  /** Main content in the second panel. */
  children: ReactNode;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  expandAriaLabel?: string;
  railHeaderHeight?: string;
  railId?: string;
  expandedPct?: number;
  minPct?: number;
  maxPct?: number;
  railPct?: number;
  railThresholdPct?: number;
  minMainPct?: number;
  railBg?: string;
  /** Narrow-screen form: a collapsed strip whose expand control opens the
   *  rail as a modal drawer over the content. Starts closed and ignores
   *  `defaultCollapsed` and the percentage sizing. */
  overlay?: boolean;
  /** Accessible name for the overlay drawer (`role="dialog"`). */
  overlayAriaLabel?: string;
};

export function CollapsibleRailLayout({ overlay = false, ...props }: RailLayoutProps) {
  return overlay ? <OverlayRailLayout {...props} /> : <SplitterRailLayout {...props} />;
}

function OverlayRailLayout({
  rail,
  children,
  onCollapsedChange,
  expandAriaLabel = "Expand panel",
  overlayAriaLabel = "Navigation",
  railHeaderHeight = COLUMN_HEADER_HEIGHT,
  railId = "rail",
  railBg = "white",
}: Omit<RailLayoutProps, "overlay">) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerId = `${railId}-drawer`;

  const lastOpen = useRef(open);
  useEffect(() => {
    if (lastOpen.current !== open) {
      lastOpen.current = open;
      onCollapsedChange?.(!open);
    }
  }, [open, onCollapsedChange]);

  // Choosing a destination closes the drawer. A modified click (new tab or
  // window) leaves the current page where it is, so the drawer stays open.
  const closeOnLinkClick = (e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.target as Element).closest("a[href]")) setOpen(false);
  };

  return (
    <Flex flex={1} minW={0} minH={0} h="full">
      {/* Collapsed strip — the same chevron band the splitter form shows when
          collapsed, at a fixed width. */}
      <Flex
        w={OVERLAY_STRIP_WIDTH}
        flexShrink={0}
        direction="column"
        align="center"
        bg={railBg}
        borderRightWidth="0.5px"
        borderColor="gray.200"
      >
        <Flex h={railHeaderHeight} align="center" justify="center">
          <IconButton
            ref={toggleRef}
            aria-label={expandAriaLabel}
            aria-expanded={open}
            aria-controls={open ? drawerId : undefined}
            aria-haspopup="dialog"
            variant="ghost"
            size="sm"
            color="charcoal.500"
            _hover={{ bg: "gray.100" }}
            onClick={() => setOpen(true)}
          >
            <CaretRight size={16} />
          </IconButton>
        </Flex>
      </Flex>

      <Box flex={1} minW={0} minH={0} overflow="hidden">
        {children}
      </Box>

      <Drawer.Root
        open={open}
        onOpenChange={(d) => setOpen(d.open)}
        placement="start"
        // The content id goes through `ids`, never an `id` prop: the dialog
        // machine finds its content by this id for the focus trap and the
        // Escape / outside-click layer.
        ids={{ content: drawerId }}
        finalFocusEl={() => toggleRef.current}
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content
              aria-label={overlayAriaLabel}
              w={OVERLAY_DRAWER_WIDTH}
              maxW={OVERLAY_DRAWER_WIDTH}
              bg={railBg}
              display="flex"
              flexDirection="column"
              pt="env(safe-area-inset-top)"
              pb="env(safe-area-inset-bottom)"
              onClick={closeOnLinkClick}
            >
              {rail({ collapse: () => setOpen(false) })}
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </Flex>
  );
}

function SplitterRailLayout({
  rail,
  children,
  defaultCollapsed = false,
  onCollapsedChange,
  expandAriaLabel = "Expand panel",
  railHeaderHeight = COLUMN_HEADER_HEIGHT,
  railId = "rail",
  expandedPct = 20,
  minPct = 14,
  maxPct = 34,
  railPct = 3,
  railThresholdPct = 8,
  minMainPct = 50,
  railBg = "white",
}: Omit<RailLayoutProps, "overlay">) {
  const expandedSizes = [expandedPct, 100 - expandedPct];
  const collapsedSizes = [railPct, 100 - railPct];

  const [sizes, setSizes] = useState<number[]>(() =>
    defaultCollapsed ? collapsedSizes : expandedSizes,
  );
  const collapsed = sizes[0]! <= railThresholdPct;
  const collapse = () => setSizes(collapsedSizes);
  const expand = () => setSizes(expandedSizes);

  // Notify on collapse-state transitions (not every drag frame).
  const lastCollapsed = useRef(collapsed);
  useEffect(() => {
    if (lastCollapsed.current !== collapsed) {
      lastCollapsed.current = collapsed;
      onCollapsedChange?.(collapsed);
    }
  }, [collapsed, onCollapsedChange]);

  // Measure the splitter's own width (changes on window resize, NOT on panel
  // resize) so the rail body can be pinned to its expanded pixel width while
  // collapsing — it then crops + fades under the narrowing edge.
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
  const expandedRailPx = rootWidth
    ? Math.round((rootWidth * expandedPct) / 100)
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
          id: railId,
          collapsible: true,
          collapsedSize: railPct,
          // zag-splitter ≥1.41 emits the panel's minSize as a hard inline CSS
          // min-width, which would floor the collapsed rail at minPct. Drop the
          // min to the rail width while collapsed; restore the drag-floor once
          // expanded. (Collapse SNAP still works: a drag below the midpoint
          // sets sizes→railPct, which flips this to railPct.)
          minSize: collapsed ? railPct : minPct,
          maxSize: maxPct,
        },
        { id: "main", minSize: minMainPct },
      ]}
    >
      <Splitter.Panel
        id={railId}
        position="relative"
        minW={0}
        overflow="hidden"
        bg={railBg}
        transition={PANEL_TRANSITION}
        css={NO_ANIM_WHILE_DRAGGING}
      >
        {/* Rail body — pinned to its expanded pixel width while collapsing so it
            crops + fades rather than reflowing into the narrow rail. */}
        <Box
          position="absolute"
          top={0}
          bottom={0}
          left={0}
          w={collapsed && expandedRailPx ? `${expandedRailPx}px` : "100%"}
          display="flex"
          flexDirection="column"
          opacity={collapsed ? 0 : 1}
          pointerEvents={collapsed ? "none" : "auto"}
          transition="opacity 0.2s ease"
          aria-hidden={collapsed}
          inert={collapsed || undefined}
        >
          {rail({ collapse })}
        </Box>

        {/* Collapsed chevron — fades in as the rail body fades/crops out,
            sharing the header-height band so its top aligns with the panels. */}
        <Flex
          position="absolute"
          top={0}
          left={0}
          right={0}
          h={railHeaderHeight}
          align="center"
          justify="center"
          bg={railBg}
          opacity={collapsed ? 1 : 0}
          pointerEvents={collapsed ? "auto" : "none"}
          transition="opacity 0.2s ease"
          aria-hidden={!collapsed}
          inert={!collapsed || undefined}
        >
          <IconButton
            aria-label={expandAriaLabel}
            variant="ghost"
            size="sm"
            color="charcoal.500"
            _hover={{ bg: "gray.100" }}
            onClick={expand}
          >
            <CaretRight size={16} />
          </IconButton>
        </Flex>
      </Splitter.Panel>

      <Splitter.ResizeTrigger
        id={`${railId}:main`}
        css={{
          "--splitter-border-size": "0.5px",
          position: "relative",
          zIndex: 3,
        }}
      />

      <Splitter.Panel
        id="main"
        minW={0}
        overflow="hidden"
        transition={PANEL_TRANSITION}
        css={NO_ANIM_WHILE_DRAGGING}
      >
        {children}
      </Splitter.Panel>
    </Splitter.Root>
  );
}
