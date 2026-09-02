"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  HStack,
  Text,
  Button,
  Dialog,
  IconButton,
  Portal,
} from "@chakra-ui/react";
import { Lock, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { UnitOutlineTree, type TreeSelection } from "./UnitOutlineTree";
import { HierarchyColumn, HierarchyRow } from "@/components/hierarchy";
import { SubjectFilterChips } from "@/components/SubjectFilterChips";
import { subjectMatches, uniqueSubjects } from "@/lib/subjects";

interface UnitOption {
  id: string;
  title: string;
  emoji?: string | null;
  description?: string | null;
  subject?: string | null;
}

export interface PickerSelection {
  unitId: string | null;
  lessonId: string | null;
  activityId: string | null;
}

interface UnitPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (sel: PickerSelection) => void;
  units: UnitOption[];
  focusLock?: {
    unitId?: string | null;
    lessonId?: string | null;
    lessonTitle?: string | null;
  } | null;
  // Pre-focus a unit's activity list (column 2) when the dialog opens,
  // WITHOUT the focus-lock semantics — the scholar can still navigate to
  // other units. Used by the home's Independent-study cards to land the
  // scholar directly on their unit's activities. Ignored when focusLock
  // is set (the lock takes precedence).
  initialUnitId?: string | null;
  isCreating?: boolean;
  // When false, the "Independent Study" entry is hidden (e.g. teacher start
  // dialog where IS isn't a meaningful focus target). Defaults to true.
  showIndependentStudy?: boolean;
  // Override the title shown at the top of the dialog.
  title?: { step1?: string; step2?: (unitTitle: string) => string };
  // Override the confirm-button label when an activity (or startable lesson)
  // is selected. Defaults to "Start this activity" / "Start this lesson".
  confirmLabelOverride?: string;
}

/**
 * Scholar "new project" picker — Finder-style two-column drill-down:
 *   Column 1: Independent Study + unit list
 *   Column 2: outline of the picked unit (lessons + activities,
 *             grouped by strand)
 * + sticky bottom Start button.
 *
 * Same column primitives as StartAssignmentDialog and the Curriculum
 * units browser, so the scholar's mental model matches the teacher's.
 * Column 2 uses UnitOutlineTree under the hood — once that component
 * is refactored to consume HierarchyRow primitives (step 5 of the
 * hierarchy DRY pass), both surfaces inherit the same visual style.
 */
export function UnitPickerDialog({
  open,
  onClose,
  onSelect,
  units,
  focusLock,
  initialUnitId = null,
  isCreating = false,
  showIndependentStudy = true,
  title,
  confirmLabelOverride,
}: UnitPickerDialogProps) {
  const rawLockedUnitId = focusLock?.unitId ?? null;
  const rawLockedLessonId = focusLock?.lessonId ?? null;

  // Look up the locked unit's activities + this scholar's completions
  // so we can determine whether the focus is effectively complete.
  const lockedUnitActivities = useQuery(
    api.activities.listByUnitPublic,
    open && rawLockedUnitId && !rawLockedLessonId
      ? { unitId: rawLockedUnitId as Id<"units"> }
      : "skip",
  );
  const lockedUnitCompletions = useQuery(
    api.activityCompletions.listForScholarInUnit,
    open && rawLockedUnitId && !rawLockedLessonId
      ? { unitId: rawLockedUnitId as Id<"units"> }
      : "skip",
  );

  // Focus is "effectively complete" for this scholar when every
  // online activity in the locked unit has a completion row. When
  // that's true, drop the lock for navigation purposes — the
  // scholar should be able to pick a different unit. The focus
  // banner still shows (informationally) so they know which focus
  // they already wrapped.
  const focusEffectivelyComplete = (() => {
    if (!rawLockedUnitId) return false;
    if (rawLockedLessonId) return false; // lesson-scoped: skip for now
    if (!lockedUnitActivities || !lockedUnitCompletions) return false;
    const onlineOnly = lockedUnitActivities.filter(
      (a) => a.kind === "online",
    );
    if (onlineOnly.length === 0) return false;
    const doneIds = new Set(
      lockedUnitCompletions.map((c) => String(c.activityId)),
    );
    return onlineOnly.every((a) => doneIds.has(String(a._id)));
  })();

  // Effective lock: null when the focus is already complete for
  // this scholar.
  const lockedUnitId = focusEffectivelyComplete ? null : rawLockedUnitId;
  const lockedLessonId = focusEffectivelyComplete ? null : rawLockedLessonId;

  // The unit currently being explored (column 2). Defaults to the
  // locked unit when present.
  const [exploringUnitId, setExploringUnitId] = useState<string | null>(
    lockedUnitId ?? initialUnitId,
  );
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  const [picksIndependent, setPicksIndependent] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);

  // Subject filter — derived from the units this picker was handed, so
  // it only offers subjects the scholar can actually see. When a focus
  // lock is in play the list is already pinned to one unit, so the
  // chips would be noise — hide them in that case.
  const subjects = useMemo(
    () => (rawLockedUnitId ? [] : uniqueSubjects(units)),
    [units, rawLockedUnitId],
  );
  const filteredUnits = useMemo(
    () =>
      selectedSubject
        ? units.filter((u) => subjectMatches(u.subject, selectedSubject))
        : units,
    [units, selectedSubject],
  );

  // Reset state when dialog opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset of dialog selection state when opened
    setSelectedSubject(null);
    setExploringUnitId(lockedUnitId ?? initialUnitId);
    setSelection(
      lockedUnitId && lockedLessonId
        ? {
            type: "lesson",
            unitId: lockedUnitId as Id<"units">,
            lessonId: lockedLessonId as Id<"lessons">,
          }
        : lockedUnitId
        ? { type: "unit", unitId: lockedUnitId as Id<"units"> }
        : null,
    );
    setPicksIndependent(false);
  }, [open, lockedUnitId, lockedLessonId, initialUnitId]);

  // ── Auto-skip when only one activity exists in the locked unit ─────
  // When the dialog opens scoped to a unit that contains exactly one
  // online activity, there's nothing to pick — just start it.
  //
  // Auto-skip never fires when the focus is effectively complete (the
  // lock has been dropped to null above), so the scholar isn't
  // dragged back into a finished session.
  const autoStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      autoStartedRef.current = null;
      return;
    }
    if (!lockedUnitId) return;
    if (lockedUnitActivities === undefined) return;
    if (lockedUnitCompletions === undefined) return;
    if (autoStartedRef.current === lockedUnitId) return;

    const onlineOnly = lockedUnitActivities.filter(
      (a) => a.kind === "online",
    );
    if (onlineOnly.length !== 1) return;
    const only = onlineOnly[0];
    autoStartedRef.current = lockedUnitId;
    onSelect({
      unitId: lockedUnitId,
      lessonId: String(only.lessonId),
      activityId: String(only._id),
    });
  }, [open, lockedUnitId, lockedUnitActivities, lockedUnitCompletions, onSelect]);

  const exploringUnit = useMemo(
    () => units.find((u) => u.id === exploringUnitId) ?? null,
    [units, exploringUnitId],
  );

  const focusBannerText = (() => {
    if (!rawLockedUnitId) return null;
    const unit = units.find((u) => u.id === rawLockedUnitId);
    const lessonName = focusLock?.lessonTitle;
    const target = lessonName ?? unit?.title ?? null;
    if (focusEffectivelyComplete) {
      return target
        ? `You've finished the class focus (${target}). Pick anything else to work on.`
        : "You've finished the class focus. Pick anything else to work on.";
    }
    if (target) return `Your teacher has set a focus: ${target}`;
    return "Your teacher has set a focus";
  })();

  // Only activities and Independent Study can start a project. Units and
  // lessons are navigational — selecting one drills in / expands; the
  // scholar must reach an activity (or pick Independent Study) to start.
  const handleConfirm = () => {
    if (picksIndependent) {
      onSelect({ unitId: null, lessonId: null, activityId: null });
      return;
    }
    if (selection?.type !== "activity") return;
    onSelect({
      unitId: String(selection.unitId),
      lessonId: String(selection.lessonId),
      activityId: String(selection.activityId),
    });
  };

  const canConfirm = picksIndependent || selection?.type === "activity";

  const confirmLabel = (() => {
    if (picksIndependent) return "Start Independent Study";
    if (selection?.type === "activity")
      return confirmLabelOverride ?? "Start this activity";
    return "Pick an activity";
  })();

  // Dialog title — single text now that there's no step-1 / step-2.
  const dialogTitle =
    title?.step1 ?? "What would you like to work on?";

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
          <StyledDialogContent maxW="900px" w="95vw">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Flex align="center" gap={2} flex={1}>
                <Dialog.Title
                  fontFamily="heading"
                  fontWeight="700"
                  color="navy.500"
                  fontSize="lg"
                  flex={1}
                >
                  {dialogTitle}
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

            <Dialog.Body px={0} py={0}>
              {focusBannerText && (
                <HStack
                  gap={2}
                  bg="orange.50"
                  borderTop="1px solid"
                  borderBottom="1px solid"
                  borderColor="orange.200"
                  px={6}
                  py={2}
                >
                  <Lock size={14} color="var(--chakra-colors-orange-500)" />
                  <Text
                    fontSize="xs"
                    fontFamily="heading"
                    color="orange.700"
                    fontWeight="500"
                  >
                    {focusBannerText}
                  </Text>
                </HStack>
              )}

              {subjects.length >= 2 && (
                <Box
                  px={6}
                  py={2.5}
                  borderTop="1px solid"
                  borderColor="gray.200"
                  bg="white"
                >
                  <SubjectFilterChips
                    subjects={subjects}
                    selected={selectedSubject}
                    onSelect={(s) => {
                      setSelectedSubject(s);
                      // Picking a subject the explored unit isn't in
                      // would leave column 2 showing a now-hidden unit;
                      // clear the exploration so it reads cleanly.
                      setExploringUnitId(null);
                      setSelection(null);
                      setPicksIndependent(false);
                    }}
                    size="sm"
                  />
                </Box>
              )}

              <Flex
                borderTop="1px solid"
                borderTopColor="gray.200"
                borderBottom="1px solid"
                borderBottomColor="gray.200"
                bg="gray.50"
                h="420px"
                overflowX="auto"
              >
                {/* Column 1 — Units (+ Independent Study) */}
                <HierarchyColumn
                  header="Unit"
                  width="280px"
                  testId="unit-picker-units-column"
                >
                  {showIndependentStudy && !selectedSubject && (
                    <HierarchyRow
                      leading="🚀"
                      label="Independent Study"
                      sublabel="Explore any topic"
                      selected={picksIndependent}
                      disabled={!!lockedUnitId}
                      onClick={() => {
                        if (lockedUnitId) return;
                        setPicksIndependent(true);
                        setExploringUnitId(null);
                        setSelection(null);
                      }}
                    />
                  )}
                  {filteredUnits.length === 0 && (
                    <HierarchyRow variant="empty" label="(no units in subject)" />
                  )}
                  {filteredUnits.map((u) => {
                    const isDisabled =
                      !!lockedUnitId && lockedUnitId !== u.id;
                    return (
                      <HierarchyRow
                        key={u.id}
                        leading={u.emoji ?? "📚"}
                        label={u.title}
                        sublabel={u.description ?? undefined}
                        selected={exploringUnitId === u.id}
                        disabled={isDisabled}
                        onClick={() => {
                          if (isDisabled) return;
                          setExploringUnitId(u.id);
                          setSelection({
                            type: "unit",
                            unitId: u.id as Id<"units">,
                          });
                          setPicksIndependent(false);
                        }}
                        trailing={{ kind: "chevron" }}
                      />
                    );
                  })}
                </HierarchyColumn>

                {/* Column 2 — Outline of the selected unit */}
                <Box
                  flex={1}
                  minW="320px"
                  bg="white"
                  overflowY="auto"
                  p={3}
                >
                  {exploringUnit ? (
                    <UnitOutlineTree
                      unitId={exploringUnit.id as Id<"units">}
                      mode="pick"
                      selected={selection}
                      onSelect={(s) => {
                        setSelection(s);
                        setPicksIndependent(false);
                      }}
                    />
                  ) : (
                    <Flex
                      align="center"
                      justify="center"
                      h="full"
                      color="charcoal.300"
                      fontFamily="body"
                      fontSize="sm"
                    >
                      Pick a unit on the left to see its lessons.
                    </Flex>
                  )}
                </Box>
              </Flex>
            </Dialog.Body>

            <Dialog.Footer px={6} pb={5} pt={4}>
              <Button
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.700" }}
                fontFamily="heading"
                size="sm"
                onClick={handleConfirm}
                disabled={!canConfirm || isCreating}
                loading={isCreating}
                loadingText="Creating..."
                w="full"
              >
                {confirmLabel}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
