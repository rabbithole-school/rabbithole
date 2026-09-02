"use client";

// The teacher's per-scholar quest management list — THE one place a quest is
// listed as a managed object on the scholar-detail page. Reads the ONE
// canonical per-scholar derivation (api.quests.listForScholar → questsForScholar)
// so its rows can't drift from the institution-wide board (components/QuestsTab)
// or the scholar's plate.
//
// This surface is management-only: it exposes the Phase 4 teacher verbs that
// take a quest OFF a scholar's map — Retract (cascades unit + seeds + sessions,
// confirm-gated) and, under a quiet "Show retracted" toggle, Reopen (its
// inverse). Offering / starting / finishing deliberately live elsewhere:
// offering happens on the board / suggest flow, and finishing is EARNED (a
// completion badge or all activities complete), never stamped here.

import { useState } from "react";
import NextLink from "next/link";
import { useQuery, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import {
  Box,
  Flex,
  HStack,
  VStack,
  Text,
  Badge,
  Spinner,
  Switch,
  Menu,
  Portal,
  IconButton,
  Dialog,
  Button,
  Link as ChakraLink,
} from "@chakra-ui/react";
import { DotsThreeVertical } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Surface } from "@/components/ui/Surface";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { QUEST_LIFECYCLE_LABELS } from "@/components/questLifecycleLabels";

type QuestRow = FunctionReturnType<typeof api.quests.listForScholar>[number];
type QuestState = QuestRow["state"];

// The canonical state → a quiet status chip. Not a control (fine print), so a
// subtle per-state palette is fine; the teacher-UI "no tiny control text" rule
// governs the header controls below, not a status tag.
const STATE_CHIP_PALETTE: Record<QuestState, string> = {
  offered: "yellow",
  active: "blue",
  finished: "green",
  dormant: "gray",
  retracted: "gray",
};

function StateChip({ state }: { state: QuestState }) {
  return (
    <Badge
      colorPalette={STATE_CHIP_PALETTE[state]}
      variant="subtle"
      fontSize="2xs"
      fontFamily="heading"
      textTransform="none"
      flexShrink={0}
    >
      {QUEST_LIFECYCLE_LABELS[state]}
    </Badge>
  );
}

function DraftChip() {
  return (
    <Badge
      colorPalette="gray"
      variant="outline"
      fontSize="2xs"
      fontFamily="heading"
      textTransform="none"
      flexShrink={0}
    >
      Draft
    </Badge>
  );
}

function QuestRowView({
  quest,
  onRetract,
  onReopen,
  busy,
}: {
  quest: QuestRow;
  onRetract: (q: QuestRow) => void;
  onReopen: (q: QuestRow) => void;
  busy: boolean;
}) {
  // Progress only reads once a quest is under way; the counts come straight
  // from the canonical online-activity projection (same source as the plate).
  const showProgress =
    (quest.state === "active" || quest.state === "finished") &&
    quest.onlineActivityCount > 0;

  return (
    <Flex
      p={3}
      bg="white"
      borderRadius="md"
      borderWidth="1px"
      borderColor="gray.200"
      align="center"
      gap={3}
    >
      <Box fontSize="lg" lineHeight="1" flexShrink={0}>
        {quest.emoji ?? "📘"}
      </Box>
      <VStack gap={0.5} flex={1} minW={0} align="stretch">
        <HStack gap={2} minW={0} flexWrap="wrap">
          <ChakraLink
            asChild
            fontFamily="heading"
            fontWeight="600"
            color="navy.500"
            fontSize="sm"
            lineClamp={1}
            minW={0}
            _hover={{ color: "violet.600", textDecoration: "underline" }}
          >
            <NextLink href={curriculumUnitHref(quest.unitId)}>
              {quest.title}
            </NextLink>
          </ChakraLink>
          <StateChip state={quest.state} />
          {quest.unitIsDraft && <DraftChip />}
        </HStack>
        {showProgress && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
            {quest.completedCount}/{quest.onlineActivityCount} activities
          </Text>
        )}
      </VStack>

      <Box flexShrink={0}>
        <Menu.Root>
          <Menu.Trigger asChild>
            <IconButton
              aria-label={`Quest actions for ${quest.title}`}
              variant="ghost"
              size="sm"
              color="charcoal.400"
              disabled={busy}
            >
              <DotsThreeVertical />
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content>
                {quest.state === "retracted" ? (
                  <Menu.Item
                    value="reopen"
                    fontFamily="heading"
                    fontSize="sm"
                    onSelect={() => onReopen(quest)}
                  >
                    Reopen
                  </Menu.Item>
                ) : (
                  <Menu.Item
                    value="retract"
                    fontFamily="heading"
                    fontSize="sm"
                    color="red.600"
                    onSelect={() => onRetract(quest)}
                  >
                    Retract
                  </Menu.Item>
                )}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      </Box>
    </Flex>
  );
}

export function ScholarQuestsCard({ scholarId }: { scholarId: Id<"users"> }) {
  const quests = useQuery(api.quests.listForScholar, { scholarId });
  const retractQuest = useMutation(api.quests.retract);
  const reopenQuest = useMutation(api.quests.reopen);

  const [showRetracted, setShowRetracted] = useState(false);
  // Retract is destructive (archives sessions + dismisses offers), so it routes
  // through one shared confirm dialog — never remounted while open. Reopen is
  // restorative, so it fires directly from the menu.
  const [pendingRetract, setPendingRetract] = useState<QuestRow | null>(null);
  const [busy, setBusy] = useState(false);

  const heading = (
    <Flex justify="space-between" align="center" gap={3} mb={3} wrap="wrap">
      <SectionEyebrow>Quests</SectionEyebrow>
      <ChakraLink
        asChild
        fontFamily="heading"
        fontWeight="600"
        fontSize="sm"
        color="charcoal.500"
        _hover={{ color: "violet.600" }}
      >
        <NextLink href="/teacher/quests">Open the quest board</NextLink>
      </ChakraLink>
    </Flex>
  );

  if (quests === undefined) {
    return (
      <Surface p={4}>
        {heading}
        <Flex justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      </Surface>
    );
  }

  const retracted = quests.filter((q) => q.state === "retracted");
  const active = quests.filter((q) => q.state !== "retracted");

  const runRetract = async () => {
    if (!pendingRetract) return;
    setBusy(true);
    try {
      const res = await retractQuest({ unitId: pendingRetract.unitId });
      toaster.success({
        title: "Quest retracted",
        description: `${res.seedsDismissed} offer${res.seedsDismissed === 1 ? "" : "s"} dismissed · ${res.sessionsArchived} session${res.sessionsArchived === 1 ? "" : "s"} archived`,
      });
      setPendingRetract(null);
    } catch (e) {
      toaster.error({
        title: "Couldn't retract that quest",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleReopen = async (quest: QuestRow) => {
    setBusy(true);
    try {
      await reopenQuest({ unitId: quest.unitId });
      toaster.success({ title: "Quest reopened" });
    } catch (e) {
      toaster.error({
        title: "Couldn't reopen that quest",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface p={4}>
      {heading}

      {quests.length === 0 ? (
        <EmptyState
          title="No quests yet"
          hint="Suggest one from the quest board."
        />
      ) : (
        <VStack gap={2} align="stretch">
          {active.length === 0 ? (
            <EmptyState title="No active quests" />
          ) : (
            active.map((q) => (
              <QuestRowView
                key={String(q.unitId)}
                quest={q}
                onRetract={setPendingRetract}
                onReopen={handleReopen}
                busy={busy}
              />
            ))
          )}

          {retracted.length > 0 && (
            <>
              {/* Show-retracted mirrors the board's Show-inactive toggle: the
                  quiet, opt-in group of closed quests. */}
              <Flex justify="flex-end" pt={1}>
                <Switch.Root
                  checked={showRetracted}
                  onCheckedChange={(d) => setShowRetracted(!!d.checked)}
                  colorPalette="violet"
                  size="sm"
                >
                  <Switch.HiddenInput />
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Switch.Label
                    fontFamily="heading"
                    fontSize="sm"
                    color="charcoal.500"
                    whiteSpace="nowrap"
                  >
                    Show retracted ({retracted.length})
                  </Switch.Label>
                </Switch.Root>
              </Flex>
              {showRetracted &&
                retracted.map((q) => (
                  <QuestRowView
                    key={String(q.unitId)}
                    quest={q}
                    onRetract={setPendingRetract}
                    onReopen={handleReopen}
                    busy={busy}
                  />
                ))}
            </>
          )}
        </VStack>
      )}

      {/* ONE shared retract-confirm dialog — `open` driven purely by pending. */}
      <Dialog.Root
        open={pendingRetract !== null}
        onOpenChange={(e) => {
          if (!e.open && !busy) setPendingRetract(null);
        }}
        placement="center"
        role="alertdialog"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title
                  fontFamily="heading"
                  fontSize="lg"
                  color="navy.500"
                >
                  Retract this quest?
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  “{pendingRetract?.title}” will be taken off the scholar&apos;s
                  map: its open offers are dismissed and its sessions archived.
                  Nothing is deleted — you can reopen it later.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  disabled={busy}
                  onClick={() => setPendingRetract(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  colorPalette="red"
                  fontFamily="heading"
                  loading={busy}
                  onClick={runRetract}
                >
                  Retract
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Surface>
  );
}
