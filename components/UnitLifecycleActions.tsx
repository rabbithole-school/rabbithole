"use client";

/**
 * Archive / Restore / Delete actions for a curriculum Unit. Shared by
 * the Curriculum unit-preview pane (`variant="buttons"`) and the Unit
 * Designer toolbar (`variant="menu"`) so the lifecycle policy lives in
 * one place.
 *
 * Archive is reversible (flips `isActive`); Delete is permanent and
 * only enabled when the unit was never run — `units.deletionImpact`
 * gates it on having zero assignments and zero real scholar projects,
 * so a delete never cascades away scholar work. When blocked, the
 * reason is surfaced inline (buttons) / in the menu (menu) and the
 * caller is steered to Archive instead.
 *
 * `onDeleted` fires after a successful hard delete so the host can
 * navigate away from the now-gone unit.
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, HStack, IconButton, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import {
  Archive,
  ArrowCounterClockwise,
  Copy,
  DotsThreeVertical,
  Trash,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ConfirmDeleteDialog } from "@/components/nodeEditor/shared";
import {
  NodeOptionsMenuItems,
  type NodeOptionRow,
} from "@/components/curriculumDoc/NodeOptions";
import { toaster } from "@/lib/toaster";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Please try again.";
}

export function UnitLifecycleActions({
  unitId,
  variant = "buttons",
  onDeleted,
  onDuplicated,
  optionRows,
}: {
  unitId: Id<"units">;
  variant?: "buttons" | "menu" | "icons";
  onDeleted: () => void;
  onDuplicated?: (unitId: Id<"units">) => void;
  /** The unit's settings, rendered as nested submenus leading the ⋮ menu (the
   *  curriculum document view) so settings and lifecycle actions share this one
   *  affordance. */
  optionRows?: NodeOptionRow[];
}) {
  // deletionImpact carries everything this surface needs — title,
  // isActive, child counts, and the canDelete gate — so it's the only
  // query (no redundant units.get).
  const impact = useQuery(api.units.deletionImpact, { id: unitId });
  const archiveUnit = useMutation(api.units.deactivate);
  const reactivateUnit = useMutation(api.units.reactivate);
  const removeUnit = useMutation(api.units.remove);
  const duplicateUnit = useMutation(api.units.duplicate);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const isActive = impact?.isActive ?? true;
  const canDelete = !!impact?.canDelete;

  const handleArchive = async () => {
    try {
      await archiveUnit({ id: unitId });
      toaster.success({
        title: "Unit archived",
        description: "Find it again under “Show archived”.",
      });
    } catch (err) {
      toaster.error({ title: "Archive failed", description: errMessage(err) });
    }
  };

  const handleRestore = async () => {
    try {
      await reactivateUnit({ id: unitId });
      toaster.success({ title: "Unit restored" });
    } catch (err) {
      toaster.error({ title: "Restore failed", description: errMessage(err) });
    }
  };

  // Throws on a blocked delete; ConfirmDeleteDialog surfaces the
  // message as an error toast and keeps itself open.
  const handleDelete = async () => {
    await removeUnit({ id: unitId });
    toaster.success({ title: "Unit deleted" });
    onDeleted();
  };

  const handleDuplicate = async () => {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const copyId = await duplicateUnit({ unitId });
      toaster.success({ title: "Unit duplicated" });
      onDuplicated?.(copyId);
    } catch (err) {
      toaster.error({
        title: "Duplicate failed",
        description: errMessage(err),
      });
    } finally {
      setDuplicating(false);
    }
  };

  const blockedReason =
    !impact || impact.canDelete
      ? null
      : `This unit has ${[
          impact.assignmentCount > 0
            ? `${impact.assignmentCount} assignment${impact.assignmentCount === 1 ? "" : "s"}`
            : null,
          impact.sessionCount > 0
            ? `${impact.sessionCount} scholar session${impact.sessionCount === 1 ? "" : "s"}`
            : null,
        ]
          .filter(Boolean)
          .join(" and ")} — archive it instead of deleting.`;

  const lessonCount = impact?.lessonCount ?? 0;
  const activityCount = impact?.activityCount ?? 0;
  const confirmMessage = `Delete “${impact?.title ?? "this unit"}” and its ${lessonCount} lesson${
    lessonCount === 1 ? "" : "s"
  } / ${activityCount} activit${
    activityCount === 1 ? "y" : "ies"
  }? This permanently removes the unit and its content and cannot be undone.`;

  // Still loading (or the unit vanished) — render nothing rather than
  // flashing controls in an unknown state.
  if (impact === undefined || impact === null) return null;

  return (
    <>
      {variant === "menu" ? (
        <Menu.Root positioning={{ placement: "bottom-end" }}>
          <Menu.Trigger asChild>
            <Box
              as="button"
              aria-label="Unit actions"
              display="inline-flex"
              alignItems="center"
              justifyContent="center"
              boxSize="32px"
              borderRadius="md"
              color="charcoal.500"
              cursor="pointer"
              _hover={{ bg: "gray.100" }}
            >
              <DotsThreeVertical size={18} weight="bold" />
            </Box>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="200px">
                {isActive ? (
                  <Menu.Item
                    value="archive"
                    cursor="pointer"
                    onClick={handleArchive}
                  >
                    <Archive /> Archive unit
                  </Menu.Item>
                ) : (
                  <Menu.Item
                    value="restore"
                    cursor="pointer"
                    onClick={handleRestore}
                  >
                    <ArrowCounterClockwise /> Restore unit
                  </Menu.Item>
                )}
                <Menu.Item
                  value="duplicate"
                  disabled={duplicating}
                  cursor="pointer"
                  onClick={() => void handleDuplicate()}
                >
                  <Copy /> Duplicate unit
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item
                  value="delete"
                  disabled={!canDelete}
                  color="red.500"
                  cursor="pointer"
                  _hover={{ bg: "red.50" }}
                  onClick={() => canDelete && setConfirmOpen(true)}
                >
                  <Trash /> Delete unit…
                </Menu.Item>
                {blockedReason && (
                  <Box px={3} py={1.5} maxW="240px">
                    <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
                      {blockedReason}
                    </Text>
                  </Box>
                )}
                {optionRows && optionRows.length > 0 && (
                  <>
                    <Menu.Separator />
                    <NodeOptionsMenuItems rows={optionRows} />
                  </>
                )}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      ) : variant === "icons" ? (
        <HStack gap={1}>
          {isActive ? (
            <IconButton
              aria-label="Archive unit"
              title="Archive unit"
              variant="ghost"
              size="sm"
              color="charcoal.500"
              _hover={{ bg: "gray.100" }}
              onClick={handleArchive}
            >
              <Archive size={18} />
            </IconButton>
          ) : (
            <IconButton
              aria-label="Restore unit"
              title="Restore unit"
              variant="ghost"
              size="sm"
              color="charcoal.500"
              _hover={{ bg: "gray.100" }}
              onClick={handleRestore}
            >
              <ArrowCounterClockwise size={18} />
            </IconButton>
          )}
          <IconButton
            aria-label="Duplicate unit"
            title="Duplicate unit"
            variant="ghost"
            size="sm"
            color="charcoal.500"
            _hover={{ bg: "gray.100" }}
            disabled={duplicating}
            loading={duplicating}
            onClick={() => void handleDuplicate()}
          >
            <Copy size={18} />
          </IconButton>
          <IconButton
            aria-label="Delete unit"
            title={canDelete ? "Delete unit…" : (blockedReason ?? "Delete unit…")}
            variant="ghost"
            size="sm"
            color="charcoal.500"
            _hover={{ bg: "gray.100" }}
            disabled={!canDelete}
            onClick={() => canDelete && setConfirmOpen(true)}
          >
            <Trash size={18} />
          </IconButton>
        </HStack>
      ) : (
        <Stack gap={1.5} alignItems="flex-start">
          <HStack gap={2}>
            {isActive ? (
              <Button
                size="sm"
                variant="ghost"
                color="charcoal.500"
                fontFamily="heading"
                fontWeight="600"
                _hover={{ bg: "gray.100" }}
                onClick={handleArchive}
              >
                <Archive /> Archive
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                color="charcoal.500"
                fontFamily="heading"
                fontWeight="600"
                _hover={{ bg: "gray.100" }}
                onClick={handleRestore}
              >
                <ArrowCounterClockwise /> Restore
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              color="charcoal.500"
              fontFamily="heading"
              fontWeight="600"
              _hover={{ bg: "gray.100" }}
              loading={duplicating}
              onClick={() => void handleDuplicate()}
            >
              <Copy /> Duplicate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              color="red.500"
              fontFamily="heading"
              fontWeight="600"
              _hover={{ bg: "red.50" }}
              disabled={!canDelete}
              onClick={() => setConfirmOpen(true)}
            >
              <Trash /> Delete
            </Button>
          </HStack>
          {blockedReason && (
            <Text fontSize="xs" color="charcoal.400" fontFamily="body">
              {blockedReason}
            </Text>
          )}
        </Stack>
      )}

      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete unit?"
        message={confirmMessage}
        confirmLabel="Delete unit"
        onConfirm={handleDelete}
      />
    </>
  );
}
