"use client";

/**
 * UnitProgressDialog — a focused "where am I in this unit?" view for a
 * scholar, opened from a unit group card's progress meter on the home
 * plate.
 *
 * Deliberately NOT the full UnitPickerDialog (that surface exists for
 * choosing/launching a NEW quest — unit switcher + "Pick an activity"
 * footer). This is just THIS unit's activity ladder with the scholar's
 * completion checkmarks (done / here / upcoming). It reuses
 * <UnitOutlineTree> (pick mode, alwaysExpanded) so the outline +
 * completion logic stay DRY. Tapping an activity jumps the scholar into
 * it (continue / start).
 */

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  Flex,
  IconButton,
  Portal,
  Text,
} from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { UnitOutlineTree, type TreeSelection } from "./UnitOutlineTree";

export interface UnitProgressActivity {
  unitId: string;
  lessonId: string;
  activityId: string;
  assignmentId?: string | null;
}

export function UnitProgressDialog({
  open,
  onClose,
  unitId,
  assignmentId,
  scholarId,
  onLaunchActivity,
}: {
  open: boolean;
  onClose: () => void;
  unitId: Id<"units"> | null;
  assignmentId?: Id<"assignments"> | null;
  /** Whose completions drive the checkmarks. Omit = current user. */
  scholarId?: Id<"users"> | null;
  /** Tapping an activity jumps the scholar into it. */
  onLaunchActivity: (sel: UnitProgressActivity) => void;
}) {
  const unit = useQuery(
    api.units.get,
    open && unitId ? { id: unitId } : "skip",
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="560px" w="95vw">
            <Dialog.Header px={6} pt={5} pb={3}>
              <Flex align="center" gap={2} flex={1} minW={0}>
                {unit?.emoji && (
                  <Text fontSize="xl" lineHeight="1" flexShrink={0}>
                    {unit.emoji}
                  </Text>
                )}
                <Dialog.Title
                  fontFamily="heading"
                  fontWeight="700"
                  color="navy.500"
                  fontSize="lg"
                  lineClamp={1}
                >
                  {unit?.title ?? "Your progress"}
                </Dialog.Title>
              </Flex>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body px={3} pt={0} pb={5} maxH="60vh" overflowY="auto">
              {unitId && (
                <UnitOutlineTree
                  unitId={unitId}
                  mode="pick"
                  scholarId={scholarId ?? undefined}
                  assignmentId={assignmentId ?? undefined}
                  alwaysExpanded
                  selected={null}
                  onSelect={(sel: TreeSelection) => {
                    if (sel.type === "activity") {
                      onLaunchActivity({
                        unitId: String(sel.unitId),
                        lessonId: String(sel.lessonId),
                        activityId: String(sel.activityId),
                        assignmentId: assignmentId ? String(assignmentId) : null,
                      });
                    }
                  }}
                />
              )}
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
