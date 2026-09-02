import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useConvexAuth } from "@convex-dev/auth/react";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import Svg, { Circle, Rect, Defs, RadialGradient, Stop } from "react-native-svg";
import { Dimensions } from "react-native";
import PagerView from "react-native-pager-view";
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppLauncher } from "@/components/AppLauncher";
import { FocusStrip } from "@/components/FocusStrip";
import { ArchivedSessions } from "@/components/ArchivedSessions";
import { CreateQuestDialog } from "@/components/CreateQuestDialog";
import { DevManipulativeLauncher } from "@/components/EmbeddedWebLaunchButton";
import { PracticePlaylistCard } from "@/components/practice/PracticePlaylistCard";
import { CheckInHomeCard } from "@/components/practice/CheckInHomeCard";
import { MapHomeCard } from "@/components/MapHomeCard";
import { MapCompletionCard } from "@/components/MapCompletionCard";
import { ScholarCalculatorLicenseCard } from "@/components/ScholarCalculatorLicenseCard";
import {
  PrepActivityCards,
  PrepEntryCard,
} from "@/components/ScholarPrepCards";
import {
  SessionsTitleSwitcher,
  type SessionsView,
} from "@/components/SessionsSwitcher";
import { SuggestedQuests } from "@/components/SuggestedQuests";
import { StoryInvitations } from "@/components/StoryInvitations";
import { PeerTrails } from "@/components/PeerTrails";
import { UnitBand } from "@/components/UnitBand";
import { ScholarHomeTabs } from "@/components/ScholarHomeTabs";
import { PlannedTodayCard } from "@/components/PlannedTodayCard";
import { ComingUpCard } from "@/components/ComingUpCard";
import {
  TakeHomePlan,
  type TakeHomePinning,
} from "@/components/TakeHomePlan";
import { TakeHomePinButton } from "@/components/TakeHomePinButton";
import { BirthdayConfetti } from "@/components/BirthdayConfetti";
import { HouseIcon, SunHorizonIcon, TargetIcon } from "@/components/PrepIcons";
import { api, type Id } from "@/lib/convex";
import { tuning, useTuningValue } from "@/lib/homeGestureTuning";
import { FORCE_ALL_HOME_CARDS } from "@/lib/homeDevForce";
import { HOME_GAP, HOME_LABEL_GAP, HOME_SECTION_GAP } from "@/lib/homeRhythm";
import { HomeSection, HomeSectionHead } from "@/components/HomeSection";
import { DueChip } from "@/components/ui/DueChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { openWebActivity } from "@/lib/externalAppHost";
import { openGameActivity } from "@/lib/gameHost";
import { webEmbedUrlError } from "@/lib/webEmbedConfig";
import { isWithinPrepTime } from "@/lib/prepTime";
import {
  homeTabIndexForKey,
  homeTabKeyForIndex,
  homeTabPageKeys,
} from "@/lib/homeTabPager";
import { fonts, palette, useColors } from "@/theme";
import { useRoomTurnPhase } from "@/hooks/useRoomTurnPhase";
import { useActiveRoomCues } from "@/hooks/useActiveRoomCues";
import { useInstitutionDay } from "@/hooks/useInstitutionDay";
import { RoomCueBanner } from "@/components/RoomCueBanner";
import { RestOverlay } from "@/components/RestOverlay";
import {
  isLockedByFocus,
  isWelcomeGated,
  pickLockingFocus,
  prioritizeFocusedUnit,
  type PlateFocusLock,
} from "../../vendor/shared/focusLock";
import { isBirthdayOnDayKey } from "../../vendor/shared/birthday";
import {
  OVERSIGHT_LINE,
  RELATIONAL_LINE,
} from "../../vendor/shared/admonishments";
import {
  classFocusPlateLine,
  formatRoomTurnTime,
} from "../../vendor/shared/roomTurn";
import {
  dayKeyForTimezone,
  dueStatus,
} from "../../vendor/shared/institutionDay";
import {
  buildNowDigest,
  deriveHomeTabs,
  filterHomeworkForNow,
  filterRowsForTab,
  groupHomeRowsByUnit,
  isWithinScheduleWindow,
  matchRowsToFocusOrder,
  pickCurrentBlock,
  shouldShowHomeworkInNow,
  type ScholarHomeTab,
} from "../../vendor/shared/scholarHomeNow";

// iPad-first: a centered reading-width column (works in landscape + portrait).
const COLUMN_MAX_WIDTH = 720;

// --- Sky pull, driven by native top-overscroll -----------------------------
// The Earth→Sky transition is no longer a separate Pan gesture fighting the
// list for touches. Instead we let the list rubber-band at the top (the iOS
// pull-to-refresh idiom) and map that overscroll → skyProgress in the scroll
// handler, so a pull ANYWHERE on the list — including the side margins — drives
// the sky, and short content still bounces (alwaysBounceVertical). Every feel
// parameter (pull distance, resistance, commit thresholds, parallax, sky-peek)
// is a live shared value in `@/lib/homeGestureTuning`. (The on-device tuning
// panel used to dial these in was removed once the feel settled — revert the
// PR that removed it to bring the panel back.) See the scroll handler +
// animated styles in Home for how each is applied.
// Cast back to the generic SectionList type so JSX keeps its Item/Section
// typing (createAnimatedComponent widens the generics to `unknown`); the
// reanimated onScroll handler is accepted on the resulting component.
const AnimatedSectionList =
  Animated.createAnimatedComponent(SectionList) as unknown as typeof SectionList;
const HOME_REFRESH_FEEDBACK_MS = 600;
/** Space — the sky backdrop's far stop, and the surface an unlocked-sky Quests
 *  page paints so its horizon sits against space rather than the page grey. */
const SPACE_BG = "#05060c";

type HomeSyncClient = Pick<
  ReturnType<typeof useConvex>,
  "connectionState" | "subscribeToConnectionState"
>;

function waitForHomeSync(client: HomeSyncClient, timeoutMs = 10_000) {
  const isSynced = () => {
    const state = client.connectionState();
    return state.isWebSocketConnected && !state.hasInflightRequests;
  };
  if (isSynced()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for Home data to sync"));
    }, timeoutMs);
    const settleIfSynced = () => {
      if (!isSynced()) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    unsubscribe = client.subscribeToConnectionState(settleIfSynced);
    settleIfSynced();
  });
}

type PlateRow = {
  sessionId: Id<"sessions"> | null;
  title: string;
  lastTouched: number;
  notStarted: boolean;
  activityKind:
    | "online"
    | "offline"
    | "shareBack"
    | "web"
    | "problem_set"
    | "game"
    | "simulator"
    | "vibecode";
  practiceSkillKey: string | null;
  origin: "classFocus" | "homework" | "is";
  activityId: Id<"activities"> | null;
  unitId: Id<"units"> | null;
  unitTitle: string | null;
  unitEmoji: string | null;
  unitCompletedCount: number | null;
  unitActivityCount: number | null;
  assignmentId?: Id<"assignments">;
  teacherName?: string;
  description: string | null;
  etaMinutes: number | null;
  lastMessagePreview: string | null;
  isContinuation?: boolean;
  isReopenedComplete: boolean;
  // Choice lessons: when set, this row is one option in a "pick N of these"
  // menu (grouped by choiceLessonId into a ChoiceMenuCard). See scholarPlate.ts.
  choiceLessonId?: Id<"lessons"> | null;
  choicePickCount?: number | null;
  choicePickedCount?: number | null;
  choiceOptionCount?: number | null;
  // Tab-filter fields added by Stage A backend (scholarPlate.ts):
  subject: string | null;
  dueAt: number | null;
  endsAt: number | null;
};
type QuestEmptyRow = { kind: "quest-empty" };
// A run of choice options (same choiceLessonId) collapsed into one menu card.
type ChoiceGroupRow = {
  kind: "choice-group";
  lessonId: string;
  options: PlateRow[];
};
type UnitActivityGroupRow = {
  kind: "unit-group";
  key: string;
  rows: PlateRow[];
};
type SectionRow =
  | PlateRow
  | QuestEmptyRow
  | ChoiceGroupRow
  | UnitActivityGroupRow;

// Collapse choice-option rows (sharing a choiceLessonId) into a single
// ChoiceGroupRow at the position of the first option; pass everything else
// through untouched.
function groupChoiceRows(rows: PlateRow[]): SectionRow[] {
  const out: SectionRow[] = [];
  const groupAt = new Map<string, number>();
  for (const r of rows) {
    if (r.choiceLessonId) {
      const key = String(r.choiceLessonId);
      const at = groupAt.get(key);
      if (at === undefined) {
        groupAt.set(key, out.length);
        out.push({ kind: "choice-group", lessonId: key, options: [r] });
      } else {
        (out[at] as ChoiceGroupRow).options.push(r);
      }
    } else {
      out.push(r);
    }
  }
  return out;
}

function groupPlateRows(rows: PlateRow[]): SectionRow[] {
  return groupHomeRowsByUnit(rows).flatMap((group) => {
    const displayRows = groupChoiceRows(group.rows);
    const containsChoiceGroup = displayRows.some(
      (row) => "kind" in row && row.kind === "choice-group",
    );
    if (
      group.unitId !== null &&
      group.rows.length > 1 &&
      !containsChoiceGroup
    ) {
      return [{ kind: "unit-group", key: group.key, rows: group.rows }];
    }
    return displayRows;
  });
}

function sectionRowKey(item: SectionRow, index: number): string {
  if (!("kind" in item)) {
    return `${String(item.sessionId ?? item.activityId ?? "row")}:${index}`;
  }
  if (item.kind === "choice-group") return `choice:${item.lessonId}:${index}`;
  if (item.kind === "unit-group") return `${item.key}:${index}`;
  return `${item.kind}:${index}`;
}

type OnboardingPin = {
  unitId: Id<"units">;
  assignmentId: Id<"assignments"> | null;
  activityId: Id<"activities">;
  sessionId: Id<"sessions"> | null;
  nextBeatTitle: string;
  emoji: string | null;
  completedCount: number;
  totalCount: number;
};

// Spacing-harness content only (FORCE_ALL_HOME_CARDS); unreachable in prod.
const DEMO_ONBOARDING_PIN = {
  unitId: "demo" as unknown as Id<"units">,
  assignmentId: null,
  activityId: "demo" as unknown as Id<"activities">,
  sessionId: null,
  nextBeatTitle: "What are you curious about?",
  emoji: "🧭",
  completedCount: 1,
  totalCount: 4,
} satisfies OnboardingPin;

function sectionMeta(c: ReturnType<typeof useColors>): Record<
  PlateRow["origin"],
  { heading: string; tint: string; subtle: string; muted: string }
> {
  return {
    classFocus: {
      heading: "Class focus",
      tint: c.violet,
      subtle: c.violetSubtle,
      muted: c.violetMuted,
    },
    homework: {
      heading: "Homework",
      tint: c.orange,
      subtle: c.orangeSubtle,
      muted: c.orangeMuted,
    },
    is: {
      heading: "Quests",
      tint: c.cyan,
      subtle: c.cyanSubtle,
      muted: c.cyanMuted,
    },
  };
}
const ORDER: PlateRow["origin"][] = ["classFocus", "homework", "is"];

// Prewarm each row's chat query while home is mounted, so tapping in paints
// instantly (native equivalent of the web RoutePrefetcher — same Convex
// shared-subscription trick).
function usePrewarmSessions(ids: string[]) {
  const convex = useConvex();
  const key = ids.join(",");
  useEffect(() => {
    const idList = key ? key.split(",") : [];
    const unsubs = idList.map((id) =>
      convex
        .watchQuery(api.sessions.getWithMessages, { id: id as Id<"sessions"> })
        .onUpdate(() => {}),
    );
    return () => unsubs.forEach((u) => u());
  }, [convex, key]);
}

export default function Home() {
  const { isAuthenticated } = useConvexAuth();
  const convex = useConvex();
  const router = useRouter();
  const W = Dimensions.get("window").width;
  const EARTH_R = W * 1.95;
  const EARTH_CY = EARTH_R + 2;
  const ATMO = W * 0.8; // distance over which gray→blue→black fades
  const ATMO_R = EARTH_R + ATMO;
  const EARTH_FRAC = EARTH_R / ATMO_R;
  const SKY_EXTRA = 900; // overscan above the screen so descending never reveals bg
  const [view, setView] = useState<SessionsView>("active");
  const [createQuestOpen, setCreateQuestOpen] = useState(false);
  // WHICH page is refreshing, not merely whether one is. Every mounted pager
  // page renders its own RefreshControl, so a bare boolean handed a second
  // page a `refreshing` it never initiated: iOS then had no pull gesture to
  // retract and the spinner stuck forever (reported after pull-to-refresh plus
  // fast tab swipes). Owning it by page key makes that unrepresentable.
  // This is STATE, not a ref, because the RefreshControls render off it — a ref
  // can change without re-rendering, which would leave the native control
  // showing a stale value.
  const [refreshOwner, setRefreshOwner] = useState<string | null>(null);
  // Re-entrancy guard only. A ref because it must be read and set
  // synchronously within one refresh, where a state value would be stale.
  const refreshInFlightRef = useRef(false);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const skyProgress = useSharedValue(0);
  // SIGNED scroll displacement (-contentOffset.y): positive past the top
  // (pull-down overscroll), negative scrolled into the list. The foreground
  // moves at exactly this (iOS-standard rubber-band velocity, no extra
  // transform); the earth/space background trails it at `bgParallax`× for
  // depth — CONTINUOUSLY through zero, so scrolling into the list eases the
  // horizon up instead of hard-stopping at dy=0, and the bottom bounce flows
  // through the same motion.
  const pullShift = useSharedValue(0);
  // 0→1 during the commit animation only — drives the earth's final descend
  // (`travel` px) as the app hands off to the Sky.
  const commitShift = useSharedValue(0);
  // The pull displacement captured at the commit instant. After commit the
  // native spring still snaps the list back to 0; the content layer adds back
  // (commitHold − live displacement) so the cards FREEZE where the finger
  // released and fade into the sky instead of visibly bouncing back.
  const commitHold = useSharedValue(0);
  // Once a pull commits to the sky, the native spring snapping the overscroll
  // back must NOT keep writing skyProgress — this flag freezes the scroll
  // handler so the commit animation to 1 wins.
  const committed = useSharedValue(false);
  // Whether a finger is currently dragging the list (begin/end drag), used to
  // gate the threshold haptic and momentum-commit.
  const isDragging = useSharedValue(false);
  // Fires the "you can release now" haptic once per drag when progress first
  // crosses commitProgress; reset on each begin-drag.
  const crossedThreshold = useSharedValue(false);
  // JS-side guard so openSky can't double-fire (endDrag + momentum both scheduling).
  const openedRef = useRef(false);
  const bounces = useTuningValue("bounces");
  const plate = useQuery(
    api.scholarPlate.activeForMe,
    isAuthenticated ? { includeWebActivities: true } : "skip",
  );
  // Milestone reveals (f6): the pull-to-Sky gesture is inert until at least one
  // of the scholar's two maps first has real data — no surface, no teaser before
  // then. Mirrored into a shared value the gesture worklets can read.
  const mapGates = useQuery(
    api.mapGates.mine,
    isAuthenticated ? {} : "skip",
  );
  // Sky reveal — the horizon backdrop + pull-to-Sky gesture — is scoped to the
  // Quests tab and the SKY map ONLY (`skyRevealActive`, computed once the active
  // tab is known, below). These are the gesture worklets' bridge to that gate;
  // the effect that syncs them lives next to `skyRevealActive`'s definition.
  const skyRevealActiveRef = useRef(false);
  const mapUnlockedSV = useSharedValue(false);
  const currentFocus = useQuery(
    api.assignments.currentClassFocusForMe,
    isAuthenticated ? { asLearner: true } : "skip",
  );
  const archived = useQuery(
    api.sessions.finishedForScholar,
    isAuthenticated
      ? { includeWebActivities: true, asLearner: true }
      : "skip",
  );
  // Room Layer — a teacher's live cue for this scholar's own screens (see
  // convex/roomCues.ts). Native is scholar-only (no teacher remote-view), so
  // the only gate needed is auth.
  const roomCues = useActiveRoomCues(isAuthenticated);
  const prepBlock = useQuery(
    api.metaChat.myPrepTimeBlock,
    isAuthenticated ? {} : "skip",
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const serverDayRaw = useQuery(
    api.institutions.currentDayForScholar,
    isAuthenticated ? {} : "skip",
  );
  const institutionDay = useInstitutionDay(serverDayRaw);
  const takeHomePinning = useQuery(
    api.takeHomePlans.pinningForSelf,
    isAuthenticated && institutionDay
      ? { now: institutionDay.dayStart }
      : "skip",
  );
  const addTakeHomeSuggestion = useMutation(api.takeHomePlans.addSuggestion);
  const removeTakeHomeItem = useMutation(api.takeHomePlans.removeItem);
  const startTakeHomeSeed = useMutation(api.takeHomePlans.startSeedInPlan);
  const [takeHomePinPendingKeys, setTakeHomePinPendingKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const takeHomePinInFlightRef = useRef(new Set<string>());
  const readyTakeHomePinning = takeHomePinning?.dayKey
    ? takeHomePinning
    : undefined;
  const pinByUnitId = useMemo(
    () => new Map((readyTakeHomePinning?.pins ?? []).filter((p) => p.unitId).map((p) => [String(p.unitId), p])),
    [readyTakeHomePinning],
  );
  const runTakeHomePin = useCallback(async (
    key: string,
    action: () => Promise<unknown>,
  ) => {
    if (takeHomePinInFlightRef.current.has(key)) return;
    takeHomePinInFlightRef.current.add(key);
    setTakeHomePinPendingKeys(new Set(takeHomePinInFlightRef.current));
    try {
      await action();
      Haptics.selectionAsync().catch(() => {});
    } catch (error) {
      console.warn("[take-home-pin] update failed", error);
      Alert.alert("Couldn't update your take-home list", "Please try again.");
    } finally {
      takeHomePinInFlightRef.current.delete(key);
      setTakeHomePinPendingKeys(new Set(takeHomePinInFlightRef.current));
    }
  }, []);
  const toggleQuestPin = useCallback(async (unitId: Id<"units"> | null) => {
    if (!unitId || !readyTakeHomePinning) return;
    const existing = pinByUnitId.get(String(unitId));
    await runTakeHomePin(`unit:${unitId}`, () =>
      existing
        ? removeTakeHomeItem({ itemId: existing.itemId })
        : addTakeHomeSuggestion({ suggestion: { kind: "quest", unitId } }),
    );
  }, [addTakeHomeSuggestion, pinByUnitId, readyTakeHomePinning, removeTakeHomeItem, runTakeHomePin]);
  const refreshHome = useCallback(async (owner: string) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setRefreshOwner(owner);
    // Convex queries are live subscriptions. A refresh updates the only
    // client-owned input and waits until those subscriptions are synced.
    setNowMs(Date.now());
    try {
      await Promise.all([
        waitForHomeSync(convex),
        new Promise<void>((resolve) =>
          setTimeout(resolve, HOME_REFRESH_FEEDBACK_MS),
        ),
      ]);
    } catch (error) {
      console.warn("Failed to refresh Home:", error);
      Alert.alert(
        "Can't refresh Home",
        "Check your connection. Home will update automatically when you're back online.",
      );
    } finally {
      requestAnimationFrame(() => {
        setRefreshOwner(null);
        refreshInFlightRef.current = false;
      });
    }
  }, [convex]);

  // ── Tab row (Now · All · subjects · Scholar’s Prep · Quests) ─────────
  // Active view only — hidden + reset to "now" when the header switches to Finished.
  const [activeTab, setActiveTab] = useState("now");
  // Per-tab persistence: each tab the scholar has visited keeps its OWN list
  // mounted (just hidden via display:none when inactive), so every tab's Convex
  // subscriptions — e.g. the Math playlist's standing → domains → playlist
  // cascade — stay warm and repeat visits paint instantly with no flash. Lazy:
  // a tab isn't mounted until first opened, so unused tabs never pay for it.
  const [visitedTabs, setVisitedTabs] = useState<string[]>(["now"]);
  // Sync: whenever the scholar switches to Finished view, reset the tab so
  // coming back to Active always lands on "now" (and re-mounts fresh).
  useEffect(() => {
    if (view !== "active") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Finished view must reset the retained Active tab before it can be revisited.
      setActiveTab("now");
      setVisitedTabs(["now"]);
    }
  }, [view]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- records a newly selected tab so its subscription remains mounted on later visits.
    setVisitedTabs((prev) =>
      prev.includes(activeTab) ? prev : [...prev, activeTab],
    );
  }, [activeTab]);

  // Institution day — drives dayKey cache-busters for bell-schedule queries.
  // Derived dayKey: fallback to computing from nowMs + "Pacific/Honolulu" so
  // the cache-buster is always a valid string even before the query resolves.
  const institutionDayKey =
    institutionDay?.dayKey ??
    dayKeyForTimezone(nowMs, serverDayRaw?.timeZone ?? "Pacific/Honolulu");
  const institutionTimeZone =
    institutionDay?.timeZone ?? serverDayRaw?.timeZone ?? "Pacific/Honolulu";

  // The signed-in scholar (for the birthday derivation). currentUser already
  // returns the full profile incl. dateOfBirth; the home fetches it only for
  // the wordless birthday confetti — derived on-client, no new round-trip.
  const me = useQuery(api.users.currentUser, isAuthenticated ? {} : "skip");
  const isOwnBirthday = isBirthdayOnDayKey(me?.dateOfBirth, institutionDayKey);

  // Bell-schedule block query (context strip: "Right now: Math Workshop · until 9:40").
  const blockResult = useQuery(
    api.masterSchedule.currentBlockForSelf,
    isAuthenticated ? { dayKey: institutionDayKey } : "skip",
  );
  // TODAY's planned entries (non-startable ghost cards in Now tab, invariant 1).
  const plannedTodayResult = useQuery(
    api.assignments.todayScheduleForSelf,
    isAuthenticated ? { dayKey: institutionDayKey, includeWebActivities: true } : "skip",
  );

  // Derive the current bell-schedule block from server data + 30s tick.
  const currentBlock =
    blockResult && blockResult.blocks.length > 0
      ? pickCurrentBlock(blockResult.blocks, nowMs, blockResult.timeZone)
      : null;
  const isWithinSchoolHours = blockResult
    ? isWithinScheduleWindow(blockResult.blocks, nowMs, blockResult.timeZone)
    : false;
  const isPrepTime =
    currentBlock?.kind === "prep" ||
    isWithinPrepTime(prepBlock ?? null, nowMs);
  // Planned today entries (setAt=null, startsAt today, invariant 1: no CTA).
  const plannedToday = plannedTodayResult?.entries ?? [];
  // Effective timezone for planned-time display.
  const plannedTimeZone =
    plannedTodayResult?.timeZone ?? blockResult?.timeZone ?? institutionTimeZone;

  const rows = useMemo(() => (plate?.rows ?? []) as PlateRow[], [plate?.rows]);
  // The Convex-inferred type of this field doesn't structurally match the local
  // OnboardingPin, hence the assertion — which has to sit BEFORE the harness
  // fallback, not around it, or the `??` reads as always-nullish.
  const platePin = plate?.onboarding as OnboardingPin | null | undefined;
  const onboarding: OnboardingPin | null =
    platePin ?? (FORCE_ALL_HOME_CARDS ? DEMO_ONBOARDING_PIN : null);
  const firstFocus = pickLockingFocus(currentFocus);
  const focusLock: PlateFocusLock = firstFocus
    ? {
        unitId: firstFocus.unitId ? String(firstFocus.unitId) : null,
        label:
          firstFocus.activityTitle ??
          firstFocus.lessonTitle ??
          firstFocus.unitTitle ??
          null,
        // "The turn, not the bell" — when (+ in what timezone) this class
        // focus wraps, so the plate's class-focus card can render a soft
        // local time instead of a bare "paused until then".
        endsAt: firstFocus.endsAt ?? null,
        timeZone: firstFocus.timeZone,
      }
    : null;
  const focusLocked = !!focusLock?.unitId;
  // H1 (review/ftue-audit): before the first Welcome beat is done, gate the
  // SAME "new exploration" actions a live class focus locks — Custom Quest,
  // the "Start with your own question" empty card, and Suggested Quests — so a
  // zero-history scholar finishes one beat of Welcome before authoring/
  // exploring. Mirrors web ScholarPlate's `welcomeGate` (vendor/shared/focusLock).
  const welcomeGate = isWelcomeGated(onboarding);
  const newQuestLocked = focusLocked || welcomeGate;
  const openCreateQuest = () => {
    if (newQuestLocked) return;
    Haptics.selectionAsync();
    setCreateQuestOpen(true);
  };
  usePrewarmSessions(
    rows.map((r) => r.sessionId).filter((x): x is Id<"sessions"> => !!x),
  );

  // Derive tabs from the plate's subject tabs + current rows (Active view only).
  // External apps available to this scholar drive the "Apps" tab (shown only
  // when ≥1 app exists); the launcher grid renders on that tab exclusively.
  const scholarApps = useQuery(
    api.scholarApps.listForLauncher,
    isAuthenticated ? {} : "skip",
  );
  const hasApps = (scholarApps?.length ?? 0) > 0;
  const { tabs } = useMemo(() => {
    if (!plate) return { tabs: [] as ScholarHomeTab[], hasOther: false };
    return deriveHomeTabs({
      subjectTabs: plate.subjectTabs ?? [],
      rows,
      hasApps,
    });
  }, [plate, rows, hasApps]);

  // A closure and a live block are mutually exclusive, so the harness forces
  // the BLOCK (the far more common state, and the one that carries a section
  // heading). To exercise the no-school branch instead, flip this to
  // `FORCE_ALL_HOME_CARDS ? { label: "Kūhiō Day" } : null`.
  const closure = blockResult?.closure ?? null;
  // The live timetable block. It is a section HEADING over the work happening
  // inside that block — never a free-floating line. Its label is the heading
  // ("MATH WORKSHOP"); the rest of the old one-line strip is its detail.
  //
  // A closure and a live block are mutually exclusive in real data (blocks come
  // back empty on a no-school day), so the closure wins outright. That is also
  // what stops FORCE_ALL_HOME_CARDS from rendering the contradiction.
  const blockContext: { label: string; detail: string | null } | null = closure
    ? null
    : currentBlock
      ? {
          label: currentBlock.label,
          detail:
            [
              `until ${currentBlock.endLocal}`,
              currentBlock.teacherName ? `with ${currentBlock.teacherName}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || null,
        }
      : FORCE_ALL_HOME_CARDS
        ? { label: "Math Workshop", detail: "until 9:40 · with Ms. Rivera" }
        : null;

  // If the active tab vanished from the derived set (e.g. a subject disappears
  // mid-day), fall back to "now" for THIS render. This derive is the whole fix:
  // it prevents the one-frame blank on a now-invalid tab. The only remaining
  // reader of the raw `activeTab` is the visited-tabs bookkeeping above, which
  // is harmless — `renderableTabs` filters `visitedTabs` through `validTabKeys`,
  // so a stale entry never mounts anything. Nothing user-visible reads it, so a
  // tab that comes back returns the scholar to it rather than having been
  // rewritten to "now" behind their back.
  const validTabKeys = useMemo(
    () => new Set<string>(["now", ...tabs.map((t) => t.key)]),
    [tabs],
  );
  const effectiveActiveTab = validTabKeys.has(activeTab) ? activeTab : "now";
  // No "retract on tab change" effect is needed, and deliberately so. A page
  // that did not start the refresh renders `refreshing={false}` (below), so it
  // can never inherit a spinner it does not own — which was the actual bug.
  // The OWNER page keeping its spinner while the scholar swipes away and back
  // is correct: the sync really is still running, and forcing it to retract
  // would lie about that.
  // Which tabs to keep mounted: every visited-and-still-valid tab, plus the
  // active one (added even before the visited-effect runs, so it never blanks).
  const renderableTabs = useMemo(() => {
    const set = new Set<string>(visitedTabs.filter((t) => validTabKeys.has(t)));
    set.add(effectiveActiveTab);
    return [...set];
  }, [visitedTabs, validTabKeys, effectiveActiveTab]);

  // ── Tab pager (horizontal swipe between tabs) ────────────────────────────
  // The tab CONTENT is a react-native-pager-view, not a display:none stack, so
  // a horizontal swipe pages between tabs. pager-view is a NATIVE
  // horizontally-paging scroll view, so iOS arbitrates the swipe axes itself:
  // the screen's two vertical gestures — the Earth→Sky top-overscroll handler
  // and pull-to-refresh, both driven by the inner AnimatedSectionList — keep
  // working with NO Gesture.Pan / activeOffsetX / failOffsetY wiring. A
  // hand-rolled Reanimated/RNGH pager would have to referee those axes by
  // hand; letting the native pager do it is the whole reason for the dependency.
  //
  // The pages are the FULL ordered tab list (homeTabPageKeys) — a pager needs
  // every index between 0 and the target to exist, and `renderableTabs` is a
  // Set in VISIT order, not tab order — so page index and tab order agree,
  // exactly like `validTabKeys` is built.
  const pagerRef = useRef<PagerView>(null);
  const pageKeys = useMemo(() => homeTabPageKeys(tabs), [tabs]);
  const activePageIndex = homeTabIndexForKey(pageKeys, effectiveActiveTab);
  // What the pager last reported as its page. The down-sync effect below skips
  // a setPage when the pager already sits on the target, so a swipe's
  // onPageSelected → setActiveTab → effect can't bounce a second setPage back
  // and fight the finger. It also lets the pager FOLLOW effectiveActiveTab when
  // the tab list reshapes (a subject vanishing mid-day) instead of stranding
  // the scholar on a now-stale index.
  const currentPageRef = useRef(activePageIndex);
  useEffect(() => {
    if (currentPageRef.current === activePageIndex) return;
    currentPageRef.current = activePageIndex;
    pagerRef.current?.setPage(activePageIndex);
  }, [activePageIndex]);

  // Sky reveal (horizon backdrop + pull-to-Sky gesture) is scoped to the Quests
  // tab and the SKY map only. The Tree map has its own affordance on the Math
  // tab (the "View your frontier" card), so a tree-only unlock never arms the
  // pull gesture, and no other tab shows the horizon.
  const skyRevealActive = effectiveActiveTab === "quests" && !!mapGates?.sky;
  useEffect(() => {
    skyRevealActiveRef.current = skyRevealActive;
    mapUnlockedSV.set(skyRevealActive);
    if (!skyRevealActive) {
      // Relock hardening. This fires whenever the Quests tab stops being active
      // (its list now stays MOUNTED but display:none rather than unmounting), so
      // HARD-reset the sky shared values — not withTiming — so a fast tab
      // re-entry can never reveal a residual faded/shifted horizon mid-animation.
      openedRef.current = false;
      committed.set(false);
      isDragging.set(false);
      crossedThreshold.set(false);
      commitHold.set(0);
      commitShift.set(0);
      skyProgress.set(0);
      // Keep a real scroll-into-list offset (negative) so returning while
      // scrolled keeps the horizon tucked; clear any positive overscroll so the
      // peek returns to rest instead of a stale shifted position.
      pullShift.set((v) => Math.min(0, v));
    }
  }, [
    skyRevealActive,
    mapUnlockedSV,
    committed,
    isDragging,
    crossedThreshold,
    commitHold,
    commitShift,
    skyProgress,
    pullShift,
  ]);

  const homeworkForNow = useMemo(
    () => filterHomeworkForNow(
      rows.filter((row) => row.origin === "homework"),
      {
        nowMs,
        timeZone: institutionTimeZone,
        nextOpenSchoolDayKey: plannedTodayResult?.nextOpenSchoolDayKey,
      },
    ),
    [
      rows,
      institutionTimeZone,
      nowMs,
      plannedTodayResult?.nextOpenSchoolDayKey,
    ],
  );

  // Fix A: loading guard — only apply digest when both relevant queries have
  // resolved. Before they resolve, treat as not-quiet to avoid flashing the
  // "nothing scheduled" state on cold launch.
  const nowDataLoaded =
    currentFocus !== undefined &&
    plannedTodayResult !== undefined &&
    blockResult !== undefined &&
    prepBlock !== undefined;
  const showHomeworkInNow = shouldShowHomeworkInNow({
    currentBlockKind: currentBlock?.kind,
    isWithinSchoolHours,
    isPrepTime,
  });
  // After Prep, the canonical take-home card owns these same homework rows plus
  // the scholar's chosen items. The legacy digest stands down rather than
  // rendering the assigned rows twice.
  const takeHomePlanOwnsNow = showHomeworkInNow && !isPrepTime;
  const homeworkVisibleInNow =
    showHomeworkInNow && !takeHomePlanOwnsNow ? homeworkForNow : [];
  const homeworkDueTodayInNow = homeworkVisibleInNow.filter(
    (r) => dueStatus(r.dueAt, nowMs, institutionTimeZone)?.status === "dueToday",
  );
  const homeworkOverdueInNow = homeworkVisibleInNow.filter(
    (r) => dueStatus(r.dueAt, nowMs, institutionTimeZone)?.status === "overdue",
  );
  const homeworkUpcomingInNow = homeworkVisibleInNow.filter(
    (r) =>
      r.dueAt == null ||
      dueStatus(r.dueAt, nowMs, institutionTimeZone)?.status === "upcoming",
  );

  // Fix A: use buildNowDigest to derive isQuiet and the live focus / upcoming
  // planned item lists. Pass playlist:null — practice lives under Math and
  // does not gate the quiet state.
  const { sections: nowSections, isQuiet: digestIsQuiet } = buildNowDigest({
    focusEntries: nowDataLoaded ? (currentFocus ?? []) : [],
    plannedToday: nowDataLoaded ? plannedToday : [],
    // Plate rows never include completed work, so stamp the explicit false the
    // helper's weak HomeworkEntry type needs.
    homework: nowDataLoaded
      ? homeworkVisibleInNow.map((r) => ({ ...r, completedByMe: false }))
      : [],
    playlist: null,
    nowMs,
  });
  // Live focus items for the Now tab header digest (currently-active only,
  // filtered by buildNowDigest to setAt <= nowMs && endsAt > nowMs).
  // For native rendering, match these back to the corresponding PlateRow entries
  // so we can reuse PlateCard (which already handles web-activity, start, lock, etc.).
  const nowFocusItems = (nowSections.find((s) => s.key === "focus") as
    | { key: "focus"; items: NonNullable<typeof currentFocus> }
    | undefined)?.items ?? [];
  const liveFocusRows = prioritizeFocusedUnit(
    matchRowsToFocusOrder(
      nowFocusItems,
      rows.filter((row) => row.origin === "classFocus"),
    ),
    focusLock,
  );
  const liveFocusItems = groupPlateRows(liveFocusRows);
  // Upcoming planned items (startsAt >= nowMs), filtered by buildNowDigest.
  const nowPlannedItems = (nowSections.find((s) => s.key === "planned") as
    | { key: "planned"; items: typeof plannedToday }
    | undefined)?.items ?? [];
  const isQuiet = nowDataLoaded && digestIsQuiet;
  // A clear Now tab does NOT mean the scholar has nothing to do: independent
  // Quests live on their own tab and are deliberately excluded from "now". The
  // empty state has to know, or it tells a scholar with three open Quests that
  // "nothing is open" and points them at starting a fourth.
  const hasQuestsWaiting = filterRowsForTab(rows, "quests").length > 0;

  const buildSectionsFor = (tab: string) => {
    const meta = sectionMeta(colors);
    const isNowTab = tab === "now";
    const isQuestTab = tab === "quests";
    const tabRows = filterRowsForTab(rows, tab);
    const effectiveRows =
      isNowTab && (!showHomeworkInNow || takeHomePlanOwnsNow)
        ? tabRows.filter((row) => row.origin !== "homework")
        : tabRows;
    return ORDER.map((origin) => {
      if (isQuestTab && origin !== "is") return null;
      if (!isQuestTab && origin === "is") return null;
      // Fix D: Now tab (not quiet): return null for ALL origins. Live class
      // focus is hoisted to the ListHeader digest above the planned rail;
      // rendering classFocus rows here AND in the header would double them.
      // (Old code only suppressed non-classFocus, leaving focus rows in the
      // SectionList body BELOW the header digest — inverting the Q5 ladder.)
      if (isNowTab && !isQuiet) return null;
      const sectionRows = effectiveRows.filter((r) => r.origin === origin);
      const owedRows = sectionRows.filter((row) => !row.isReopenedComplete);
      const startedCount = owedRows.filter((row) => !row.notStarted).length;
      const notStartedCount = owedRows.filter((row) => row.notStarted).length;
      const isTotalCount = plate?.isTotalCount ?? 0;
      const countText =
        origin === "homework"
          ? owedRows.length > 0
            ? `${owedRows.length} due`
            : null
          : origin === "classFocus"
            ? [
                startedCount > 0 ? `${startedCount} in progress` : null,
                notStartedCount > 0 ? `${notStartedCount} to start` : null,
              ].filter(Boolean).join(" · ")
            : isTotalCount > 0
              ? `${isTotalCount} in progress`
              : null;
      return {
        origin,
        ...meta[origin],
        countText: countText || null,
        data: (() => {
          const base =
            origin === "classFocus"
              ? prioritizeFocusedUnit(sectionRows, focusLock)
              : sectionRows;
          return origin === "is" && base.length === 0
            ? ([{ kind: "quest-empty" }] satisfies SectionRow[])
            : groupPlateRows(base);
        })(),
      };
    })
      .filter((s): s is NonNullable<typeof s> => s !== null && s.data.length > 0);
  };
  // ONE motion model, both layers: the foreground's displacement `fgDy` is the
  // native rubber-band while free, and — once a pull commits — continues from
  // the held release point by `travel` px (commitShift 0→1) as the cards fade
  // into the sky. The background is ALWAYS `bgParallax × fgDy` (+ skyPeek), so
  // the depth ratio holds through the commit animation instead of the two
  // layers decoupling. The fgDy expression is INLINED in each worklet below —
  // a shared helper function in the component body gets memo-wrapped by React
  // Compiler and breaks Reanimated's workletization (the background silently
  // stops animating). Keep the two copies in sync.
  //
  // Foreground = the list itself. While free it moves at exactly the native
  // rubber-band velocity (no extra transform). After a commit the native
  // spring removes `pullShift` px, so add back (fgDy − pullShift) to keep the
  // cards on the fgDy path (no phantom bounce-back).
  const contentLayerStyle = useAnimatedStyle(() => {
    const fgDy = committed.get()
      ? commitHold.get() + commitShift.get() * tuning.travel.get()
      : pullShift.get(); // signed: + past the top, − scrolled into the list
    return {
      transform: [
        {
          translateY: committed.get()
            ? Math.max(0, fgDy - Math.max(0, pullShift.get()))
            : 0,
        },
      ],
      opacity: 1 - skyProgress.get() * tuning.contentFade.get(),
    };
  });
  // Background = earth/space trailing at `bgParallax`× fgDy — continuously
  // through dy=0 (scrolling into the list eases the horizon up). `skyPeek`
  // offsets it at rest (may be negative to tuck the horizon up).
  const earthStyle = useAnimatedStyle(() => {
    const fgDy = committed.get()
      ? commitHold.get() + commitShift.get() * tuning.travel.get()
      : pullShift.get();
    return {
      transform: [
        { translateY: tuning.skyPeek.get() + fgDy * tuning.bgParallax.get() },
      ],
    };
  });
  const starsStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, skyProgress.get() * 1.4 - 0.1),
  }));
  const hubStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, skyProgress.get() - 0.45),
    transform: [{ translateY: (1 - skyProgress.get()) * -24 }],
  }));
  // Rest-state hint on the Quests peek — fades out the instant the pull starts.
  const skyHintStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - skyProgress.get() * 4),
  }));
  const openSky = useCallback(() => {
    // Guard against a double-fire (endDrag + momentum both scheduling this).
    if (openedRef.current) return;
    // Sky reveal is Quests-tab + sky-map only (belt-and-suspenders with the
    // worklet commit gate below and the /sky route guard).
    if (!skyRevealActiveRef.current) return;
    openedRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/sky");
  }, [router]);
  // Dev-only calibration log — the iOS velocity sign/scale needs live checking
  // (I can't run the app); this prints the raw values so they can be dialed in.
  const logGesture = useCallback((overscrollPx: number, rawVelocityY: number) => {
    console.log("[sky-gesture]", { overscroll: overscrollPx, rawVelocityY });
  }, []);
  // Snap back to Earth whenever the home regains focus (returning from the sky),
  // and clear the commit/overscroll/open guards so the next pull starts fresh.
  useFocusEffect(
    useCallback(() => {
      openedRef.current = false;
      committed.set(false);
      // NOTE: pullShift is deliberately NOT reset here — it already holds the
      // list's real displacement (home can regain focus while scrolled
      // mid-list, e.g. returning from a session; zeroing it would snap the
      // horizon until the next scroll event).
      commitHold.set(0);
      commitShift.set(withTiming(0, { duration: 260 }));
      skyProgress.set(withTiming(0, { duration: 260 }));
    }, [committed, commitHold, commitShift, skyProgress]),
  );
  // Re-check the Prep Time window immediately on focus (don't wait for the tick).
  useFocusEffect(
    useCallback(() => {
      setNowMs(Date.now());
    }, []),
  );
  // Drive the sky from the list's native top-overscroll. iOS's rubber-band
  // already applies friction to finger→offset; `resistance` is an extra exponent
  // on top of that (default 1.0 = none). All thresholds are live tuning values.
  const skyScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const shift = -e.contentOffset.y; // signed: + past top, − into the list
      const os = Math.max(0, shift);
      pullShift.set(shift);
      if (committed.get()) return;
      const p = Math.min(
        1,
        Math.pow(os / tuning.overscrollDistance.get(), tuning.resistance.get()),
      );
      // Locked map (f6): no sky layers are rendered, so the pull must not fade
      // the cards toward a backdrop that isn't there (and no teaser haptic).
      skyProgress.set(mapUnlockedSV.get() ? p : 0);
      // Threshold haptic: once per drag, when progress first crosses the commit
      // line upward — a "you can release now" tick (replaces the removed text).
      if (
        mapUnlockedSV.get() &&
        tuning.commitHaptic.get() &&
        isDragging.get() &&
        !crossedThreshold.get() &&
        p >= tuning.commitProgress.get()
      ) {
        crossedThreshold.set(true);
        runOnJS(Haptics.selectionAsync)();
      }
      // Momentum commit (default off): a fling that coasts past the line commits
      // without a further drag. Gated on an unlocked map (f6).
      if (
        tuning.momentumCommit.get() &&
        mapUnlockedSV.get() &&
        !isDragging.get() &&
        p >= tuning.commitProgress.get()
      ) {
        committed.set(true);
        commitHold.set(os);
        skyProgress.set(withTiming(1, { duration: tuning.commitAnimMs.get() }));
        commitShift.set(withTiming(1, { duration: tuning.commitAnimMs.get() }));
        runOnJS(openSky)();
      }
    },
    onBeginDrag: () => {
      isDragging.set(true);
      crossedThreshold.set(false);
    },
    onEndDrag: (e) => {
      isDragging.set(false);
      const os = Math.max(0, -e.contentOffset.y);
      // iOS reports velocity.y in px/ms; normalize to px/s. Sign convention is
      // unverified (see logGesture), so gate on overscroll>30 (already past top →
      // any fast release there is a pull) and use the magnitude.
      const rawVelocityY = e.velocity?.y ?? 0;
      const pullVelocityPxPerSec = Math.abs(rawVelocityY) * 1000;
      if (__DEV__) runOnJS(logGesture)(os, rawVelocityY);
      if (committed.get()) return;
      if (
        mapUnlockedSV.get() &&
        (skyProgress.get() >= tuning.commitProgress.get() ||
          (os > 30 && pullVelocityPxPerSec >= tuning.commitVelocity.get()))
      ) {
        committed.set(true);
        commitHold.set(os);
        skyProgress.set(withTiming(1, { duration: tuning.commitAnimMs.get() }));
        commitShift.set(withTiming(1, { duration: tuning.commitAnimMs.get() }));
        runOnJS(openSky)();
      }
    },
    onMomentumEnd: (e) => {
      // The list has settled; sync to the actual offset (NOT a hard 0 — the
      // background tracks the signed displacement continuously).
      pullShift.set(-e.contentOffset.y);
    },
  });

  // The Home nav bar (experiment): the Now·All·subject tabs live in the
  // title (center), and the Active⇄Finished switch is a compact filter
  // button in the top-left. Tabs only exist in the Active view; the Finished
  // view shows a plain title instead.
  const header = (
    <Stack.Screen
      options={{
        headerTitleAlign: "center",
        headerLeft: () => (
          <SessionsTitleSwitcher
            variant="filter"
            view={view}
            onSelect={setView}
            activeCount={plate ? rows.length : null}
            archivedCount={archived?.length ?? null}
          />
        ),
        headerTitle: () =>
          view === "active" && tabs.length > 0 ? (
            <ScholarHomeTabs tabs={tabs} activeTab={effectiveActiveTab} onChange={setActiveTab} />
          ) : (
            <Text style={styles.headerTitleText}>
              {view === "archived" ? "Finished" : "My Sessions"}
            </Text>
          ),
      }}
    />
  );

  // Room Layer chrome — a dismissible strip per live message/transition, plus
  // the full-screen rest overlay (a Modal, so it renders fine above either
  // branch below). See convex/roomCues.ts + components' doc comments.
  const roomCueChrome = (
    <>
      {roomCues.message && (
        <RoomCueBanner cue={roomCues.message} onDismiss={roomCues.dismiss} />
      )}
      {roomCues.transition && (
        <RoomCueBanner cue={roomCues.transition} onDismiss={roomCues.dismiss} />
      )}
      {roomCues.rest && <RestOverlay returnAt={roomCues.rest.returnAt} />}
    </>
  );

  // mapGates gates the whole backdrop (horizon vs plain), so hold the spinner
  // until it resolves — otherwise an unlocked scholar flashes the locked plain
  // home for a beat on every launch before the horizon pops in.
  if (!isAuthenticated || plate === undefined || mapGates === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.violet} />
      </View>
    );
  }

  if (view === "archived") {
    return (
      <>
        {header}
        {roomCueChrome}
        {archived === undefined ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.violet} />
          </View>
        ) : (
          <ArchivedSessions
            rows={archived}
            refreshing={
              refreshOwner === "archived"
            }
            onRefresh={() => refreshHome("archived")}
          />
        )}
      </>
    );
  }

  const renderTabList = (tab: string) => {
    const isNowTab = tab === "now";
    const isQuestTab = tab === "quests";
    const isPrepTab = tab === "prep";
    const isMathTab = tab === "subject:math";
    const isAppsTab = tab === "apps";
    // ONE literal elevated Tree hero, passed by reference into the playlist's
    // loading boundary so the two real surfaces paint together in their final
    // order (caught-up/empty: hero first; actionable playlist: hero second).
    const mathTreeCardElevated = isMathTab && <MapHomeCard map="tree" slot="elevated" />;
    // Same pattern for the completion/growth reveal and the check-in
    // accelerator — both self-contained (own their Convex reads/gating), so
    // there's nothing to thread beyond mounting them (mirrors mathTreeCardElevated).
    const mathCompletionCardElevated = isMathTab && <MapCompletionCard />;
    const mathCheckInCardElevated = isMathTab && <CheckInHomeCard />;
    // Sky treatment (horizon backdrop + pull gesture + top peek padding) is
    // Quests-tab + unlocked-sky ONLY; a locked-sky Quests tab renders as a plain
    // list on the light surface, exactly like every other tab.
    const questSkyEnabled = isQuestTab && !!mapGates?.sky;
    const tabSections = buildSectionsFor(tab);
    const list = (
      <AnimatedSectionList
        style={styles.listFrame}
        contentInsetAdjustmentBehavior="automatic"
        onScroll={questSkyEnabled ? skyScroll : undefined}
        scrollEventThrottle={16}
        bounces={bounces}
        alwaysBounceVertical={true}
        refreshControl={
          questSkyEnabled || tab !== effectiveActiveTab ? undefined : (
            <RefreshControl
              accessibilityLabel="Refresh Home"
              refreshing={refreshOwner === tab}
              onRefresh={() => refreshHome(tab)}
              tintColor={colors.violet}
            />
          )
        }
        sections={tabSections}
        keyExtractor={sectionRowKey}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: 24 },
          // Shift the cards down on the Quests tab so the darkened sky
          // peek (with its resting stars) has room to breathe above them.
          questSkyEnabled && { paddingTop: 154 },
        ]}
        // The footer GROWS into whatever vertical slack is left so the
        // transparency line (its `marginTop: "auto"` child) can sit at the
        // bottom of the screen on short tabs. It is deliberately flexGrow, not
        // `marginTop: "auto"` on the whole footer: the Frontier card lives in
        // here too and is CONTENT — pushing it to the bottom of the viewport
        // tore it away from the cards it belongs under.
        ListFooterComponentStyle={styles.listFooter}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          // ONE gap stack. Every child below is either a self-gating card or a
          // `cond && <Card/>`, so an absent card contributes no gap. Do NOT
          // wrap these in per-card <View>s (see HOME_GAP).
          <View style={[styles.column, styles.stack]}>
            {/* Live pushes belong to today, so they ride at the top of the Now
                tab's own list rather than sitting in the chrome above the tab
                row. As chrome they hovered over Math, Quests and every other
                tab they had nothing to say about, and never scrolled away. */}
            {isNowTab ? <FocusStrip /> : null}
            {/* The map card, elevated (f6/f14/f21). ONE card per map, whose
                state picks its heading and tone: the once-ever unlock
                ("SOMETHING NEW"), or today's movement ("TODAY"). The standing
                Tree doorway is the same card's quiet state, down in the footer
                — the two positions are mutually exclusive by construction (see
                shared/mapHomeCard.ts), so the scholar never sees two.

                Reveal states surface ONLY on home (Andy's ruling, 2026-07-15)
                — never in-session. Each self-gates, so the moment DEFERS rather
                than burns until the scholar next lands home.

                The SKY's once-ever "Your Sky is ready" reveal card is RETIRED
                (P5, review/story-quest-rationalization-plan.html d4, Andy
                2026-08-12): the Quests tab's invitation family carries the
                "something new" moment — the first story/seed invitation IS the
                reveal. Sky access is unchanged (the pull-to-Sky gesture +
                horizon hint), and /sky still consumes revealPending on first
                arrival. Only the TREE renders a MapHomeCard now, on Math. */}
            {onboarding ? <OnboardingPinCard pin={onboarding} /> : null}
            {/* Fix D: Context strip renders independently of tabs.length.
                Tab row is still hidden when tabs.length === 0, but the
                context strip should not be suppressed just because there
                are no subject tabs. */}
            {/* No-school day banner (holiday / break / staff-development
                day): parity with the web scholar home. Suppresses the
                "Right now" strip (blocks come back empty on a closure). */}
            {closure ? (
              <View style={styles.noSchoolBanner}>
                <Text style={styles.noSchoolTitle}>No school today</Text>
                <Text style={styles.noSchoolLabel}>{closure.label}</Text>
              </View>
            ) : null}
            {/* The live block is a section HEADING over the work happening in
                it, never a floating line. On Now that work is the live-focus
                rows; on Math it is the playlist card, which owns the heading
                itself so the two gate together. Where the block has no work on
                this tab it simply doesn't render — a heading over nothing is
                the artifact we're removing. */}
            {/* Fix D: Now tab digest — live class focus hoisted to TOP
                (above planned ghost cards), matching the Q5 ladder in
                the spec §5.1 and web parity. Previously classFocus
                rendered in the SectionList body BELOW the header, which
                inverted the ladder. */}
            {isNowTab && isPrepTime && (
              <PrepEntryCard onOpen={() => setActiveTab("prep")} />
            )}
            {isNowTab && liveFocusRows.length > 0 && (
              <HomeSection
                label={blockContext?.label ?? "Right now"}
                detail={blockContext?.detail}
              >
                {liveFocusItems.map((item, index) => (
                  <PlateWorkItem
                    key={sectionRowKey(item, index)}
                    item={item}
                    focusLock={focusLock}
                    nowMs={nowMs}
                    timeZone={institutionTimeZone}
                  />
                ))}
              </HomeSection>
            )}
            {/* Now tab: planned ghost cards — upcoming only (startsAt ≥ nowMs,
                filtered by buildNowDigest). Invariant 1: no CTA. */}
            {isNowTab &&
              nowPlannedItems.map((entry) => (
                <PlannedTodayCard
                  key={`${entry.assignmentId}-${entry.activityId}`}
                  entry={{
                    activityTitle: entry.activityTitle,
                    unitTitle: entry.unitTitle ?? null,
                    unitEmoji: entry.unitEmoji ?? null,
                    subject: entry.subject ?? null,
                    startsAt: entry.startsAt,
                  }}
                  timeZone={plannedTimeZone}
                />
              ))}
            {/* The Tree's daily movement used to render here, as a second
                "TODAY" card pointing at the same map as the Frontier doorway
                two screens down. It is now a STATE of the one Tree card, on
                the Math tab where the map lives (Andy, 2026-07-26: the daily
                movement's canonical home is the Tree card). */}
            {/* The block heading is the card's, so the two gate together. With
                no live block the card keeps its own "Today's Math Playlists"
                title strip and takes no heading — claiming MATH WORKSHOP on a
                day with no workshop would be a lie. */}
            {/* Math cold-load boundary:
                PracticePlaylistCard owns the resolved Tree placement.
                Rather than report has-work through an effect and trigger a
                second parent commit, it receives the one elevated element.
                While any layout-affecting initial read remains unresolved,
                only the minimum playlist skeleton occupies this stack.
                Neither the real playlist nor the Tree hero paints yet.
                No already-painted hero is ever reordered.
                On resolve both paint together in their final order:
                caught-up playlists put the hero before the card;
                actionable playlists put the hero after the card.
                A legacy nothing-to-serve result removes the skeleton
                once the playlist query itself answers. */}
            {isMathTab && (
              <PracticePlaylistCard
                eyebrow={blockContext?.label}
                eyebrowDetail={blockContext?.detail}
                treeHero={mathTreeCardElevated}
                completionHero={mathCompletionCardElevated}
                checkInHero={mathCheckInCardElevated}
              />
            )}
            {isMathTab && <ScholarCalculatorLicenseCard />}
            {isPrepTab && (
              <>
                <TakeHomePlan
                  onOpenQuests={() => setActiveTab("quests")}
                  onTogglePin={async ({ itemId, unitId, sessionId }) => {
                    if (itemId) await removeTakeHomeItem({ itemId });
                    else if (unitId) await addTakeHomeSuggestion({ suggestion: { kind: "quest", unitId } });
                    else if (sessionId) await addTakeHomeSuggestion({ suggestion: { kind: "activity", sessionId } });
                  }}
                />
                <ComingUpCard />
                <PrepActivityCards />
              </>
            )}
            {isNowTab && takeHomePlanOwnsNow && (
              <TakeHomePlan
                mode="home"
                onTogglePin={async ({ itemId }) => {
                  if (itemId) await removeTakeHomeItem({ itemId });
                }}
              />
            )}
            {/* Coming up — read-only lookahead below tonight's list on the
                evening Home. Never null; renders a quiet empty line instead. */}
            {isNowTab && takeHomePlanOwnsNow && <ComingUpCard />}
            {isAppsTab && <AppLauncher />}
            {/* Now tab: homework rows in digest (below practice, above quiet
                note) — web §5.1 parity. Rendered only when not quiet (quiet
                state shows the full plate via sections). Two groups sharing the
                same orange pill: "Due today", then "Catch up" for past-due
                incomplete homework that was previously vanishing. */}
            {isNowTab && !isQuiet && homeworkDueTodayInNow.length > 0 && (
              <HomeSection label="Due today" tint={colors.orange}>
                {homeworkDueTodayInNow.map((row) => (
                  <HomeworkNowNativeRow
                    key={`${row.assignmentId ?? ""}::${row.activityId ?? ""}`}
                    row={row}
                    focusLock={focusLock}
                    nowMs={nowMs}
                    timeZone={institutionTimeZone}
                  />
                ))}
              </HomeSection>
            )}
            {isNowTab && !isQuiet && homeworkOverdueInNow.length > 0 && (
              <HomeSection label="Catch up" tint={colors.orange}>
                {homeworkOverdueInNow.map((row) => (
                  <HomeworkNowNativeRow
                    key={`${row.assignmentId ?? ""}::${row.activityId ?? ""}`}
                    row={row}
                    focusLock={focusLock}
                    nowMs={nowMs}
                    timeZone={institutionTimeZone}
                  />
                ))}
              </HomeSection>
            )}
            {isNowTab && !isQuiet && homeworkUpcomingInNow.length > 0 && (
              <HomeSection label="Homework" tint={colors.orange}>
                {homeworkUpcomingInNow.map((row) => (
                  <HomeworkNowNativeRow
                    key={`${row.assignmentId ?? ""}::${row.activityId ?? ""}`}
                    row={row}
                    focusLock={focusLock}
                    nowMs={nowMs}
                    timeZone={institutionTimeZone}
                  />
                ))}
              </HomeSection>
            )}
            {/* Quiet fallback (Now tab): no live focus + no planned + no visible
                homework. Two genuinely different states hide behind that one
                signal, so they get two different renderings (the web twin makes
                the same split in app/scholar/page.tsx):

                  - open work DOES render below → this is a HEADER over a real
                    list, so it uses the same HomeSectionHead every other
                    section on this tab uses. It was a dashed 13px pill, which
                    is a second rendering of a signal that already has one.
                  - nothing renders below → the tab is genuinely empty, so it
                    gets exactly ONE canonical full-surface empty state, with
                    the same "Start a Quest" way out the Quests tab offers
                    (native's empty states have been dead ends). */}
            {isNowTab && isQuiet && !takeHomePlanOwnsNow && (
              tabSections.length > 0 ? (
                <HomeSectionHead label="Open work" tint={colors.charcoalSubtle} />
              ) : (
                <EmptyState
                  size="lg"
                  icon={(size, color) => (
                    <SunHorizonIcon size={size} color={color} />
                  )}
                  title="Your day is clear"
                  hint={
                    hasQuestsWaiting
                      ? "Nothing is scheduled today. Your Quests are waiting whenever you want them."
                      : "Nothing is scheduled and nothing is open. Good time to start a Quest and follow something you're curious about."
                  }
                  cta={
                    hasQuestsWaiting
                      ? undefined
                      : {
                          label: "Start a Quest",
                          onPress: openCreateQuest,
                          primary: true,
                          disabled: newQuestLocked,
                        }
                  }
                />
              )
            )}
          </View>
        }
        ListEmptyComponent={
          isPrepTab || isMathTab || isAppsTab || isNowTab ? null : (
            <View style={[styles.column, { paddingTop: HOME_SECTION_GAP }]}>
              <Text style={styles.empty}>Nothing open right now.</Text>
            </View>
          )
        }
        renderSectionHeader={({ section }) => (
          <View style={[styles.column, { paddingTop: HOME_SECTION_GAP }]}>
            <HomeSectionHead
              label={section.heading}
              tint={section.tint}
              icon={
                section.origin === "classFocus" ? (
                  <TargetIcon size={20} color={section.tint} />
                ) : section.origin === "homework" ? (
                  <HouseIcon size={20} color={section.tint} />
                ) : undefined
              }
              trailing={
                section.countText || (section.origin === "is" && isQuestTab) ? (
                  <View style={styles.sectionActions}>
                    {section.countText ? (
                      <Text style={styles.sectionCount}>{section.countText}</Text>
                    ) : null}
                    {section.origin === "is" && isQuestTab ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Start a Quest"
                        disabled={newQuestLocked}
                        onPress={openCreateQuest}
                        style={({ pressed }) => [
                          styles.startQuestButton,
                          { borderColor: section.muted, backgroundColor: section.subtle },
                          pressed && !newQuestLocked && { backgroundColor: section.muted },
                          newQuestLocked && styles.lockedControl,
                        ]}
                      >
                        <Text style={[styles.startQuestText, { color: section.tint }]}>
                          + Start a Quest
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null
              }
            />
          </View>
        )}
        // A list cell has no shared parent to hang a `gap` on, so each cell
        // owns its LEADING gap: the first row of a section hugs its label,
        // every later row falls back to the card rhythm. (This replaces the
        // Item/SectionSeparatorComponent pair — RN renders the section
        // separator both above the first row AND below the last one, so the
        // single height that pair could express was necessarily wrong at one
        // of the two ends; it was 2pt under the last card.)
        renderItem={({ item, index }) => (
          <View
            style={[
              styles.column,
              { paddingTop: index === 0 ? HOME_LABEL_GAP : HOME_GAP },
            ]}
          >
            {"kind" in item ? (
              item.kind === "quest-empty" ? (
                <QuestEmptyCard
                  locked={newQuestLocked}
                  welcomeGate={welcomeGate && !focusLocked}
                  focusLabel={focusLock?.label ?? null}
                />
              ) : (
                <PlateWorkItem
                  item={item}
                  focusLock={focusLock}
                  nowMs={nowMs}
                  timeZone={institutionTimeZone}
                  pinning={isQuestTab ? readyTakeHomePinning : undefined}
                  onToggleQuestPin={isQuestTab ? toggleQuestPin : undefined}
                  pendingPinKeys={takeHomePinPendingKeys}
                />
              )
            ) : (
              <PlateWorkItem
                item={item}
                focusLock={focusLock}
                nowMs={nowMs}
                timeZone={institutionTimeZone}
                pinning={isQuestTab ? readyTakeHomePinning : undefined}
                onToggleQuestPin={isQuestTab ? toggleQuestPin : undefined}
                pendingPinKeys={takeHomePinPendingKeys}
              />
            )}
          </View>
        )}
        renderSectionFooter={({ section }) =>
          section.origin === "is" && !newQuestLocked && isQuestTab ? (
            // Three labeled sections, ALL of which can self-gate to nothing —
            // so this wrapper carries neither padding nor gap. Spacing that
            // lived here would be a phantom gap on the (common) day when all
            // three are empty. Each section owns its LEADING gap instead
            // (HOME_SECTION_GAP on its own root), which collapses with it.
            <View style={styles.column}>
              <SuggestedQuests
                pinning={readyTakeHomePinning}
                onStartSeedInPlan={(seedId) =>
                  runTakeHomePin(`seed:${seedId}`, () =>
                    startTakeHomeSeed({ seedId }),
                  )
                }
                onTogglePin={toggleQuestPin}
                onRemovePin={(itemId) =>
                  runTakeHomePin(`item:${itemId}`, () =>
                    removeTakeHomeItem({ itemId }),
                  )
                }
                pendingPinKeys={takeHomePinPendingKeys}
              />
              <StoryInvitations />
              <PeerTrails />
            </View>
          ) : null
        }
        ListFooterComponent={
          <View style={[styles.column, styles.stack, styles.footerStack]}>
            {/* Math tab: the Tree card's QUIET state — the standing doorway to
                the scholar's frontier. It renders only when the elevated slot
                above is empty (nothing new, nothing moved today), so the two
                can never both be on screen. */}
            {isMathTab && <MapHomeCard map="tree" slot="quiet" />}
            {/* Apps live on the dedicated "Apps" tab now — the footer
                keeps only the dev manipulative launcher (dev-only). */}
            <DevManipulativeLauncher />
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push("/how-it-works")}
              style={({ pressed }) => [
                styles.transparencyFooter,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.transparencyText}>
                {RELATIONAL_LINE} {OVERSIGHT_LINE}{" "}
                <Text style={styles.transparencyLink}>See how it works.</Text>
              </Text>
            </Pressable>
          </View>
        }
      />
    );
    if (questSkyEnabled) {
      return (
        <>
          <Animated.View style={[styles.skyLayer, starsStyle]} pointerEvents="none">
            <View style={styles.skyDot1} /><View style={styles.skyDot2} /><View style={styles.skyDot3} />
            <View style={styles.skyDot4} /><View style={styles.skyDot5} /><View style={styles.skyDot6} />
          </Animated.View>
          <Animated.View style={[styles.skyHub, hubStyle]} pointerEvents="none">
            <Text style={styles.skyHubLabel}>YOUR EXPLORATION SKY</Text>
            <Text style={styles.skyHubSub}>where your curiosities converge</Text>
          </Animated.View>
          <Animated.View
            // This backdrop stays mounted with the Quests tab (hidden, not
            // unmounted, when another tab is active), so switching tabs never
            // replays a fade-from-black — the horizon is revealed with the tab.
            style={[styles.earthLayer, earthStyle]}
            pointerEvents="none"
          >
            <Svg height={ATMO_R + SKY_EXTRA + 4} width={W}>
              <Defs>
                <RadialGradient id="atmo" cx="50%" cy={EARTH_CY + SKY_EXTRA} r={ATMO_R} gradientUnits="userSpaceOnUse">
                  {/* Compressed atmosphere: a thin bright horizon rim, then
                      space arrives fast. The resting Quests peek only ever
                      shows this near-horizon slice, so bringing the dark
                      navy/black down close to the surface makes the peek read
                      as sky-at-the-edge-of-space (a few stars sit on top of
                      it). Opening the Sky is then pure parallax of this same
                      backdrop — no cross-fade. */}
                  <Stop offset={EARTH_FRAC} stopColor="#dfe6f0" stopOpacity="1" />
                  <Stop offset={EARTH_FRAC + (1 - EARTH_FRAC) * 0.045} stopColor="#a6c4ea" stopOpacity="1" />
                  <Stop offset={EARTH_FRAC + (1 - EARTH_FRAC) * 0.1} stopColor="#4c6ca8" stopOpacity="1" />
                  <Stop offset={EARTH_FRAC + (1 - EARTH_FRAC) * 0.17} stopColor="#26365c" stopOpacity="1" />
                  <Stop offset={EARTH_FRAC + (1 - EARTH_FRAC) * 0.3} stopColor="#0e1626" stopOpacity="1" />
                  <Stop offset={EARTH_FRAC + (1 - EARTH_FRAC) * 0.52} stopColor={SPACE_BG} stopOpacity="1" />
                  <Stop offset="1" stopColor={SPACE_BG} stopOpacity="1" />
                </RadialGradient>
              </Defs>
              <Rect x="0" y="0" width={W} height={ATMO_R + SKY_EXTRA + 4} fill="url(#atmo)" />
              <Circle cx={W / 2} cy={EARTH_CY + SKY_EXTRA} r={EARTH_R} fill={colors.bgSubtle} />
            </Svg>
          </Animated.View>
          {/* A few stars resting on the darkened Quests peek — painted above
              the atmosphere shell but below the cards, so they sit only in
              the peek band. Steady opacity (no fade): the full skyLayer field
              behind the atmosphere takes over as the pull uncovers it, so the
              open is continuous parallax rather than a cross-fade. */}
          <View style={styles.peekStars} pointerEvents="none">
            <View style={styles.peekStar1} />
            <View style={styles.peekStar2} />
            <View style={styles.peekStar3} />
            <View style={styles.peekStar4} />
            <View style={styles.peekStar5} />
          </View>
          {/* Rest-state affordance for the pull-to-Sky gesture, centered on
              the peek. Fades out as the pull begins (skyHintStyle). */}
          <Animated.View style={[styles.skyHint, skyHintStyle]} pointerEvents="none">
            <Text style={styles.skyHintText}>Swipe down for Sky</Text>
          </Animated.View>

          <Animated.View style={[styles.contentLayer, contentLayerStyle]}>
            {list}
          </Animated.View>
        </>
      );
    }
    return list;
  };

  return (
    <>
      {header}
      {roomCueChrome}
      <View style={styles.homeRoot}>
        <PagerView
          ref={pagerRef}
          // The pager owns the page-surface colour because `overdrag` bounces
          // reveal the pager's OWN background past the first/last tab — against
          // the black homeRoot that read as a hole at the ends of the strip.
          style={[styles.tabFill, { backgroundColor: colors.bgSubtle }]}
          initialPage={activePageIndex}
          // Rubber-band at the first/last tab (iOS). Without it a swipe past
          // either end is dead on arrival, which reads as "the gesture broke"
          // rather than "there is nothing further" — the bounce IS the feedback.
          overdrag={true}
          onPageSelected={(e) => {
            const index = e.nativeEvent.position;
            currentPageRef.current = index;
            setActiveTab(homeTabKeyForIndex(pageKeys, index));
          }}
        >
          {pageKeys.map((tab, index) => {
            // A locked-sky Quests tab is a plain light surface; an unlocked-sky
            // one paints SPACE_BG so its horizon backdrop sits against space.
            // It used to be left transparent and let the black homeRoot show
            // through, but the pager's overdrag bounce reveals the pager's own
            // background at the ends — so the two jobs that one black surface
            // was doing had to be split: the pager carries the page surface
            // colour (what the bounce reveals) and the sky page carries space.
            const questSky = tab === "quests" && !!mapGates?.sky;
            // Lazy mount, widened by ONE page either side of the active one.
            // A visited tab renders its real list and STAYS mounted (the pager
            // keeps every page mounted) to keep its subscriptions warm; an
            // unvisited far-away tab renders a cheap placeholder so its
            // queries don't fire on first paint.
            //
            // The neighbours have to be mounted EAGERLY rather than on arrival:
            // `onPageSelected` fires only once a swipe has SETTLED, so gating
            // on it alone drags the scholar into a blank page and pops the
            // content in afterwards — the one thing a swipe affordance must
            // not do. Mounting ±1 keeps at most three tabs live and means the
            // page you are swiping toward is already painted before it is
            // revealed. Mounting mid-gesture off `onPageScroll` was the
            // alternative and is worse: it renders during the drag.
            const mounted =
              renderableTabs.includes(tab) ||
              Math.abs(index - activePageIndex) === 1;
            return (
              <View
                key={tab}
                style={[
                  styles.tabFill,
                  {
                    backgroundColor: questSky ? SPACE_BG : colors.bgSubtle,
                  },
                ]}
              >
                {mounted ? (
                  renderTabList(tab)
                ) : (
                  <View style={styles.tabFill} />
                )}
              </View>
            );
          })}
        </PagerView>
      </View>
      <CreateQuestDialog
        open={createQuestOpen}
        onClose={() => setCreateQuestOpen(false)}
        mode={effectiveActiveTab === "prep" ? "addToTonight" : "launch"}
      />
      <BirthdayConfetti active={isOwnBirthday} dayKey={institutionDayKey} />
    </>
  );
}

/**
 * DailyRecapSection — factual map movement stays in Now. Math practice and
 * check-in live in the dedicated Math tab.
 *
 * Retired: the card now owns its own TODAY eyebrow (`eyebrow` prop), so the
 * label and the card gate together instead of the card reporting presence back
 * up so a sibling label could gate on it. One child in the Home stack, one
 * gate, no empty wrapper left behind when there's no movement to report.
 */

function QuestEmptyCard({
  locked,
  welcomeGate = false,
  focusLabel,
}: {
  locked: boolean;
  welcomeGate?: boolean;
  focusLabel: string | null;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Boring empty state, matching the other tabs' muted line — the section
  // header's "+ Start a Quest" CTA is the affordance for a custom quest, so
  // this no longer needs its own pressable card.
  return (
    <Text style={styles.empty}>
      {locked
        ? welcomeGate
          ? "After you finish Welcome"
          : focusLabel
            ? `After you finish: ${focusLabel}`
            : "After you finish your class focus"
        : "No Quests yet."}
    </Text>
  );
}

// Quiet, always-first "Continue Welcome" pin for the self-paced onboarding
// quest — the later beats would otherwise sink under each day's fresh work.
// Stays first until the unit is complete. Never a lock.
function OnboardingPinCard({ pin }: { pin: OnboardingPin }) {
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const [starting, setStarting] = useState(false);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const started = pin.completedCount > 0 || pin.sessionId !== null;

  const open = async () => {
    if (starting) return;
    Haptics.selectionAsync();
    if (pin.sessionId) {
      router.push({
        pathname: "/session/[id]",
        params: { id: pin.sessionId, title: pin.nextBeatTitle },
      });
      return;
    }
    setStarting(true);
    try {
      const result = await createSession({
        activityId: pin.activityId,
        ...(pin.assignmentId ? { assignmentId: pin.assignmentId } : {}),
      });
      if (result?.id) {
        router.push({
          pathname: "/session/[id]",
          params: { id: result.id, title: pin.nextBeatTitle },
        });
      }
    } catch (e) {
      console.warn("[onboarding-pin] start failed", e);
    } finally {
      setStarting(false);
    }
  };

  return (
    <HomeSection label="Welcome">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Welcome — next: ${pin.nextBeatTitle}`}
        onPress={open}
        disabled={starting}
        style={({ pressed }) => [
          styles.onboardingPin,
          pressed && { opacity: 0.85 },
          starting && { opacity: 0.6 },
        ]}
      >
        <Text style={styles.onboardingEmoji}>{pin.emoji || "🧭"}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* The section heading already says WELCOME, so the card leads with
              the ACTIVITY the scholar is actually being sent to. */}
          <Text style={styles.onboardingTitle} numberOfLines={2}>
            {pin.nextBeatTitle}
          </Text>
          <Text style={styles.onboardingNext} numberOfLines={1}>
            {started ? "Pick up where you left off" : "Your first step"}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Text style={styles.onboardingCta}>{started ? "Continue" : "Start"} ›</Text>
          <Text style={styles.onboardingCount}>
            {pin.completedCount} of {pin.totalCount}
          </Text>
        </View>
      </Pressable>
    </HomeSection>
  );
}

// Shared open/start behavior for a plate row (a started session → open it; a
// not-started assigned activity → create the session then open; a web activity
// → launch the embedded webview). Used by both PlateCard and ChoiceOptionRow.
function useRowAction(row: PlateRow, focusLock: PlateFocusLock) {
  const router = useRouter();
  const convex = useConvex();
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const [starting, setStarting] = useState(false);
  const locked = isLockedByFocus(focusLock, row.unitId, row.origin);
  const isOfflineHomework =
    row.activityKind === "offline" && row.origin === "homework";

  const open = async () => {
    if (starting || locked) return;
    Haptics.selectionAsync();
    if (isOfflineHomework) {
      if (!row.activityId || !row.assignmentId) return;
      setStarting(true);
      try {
        const result = await openOfflineHomework({
          activityId: row.activityId,
          assignmentId: row.assignmentId,
        });
        router.push({
          pathname: "/session/[id]",
          params: { id: result.id, title: row.title },
        });
      } catch (e) {
        console.warn("[offline-homework] open failed", e);
        Alert.alert(
          "Couldn’t open that homework",
          "Check your connection and try again.",
        );
      } finally {
        setStarting(false);
      }
      return;
    }
    if (row.activityKind === "web" && row.activityId) {
      setStarting(true);
      try {
        const detail = await convex.query(api.activities.getPublic, {
          id: row.activityId,
        });
        const webUrl = detail?.webUrl;
        if (!webUrl) {
          Alert.alert(
            "No website yet",
            "Ask your teacher to add the website URL for this activity.",
          );
          return;
        }
        const urlError = webEmbedUrlError(webUrl);
        if (urlError) {
          Alert.alert("Couldn’t open this activity", urlError);
          return;
        }
        openWebActivity({
          activityId: row.activityId,
          ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
          title: detail?.title ?? row.title,
          url: webUrl,
          allowedHosts: detail?.webAllowedHosts ?? null,
          externalAppId: detail?.externalAppId ?? null,
          gestureMode: "page",
        });
      } catch (e) {
        console.warn("[plate-web] launch failed", e);
        Alert.alert(
          "Couldn’t open this activity",
          "Check your connection and try again.",
        );
      } finally {
        setStarting(false);
      }
      return;
    }
    // Games open in the root GameHost — no chat session, no webview. The host
    // resolves the game and its frozen config itself.
    if (row.activityKind === "game" && row.activityId) {
      openGameActivity({
        activityId: row.activityId,
        ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
        activityTitle: row.title,
      });
      return;
    }
    if (row.activityKind === "problem_set" && row.practiceSkillKey) {
      router.push({
        pathname: "/practice",
        params: { skill: row.practiceSkillKey },
      });
      return;
    }
    if (row.sessionId) {
      router.push({
        pathname: "/session/[id]",
        params: { id: row.sessionId, title: row.title },
      });
      return;
    }
    // Not-started assigned activity: create the session, then open it.
    if (!row.activityId) return;
    setStarting(true);
    try {
      const result = await createSession({
        activityId: row.activityId,
        ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
      });
      if (result?.id) {
        router.push({
          pathname: "/session/[id]",
          params: { id: result.id, title: row.title },
        });
      }
    } catch (e) {
      console.warn("[start] failed", e);
      Alert.alert(
        "Couldn't start that activity",
        "Please try again.",
      );
    } finally {
      setStarting(false);
    }
  };

  return { open, starting, locked, isOfflineHomework };
}

// ── Homework row for the Now tab's homework digest ────────────────────────
// Serves BOTH the "Due today" and "Catch up" groups — a small orange due pill
// in the title block carries the distinguishing phrase ("due today" / "was due
// yesterday") via dueStatus().phrase, while the right-hand CTA is the standard
// violet "Start ›" / "Continue ›" link (Andy, fix round 2: pill and CTA are
// separate, not one coalesced chip; identical structure/copy to web).
// Fix B native: fully start/continue capable via useRowAction — handles web
// activities, existing sessions (open), and not-yet-started activities (create
// then open). Homework is always exempt from the focus lock.
function HomeworkNowNativeRow({
  row,
  focusLock,
  nowMs,
  timeZone,
}: {
  row: PlateRow;
  focusLock: PlateFocusLock;
  nowMs: number;
  timeZone: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { open, starting, locked, isOfflineHomework } = useRowAction(
    row,
    focusLock,
  );
  const actionable = !locked && !starting;

  return (
    <Pressable
      onPress={actionable ? open : undefined}
      accessibilityRole="button"
      accessibilityLabel={row.title}
      accessibilityState={{ disabled: !actionable }}
      style={({ pressed }) => [
        styles.hwDueTodayCard,
        pressed && actionable && styles.cardPressed,
        locked && styles.cardLocked,
        starting && { opacity: 0.7 },
      ]}
    >
      <View style={styles.hwDueTodayLeft}>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={{ gap: 3 }}>
            <View style={styles.hwDueTodayTitleRow}>
              {row.unitEmoji ? (
                <Text style={styles.hwDueTodayEmoji}>{row.unitEmoji}</Text>
              ) : null}
              <Text style={styles.hwDueTodayTitle} numberOfLines={2}>
                {row.title}
              </Text>
            </View>
            {row.unitTitle ? (
              <Text style={styles.hwDueTodayMeta} numberOfLines={1}>
                {row.unitTitle}
              </Text>
            ) : null}
          </View>
          {isOfflineHomework && row.description ? (
            <Text style={styles.cardContext} numberOfLines={2}>
              {row.description}
            </Text>
          ) : null}
          {/* The due phrase stays its OWN token, never coalesced into the CTA
              (Andy, fix round 2) — but it is the SHARED chip now, not a local
              orange badge. Catch up rows are already late or due tonight, so
              DueChip derives the loud tone without being told. */}
          <View style={styles.dueChipWrap}>
            <DueChip dueAt={row.dueAt} nowMs={nowMs} timeZone={timeZone} />
          </View>
        </View>
      </View>
      {/* Standard violet CTA (matches PlateActivityRow's styles.open), never
          the orange chip. "Opening…" replaces the label while starting. */}
      <View style={styles.ctaWrap}>
        <Text style={styles.open}>
          {starting
            ? "Opening…"
            : isOfflineHomework
              ? "Open ›"
              : row.sessionId
              ? "Continue ›"
              : "Start ›"}
        </Text>
      </View>
    </Pressable>
  );
}

function PlateUnitBand({
  row,
  showProgress = true,
  raisedAction,
}: {
  row: PlateRow;
  showProgress?: boolean;
  raisedAction?: React.ReactNode;
}) {
  const router = useRouter();
  const colors = useColors();
  const section = sectionMeta(colors)[row.origin];

  const openUnitProgress = () => {
    if (!row.unitId) return;
    Haptics.selectionAsync();
    router.push({
      pathname: "/unit-progress" as never,
      params: {
        unitId: row.unitId,
        title: row.unitTitle ?? "Unit progress",
        ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
      },
    });
  };

  return (
    <UnitBand
      emoji={row.unitEmoji}
      title={row.unitTitle}
      teacherName={row.teacherName}
      subtle={section.subtle}
      muted={section.muted}
      tint={section.tint}
      progress={
        showProgress
          ? {
              completedCount: row.unitCompletedCount ?? null,
              activityCount: row.unitActivityCount ?? null,
            }
          : undefined
      }
      onPress={openUnitProgress}
      accessibilityLabel={`Where you are in ${row.unitTitle ?? "this unit"}`}
      raisedAction={raisedAction}
    />
  );
}

function plateQuestPinAction({
  row,
  pinning,
  onToggleQuestPin,
  pendingPinKeys,
}: {
  row: PlateRow;
  pinning?: TakeHomePinning;
  onToggleQuestPin?: (unitId: Id<"units">) => void | Promise<void>;
  pendingPinKeys?: ReadonlySet<string>;
}) {
  const unitId = row.unitId;
  if (!pinning?.dayKey || row.origin !== "is" || !unitId || !onToggleQuestPin) {
    return null;
  }
  const existing = pinning.pins.find(
    (pin) => String(pin.unitId) === String(unitId),
  );
  return (
    <TakeHomePinButton
      selected={!!existing}
      subject={row.unitTitle ?? "Quest"}
      busy={pendingPinKeys?.has(`unit:${unitId}`)}
      onToggle={() => onToggleQuestPin(unitId)}
    />
  );
}

function PlateWorkItem({
  item,
  focusLock,
  nowMs,
  timeZone,
  pinning,
  onToggleQuestPin,
  pendingPinKeys,
}: {
  item: SectionRow;
  focusLock: PlateFocusLock;
  nowMs: number;
  timeZone: string;
  pinning?: TakeHomePinning;
  onToggleQuestPin?: (unitId: Id<"units">) => void | Promise<void>;
  pendingPinKeys?: ReadonlySet<string>;
}) {
  if ("kind" in item) {
    if (item.kind === "choice-group") {
      return (
        <ChoiceMenuCard
          group={item}
          focusLock={focusLock}
          pinning={pinning}
          onToggleQuestPin={onToggleQuestPin}
          pendingPinKeys={pendingPinKeys}
        />
      );
    }
    if (item.kind === "unit-group") {
      return (
        <UnitActivityGroup
          group={item}
          focusLock={focusLock}
          nowMs={nowMs}
          timeZone={timeZone}
          pinning={pinning}
          onToggleQuestPin={onToggleQuestPin}
          pendingPinKeys={pendingPinKeys}
        />
      );
    }
    return null;
  }
  return (
    <PlateCard
      row={item}
      focusLock={focusLock}
      nowMs={nowMs}
      timeZone={timeZone}
      pinning={pinning}
      onToggleQuestPin={onToggleQuestPin}
      pendingPinKeys={pendingPinKeys}
    />
  );
}

function UnitActivityGroup({
  group,
  focusLock,
  nowMs,
  timeZone,
  pinning,
  onToggleQuestPin,
  pendingPinKeys,
}: {
  group: UnitActivityGroupRow;
  focusLock: PlateFocusLock;
  nowMs: number;
  timeZone: string;
  pinning?: TakeHomePinning;
  onToggleQuestPin?: (unitId: Id<"units">) => void | Promise<void>;
  pendingPinKeys?: ReadonlySet<string>;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const first = group.rows[0];
  if (!first) return null;

  return (
    <View style={styles.card}>
      <View style={styles.cardSurface}>
        <PlateUnitBand
          row={first}
        />
        {group.rows.map((row, index) => (
          <PlateActivityRow
            key={String(row.sessionId ?? row.activityId ?? index)}
            row={row}
            focusLock={focusLock}
            hasUnitStrip
            showDivider={index > 0}
            nowMs={nowMs}
            timeZone={timeZone}
            raisedAction={
              index === 0
                ? plateQuestPinAction({
                    row: first,
                    pinning,
                    onToggleQuestPin,
                    pendingPinKeys,
                  })
                : null
            }
          />
        ))}
      </View>
    </View>
  );
}

function PlateCard({
  row,
  focusLock,
  nowMs,
  timeZone,
  pinning,
  onToggleQuestPin,
  pendingPinKeys,
}: {
  row: PlateRow;
  focusLock: PlateFocusLock;
  nowMs: number;
  timeZone: string;
  pinning?: TakeHomePinning;
  onToggleQuestPin?: (unitId: Id<"units">) => void | Promise<void>;
  pendingPinKeys?: ReadonlySet<string>;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const hasUnitStrip = !!row.unitId;

  return (
    <View style={styles.card}>
      <View style={styles.cardSurface}>
        {hasUnitStrip ? (
          <PlateUnitBand
            row={row}
          />
        ) : null}
        <PlateActivityRow
          row={row}
          focusLock={focusLock}
          hasUnitStrip={hasUnitStrip}
          nowMs={nowMs}
          timeZone={timeZone}
          raisedAction={plateQuestPinAction({
            row,
            pinning,
            onToggleQuestPin,
            pendingPinKeys,
          })}
        />
      </View>
    </View>
  );
}

function PlateActivityRow({
  row,
  focusLock,
  hasUnitStrip,
  showDivider = false,
  nowMs,
  timeZone,
  raisedAction,
}: {
  row: PlateRow;
  focusLock: PlateFocusLock;
  hasUnitStrip: boolean;
  showDivider?: boolean;
  nowMs: number;
  timeZone: string;
  raisedAction?: React.ReactNode;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { open, starting, locked, isOfflineHomework } = useRowAction(
    row,
    focusLock,
  );
  const progress =
    row.unitCompletedCount != null && row.unitActivityCount != null
      ? `${row.unitCompletedCount} of ${row.unitActivityCount}`
      : null;
  const metaParts = hasUnitStrip
    ? []
    : ([row.unitTitle, progress].filter(Boolean) as string[]);
  const context = row.description ?? row.lastMessagePreview ?? null;
  const eta = row.etaMinutes ? `~${row.etaMinutes} min` : null;
  const subParts = [
    !hasUnitStrip && row.teacherName ? `with ${row.teacherName}` : null,
    eta,
  ].filter(Boolean) as string[];
  const lockMeta = focusLock?.label
    ? `After you finish: ${focusLock.label}`
    : "After you finish your class focus";

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

  // Secondary overdue read on All / subject cards (web parity, ScholarPlate):
  // a small orange "was due X" line on past-due homework. Derived from Home's
  // ticking nowMs (30s) + the institution tz, so it acquires/updates across
  // institution midnight while mounted.
  const dueInfo =
    row.origin === "homework" ? dueStatus(row.dueAt, nowMs, timeZone) : null;
  // The plate is a BROWSE surface: it deliberately shows a deadline only once
  // it is late, because a chip on every homework row would be deadline noise on
  // a screen about choosing work. The SELECTION is the plate's; the rendering
  // is the shared one (review/scholar-activity-row-rationalization.html §4).
  const isOverdue = dueInfo?.status === "overdue";

  return (
    <View
      style={[
        styles.cardBody,
        showDivider && styles.choiceRowDivider,
        locked && styles.cardLocked,
      ]}
    >
      <Pressable
        onPress={open}
        disabled={locked || starting}
        accessibilityRole="button"
        accessibilityLabel={row.title}
        accessibilityState={{ disabled: locked || starting }}
        style={({ pressed }) => [
          styles.cardBodyMain,
          !raisedAction && styles.cardBodyMainWithoutAction,
          pressed && !locked && styles.cardPressed,
        ]}
      >
      <View style={styles.cardLeft}>
        <View style={styles.titleRow}>
          {!hasUnitStrip && row.unitEmoji ? (
            <Text style={styles.emoji}>{row.unitEmoji}</Text>
          ) : null}
          <Text style={styles.cardTitle} numberOfLines={2}>
            {row.title}
          </Text>
        </View>
        {metaParts.length > 0 && (
          <Text style={styles.cardMeta} numberOfLines={1}>
            {metaParts.join(" · ")}
          </Text>
        )}
        {context && (
          <Text style={styles.cardContext} numberOfLines={2}>
            {context}
          </Text>
        )}
        {locked ? (
          <Text style={styles.cardSub} numberOfLines={1}>
            {lockMeta}
          </Text>
        ) : roomTurnLine ? (
          <Text style={styles.cardSubRoomTurn} numberOfLines={1}>
            {roomTurnLine}
          </Text>
        ) : subParts.length > 0 && (
          <Text style={styles.cardSub} numberOfLines={1}>
            {subParts.join(" · ")}
          </Text>
        )}
        {isOverdue ? (
          <View style={styles.dueChipWrap}>
            <DueChip dueAt={row.dueAt} nowMs={nowMs} timeZone={timeZone} />
          </View>
        ) : null}
      </View>
      <View style={styles.ctaWrap}>
        {starting ? (
          <ActivityIndicator color={colors.violet} />
        ) : (
          <Text style={styles.open}>
            {locked
              ? "Locked"
              : isOfflineHomework
                ? "Open ›"
                : row.activityKind === "web" || row.activityKind === "game"
                  ? "Open ›"
                  : row.isContinuation || !row.notStarted
                    ? "Continue ›"
                    : "Start ›"}
          </Text>
        )}
      </View>
      </Pressable>
      {raisedAction ? (
        <View style={styles.cardRaisedAction}>{raisedAction}</View>
      ) : null}
    </View>
  );
}

// A choice lesson: a unit band + a violet "Choose N of these" strip, then each
// option as a tappable row. Mirrors the web ChoiceMenuCard (scholar parity).
function ChoiceMenuCard({
  group,
  focusLock,
  pinning,
  onToggleQuestPin,
  pendingPinKeys,
}: {
  group: ChoiceGroupRow;
  focusLock: PlateFocusLock;
  pinning?: TakeHomePinning;
  onToggleQuestPin?: (unitId: Id<"units">) => void | Promise<void>;
  pendingPinKeys?: ReadonlySet<string>;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const options = group.options;
  const first = options[0];
  if (!first) return null;
  const pickCount = first?.choicePickCount ?? 1;
  const pickedCount = first?.choicePickedCount ?? 0;
  const optionCount = first?.choiceOptionCount ?? options.length;
  const instruction =
    pickCount > 1
      ? `Choose ${pickCount} of these ${optionCount}`
      : `Choose one of these ${optionCount}`;
  const hasUnit = !!first.unitId;

  return (
    <View style={styles.card}>
      <View style={styles.cardSurface}>
        {hasUnit && (
          <PlateUnitBand
            row={first}
            showProgress={false}
            raisedAction={plateQuestPinAction({
              row: first,
              pinning,
              onToggleQuestPin,
              pendingPinKeys,
            })}
          />
        )}
        <View style={styles.choiceStrip}>
          <Text style={styles.choiceStripLabel}>◈ {instruction}</Text>
          {pickCount > 1 && pickedCount > 0 && (
            <Text style={styles.choiceStripCount}>
              picked {pickedCount}/{pickCount}
            </Text>
          )}
        </View>
        {options.map((opt, i) => (
          <ChoiceOptionRow
            key={String(opt.activityId ?? opt.sessionId ?? i)}
            row={opt}
            focusLock={focusLock}
            showDivider={i > 0}
          />
        ))}
      </View>
    </View>
  );
}

function ChoiceOptionRow({
  row,
  focusLock,
  showDivider,
}: {
  row: PlateRow;
  focusLock: PlateFocusLock;
  showDivider: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { open, starting, locked, isOfflineHomework } = useRowAction(
    row,
    focusLock,
  );
  const eta = row.etaMinutes ? `~${row.etaMinutes} min` : null;
  const context = isOfflineHomework
    ? row.description ?? null
    : row.lastMessagePreview ?? null;

  return (
    <Pressable
      onPress={open}
      disabled={locked || starting}
      accessibilityRole="button"
      accessibilityLabel={row.title}
      accessibilityState={{ disabled: locked || starting }}
      style={({ pressed }) => [
        styles.cardBody,
        showDivider && styles.choiceRowDivider,
        pressed && !locked && styles.cardPressed,
        locked && styles.cardLocked,
      ]}
    >
      <View style={styles.cardLeft}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {row.title}
        </Text>
        {eta && (
          <Text style={styles.cardSub} numberOfLines={1}>
            {eta}
          </Text>
        )}
        {context ? (
          <Text style={styles.cardContext} numberOfLines={2}>
            {context}
          </Text>
        ) : null}
      </View>
      <View style={styles.ctaWrap}>
        {starting ? (
          <ActivityIndicator color={colors.violet} />
        ) : (
          <Text style={styles.open}>
            {locked
              ? "Locked"
              : isOfflineHomework
                ? "Open ›"
                : row.activityKind === "web" || row.activityKind === "game"
                  ? "Open ›"
                  : row.isContinuation || !row.notStarted
                    ? "Continue ›"
                    : "Start ›"}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.bgSubtle,
  },
  homeRoot: {
    flex: 1,
    backgroundColor: SPACE_BG,
    overflow: "hidden",
  },
  skyLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  earthLayer: { position: "absolute", top: -900, left: 0, right: 0 },
  skyDot1: { position: "absolute", top: 70, left: 48, width: 3, height: 3, borderRadius: 2, backgroundColor: "#cfd6ff", opacity: 0.8 },
  skyDot2: { position: "absolute", top: 150, right: 70, width: 4, height: 4, borderRadius: 2, backgroundColor: "#a98bff", opacity: 0.7 },
  skyDot3: { position: "absolute", top: 280, left: 120, width: 2, height: 2, borderRadius: 1, backgroundColor: "#cfd6ff", opacity: 0.5 },
  skyDot4: { position: "absolute", bottom: 220, right: 130, width: 3, height: 3, borderRadius: 2, backgroundColor: "#cfd6ff", opacity: 0.6 },
  skyDot5: { position: "absolute", bottom: 120, left: 60, width: 5, height: 5, borderRadius: 3, backgroundColor: "#a98bff", opacity: 0.5 },
  skyDot6: { position: "absolute", top: 360, right: 160, width: 2, height: 2, borderRadius: 1, backgroundColor: "#cfd6ff", opacity: 0.6 },
  peekStars: { position: "absolute", top: 0, left: 0, right: 0, height: 132 },
  peekStar1: { position: "absolute", top: 24, left: 70, width: 3, height: 3, borderRadius: 2, backgroundColor: "#e8ecff", opacity: 0.95 },
  peekStar2: { position: "absolute", top: 46, right: 110, width: 2, height: 2, borderRadius: 1, backgroundColor: "#cfd6ff", opacity: 0.8 },
  peekStar3: { position: "absolute", top: 70, left: 168, width: 2, height: 2, borderRadius: 1, backgroundColor: "#a98bff", opacity: 0.85 },
  peekStar4: { position: "absolute", top: 90, right: 200, width: 3, height: 3, borderRadius: 2, backgroundColor: "#cfd6ff", opacity: 0.7 },
  peekStar5: { position: "absolute", top: 38, left: 300, width: 2, height: 2, borderRadius: 1, backgroundColor: "#cfd6ff", opacity: 0.7 },
  skyHint: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", paddingTop: 22 },
  skyHintText: {
    color: "#eaf0ff",
    fontFamily: fonts.medium,
    fontSize: 13.5,
    letterSpacing: 0.4,
    opacity: 0.9,
  },
  skyHub: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 110,
  },
  skyHubLabel: { color: "#a98bff", fontFamily: fonts.bold, fontSize: 12.5, letterSpacing: 1.6 },
  skyHubSub: { color: "#cfd6ff", fontFamily: fonts.regular, fontSize: 15, marginTop: 6 },
  contentLayer: {
    flex: 1,
    marginTop: 0,
    backgroundColor: "transparent",
    overflow: "hidden",
  },
  listFrame: {
    flex: 1,
    width: "100%",
  },
  listContent: {
    width: "100%",
    flexGrow: 1,
    paddingTop: 32,
    paddingBottom: 20,
  },
  listFooter: {
    // Absorb the leftover viewport height (see the prop's comment) so the
    // transparency line's own `marginTop: "auto"` can pin it to the bottom
    // without dragging the Frontier card down with it.
    flexGrow: 1,
  },
  // Stretches to fill the grown footer cell, which is what gives the
  // transparency line's `marginTop: "auto"` some slack to absorb.
  footerStack: { paddingTop: HOME_GAP, flexGrow: 1 },
  // The reading-width column every Home block sits in. Horizontal only — all
  // vertical spacing is a `gap` on the stack (or a cell's paddingTop).
  column: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: 24,
  },
  stack: { gap: HOME_GAP },
  // Fills a pager page (and the cheap placeholder for an unvisited tab). The
  // pager keeps every page mounted, so a visited tab's list — and its Convex
  // subscriptions — stay warm across swipes without re-fetching or re-mounting.
  tabFill: { flex: 1 },
  empty: {
    textAlign: "center",
    color: c.fgMuted,
    fontSize: 17,
    lineHeight: 25,
    fontFamily: fonts.regular,
    paddingHorizontal: 12,
  },
  transparencyFooter: {
    width: "100%",
    // Pinned to the bottom of the viewport when the tab is short (the footer
    // cell grows into the slack); collapses to the plain HOME_GAP when the
    // content is tall enough to scroll.
    marginTop: "auto",
    paddingHorizontal: 8,
    paddingVertical: 18,
  },
  transparencyText: {
    color: c.charcoalSubtle,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: fonts.regular,
    textAlign: "center",
  },
  transparencyLink: {
    color: c.charcoalMuted,
    fontFamily: fonts.semibold,
    textDecorationLine: "underline",
  },
  startQuestButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  lockedControl: {
    opacity: 0.45,
  },
  startQuestText: {
    fontSize: 13.5,
    fontFamily: fonts.bold,
  },
  onboardingPin: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bg,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  onboardingEmoji: { fontSize: 26, width: 32, textAlign: "center" },
  onboardingTitle: { color: c.navy, fontSize: 16.5, fontFamily: fonts.bold },
  onboardingNext: {
    color: c.charcoalMuted,
    fontSize: 14.5,
    fontFamily: fonts.regular,
    marginTop: 2,
  },
  onboardingCta: { color: c.violet, fontSize: 15, fontFamily: fonts.semibold },
  onboardingCount: {
    color: c.charcoalSubtle,
    fontSize: 12,
    fontFamily: fonts.regular,
  },
  card: {
    borderRadius: 18,
    shadowColor: palette.navy[900],
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
  },
  cardSurface: {
    backgroundColor: c.bg,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
  },
  choiceStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    backgroundColor: c.violetSubtle,
  },
  choiceStripLabel: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: c.violetSolid,
    letterSpacing: 0.2,
  },
  choiceStripCount: {
    fontSize: 12.5,
    fontFamily: fonts.medium,
    color: c.violet,
  },
  choiceRowDivider: {
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  cardBody: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.bg,
  },
  cardBodyMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingVertical: 20,
    paddingLeft: 22,
    paddingRight: 12,
  },
  cardBodyMainWithoutAction: { paddingRight: 22 },
  cardRaisedAction: { flexShrink: 0, marginRight: 22 },
  cardPressed: { backgroundColor: c.gray50 },
  cardLocked: { opacity: 0.58 },
  cardLeft: { flex: 1, minWidth: 0, gap: 7 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  emoji: { fontSize: 26 },
  cardTitle: {
    flex: 1,
    fontSize: 19,
    fontFamily: fonts.semibold,
    color: c.navy,
  },
  cardMeta: { fontSize: 14.5, fontFamily: fonts.semibold, color: c.fgMuted },
  cardContext: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
  },
  cardSub: { fontSize: 13.5, fontFamily: fonts.regular, color: c.charcoalSubtle },
  // "The turn, not the bell" — a calm violet tint, distinct from the
  // ordinary charcoal metadata line (never red, never urgent).
  cardSubRoomTurn: { fontSize: 13.5, fontFamily: fonts.regular, color: c.violet },
  // Overdue homework subline (web parity) — the same orange as the due pill,
  // never red. A nudge, not a hazard.
  sectionActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  sectionCount: { fontSize: 13, fontFamily: fonts.medium, color: c.charcoalMuted },
  ctaWrap: { minWidth: 60, alignItems: "flex-end" },
  open: { fontSize: 16, fontFamily: fonts.semibold, color: c.violet },
  // ── Due-today homework rows (Now tab digest) ──────────────────────────
  hwDueTodayCard: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.gray200,
    backgroundColor: c.bg,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  hwDueTodayLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
  },
  hwDueTodayTitleRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
  },
  hwDueTodayEmoji: { fontSize: 18 },
  hwDueTodayTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.semibold,
    color: c.navy,
  },
  hwDueTodayMeta: {
    fontSize: 13,
    fontFamily: fonts.medium,
    color: c.charcoalMuted,
  },
  // The one wrapper the shared DueChip needs on native: RN stretches a child
  // to the cross axis, so without this the pill would span the whole row.
  dueChipWrap: { alignSelf: "flex-start" as const },
  // ── Tab row chrome ──────────────────────────────────────────────────
  headerTitleText: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    color: c.navy,
  },
  noSchoolBanner: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bg,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  noSchoolTitle: {
    fontSize: 15,
    fontFamily: fonts.bold,
    color: c.navy,
  },
  noSchoolLabel: {
    fontSize: 13,
    fontFamily: fonts.medium,
    color: c.charcoalMuted,
    marginTop: 2,
  },
  // ── Quests trace (subject/other tabs) ─────────────────────────────────
  });
}
