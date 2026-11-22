"use client";

// School › Classes & times › Field trips (TRA-601). Staff enter a trip here:
// which groups go, the day, when it leaves and gets back, where, and notes.
// It lives beside the bell schedule and the weekly classes because its whole
// effect is on them: a going group's classes that overlap the trip don't meet
// that day. Rabbithole is the source of truth (nothing syncs from a Google
// calendar), and scholars and families see the trip on their own views.
//
// The backend is the authority on who may write (fieldTrips.create / update /
// cancel: teachers and admins of the trip's school). Trips belong to one
// school, so under the all-schools lens the section asks for one.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Checkbox,
  Field,
  HStack,
  Input,
  Stack,
  Text,
  Textarea,
  Wrap,
} from "@chakra-ui/react";
import { Bus, Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { EmptyState } from "@/components/ui/EmptyState";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { tripTimeRange, tripTimesProblem } from "@/shared/fieldTrips";
import { shortDayLabel } from "@/shared/schoolClosures";

type ListData = NonNullable<ReturnType<typeof useQuery<typeof api.fieldTrips.listForSchool>>>;
type Trip = ListData["trips"][number];
type Group = ListData["groups"][number];

type Draft = {
  groupIds: string[];
  dayKey: string;
  startLocal: string;
  endLocal: string;
  destination: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  groupIds: [],
  dayKey: "",
  startLocal: "09:00",
  endLocal: "12:00",
  destination: "",
  notes: "",
};

function fail(title: string, err: unknown) {
  toaster.create({
    title,
    description: serverErrorMessage(err, "Check your connection and try again."),
    type: "error",
  });
}

export function FieldTrips({ scope }: { scope: string }) {
  const data = useQuery(api.fieldTrips.listForSchool, { scope: scope || undefined });
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Surface p={{ base: 4, md: 6 }}>
      <SectionEyebrow>Field trips</SectionEyebrow>
      <Text fontSize="sm" color="charcoal.400" mt={1} mb={4}>
        The groups going miss the classes the trip overlaps that day. Scholars
        see the trip on Home, and families see it in their homework week and
        calendar. Staff notes stay with staff.
      </Text>
      {data === undefined ? (
        <Text fontSize="sm" color="charcoal.400">Loading…</Text>
      ) : !data.institution ? (
        <EmptyState
          icon={<Bus />}
          title="Pick a school"
          hint="A field trip belongs to one school. Choose it in the school switcher to see and add its trips."
        />
      ) : (
        <Stack gap={0}>
          {data.trips.length === 0 && !adding && (
            <EmptyState
              icon={<Bus />}
              title="No field trips coming up"
              cta={{ label: "Add a field trip", icon: <Plus size={14} />, onClick: () => setAdding(true) }}
            />
          )}
          {data.trips.map((trip) =>
            editingId === trip.id ? (
              <TripForm
                key={trip.id}
                groups={data.groups}
                initial={{
                  ...trip,
                  // A stored group that moved schools or was deleted isn't in
                  // the picker; leave it out so saving drops it.
                  groupIds: trip.groupIds
                    .map(String)
                    .filter((id) => data.groups.some((g) => g.id === id)),
                  notes: trip.notes ?? "",
                }}
                tripId={trip.id}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <TripRow
                key={trip.id}
                trip={trip}
                groups={data.groups}
                isPast={trip.dayKey < (data.todayDayKey ?? "")}
                onEdit={() => {
                  setAdding(false);
                  setEditingId(trip.id);
                }}
              />
            ),
          )}
          {adding ? (
            <TripForm
              groups={data.groups}
              initial={EMPTY_DRAFT}
              scope={scope}
              onDone={() => setAdding(false)}
            />
          ) : (
            data.trips.length > 0 && (
              <Box pt={3}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingId(null);
                    setAdding(true);
                  }}
                >
                  <Plus size={14} /> Add a field trip
                </Button>
              </Box>
            )
          )}
        </Stack>
      )}
    </Surface>
  );
}

function groupLabel(group: Group): string {
  return group.emoji ? `${group.emoji} ${group.name}` : group.name;
}

function TripRow({
  trip,
  groups,
  isPast,
  onEdit,
}: {
  trip: Trip;
  groups: Group[];
  isPast: boolean;
  onEdit: () => void;
}) {
  const cancelTrip = useMutation(api.fieldTrips.cancel);
  const [confirming, setConfirming] = useState(false);
  const going = trip.groupIds
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is Group => !!g)
    .map(groupLabel)
    .join(", ");
  return (
    <Box py={3} borderBottom="1px solid" borderColor="gray.100">
      <HStack justify="space-between" align="start" gap={3} flexWrap="wrap">
        <Box minW={0}>
          <Text fontFamily="heading" fontWeight="600" color={isPast ? "charcoal.400" : "navy.700"}>
            {trip.destination}
          </Text>
          <Text fontSize="sm" color="charcoal.500">
            {shortDayLabel(trip.dayKey)} · {tripTimeRange(trip)} · {going || "No groups"}
          </Text>
          {trip.notes && (
            <Text fontSize="sm" color="charcoal.400" mt={0.5} whiteSpace="pre-wrap">
              {trip.notes}
            </Text>
          )}
        </Box>
        <HStack gap={1}>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" color="red.600" onClick={() => setConfirming(true)}>
            Cancel trip
          </Button>
        </HStack>
      </HStack>
      {confirming && (
        <HStack gap={2} mt={2} flexWrap="wrap">
          <Text fontSize="sm" color="charcoal.500">
            Cancel the trip to {trip.destination}? Its groups&apos; classes meet
            again that day.
          </Text>
          <Button
            size="sm"
            colorPalette="red"
            onClick={async () => {
              try {
                await cancelTrip({ tripId: trip.id });
              } catch (err) {
                fail("Couldn't cancel the trip", err);
              }
              setConfirming(false);
            }}
          >
            Cancel trip
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </HStack>
      )}
    </Box>
  );
}

function TripForm({
  groups,
  initial,
  tripId,
  scope,
  onDone,
}: {
  groups: Group[];
  initial: Draft;
  /** Set when editing; absent when adding. */
  tripId?: Id<"fieldTrips">;
  scope?: string;
  onDone: () => void;
}) {
  const createTrip = useMutation(api.fieldTrips.create);
  const updateTrip = useMutation(api.fieldTrips.update);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  // The server says the same thing; checking here keeps Save honest.
  const problem = !draft.destination.trim()
    ? "Where is the trip going?"
    : draft.groupIds.length === 0
      ? "Which groups are going?"
      : tripTimesProblem(draft);

  async function save() {
    if (problem) return;
    setSaving(true);
    const fields = {
      groupIds: draft.groupIds as Id<"scholarGroups">[],
      dayKey: draft.dayKey,
      startLocal: draft.startLocal,
      endLocal: draft.endLocal,
      destination: draft.destination,
      notes: draft.notes,
    };
    try {
      if (tripId) await updateTrip({ tripId, ...fields });
      else await createTrip({ scope: scope || undefined, ...fields });
      onDone();
    } catch (err) {
      fail("Couldn't save the trip", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box py={3} borderBottom="1px solid" borderColor="gray.100">
      <Stack gap={3}>
        <Field.Root>
          <Field.Label fontFamily="heading">Where</Field.Label>
          <Input
            size="sm"
            value={draft.destination}
            placeholder="Kualoa Ranch"
            onChange={(e) => set({ destination: e.target.value })}
          />
        </Field.Root>
        <HStack gap={3} align="end" flexWrap="wrap">
          <Field.Root maxW="11rem">
            <Field.Label fontFamily="heading">Day</Field.Label>
            <Input
              size="sm"
              type="date"
              value={draft.dayKey}
              onChange={(e) => set({ dayKey: e.target.value })}
            />
          </Field.Root>
          <Field.Root maxW="8rem">
            <Field.Label fontFamily="heading">Leaves</Field.Label>
            <Input
              size="sm"
              type="time"
              value={draft.startLocal}
              onChange={(e) => set({ startLocal: e.target.value })}
            />
          </Field.Root>
          <Field.Root maxW="8rem">
            <Field.Label fontFamily="heading">Back</Field.Label>
            <Input
              size="sm"
              type="time"
              value={draft.endLocal}
              onChange={(e) => set({ endLocal: e.target.value })}
            />
          </Field.Root>
        </HStack>
        <Box>
          <Text fontFamily="heading" fontSize="sm" fontWeight="500" mb={1.5}>
            Groups going
          </Text>
          <Wrap gap={4}>
            {groups.map((group) => (
              <Checkbox.Root
                key={group.id}
                size="sm"
                colorPalette="violet"
                checked={draft.groupIds.includes(group.id)}
                onCheckedChange={(details) =>
                  set({
                    groupIds:
                      details.checked === true
                        ? [...draft.groupIds, group.id]
                        : draft.groupIds.filter((id) => id !== group.id),
                  })
                }
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label fontFamily="heading">{groupLabel(group)}</Checkbox.Label>
              </Checkbox.Root>
            ))}
          </Wrap>
        </Box>
        <Field.Root>
          <Field.Label fontFamily="heading">Staff notes</Field.Label>
          <Textarea
            size="sm"
            rows={2}
            value={draft.notes}
            placeholder="Only staff see this, e.g. bus 3, chaperones"
            onChange={(e) => set({ notes: e.target.value })}
          />
        </Field.Root>
        <HStack gap={2} flexWrap="wrap">
          <Button
            size="sm"
            colorPalette="violet"
            disabled={!!problem || saving}
            loading={saving}
            onClick={save}
          >
            {tripId ? "Save trip" : "Add trip"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          {problem && draft !== initial && (
            <Text fontSize="sm" color="charcoal.400">
              {problem}
            </Text>
          )}
        </HStack>
      </Stack>
    </Box>
  );
}
