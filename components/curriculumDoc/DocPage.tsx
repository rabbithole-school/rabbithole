"use client";

/**
 * One "page" in the curriculum document view. Resting state = a flush, white,
 * card-less page (edge-to-edge on the white document, no drop shadow) rendering
 * the read view for its node. Horizontal margins come from the shared doc
 * column in CurriculumDocumentView. Field-level edits happen inside the read
 * views (InlineText / InlineProse); clicking the surrounding page never swaps
 * the page into a form editor. See
 * review/curriculum-document-view-plan.html.
 */
import { useCallback, useRef } from "react";
import { Box } from "@chakra-ui/react";
import type { NodeStatus } from "@/convex/lib/unitMaturity";
import type { HubView } from "./MaturityHub";
import type { RehearseFixField } from "@/components/nodeEditor/rehearseResult";
import {
  UnitReadView,
  LessonReadView,
  ActivityReadView,
  useLessonHeaderHeight,
} from "./docReadViews";
import { anchorId, type DocNode } from "./types";

const KIND_PY: Record<DocNode["kind"], { base: number; md: number }> = {
  unit: { base: 5, md: 6 },
  lesson: { base: 3, md: 3.5 },
  activity: { base: 5, md: 5 },
};

interface DocPageProps {
  node: DocNode;
  status?: NodeStatus;
  onOpenMaturity: (
    node: DocNode,
    title: string,
    initialView?: HubView,
  ) => void;
  onDuplicate?: () => Promise<void>;
  onDelete?: () => void;
  registerAnchor?: (el: HTMLDivElement | null) => void;
  /**
   * The document is now a flush white page (no floating cards, no gray canvas):
   * every DocPage renders edge-to-edge white, and horizontal margins come from
   * the shared doc column in CurriculumDocumentView. `topDivider` draws a
   * hairline above the page (used to separate sibling activities within a
   * lesson). The maturity pill (which launches the maturity hub) lives
   * right-aligned inside each read view's headline row, so there's no separate
   * action row.
   */
  topDivider?: boolean;
  /** Only meaningful for an activity node: a Preflight finding's "Fix this"
   *  landed HERE. See ActivityReadView's `fixTarget` prop. */
  fixTarget?: { field: RehearseFixField; signal: number };
}

export function DocPage({
  node,
  status,
  onOpenMaturity,
  onDuplicate,
  onDelete,
  registerAnchor,
  topDivider = false,
  fixTarget,
}: DocPageProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lessonHeaderH = useLessonHeaderHeight();
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el;
      registerAnchor?.(el);
    },
    [registerAnchor],
  );

  const readBody =
    node.kind === "unit" ? (
      <UnitReadView unitId={node.unitId} />
    ) : node.kind === "lesson" ? (
      <LessonReadView
        lessonId={node.lessonId}
        unitId={node.unitId}
        index={node.index}
        status={status}
      />
    ) : (
      <ActivityReadView
        activityId={node.activityId}
        unitId={node.unitId}
        status={status}
        onOpenMaturity={(title, initialView) =>
          onOpenMaturity(node, title, initialView)
        }
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        fixTarget={fixTarget}
      />
    );

  // Activities sit under a sticky lesson subhead, so give them scroll clearance
  // matching the pinned lesson-header height; unit + lesson land flush at the
  // top of the scroll box.
  const scrollMt = node.kind === "activity" ? `${lessonHeaderH}px` : "0px";
  const py = KIND_PY[node.kind];

  // ── READ (resting) — flush white, no card ──────────────────────────────────
  return (
    <Box id={anchorId(node)} ref={setRefs} scrollMarginTop={scrollMt}>
      <Box
        position="relative"
        py={py}
        borderTopWidth={topDivider ? "1px" : "0"}
        borderColor="gray.100"
      >
        {readBody}
      </Box>
    </Box>
  );
}
