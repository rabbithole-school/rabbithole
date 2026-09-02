"use client";

/**
 * The cyan strip that sits above a manual-rehearsal session. Owns the
 * "Rehearse manually" label, a "View as" picker (lets the teacher render the
 * tutor as themselves, a real scholar, or a synthetic profile), a
 * "Reset" button (archives the current rehearsal and starts a fresh one
 * against the same activity, preserving View as), and an optional Curriculum
 * Bot trigger for chat rehearsals.
 *
 * Synthetic profiles live only on rehearsal session records. Reset copies them
 * to the new rehearsal, and archiving retains them with the old rehearsal
 * history. They never become scholar dossier, mastery, or signal records.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Input,
  Popover,
  Portal,
  Text,
  Textarea,
  Tooltip,
  VStack,
} from "@chakra-ui/react";
import { Check, CaretDown, ArrowClockwise, Play, Repeat, Stop, User, SteeringWheel, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { BotIconButton } from "./BotIconButton";
import { ScholarPicker } from "@/components/ScholarPicker";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import type { ManualRehearsalReplay } from "@/hooks/useManualRehearsalReplay";

type Session = Doc<"sessions">;

interface ManualRehearsalBannerProps {
  session: Session;
  /** Scholar turns in the current rehearsal — gates the "Reset & replay" CTA. */
  scholarTurnCount?: number;
  /** Replay driver state for the staged-script strip. */
  replay?: ManualRehearsalReplay;
  /** Show the curriculum-bot trigger when there's an activity to discuss. */
  onOpenBot?: () => void;
}

export function ManualRehearsalBanner({
  session,
  scholarTurnCount = 0,
  replay,
  onOpenBot,
}: ManualRehearsalBannerProps) {
  const router = useRouter();
  const scholars = useQuery(api.users.listScholars, {});
  const setViewAs = useMutation(api.sessions.setTestDriveViewAs);
  const resetRehearsal = useMutation(api.sessions.resetTestDrive);

  const [syntheticOpen, setSyntheticOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Resolve the current view-as label from the session itself.
  const currentScholarId = session.testDriveAsScholarId;
  const currentSyntheticName = session.testDriveSyntheticName;
  const currentSyntheticReadingLevel = session.testDriveSyntheticReadingLevel;
  const currentSyntheticDossier = session.testDriveSyntheticDossier;
  const isSynthetic =
    !currentScholarId &&
    (currentSyntheticName !== undefined ||
      currentSyntheticReadingLevel !== undefined ||
      currentSyntheticDossier !== undefined);

  let viewAsLabel = "Yourself";
  if (currentScholarId) {
    const found = scholars?.find((s) => s._id === currentScholarId);
    viewAsLabel = found?.name || found?.username || "Scholar";
  } else if (isSynthetic) {
    viewAsLabel = currentSyntheticName?.trim() || "Synthetic scholar";
  }

  const handlePickSelf = async () => {
    try {
      await setViewAs({ sessionId: session._id, mode: "self" });
    } catch (err) {
      console.error(err);
      toaster.error({ title: "Couldn't change View as" });
    }
  };

  const handlePickRealScholar = async (scholarId: Id<"users">) => {
    try {
      await setViewAs({
        sessionId: session._id,
        mode: "real",
        realScholarId: scholarId,
      });
    } catch (err) {
      console.error(err);
      toaster.error({ title: "Couldn't change View as" });
    }
  };

  const handleReset = async (withReplay = false) => {
    if (resetting) return;
    setResetting(true);
    try {
      const { id } = await resetRehearsal({ sessionId: session._id, withReplay });
      router.push(`/scholar/${id}`);
    } catch (err) {
      console.error(err);
      toaster.error({ title: "Couldn't reset rehearsal" });
      setResetting(false);
    }
  };

  return (
    <>
      <Flex
        px={4}
        py={1.5}
        bg="cyan.50"
        borderBottom="1px solid"
        borderColor="cyan.200"
        align="center"
        gap={2}
      >
        <SteeringWheel
          size={18}
          weight="duotone"
          color="var(--chakra-colors-cyan-600)"
          style={{ flexShrink: 0 }}
        />
        <Text fontSize="sm" fontFamily="heading" color="cyan.700" fontWeight="600">
          Rehearse manually
        </Text>
        <Text fontSize="sm" fontFamily="heading" color="cyan.700" flex={1}>
          — nothing here is being saved to a scholar.
        </Text>

        {/* View as picker */}
        <Popover.Root
          open={viewAsOpen}
          onOpenChange={(d) => setViewAsOpen(d.open)}
          positioning={{ placement: "bottom-end" }}
        >
          <Popover.Trigger asChild>
            <Button
              size="xs"
              variant="ghost"
              color="cyan.700"
              _hover={{ bg: "white" }}
              aria-label="Change View as"
            >
              <HStack gap={1.5}>
                <User size={12} />
                <Text fontFamily="heading" fontSize="xs" fontWeight="600">
                  View as: {viewAsLabel}
                </Text>
                <CaretDown size={12} />
              </HStack>
            </Button>
          </Popover.Trigger>
          <Portal>
            <Popover.Positioner>
              <Popover.Content w="300px" shadow="lg" borderRadius="lg">
                <Popover.Body p={3}>
                  <VStack gap={2} align="stretch">
                    {/* Yourself */}
                    <ViewAsOption
                      label="Yourself (no dossier)"
                      icon={<User size={12} />}
                      active={!currentScholarId && !isSynthetic}
                      onClick={() => {
                        setViewAsOpen(false);
                        void handlePickSelf();
                      }}
                    />

                    {/* Real scholars — shared picker (search, groups,
                        my-scholars-first). No affinity hearts here. */}
                    <Box borderTopWidth="1px" borderColor="gray.100" pt={2}>
                      <Text
                        px={1}
                        mb={1}
                        fontSize="2xs"
                        fontFamily="heading"
                        color="charcoal.400"
                        textTransform="uppercase"
                        letterSpacing="0.05em"
                      >
                        Real scholars
                      </Text>
                      <ScholarPicker
                        mode="single"
                        selected={currentScholarId ?? null}
                        onChange={(id) => {
                          if (!id) return;
                          setViewAsOpen(false);
                          void handlePickRealScholar(id as Id<"users">);
                        }}
                        showAffinityToggle={false}
                        autoFocusSearch
                        maxH="220px"
                        emptyHint="No scholars yet"
                      />
                    </Box>

                    {/* Synthetic */}
                    <Box borderTopWidth="1px" borderColor="gray.100" pt={2}>
                      <ViewAsOption
                        label={isSynthetic ? "Edit sim…" : "New sim…"}
                        active={isSynthetic}
                        onClick={() => {
                          setViewAsOpen(false);
                          setSyntheticOpen(true);
                        }}
                      />
                    </Box>
                  </VStack>
                </Popover.Body>
              </Popover.Content>
            </Popover.Positioner>
          </Portal>
        </Popover.Root>

        {/* Reset & replay — fresh rehearsal that auto-re-sends the scholar
            turns from this rehearsal against the (edited) prompt. Only shown
            once there's a conversation worth replaying. */}
        {scholarTurnCount > 0 && (
          <Tooltip.Root openDelay={300} closeDelay={0}>
            <Tooltip.Trigger asChild>
              <Button
                size="xs"
                variant="ghost"
                color="cyan.700"
                _hover={{ bg: "white" }}
                onClick={() => handleReset(true)}
                loading={resetting}
                aria-label="Reset and replay this rehearsal"
              >
                <HStack gap={1.5}>
                  <Repeat size={12} />
                  <Text fontFamily="heading" fontSize="xs" fontWeight="600">
                    Reset &amp; replay
                  </Text>
                </HStack>
              </Button>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content>
                  Start fresh, then re-run your scholar turns against the
                  current prompt — no re-typing
                </Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        )}

        {/* Reset button */}
        <Tooltip.Root openDelay={300} closeDelay={0}>
          <Tooltip.Trigger asChild>
            <IconButton
              aria-label="Reset rehearsal"
              size="xs"
              variant="ghost"
              color="cyan.700"
              _hover={{ bg: "white" }}
              onClick={() => handleReset(false)}
              loading={resetting}
            >
              <ArrowClockwise />
            </IconButton>
          </Tooltip.Trigger>
          <Portal>
            <Tooltip.Positioner>
              <Tooltip.Content>
                Reset — start a fresh rehearsal of this activity (keeps View as)
              </Tooltip.Content>
            </Tooltip.Positioner>
          </Portal>
        </Tooltip.Root>

        {session.unitId && onOpenBot && (
          <BotIconButton
            onClick={onOpenBot}
            tooltipText="Ask Curriculum Bot about this activity"
            hoverBg="white"
          />
        )}
      </Flex>

      {replay && <ReplayStrip replay={replay} />}

      <SyntheticScholarDialog
        open={syntheticOpen}
        onClose={() => setSyntheticOpen(false)}
        sessionId={session._id}
        initialName={currentSyntheticName ?? ""}
        initialReadingLevel={currentSyntheticReadingLevel ?? ""}
        initialDossier={currentSyntheticDossier ?? ""}
      />
    </>
  );
}

/**
 * The replay strip — a second, slightly deeper cyan bar that appears under
 * the banner on a fresh rehearsal carrying a staged scholar script. Offers a
 * one-click replay (to the flagged turn, or the whole run), shows progress
 * while running, and a Continue/Done pause state. The conversation itself
 * is the feedback, so the strip hides once a full replay completes
 * (status "done" / "none").
 */
function ReplayStrip({ replay }: { replay: ManualRehearsalReplay }) {
  const {
    status,
    total,
    sentCount,
    runTarget,
    hasFlagBoundary,
    stopAfter,
    start,
    continueToEnd,
    stop,
    dismiss,
  } = replay;

  if (status === "none" || status === "done" || total === 0) return null;

  return (
    <Flex
      px={4}
      py={1.5}
      bg="cyan.100"
      borderBottom="1px solid"
      borderColor="cyan.200"
      align="center"
      gap={2}
    >
      {status === "offered" && (
        <>
          <Text fontSize="xs" fontFamily="heading" color="cyan.800" flex={1}>
            {hasFlagBoundary
              ? `Replay your ${total} scholar turn${total === 1 ? "" : "s"} against this prompt — pausing at the flagged turn (${stopAfter}).`
              : `Replay your ${total} scholar turn${total === 1 ? "" : "s"} against this prompt.`}
          </Text>
          <Button
            size="xs"
            bg="cyan.500"
            color="white"
            _hover={{ bg: "cyan.600" }}
            onClick={start}
          >
            <HStack gap={1.5}>
              <Play size={12} weight="fill" />
              <Text fontFamily="heading" fontSize="xs" fontWeight="600">
                {hasFlagBoundary ? "Replay to flag" : "Replay"}
              </Text>
            </HStack>
          </Button>
          {hasFlagBoundary && (
            <Button
              size="xs"
              variant="ghost"
              color="cyan.800"
              _hover={{ bg: "cyan.200" }}
              onClick={continueToEnd}
            >
              <Text fontFamily="heading" fontSize="xs" fontWeight="600">
                Replay all
              </Text>
            </Button>
          )}
          <ReplayDismiss onClick={dismiss} />
        </>
      )}

      {status === "running" && (
        <>
          <Text fontSize="xs" fontFamily="heading" color="cyan.800" flex={1}>
            Replaying… {sentCount}/{runTarget}
          </Text>
          <Button
            size="xs"
            variant="ghost"
            color="cyan.800"
            _hover={{ bg: "cyan.200" }}
            onClick={stop}
          >
            <HStack gap={1.5}>
              <Stop size={12} weight="fill" />
              <Text fontFamily="heading" fontSize="xs" fontWeight="600">
                Stop
              </Text>
            </HStack>
          </Button>
        </>
      )}

      {status === "paused" && (
        <>
          <Text fontSize="xs" fontFamily="heading" color="cyan.800" flex={1}>
            Paused at {sentCount}/{total}. Type to take over, or continue.
          </Text>
          {sentCount < total && (
            <Button
              size="xs"
              bg="cyan.500"
              color="white"
              _hover={{ bg: "cyan.600" }}
              onClick={continueToEnd}
            >
              <HStack gap={1.5}>
                <Play size={12} weight="fill" />
                <Text fontFamily="heading" fontSize="xs" fontWeight="600">
                  Continue ({total - sentCount} more)
                </Text>
              </HStack>
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            color="cyan.800"
            _hover={{ bg: "cyan.200" }}
            onClick={dismiss}
          >
            <Text fontFamily="heading" fontSize="xs" fontWeight="600">
              Done
            </Text>
          </Button>
        </>
      )}
    </Flex>
  );
}

function ReplayDismiss({ onClick }: { onClick: () => void }) {
  return (
    <IconButton
      aria-label="Dismiss replay"
      size="xs"
      variant="ghost"
      color="cyan.700"
      _hover={{ bg: "cyan.200" }}
      onClick={onClick}
    >
      <X size={12} />
    </IconButton>
  );
}

function SyntheticScholarDialog({
  open,
  onClose,
  sessionId,
  initialName,
  initialReadingLevel,
  initialDossier,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  initialName: string;
  initialReadingLevel: string;
  initialDossier: string;
}) {
  const setViewAs = useMutation(api.sessions.setTestDriveViewAs);
  const [name, setName] = useState(initialName);
  const [readingLevel, setReadingLevel] = useState(initialReadingLevel);
  const [dossier, setDossier] = useState(initialDossier);
  const [saving, setSaving] = useState(false);

  // Reset local form when the dialog opens with new initial values (e.g.,
  // teacher previously saved a synthetic, closed, reopened to edit).
  useResetOnOpen(open, () => {
    setName(initialName);
    setReadingLevel(initialReadingLevel);
    setDossier(initialDossier);
  });

  const canSave =
    name.trim().length > 0 ||
    readingLevel.trim().length > 0 ||
    dossier.trim().length > 0;

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await setViewAs({
        sessionId,
        mode: "synthetic",
        syntheticName: name.trim() || undefined,
        syntheticReadingLevel: readingLevel.trim() || undefined,
        syntheticDossier: dossier.trim() || undefined,
      });
      onClose();
    } catch (err) {
      console.error(err);
      toaster.error({ title: "Couldn't save sim" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={({ open: o }) => {
        if (!o) onClose();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={6} pb={0}>
              <Dialog.Title asChild>
                <Text
                  as="h2"
                  fontFamily="heading"
                  fontSize="lg"
                  fontWeight="700"
                  color="navy.500"
                >
                  Sim
                </Text>
              </Dialog.Title>
              <Text mt={1} fontSize="xs" color="charcoal.400">
                Stress-test the activity against a kid type. Nothing here is
                saved beyond this rehearsal.
              </Text>
            </Dialog.Header>

            <Dialog.Body px={6} py={5}>
              <VStack align="stretch" gap={4}>
                <Box>
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.500" mb={1}>
                    Name (optional)
                  </Text>
                  <Input
                    size="sm"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Maile (early reader)"
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.500" mb={1}>
                    Reading level (optional)
                  </Text>
                  <Input
                    size="sm"
                    value={readingLevel}
                    onChange={(e) => setReadingLevel(e.target.value)}
                    placeholder='e.g. "1st grade", "early elementary", "8.2"'
                  />
                  <Text fontSize="2xs" color="charcoal.400" mt={1}>
                    Free-form. Same field as a real scholar&apos;s reading level.
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.500" mb={1}>
                    Dossier persona (optional)
                  </Text>
                  <Textarea
                    size="sm"
                    rows={6}
                    value={dossier}
                    onChange={(e) => setDossier(e.target.value)}
                    placeholder={
                      "Strong reader, math-curious. Loves sharks. Resists writing tasks. Asks lots of follow-up questions."
                    }
                  />
                </Box>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer px={6} py={4} borderTop="1px solid" borderColor="gray.100">
              <HStack justify="flex-end" gap={2} w="full">
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="cyan.500"
                  color="white"
                  _hover={{ bg: "cyan.600" }}
                  onClick={handleSave}
                  loading={saving}
                  disabled={!canSave}
                >
                  Save
                </Button>
              </HStack>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Tiny effect helper: runs `fn` whenever `open` flips from false to true.
 * Pulled into a hook so the consumer doesn't need its own `useEffect` and
 * to keep the eslint-disable for the set-state-in-effect pattern in one
 * place. Same shape as the other reset-on-prop hooks in the codebase.
 */
function useResetOnOpen(open: boolean, fn: () => void) {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      fn();
    }
    wasOpen.current = open;
    // fn is intentionally untracked — callers re-create it per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/**
 * A non-scholar option row inside the View-as popover (Yourself /
 * Synthetic). The real-scholar rows are rendered by <ScholarPicker />;
 * these two bookend it with the same look.
 */
function ViewAsOption({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Flex
      as="button"
      w="full"
      align="center"
      gap={2}
      px={2}
      py={1.5}
      borderRadius="md"
      cursor="pointer"
      textAlign="left"
      bg={active ? "cyan.50" : "transparent"}
      _hover={{ bg: active ? "cyan.50" : "gray.50" }}
      onClick={onClick}
    >
      {icon}
      <Text fontFamily="heading" fontSize="sm" color="navy.500" flex={1}>
        {label}
      </Text>
      {active && <Check size={13} color="var(--chakra-colors-cyan-600)" />}
    </Flex>
  );
}
