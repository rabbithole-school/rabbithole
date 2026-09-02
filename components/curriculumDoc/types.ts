import type { Id } from "@/convex/_generated/dataModel";
import type { TreeSelection } from "@/components/UnitOutlineTree";
import type { ActivityKind } from "@/lib/activityKinds";

/**
 * The document-view IA: a unit flattened into an ordered list of "pages"
 * (one white card each) rendered as a single vertical scroll —
 *   unit → lesson 1 → its activities → lesson 2 → …
 * See review/curriculum-document-view-plan.html.
 */
export type DocNode =
  | { kind: "unit"; unitId: Id<"units"> }
  | {
      kind: "lesson";
      unitId: Id<"units">;
      lessonId: Id<"lessons">;
      /** 1-based position among the unit's lessons (for the "Lesson N" eyebrow). */
      index: number;
    }
  | {
      kind: "activity";
      unitId: Id<"units">;
      lessonId: Id<"lessons">;
      activityId: Id<"activities">;
      actKind: ActivityKind;
    };

export function parseEditMode(
  raw: string | null | undefined,
): "inline" | "focus" {
  return raw === "focus" ? "focus" : "inline";
}

/** DOM id used both as the scroll anchor and the IntersectionObserver key. */
export function anchorId(node: DocNode): string {
  if (node.kind === "unit") return `doc-unit-${node.unitId}`;
  if (node.kind === "lesson") return `doc-lesson-${node.lessonId}`;
  return `doc-activity-${node.activityId}`;
}

/** Stable identity for scroll, selection, and maturity actions. */
export function nodeKey(node: DocNode): string {
  if (node.kind === "unit") return `unit:${node.unitId}`;
  if (node.kind === "lesson") return `lesson:${node.lessonId}`;
  return `activity:${node.activityId}`;
}

/** Bridge a DocNode to the shared outline-tree selection shape. */
export function toTreeSelection(node: DocNode): TreeSelection {
  if (node.kind === "unit") return { type: "unit", unitId: node.unitId };
  if (node.kind === "lesson")
    return { type: "lesson", unitId: node.unitId, lessonId: node.lessonId };
  return {
    type: "activity",
    unitId: node.unitId,
    lessonId: node.lessonId,
    activityId: node.activityId,
    kind: node.actKind,
  };
}
