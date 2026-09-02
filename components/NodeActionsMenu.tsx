"use client";

import { useState } from "react";
import { Box, Menu, Portal } from "@chakra-ui/react";
import { Archive, ArrowCounterClockwise, Copy, DotsThreeVertical, Trash } from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";
import {
  NodeOptionsMenuItems,
  type NodeOptionRow,
} from "./curriculumDoc/NodeOptions";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Please try again.";
}

export function NodeActionsMenu({
  kind,
  onDuplicate,
  onDelete,
  onArchive,
  onUnarchive,
  optionRows,
}: {
  kind: "unit" | "lesson" | "activity";
  onDuplicate?: () => Promise<void>;
  onDelete?: () => void;
  /** Archive (soft-hide) — the non-destructive alternative to delete. */
  onArchive?: () => Promise<void>;
  /** Unarchive — restore an archived node. Shown instead of Archive. */
  onUnarchive?: () => Promise<void>;
  /** The node's settings, rendered as nested submenus leading the menu so
   *  settings and actions share this one ⋮ affordance instead of a separate
   *  popover trigger. */
  optionRows?: NodeOptionRow[];
}) {
  const [duplicating, setDuplicating] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const kindLabel = kind[0].toUpperCase() + kind.slice(1);

  const handleDuplicate = async () => {
    if (!onDuplicate || duplicating) return;
    setDuplicating(true);
    try {
      await onDuplicate();
      toaster.success({
        title: `${kindLabel} duplicated`,
      });
    } catch (error) {
      toaster.error({
        title: "Duplicate failed",
        description: errorMessage(error),
      });
    } finally {
      setDuplicating(false);
    }
  };

  const handleArchive = async (archive: boolean) => {
    const fn = archive ? onArchive : onUnarchive;
    if (!fn || archiving) return;
    setArchiving(true);
    try {
      await fn();
      toaster.success({
        title: archive ? `${kindLabel} archived` : `${kindLabel} unarchived`,
        description: archive
          ? "Hidden from scholars and removed from the schedule. Scholar work is kept."
          : undefined,
      });
    } catch (error) {
      toaster.error({
        title: archive ? "Archive failed" : "Unarchive failed",
        description: errorMessage(error),
      });
    } finally {
      setArchiving(false);
    }
  };

  const hasOptions = !!optionRows && optionRows.length > 0;
  if (!onDuplicate && !onDelete && !onArchive && !onUnarchive && !hasOptions)
    return null;

  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Box
          as="button"
          aria-label={`${kindLabel} actions`}
          title={`${kindLabel} actions`}
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
          <Menu.Content minW="190px">
            {onDuplicate && (
              <Menu.Item
                value="duplicate"
                disabled={duplicating}
                cursor="pointer"
                onClick={() => void handleDuplicate()}
              >
                <Copy /> Duplicate {kind}
              </Menu.Item>
            )}
            {onArchive && (
              <Menu.Item
                value="archive"
                disabled={archiving}
                cursor="pointer"
                onClick={() => void handleArchive(true)}
              >
                <Archive /> Archive {kind}
              </Menu.Item>
            )}
            {onUnarchive && (
              <Menu.Item
                value="unarchive"
                disabled={archiving}
                cursor="pointer"
                onClick={() => void handleArchive(false)}
              >
                <ArrowCounterClockwise /> Unarchive {kind}
              </Menu.Item>
            )}
            {onDelete && (
              <>
                {(onDuplicate || onArchive || onUnarchive) && <Menu.Separator />}
                <Menu.Item
                  value="delete"
                  color="red.500"
                  cursor="pointer"
                  _hover={{ bg: "red.50" }}
                  onClick={onDelete}
                >
                  <Trash /> Delete {kind}…
                </Menu.Item>
              </>
            )}
            {hasOptions && (
              <>
                {(onDuplicate || onDelete || onArchive || onUnarchive) && (
                  <Menu.Separator />
                )}
                <NodeOptionsMenuItems rows={optionRows} />
              </>
            )}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
