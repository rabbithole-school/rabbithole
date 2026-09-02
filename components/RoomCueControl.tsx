"use client";

/**
 * RoomCueControl — the teacher's compact "Room" control: call a room cue
 * (see convex/roomCues.ts) scoped to the whole room or one pod. Lives on the
 * Assignments > Class live view (ClassActiveView) — deliberately not a new
 * nav tab, just one more control alongside "Assign a unit".
 *
 * Three actions, matching the three `roomCues` kinds:
 *   - Send a note      → kind "message"
 *   - Screens down      → kind "rest" (optionally with a "back at" time)
 *   - Screens up        → clears the live rest cue for the current scope
 * "Transition" isn't a separate action here — it's the SAME shape as a note,
 * distinguished by copy ("Send a note" reads as ongoing chatter either way;
 * a later pass can add a transition-flavored send if teachers want the
 * distinct scholar-facing framing without a second text box).
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  HStack,
  Input,
  Popover,
  Portal,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Megaphone, Moon, PaperPlaneTilt, Sun } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { GroupScopePicker } from "@/components/GroupScopePicker";
import { ManageGroupsDialog } from "@/components/ManageGroupsDialog";
import { toaster } from "@/lib/toaster";
import { formatReturnAtClock } from "@/shared/roomCueCopy";

/** "14:05" (from an <input type="time">) → the next occurrence of that
 * wall-clock time as an epoch ms — today if it hasn't passed yet, else
 * tomorrow. Returns null for an empty/invalid string. */
function nextOccurrenceOf(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function RoomCueControl() {
  const { groups } = useScholarRoster();
  const [scopeKey, setScopeKey] = useState(""); // "" = whole room
  const [manageOpen, setManageOpen] = useState(false);
  const [note, setNote] = useState("");
  const [returnTime, setReturnTime] = useState("");
  const [busy, setBusy] = useState(false);

  const groupId = scopeKey ? (scopeKey as Id<"scholarGroups">) : undefined;
  const scopeGroup = groups.find((g) => g.id === scopeKey);
  const scopeLabel = scopeKey ? (scopeGroup?.name ?? "Group") : "All scholars";
  const scopeEmoji = scopeKey ? (scopeGroup?.emoji ?? null) : "🏫";

  const activeCues = useQuery(api.roomCues.activeForScope, { groupId });
  const restCue = activeCues?.find((c) => c.kind === "rest") ?? null;

  const callRoomCue = useMutation(api.roomCues.callRoomCue);
  const clearRoomCue = useMutation(api.roomCues.clearRoomCue);

  async function sendNote() {
    const body = note.trim();
    if (!body) return;
    setBusy(true);
    try {
      await callRoomCue({ groupId, kind: "message", body });
      setNote("");
      toaster.success({ title: `Sent to ${scopeLabel}` });
    } catch (error) {
      toaster.error({
        title: "Couldn't send that",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function screensDown() {
    setBusy(true);
    try {
      const returnAt = returnTime ? (nextOccurrenceOf(returnTime) ?? undefined) : undefined;
      await callRoomCue({ groupId, kind: "rest", returnAt });
      toaster.success({ title: `Screens down for ${scopeLabel}` });
    } catch (error) {
      toaster.error({
        title: "Couldn't call screens down",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function screensUp() {
    if (!restCue) return;
    setBusy(true);
    try {
      await clearRoomCue({ cueId: restCue.cueId });
      toaster.success({ title: `Screens up for ${scopeLabel}` });
    } catch (error) {
      toaster.error({
        title: "Couldn't clear that",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover.Root positioning={{ placement: "bottom-end" }}>
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant="outline"
          color="navy.600"
          borderColor="gray.200"
          fontFamily="heading"
          fontWeight="600"
        >
          <Megaphone size={14} style={{ marginRight: 6 }} />
          Room
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content w="340px" shadow="lg" borderRadius="lg">
            <Popover.Body p={4}>
              <Stack gap={3}>
                <Stack gap={1}>
                  <Text fontSize="2xs" textTransform="uppercase" letterSpacing="0.04em" color="charcoal.300" fontFamily="heading" fontWeight="700">
                    Send to
                  </Text>
                  <GroupScopePicker
                    groups={groups}
                    scopeKey={scopeKey}
                    scopeLabel={scopeLabel}
                    scopeEmoji={scopeEmoji}
                    hasMine={false}
                    onSelectScope={setScopeKey}
                    onManageGroups={() => setManageOpen(true)}
                    variant="compact"
                    portalled={false}
                  />
                </Stack>

                <Box borderTopWidth="1px" borderColor="gray.100" />

                <Stack gap={1.5}>
                  <Text fontSize="2xs" textTransform="uppercase" letterSpacing="0.04em" color="charcoal.300" fontFamily="heading" fontWeight="700">
                    Send a note
                  </Text>
                  <Textarea
                    placeholder="Clean up in two minutes — then we're on the rug."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    size="sm"
                    rows={2}
                    disabled={busy}
                  />
                  <Button
                    size="xs"
                    alignSelf="flex-end"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    disabled={!note.trim() || busy}
                    onClick={sendNote}
                  >
                    <PaperPlaneTilt size={12} style={{ marginRight: 4 }} />
                    Send
                  </Button>
                </Stack>

                <Box borderTopWidth="1px" borderColor="gray.100" />

                <Stack gap={1.5}>
                  <Text fontSize="2xs" textTransform="uppercase" letterSpacing="0.04em" color="charcoal.300" fontFamily="heading" fontWeight="700">
                    Screens
                  </Text>
                  {restCue ? (
                    <Stack gap={2}>
                      <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                        Resting for {scopeLabel}
                        {restCue.returnAt
                          ? ` — back at ${formatReturnAtClock(restCue.returnAt)}`
                          : ""}
                        .
                      </Text>
                      <Button
                        size="xs"
                        variant="outline"
                        color="navy.600"
                        disabled={busy}
                        onClick={screensUp}
                      >
                        <Sun size={12} style={{ marginRight: 4 }} />
                        Screens up
                      </Button>
                    </Stack>
                  ) : (
                    <Stack gap={2}>
                      <HStack gap={2}>
                        <Text fontSize="xs" color="charcoal.400" fontFamily="heading" whiteSpace="nowrap">
                          Back at (optional)
                        </Text>
                        <Input
                          type="time"
                          size="xs"
                          value={returnTime}
                          onChange={(e) => setReturnTime(e.target.value)}
                          disabled={busy}
                        />
                      </HStack>
                      <Button
                        size="xs"
                        variant="outline"
                        color="navy.600"
                        alignSelf="flex-start"
                        disabled={busy}
                        onClick={screensDown}
                      >
                        <Moon size={12} style={{ marginRight: 4 }} />
                        Screens down
                      </Button>
                    </Stack>
                  )}
                </Stack>
              </Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
      <ManageGroupsDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </Popover.Root>
  );
}
