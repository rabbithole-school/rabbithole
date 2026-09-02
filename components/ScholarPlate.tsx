"use client";

/**
 * Scholar plate — the redesigned /scholar home view + teacher remote view.
 *
 * Three page-level sections: Class focus → Homework → Independent study.
 * Seeds + IS start-actions fold INTO the IS section footer, not a
 * separate peer heading.
 *
 * See review/scholar-home-activity-centric.md for design rationale.
 * See .claude/rules/visual-design.md: no edge-only accent stripes.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Archive, ArrowCounterClockwise, Cards, Clock, Lock, Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { toaster } from "@/lib/toaster";
import { ActivityModeIcon } from "@/lib/activityMode";
import { formatTimeAgo } from "@/lib/relativeTime";
import {
  dueStatus,
} from "@/shared/institutionDay";
import type { Id } from "@/convex/_generated/dataModel";
import type { ExploreSeedOptions } from "@/lib/bakePaths";
import { useInstitutionDay } from "@/hooks/useInstitutionDay";
import { useRemote } from "@/hooks/useRemote";
import { PeerTrails } from "@/components/PeerTrails";
import { SuggestedQuests } from "@/components/SuggestedQuests";
import { TakeHomePinButton } from "@/components/TakeHomePinButton";
import { StoryInvitations } from "@/components/StoryInvitations";
import { CreateQuestDialog } from "@/components/CreateQuestDialog";
import { ActivityCard, ActivityCardCta, ActivityCardMeta, ActivityCardTitle } from "@/components/ui/ActivityCard";
import { DueChip } from "@/components/ui/DueChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { UnitGroupBand, UnitGroupCard, UnitGroupRow } from "@/components/ui/UnitGroupCard";
import {
  isWelcomeGated,
  prioritizeFocusedUnit,
  type PlateFocusLock,
} from "@/lib/focusLock";
import {
  classFocusPlateLine,
  formatRoomTurnTime,
} from "@/shared/roomTurn";
import { useRoomTurnPhase } from "@/hooks/useRoomTurnPhase";
import { filterRowsForTab } from "@/shared/scholarHomeNow";

type PlateResult = NonNullable<
  ReturnType<typeof useQuery<typeof api.scholarPlate.activeForMe>>
>;
export type PlateRow = PlateResult["rows"][number];
export type OnboardingPinData = NonNullable<PlateResult["onboarding"]>;
export type ActiveSession = NonNullable<
  ReturnType<typeof useQuery<typeof api.sessions.list>>
>[number];
type ISUnitCardData = NonNullable<
  ReturnType<typeof useQuery<typeof api.units.myIndependentStudyUnits>>
>[number];

type Section = {
  origin: "classFocus" | "homework" | "is";
  heading: string;
  icon?: ReactNode;
};

/**
 * One ticking clock for the whole plate, so an overdue-homework card that
 * stays mounted across institution midnight acquires its "was due X" subline
 * without a per-card interval. Provided at the ScholarPlate root (60s tick);
 * consumers fall back to a render-time Date.now() when no provider is present
 * (e.g. a stray card rendered outside the plate). See PlateRowCard.
 */
const PlateNowContext = createContext<number>(0);

const SECTIONS: Section[] = [
  {
    origin: "classFocus",
    heading: "Class focus",
    icon: <ActivityModeIcon mode="classFocus" size={20} />,
  },
  {
    origin: "homework",
    heading: "Homework",
    icon: <ActivityModeIcon mode="homework" size={20} />,
  },
  {
    origin: "is",
    heading: "Quests",
  },
];

/** The live class-focus lock, passed down from the scholar Home. `unitId` is
 *  the focused unit; `label` names what the class is on right now. Null when no
 *  focus is live (or in the teacher's remote view). Since the hard focus gate
 *  was removed (lib/focusLock.ts) this is a SOFT signal: it sorts the focused
 *  unit first and names what the class is on. It never disables a card. */
export type { PlateFocusLock };

export function ScholarPlate({
  userId,
  onOpenUnit,
  onOpenUnitProgress,
  onExploreSeed,
  exploringSeedId,
  focusLock = null,
  hideOnboarding = false,
  hideHomework = false,
  tabKey,
}: {
  userId?: Id<"users">;
  onOpenUnit: (unitId: Id<"units">) => void;
  onOpenUnitProgress?: (
    unitId: Id<"units">,
    assignmentId?: Id<"assignments">,
  ) => void;
  onExploreSeed: (id: Id<"seeds">, opts?: ExploreSeedOptions) => void;
  exploringSeedId: string | null;
  focusLock?: PlateFocusLock;
  /** True when the page itself already rendered the Welcome pin ABOVE
   *  "Today" (H1 fix: a brand-new scholar's Welcome beat should lead Home,
   *  not sink below the louder Math Check-In card) — suppresses this
   *  component's own (otherwise-first) onboarding block so it isn't shown
   *  twice. `welcomeGate` below is still computed regardless, since the
   *  zero-history quest gating applies whether the pin renders here or was
   *  hoisted to the page. */
  hideOnboarding?: boolean;
  /** Suppresses homework rows in the Now quiet fallback during the school day. */
  hideHomework?: boolean;
  /** Self-view tab filter. `"all"`/`"now"` show assigned work,
   *  `"quests"` shows independent work, and subject/other keys narrow the
   *  assigned lanes. Undefined is the teacher remote view's full plate. */
  tabKey?: string;
}) {
  const isRemoteMode = !!userId;
  const isQuestTab = tabKey === "quests";
  const isAssignedTab = tabKey !== undefined && !isQuestTab;

  // One 60s clock for the whole plate — threaded to every PlateRowCard via
  // PlateNowContext so an overdue-homework card mounted across institution
  // midnight picks up its "was due X" subline (no per-card intervals).
  const [plateNowMs, setPlateNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setPlateNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const result = useQuery(api.scholarPlate.activeForMe, {
    userId,
    // Uncapped: the home shows EVERY active quest. Overflow is handled by
    // archiving, not by hiding rows behind a "show more" (a hidden quest made
    // "what's on my home?" ambiguous — see scholarPlate.ts cap rule).
    isLimit: 0,
    ...(isRemoteMode ? { includeWebActivities: true } : {}),
  });
  const activeSessions = useQuery(api.sessions.list, { userId });
  const pinningServerDay = useQuery(
    api.institutions.currentDayForScholar,
    !isRemoteMode && isQuestTab ? {} : "skip",
  );
  const pinningDay = useInstitutionDay(pinningServerDay);
  const pinning = useQuery(
    api.takeHomePlans.pinningForSelf,
    !isRemoteMode && isQuestTab && pinningDay
      ? { now: pinningDay.dayStart }
      : "skip",
  );
  const addSuggestion = useMutation(api.takeHomePlans.addSuggestion);
  const removePlanItem = useMutation(api.takeHomePlans.removeItem);
  const startSeedInPlan = useMutation(api.takeHomePlans.startSeedInPlan);
  const [pendingPinKeys, setPendingPinKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pinMutationsInFlight = useRef(new Set<string>());

  // The scholar's own IS units that have no live project yet. These
  // don't appear in the project-driven plate above (it only knows about
  // started projects), so surface them as standalone cards in the
  // Independent-study section — otherwise a freshly-built IS unit (e.g.
  // one the Curriculum Bot just created) is invisible until the scholar
  // hunts it down in Browse units. Teacher remote mode passes the target
  // scholar id through a server-gated query so the web plate mirrors iPad Home.
  const myISUnits = useQuery(
    api.units.myIndependentStudyUnits,
    userId ? { userId } : {},
  );
  // Standalone IS unit cards: units with NO in-progress (plate-visible)
  // project — either never opened, or opened but the started project's
  // current activity is complete while the unit still has work left
  // (hasStartedSession mirrors scholarPlate's completion skip, so the
  // unit can't fall into the gap where neither a plate row nor a card
  // shows). Fully-finished units (all online activities done) are NOT
  // "on the plate" — they belong in Browse/portfolio — so drop them.
  const newISUnits = useMemo(
    () =>
      (myISUnits ?? []).filter((u) => {
        if (u.hasStartedSession) return false;
        const done =
          u.onlineActivityCount > 0 &&
          u.completedCount >= u.onlineActivityCount;
        return !done;
      }),
    [myISUnits],
  );

  const bySection = useMemo(() => {
    const map: Record<Section["origin"], PlateRow[]> = {
      classFocus: [], homework: [], is: [],
    };
    if (!result) return map;
    const tabRows = tabKey
      ? filterRowsForTab(result.rows, tabKey)
      : result.rows;
    const rowsToUse = hideHomework
      ? tabRows.filter((row) => row.origin !== "homework")
      : tabRows;
    for (const r of rowsToUse) map[r.origin].push(r);
    return map;
  }, [hideHomework, result, tabKey]);

  const showExplore = !isRemoteMode && isQuestTab;
  // H1 fix: gate zero-history authoring/exploration actions (Custom Quest +
  // the suggested-quests/peer-trails extras) until the scholar has completed
  // at least the FIRST Welcome beat. Lifts the moment `completedCount` reaches
  // 1; fully gone once onboarding itself completes (`result.onboarding` →
  // null). This is the ONLY gate on these actions now — a live class focus no
  // longer locks them (lib/focusLock.ts).
  const welcomeGate = isWelcomeGated(result?.onboarding);
  const pinForUnit = (unitId: Id<"units">) =>
    pinning?.pins.find((pin) => pin.unitId === unitId) ?? null;
  const runPinMutation = async (
    key: string,
    action: () => Promise<unknown>,
  ) => {
    if (pinMutationsInFlight.current.has(key)) return;
    pinMutationsInFlight.current.add(key);
    setPendingPinKeys(new Set(pinMutationsInFlight.current));
    try {
      await action();
    } catch (error) {
      console.error("Error updating take-home Quest:", error);
      toaster.error({
        title: "Couldn't update your take-home list",
        description: "Please try again.",
      });
    } finally {
      pinMutationsInFlight.current.delete(key);
      setPendingPinKeys(new Set(pinMutationsInFlight.current));
    }
  };
  const toggleUnitPin = async (unitId: Id<"units">) => {
    const pin = pinForUnit(unitId);
    await runPinMutation(`unit:${unitId}`, () => {
      if (pin) return removePlanItem({ itemId: pin.itemId });
      return addSuggestion({ suggestion: { kind: "quest", unitId } });
    });
  };
  const unitPinAction = (
    unitId: Id<"units">,
    title: string,
  ) =>
    pinning?.dayKey ? (
      <TakeHomePinButton
        pinned={pinForUnit(unitId) !== null}
        subject={title}
        busy={pendingPinKeys.has(`unit:${unitId}`)}
        onToggle={() => toggleUnitPin(unitId)}
      />
    ) : null;

  // Initial load: show spinner before we have any data.
  if (result === undefined) {
    return <Flex justify="center" py={6}><Spinner size="sm" color="violet.500" /></Flex>;
  }

  return (
    <PlateNowContext.Provider value={plateNowMs}>
      <Stack gap={10}>
        {!hideOnboarding && result.onboarding && (
          <Stack gap={3}>
            <ScholarHomeSectionHeader color="violet.600">
              Welcome to Rabbithole
            </ScholarHomeSectionHeader>
            <OnboardingPin pin={result.onboarding} interactive={!isRemoteMode} />
          </Stack>
        )}
        {SECTIONS.map((section) => {
          if (isQuestTab && section.origin !== "is") return null;
          if (isAssignedTab && section.origin === "is") return null;
          const sectionRows = bySection[section.origin];
          const totalForSection = section.origin === "is" ? result.isTotalCount : sectionRows.length;
          const isUnitCards = section.origin === "is" ? newISUnits : [];
          if (sectionRows.length === 0 && isUnitCards.length === 0 && section.origin !== "is") return null;
          return (
            <PlateSection
              key={section.origin}
              section={section}
              rows={sectionRows}
              totalForSection={totalForSection}
              isUnitCards={isUnitCards}
              onOpenUnit={onOpenUnit}
              onOpenUnitProgress={onOpenUnitProgress}
              activeSessions={activeSessions}
              showExplore={showExplore}
              onExploreSeed={onExploreSeed}
              exploringSeedId={exploringSeedId}
              focusLock={focusLock}
              welcomeGate={welcomeGate}
              unitPinAction={isQuestTab ? unitPinAction : undefined}
              suggestedQuestPinAction={
                isQuestTab && pinning?.dayKey
                  ? (seedId, unitId, title) => {
                      const pin = pinForUnit(unitId);
                      return (
                        <TakeHomePinButton
                          pinned={pin !== null}
                          subject={title}
                          busy={pendingPinKeys.has(`unit:${unitId}`)}
                          onToggle={() =>
                            runPinMutation(`unit:${unitId}`, () =>
                              pin
                                ? removePlanItem({ itemId: pin.itemId })
                                : startSeedInPlan({ seedId }),
                            )
                          }
                        />
                      );
                    }
                  : undefined
              }
            />
          );
        })}
      </Stack>
    </PlateNowContext.Provider>
  );
}

// ── Onboarding pin — quiet, always-first "Continue Welcome" row ───────
// The self-paced welcome quest's later beats would otherwise sort by
// lastTouched and sink under each day's fresh work. This pins the next beat
// to the very top of Home until the unit is complete. It never locks
// anything — just stays visibly first.
export function OnboardingPin({
  pin,
  interactive,
}: {
  pin: OnboardingPinData;
  interactive: boolean;
}) {
  const { stamp, remote } = useRemote();
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const [starting, setStarting] = useState(false);

  const started = pin.completedCount > 0 || pin.sessionId !== null;

  const go = async () => {
    if (!interactive || starting) return;
    if (pin.sessionId) {
      router.push(stamp(`/scholar/${pin.sessionId}`));
      return;
    }
    setStarting(true);
    try {
      const result = await createSession({
        activityId: pin.activityId,
        ...(pin.assignmentId ? { assignmentId: pin.assignmentId } : {}),
        ...(remote ? { userId: remote as Id<"users"> } : {}),
      });
      if (result) router.push(stamp(`/scholar/${result.id}`));
      else setStarting(false);
    } catch (error) {
      console.error("Error continuing welcome quest:", error);
      toaster.error({
        title: "Couldn't open Welcome",
        description: "Please try again.",
      });
      setStarting(false);
    }
  };

  return (
    <Box
      as={interactive ? "button" : "div"}
      onClick={interactive ? go : undefined}
      w="100%"
      textAlign="left"
      borderWidth="1px"
      borderColor="violet.200"
      bg="violet.50"
      borderRadius="xl"
      px={4}
      py={3.5}
      opacity={starting ? 0.6 : 1}
      transition="background 0.15s"
      cursor={interactive ? "pointer" : undefined}
      _hover={interactive ? { bg: "violet.100" } : undefined}
      aria-label={`Continue Welcome — next: ${pin.nextBeatTitle}`}
    >
      <HStack gap={3} align="center">
        <Box fontSize="xl" lineHeight="1" flexShrink={0} aria-hidden>
          {pin.emoji || "🧭"}
        </Box>
        <Stack gap={0.5} flex={1} minW={0}>
          <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.500">
            Continue Welcome
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineClamp={1}>
            Next: {pin.nextBeatTitle}
          </Text>
        </Stack>
        <Stack gap={0.5} align="end" flexShrink={0}>
          {interactive && (
            <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="violet.600">
              {started ? "Continue" : "Start"} →
            </Text>
          )}
          <Text fontFamily="heading" fontSize="2xs" color="charcoal.400">
            {pin.completedCount} of {pin.totalCount}
          </Text>
        </Stack>
      </HStack>
    </Box>
  );
}

// ── Section ──────────────────────────────────────────────────────────
function PlateSection({
  section,
  rows,
  totalForSection,
  isUnitCards,
  onOpenUnit,
  onOpenUnitProgress,
  activeSessions,
  showExplore,
  onExploreSeed,
  exploringSeedId,
  focusLock,
  welcomeGate = false,
  unitPinAction,
  suggestedQuestPinAction,
}: {
  section: Section;
  rows: PlateRow[];
  totalForSection: number;
  isUnitCards: ISUnitCardData[];
  onOpenUnit: (unitId: Id<"units">) => void;
  onOpenUnitProgress?: (
    unitId: Id<"units">,
    assignmentId?: Id<"assignments">,
  ) => void;
  activeSessions: ActiveSession[] | undefined;
  showExplore: boolean;
  onExploreSeed: (id: Id<"seeds">, opts?: ExploreSeedOptions) => void;
  exploringSeedId: string | null;
  focusLock: PlateFocusLock;
  /** H1 fix: true while the scholar hasn't completed the first Welcome beat
   *  yet — gates the "Custom Quest" entry + the suggested-quests/peer-trails
   *  extras. The only gate left on them since the class-focus lock was removed
   *  (lib/focusLock.ts). */
  welcomeGate?: boolean;
  unitPinAction?: (
    unitId: Id<"units">,
    title: string,
  ) => React.ReactNode;
  suggestedQuestPinAction?: (
    seedId: Id<"seeds">,
    unitId: Id<"units">,
    title: string,
  ) => React.ReactNode;
}) {
  const [customQuestOpen, setCustomQuestOpen] = useState(false);
  // A not-yet-completed first Welcome beat gates NEW independent work — a
  // zero-history scholar shouldn't author/explore before finishing even one
  // beat of Welcome (H1). A live class focus USED to gate the same entries;
  // that hard gate is gone (lib/focusLock.ts), so Welcome is the only reason
  // left.
  const gateHint = "Finish Welcome first";
  // The gate only ever disables the "Custom Quest" authoring entry (and hides
  // the explore extras) — it NEVER hides an already-started or offered quest,
  // which stay playable right below. So the note must speak only to what's
  // actually gated (creating a Custom Quest); "New quests open up after…" over
  // a playable quest read as a contradiction (pilot9 J8b).
  const gateNote = "Custom Quests unlock after you finish Welcome";
  const hasQuestContent = rows.length > 0 || isUnitCards.length > 0;
  type Bucket = {
    unitId: Id<"units"> | null;
    unitTitle: string | null;
    unitEmoji: string | null;
    unitCompletedCount: number | null;
    unitActivityCount: number | null;
    assignmentId?: Id<"assignments">;
    teacherName?: string;
    teacherImage?: string;
    rows: PlateRow[];
    sortKey: number;
  };
  const bucketMap = new Map<string, Bucket>();
  for (const r of rows) {
    const key = r.unitId ? `${r.unitId}:${r.assignmentId ?? ""}` : "_anchorless";
    const existing = bucketMap.get(key);
    if (existing) {
      existing.rows.push(r);
      if (r.lastTouched > existing.sortKey) existing.sortKey = r.lastTouched;
    } else {
      bucketMap.set(key, {
        unitId: r.unitId, unitTitle: r.unitTitle, unitEmoji: r.unitEmoji,
        assignmentId: r.assignmentId,
        unitCompletedCount: r.unitCompletedCount, unitActivityCount: r.unitActivityCount,
        teacherName: r.teacherName, teacherImage: r.teacherImage,
        rows: [r], sortKey: r.lastTouched,
      });
    }
  }
  const sortedBuckets = Array.from(bucketMap.values()).sort(
    (a, b) => b.sortKey - a.sortKey,
  );
  const buckets =
    section.origin === "classFocus"
      ? prioritizeFocusedUnit(sortedBuckets, focusLock)
      : sortedBuckets;

  // Section count — honest about started ("in progress") vs not-yet-started
  // ("to start") work, so a header never reads "in progress" above a "not
  // started" item. Homework reads "N due" (applies whether opened or not).
  //
  // Reopened-completed rows are excluded from every owed-work count: a scholar
  // who peeked back into finished work via "Keep working on this" still sees a
  // resumable card, but it must NOT resurrect as due/in-progress owed work.
  const owedRows = rows.filter((r) => !r.isReopenedComplete);
  const startedCount = owedRows.filter((r) => !r.notStarted).length;
  const notStartedCount = owedRows.filter((r) => r.notStarted).length;
  let countText: string | null = null;
  if (section.origin === "homework") {
    if (owedRows.length > 0) countText = `${owedRows.length} due`;
  } else if (section.origin === "is") {
    // Started quests have a session. The not-yet-started IS-unit cards are
    // visible right below as their own cards, so we DON'T also count them
    // here — a bare "1 to start" next to the Custom Quest button read as
    // awkward/unclear.
    countText = totalForSection > 0 ? `${totalForSection} in progress` : null;
  } else {
    const parts: string[] = [];
    if (startedCount > 0) parts.push(`${startedCount} in progress`);
    if (notStartedCount > 0) parts.push(`${notStartedCount} to start`);
    countText = parts.length ? parts.join(" · ") : null;
  }

  return (
    <Stack gap={4} id={`plate-${section.origin}`} scrollMarginTop="64px">
      {section.origin === "is" && showExplore && (
        <CreateQuestDialog
          open={customQuestOpen}
          onClose={() => setCustomQuestOpen(false)}
        />
      )}
      <ScholarHomeSectionHeader
        icon={section.icon}
        actions={
          <HStack gap={3}>
            {section.origin === "is" && showExplore && (
              welcomeGate ? (
                <Button
                  size="2xs"
                  variant="outline"
                  colorPalette="gray"
                  fontFamily="heading"
                  fontWeight="600"
                  disabled
                  title={gateHint}
                >
                  <Lock size={12} style={{ marginRight: 3 }} /> Custom Quest
                </Button>
              ) : (
                <Button
                  size="2xs"
                  variant="outline"
                  colorPalette="violet"
                  fontFamily="heading"
                  fontWeight="600"
                  onClick={() => setCustomQuestOpen(true)}
                >
                  <Plus size={12} style={{ marginRight: 3 }} /> Custom Quest
                </Button>
              )
            )}
            {countText && (
              <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
                {countText}
              </Text>
            )}
          </HStack>
        }
      >
        {section.heading}
      </ScholarHomeSectionHeader>

      {/* Welcome-gate hint for the disabled Custom Quest entry (a tooltip
          alone isn't discoverable). Quiet: a small lock, muted text, no new
          colour. */}
      {section.origin === "is" && showExplore && welcomeGate && (
        <HStack gap={1.5} fontSize="xs" color="charcoal.400" fontFamily="heading">
          <Lock size={12} />
          <Text lineClamp={1}>{gateNote}</Text>
        </HStack>
      )}

      {section.origin === "is" && showExplore && !hasQuestContent && (
        <EmptyState
          title="No Quests yet"
          hint="Quests you start will show up here."
        />
      )}

      {rows.length > 0 && (
        <Stack gap={5}>
          {buckets.map((b, i) => (
            <ScholarPlateActivityGroup
              key={String(b.unitId ? `${b.unitId}:${b.assignmentId ?? ""}` : `_anchorless_${i}`)}
              rows={b.rows}
              onOpenUnitProgress={onOpenUnitProgress}
              activeSessions={activeSessions}
              focusLock={focusLock}
              unitPinAction={unitPinAction}
            />
          ))}
        </Stack>
      )}

      {/* Not-yet-started IS units (no live project) — the project-driven
          buckets above can't show these. Tapping opens the unit picker
          pre-focused on the unit's activities. */}
      {isUnitCards.length > 0 && (
        <Stack gap={2}>
          {isUnitCards.map((u) => (
            <ISUnitCard
              key={String(u.unitId)}
              unit={u}
              onOpen={onOpenUnit}
            />
          ))}
        </Stack>
      )}

      {/* Suggested destinations (seeds) + social-proof peer trails sit under
          the quests in progress. Self view only (hidden from the teacher
          remote view). Hidden before the first Welcome beat is done (H1: a
          zero-history scholar shouldn't be nudged into exploring before
          finishing even one beat); a live class focus no longer hides them.
          The full star map now lives on its own screen — /scholar/map. */}
      {section.origin === "is" && showExplore && !welcomeGate && (
        <>
          <SuggestedQuests
            onStart={onExploreSeed}
            startingSeedId={exploringSeedId}
            pinAction={
              suggestedQuestPinAction
                ? (quest) =>
                    suggestedQuestPinAction(quest.seedId, quest.unitId, quest.title)
                : undefined
            }
          />
          <StoryInvitations />
          <PeerTrails />
        </>
      )}

    </Stack>
  );
}

// ── Not-started IS unit card (unit-level, opens the picker) ──────────
function ISUnitCard({ unit, onOpen }: {
  unit: ISUnitCardData;
  onOpen: (unitId: Id<"units">) => void;
}) {
  const n = unit.onlineActivityCount;
  const inProgress = unit.completedCount > 0;
  const meta =
    n > 0
      ? inProgress
        ? `${unit.completedCount} of ${n} done · keep going`
        : `${n} ${n === 1 ? "activity" : "activities"} · not started`
      : inProgress
        ? "keep going"
        : "not started";
  return (
    <ActivityCard
      density="compact"
      glyph={unit.emoji || undefined}
      onClick={() => onOpen(unit.unitId)}
      ariaLabel={unit.title}
      cta={<ActivityCardCta>{inProgress ? "Continue" : "Start"}</ActivityCardCta>}
    >
      <ActivityCardTitle density="compact">{unit.title}</ActivityCardTitle>
      {unit.description && (
        <Text
          fontSize="sm"
          color="charcoal.500"
          fontFamily="body"
          lineHeight="1.45"
          lineClamp={2}
        >
          {unit.description}
        </Text>
      )}
      <ActivityCardMeta>{meta}</ActivityCardMeta>
    </ActivityCard>
  );
}

// ── Unit bucket — one banded card per unit, with one or more rows ─────

// Stable React key for a plate row. A started session has a unique
// sessionId; a not-started row has none, so fall back to its
// assignment+activity pair — the SAME pair the server de-dupes on, so two
// not-started rows for the same activity in two different assignments stay
// distinct (a bare `ns-${activityId}` would collide).
function rowKey(row: PlateRow): string {
  if (row.sessionId) return String(row.sessionId);
  return `ns-${row.assignmentId ?? "_"}-${row.activityId}`;
}

/** The canonical web card for one scholar activity.
 *
 * Unit-bearing activities always use the same quiet emoji/unit/teacher band as
 * the native iPad card. Both the plate and the Now digest consume this component
 * so a live activity does not change card families between tabs.
 */
export function ScholarPlateActivityCard({
  row,
  activeSessions,
  focusLock,
  onOpenUnitProgress,
  unitPinAction,
}: {
  row: PlateRow;
  activeSessions: ActiveSession[] | undefined;
  focusLock: PlateFocusLock;
  onOpenUnitProgress?: (
    unitId: Id<"units">,
    assignmentId?: Id<"assignments">,
  ) => void;
  unitPinAction?: (
    unitId: Id<"units">,
    title: string,
  ) => React.ReactNode;
}) {
  if (!row.unitId) {
    return (
      <PlateRowCard
        row={row}
        activeSessions={activeSessions}
        focusLock={focusLock}
      />
    );
  }
  const unitId = row.unitId;

  return (
    <UnitGroupCard>
      <UnitGroupBand
        emoji={row.unitEmoji}
        title={row.unitTitle}
        completedCount={row.unitCompletedCount}
        activityCount={row.unitActivityCount}
        teacherName={row.teacherName}
        teacherImage={row.teacherImage}
        onProgressClick={
          onOpenUnitProgress
            ? () => onOpenUnitProgress(unitId, row.assignmentId)
            : undefined
        }
      />
      <ScholarPlateActivityRow
        row={row}
        activeSessions={activeSessions}
        focusLock={focusLock}
        showDivider={false}
        secondaryAction={unitPinAction?.(unitId, row.unitTitle ?? "Quest")}
      />
    </UnitGroupCard>
  );
}

/** One canonical activity row inside a unit-banded card. */
export function ScholarPlateActivityRow({
  row,
  activeSessions,
  focusLock,
  showDivider,
  secondaryAction,
}: {
  row: PlateRow;
  activeSessions: ActiveSession[] | undefined;
  focusLock: PlateFocusLock;
  showDivider: boolean;
  secondaryAction?: React.ReactNode;
}) {
  return (
    <PlateRowCard
      row={row}
      activeSessions={activeSessions}
      focusLock={focusLock}
      variant="row"
      showDivider={showDivider}
      secondaryAction={secondaryAction}
    />
  );
}

/** The canonical web composition for one unit's visible activity rows. */
export function ScholarPlateActivityGroup({
  rows,
  activeSessions,
  focusLock,
  onOpenUnitProgress,
  unitPinAction,
}: {
  rows: PlateRow[];
  activeSessions: ActiveSession[] | undefined;
  focusLock: PlateFocusLock;
  onOpenUnitProgress?: (
    unitId: Id<"units">,
    assignmentId?: Id<"assignments">,
  ) => void;
  unitPinAction?: (
    unitId: Id<"units">,
    title: string,
  ) => React.ReactNode;
}) {
  const first = rows[0];
  if (!first) return null;

  return (
    <UnitBucket
      bucket={{
        unitId: first.unitId,
        unitTitle: first.unitTitle,
        unitEmoji: first.unitEmoji,
        unitCompletedCount: first.unitCompletedCount,
        unitActivityCount: first.unitActivityCount,
        assignmentId: first.assignmentId,
        teacherName: first.teacherName,
        teacherImage: first.teacherImage,
        rows,
      }}
      onOpenUnitProgress={onOpenUnitProgress}
      activeSessions={activeSessions}
      focusLock={focusLock}
      unitPinAction={unitPinAction}
    />
  );
}

function UnitBucket({ bucket, onOpenUnitProgress, activeSessions, focusLock, unitPinAction }: {
  bucket: {
    unitId: Id<"units"> | null;
    unitTitle: string | null;
    unitEmoji: string | null;
    unitCompletedCount: number | null;
    unitActivityCount: number | null;
    assignmentId?: Id<"assignments">;
    teacherName?: string;
    teacherImage?: string;
    rows: PlateRow[];
  };
  onOpenUnitProgress?: (
    unitId: Id<"units">,
    assignmentId?: Id<"assignments">,
  ) => void;
  activeSessions: ActiveSession[] | undefined;
  focusLock: PlateFocusLock;
  unitPinAction?: (
    unitId: Id<"units">,
    title: string,
  ) => React.ReactNode;
}) {
  // ── Split off "choice" lessons — a set of activities the scholar picks
  // from, not a ladder. Each group (rows sharing a choiceLessonId) becomes
  // one "Choose N of these" menu card; everything else renders as today.
  const choiceGroups = new Map<string, PlateRow[]>();
  const plainRows: PlateRow[] = [];
  for (const r of bucket.rows) {
    if (r.choiceLessonId) {
      const k = String(r.choiceLessonId);
      const g = choiceGroups.get(k);
      if (g) g.push(r);
      else choiceGroups.set(k, [r]);
    } else {
      plainRows.push(r);
    }
  }

  const renderPlain = (rows: PlateRow[]) => {
    if (rows.length === 0) return null;
    // Anchorless rows (seed explorations / ad-lib sessions) have no unit —
    // render them as plain cards, no chip.
    if (bucket.unitId === null) {
      return (
        <Stack gap={2}>
          {rows.map((row) => (
            <PlateRowCard
              key={rowKey(row)}
              row={row}
              activeSessions={activeSessions}
              focusLock={focusLock}
            />
          ))}
        </Stack>
      );
    }

    // Single-activity units use the same band + row composition as native.
    // Multi-activity units keep one shared band over all their rows.
    const isMultiActivity =
      rows.length > 1 || (bucket.unitActivityCount ?? 0) >= 2;

    if (!isMultiActivity) {
      return (
        <Stack gap={2}>
          {rows.map((row) => (
            <ScholarPlateActivityCard
              key={rowKey(row)}
              row={row}
              activeSessions={activeSessions}
              focusLock={focusLock}
              onOpenUnitProgress={onOpenUnitProgress}
              unitPinAction={unitPinAction}
            />
          ))}
        </Stack>
      );
    }

    const unitId = bucket.unitId;
    return (
      <UnitGroupCard>
        <UnitGroupBand
          emoji={bucket.unitEmoji}
          title={bucket.unitTitle}
          completedCount={bucket.unitCompletedCount}
          activityCount={bucket.unitActivityCount}
          teacherName={bucket.teacherName}
          teacherImage={bucket.teacherImage}
          onProgressClick={
            onOpenUnitProgress
              ? () => onOpenUnitProgress(unitId, bucket.assignmentId)
              : undefined
          }
        />
        {rows.map((row, i) => (
          <PlateRowCard
            key={rowKey(row)}
            row={row}
            activeSessions={activeSessions}
            focusLock={focusLock}
            variant="row"
            showDivider={i > 0}
            secondaryAction={
              i === 0
                ? unitPinAction?.(unitId, bucket.unitTitle ?? "Quest")
                : undefined
            }
          />
        ))}
      </UnitGroupCard>
    );
  };

  if (choiceGroups.size === 0) return renderPlain(bucket.rows);

  return (
    <Stack gap={2}>
      {Array.from(choiceGroups.entries()).map(([lessonId, options]) => (
        <ChoiceMenuCard
          key={`choice-${lessonId}`}
          unitEmoji={bucket.unitEmoji}
          unitTitle={bucket.unitTitle}
          teacherName={bucket.teacherName}
          teacherImage={bucket.teacherImage}
          options={options}
          activeSessions={activeSessions}
          focusLock={focusLock}
          pinAction={
            bucket.unitId
              ? unitPinAction?.(
                  bucket.unitId,
                  bucket.unitTitle ?? "Quest",
                )
              : undefined
          }
        />
      ))}
      {renderPlain(plainRows)}
    </Stack>
  );
}

// ── Choice menu — a lesson presented as "Choose N of these" alternatives.
// Reuses the UnitGroupCard band + rows, with a violet instruction strip so
// the scholar reads it as a menu (pick one), not a ladder (do them all).
function ChoiceMenuCard({
  unitEmoji,
  unitTitle,
  teacherName,
  teacherImage,
  options,
  activeSessions,
  focusLock,
  pinAction,
}: {
  unitEmoji: string | null;
  unitTitle: string | null;
  teacherName?: string;
  teacherImage?: string;
  options: PlateRow[];
  activeSessions: ActiveSession[] | undefined;
  focusLock: PlateFocusLock;
  pinAction?: React.ReactNode;
}) {
  const pickCount = options[0]?.choicePickCount ?? 1;
  const pickedCount = options[0]?.choicePickedCount ?? 0;
  const optionCount = options[0]?.choiceOptionCount ?? options.length;
  const instruction =
    pickCount > 1
      ? `Choose ${pickCount} of these ${optionCount}`
      : `Choose one of these ${optionCount}`;

  return (
    <UnitGroupCard>
      <UnitGroupBand
        emoji={unitEmoji}
        title={unitTitle}
        completedCount={null}
        activityCount={null}
        teacherName={teacherName}
        teacherImage={teacherImage}
      />
      <HStack
        gap={2}
        px={3.5}
        py={2}
        bg="violet.50"
        borderBottomWidth="1px"
        borderColor="violet.100"
        color="violet.600"
      >
        <Cards size={15} weight="fill" />
        <Text fontFamily="heading" fontWeight="700" fontSize="xs" letterSpacing="0.01em">
          {instruction}
        </Text>
        {pickCount > 1 && pickedCount > 0 && (
          <Text fontFamily="heading" fontWeight="500" fontSize="xs" color="violet.400">
            · picked {pickedCount}/{pickCount}
          </Text>
        )}
      </HStack>
      {options.map((row, i) => (
        <PlateRowCard
          key={rowKey(row)}
          row={row}
          activeSessions={activeSessions}
          focusLock={focusLock}
          variant="row"
          showDivider={i > 0}
          secondaryAction={i === 0 ? pinAction : undefined}
        />
      ))}
    </UnitGroupCard>
  );
}

// ── Individual plate row — renders as a standalone card (default) or as a
//    row inside a UnitGroupCard band (variant="row") ───────────────────
function PlateRowCard({
  row,
  variant = "card",
  showDivider = false,
  activeSessions,
  focusLock,
  secondaryAction,
}: {
  row: PlateRow;
  variant?: "card" | "row";
  showDivider?: boolean;
  activeSessions: ActiveSession[] | undefined;
  focusLock: PlateFocusLock;
  secondaryAction?: React.ReactNode;
}) {
  const { stamp, remote } = useRemote();
  const router = useRouter();
  const archive = useMutation(api.sessions.archive);
  const unarchive = useMutation(api.sessions.unarchive);
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const [isHovered, setIsHovered] = useState(false);
  const [starting, setStarting] = useState(false);

  const isOfflineHomework =
    row.activityKind === "offline" && row.origin === "homework";

  // "The turn, not the bell": this row IS the class-focus activity the room
  // is on right now (never a countdown — a soft phase + a wall-clock label).
  const matchesLiveFocus =
    row.origin === "classFocus" &&
    !!focusLock?.unitId &&
    String(row.unitId ?? "") === focusLock.unitId;
  const roomPhase = useRoomTurnPhase(matchesLiveFocus ? focusLock?.endsAt ?? null : null);
  const roomTimeLabel =
    matchesLiveFocus && focusLock?.endsAt != null && focusLock.timeZone
      ? formatRoomTurnTime(focusLock.endsAt, focusLock.timeZone)
      : null;
  const roomTurnLine = matchesLiveFocus ? classFocusPlateLine(roomPhase, roomTimeLabel) : null;

  // Secondary overdue read on All / subject cards: a tiny "was due X" subline
  // on past-due homework (the same orange/vocabulary as the Now pill). The
  // row carries the plate's scholar-calendar timezone from the read model. The
  // clock is the plate's ONE ticking value (PlateNowContext, 60s)
  // so a card mounted across midnight acquires the line; falls back to a
  // render-time Date.now() if rendered outside a provider.
  const ctxNow = useContext(PlateNowContext);
  const [fallbackNowMs] = useState(Date.now);
  const plateNowMs = ctxNow || fallbackNowMs;
  const dueInfo =
    row.origin === "homework"
      ? dueStatus(row.dueAt, plateNowMs, row.timeZone)
      : null;
  // The plate is a BROWSE surface, not a triage surface, so it deliberately
  // shows a deadline only when it is already late — a chip on every homework
  // row here would be deadline noise on a screen about choosing work. That
  // selection is the plate's; the RENDERING is not, and now goes through the
  // one shared DueChip (review/scholar-activity-row-rationalization.html §4).
  const isOverdue = dueInfo?.status === "overdue";

  const handleArchive = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!row.sessionId) return;
    if (row.isArchived) await unarchive({ id: row.sessionId });
    else await archive({ id: row.sessionId });
  };

  // Card context: every card leans on the unit/activity's authored blurb
  // (`row.description` — now the scholar-facing one) so the cards are
  // distinct and read TO the scholar. A started session's first message is
  // the formulaic "Welcome back, <name>!" greeting, which made every
  // in-progress card look alike — so the resume cue is only a fallback when
  // there's no authored description. Plus a bounded time estimate.
  const resumeCue = row.lastMessagePreview
    ? `“${row.lastMessagePreview.replace(/^["“\s]+|["”\s]+$/g, "")}”`
    : null;
  const context = row.description ?? resumeCue;
  const etaLabel = row.etaMinutes ? `~${row.etaMinutes} min` : null;

  // Not-started assigned activity: there's no session yet. Tapping creates
  // one (sessions.create derives unit/lesson from the activity) and opens it.
  const handleStart = async () => {
    const activityId = row.activityId;
    if (
      !activityId ||
      starting ||
      (isOfflineHomework && !row.assignmentId) ||
      (!isOfflineHomework && activeSessions === undefined)
    ) {
      return;
    }
    if (isOfflineHomework) {
      if (!row.assignmentId) return;
      setStarting(true);
      try {
        const result = await openOfflineHomework({
          activityId,
          assignmentId: row.assignmentId,
          ...(remote ? { userId: remote as Id<"users"> } : {}),
        });
        router.push(stamp(`/scholar/${result.id}`));
      } catch (error) {
        console.error("Error opening offline homework:", error);
        toaster.error({
          title: "Couldn't open that homework",
          description: "Please try again.",
        });
        setStarting(false);
      }
      return;
    }
    if (activeSessions === undefined) return;
    if (row.activityKind === "problem_set" && row.practiceSkillKey) {
      router.push(
        stamp(
          `/scholar/practice?skill=${encodeURIComponent(row.practiceSkillKey)}`,
        ),
      );
      return;
    }
    setStarting(true);
    try {
      const existing = activeSessions.find(
        (s) =>
          s.activityId &&
          String(s.activityId) === String(activityId) &&
          (row.assignmentId
            ? String(s.assignmentId ?? "") === String(row.assignmentId)
            : s.assignmentId === undefined),
      );
      if (existing?.id) {
        router.push(stamp(`/scholar/${existing.id}`));
        return;
      }
      const result = await createSession({
        activityId,
        ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
        ...(remote ? { userId: remote as Id<"users"> } : {}),
      });
      if (result) router.push(stamp(`/scholar/${result.id}`));
    } catch (error) {
      console.error("Error starting activity:", error);
      toaster.error({
        title: "Couldn't start that activity",
        description: "Please try again.",
      });
      setStarting(false);
    }
  };

  const href =
    row.sessionId && !isOfflineHomework
      ? stamp(`/scholar/${row.sessionId}`)
      : undefined;
  const onClick =
    !row.sessionId || isOfflineHomework ? handleStart : undefined;
  const resolvingSession =
    !isOfflineHomework && !row.sessionId && activeSessions === undefined;
  const opacity = row.isArchived
    ? 0.55
    : starting || resolvingSession
      ? 0.6
      : 1;

  const archiveButton = row.sessionId ? (
    <IconButton
      aria-label={row.isArchived ? "Restore" : "Archive"}
      size="xs" variant="ghost" color="charcoal.300"
      _hover={{ color: "charcoal.600", bg: "gray.100" }}
      visibility={isHovered ? "visible" : "hidden"}
      onClick={handleArchive}
    >
      {row.isArchived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />}
    </IconButton>
  ) : undefined;

  const cta = (
    <ActivityCardCta
      loading={starting || resolvingSession}
      showCaret
    >
      {isOfflineHomework
        ? "Open"
        : row.isContinuation
          ? "Continue"
          : row.notStarted
            ? "Start"
            : "Continue"}
    </ActivityCardCta>
  );

  const body = (
    <>
      <ActivityCardTitle density="compact">{row.title}</ActivityCardTitle>
      {context && (
        <Text fontSize="sm" color="charcoal.500" fontFamily="body"
          lineHeight="1.45" lineClamp={2}>
          {context}
        </Text>
      )}
      {roomTurnLine ? (
        <HStack gap={1.5} fontSize="xs" color="violet.500" fontFamily="heading">
          <Clock size={12} />
          <Text lineClamp={1}>{roomTurnLine}</Text>
        </HStack>
      ) : (
        <HStack gap={1.5} fontSize="xs" color="charcoal.400" fontFamily="heading">
          {etaLabel && (
            <>
              <Text>{etaLabel}</Text>
              <Text color="charcoal.300">·</Text>
            </>
          )}
          <Text>
            {row.isArchived ? "archived · " : ""}
            {row.isContinuation
              ? "up next"
              : row.notStarted
                ? "not started"
                : `last opened ${formatTimeAgo(row.lastTouched)}`}
          </Text>
        </HStack>
      )}
      {isOverdue && (
        <Box alignSelf="flex-start">
          <DueChip dueAt={row.dueAt} nowMs={plateNowMs} timeZone={row.timeZone} />
        </Box>
      )}
    </>
  );

  if (variant === "row") {
    return (
      <UnitGroupRow
        status={row.notStarted ? "todo" : "here"}
        showDivider={showDivider}
        href={href}
        onClick={onClick}
        ariaLabel={
          row.title
        }
        opacity={opacity}
        trailing={archiveButton}
        cta={cta}
        secondaryAction={secondaryAction}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {body}
      </UnitGroupRow>
    );
  }

  return (
    <ActivityCard
      density="compact"
      // A standalone card is NOT under a unit band, so it carries its own
      // identity glyph — the same axis native already applied here. No
      // fallback: a generic memo emoji on every unitless row identifies
      // nothing (review/scholar-activity-row-rationalization.html §6.3).
      glyph={row.unitEmoji ?? undefined}
      ariaLabel={
        row.title
      }
      href={href}
      onClick={onClick}
      opacity={opacity}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      trailing={archiveButton}
      cta={cta}
      secondaryAction={secondaryAction}
    >
      {body}
    </ActivityCard>
  );
}
