"use client";

/**
 * ConfirmGroupCheckpointDialog — the ONE guard in front of a math-group
 * checkpoint write. A scholar's checkpoint is one child's policy; a group's is
 * every member's at once, so the group-altitude surfaces (the domain/strand
 * grade pill and the panel band control) all stop here first.
 *
 * Purely presentational and fully controlled: it holds no query and no
 * mutation. The caller owns the request, the server preview, the single write,
 * and the error — so there is exactly one confirmation component and exactly
 * one write path behind it, whichever surface opened it.
 *
 * What it must say, and why:
 *  • The exact SERVER member total ("4 scholars"), never the filtered column
 *    count the matrix happens to be showing — the write reaches every member.
 *  • That this changes GROUP policy while individual exceptions stay put. A
 *    teacher who thinks a group write overwrites overrides will avoid the
 *    control that is actually safe.
 *  • The exception split (following / keeping their own / none) truthfully. A
 *    zero row is omitted as noise, but a nonzero one is never hidden.
 *  • Named blockers when the server would refuse, with the next move spelled
 *    out — and Confirm disabled rather than left to fail.
 *
 * Colour discipline follows the rest of the checkpoint vocabulary: neutral
 * charcoal chrome, amber only for the "read this before you confirm" callout,
 * red reserved for a write that actually failed. A clear is framed as removing
 * the group's policy — never as deleting anyone's own checkpoint, which it does
 * not do.
 */

import { useRef } from "react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { WarningCircle } from "@phosphor-icons/react";

import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { CheckpointBandChip } from "@/components/practice/MathPlanMarks";
import {
  groupCheckpointActionLabel,
  scholarCountLabel,
  type GroupCheckpointIntent,
} from "@/components/practice/mathPlanProjection";

export type GroupCheckpointBlockedScholar = {
  scholarId: string;
  name: string;
};

export type GroupCheckpointGroupBlockedScholar =
  GroupCheckpointBlockedScholar & { groupName: string };

/** `checkpointForGroup.members`, narrowed to what this dialog reads. */
export type GroupCheckpointMembersPreview = {
  total: number;
  following: number;
  keepingOwn: number;
  none: number;
  blockedByScope: GroupCheckpointBlockedScholar[];
  blockedByGroup: GroupCheckpointGroupBlockedScholar[];
};

/** The exception rows, in the order a teacher reads them. A zero count is
 *  dropped; a nonzero one always shows. */
function exceptionRows(members: GroupCheckpointMembersPreview) {
  return (
    [
      {
        key: "following",
        count: members.following,
        label: "following the group checkpoint",
      },
      {
        key: "keepingOwn",
        count: members.keepingOwn,
        label: "keeping their own checkpoint instead",
      },
      {
        key: "none",
        count: members.none,
        label: "with no checkpoint at all",
      },
    ] as const
  ).filter((row) => row.count > 0);
}

function namedList(names: string[]) {
  const shown = names.slice(0, 4);
  const others = names.length - shown.length;
  return `${shown.join(", ")}${
    others ? ` and ${others} other${others === 1 ? "" : "s"}` : ""
  }`;
}

export function ConfirmGroupCheckpointDialog({
  open,
  intent,
  groupName,
  targetLabel,
  targetChipLabel,
  currentLabel,
  expectedUpdatedAt,
  checkpointRevision,
  members,
  saving,
  error,
  onConfirm,
  onCancel,
  finalFocusEl,
}: {
  open: boolean;
  intent: GroupCheckpointIntent;
  groupName: string;
  /** The band being written, in words. Null for a clear (nothing is written). */
  targetLabel: string | null;
  /** The same band as the matrix chip, e.g. "G7". Null for a clear. */
  targetChipLabel: string | null;
  /** The band the group holds NOW, in words; null when it holds none. */
  currentLabel: string | null;
  /** Revision shown when the request opened. */
  expectedUpdatedAt?: number | null;
  /** Live preview revision; undefined means the preview is still loading. */
  checkpointRevision?: number | null;
  /** The server preview for THIS request. `undefined` ⇒ still loading. */
  members: GroupCheckpointMembersPreview | undefined;
  saving: boolean;
  /** A write that failed. The dialog stays open and says so. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus returns when the dialog closes — the control that opened it. */
  finalFocusEl?: () => HTMLElement | null;
}) {
  // Focus starts on Cancel, never on the write: this dialog exists because the
  // action is consequential, so the safe exit is what a stray Enter hits.
  const cancelRef = useRef<HTMLButtonElement>(null);

  const clearing = intent === "clear";
  // A clear has no target, so the server computes no scope blockers for it, and
  // membership conflicts do not block a removal — only a set/move can be
  // refused. Reading both lists unconditionally would disable a Confirm the
  // server would happily accept.
  const blockedByScope = clearing ? [] : (members?.blockedByScope ?? []);
  const blockedByGroup = clearing ? [] : (members?.blockedByGroup ?? []);
  const blocked = blockedByScope.length > 0 || blockedByGroup.length > 0;
  const stale =
    checkpointRevision !== undefined &&
    checkpointRevision !== (expectedUpdatedAt ?? null);

  const total = members?.total ?? 0;
  const title = members
    ? groupCheckpointActionLabel(intent, total)
    : "Checking this group…";

  return (
    <Dialog.Root
      open={open}
      role="alertdialog"
      initialFocusEl={() => cancelRef.current}
      {...(finalFocusEl ? { finalFocusEl } : {})}
      onOpenChange={(details) => {
        // Escape, the backdrop, and the close affordance all land here, and all
        // of them mean "do not write". A save in flight is not interruptible.
        if (!details.open && !saving) onCancel();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent
            maxW="480px"
            w="95vw"
            data-testid="group-checkpoint-dialog"
          >
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Math group checkpoint
                </Text>
                <Dialog.Title asChild>
                  <Heading
                    size="md"
                    color="navy.500"
                    fontFamily="heading"
                    data-testid="group-checkpoint-title"
                  >
                    {title}
                  </Heading>
                </Dialog.Title>
                <Text fontSize="sm" color="charcoal.500" mt={1}>
                  {groupName}
                </Text>
              </Stack>
            </Dialog.Header>

            <Dialog.Body px={6} pb={2}>
              {!members ? (
                <Flex
                  align="center"
                  justify="center"
                  gap={2}
                  py={8}
                  data-testid="group-checkpoint-loading"
                >
                  <Spinner size="sm" color="violet.500" />
                  <Text fontSize="sm" color="charcoal.400">
                    Checking what this changes for the group…
                  </Text>
                </Flex>
              ) : (
                <Stack gap={4}>
                  {/* The band, in the matrix's own chip so the target reads as
                      the same mark the cells carry. */}
                  {!clearing && targetLabel && (
                    <Flex align="center" gap={2.5}>
                      {targetChipLabel && (
                        <CheckpointBandChip label={targetChipLabel} />
                      )}
                      <Box minW={0}>
                        <Text
                          fontSize="sm"
                          fontWeight="700"
                          color="charcoal.700"
                          lineClamp={2}
                        >
                          {targetLabel}
                        </Text>
                        {intent === "move" && currentLabel && (
                          <Text fontSize="2xs" color="charcoal.400">
                            Moves off {currentLabel}. A group holds one
                            checkpoint.
                          </Text>
                        )}
                      </Box>
                    </Flex>
                  )}
                  {clearing && currentLabel && (
                    <Text fontSize="sm" fontWeight="700" color="charcoal.700">
                      {currentLabel}
                    </Text>
                  )}

                  {/* Neutral/amber only. This is a "read before you confirm",
                      not a red destructive warning — nothing here deletes a
                      scholar's own checkpoint. */}
                  <Box
                    px={3}
                    py={2.5}
                    borderWidth="1px"
                    borderColor="orange.200"
                    borderRadius="md"
                    bg="orange.50"
                    data-testid="group-checkpoint-policy-note"
                  >
                    <Text fontSize="xs" color="charcoal.600" lineHeight="1.6">
                      {clearing
                        ? `This removes the checkpoint for all ${scholarCountLabel(
                            total,
                          )} in this math group. It changes group policy only — scholars with their own checkpoint keep it.`
                        : `This changes the checkpoint for all ${scholarCountLabel(
                            total,
                          )} in this math group. Individual checkpoint exceptions stay in place.`}
                    </Text>
                  </Box>
                  {stale && (
                    <Box
                      px={3}
                      py={2.5}
                      borderWidth="1px"
                      borderColor="orange.400"
                      borderRadius="md"
                      bg="orange.50"
                      data-testid="group-checkpoint-stale"
                    >
                      <Text fontSize="xs" fontWeight="700" color="charcoal.700">
                        The group checkpoint changed while this confirmation was open.
                      </Text>
                      <Text fontSize="xs" color="charcoal.600" lineHeight="1.5" mt={0.5}>
                        Close this confirmation, review the new checkpoint, then reopen it.
                      </Text>
                    </Box>
                  )}

                  {/* Who is actually affected, and who is not. */}
                  <Box data-testid="group-checkpoint-members">
                    <Text
                      fontSize="2xs"
                      fontWeight="700"
                      color="charcoal.400"
                      textTransform="uppercase"
                      letterSpacing="0.04em"
                      mb={1}
                    >
                      {scholarCountLabel(total)} in this group
                    </Text>
                    {blocked && (
                      <Text
                        fontSize="xs"
                        color="charcoal.500"
                        lineHeight="1.5"
                        mb={1}
                        data-testid="group-checkpoint-members-after-blockers"
                      >
                        If these blockers are resolved, this is what would happen:
                      </Text>
                    )}
                    <Stack gap={0.5}>
                      {exceptionRows(members).map((row) => (
                        <Text
                          key={row.key}
                          fontSize="xs"
                          color="charcoal.500"
                          lineHeight="1.5"
                          data-testid={`group-checkpoint-members-${row.key}`}
                        >
                          <Text as="span" fontWeight="700" color="charcoal.700">
                            {row.count}
                          </Text>{" "}
                          {row.label}
                        </Text>
                      ))}
                    </Stack>
                  </Box>

                  {blocked && (
                    <Box
                      px={3}
                      py={2.5}
                      borderWidth="1px"
                      borderColor="orange.300"
                      borderRadius="md"
                      bg="orange.50"
                      data-testid="group-checkpoint-blockers"
                    >
                      <Flex align="center" gap={1.5} mb={1}>
                        <Box color="orange.600" display="flex">
                          <WarningCircle size={14} weight="fill" />
                        </Box>
                        <Text fontSize="sm" fontWeight="700" color="charcoal.700">
                          This cannot be saved yet
                        </Text>
                      </Flex>
                      <Stack gap={1.5}>
                        {blockedByGroup.length > 0 && (
                          <Text
                            fontSize="xs"
                            color="charcoal.600"
                            lineHeight="1.6"
                          >
                            {namedList(
                              blockedByGroup.map(
                                (scholar) =>
                                  `${scholar.name} (${scholar.groupName})`,
                              ),
                            )}{" "}
                            already belong to another math group that holds a
                            checkpoint. Remove them from that group first — a
                            scholar can follow only one.
                          </Text>
                        )}
                        {blockedByScope.length > 0 && (
                          <Text
                            fontSize="xs"
                            color="charcoal.600"
                            lineHeight="1.6"
                          >
                            {namedList(
                              blockedByScope.map((scholar) => scholar.name),
                            )}{" "}
                            {blockedByScope.length === 1 ? "has" : "have"} a
                            practice scope that excludes this band. Widen it in
                            their math plan, or pick a band inside it.
                          </Text>
                        )}
                      </Stack>
                    </Box>
                  )}

                  {error && (
                    <Text
                      fontSize="xs"
                      color="red.600"
                      lineHeight="1.6"
                      data-testid="group-checkpoint-error"
                    >
                      {error}
                    </Text>
                  )}
                </Stack>
              )}
            </Dialog.Body>

            <Flex px={6} py={4} gap={2} justify="flex-end">
              <Button
                ref={cancelRef}
                size="sm"
                variant="ghost"
                onClick={onCancel}
                disabled={saving}
                data-testid="group-checkpoint-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                colorPalette="violet"
                onClick={onConfirm}
                loading={saving}
                disabled={!members || blocked || stale || saving}
                data-testid="group-checkpoint-confirm"
              >
                {clearing
                  ? "Clear checkpoint"
                  : intent === "move"
                    ? "Move checkpoint"
                    : "Set checkpoint"}
              </Button>
            </Flex>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
