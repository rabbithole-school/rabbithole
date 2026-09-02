"use client";

/**
 * GroupCheckpointBandControl — the math GROUP's checkpoint, authored on the band
 * the selected skill names. The scholar-altitude twin of
 * `CheckpointBandControl`, in the same panel slot, wearing the same chip · band
 * line · notes · one full-width action.
 *
 * Two things it does differently, both because a group write is not a scholar
 * write:
 *  • It never mutates. It raises a request; the view opens
 *    `ConfirmGroupCheckpointDialog` and owns the single write behind it. One
 *    policy row for every member is not a one-click action.
 *  • Its count is the group's SERVER member total, not the matrix's filtered
 *    column count — the write reaches members a filter is hiding, so a label
 *    counted from what is on screen would understate it.
 *
 * The band chip carries NO mode corner here on purpose. Mode is derived per
 * scholar from that scholar's band fluency, so a group of four has up to four of
 * them; picking one hue for the group would state a reading nobody made. The
 * canonical `CheckpointMark` on the action, and the neutral "this group's
 * checkpoint" line, are the same current-checkpoint vocabulary the header grade
 * pill uses — the cells' own mark, never a bare flag glyph.
 */

import { useRef } from "react";
import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";

import {
  CheckpointBandChip,
  CheckpointMark,
} from "@/components/practice/MathPlanMarks";
import {
  groupCheckpointActionLabel,
  scholarCountLabel,
  type GroupCheckpointIntent,
  type MathPlanCheckpoint,
} from "@/components/practice/mathPlanProjection";

export function GroupCheckpointBandControl({
  groupName,
  memberTotal,
  band,
  bandLabel,
  bandSkillCount,
  currentLabel,
  isCurrent,
  onRequest,
}: {
  groupName: string;
  /** The group's exact server-side member total. */
  memberTotal: number;
  /** The band the selected skill names; null when that skill has no grade. */
  band: MathPlanCheckpoint | null;
  /** That band in words — "Chance · grade 7". */
  bandLabel: string | null;
  /** How many skills the band holds, from the UNFILTERED domain nodes. */
  bandSkillCount: number;
  /** The band the group holds now, in words; null when it holds none. */
  currentLabel: string | null;
  /** Whether the group's stored checkpoint IS this band. */
  isCurrent: boolean;
  /** Ask for a confirmation. The trigger is handed back so focus can return. */
  onRequest: (
    intent: GroupCheckpointIntent,
    target: MathPlanCheckpoint | null,
    trigger: HTMLElement | null,
  ) => void;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);

  // Clearing is the one action that needs no band, so an ungraded skill still
  // offers it when this group holds a checkpoint elsewhere; otherwise there is
  // nothing to author here and the control states why rather than vanishing.
  const intent: GroupCheckpointIntent = !band
    ? "clear"
    : isCurrent
      ? "clear"
      : currentLabel
        ? "move"
        : "set";
  const disabled = !band && !currentLabel;

  const notes: string[] = [];
  if (!band) {
    notes.push(
      "This skill has no grade, so it cannot anchor a checkpoint. Pick a graded skill in this strand.",
    );
    if (currentLabel) {
      notes.push(`${groupName} is checkpointed at ${currentLabel}.`);
    }
  } else if (isCurrent) {
    notes.push(
      `${groupName}\u2019s checkpoint. Clearing it removes the group\u2019s policy; scholars keeping their own are untouched.`,
    );
  } else {
    notes.push(
      `${bandSkillCount} ${bandSkillCount === 1 ? "skill" : "skills"} in this band, for ${scholarCountLabel(memberTotal)}.`,
    );
    if (currentLabel) {
      notes.push(
        `${groupName} holds one checkpoint, so this moves it off ${currentLabel}.`,
      );
    }
  }

  const label = disabled
    ? "No band"
    : groupCheckpointActionLabel(intent, memberTotal);
  const ariaLabel = disabled
    ? `This skill has no grade, so it cannot anchor a checkpoint for ${groupName}.`
    : intent === "clear"
      ? `${label} in ${groupName}. Opens a confirmation.`
      : `${label} in ${groupName}, at ${bandLabel}. Opens a confirmation.`;

  return (
    <Box mb={4} data-testid="group-checkpoint-band-control">
      <Flex align="center" gap={2} mb={2}>
        {band && (
          <CheckpointBandChip label={`G${band.grade}`} />
        )}
        <Box minW={0}>
          <Flex align="center" gap={1.5} flexWrap="wrap">
            <Text
              fontSize="sm"
              fontWeight="700"
              color="charcoal.700"
              lineClamp={2}
            >
              {bandLabel ?? "No band"}
            </Text>
            {isCurrent && (
              <Box
                as="span"
                display="inline-flex"
                alignItems="center"
                gap={1}
                px={1.5}
                py="1px"
                borderRadius="full"
                bg="gray.100"
                color="charcoal.700"
                fontSize="2xs"
                fontWeight="700"
                flexShrink={0}
                data-testid="group-checkpoint-current-pill"
              >
                <CheckpointMark size={12} />
                Group checkpoint
              </Box>
            )}
          </Flex>
          <Stack gap={0.5} mt={0.5}>
            {notes.map((note) => (
              <Text
                key={note}
                fontSize="2xs"
                color="charcoal.400"
                lineHeight="1.5"
              >
                {note}
              </Text>
            ))}
          </Stack>
        </Box>
      </Flex>

      <Button
        ref={actionRef}
        size="sm"
        w="100%"
        minH="44px"
        cursor={disabled ? "not-allowed" : "pointer"}
        variant="outline"
        colorPalette="violet"
        disabled={disabled}
        onClick={() => onRequest(intent, band, actionRef.current)}
        aria-label={ariaLabel}
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "violet.500",
          outlineOffset: "1px",
        }}
        data-testid="group-checkpoint-band-action"
      >
        {!disabled && intent !== "clear" && <CheckpointMark size={14} />}
        {label}
      </Button>
    </Box>
  );
}
