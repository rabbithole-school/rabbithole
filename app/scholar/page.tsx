"use client";

import { Fragment, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { useCachedQuery } from "@/hooks/useCachedQuery";
import { useSignOut } from "@/hooks/useSignOut";
import { RemoteLink } from "@/components/RemoteLink";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useLearnerContext } from "@/hooks/useLearnerContext";
import { isTeacherRole } from "@/convex/lib/roles";
import { teacherHomePath } from "@/lib/teacherHome";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";
import { useScholarFont } from "@/hooks/useScholarFont";
import { useRemote } from "@/hooks/useRemote";
import { useMapGates } from "@/hooks/useMapGates";
import {
  Box,
  Flex,
  HStack,
  Text,
} from "@chakra-ui/react";
import { AppLogo } from "@/components/AppLogo";
import { MapHomeCard } from "@/components/MapHomeCard";
import { AppHeader } from "@/components/AppHeader";
import { AccountMenu } from "@/components/AccountMenu";
import { UnitPickerDialog } from "@/components/UnitPickerDialog";
import { UnitProgressDialog } from "@/components/UnitProgressDialog";
import { toaster } from "@/lib/toaster";
import { ProfileEditModal } from "@/components/ProfileEditModal";
import { SetPasswordDialog } from "@/components/SetPasswordDialog";
import {
  CaretDown,
  CaretRight,
  Eye,
  MapTrifold,
  SunHorizon,
} from "@phosphor-icons/react";
import { Stack, Heading } from "@chakra-ui/react";
import {
  ScholarPlate,
  ScholarPlateActivityGroup,
  ScholarPlateActivityRow,
  OnboardingPin,
  type ActiveSession,
} from "@/components/ScholarPlate";
import {
  isLockedByFocus,
  pickLockingFocus,
  prioritizeFocusedUnit,
  type PlateFocusLock,
} from "@/lib/focusLock";
import { PlaylistCard, type PlaylistData, type ChoiceCard } from "@/components/practice/PlaylistCard";
import { CheckInHomeCard } from "@/components/practice/CheckInHomeCard";
import { MapCompletionCard } from "@/components/practice/MapCompletionCard";
import { ScholarCalculatorLicenseCard } from "@/components/practice/ScholarCalculatorLicenseCard";
import { hasActionablePlaylist } from "@/shared/playlistDoneness";
import { DailyRecapCard } from "@/components/DailyRecapCard";
import type { DailyRecap } from "@/convex/lib/dailyRecap";
import type { ExploreSeedOptions } from "@/lib/bakePaths";
import { useExploreSeed } from "@/hooks/useExploreSeed";
import { useJoinFocus } from "@/hooks/useJoinFocus";
import { useActiveRoomCues } from "@/hooks/useActiveRoomCues";
import { RoomCueBanner } from "@/components/RoomCueBanner";
import { FocusStrip } from "@/components/FocusStrip";
import { RestOverlay } from "@/components/RestOverlay";
import { WebAssignmentDoneDialog } from "@/components/WebAssignmentDoneDialog";
import { GameCapabilityNotice } from "@/components/GameCapabilityNotice";
import { AppLauncher } from "@/components/AppLauncher";
import {
  PrepActivityCards,
  PrepEntryCard,
} from "@/components/ScholarPrepCards";
import { TakeHomePlanCard } from "@/components/TakeHomePlanCard";
import { takeHomePlanOwnsNow as takeHomePlanOwnsHomeworkInNow } from "@/components/takeHomePlanPlacement";
import { ScholarHomeSkeleton } from "@/components/skeletons/PanelSkeletons";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { useKeepWorking } from "@/hooks/useKeepWorking";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useInstitutionDay, } from "@/hooks/useInstitutionDay";
import { dueStatus } from "@/shared/institutionDay";
import { DueChip } from "@/components/ui/DueChip";
import { OVERSIGHT_LINE, RELATIONAL_LINE } from "@/shared/admonishments";
import { ScholarHomeTabs } from "@/components/ScholarHomeTabs";
import { PlannedTodayCard } from "@/components/PlannedTodayCard";
import { ComingUpCard } from "@/components/ComingUpCard";
import { shouldShowProfileSetup } from "@/lib/profileSetup";
import {
  buildNowDigest,
  deriveHomeTabs,
  filterHomeworkForNow,
  filterRowsForTab,
  groupHomeRowsByUnit,
  isWithinScheduleWindow,
  pickCurrentBlock,
  shouldShowHomeworkInNow,
  type ScholarHomeTab,
} from "@/shared/scholarHomeNow";
import { isWithinPrepWindow } from "@/convex/lib/metaBlocks";
import {
  ActivityCard,
  ActivityCardCta,
  ActivityCardMeta,
  ActivityCardTitle,
} from "@/components/ui/ActivityCard";
import {
  UnitGroupBand,
  UnitGroupCard,
  UnitGroupRow,
} from "@/components/ui/UnitGroupCard";
import {
  classFocusPlateLine,
  formatRoomTurnTime,
} from "@/shared/roomTurn";
import { useRoomTurnPhase } from "@/hooks/useRoomTurnPhase";

export function findPendingHighlightChoice(
  highlightDomain: string | null,
  consumedHighlightDomain: string | null,
  choiceCards: ChoiceCard[],
): ChoiceCard | null {
  if (!highlightDomain || consumedHighlightDomain === highlightDomain) return null;
  return choiceCards.find((card) => card.domain === highlightDomain) ?? null;
}

/**
 * /scholar — Home view with project cards.
 * If ?remote=userId is set, shows that scholar's projects (teacher remote mode).
 */
export default function ScholarPage() {
  return (
    <Suspense fallback={<ScholarHomeSkeleton />}>
      <ScholarHome />
    </Suspense>
  );
}

function ScholarHome() {
  const { user, isLoading: isUserLoading } = useCurrentUser();
  const [signOut] = useSignOut();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { stamp } = useRemote();
  const { hasLearnerContext, isLearnerContextLoading } =
    useLearnerContext(!!user);

  const remoteUserId = searchParams.get("remote");
  const isRemoteMode = !!(remoteUserId && user && isTeacherRole(user.role));
  const isTestMode =
    isRemoteMode ||
    !!(user && isTeacherRole(user.role) && !hasLearnerContext);

  // Room Layer — a teacher's live cue for THIS scholar's own screens. Scoped
  // to a genuine scholar session: never subscribed for a teacher remote-view
  // or self-preview (isTestMode covers both — see convex/roomCues.ts).
  const roomCues = useActiveRoomCues(!!user && !isTestMode);

  // Remote scholar lookup is owned by AccountMenu now — it reads
  // `?remote=` directly. No need to duplicate the query here.

  // Boot-path queries ride the perceived-speed cache: a cold launch renders
  // the last-known list instantly, then live data replaces it. Remote mode
  // (teacher viewing a scholar) stays uncached — it's not this device's data.
  const sessions = useCachedQuery(
    api.sessions.list,
    user
      ? isRemoteMode
        ? { userId: remoteUserId as Id<"users"> }
        : { asLearner: !isTestMode }
      : "skip",
    isRemoteMode
      ? null
      : `projects.${user?._id ?? "anon"}.${isTestMode ? "staff" : "learner"}`,
  );

  const units =
    useCachedQuery(
      api.units.list,
      user ? { asLearner: !isTestMode && !isRemoteMode } : "skip",
      `units.${user?._id ?? "anon"}.${isTestMode || isRemoteMode ? "staff" : "learner"}`,
    ) ?? [];
  // Legacy listMyScholarScoped query removed — one-off IS tasks are
  // now first-class IS Units (units.authorScholarId). MyIndependentStudies
  // renders them.
  const currentFocus = useQuery(
    api.assignments.currentClassFocusForMe,
    user ? { asLearner: !isTestMode } : "skip",
  );
  // currentFocus is now an array of per-activity classFocus pushes.
  // For the lock UI, take the first SOLO-STARTABLE one as the headline focus:
  // a focus the scholar can't complete on their own (e.g. a card-sort done
  // together in class) must NOT drive the read-only lock (policy b, PR #707).
  const firstFocus = pickLockingFocus(currentFocus);
  const focusLock = !isTestMode && firstFocus
    ? {
        unitId: firstFocus.unitId ? String(firstFocus.unitId) : null,
        lessonId: firstFocus.lessonId ? String(firstFocus.lessonId) : null,
        lessonTitle: firstFocus.lessonTitle ?? null,
        // Most-specific name of what the class is on right now — used by the
        // Home's quiet lock treatment ("After you finish: <label>").
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

  // Plate-query at page level powers ONLY the ClassFocusPin suppression
  // logic — ScholarPlate itself owns its own query (with its own
  // show-archived state). classFocus rows are returned in full
  // regardless of isLimit, so this stable view works for the
  // suppression check.
  // The same query also drives the teacher remote view: when isRemoteMode,
  // we pass the remote scholar's userId through. ScholarPlate handles the
  // remote case identically — the data shape is the same.
  const plateScope = isRemoteMode && remoteUserId
    ? {
        userId: remoteUserId as Id<"users">,
        includeWebActivities: true,
      }
    : {};
  const plateResult = useQuery(
    api.scholarPlate.activeForMe,
    user ? plateScope : "skip",
  );
  const archivedSessions = useQuery(
    api.sessions.finishedForScholar,
    user && !isRemoteMode ? { asLearner: !isTestMode } : "skip",
  );

  // ── Above-the-fold practice queries, lifted to the page so the home renders
  //    in ONE step (no per-card pop-in). `standing` frames the Playlist card;
  //    `playlist` is its data (the card is presentational); `launcherApps`
  //    determines whether the dedicated Apps tab is available.
  const remoteScholarId =
    isRemoteMode && remoteUserId ? (remoteUserId as Id<"users">) : undefined;
  const serverDay = useQuery(
    api.institutions.currentDayForScholar,
    user ? (remoteScholarId ? { scholarId: remoteScholarId } : {}) : "skip",
  );
  const institutionDay = useInstitutionDay(serverDay);
  const standing = useQuery(
    api.standingPractice.myActiveStanding,
    user ? (remoteScholarId ? { scholarId: remoteScholarId } : {}) : "skip",
  );
  const mathPlan = useQuery(
    api.mathPlans.myPlan,
    user ? (remoteScholarId ? { scholarId: remoteScholarId } : {}) : "skip",
  );
  // An explicit Math plan supersedes every legacy standing-practice field.
  // Keep the plan loading boundary intact so Home cannot briefly preview a
  // superseded standing pin before the authoritative source arrives.
  const hasExplicitMathPlan = mathPlan?.scopeSource === "math_plan";
  const effectiveStanding = hasExplicitMathPlan ? null : standing;
  // Registered practice domains + this scholar's per-domain progress — feeds
  // BOTH the "new territory" tiles below and the effective-domain resolution
  // (the straggler fix, f7): a teacher's `standing` pin always wins, but with
  // no pin (auto-blend) the playlist's domain must be a domain the scholar has
  // actually STARTED, never a hardcoded default — otherwise a scholar who
  // deep-linked into (and placed) a non-default domain sees a home card
  // permanently stuck on a domain they never touched. Not in the render gate:
  // the home shouldn't block on it, and the affordance can appear a beat later
  // without any layout jump.
  const domainsInfo = useQuery(
    api.practiceSkills.domainsForScholar,
    user ? { scholarId: remoteScholarId ?? user._id } : "skip",
  );
  const autoBlend = mathPlan !== undefined && effectiveStanding === null;
  const startedDomains = (domainsInfo ?? []).filter((d) => d.started).map((d) => d.domain);
  const anyDomainStarted = startedDomains.length > 0;
  const planDomains =
    hasExplicitMathPlan && mathPlan.practiceScope.kind === "limited"
      ? mathPlan.practiceScope.domains.map((entry) => entry.domain)
      : startedDomains;
  // The map derivation's own honest state (finish-the-check-in decision 6):
  // home reads the SAME `mapProgressForScholar` read-surface CheckInHomeCard
  // renders from — one derivation, one source of truth (T7/T11). It replaces
  // the stale `mixedPlacementCurrent` governor readout home used to poll: that
  // query's `paused` flag is the standalone 30-probes/day SITTING budget, which
  // no longer governs the Option-D serving path (the `· mapping` band rides the
  // ordinary playlist), so reading it here reported a governor that had stopped
  // governing. Same args as CheckInHomeCard's own query, so convex/react shares
  // ONE subscription. Autoblend-only: a teacher pin has no cross-domain
  // check-in concept.
  const mapProgress = useQuery(
    api.practiceSkills.mapProgressForScholar,
    user && autoBlend ? { scholarId: remoteScholarId ?? user._id } : "skip",
  );
  // The TOP STRAGGLER fix: show the chooser once ANY domain has placed, or the
  // check-in is otherwise underway — never gated on the FULL cross-domain
  // check-in completing. The derivation's `started` (any domain in flight or
  // converged) subsumes the old sitting-budget `paused` leg with fresher
  // semantics: a sitting can only pause after probes were answered, so a paused
  // sitting is always a started check-in (decision 6). A teacher pin
  // (`!autoBlend`) never gates on this at all (its own single-domain
  // `playlist.needsPlacement` below is the only gate).
  const forceChooser = autoBlend && (anyDomainStarted || !!mapProgress?.started);
  // The CTA's Start-vs-Resume verb, from the same derivation (decision 6) —
  // `started` is true once any domain is in flight or converged, so a scholar
  // who left the check-in mid-flight is never told to "Start" it again.
  const checkInStarted = autoBlend && !!mapProgress?.started;
  // Session-only domain switch (math-skills plan §8): the header chip's switcher
  // drawer re-scopes the playlist/choice queries to another ACTIVE focus domain
  // for THIS session only — never persisted, so next login returns to primary by
  // construction. `null` = the scholar's primary (server default). Only ever set
  // in focus-mode serving (the chip is a plain label otherwise).
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const playlist = useQuery(
    api.practiceSkills.playlistForScholar,
    // Wait for the authoritative plan so a legacy pin cannot briefly drive the
    // preview before an explicit plan suppresses it.
    user &&
    mathPlan !== undefined &&
    (hasExplicitMathPlan || standing !== undefined) &&
    institutionDay
      ? {
          ...(remoteScholarId ? { scholarId: remoteScholarId } : {}),
          ...(selectedDomain
            ? { domain: selectedDomain }
            : effectiveStanding?.domain
              ? { domain: effectiveStanding.domain }
              : planDomains[0]
                ? { domain: planDomains[0] }
                : {}),
          dayKey: institutionDay.dayKey,
          // Option D (Q6): the default (auto-blend) Start folds the `· mapping`
          // band, so the base preview must too (matching serve). A teacher's
          // single-domain pin serves without mapping, so it stays ordinary.
          ...(effectiveStanding ? {} : { includeMapping: true }),
        }
      : "skip",
  );
  const launcherApps = useQuery(
    api.scholarApps.listForLauncher,
    user ? (remoteScholarId ? { scholarId: remoteScholarId } : {}) : "skip",
  );
  // Up to 3 bounded frontier "You pick" cards — feeds PlaylistCard's optional
  // choice moment. `choiceSetForSelf` always reads the AUTHENTICATED scholar
  // (no scholarId arg), so it's skipped entirely in teacher remote-view mode —
  // there the query would resolve to the viewing teacher, not the scholar being
  // viewed. Not in the render gate: purely additive, can pop in a beat later.
  const choiceSet = useQuery(
    api.practiceSkills.choiceSetForSelf,
    user && !remoteScholarId
      ? { ...(selectedDomain ? { domains: [selectedDomain] } : {}) }
      : "skip",
  );
  // "New territory" tiles — the fold-in of the old standalone "Explore a new
  // territory" pills (raise-the-ceiling consolidation, f7): one peer tile per
  // NOT-yet-started domain not already represented in `choiceSet`, tagged
  // `isNew` so the tile row can mark it with a subtle accent. Same
  // authenticated-scholar-only scoping as `choiceSet`.
  const newTerritoryCards = useQuery(
    api.practiceSkills.newTerritoryCards,
    user && !remoteScholarId
      ? {
          excludeDomains: (choiceSet ?? []).map((c) => c.domain),
          ...(selectedDomain ? { currentDomain: selectedDomain } : {}),
        }
      : "skip",
  );
  // Memoized so its identity only changes when the underlying card data does —
  // the `highlightDomain` effect depends on its CONTENTS, so a fresh array every
  // render would make that effect run every render.
  const allChoiceCards: ChoiceCard[] = useMemo(
    () => [
      ...(choiceSet ?? []),
      ...(newTerritoryCards ?? []).map((c) => ({ ...c, isNew: true })),
    ],
    [choiceSet, newTerritoryCards],
  );
  // The controlled "You Pick" tile selection (select-and-recompose, raise-the-
  // ceiling §C-2 follow-up) — `null` means "Today's blend" (the default set)
  // is active. Owned here (not inside PlaylistCard) so the second query below
  // can fire on selection; resets to the blend whenever the choice set itself
  // changes shape (e.g. the scholar advances and the frontier cards rotate) so
  // a stale selection never lingers on a card that's no longer offered.
  //
  // DERIVED, not clamped. The stored pick is only ever *honoured* while the set
  // still offers it, so a rotation can never leave an orphan selected. The
  // effect this replaces watched `allChoiceCards.length`, so a rotation that
  // kept the same length (the common case — the scholar advances and a card's
  // frontier skill changes) never re-ran it and the stale pick stayed
  // highlighted indefinitely, with the preview and Start both aimed at a strand
  // no longer on offer.
  const [storedChoice, setStoredChoice] = useState<ChoiceCard | null>(null);
  const selectedChoice =
    storedChoice &&
    allChoiceCards.some((c) => c.domain === storedChoice.domain && c.strand === storedChoice.strand)
      ? storedChoice
      : null;
  // `?highlightDomain=` — the reusable "land on the chooser with a tile
  // preselected" redirect target (f7's fold #2/#3 substrate): a summit
  // hand-off or any future "new frontier" moment links here instead of
  // straight into practice. Preselects the matching tile once it's available;
  // a no-match (typo, or the domain already fully caught up and absent from
  // both card lists) is a quiet no-op — never an error state.
  const highlightDomain = searchParams.get("highlightDomain");
  // Apply the deep-link highlight AT MOST ONCE per `highlightDomain` value.
  // The dep is the card set's CONTENTS (not its `.length`), so a later rotation
  // that swaps the requested card in while keeping N cards still fires a match —
  // the old `.length` proxy silently missed that and stranded the scholar on
  // "Today's blend". The ref makes it fire-once: after the first successful
  // preselect we stop, so a rotation that happens AFTER the scholar has tapped a
  // different tile never re-selects the highlighted domain and stomps their
  // choice. A still-absent domain keeps waiting until it appears, unless the
  // scholar explicitly chooses a strand, domain, or Stretch first.
  const consumedHighlightRef = useRef<string | null>(null);
  useEffect(() => {
    const match = findPendingHighlightChoice(
      highlightDomain,
      consumedHighlightRef.current,
      allChoiceCards,
    );
    if (match) {
      consumedHighlightRef.current = highlightDomain;
      setStoredChoice(match);
    }
  }, [highlightDomain, allChoiceCards]);
  const disarmPendingHighlight = useCallback(() => {
    if (highlightDomain) consumedHighlightRef.current = highlightDomain;
  }, [highlightDomain]);
  const handleSelectChoice = useCallback((choice: ChoiceCard | null) => {
    disarmPendingHighlight();
    setStoredChoice(choice);
  }, [disarmPendingHighlight]);
  // The RECOMPOSED preview for the selected strand — the SAME playlistForScholar
  // query, just scoped to the SELECTED card's own domain (never the home's
  // default effective domain — a cross-domain or "new territory" pick would
  // otherwise have its choiceHint silently dropped, since practiceSession's own
  // `choiceHint.domain === domain` gate requires an exact match), with
  // `choiceHint` set so it reuses the identical composition path (no forked
  // scheduling logic) and is a byte-faithful stand-in for what Start will
  // actually serve. Skipped entirely when nothing is selected (the blend
  // already IS `playlist` above, no second query needed).
  const choicePreview = useQuery(
    api.practiceSkills.playlistForScholar,
    user && institutionDay && selectedChoice
      ? {
          ...(remoteScholarId ? { scholarId: remoteScholarId } : {}),
          domain: selectedChoice.domain,
          dayKey: institutionDay.dayKey,
          choiceHint: { domain: selectedChoice.domain, strand: selectedChoice.strand },
          // Option D (Q6): the You-Pick Start folds mapping for an unmapped
          // domain, so this preview must recompose to the SAME `· mapping`
          // composition — never ordinary root/frontier rows Start won't serve.
          includeMapping: true,
        }
      : "skip",
  );
  // The Stretch tile selection — true when the scholar has tapped the Stretch
  // tile (the standing, scholar-chosen home for the challenge lane). Owned here
  // (not inside PlaylistCard) so the `stretchPreview` query fires on selection,
  // exactly mirroring how `selectedChoice` drives `choicePreview`. Mutually
  // exclusive with `selectedChoice` (handled inside PlaylistCard's tile tap
  // handler — selecting a strand tile clears stretch, and vice-versa).
  const [stretchSelected, setStretchSelected] = useState(false);
  const handleSelectStretch = useCallback((selected: boolean) => {
    disarmPendingHighlight();
    setStretchSelected(selected);
  }, [disarmPendingHighlight]);
  // Session-only domain switch handler (plan §8): re-scope to another active
  // focus domain, clearing any strand/stretch selection so a stale pick from the
  // previous domain never lingers (the choice cards refetch for the new domain).
  const handleSelectDomain = useCallback((domain: string) => {
    disarmPendingHighlight();
    setSelectedDomain(domain);
    setStoredChoice(null);
    setStretchSelected(false);
  }, [disarmPendingHighlight]);
  // The RECOMPOSED preview for the stretch tile — `playlistForScholar` with
  // `stretchHint: true` returns the challenge-tail items as the `set`, so the
  // scholar sees what the stretch round actually contains. Skipped when nothing
  // is selected (the blend already is `playlist`). Uses the SAME resolved
  // domain as the base playlist (challenge items are always single-domain).
  const effectiveDomainForStretch =
    playlist?.domain ??
    (effectiveStanding?.domain || planDomains[0]);
  const stretchPreview = useQuery(
    api.practiceSkills.playlistForScholar,
    user && institutionDay && stretchSelected && effectiveDomainForStretch
      ? {
          ...(remoteScholarId ? { scholarId: remoteScholarId } : {}),
          domain: effectiveDomainForStretch,
          dayKey: institutionDay.dayKey,
          stretchHint: true,
        }
      : "skip",
  );

  // Daily map-movement receipt — the institution's calendar owns "today"; the
  // day key refreshes the subscription at school-local midnight.
  const recapScholarId = remoteScholarId ?? user?._id;
  const recap = useQuery(
    api.dailyRecap.forScholar,
    user && recapScholarId && institutionDay
      ? { scholarId: recapScholarId, dayKey: institutionDay.dayKey }
      : "skip",
  );
  // The Home CTA (Surface 1) is autoBlend-only, mirroring `mixedCurrent`
  // above — a teacher-pinned scholar has no cross-domain check-in concept at
  // all (pinning IS the single-domain override), so there is nothing to
  // accelerate. `undefined` skips CheckInHomeCard's own query entirely.
  const checkInScholarId = autoBlend ? recapScholarId : undefined;


  // ── Tab state for Now · All · subjects · Prep · Quests ────────────────
  // Defaults to "now"; Prep activity back-links can restore the Prep tab.
  // Remote/teacher view always shows all rows (no tabs).
  const [activeTab, setActiveTab] = useState(() =>
    searchParams.get("tab") === "prep" ? "prep" : "now",
  );
  // 30s tick — powers the context strip's current-block line and the Now
  // digest's isQuiet determination.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Bell-schedule context: TODAY's blocks for this scholar's groups, used to
  // derive the "Right now: <block>" context strip above the tab row.
  // Scholar-only (invariant 3: no teacher/remote view). dayKey is the
  // cache-buster; server uses its own authoritative day.
  const blockResult = useQuery(
    api.masterSchedule.currentBlockForSelf,
    user && !isTestMode && institutionDay
      ? { dayKey: institutionDay.dayKey }
      : "skip",
  );
  const prepBlock = useQuery(
    api.metaChat.myPrepTimeBlock,
    user && !isTestMode ? {} : "skip",
  );

  // TODAY's planned entries (setAt=null, startsAt today) — the "up next
  // today" rail in the Now tab. Scholar-only (invariant 1: non-startable).
  // includeWebActivities: true so web-activity planned entries appear (parity
  // with native which already passes this flag).
  const plannedTodayResult = useQuery(
    api.assignments.todayScheduleForSelf,
    user && !isTestMode && institutionDay
      ? { dayKey: institutionDay.dayKey, includeWebActivities: true }
      : "skip",
  );

  // Derive the current bell-schedule block from the server data + 30s tick.
  const currentBlock =
    blockResult && blockResult.blocks.length > 0
      ? pickCurrentBlock(blockResult.blocks, nowMs, blockResult.timeZone)
      : null;
  const isWithinSchoolHours = blockResult
    ? isWithinScheduleWindow(blockResult.blocks, nowMs, blockResult.timeZone)
    : false;
  const isPrepTime =
    currentBlock?.kind === "prep" ||
    (prepBlock ? isWithinPrepWindow(prepBlock, nowMs) : false);

  // Derive the tab set from the plate's subject tabs + the current rows.
  // Remote/teacher view gets no tabs (the server-side plate data drives them).
  const tabs: ScholarHomeTab[] =
    !isRemoteMode && plateResult
      ? deriveHomeTabs({
          subjectTabs: plateResult.subjectTabs,
          rows: plateResult.rows,
          hasApps: (launcherApps?.length ?? 0) > 0,
        }).tabs
      : [];

  // Fix C: if the current tab disappears from the derived set (last row
  // completed, subject renamed, Other collapsing), fall back to "now" so the
  // scholar is never left on an empty filter. Derived for THIS render rather
  // than repaired by an effect — an effect runs after the paint, so it showed
  // the blank filter it exists to prevent. Matches native's `effectiveActiveTab`
  // (`native/src/app/index.tsx`), which web had never been given.
  const effectiveActiveTab =
    tabs.length > 0 && !tabs.some((t) => t.key === activeTab) ? "now" : activeTab;

  // nowDataLoaded: true once both the currentFocus and plannedTodayResult
  // queries have resolved. Used by ScholarSections to prevent a premature
  // clear-day empty state flashing while data is still loading.
  const nowDataLoaded =
    currentFocus !== undefined &&
    plannedTodayResult !== undefined &&
    blockResult !== undefined &&
    prepBlock !== undefined;

  const createSession = useMutation(api.sessions.create);
  const startUnit = useMutation(api.sessions.startUnit);

  // Seed-tap → begin-quest flow (shared with /scholar/map).
  const { exploreSeed, exploringSeedId, exploreSeedDialog } = useExploreSeed();


  // Unit picker dialog state (still used by the "current focus" fallback that
  // opens a unit browser when no specific activity is targeted).
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pickerInitialUnitId, setPickerInitialUnitId] = useState<string | null>(null);
  // Focused "where am I in this unit" dialog — opened from a unit group
  // card's progress meter on the plate.
  const [progressTarget, setProgressTarget] = useState<{
    unitId: Id<"units">;
    assignmentId?: Id<"assignments">;
  } | null>(null);
  // Starting an Independent-Study / Custom-Quest card launches DIRECTLY into the
  // unit's first online activity (matching how a teacher-suggested star opens
  // via createFromSeed) — no "pick an activity" picker detour. A unit with no
  // online activities spawns an ad-libbed session, exactly as before.
  const startUnitAndGo = useCallback(
    async (unitId: Id<"units">) => {
      try {
        const result = await startUnit({
          unitId,
          ...(isRemoteMode && remoteUserId
            ? { userId: remoteUserId as Id<"users"> }
            : {}),
        });
        if (result) router.push(stamp(`/scholar/${result.id}`));
      } catch (error) {
        console.error("Error starting unit:", error);
        toaster.error({
          title: "Couldn't start that quest",
          description: "Please try again.",
        });
      }
    },
    [startUnit, router, stamp, isRemoteMode, remoteUserId],
  );
  const [isCreating, setIsCreating] = useState(false);
  const [finishedOpen, setFinishedOpen] = useState(false);

  const impersonation = useQuery(api.impersonation.myImpersonation, {});
  const isImpersonating =
    impersonation === undefined ? undefined : impersonation !== null;
  const needsSetup = shouldShowProfileSetup(user, isImpersonating);

  // Auth redirects
  useEffect(() => {
    if (isUserLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (
      isTeacherRole(user.role) &&
      !remoteUserId &&
      !isLearnerContextLoading &&
      !hasLearnerContext
    ) {
      router.replace(teacherHomePath(user.role));
      return;
    }
  }, [
    user,
    isUserLoading,
    router,
    remoteUserId,
    hasLearnerContext,
    isLearnerContextLoading,
  ]);

  const handleUnitSelected = useCallback(async (sel: {
    unitId: string | null;
    lessonId: string | null;
    activityId: string | null;
    assignmentId?: string | null;
  }) => {
    setIsCreating(true);
    const createArgs: Record<string, unknown> = {};
    if (isRemoteMode && remoteUserId) {
      createArgs.userId = remoteUserId as Id<"users">;
    }
    if (sel.unitId) {
      createArgs.unitId = sel.unitId as Id<"units">;
    }
    if (sel.lessonId) {
      createArgs.lessonId = sel.lessonId as Id<"lessons">;
    }
    if (sel.activityId) {
      createArgs.activityId = sel.activityId as Id<"activities">;
    }
    // If the scholar's active class-focus Assignment matches the
    // picked unit, stamp it on the project — that's the cohort the
    // work belongs to (drives Submissions / ShareBack / completion
    // scoping). Otherwise leave assignmentId undefined: this is a
    // free-form project.
    // If any of the scholar's active class-focus pushes target the
    // picked unit, stamp that Assignment on the project.
    if (sel.assignmentId) {
      createArgs.assignmentId = sel.assignmentId as Id<"assignments">;
    } else if (sel.unitId && currentFocus) {
      const matching = currentFocus.find(
        (f) => f.unitId && String(f.unitId) === sel.unitId,
      );
      if (matching) createArgs.assignmentId = matching.assignmentId;
    }
    try {
      const result = await createSession(createArgs as Parameters<typeof createSession>[0]);
      if (result) {
        router.push(stamp(`/scholar/${result.id}`));
      }
    } catch (error) {
      console.error("Error creating session:", error);
      toaster.error({ title: "Failed to create session", description: "Please try again." });
    } finally {
      setIsCreating(false);
      setDialogOpen(false);
    }
  }, [createSession, router, remoteUserId, isRemoteMode, stamp, currentFocus]);

  // Quest handlers removed in the kill-quests refactor.


  useScholarFont(user?.preferredFont as "andika" | "opendyslexic" | undefined, isRemoteMode);

  // Hold the page on a spinner until the structural above-the-fold queries
  // resolve, so homework + unit rows do not pop in one at a time. The playlist
  // is intentionally excluded: while it loads (or when absent), the Math tab
  // keeps its default Tree-first composition instead of blocking the whole Home.
  // Less-critical queries (completedQuests, archivedSessions) also lazy-fill.
  if (
    isUserLoading ||
    isLearnerContextLoading ||
    !user ||
    sessions === undefined ||
    plateResult === undefined ||
    standing === undefined ||
    launcherApps === undefined ||
    recap === undefined
  ) {
    return <ScholarHomeSkeleton />;
  }

  return (
    <Flex h={VIEWPORT_SHELL_HEIGHT} bg="gray.50" flexDir="column">
      <TopBar
        onSignOut={signOut}
      />
      {/* Room Layer — a live teacher cue for this scholar's own screens.
          Message/transition render as a dismissible strip right under the
          top bar; rest replaces the whole Home with a calm full-screen
          overlay (see components/RestOverlay.tsx) rather than hiding it —
          the underlying Home is untouched underneath, just covered. */}
      {roomCues.message && (
        <RoomCueBanner cue={roomCues.message} onDismiss={roomCues.dismiss} />
      )}
      {roomCues.transition && (
        <RoomCueBanner cue={roomCues.transition} onDismiss={roomCues.dismiss} />
      )}
      {roomCues.rest && <RestOverlay returnAt={roomCues.rest.returnAt} />}
      <Box flex={1} overflowY="auto" pb={16} display="flex" flexDir="column">
        <Box maxW="680px" mx="auto" px={{ base: 4, md: 6 }} pt={6} flexShrink={0}>
          <ScholarSections
            plateRows={plateResult?.rows ?? []}
            activeSessions={sessions}
            onboardingPin={plateResult?.onboarding ?? null}
            archivedSessions={archivedSessions}
            currentFocus={currentFocus}
            focusLock={focusLock}
            playlist={playlist}
            mathPlan={mathPlan}
            standing={standing}
            startedDomains={startedDomains}
            choiceSet={allChoiceCards}
            forceChooser={forceChooser}
            checkInStarted={checkInStarted}
            selectedChoice={selectedChoice}
            onSelectChoice={handleSelectChoice}
            choicePreview={choicePreview}
            stretchSelected={stretchSelected}
            onSelectStretch={handleSelectStretch}
            stretchPreview={stretchPreview}
            onSelectDomain={handleSelectDomain}
            selectedDomain={selectedDomain}
            recap={recap}
            checkInScholarId={checkInScholarId}
            exploringSeedId={exploringSeedId}
            handleExploreSeed={exploreSeed}
            setDialogOpen={setDialogOpen}
            onOpenUnit={startUnitAndGo}
            onOpenUnitProgress={(unitId, assignmentId) =>
              setProgressTarget({ unitId, assignmentId })
            }
            finishedOpen={finishedOpen}
            setFinishedOpen={setFinishedOpen}
            isRemoteMode={isRemoteMode}
            isStaffPreview={isTestMode}
            remoteUserId={remoteUserId}
            tabs={tabs}
            activeTab={effectiveActiveTab}
            onTabChange={setActiveTab}
            currentBlock={currentBlock}
            isWithinSchoolHours={isWithinSchoolHours}
            closure={blockResult?.closure ?? null}
            isPrepTime={isPrepTime}
            plannedToday={plannedTodayResult?.entries ?? []}
            plannedTimeZone={plannedTodayResult?.timeZone ?? blockResult?.timeZone ?? "Pacific/Honolulu"}
            nextOpenSchoolDayKey={plannedTodayResult?.nextOpenSchoolDayKey ?? null}
            nowMs={nowMs}
            nowDataLoaded={nowDataLoaded}
          />
        </Box>
        {/* Absorbs whatever vertical slack is left so the footer below sits at
            the BOTTOM of a short tab instead of floating under the content.
            A spacer rather than `mt="auto"` on the footer itself, because
            `auto` would also eat the deliberate mt={8} gap once the content
            is tall enough to scroll. Mirrors the native SectionList's
            ListFooterComponentStyle flexGrow. */}
        <Box flex="1 0 auto" aria-hidden />
        {/* A quiet, honest footer — not a buried disclaimer. M5 fix: aligned to
            the same plain register as the composer's own RELATIONAL_LINE
            (shared/admonishments.ts) instead of a separate, more corporate
            "is a tool, not a friend" paraphrase — reusing the exact
            Andy-approved sentence rather than drifting a second copy of it.
            Still links to the full "How it works" page; muted so it never
            competes with the work above. See review/anti-parasocial-design.md. */}
        <Box
          as="footer"
          maxW="680px"
          mx="auto"
          px={{ base: 4, md: 6 }}
          mt={8}
        >
          <Box borderTopWidth="1px" borderColor="gray.200" pt={5}>
            <HStack gap={2.5} align="flex-start">
              <Box color="charcoal.300" flexShrink={0} mt={0.5}>
                <Eye size={16} weight="duotone" />
              </Box>
              <Text
                fontFamily="body"
                fontSize="xs"
                color="charcoal.400"
                lineHeight="1.6"
              >
                {RELATIONAL_LINE} {OVERSIGHT_LINE}{" "}
                <Link
                  href="/how-it-works"
                  style={{ textDecoration: "underline", fontWeight: 600 }}
                >
                  See how it works
                </Link>
                .
              </Text>
            </HStack>
          </Box>
        </Box>
      </Box>

      {/* Unit Picker Dialog */}
      <UnitPickerDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setPickerInitialUnitId(null);
        }}
        initialUnitId={pickerInitialUnitId}
        onSelect={handleUnitSelected}
        units={units.map((u) => ({
          id: u._id,
          title: u.title,
          emoji: u.emoji,
          description: u.description,
          subject: u.subject,
        }))}
        focusLock={focusLock}
        isCreating={isCreating}
      />

      {/* Focused "where am I in this unit" dialog — opened from a unit
          group card's progress meter (NOT the full picker). */}
      <UnitProgressDialog
      open={!!progressTarget}
      unitId={progressTarget?.unitId ?? null}
      assignmentId={progressTarget?.assignmentId ?? null}
      onClose={() => setProgressTarget(null)}
        scholarId={
          isRemoteMode && remoteUserId ? (remoteUserId as Id<"users">) : null
        }
        onLaunchActivity={(sel) => {
          setProgressTarget(null);
          handleUnitSelected(sel);
        }}
      />

      {/* "Choose your path" — shown when opting into a topic-seed quest that
          will be baked, so the scholar picks the shape (deep / wide / build). */}
      {exploreSeedDialog}

      {/* Profile setup modal (first-time only) */}
      {user && needsSetup && (
        <ProfileEditModal
          open={true}
          onClose={() => {}}
          isSetup={true}
          user={user}
        />
      )}

      {/* Forced password reset */}
      {isImpersonating === false && user?.mustResetPassword && user.username && (
        <SetPasswordDialog
          open={true}
          onClose={() => {}}
          requireCurrentPassword={false}
        />
      )}
    </Flex>
  );
}

function TopBar({
  onSignOut,
}: {
  onSignOut: () => void;
}) {
  const { stamp } = useRemote();
  // The "Your Map" entry is hidden until at least one of the scholar's two maps
  // (Sky / Tree) first has real data — the milestone-reveal design (f6). No
  // padlock, no teaser: before reveal the surface simply isn't in their nav.
  const { anyUnlocked } = useMapGates();
  return (
    <AppHeader>
      <AppLogo variant="dark" />
      <RemoteLink href="/scholar" style={{ textDecoration: "none", marginLeft: "16px" }}>
        <Text fontSize="sm" fontFamily="heading" fontWeight="600" color="navy.500">
          Home
        </Text>
      </RemoteLink>
      <Box flex={1} />
      {anyUnlocked && (
        <Link
          href={stamp("/scholar/map")}
          style={{ textDecoration: "none", marginRight: "4px" }}
        >
          <HStack
            gap={1.5}
            px={2.5}
            py={1.5}
            borderRadius="md"
            color="charcoal.500"
            _hover={{ bg: "gray.100", color: "violet.600" }}
          >
            <MapTrifold size={18} weight="duotone" />
            <Text
              fontSize="sm"
              fontFamily="heading"
              fontWeight="600"
              display={{ base: "none", sm: "block" }}
            >
              Your Map
            </Text>
          </HStack>
        </Link>
      )}
      <AccountMenu
        onSignOut={onSignOut}
      />
    </AppHeader>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Section components for the new single-page IA. Each takes the data
// it needs as props from ScholarHome; this keeps ScholarHome readable.
// ──────────────────────────────────────────────────────────────────────

type ScholarSession = NonNullable<
  ReturnType<typeof useQuery<typeof api.sessions.finishedForScholar>>
>[number];

// One enriched entry from assignments.currentClassFocusForMe (which
// returns an array of per-activity classFocus pushes).
type FocusState = NonNullable<
  ReturnType<typeof useQuery<typeof api.assignments.currentClassFocusForMe>>
>[number];

type PlateRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.scholarPlate.activeForMe>>
>["rows"][number];

type NowFocusItem = {
  focus: FocusState;
  row: PlateRow | undefined;
  unitId: Id<"units"> | null;
  assignmentId: Id<"assignments">;
};

type OnboardingPinData = NonNullable<
  ReturnType<typeof useQuery<typeof api.scholarPlate.activeForMe>>
>["onboarding"];

type TodayEntry = NonNullable<
  ReturnType<typeof useQuery<typeof api.assignments.todayScheduleForSelf>>
>["entries"][number];

type CurrentBlock = NonNullable<
  ReturnType<typeof useQuery<typeof api.masterSchedule.currentBlockForSelf>>
>["blocks"][number];

type ScholarClosure = NonNullable<
  ReturnType<typeof useQuery<typeof api.masterSchedule.currentBlockForSelf>>
>["closure"];

function ScholarSections({
  plateRows,
  activeSessions,
  onboardingPin,
  archivedSessions,
  currentFocus,
  focusLock,
  playlist,
  mathPlan,
  standing,
  startedDomains,
  choiceSet,
  forceChooser,
  checkInStarted,
  selectedChoice,
  onSelectChoice,
  choicePreview,
  stretchSelected,
  onSelectStretch,
  stretchPreview,
  onSelectDomain,
  selectedDomain,
  recap,
  checkInScholarId,
  exploringSeedId,
  handleExploreSeed,
  setDialogOpen,
  onOpenUnit,
  onOpenUnitProgress,
  finishedOpen,
  setFinishedOpen,
  isRemoteMode,
  isStaffPreview,
  remoteUserId,
  tabs,
  activeTab,
  onTabChange,
  currentBlock,
  isWithinSchoolHours,
  isPrepTime,
  closure,
  plannedToday,
  plannedTimeZone,
  nextOpenSchoolDayKey,
  nowMs,
  nowDataLoaded,
}: {
  plateRows: PlateRow[];
  activeSessions: ActiveSession[];
  /** The Welcome unit's next-beat pin (H1 fix: hoisted here so it can render
   *  BEFORE "Today" — a brand-new scholar's Welcome beat should lead Home,
   *  not sink below the louder Math Check-In card). `null` once onboarding
   *  is complete (or for a scholar who never had it). Passed straight
   *  through to `ScholarPlate` too (with `hideOnboarding`) so its OWN
   *  zero-history quest gating (Custom Quest, suggested quests) still
   *  applies regardless of where the pin itself renders. */
  onboardingPin: OnboardingPinData;
  archivedSessions: ScholarSession[] | undefined;
  currentFocus: FocusState[] | undefined;
  focusLock: PlateFocusLock;
  playlist: PlaylistData | null | undefined;
  mathPlan: {
    practiceScope: import("@/shared/mathPlanScope").PracticeScope;
    scopeSource: "math_plan" | "legacy_standing" | "open_default";
  } | undefined;
  standing: {
    domain: string;
    /** The full pinned set on a multi-domain standing row — the legacy
     *  switcher/blend source, still honored for scholars with no Math plan. */
    domains?: string[];
    dailyGoalMinutes: number | null;
    title: string | null;
  } | null;
  /** Domains the scholar has STARTED (any mastery row) — threaded down to
   *  PlaylistCard so a tile pick can tell whether its domain is inside the
   *  scholar's effective (auto-blend) domain set, mirroring native's own
   *  `domainSet`. See PlaylistCard's `practiceHref` computation. */
  startedDomains: string[];
  choiceSet: ChoiceCard[] | undefined;
  /** True once ANY domain has placed, or the map derivation reports the
   *  check-in already underway — the chooser renders even though
   *  `playlist.needsPlacement` (a single, default-domain-scoped signal) might
   *  still say true. The straggler fix, f7. */
  forceChooser: boolean;
  /** True once the check-in has been ENTERED — any domain in flight or
   *  converged (`mapProgressForScholar.started`, decision 6). Relabels the
   *  primary CTA "Resume check-in" instead of "Start check-in" (pilot7 f18
   *  finding: leaving mid-flight must not read as "never started"). */
  checkInStarted: boolean;
  selectedChoice: ChoiceCard | null;
  onSelectChoice: (choice: ChoiceCard | null) => void;
  choicePreview: PlaylistData | undefined;
  stretchSelected: boolean;
  onSelectStretch: (selected: boolean) => void;
  stretchPreview: PlaylistData | undefined;
  /** Session-only domain switch (plan §8) — threaded to PlaylistCard's header
   *  switcher drawer. The page owns the selected-domain state. */
  onSelectDomain: (domain: string) => void;
  /** The page owns the switcher selection (it drives the preview queries); the
   *  card needs it back so Start launches the domain the scholar picked. */
  selectedDomain: string | null;
  recap: DailyRecap | undefined;
  /** Surface 1 (Home CTA): the scholar to read `mapProgressForScholar` for —
   *  `undefined` for a teacher-pinned (non-autoBlend) scholar, who has no
   *  cross-domain check-in concept, so CheckInHomeCard's own query never
   *  fires and the card never renders. */
  checkInScholarId: Id<"users"> | undefined;
  exploringSeedId: string | null;
  handleExploreSeed: (id: Id<"seeds">, opts?: ExploreSeedOptions) => void;
  setDialogOpen: (open: boolean) => void;
  onOpenUnit: (unitId: Id<"units">) => void;
  onOpenUnitProgress: (
    unitId: Id<"units">,
    assignmentId?: Id<"assignments">,
  ) => void;
  finishedOpen: boolean;
  setFinishedOpen: (open: boolean) => void;
  isRemoteMode: boolean;
  /** A teacher looking at Home without a learner context (remote view or
   *  self-preview). Live pushes are addressed to scholars, so the strip
   *  stands down rather than showing staff someone else's instruction. */
  isStaffPreview: boolean;
  remoteUserId: string | null;
  tabs: ScholarHomeTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  currentBlock: CurrentBlock | null;
  isWithinSchoolHours: boolean;
  isPrepTime: boolean;
  closure: ScholarClosure;
  plannedToday: TodayEntry[];
  plannedTimeZone: string;
  nextOpenSchoolDayKey: string | null;
  nowMs: number;
  /** True once focus, schedule, and Prep-window queries have resolved. Prevents
   *  a premature clear-day empty state on cold launch. */
  nowDataLoaded: boolean;
}) {
  const { stamp } = useRemote();

  // "Review" (M3 fix: was "Keep working on this", which read as if the
  // Finished row wasn't actually done) — re-open a finished session without
  // regressing completion (see hooks/useKeepWorking + convex sessions.reopen).
  const { keepWorking, pendingId: reopeningId } = useKeepWorking();

  // All/remote needs a fallback only when a live focus has no canonical plate
  // row (for example an offline whole-class activity or a web assignment).
  const startedClassFocusKeys = new Set<string>(
    plateRows
      .filter((r) => r.origin === "classFocus" && r.assignmentId && r.activityId)
      .map((r) => `${r.assignmentId}::${r.activityId}`),
  );
  const pendingClassFocus =
    (currentFocus ?? []).find((f) => {
      if (f.completedByMe) return false;
      if (!f.activityId) return true;
      const key = `${f.assignmentId}::${f.activityId}`;
      return !startedClassFocusKeys.has(key);
    }) ?? null;
  const plateRowByFocusKey = new Map<string, (typeof plateRows)[number]>(
    plateRows
      .filter((row) => row.assignmentId && row.activityId)
      .map((row) => [
        `${row.assignmentId}::${row.activityId}`,
        row,
      ] as const),
  );

  const finishedCount = archivedSessions?.length ?? 0;
  // H1 fix: true while the scholar hasn't finished the Welcome unit yet
  // (`onboardingPin` non-null) — demotes the Math Check-In card to a
  // secondary (outlined, not filled) CTA so it doesn't out-shout the
  // Welcome pin rendered above it, and gates ScholarPlate's own
  // zero-history quest actions (passed through as its `hideOnboarding`
  // sibling prop, `welcomeGate`, computed there from the SAME pin data).
  const welcomeActive = !!onboardingPin;

  const homeworkForNow = filterHomeworkForNow(
    plateRows.filter((row) => row.origin === "homework"),
    { nowMs, timeZone: plannedTimeZone, nextOpenSchoolDayKey },
  );
  const showHomeworkInNow = shouldShowHomeworkInNow({
    currentBlockKind: currentBlock?.kind,
    isWithinSchoolHours,
    isPrepTime,
  });
  // Once Prep is over, the take-home card owns the current plan's work
  // on the Now tab — it renders the SAME homework (same shared deadline
  // policy, server-side) plus whatever the scholar chose during Prep. The
  // digest therefore stands down for the evening rather than rendering those
  // rows a second time. Inside the Prep window the card lives on the Prep tab,
  // so Now keeps its own homework groups.
  const takeHomePlanOwnsNow = takeHomePlanOwnsHomeworkInNow({
    isRemoteMode,
    showHomeworkInNow,
    isPrepTime,
  });
  const homeworkVisibleInNow =
    showHomeworkInNow && !takeHomePlanOwnsNow ? homeworkForNow : [];
  // Mirror EXACTLY what <ScholarPlate tabKey="now"> would put on screen: the
  // same "now" tab predicate, then the same homework suppression. When this is
  // empty the plate renders literally nothing, so the page must not print a
  // header promising a list (the orphaned-band bug) — it owns the empty state
  // itself instead. Both read the same api.scholarPlate.activeForMe query, so
  // the two stay in step without a second round trip.
  const hideHomeworkInNow = !showHomeworkInNow || takeHomePlanOwnsNow;
  const hasOpenWorkInNow = filterRowsForTab(plateRows, "now").some(
    (row) => !(hideHomeworkInNow && row.origin === "homework"),
  );
  // A clear Now tab does NOT mean the scholar has nothing to do: independent
  // Quests live on their own tab and are deliberately excluded from "now". The
  // empty state has to know, or it tells a scholar with three open Quests that
  // "nothing is open" and points them at starting a fourth.
  const hasQuestsWaiting = filterRowsForTab(plateRows, "quests").length > 0;
  // Group the shared-policy rows by their existing deadline phrases.
  const homeworkDueTodayInNow = homeworkVisibleInNow.filter(
    (r) => dueStatus(r.dueAt, nowMs, plannedTimeZone)?.status === "dueToday",
  );
  const homeworkOverdueInNow = homeworkVisibleInNow.filter(
    (r) => dueStatus(r.dueAt, nowMs, plannedTimeZone)?.status === "overdue",
  );
  const homeworkUpcomingInNow = homeworkVisibleInNow.filter(
    (r) =>
      r.dueAt == null ||
      dueStatus(r.dueAt, nowMs, plannedTimeZone)?.status === "upcoming",
  );

  // Fix A: Route through buildNowDigest to derive `isQuiet` and the filtered
  // planned rail. Guard: if either currentFocus or plannedToday (query) hasn't
  // loaded yet, treat as not-quiet to avoid the clear-day empty state flashing
  // on cold load. `playlist: null` — the practice section is rendered
  // separately; practice does not gate isQuiet.
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
  // Live focus items — only currently-active (set, not ended) ones, per
  // buildNowDigest's filter. The All tab keeps pendingClassFocus so started
  // items aren't doubled beside the plate row; the Now tab shows every live
  // focus that hasn't ended (matching the digest's focus section).
  const nowFocusItems = prioritizeFocusedUnit(
    (nowSections.find((s) => s.key === "focus") as
      | { key: "focus"; items: FocusState[] }
      | undefined)?.items ?? [],
    focusLock,
  );
  const nowFocusGroups = groupHomeRowsByUnit(
    nowFocusItems.map((focus) => {
      const key = `${focus.assignmentId}::${focus.activityId ?? ""}`;
      const row = focus.activityId ? plateRowByFocusKey.get(key) : undefined;
      return {
        focus,
        row,
        unitId: row?.unitId ?? focus.unitId ?? null,
        assignmentId: row?.assignmentId ?? focus.assignmentId,
      } satisfies NowFocusItem;
    }),
  );
  // Upcoming planned entries for the Now rail (startsAt >= nowMs filtered
  // by the helper — past-planned entries don't linger in the rail all day).
  const nowPlannedItems =
    (nowSections.find((s) => s.key === "planned") as { key: "planned"; items: TodayEntry[] } | undefined)?.items ?? [];
  const isQuiet = nowDataLoaded && digestIsQuiet;
  // isQuiet: no live focus + no upcoming planned + no due-today homework.
  // When !nowDataLoaded the helper returns isQuiet=false (empty arrays →
  // isQuiet=true, but we guard by returning empty arrays when not loaded above).

  // Context strip: "Right now: Math Workshop · until 9:40 · with Ms. Rivera"
  const contextLine = currentBlock
    ? [
        currentBlock.label,
        `until ${currentBlock.endLocal}`,
        currentBlock.teacherName ? `with ${currentBlock.teacherName}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  // The tab-specific content area. Remote/teacher view always shows the
  // full plate (no tabs, no Now digest).
  const isQuestTab = activeTab === "quests";
  const isPrepTab = activeTab === "prep";
  const isAppsTab = activeTab === "apps";
  const isSubjectTab =
    activeTab !== "now" &&
    activeTab !== "all" &&
    !isPrepTab &&
    !isAppsTab &&
    !isQuestTab;
  const isMathTab = activeTab === "subject:math";

  return (
    <Stack gap={8}>
      {/* ── Welcome — hoisted ABOVE "Today" (H1 fix): a brand-new scholar's
          Welcome pin used to render below the louder, filled "Start
          check-in →" Math card, so the FIRST thing a fresh scholar saw
          ("Math Check-In") wasn't the intended onboarding action. Reuses the
          exact pin ScholarPlate otherwise renders first — passing
          `hideOnboarding` down there so it doesn't also render below. ── */}
      {onboardingPin && (
        <Stack gap={3}>
          <ScholarHomeSectionHeader color="violet.600">
            Welcome to Rabbithole
          </ScholarHomeSectionHeader>
          <OnboardingPin pin={onboardingPin} interactive={!isRemoteMode} />
        </Stack>
      )}

      {/* ── No-school day banner: a holiday / break / staff-development day
          means no classes for the scholar today. Suppresses the "Right now"
          bell-schedule strip (blocks come back empty on a closure) and greets
          the scholar with the day's label instead. Never in remote view. ── */}
      {!isRemoteMode && closure && (
        <Box
          px={4}
          py={3}
          bg="violet.50"
          borderRadius="lg"
          borderWidth="1px"
          borderColor="violet.200"
        >
          <Text fontSize="sm" fontFamily="heading" fontWeight="700" color="violet.700">
            No school today
          </Text>
          <Text fontSize="xs" color="charcoal.500" mt={0.5}>
            {closure.label}
          </Text>
        </Box>
      )}

      {/* ── Context strip + Tab row — above the tab content area.
          Context strip: structural bell-schedule info (Q8): current block
          label, window end, teacher name. Hidden when no current block.
          Tab row: Now · All · subjects · Other · Scholar’s Prep · Quests.
          Neither shown in remote/teacher view. ── */}
      {!isRemoteMode && contextLine && (
        <Box
          px={3}
          py={2}
          bg="gray.100"
          borderRadius="lg"
          borderWidth="1px"
          borderColor="gray.200"
        >
          <Text
            fontSize="xs"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.500"
          >
            <Text as="span" color="charcoal.400" fontWeight="500">
              Right now:{" "}
            </Text>
            {contextLine}
          </Text>
        </Box>
      )}
      {!isRemoteMode && tabs.length > 0 && (
        <ScholarHomeTabs
          tabs={tabs}
          activeTab={activeTab}
          onChange={onTabChange}
        />
      )}

      {/* ══ TAB CONTENT ═══════════════════════════════════════════════════
          Now tab: Q5 ladder — focus → planned → homework.
          All tab: assigned work. Quests tab: independent work + discovery.
          Scholar’s Prep: standing reflection/workshop and teacher-set work.
          Subject/Other tabs: filtered assigned work.
          Remote view: full plate, same as before.
          ════════════════════════════════════════════════════════════════*/}

      {/* ── NOW tab ──────────────────────────────────────────────────── */}
      {(activeTab === "now" && !isRemoteMode) && (
        <Stack gap={6}>
          {/* Pushes with no other home — a link, a video, an app, or work
              aimed at a group rather than an assignment's roster. Activity
              focus is NOT here: the schedule already renders it as the
              groups below, so serving it twice is what convex/pushes.ts
              filters schedule mirrors to prevent. Inside the tab content on
              purpose — as fixed chrome above the tab bar it read as a
              second, competing header for the same moment. */}
          {!isStaffPreview && <FocusStrip />}
          {isPrepTime && (
            <PrepEntryCard onOpen={() => onTabChange("prep")} />
          )}
          {/* After Prep, tonight's list leads Home — the same card the scholar
              built during Prep, with the same homework rows the digest would
              otherwise render (see takeHomePlanOwnsNow). Renders nothing when
              the list is empty. */}
          {takeHomePlanOwnsNow && (
            <TakeHomePlanCard
              mode="home"
              hideWhenEmpty={isQuiet && !hasOpenWorkInNow}
            />
          )}
          {/* Coming up — the read-only lookahead sits directly below tonight's
              list on the evening Home, dating the work tonight deliberately
              withholds. On a fully clear day the page's own empty state speaks
              for the whole tab, so the card stands down rather than stacking a
              second nothing-message under it. */}
          {takeHomePlanOwnsNow && (
            <ComingUpCard hideWhenEmpty={isQuiet && !hasOpenWorkInNow} />
          )}
          {/* Live class focus — all currently-active (started, not ended) focus
              items from buildNowDigest. The All tab keeps pendingClassFocus so
              started items aren't doubled beside the plate row; the Now tab has
              no ScholarPlate, so it renders every live focus. */}
          {nowFocusGroups.map((group) => {
            const plateRows = group.rows.flatMap((item) =>
              item.row ? [item.row] : [],
            );
            const fallbackItems = group.rows.filter((item) => !item.row);
            if (plateRows.length === group.rows.length) {
              return (
                <ScholarPlateActivityGroup
                  key={group.key}
                  rows={plateRows}
                  activeSessions={activeSessions}
                  focusLock={focusLock}
                  onOpenUnitProgress={onOpenUnitProgress}
                />
              );
            }
            if (fallbackItems.length === 1 && group.rows.length === 1) {
              return (
                <ClassFocusActivityCard
                  key={group.key}
                  focus={fallbackItems[0].focus}
                  setDialogOpen={setDialogOpen}
                />
              );
            }
            return (
              <ClassFocusUnitGroupCard
                key={group.key}
                items={group.rows}
                activeSessions={activeSessions}
                focusLock={focusLock}
                onOpenUnitProgress={onOpenUnitProgress}
                setDialogOpen={setDialogOpen}
              />
            );
          })}

          {/* Planned "up next today" rail — only upcoming entries (startsAt ≥
              nowMs, filtered by buildNowDigest). Ghost/dashed cards, no CTA
              (invariant 1: planned entries are never startable). */}
          {nowPlannedItems.length > 0 && (
            <Stack gap={3}>
              <Stack gap={2}>
                {nowPlannedItems.map((entry) => (
                  <PlannedTodayCard
                    key={`${entry.assignmentId}-${entry.activityId}`}
                    entry={{
                      activityTitle: entry.activityTitle,
                      unitTitle: entry.unitTitle,
                      unitEmoji: entry.unitEmoji,
                      subject: entry.subject,
                      startsAt: entry.startsAt,
                    }}
                    timeZone={plannedTimeZone}
                  />
                ))}
              </Stack>
            </Stack>
          )}

          {/* The Tree's daily movement used to render here, as a "TODAY" card
              on the Now tab. It is now a STATE of the one Tree card, on the
              Math tab where the map's own work lives (Andy, 2026-07-26). */}

          {/* Homework for Now — start/continue capable (Fix B: full action,
              not just navigate-to-existing; focus lock exempt for homework).
              Split into two groups sharing the SAME orange pill: work due
              today, then a "Catch up" group for past-due incomplete homework
              (was silently vanishing). Both derive from the ticking nowMs. */}
          {homeworkDueTodayInNow.length > 0 && (
            <Stack gap={3}>
              <ScholarHomeSectionHeader>
                Due today
              </ScholarHomeSectionHeader>
              <Stack gap={3}>
                {homeworkDueTodayInNow.map((row) => (
                  <HomeworkNowRow
                    key={`${row.assignmentId ?? ""}-${row.activityId ?? ""}`}
                    row={row}
                    focusLock={focusLock}
                    nowMs={nowMs}
                    timeZone={plannedTimeZone}
                  />
                ))}
              </Stack>
            </Stack>
          )}
          {homeworkOverdueInNow.length > 0 && (
            <Stack gap={3}>
              <ScholarHomeSectionHeader>
                Catch up
              </ScholarHomeSectionHeader>
              <Stack gap={3}>
                {homeworkOverdueInNow.map((row) => (
                  <HomeworkNowRow
                    key={`${row.assignmentId ?? ""}-${row.activityId ?? ""}`}
                    row={row}
                    focusLock={focusLock}
                    nowMs={nowMs}
                    timeZone={plannedTimeZone}
                  />
                ))}
              </Stack>
            </Stack>
          )}
          {homeworkUpcomingInNow.length > 0 && (
            <Stack gap={3}>
              <ScholarHomeSectionHeader>Homework</ScholarHomeSectionHeader>
              <Stack gap={3}>
                {homeworkUpcomingInNow.map((row) => (
                  <HomeworkNowRow
                    key={`${row.assignmentId ?? ""}-${row.activityId ?? ""}`}
                    row={row}
                    focusLock={focusLock}
                    nowMs={nowMs}
                    timeZone={plannedTimeZone}
                  />
                ))}
              </Stack>
            </Stack>
          )}

          {/* Quiet fallback (Q3): no live focus, no planned entry, no visible
              homework. Two genuinely different states hide behind that one
              signal, and conflating them is what produced the orphaned
              "here's your open work" band with nothing under it:

                - there IS open assigned work  → this is a HEADER over a real
                  list, so it renders as the same ScholarHomeSectionHeader
                  every other section on this tab uses (T-rule: one canonical
                  rendering per signal).
                - there is NO open assigned work → the tab is genuinely empty,
                  so it gets exactly ONE top-level empty state and the plate
                  (which would render nothing at all) is skipped entirely. */}
          {isQuiet && hasOpenWorkInNow && (
            <>
              <ScholarHomeSectionHeader>Open work</ScholarHomeSectionHeader>
              {/* Open assigned work; independent work lives under Quests. */}
              <ScholarPlate
                onOpenUnit={onOpenUnit}
                onOpenUnitProgress={onOpenUnitProgress}
                onExploreSeed={handleExploreSeed}
                exploringSeedId={exploringSeedId}
                focusLock={focusLock}
                hideOnboarding
                hideHomework={hideHomeworkInNow}
                tabKey="now"
              />
            </>
          )}
          {isQuiet && !hasOpenWorkInNow && (
            <EmptyState
              size="lg"
              icon={<SunHorizon weight="duotone" />}
              title="Your day is clear"
              hint={
                hasQuestsWaiting
                  ? "Nothing is scheduled today. Your Quests are waiting whenever you want them."
                  : "Nothing is scheduled and nothing is open. Good time to start a Quest and follow something you're curious about."
              }
              // No CTA when Quests are already waiting: the tab is right there
              // and the scholar knows where it is. A button here would be the
              // app nagging. The CTA stays only for the genuine dead end —
              // nothing scheduled AND nothing to go back to.
              cta={
                hasQuestsWaiting
                  ? undefined
                  : {
                      label: "Start a Quest",
                      onClick: () => setDialogOpen(true),
                      primary: true,
                    }
              }
            />
          )}
        </Stack>
      )}

      {/* ── ALL tab (or remote/teacher view — always shows the full plate) */}
      {(activeTab === "all" || isRemoteMode) && (
        <Stack gap={6}>
          {/* Practice strip + recap (in All tab when remote, or when All is active) */}
          {isRemoteMode && (
            <Stack gap={3}>
              <ScholarHomeSectionHeader>
                Today
              </ScholarHomeSectionHeader>
              <Stack gap={4}>
                <CheckInHomeCard
                  scholarId={checkInScholarId}
                  href={stamp("/scholar/practice?checkin=all")}
                />
                {playlist && (
                  <PlaylistCard
                    playlist={playlist}
                    mathPlan={mathPlan}
                    standing={standing}
                    startedDomains={startedDomains}
                    choiceSet={choiceSet}
                    forceChooser={forceChooser}
                    checkInStarted={checkInStarted}
                    selectedChoice={selectedChoice}
                    onSelectChoice={onSelectChoice}
                    preview={choicePreview}
                    stretchSelected={stretchSelected}
                    onSelectStretch={onSelectStretch}
                    stretchPreview={stretchPreview}
                    onSelectDomain={onSelectDomain}
                    selectedDomain={selectedDomain}
                    secondary={welcomeActive}
                  />
                )}
                <DailyRecapCard recap={recap} mapHref={stamp("/scholar/map?view=tree")} />
              </Stack>
            </Stack>
          )}
          {/* A focus without a plate row (offline/share-back, web, or a
              unit-level picker) keeps the same neutral banded card language. */}
          {pendingClassFocus && (
            <ClassFocusActivityCard
              focus={pendingClassFocus}
              setDialogOpen={setDialogOpen}
            />
          )}
          {/* Remote view stays comprehensive; scholar All is assigned work. */}
          <ScholarPlate
            userId={isRemoteMode && remoteUserId
              ? (remoteUserId as Id<"users">)
              : undefined}
            onOpenUnit={onOpenUnit}
            onOpenUnitProgress={onOpenUnitProgress}
            onExploreSeed={handleExploreSeed}
            exploringSeedId={exploringSeedId}
            focusLock={isRemoteMode ? null : focusLock}
            hideOnboarding
            tabKey={isRemoteMode ? undefined : "all"}
          />
        </Stack>
      )}

      {/* ── SUBJECT / OTHER tabs ────────────────────────────────────── */}
      {isSubjectTab && !isRemoteMode && (
        <Stack gap={6}>
          {isMathTab && (() => {
            // The Tree card's canonical home: one card whose state picks its
            // heading and tone — the once-ever unlock ("Something new") or
            // today's movement ("Today"). Its quiet doorway state renders
            // nothing on web; the title bar's persistent "Your Map" control
            // is already that. See shared/mapHomeCard.ts.
            const treeCard = (
              <MapHomeCard
                map="tree"
                recap={recap}
                mapHref={stamp("/scholar/map?view=tree")}
              />
            );
            // Surface 4: the once-ever completion/growth reveal — the
            // LOUDEST rung, rendered above everything else on the days it
            // fires (fires once per state; see components/practice/
            // MapCompletionCard.tsx). Renders nothing otherwise.
            const completionCard = (
              <MapCompletionCard
                mapHref={stamp("/scholar/map?view=tree")}
                checkInHref={stamp("/scholar/practice?checkin=all")}
              />
            );
            // Surface 1: the optional check-in accelerator — sits directly
            // above the playlist card it accelerates past (brief: "the ≤2
            // mapping playlist items below the CTA are already served by the
            // engine — just make sure the CTA sits above the existing
            // playlist card").
            const checkInCard = (
              <CheckInHomeCard
                scholarId={checkInScholarId}
                href={stamp("/scholar/practice?checkin=all")}
              />
            );
            const playlistCard = playlist && (
              <PlaylistCard
                playlist={playlist}
                mathPlan={mathPlan}
                standing={standing}
                startedDomains={startedDomains}
                choiceSet={choiceSet}
                forceChooser={forceChooser}
                checkInStarted={checkInStarted}
                selectedChoice={selectedChoice}
                onSelectChoice={onSelectChoice}
                preview={choicePreview}
                stretchSelected={stretchSelected}
                onSelectStretch={onSelectStretch}
                stretchPreview={stretchPreview}
                onSelectDomain={onSelectDomain}
                selectedDomain={selectedDomain}
                secondary={welcomeActive}
              />
            );
            // The ONE Fast math + Calculator license card. Its action routes to
            // the dedicated Quick-facts run (`?quickFacts=1`), not the ordinary
            // playlist entry — the playlist's Start is a different offer.
            const calculatorLicenseCard = (
              <ScholarCalculatorLicenseCard
                practiceHref={stamp("/scholar/practice?quickFacts=1")}
              />
            );
            // Demote the Tree hero below the playlist whenever the playlist
            // actually has work queued — the SAME `caughtUp` verdict the
            // playlist card itself uses for its "all done" copy (shared/
            // playlistDoneness.ts), so this never invents a second notion of
            // "has stuff to do". Caught-up (or nothing served) keeps the
            // hero on top.
            return !hasActionablePlaylist(playlist) ? (
              <>
                {completionCard}
                {treeCard}
                {checkInCard}
                {playlistCard}
                {calculatorLicenseCard}
              </>
            ) : (
              <>
                {completionCard}
                {checkInCard}
                {playlistCard}
                {calculatorLicenseCard}
                {treeCard}
              </>
            );
          })()}
          <ScholarPlate
            onOpenUnit={onOpenUnit}
            onOpenUnitProgress={onOpenUnitProgress}
            onExploreSeed={handleExploreSeed}
            exploringSeedId={exploringSeedId}
            focusLock={focusLock}
            hideOnboarding
            tabKey={activeTab}
          />
        </Stack>
      )}

      {/* ── SCHOLAR'S PREP tab ───────────────────────────────────────── */}
      {isPrepTab && !isRemoteMode && (
        <Stack gap={3}>
          {/* Tonight's list leads the Prep tab; Coming up dates what follows;
              Prep activities close it. */}
          <TakeHomePlanCard onAddQuest={() => onTabChange("quests")} />
          <ComingUpCard />
          <PrepActivityCards />
        </Stack>
      )}

      {/* ── APPS tab ─────────────────────────────────────────────────── */}
      {isAppsTab && !isRemoteMode && <AppLauncher />}

      {/* ── QUESTS tab ──────────────────────────────────────────────── */}
      {isQuestTab && !isRemoteMode && (
        <Stack gap={6}>
          {/* The once-ever "Your Sky is ready" reveal card is RETIRED (P5,
              review/story-quest-rationalization-plan.html d4, Andy 2026-08-12):
              the Quests tab's invitation family carries the "something new"
              moment now — the first story/seed invitation IS the reveal. Sky
              access is unchanged (web: the "Your Map" title-bar door; native:
              the pull-to-Sky gesture), and /scholar/map still consumes
              revealPending on first arrival. The Tree keeps its MapHomeCard
              rungs on the Math tab — only the Sky rung is gone. */}
          <ScholarPlate
            onOpenUnit={onOpenUnit}
            onOpenUnitProgress={onOpenUnitProgress}
            onExploreSeed={handleExploreSeed}
            exploringSeedId={exploringSeedId}
            focusLock={focusLock}
            hideOnboarding
            tabKey="quests"
          />
        </Stack>
      )}

      {/* ── Finished — collapsible, always at page bottom ─────────── */}
      {finishedCount > 0 && (
        <Stack gap={3}>
          <Box
            as="button"
            onClick={() => setFinishedOpen(!finishedOpen)}
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            cursor="pointer"
            py={2}
          >
            <HStack gap={2}>
              {finishedOpen ? (
                <CaretDown color="var(--chakra-colors-charcoal-400)" />
              ) : (
                <CaretRight color="var(--chakra-colors-charcoal-400)" />
              )}
              <Heading
                size="md"
                color="charcoal.500"
                fontFamily="heading"
                fontWeight="700"
              >
                📦 Finished
              </Heading>
              <Text
                fontSize="xs"
                color="charcoal.400"
                fontFamily="heading"
              >
                {finishedCount}
              </Text>
            </HStack>
          </Box>
          {finishedOpen && (
            <Stack gap={4} pl={6}>
              {archivedSessions && archivedSessions.length > 0 && (
                <Stack gap={2}>
                  {archivedSessions.map((p) => (
                    <Flex
                      key={p._id}
                      as="button"
                      onClick={() => keepWorking(p._id as Id<"sessions">)}
                      textAlign="left"
                      width="100%"
                      p={3}
                      bg="white"
                      borderRadius="md"
                      borderWidth="1px"
                      borderColor="gray.200"
                      shadow="xs"
                      align="center"
                      gap={3}
                      cursor="pointer"
                      opacity={reopeningId === p._id ? 0.6 : 1}
                      aria-disabled={reopeningId === p._id}
                      _hover={{ shadow: "sm", bg: "gray.50" }}
                    >
                      {p.personaEmoji && (
                        <Text fontSize="md">{p.personaEmoji}</Text>
                      )}
                      <Stack gap={0} flex={1} minW={0}>
                        <Text
                          fontFamily="heading"
                          fontWeight="500"
                          color="charcoal.500"
                          fontSize="sm"
                          overflow="hidden"
                          textOverflow="ellipsis"
                          whiteSpace="nowrap"
                        >
                          {p.title}
                        </Text>
                        {p.unitTitle && (
                          <Text
                            fontSize="2xs"
                            color="charcoal.400"
                            fontFamily="heading"
                          >
                            {p.unitTitle}
                          </Text>
                        )}
                      </Stack>
                      <HStack
                        gap={1}
                        color="violet.600"
                        fontFamily="heading"
                        fontWeight="600"
                        fontSize="xs"
                        flexShrink={0}
                      >
                        <ArrowClockwise size={14} weight="bold" />
                        <Text>
                          {reopeningId === p._id ? "Opening…" : "Review"}
                        </Text>
                      </HStack>
                    </Flex>
                  ))}
                </Stack>
              )}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}

// ── Simplified homework row for the Now tab's homework digest ─────────
// Renders a single homework plate row. Serves BOTH the "Due today" and
// "Catch up" groups — a small orange due pill in the title block carries the
// distinguishing phrase ("due today" / "was due yesterday") via dueStatus,
// while the right-hand CTA is the standard violet "Start ›" / "Continue ›"
// link (Andy, fix round 2: pill and CTA are separate, not one coalesced chip).
// Fix B: start/continue capable — creates a session if none exists (same
// action as the plate card). Homework is exempt from the focus lock
// (isLockedByFocus returns false for origin "homework"). Uses stable
// assignmentId-activityId keys (callers should not pass array index).
function HomeworkNowRow({
  row,
  focusLock,
  nowMs,
  timeZone,
}: {
  row: PlateRow;
  focusLock: { unitId: string | null; label: string | null } | null;
  nowMs: number;
  timeZone: string;
}) {
  const router = useRouter();
  const { stamp } = useRemote();
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const [starting, setStarting] = useState(false);

  // Homework is always exempt from the focus lock (policy a in focusLock.ts).
  // isLockedByFocus("homework", ...) always returns false — no need to dim.
  const locked = isLockedByFocus(focusLock, row.unitId, "homework");

  const isOfflineHomework =
    row.activityKind === "offline" && row.origin === "homework";

  const handleClick = async () => {
    if (locked || starting) return;
    if (!isOfflineHomework && row.sessionId) {
      router.push(stamp(`/scholar/${row.sessionId}`));
      return;
    }
    // Not-started homework: create session then navigate (mirrors plate card).
    if (!row.activityId) return;
    setStarting(true);
    try {
      if (isOfflineHomework) {
        if (!row.assignmentId) return;
        const result = await openOfflineHomework({
          activityId: row.activityId,
          assignmentId: row.assignmentId,
        });
        router.push(stamp(`/scholar/${result.id}`));
        return;
      }
      const result = await createSession({
        activityId: row.activityId,
        ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
      });
      if (result) router.push(stamp(`/scholar/${result.id}`));
    } catch (err) {
      console.error("HomeworkNowRow: failed to start", err);
      toaster.error({
        title: isOfflineHomework
          ? "Couldn't open that homework"
          : "Couldn't start that activity",
        description: "Please try again.",
      });
    } finally {
      setStarting(false);
    }
  };

  const actionable = !locked && !starting;

  return (
    <Box
      as={actionable ? "button" : "div"}
      onClick={actionable ? handleClick : undefined}
      textAlign="left"
      width="100%"
      p={4}
      bg="white"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="gray.200"
      shadow="xs"
      cursor={actionable ? "pointer" : "default"}
      opacity={starting ? 0.7 : 1}
      _hover={actionable ? { shadow: "sm", bg: "gray.50" } : undefined}
    >
      <HStack justify="space-between" align="center" gap={3}>
        <Stack gap={1.5} flex={1} minW={0}>
          <HStack gap={2} align="center">
            {row.unitEmoji && (
              <Text fontSize="sm" flexShrink={0}>{row.unitEmoji}</Text>
            )}
            <Text
              fontFamily="heading"
              fontWeight="500"
              fontSize="sm"
              color="charcoal.500"
              lineClamp={2}
            >
              {row.title}
            </Text>
          </HStack>
          {row.unitTitle && (
            <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
              {row.unitTitle}
            </Text>
          )}
          {isOfflineHomework && row.description && (
            <Text
              fontSize="sm"
              color="charcoal.600"
              fontFamily="body"
              lineHeight="1.45"
              lineClamp={2}
            >
              {row.description}
            </Text>
          )}
          {/* The due phrase stays its OWN token, never coalesced into the CTA
              (Andy, fix round 2) — but it is now the SHARED chip rather than a
              third bordered variant invented here. This is a Catch up group, so
              every row in it is already late or due tonight and reads loud. */}
          <Box alignSelf="flex-start">
            <DueChip dueAt={row.dueAt} nowMs={nowMs} timeZone={timeZone} />
          </Box>
        </Stack>
        {starting ? (
          <Box
            as="span"
            flexShrink={0}
            fontFamily="heading"
            fontWeight="600"
            fontSize="xs"
            color="violet.600"
            px={2.5}
            py={1.5}
            whiteSpace="nowrap"
          >
            Opening…
          </Box>
        ) : (
          <ActivityCardCta showCaret>
            {isOfflineHomework
              ? "Open"
              : row.sessionId
                ? "Continue"
                : "Start"}
          </ActivityCardCta>
        )}
      </HStack>
    </Box>
  );
}

// ── Focus fallback — rows for work without a plate row ────────────────
function ClassFocusUnitGroupCard({
  items,
  activeSessions,
  focusLock,
  onOpenUnitProgress,
  setDialogOpen,
}: {
  items: NowFocusItem[];
  activeSessions: ActiveSession[] | undefined;
  focusLock: PlateFocusLock;
  onOpenUnitProgress: (
    unitId: Id<"units">,
    assignmentId?: Id<"assignments">,
  ) => void;
  setDialogOpen: (open: boolean) => void;
}) {
  const first = items[0];
  if (!first?.unitId) return null;
  const unitId = first.unitId;
  const progressRow = items.find((item) => item.row)?.row;

  return (
    <UnitGroupCard>
      <UnitGroupBand
        emoji={first.focus.unitEmoji}
        title={first.focus.unitTitle}
        completedCount={progressRow?.unitCompletedCount ?? null}
        activityCount={progressRow?.unitActivityCount ?? null}
        teacherName={first.focus.teacherName ?? undefined}
        teacherImage={first.focus.teacherImage ?? undefined}
        onProgressClick={
          progressRow
            ? () => onOpenUnitProgress(unitId, first.assignmentId)
            : undefined
        }
      />
      {items.map((item, index) =>
        item.row ? (
          <ScholarPlateActivityRow
            key={`${item.assignmentId}::${item.focus.activityId ?? index}`}
            row={item.row}
            activeSessions={activeSessions}
            focusLock={focusLock}
            showDivider={index > 0}
          />
        ) : (
          <ClassFocusActivityRow
            key={`${item.assignmentId}::${item.focus.activityId ?? index}`}
            focus={item.focus}
            setDialogOpen={setDialogOpen}
            variant="row"
            showDivider={index > 0}
          />
        ),
      )}
    </UnitGroupCard>
  );
}

function ClassFocusActivityCard({
  focus,
  setDialogOpen,
}: {
  focus: FocusState;
  setDialogOpen: (open: boolean) => void;
}) {
  if (!focus.unitId) {
    return (
      <ClassFocusActivityRow
        focus={focus}
        setDialogOpen={setDialogOpen}
        variant="card"
        showDivider={false}
      />
    );
  }

  return (
    <UnitGroupCard>
      <UnitGroupBand
        emoji={focus.unitEmoji}
        title={focus.unitTitle}
        completedCount={null}
        activityCount={null}
        teacherName={focus.teacherName ?? undefined}
        teacherImage={focus.teacherImage ?? undefined}
      />
      <ClassFocusActivityRow
        focus={focus}
        setDialogOpen={setDialogOpen}
        variant="row"
        showDivider={false}
      />
    </UnitGroupCard>
  );
}

function ClassFocusActivityRow({
  focus,
  setDialogOpen,
  variant,
  showDivider,
}: {
  focus: FocusState;
  setDialogOpen: (open: boolean) => void;
  variant: "card" | "row";
  showDivider: boolean;
}) {
  const {
    join,
    launching,
    donePrompt,
    resolveDonePrompt,
    gamePrompt,
    dismissGamePrompt,
  } = useJoinFocus();
  const [starting, setStarting] = useState(false);
  const canOpen = focus.activityId == null || focus.soloStartableByMe;
  const roomPhase = useRoomTurnPhase(focus.endsAt);
  const timeLabel =
    focus.endsAt != null
      ? formatRoomTurnTime(focus.endsAt, focus.timeZone)
      : null;
  const roomTurnLine = classFocusPlateLine(roomPhase, timeLabel);

  const handleOpen = async () => {
    if (!canOpen || starting || launching) return;
    setStarting(true);
    try {
      await join(focus, { onNeedsPicker: () => setDialogOpen(true) });
    } finally {
      setStarting(false);
    }
  };

  // Most-specific-wins. Falls through to a generic only if the focus
  // somehow has no resolvable target name (shouldn't happen — the
  // unit always exists when a focus is active).
  const label =
    focus.activityTitle ??
    focus.lessonTitle ??
    focus.unitTitle ??
    "Class assignment";

  const actionLabel =
    focus.activityId == null
      ? "Choose"
      : focus.activityKind === "web"
        ? "Open"
        : "Start";
  const cta = canOpen ? (
    <ActivityCardCta loading={starting || launching}>
      {actionLabel}
    </ActivityCardCta>
  ) : undefined;
  const body = (
    <>
      <HStack gap={2.5} minW={0}>
        {focus.appIconUrl && (
          <Box
            w="28px"
            h="28px"
            borderRadius="8px"
            flexShrink={0}
            bg="white"
            boxShadow="0 1px 3px rgba(20,24,50,0.18)"
            overflow="hidden"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary app icon URL from activity data; next/image would require per-source configuration */}
            <img
              src={focus.appIconUrl}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "contain", padding: "4px" }}
            />
          </Box>
        )}
        <ActivityCardTitle density="compact" clamp flex={1} minW={0}>
          {label}
        </ActivityCardTitle>
      </HStack>
      <ActivityCardMeta tone={canOpen ? "violet.500" : undefined}>
        {canOpen ? roomTurnLine : "Whole-class activity"}
      </ActivityCardMeta>
    </>
  );

  return (
    <Fragment>
      {variant === "row" ? (
        <UnitGroupRow
          status="todo"
          showDivider={showDivider}
          onClick={canOpen ? handleOpen : undefined}
          ariaLabel={canOpen ? `${actionLabel} ${label}` : undefined}
          opacity={starting || launching ? 0.7 : 1}
          cta={cta}
        >
          {body}
        </UnitGroupRow>
      ) : (
        <ActivityCard
          density="compact"
          onClick={canOpen ? handleOpen : undefined}
          ariaLabel={canOpen ? `${actionLabel} ${label}` : undefined}
          opacity={starting || launching ? 0.7 : 1}
          cta={cta}
        >
          {body}
        </ActivityCard>
      )}
      <WebAssignmentDoneDialog
        prompt={donePrompt}
        onResolve={resolveDonePrompt}
      />
      <GameCapabilityNotice prompt={gamePrompt} onDismiss={dismissGamePrompt} />
    </Fragment>
  );
}
