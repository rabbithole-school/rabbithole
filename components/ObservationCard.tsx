"use client";

import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Menu,
  Portal,
  Text,
} from "@chakra-ui/react";
import { ChatCircleText, DotsThreeVertical } from "@phosphor-icons/react";
import { Avatar } from "@/components/Avatar";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { formatTimeAgo } from "@/lib/relativeTime";

// ── ObservationCard ───────────────────────────────────────────────────────
// ONE rendering of a teacher observation, shared by the two surfaces that
// show them: the scholar Feed's activity stream and the Dossier's
// Observations list. Both used to draw their own row — the feed had the
// author's face but no controls, the dossier had the controls but no author —
// so the same note looked like two different objects. This is the single
// canonical card; the surfaces differ only in which optional affordances they
// pass in (clamp / open / discuss / delete / retype).

export type ObservationType =
  | "praise"
  | "concern"
  | "suggestion"
  | "intervention"
  | "note";

/**
 * The shape `api.observations.listByScholar` returns — the stored row plus its
 * resolved author (`authorName`/`authorImage` are null when that user is gone)
 * and `isSelf` for the reader. Structural, so both call sites hand their query
 * rows straight in.
 */
export type ObservationCardRow = {
  _id: string;
  _creationTime: number;
  teacherId: string;
  type: ObservationType;
  note: string;
  authorName: string | null;
  authorImage: string | null;
  isSelf: boolean;
};

const TYPE_BG: Record<ObservationType, string> = {
  praise: "green.100",
  concern: "red.100",
  suggestion: "blue.100",
  intervention: "orange.100",
  note: "gray.100",
};

const TYPE_FG: Record<ObservationType, string> = {
  praise: "green.700",
  concern: "red.700",
  suggestion: "blue.700",
  intervention: "orange.700",
  note: "charcoal.600",
};

/** "You" / the real author's name / a neutral fallback when the user is gone. */
function attribution(obs: ObservationCardRow): string {
  if (obs.isSelf) return "You";
  return obs.authorName ?? "A teacher";
}

/**
 * The one place the "Discuss" prompt is composed, so the feed and the dossier
 * hand the aide an identical sentence. First-person staff phrasing, the note
 * verbatim (the aide gets the whole thing, never the card's clamped view).
 */
export function observationDiscussPrompt(
  obs: ObservationCardRow,
  scholarFirstName?: string | null,
): string {
  const who = obs.isSelf ? "I" : obs.authorName ?? "A teacher";
  const about = scholarFirstName?.trim() || "this scholar";
  return `${who} noted this ${obs.type} about ${about}: “${obs.note}” — help me think about what's going on and how to respond.`;
}

export function ObservationCard({
  observation,
  scholarFirstName,
  clamp,
  onOpen,
  onDiscuss,
  onDelete,
  onSetType,
}: {
  observation: ObservationCardRow;
  /** Used in the Discuss prompt so the aide knows who the note is about. */
  scholarFirstName?: string | null;
  /** Clamp the note to N lines (the feed passes 2; the dossier shows it whole). */
  clamp?: number;
  /** Makes the whole card (minus its controls) a jump to the note's home. */
  onOpen?: () => void;
  /** Receives the composed prompt — callers just seed the aide composer. */
  onDiscuss?: (prompt: string) => void;
  /** Renders Delete in the […] menu. The confirm dialog stays with the caller. */
  onDelete?: () => void;
  /** Makes the type badge an inline editor. */
  onSetType?: (type: ObservationType) => void;
}) {
  const [editingType, setEditingType] = useState(false);
  const stop = (e: React.MouseEvent | React.KeyboardEvent) => e.stopPropagation();

  const who = attribution(observation);
  const clickable = !!onOpen;

  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="charcoal.100"
      borderRadius="xl"
      px={3}
      py={2.5}
      boxShadow="0 1px 2px rgba(34,38,86,.05)"
      _hover={clickable ? { borderColor: "violet.200" } : undefined}
      cursor={clickable ? "pointer" : undefined}
      // Whole-card click with real controls inside: a role, not a <button>, so
      // the Discuss button and […] menu are never nested inside a button.
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={
        clickable
          ? (e: React.KeyboardEvent) => {
              // Ignore keydown bubbling up from a nested control (the Discuss
              // button, the […] menu trigger, the retype badge) — otherwise
              // Enter/Space there would preventDefault the control's own
              // activation and jump to the note's home instead.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen?.();
              }
            }
          : undefined
      }
    >
      <Flex gap={3} align="flex-start">
        {/* Same 34px slot on both surfaces; the 32px avatar centers inside it.
            The generic orb only stands in when the author is gone. */}
        <Flex w="34px" h="34px" align="center" justify="center" flexShrink={0}>
          {observation.authorName ? (
            <Avatar
              size="sm"
              name={observation.authorName}
              src={observation.authorImage ?? undefined}
              colorKey={String(observation.teacherId)}
            />
          ) : (
            <Flex
              w="34px"
              h="34px"
              borderRadius="full"
              bg="blue.100"
              align="center"
              justify="center"
              fontSize="14px"
            >
              <span aria-hidden>📝</span>
            </Flex>
          )}
        </Flex>

        <Box flex={1} minW={0}>
          <HStack gap={2} flexWrap="wrap" mb="3px">
            <Text
              fontSize="xs"
              fontWeight="700"
              fontFamily="heading"
              color="charcoal.500"
            >
              {who} noted
            </Text>
            {editingType && onSetType ? (
              <Box onClick={stop}>
                <FieldSelect
                  w="150px"
                  size="sm"
                  value={observation.type}
                  onChange={(v) => {
                    setEditingType(false);
                    onSetType(v as ObservationType);
                  }}
                  fieldProps={{
                    "aria-label": `Change observation type (currently ${observation.type})`,
                    autoFocus: true,
                    onBlur: () => setEditingType(false),
                  }}
                >
                  <option value="praise">Praise</option>
                  <option value="concern">Concern</option>
                  <option value="suggestion">Suggestion</option>
                  <option value="intervention">Intervention</option>
                  <option value="note">Note</option>
                </FieldSelect>
              </Box>
            ) : (
              <Badge
                as={onSetType ? "button" : "span"}
                onClick={
                  onSetType
                    ? (e: React.MouseEvent) => {
                        stop(e);
                        setEditingType(true);
                      }
                    : undefined
                }
                cursor={onSetType ? "pointer" : undefined}
                aria-label={
                  onSetType
                    ? `Edit type — currently ${observation.type}`
                    : undefined
                }
                _hover={onSetType ? { opacity: 0.8 } : undefined}
                bg={TYPE_BG[observation.type]}
                color={TYPE_FG[observation.type]}
                fontSize="xs"
              >
                {observation.type}
              </Badge>
            )}
            <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
              {formatTimeAgo(observation._creationTime)}
            </Text>
          </HStack>
          <Text
            fontSize="sm"
            color="charcoal.600"
            fontFamily="body"
            lineHeight="1.4"
            lineClamp={clamp}
          >
            {observation.note}
          </Text>
        </Box>

        {(onDiscuss || onDelete) && (
          <HStack gap={1} flexShrink={0} alignSelf="flex-start">
            {onDiscuss && (
              <Button
                size="xs"
                variant="ghost"
                color="violet.600"
                fontFamily="heading"
                fontSize="xs"
                _hover={{ bg: "violet.50" }}
                onClick={(e) => {
                  stop(e);
                  onDiscuss(
                    observationDiscussPrompt(observation, scholarFirstName),
                  );
                }}
              >
                <ChatCircleText /> Discuss
              </Button>
            )}
            {onDelete && (
              <Box onClick={stop}>
                <Menu.Root positioning={{ placement: "bottom-end" }}>
                  <Menu.Trigger asChild>
                    <IconButton
                      aria-label={`Observation actions — ${observation.type} from ${formatTimeAgo(observation._creationTime)}`}
                      variant="ghost"
                      size="xs"
                      color="charcoal.400"
                    >
                      <DotsThreeVertical />
                    </IconButton>
                  </Menu.Trigger>
                  <Portal>
                    <Menu.Positioner>
                      <Menu.Content>
                        <Menu.Item
                          value="delete"
                          fontFamily="heading"
                          fontSize="sm"
                          color="red.600"
                          _hover={{ bg: "red.50" }}
                          onSelect={onDelete}
                        >
                          Delete
                        </Menu.Item>
                      </Menu.Content>
                    </Menu.Positioner>
                  </Portal>
                </Menu.Root>
              </Box>
            )}
          </HStack>
        )}
      </Flex>
    </Box>
  );
}
