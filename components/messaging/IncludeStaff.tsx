"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Button,
  HStack,
  Popover,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { UserPlus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";

/** An adult who may be NAMED on a scholar's mentor thread (server rule:
 *  the scholar's teaching team, or a mentor whose live grant covers them). */
export type IncludableStaff = {
  _id: Id<"users">;
  name: string;
  image: string | null;
  role: "teacher" | "mentor" | "staff";
};

const ROLE_LABELS: Record<IncludableStaff["role"], string> = {
  teacher: "Teacher",
  mentor: "Mentor",
  staff: "Staff",
};

/** Toggle pills for choosing named adults — shared by "Message scholars"
 *  (compose) and "Add people" (an open thread). */
export function IncludeStaffPills({
  candidates,
  selected,
  onToggle,
}: {
  candidates: IncludableStaff[];
  selected: ReadonlySet<Id<"users">>;
  onToggle: (userId: Id<"users">) => void;
}) {
  return (
    <HStack gap={1.5} flexWrap="wrap">
      {candidates.map((person) => {
        const isSelected = selected.has(person._id);
        return (
          <HStack
            key={person._id}
            as="button"
            aria-pressed={isSelected}
            gap={1.5}
            pl={1}
            pr={2.5}
            py={1}
            borderRadius="full"
            borderWidth="1px"
            borderColor={isSelected ? "violet.400" : "gray.200"}
            bg={isSelected ? "violet.50" : "white"}
            cursor="pointer"
            _hover={{ borderColor: "violet.300" }}
            onClick={() => onToggle(person._id)}
          >
            <Avatar
              size="2xs"
              name={person.name}
              src={person.image ?? undefined}
              colorKey={person._id}
            />
            <Text
              fontFamily="heading"
              fontSize="sm"
              fontWeight="600"
              color={isSelected ? "violet.700" : "charcoal.600"}
            >
              {person.name}
            </Text>
            <Text fontFamily="body" fontSize="xs" color="charcoal.400">
              {ROLE_LABELS[person.role]}
            </Text>
          </HStack>
        );
      })}
    </HStack>
  );
}

export function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * "Add people" on an open mentor thread: names more adults on it (the
 * teaching team can already read every thread; naming someone brings them
 * into it — their own unread, the notification, the "with …" line).
 * Candidates are the server's rule for this scholar minus who's already
 * named (and minus the viewer).
 */
export function AddStaffToThread({
  threadId,
  scholarId,
  excludeIds,
}: {
  threadId: Id<"parentThreads">;
  scholarId: Id<"users">;
  excludeIds: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<Id<"users">>>(new Set());
  const [busy, setBusy] = useState(false);
  const candidates = useQuery(
    api.scholarMessages.listIncludableStaff,
    open ? { scholarIds: [scholarId] } : "skip",
  );
  const addParticipants = useMutation(api.scholarMessages.addParticipants);
  const available = (candidates ?? []).filter((c) => !excludeIds.has(c._id));

  const add = async () => {
    const userIds = [...selected].filter((id) =>
      available.some((c) => c._id === id),
    );
    if (userIds.length === 0 || busy) return;
    setBusy(true);
    try {
      await addParticipants({ threadId, userIds });
      setSelected(new Set());
      setOpen(false);
    } catch (error) {
      toaster.create({
        title: "Couldn't add them",
        description: serverErrorMessage(error, "Please try again."),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (!details.open) setSelected(new Set());
      }}
      positioning={{ placement: "bottom-end" }}
    >
      <Popover.Trigger asChild>
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.500"
          fontFamily="heading"
          fontSize="sm"
          flexShrink={0}
          ml="auto"
        >
          <UserPlus /> Add people
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content w="340px" shadow="lg" borderRadius="lg">
            <Popover.Body p={3}>
              <Stack gap={3}>
                <Text fontFamily="body" fontSize="xs" color="charcoal.500">
                  Name another adult on this conversation. They&apos;ll be
                  notified and can reply here.
                </Text>
                {candidates === undefined ? (
                  <HStack justify="center" py={2}>
                    <Spinner size="sm" color="violet.400" />
                  </HStack>
                ) : available.length === 0 ? (
                  <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                    Everyone who can join is already here.
                  </Text>
                ) : (
                  <IncludeStaffPills
                    candidates={available}
                    selected={selected}
                    onToggle={(id) => setSelected((s) => toggleInSet(s, id))}
                  />
                )}
                <HStack justify="flex-end">
                  <Button
                    size="sm"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    fontFamily="heading"
                    loading={busy}
                    disabled={selected.size === 0}
                    onClick={add}
                  >
                    Add
                  </Button>
                </HStack>
              </Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
