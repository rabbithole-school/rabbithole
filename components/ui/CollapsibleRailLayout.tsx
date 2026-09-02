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
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Flex, IconButton, Splitter } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { COLUMN_HEADER_HEIGHT } from "@/components/hierarchy";

const PANEL_TRANSITION = "flex-grow 0.2s ease";
const NO_ANIM_WHILE_DRAGGING = { "&[data-dragging]": { transition: "none" } };

export function CollapsibleRailLayout({
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
}: {
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
}) {
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
