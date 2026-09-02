"use client";

/**
 * DidThisHappenSection — the two-answer past-meeting dialog (§7 of
 * review/unit-flow-into-class-plan.html), extracted so the SAME component
 * serves both the per-placement PlacementDetailDrawer AND the per-class
 * ClassDrawer (T1: one rendering of "did this happen?", never forked).
 *
 * Rendered only for a PAST meeting of a unit sequence (a concrete, past-dated
 * chip that links an assignment + activity + sequence). The two answers touch
 * different layers, so neither needs a new field on the row:
 *   • Yes — mark as done  → activityCompletions.markCompleteForGroup (learning
 *     record; the plan/chip stays where history put it). A roster checklist lets
 *     the teacher uncheck absentees.
 *   • No — push the rest  → masterSchedule.reflowSequence (plan projection; the
 *     tail slides one meeting later, rows updated in place).
 *
 * `onDone` fires after a successful answer. The placement drawer passes its
 * `onClose` (answering closes the single-placement drawer); the class drawer
 * passes a no-op — its reactive spine simply re-derives (a "No" moves the
 * meeting into Upcoming; a "Yes" leaves it, idempotent).
 */
import { useMemo, useState } from "react";
import { Box, Button, HStack, Text, VStack, chakra } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { useNow } from "@/hooks/useNow";

type GridData = NonNullable<ReturnType<typeof useQuery<typeof api.masterSchedule.grid>>>;
type Placement = GridData["placements"][number];

/** What a successful answer did — surfaced to callers so a host (the class
 *  drawer) can show a quiet acknowledgment in place of the dialog. */
export type DidThisHappenResult =
  | { kind: "marked"; count: number }
  | { kind: "pushed"; count: number };

function hhmmToMinutes(hhmm: string): number | null {
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
}

export function DidThisHappenSection({
  placement: p,
  grid,
  onDone,
}: {
  placement: Placement;
  grid: GridData;
  /** Called after a successful answer, with what it did. Placement drawer →
   *  onClose (ignores the arg); class drawer → records it to swap the dialog for
   *  a one-line acknowledgment (the reactive spine also re-derives). */
  onDone: (result: DidThisHappenResult) => void;
}) {
  const markGroup = useMutation(api.activityCompletions.markCompleteForGroup);
  const reflow = useMutation(api.masterSchedule.reflowSequence);
  const [answer, setAnswer] = useState<null | "yes">(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Applicable only to a past meeting of a unit sequence.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const meetingEndMs = useMemo(() => {
    if (p.weekStartMs == null || p.weekday == null || !p.blockId) return null;
    const block = grid.blocks.find((b) => String(b._id) === String(p.blockId));
    const endMins = block ? hhmmToMinutes(block.endLocal) : null;
    const base = p.weekStartMs + (p.weekday - 1) * DAY_MS;
    return endMins != null ? base + endMins * 60_000 : base + DAY_MS - 1;
  }, [p.weekStartMs, p.weekday, p.blockId, grid.blocks, DAY_MS]);
  // `applicable` flips solely because the meeting end passes, so it needs a
  // clock: without one, a meeting that ended while the drawer was open never
  // grew its "Did this activity happen?" controls unless something unrelated
  // re-rendered the row.
  const nowMs = useNow(60_000);
  const applicable =
    Boolean(p.sequenceId && p.assignmentId && p.activityId) &&
    meetingEndMs != null &&
    meetingEndMs < nowMs;

  const roster = useQuery(
    api.activityCompletions.rosterForAssignment,
    applicable && answer === "yes" && p.assignmentId
      ? { assignmentId: p.assignmentId as Id<"assignments"> }
      : "skip",
  );

  if (!applicable) return null;

  const activityLabel = p.activityTitle ?? p.subject;

  async function confirmYes() {
    if (!p.assignmentId || !p.activityId) return;
    // Guard against submitting before the roster resolves — an unresolved roster
    // would send scholarIds: [] and falsely report success for zero scholars.
    // (Roster loaded + all unchecked → [] is a legitimate explicit teacher choice.)
    if (roster === undefined) return;
    const scholarIds = (roster?.scholars ?? [])
      .map((s) => s._id)
      .filter((id) => !unchecked.has(String(id)));
    setBusy(true);
    try {
      const res = await markGroup({
        assignmentId: p.assignmentId as Id<"assignments">,
        activityId: p.activityId as Id<"activities">,
        scholarIds,
      });
      toaster.create({
        title: `Marked done for ${res.marked} scholar${res.marked === 1 ? "" : "s"}`,
        type: "success",
      });
      onDone({ kind: "marked", count: res.marked });
    } catch (err) {
      toaster.create({ title: "Couldn't mark complete", description: String(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function pushTheRest() {
    if (!p.sequenceId || p.sequenceIndex == null) return;
    setBusy(true);
    try {
      const res = await reflow({ sequenceId: p.sequenceId, fromIndex: p.sequenceIndex });
      toaster.create({
        title: `Pushed ${res.count} activit${res.count === 1 ? "y" : "ies"} back a meeting`,
        type: "success",
      });
      onDone({ kind: "pushed", count: res.count });
    } catch (err) {
      toaster.create({ title: "Couldn't push the rest", description: String(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box borderWidth="1px" borderColor="amber.200" bg="amber.50" borderRadius="md" p={3}>
      <SectionEyebrow>Did this activity happen?</SectionEyebrow>
      <Text fontSize="xs" color="charcoal.500" mt={1.5} mb={2.5}>
        This meeting for <chakra.strong>{activityLabel}</chakra.strong> has passed.
      </Text>
      {answer !== "yes" ? (
        <VStack align="stretch" gap={2}>
          <Button
            size="sm"
            colorPalette="green"
            disabled={busy}
            onClick={() => setAnswer("yes")}
          >
            <HStack gap={1.5}><Check size={15} /> Yes — mark as done</HStack>
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={pushTheRest}>
            No — push the rest
          </Button>
        </VStack>
      ) : roster?.forbidden ? (
        <VStack align="stretch" gap={2}>
          <Text fontSize="xs" color="charcoal.500">
            This class&apos;s scholars aren&apos;t in your current context, so you can&apos;t
            mark completions for them.
          </Text>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAnswer(null)}>
            Back
          </Button>
        </VStack>
      ) : (
        <VStack align="stretch" gap={2}>
          <Text fontSize="2xs" color="charcoal.400">
            Marking complete for the class. Uncheck anyone who was absent.
          </Text>
          <VStack align="stretch" gap={1} maxH="180px" overflowY="auto">
            {(roster?.scholars ?? []).map((s) => {
              const off = unchecked.has(String(s._id));
              return (
                <chakra.button
                  key={String(s._id)}
                  type="button"
                  textAlign="left"
                  onClick={() =>
                    setUnchecked((prev) => {
                      const next = new Set(prev);
                      if (next.has(String(s._id))) next.delete(String(s._id));
                      else next.add(String(s._id));
                      return next;
                    })
                  }
                >
                  <HStack gap={2}>
                    <Box
                      w={4}
                      h={4}
                      borderRadius="sm"
                      borderWidth="1px"
                      borderColor={off ? "gray.300" : "green.400"}
                      bg={off ? "white" : "green.400"}
                      color="white"
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                      flexShrink={0}
                    >
                      {!off && <Check size={11} weight="bold" />}
                    </Box>
                    <Text fontSize="sm" color={off ? "charcoal.300" : "navy.700"}>
                      {s.name}
                    </Text>
                  </HStack>
                </chakra.button>
              );
            })}
            {roster === undefined && (
              <Text fontSize="2xs" color="charcoal.300">Loading roster…</Text>
            )}
          </VStack>
          <HStack gap={2}>
            <Button size="sm" colorPalette="green" disabled={busy || roster === undefined} onClick={confirmYes}>
              Mark done
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAnswer(null)}>
              Back
            </Button>
          </HStack>
        </VStack>
      )}
    </Box>
  );
}
