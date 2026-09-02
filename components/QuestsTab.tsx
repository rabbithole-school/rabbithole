"use client";

/**
 * Teacher-facing Quests tab.
 *
 * One row per scholar. Each row lists that scholar's Quests
 * (units.authorScholarId = scholar). "New Quest" creates a new
 * scholar-owned Unit with one seeded lesson + kickoff activity.
 * Clicking a Quest opens the full Unit Designer at
 * /teacher/curriculum/<id> — same editing surface as any other unit.
 *
 * Previously this tab maintained its own one-off task model
 * (activities.scholarId) with bespoke dialogs. That was unified into
 * scholar-authored units so there's a single concept everywhere. See
 * review/homework-on-assignment.md for the migration.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import NextLink from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Heading,
  Input,
  Popover,
  Portal,
  Spinner,
  Stack,
  Switch,
  Text,
} from "@chakra-ui/react";
import {
  ArrowsOut,
  CaretDown,
  Check,
  MagnifyingGlass,
  ShootingStar,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScholarPicker } from "@/components/ScholarPicker";
import {
  DEFAULT_SCHOLAR_PARTICIPATION,
  type ScholarParticipationSelection,
} from "@/components/ScholarParticipationFilter";
import { noScholarMatchCopy } from "@/shared/scholarSearchCopy";
import { scholarMatchesParticipation } from "@/shared/scholarParticipation";
import { QuestsTabSkeleton } from "@/components/skeletons/PanelSkeletons";
import { Avatar } from "@/components/Avatar";
import { BadgeArt } from "@/components/BadgeArt";
import {
  ActivityCard,
  ActivityCardMeta,
  ActivityCardTitle,
} from "@/components/ui/ActivityCard";
import { toaster } from "@/lib/toaster";
import { formatRelative } from "@/lib/relativeTime";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { QUEST_LIFECYCLE_LABELS } from "@/components/questLifecycleLabels";

type QuestUnitRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.units.listScholarAuthored>>
>[number];

// The board's three mission-control lanes are keyed off the CANONICAL quest
// state (units.listScholarAuthored → questLifecycle). `offered` + `dormant`
// share the "Suggested" lane; `active` = In progress; `finished` = Finished.
// `retracted` rows render in a separate quiet group under "Show inactive".
type LaneKey = "offered" | "active" | "finished";

const LANES: Array<{
  key: LaneKey;
  marker: "destination" | "rocket" | "trophy";
  label: string;
  fg: string;
  hint: string;
}> = [
  { key: "offered", marker: "destination", label: QUEST_LIFECYCLE_LABELS.offered, fg: "yellow.700", hint: "waiting to launch" },
  { key: "active", marker: "rocket", label: QUEST_LIFECYCLE_LABELS.active, fg: "blue.600", hint: "flying there" },
  { key: "finished", marker: "trophy", label: QUEST_LIFECYCLE_LABELS.finished, fg: "green.600", hint: "completed" },
];

function LaneMarker({ marker }: { marker: (typeof LANES)[number]["marker"] }) {
  if (marker === "destination") {
    return <ShootingStar size={16} weight="fill" color="#caa23a" />;
  }
  return (
    <Text fontSize="sm" lineHeight="1">
      {marker === "rocket" ? "🚀" : "🏆"}
    </Text>
  );
}

// The card's one-line status, calibrated to its state. A stalled active quest
// (started, then left untouched) gets the "bounced off it" nudge.
function statusLine(u: QuestUnitRow): { text: string; tone: string } {
  const muted = "charcoal.400";
  switch (u.state) {
    // A bare dormant unit (no open offer, all chats archived) shares the
    // Suggested lane; it never goes stale (staleOffer requires state "offered").
    case "offered":
    case "dormant":
      return u.staleOffer
        ? {
            text: `waiting ${formatRelative(u.offeredAt ?? u.createdAt)} · nudge?`,
            tone: "orange.600",
          }
        : {
            text: `${u.source === "teacher" ? "suggested" : "drafted"} ${formatRelative(u.offeredAt ?? u.createdAt)}`,
            tone: muted,
          };
    case "active": {
      const when = formatRelative(u.lastTouched ?? u.createdAt);
      // Progress reads the canonical online-activity completion count
      // (completedCount) against the online-activity total (onlineActivityCount)
      // — the same source of truth as the scholar's plate + the daily recap, so
      // "N of M done" here matches what the scholar actually finished.
      const progress =
        u.completedCount > 0
          ? `${u.completedCount} of ${u.onlineActivityCount} done · `
          : "";
      return u.stalled
        ? { text: `${progress}stalled ${when} · nudge?`, tone: "orange.600" }
        : { text: `${progress}active ${when}`, tone: muted };
    }
    case "finished":
      // Reached only for a badge-less finish (all activities complete, no
      // configured badge) — a badged finish renders the real badge art instead.
      return { text: "all activities complete ✓", tone: "green.700" };
    case "retracted":
      return { text: "retracted", tone: muted };
  }
}

// A small, quiet status chip beside a Quest's scholar name. A chip next to the
// title (not an edge stripe) follows .claude/rules/visual-design.md.
function QuestChip({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "muted";
}) {
  return (
    <Box
      flexShrink={0}
      bg="gray.100"
      color={tone === "muted" ? "charcoal.400" : "charcoal.600"}
      fontSize="2xs"
      fontWeight="700"
      fontFamily="heading"
      px={1.5}
      py={0.5}
      borderRadius="full"
      lineHeight="1.4"
    >
      {label}
    </Box>
  );
}

function QuestCard({ u }: { u: QuestUnitRow }) {
  const s = statusLine(u);
  return (
    <ActivityCard
      density="compact"
      href={curriculumUnitHref(u._id)}
      ariaLabel={u.title}
    >
      <HStack gap={2} minW={0}>
        <Avatar
          size="2xs"
          name={u.scholarName}
          src={u.scholarImage ?? undefined}
          colorKey={String(u.scholarId)}
        />
        <Text
          fontSize="xs"
          fontWeight="600"
          color="charcoal.500"
          fontFamily="heading"
          lineClamp={1}
          minW={0}
          flex="1"
        >
          {u.scholarName}
        </Text>
        {u.isDraft && <QuestChip label="Draft" />}
        {u.state === "dormant" && (
          <QuestChip label={QUEST_LIFECYCLE_LABELS.dormant} tone="muted" />
        )}
        {u.state === "retracted" && (
          <QuestChip label={QUEST_LIFECYCLE_LABELS.retracted} tone="muted" />
        )}
      </HStack>
      <HStack gap={1.5} align="flex-start">
        <Text fontSize="sm" lineHeight="1.35" flexShrink={0}>
          {u.emoji ?? "📘"}
        </Text>
        <ActivityCardTitle density="compact" clamp>
          {u.title}
        </ActivityCardTitle>
      </HStack>
      {u.state === "finished" && u.badge ? (
        // The real earned badge — a small award chip, not the generic trophy.
        <HStack gap={2} align="center" mt={1.5} minW={0}>
          <BadgeArt
            imageUrl={u.badge.imageUrl}
            emoji={u.badge.emoji ?? "🏅"}
            status={u.badge.artStatus}
            size="34px"
            rounded="lg"
            alt={`${u.badge.title} badge`}
            showGeneratingOverlay={false}
          />
          <Stack gap={0} minW={0}>
            <Text
              fontSize="2xs"
              fontWeight="700"
              color="green.700"
              fontFamily="heading"
              lineClamp={1}
              minW={0}
            >
              {u.badge.title}
            </Text>
            <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
              earned the badge
            </Text>
          </Stack>
        </HStack>
      ) : (
        <ActivityCardMeta tone={s.tone} fontSize="2xs" mt={1.5}>
          {s.text}
        </ActivityCardMeta>
      )}
      <ActivityCardMeta fontSize="2xs" mt={0.5}>
        {u.lessonCount} lesson{u.lessonCount === 1 ? "" : "s"} ·{" "}
        {u.activityCount} activit{u.activityCount === 1 ? "y" : "ies"}
        {u.source === "teacher" ? " · 🌠 destination" : " · self-made"}
      </ActivityCardMeta>
    </ActivityCard>
  );
}

export function QuestsTab() {
  const router = useRouter();
  const { scopeParam } = useActiveInstitution();
  const scholars = useQuery(api.users.listScholars, {
    institutionScope: scopeParam,
    includeProgramGuests: true,
  });
  const [includeInactive, setIncludeInactive] = useState(false);
  const units = useQuery(api.units.listScholarAuthored, {
    scope: scopeParam,
    includeInactive,
  });

  const [addingFor, setAddingFor] = useState<{
    scholarId: Id<"users">;
    scholarName: string;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scholarFilterOpen, setScholarFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  // "" = all scholars. Otherwise a scholar id to narrow the board to one
  // scholar ("what Quests does Oliver have?").
  const [scholarFilter, setScholarFilter] = useState<string>("");
  const [participation, setParticipation] =
    useState<ScholarParticipationSelection>(DEFAULT_SCHOLAR_PARTICIPATION);

  if (scholars === undefined || units === undefined) {
    return <QuestsTabSkeleton />;
  }

  const selectedScholar = scholars.find(
    (scholar) => String(scholar.id) === scholarFilter,
  );
  const visibleScholarIds = new Set(
    scholars
      .filter((scholar) => scholarMatchesParticipation(scholar, participation))
      .map((scholar) => String(scholar.id)),
  );

  // Narrow by the chosen scholar, then by scholar name / quest title text,
  // then group by canonical state into mission-control lanes (offer → active →
  // finished), with retracted rows held aside for a quiet group below.
  const filteredUnits = units.filter((u) => {
    if (scholarFilter && String(u.scholarId) !== scholarFilter) return false;
    if (!scholarFilter && !visibleScholarIds.has(String(u.scholarId))) {
      return false;
    }
    const n = query.trim().toLowerCase();
    if (!n) return true;
    return (
      u.scholarName.toLowerCase().includes(n) ||
      u.title.toLowerCase().includes(n)
    );
  });

  const lanes: Record<LaneKey, QuestUnitRow[]> = {
    offered: [],
    active: [],
    finished: [],
  };
  // Retracted (inactive) quests — only present when "Show inactive" is on —
  // render as a separate quiet group below the lanes.
  const retracted: QuestUnitRow[] = [];
  for (const u of filteredUnits) {
    switch (u.state) {
      case "offered":
      case "dormant":
        lanes.offered.push(u);
        break;
      case "active":
        lanes.active.push(u);
        break;
      case "finished":
        lanes.finished.push(u);
        break;
      case "retracted":
        retracted.push(u);
        break;
    }
  }
  const recent = (u: QuestUnitRow) => u.lastTouched ?? u.createdAt;
  // Suggested: the ones most in need of a teacher (stale first, then oldest).
  lanes.offered.sort((a, b) => {
    if (a.staleOffer !== b.staleOffer) return a.staleOffer ? -1 : 1;
    return (a.offeredAt ?? a.createdAt) - (b.offeredAt ?? b.createdAt);
  });
  // In progress: stalled ones first (they need a nudge), then most recent.
  lanes.active.sort((a, b) => {
    if (a.stalled !== b.stalled) return a.stalled ? -1 : 1;
    return recent(b) - recent(a);
  });
  lanes.finished.sort((a, b) => recent(b) - recent(a));
  retracted.sort((a, b) => recent(b) - recent(a));

  return (
    <>
      <Stack gap={4}>
        <PageHeader title="Quests" />

        <Flex gap={2} align="center" wrap="wrap">
          <Box flex={1} minW="220px" position="relative">
            <Box
              position="absolute"
              left={3}
              top="50%"
              transform="translateY(-50%)"
              color="charcoal.300"
              pointerEvents="none"
            >
              <MagnifyingGlass size={14} />
            </Box>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search scholars or Quest titles"
              placeholder={
                units.length === 0
                  ? "No Quests yet — use 'Suggest a quest' to start one"
                  : "Search scholars or Quest titles…"
              }
              size="sm"
              pl={8}
              bg="white"
              borderColor="gray.200"
            />
          </Box>
          {/* The shared ScholarPicker owns roster search, group membership,
              and the enrolled-first participation filter. */}
          <Popover.Root
            open={scholarFilterOpen}
            onOpenChange={(details) => setScholarFilterOpen(details.open)}
            positioning={{ placement: "bottom-end" }}
          >
            <Popover.Trigger asChild>
              <Button
                size="sm"
                variant="outline"
                bg="white"
                borderColor="gray.200"
                minW="180px"
                maxW="240px"
                justifyContent="space-between"
                aria-label="Filter by scholar"
              >
                <Text lineClamp={1}>
                  {selectedScholar?.name ??
                    selectedScholar?.username ??
                    "All scholars"}
                </Text>
                <CaretDown size={14} />
              </Button>
            </Popover.Trigger>
            <Portal>
              <Popover.Positioner>
                <Popover.Content w="460px" maxW="calc(100vw - 32px)">
                  <Popover.Body p={4}>
                    <Stack gap={3}>
                      <Button
                        size="sm"
                        variant="ghost"
                        justifyContent="space-between"
                        onClick={() => {
                          setScholarFilter("");
                          setScholarFilterOpen(false);
                        }}
                      >
                        All scholars
                        {!scholarFilter && <Check size={14} />}
                      </Button>
                      <ScholarPicker
                        mode="single"
                        selected={scholarFilter || null}
                        participation={participation}
                        onParticipationChange={setParticipation}
                        showParticipationFilter
                        showEnrollmentStanding
                        showAffinityToggle={false}
                        autoFocusSearch
                        maxH="300px"
                        onChange={(scholarId) => {
                          setScholarFilter(scholarId ?? "");
                          if (scholarId) setScholarFilterOpen(false);
                        }}
                      />
                    </Stack>
                  </Popover.Body>
                </Popover.Content>
              </Popover.Positioner>
            </Portal>
          </Popover.Root>
          {/* Show inactive — off by default so the board matches the Work tab /
              scholar plate (both active-only). */}
          <Switch.Root
            checked={includeInactive}
            onCheckedChange={(d) => setIncludeInactive(!!d.checked)}
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
              Show inactive
            </Switch.Label>
          </Switch.Root>
          {/* Trophy Case — the kiosk/display surface the "Finished" lane below
              summarizes (all earned badges, incl. non-quest units). Its entry
              point lives here now that the Scholars-tab preview card was
              removed; opens in a new tab since it's a display surface. */}
          <Button
            asChild
            size="sm"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.500"
            _hover={{ bg: "gray.100" }}
          >
            <NextLink href="/teacher/trophy-case" target="_blank" rel="noopener">
              🏆 Trophy Case
            </NextLink>
          </Button>
          {/* Class Galaxy — the Interpretive lens showing where the class's
              curiosities converge. Its entry point moved here off the Scholars
              group page (redundant with the Math skills top-nav tab there); the
              Quests tab has no group context, so it links UNSCOPED and the
              galaxy falls back to the whole-class view. Opens in a new tab to
              MATCH Trophy Case — this companion ghost-button row behaves
              uniformly (peek at a display surface, keep your quest board). */}
          <Button
            asChild
            size="sm"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.500"
            _hover={{ bg: "gray.100" }}
          >
            <NextLink href="/teacher/galaxy?lens=galaxy" target="_blank" rel="noopener">
              🌌 Class Galaxy
            </NextLink>
          </Button>
          {/* The kiosk "Wall" cast — preserved from the old GalaxyEntry as a
              small subordinate affordance beside its parent lens (the big
              entryway display; new tab, like the other display surfaces). */}
          <Button
            asChild
            size="xs"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.400"
            _hover={{ bg: "gray.100" }}
          >
            <NextLink href="/teacher/galaxy-wall" target="_blank" rel="noopener">
              <ArrowsOut size={12} weight="bold" style={{ marginRight: 4 }} />
              Wall
            </NextLink>
          </Button>
          <Button
            size="sm"
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            fontWeight="600"
            onClick={() => setPickerOpen(true)}
          >
            <ShootingStar size={14} weight="fill" style={{ marginRight: 4 }} />
            Suggest a quest
          </Button>
        </Flex>

        {units.length === 0 ? (
          <EmptyState
            title="No Quests yet"
            hint="Use “Suggest a quest” to set the first destination."
          />
        ) : filteredUnits.length === 0 ? (
          <EmptyState title="No matches." />
        ) : (
          <>
            {/* Mission Control: a lane per quest state, answering "which offers
                landed, who just started, who's mid-flight, who finished?". */}
            <Flex gap={3} align="flex-start" overflowX="auto" pb={2}>
              {LANES.map((lane) => {
                const items = lanes[lane.key];
                return (
                  <Stack key={lane.key} gap={2} flex="1 1 0" minW="230px">
                    <HStack gap={2} px={1} align="baseline">
                      <LaneMarker marker={lane.marker} />
                      <Text
                        fontFamily="heading"
                        fontWeight="700"
                        color={lane.fg}
                        fontSize="sm"
                      >
                        {lane.label}
                      </Text>
                      <Box
                        bg="gray.100"
                        color="charcoal.500"
                        fontSize="2xs"
                        fontWeight="700"
                        fontFamily="heading"
                        px={1.5}
                        borderRadius="full"
                      >
                        {items.length}
                      </Box>
                    </HStack>
                    <Text
                      fontSize="2xs"
                      color="charcoal.300"
                      px={1}
                      mt={-1.5}
                      fontFamily="heading"
                    >
                      {lane.hint}
                    </Text>
                    <Stack gap={2}>
                      {items.length === 0 ? (
                        <EmptyState outline title="Nothing here yet" />
                      ) : (
                        items.map((u) => <QuestCard key={String(u._id)} u={u} />)
                      )}
                    </Stack>
                  </Stack>
                );
              })}
            </Flex>

            {/* Retracted quests — a quiet group below the lanes, only present
                when "Show inactive" surfaces them. */}
            {retracted.length > 0 && (
              <Stack gap={2} mt={4}>
                <HStack gap={2} px={1} align="baseline">
                  <Text fontSize="sm" lineHeight="1">
                    🗄️
                  </Text>
                  <Text
                    fontFamily="heading"
                    fontWeight="700"
                    color="charcoal.400"
                    fontSize="sm"
                  >
                    {QUEST_LIFECYCLE_LABELS.retracted}
                  </Text>
                  <Box
                    bg="gray.100"
                    color="charcoal.500"
                    fontSize="2xs"
                    fontWeight="700"
                    fontFamily="heading"
                    px={1.5}
                    borderRadius="full"
                  >
                    {retracted.length}
                  </Box>
                </HStack>
                <Box
                  display="grid"
                  gridTemplateColumns="repeat(auto-fill, minmax(230px, 1fr))"
                  gap={2}
                >
                  {retracted.map((u) => (
                    <QuestCard key={String(u._id)} u={u} />
                  ))}
                </Box>
              </Stack>
            )}
          </>
        )}
      </Stack>

      {pickerOpen && (
        <ScholarPickerDialog
          scholars={scholars}
          onClose={() => setPickerOpen(false)}
          onPick={(scholarId, scholarName) => {
            setPickerOpen(false);
            setAddingFor({ scholarId, scholarName });
          }}
        />
      )}

      {addingFor && (
        <AddQuestDialog
          scholarId={addingFor.scholarId}
          scholarName={addingFor.scholarName}
          onClose={() => setAddingFor(null)}
          onCreated={(unitId) => {
            setAddingFor(null);
            // New Quest → Edit tab (the outline); Summary would be empty.
            router.push(curriculumUnitHref(unitId, { pane: "edit" }));
          }}
        />
      )}
    </>
  );
}

// ── Dialog: pick which scholar gets a new Quest ──────────────────────

function ScholarPickerDialog({
  scholars,
  onClose,
  onPick,
}: {
  scholars: NonNullable<
    ReturnType<typeof useQuery<typeof api.users.listScholars>>
  >;
  onClose: () => void;
  onPick: (scholarId: Id<"users">, scholarName: string) => void;
}) {
  const { activeInstitution } = useActiveInstitution();
  return (
    <Dialog.Root open={true} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="480px">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Dialog.Title asChild>
                <Heading size="md" color="navy.500" fontFamily="heading">
                  Suggest a quest to which scholar?
                </Heading>
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} pb={4}>
              <ScholarPicker
                mode="single"
                selected={null}
                showParticipationFilter
                showEnrollmentStanding
                autoFocusSearch
                searchMissHint={noScholarMatchCopy({
                  institutionName: activeInstitution?.institutionName ?? null,
                  scope: activeInstitution?.scope ?? "institution",
                })}
                onChange={(id) => {
                  if (!id) return;
                  const s = scholars.find((x) => String(x.id) === id);
                  onPick(
                    id as Id<"users">,
                    s?.name ?? s?.username ?? "(unknown)",
                  );
                }}
              />
            </Dialog.Body>
            <Box px={6} pb={6}>
              <Flex justify="flex-end">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </Flex>
            </Box>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Dialog: create a new Quest for a scholar ─────────────────────────

function AddQuestDialog({
  scholarId,
  scholarName,
  onClose,
  onCreated,
}: {
  scholarId: Id<"users">;
  scholarName: string;
  onClose: () => void;
  onCreated: (unitId: Id<"units">) => void;
}) {
  const create = useMutation(api.units.createAndOfferQuestForScholar);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const result = await create({
        scholarId,
        title: title.trim(),
      });
      toaster.success({
        title: `🌠 Suggested to ${scholarName}`,
        description: "It's in their “Suggested by your teacher” list now — a guided destination they can start when ready.",
      });
      onCreated(result.unitId);
    } catch (e) {
      toaster.error({
        title: "Failed",
        description: e instanceof Error ? e.message : String(e),
      });
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={true} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="540px">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0.5}>
                <SectionEyebrow>{`Suggest a quest to ${scholarName}`}</SectionEyebrow>
                <Dialog.Title asChild>
                  <Heading size="md" color="navy.500" fontFamily="heading">
                    What&apos;s the quest?
                  </Heading>
                </Dialog.Title>
              </Stack>
            </Dialog.Header>
            <Dialog.Body px={6} py={4}>
              <Stack gap={4}>
                <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                  Drops it into {scholarName}&apos;s “Suggested by your teacher”
                  list as a guided destination. You&apos;ll land in the
                  Designer to flesh it out (lessons, activities, a badge). It
                  only becomes a quest in progress once they start it.
                </Text>
                <Stack gap={1}>
                  <Text
                    fontSize="xs"
                    color="charcoal.400"
                    fontFamily="heading"
                    fontWeight="600"
                  >
                    Quest title
                  </Text>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Word Detective — morphology"
                    disabled={submitting}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && title.trim() && !submitting) {
                        handleSubmit();
                      }
                    }}
                  />
                </Stack>
              </Stack>
            </Dialog.Body>
            <Box px={6} pb={6}>
              <Flex justify="flex-end" gap={2}>
                <Button variant="ghost" onClick={onClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  fontWeight="600"
                  disabled={!title.trim() || submitting}
                  onClick={handleSubmit}
                >
                  {submitting ? (
                    <>
                      <Spinner size="xs" mr={2} /> Suggesting...
                    </>
                  ) : (
                    <>
                      <ShootingStar size={14} weight="fill" style={{ marginRight: 4 }} />
                      Suggest it
                    </>
                  )}
                </Button>
              </Flex>
            </Box>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
