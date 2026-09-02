"use client";

import { Flex, Text, VStack } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { TreeSelection } from "./UnitOutlineTree";
import { UnitFields } from "./nodeEditor/UnitFields";
import { LessonFields } from "./nodeEditor/LessonFields";
import { ActivityFields } from "./nodeEditor/ActivityFields";
import { NodeEditorSkeleton } from "./nodeEditor/NodeEditorSkeleton";

interface NodeEditorProps {
  unitId: Id<"units">;
  selection: TreeSelection | null;
  /**
   * Hint that selection is null because we're mid-transition to a
   * known kind (e.g. URL says `?activity=…` but UnitDesigner hasn't
   * resolved the activity doc yet). Renders a layout-matching
   * skeleton instead of the EmptyState that's intended for the
   * "nothing selected, click something" case.
   */
  loadingKind?: "activity" | "lesson" | "unit" | null;
  onAfterDeleteLesson?: () => void;
  onAfterDeleteActivity?: () => void;
  onAfterDuplicateLesson?: (lessonId: Id<"lessons">) => void;
  onAfterDuplicateActivity?: (activityId: Id<"activities">) => void;
  /** Push a prompt into the Curriculum Bot chat (expanding it if collapsed). */
  askAi?: (prompt: string) => void;
}

export function NodeEditor({
  unitId,
  selection,
  loadingKind,
  onAfterDeleteLesson,
  onAfterDeleteActivity,
  onAfterDuplicateLesson,
  onAfterDuplicateActivity,
  askAi,
}: NodeEditorProps) {
  if (!selection) {
    if (loadingKind) {
      return <NodeEditorSkeleton kind={loadingKind} />;
    }
    return <EmptyState />;
  }
  if (selection.type === "unit") {
    return <UnitFields unitId={unitId} />;
  }
  if (selection.type === "lesson") {
    return (
      <LessonFields
        lessonId={selection.lessonId}
        onAfterDelete={onAfterDeleteLesson}
        onAfterDuplicate={onAfterDuplicateLesson}
      />
    );
  }
  return (
    <ActivityFields
      activityId={selection.activityId}
      onAfterDelete={onAfterDeleteActivity}
      onAfterDuplicate={onAfterDuplicateActivity}
      askAi={askAi}
    />
  );
}

function EmptyState() {
  return (
    <Flex h="full" align="center" justify="center" px={6} textAlign="center">
      <VStack gap={3} color="charcoal.300">
        <Text fontFamily="heading" fontSize="md" color="charcoal.400">
          Click anything in the outline
        </Text>
        <Text fontFamily="body" fontSize="sm" maxW="320px">
          Pick a unit, lesson, or activity in the left tree to edit its fields here. Use the AI on the right to design lessons and activities for you.
        </Text>
      </VStack>
    </Flex>
  );
}
