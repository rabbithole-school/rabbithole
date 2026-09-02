/**
 * PracticePlaylistCard — the native scholar-home "Today's Math Playlists" card,
 * the RN analogue of web `components/practice/PlaylistCard.tsx`. It mirrors the
 * web card's job: name today's practice block (the single next-up skill + how
 * much of today's set is done), offer a row of PEER playlist tiles ("Today's
 * blend" + up to 3 bounded frontier strand cards) a scholar can select before
 * starting, and offer one CTA into the full-screen practice flow
 * (`app/practice.tsx`).
 *
 * The card is hidden entirely when there's nothing queued to practice.
 *
 * Data comes from the SAME query computations the web card is fed by. The card
 * owns its subscriptions here (native has no page-level lift) and holds every
 * layout-affecting initial read behind one minimum-height skeleton.
 *
 * Select-and-recompose (tiles are SELECTIONS, never launch buttons): tapping a
 * tile only sets local `selectedChoice` state — it never navigates. The
 * preview list below recomposes to the SAME set Start would actually serve (a
 * second `playlistForScholar` subscription with `choiceHint` set — the
 * identical composition path `practiceSession` uses, no forked logic). The CTA
 * relabels to "Start with <strand headline> →"; picking logs nothing —
 * `logPracticeChoice` fires only when Start is actually pressed with a strand
 * selected, never on a dabbled select/deselect. Mirrors web PlaylistCard's
 * mechanic exactly via the shared `shared/practiceChoiceSelection.ts` helper
 * (vendored).
 */

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { api } from "@/lib/convex";
import { HomeSection } from "@/components/HomeSection";
import { Skeleton } from "@/components/ui/Skeleton";
// The check-in title is the SAME string the accelerator card renders — the two
// surfaces hand off across `started`, so a hand-typed twin here would let the
// scholar see two spellings of one name across one lifecycle. It also drifted
// in exactly that way: web sentence-cased to "Math check-in" (#2463) while this
// copy stayed "Math Check-In", so the two stacked cards on the day-1 iPad screen
// disagreed about the name of the thing. Shared constant, never a drift copy.
import { CHECK_IN_HOME_TITLE } from "../../../vendor/shared/checkInMapCopy";
import { superscriptExponents } from "../../../vendor/shared/mathNotation";
import {
  practiceDomainLabel,
  strandHeadlineFor,
} from "../../../vendor/shared/practiceDomainLabels";
import { segmentBeatLabel, withLaunchpadRow } from "../../../vendor/shared/practiceSegments";
import {
  derivePlaylistDoneness,
  playlistMastheadDateline,
} from "../../../vendor/shared/playlistDoneness";
import { MASTERY_DOT_COLOR } from "../../../vendor/shared/masteryDialPalette";
import {
  deriveStartCta,
  expandMoreLabel,
  nextTileSelection,
  playlistTileIconName,
  practiceCtaAccessibleLabel,
} from "../../../vendor/shared/practiceChoiceSelection";
import {
  STRETCH_TILE_ARIA_LABEL,
  STRETCH_TILE_HEADLINE,
  STRETCH_TILE_SUBTITLE,
} from "../../../vendor/shared/practiceLoop";
import {
  PRACTICE_SCOPE_BLOCKED_DETAIL,
  PRACTICE_SCOPE_BLOCKED_HEADLINE,
  practiceScopeSentence,
  scopeAllowsChoice,
  scopeAllowsDomain,
  type ScholarMathPlan,
} from "../../../vendor/shared/mathPlanScope";
import { PLAYLIST_TILE_ICONS, CheckpointFlagIcon } from "./PlaylistTileIcons";
import { DomainSwitcherSheet } from "./DomainSwitcherSheet";
import { fonts, useColors } from "@/theme";
import { useInstitutionDay } from "@/hooks/useInstitutionDay";

const GLYPH = "∴";

// The masthead's "toward" accent is FRONTIER GOLD (#e0b84e — the canonical
// frontier amber from masteryDialPalette), matching web PlaylistCard's
// eyebrow/rule accent exactly. NOT theme `colors.yellow` (#FFE77C): that pale
// banana yellow is near-invisible on the card's light surface.
const FRONTIER_GOLD = MASTERY_DOT_COLOR.frontier;

// Fixed carousel-tile geometry — a carousel item, not a wrapping-grid cell;
// larger sets stay in one horizontally scrollable row instead of wrapping.
// `snapToInterval` on the ScrollView below needs the exact tile+gap width.
const TILE_WIDTH = 152;
const TILE_GAP = 8;

/** Resolves a `playlistTileIconName` result to its hand-drawn RN twin —
 *  renders nothing (never crashes) for a name with no twin in
 *  PlaylistTileIcons.tsx, mirroring web's `TileIcon`'s same-shaped fallback.
 *  Indexes the icon map directly (not through a wrapping function call) so
 *  React Compiler can see `Icon` is a stable reference, matching web
 *  PlaylistCard's `TileIcon` — see PlaylistTileIcons.tsx's header comment. */
function TileIcon({ name, color }: { name: string; color: string }) {
  const Icon = PLAYLIST_TILE_ICONS[name];
  if (!Icon) return null;
  return <Icon size={20} color={color} />;
}

/** One api.practiceSkills.choiceCardsForSelf card
 *  (mirrors web ChoiceCard). */
type ChoiceCard = {
  domain: string;
  domainLabel: string;
  strand: string;
  sampleSkillKey: string;
  sampleSkillLabel: string;
  /** True for a `newTerritory` entry (a domain the scholar hasn't started
   *  yet) — the fold-in of the old standalone "Explore a new territory" pills
   *  (raise-the-ceiling consolidation, f7). Draws a subtle "NEW" accent. */
  isNew?: boolean;
};

export function pendingHighlightMatch<T extends { domain: string }>(
  highlightDomain: string | undefined,
  consumedHighlight: string | null,
  choices: readonly T[],
): T | undefined {
  if (!highlightDomain || consumedHighlight === highlightDomain) return undefined;
  return choices.find((choice) => choice.domain === highlightDomain);
}

/** Narrow local shape of `api.mathFocus.myMathCheckpoint`'s result — cast here
 *  because the vendored/generated Convex types haven't caught up yet with the
 *  parallel backend extension (QB regenerates before merge). `mode` splits the
 *  ONE banner into two states: still mapping toward the checkpoint ("toward")
 *  vs. already there and now going deeper on the same band ("deeper").
 *  `bandSolid`/`bandTotal` drive the dot tally (solid dots out of the total). */
type MathCheckpoint = {
  grade: string;
  strandLabel: string;
  mode: "toward" | "deeper";
  bandSolid: number;
  bandTotal: number;
};

type PracticeScopeSource = "math_plan" | "legacy_standing" | "open_default";
type MathPlan = ScholarMathPlan & { scopeSource: PracticeScopeSource };

/** RN has no reliable global `crypto.randomUUID` (Hermes doesn't ship WebCrypto),
 *  so `logPracticeChoice`'s idempotency key falls back to a time+random string —
 *  it only needs to be unique per-tap, never cryptographically strong. */
function makeClientPickId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pick-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function PracticePlaylistCard({
  eyebrow,
  eyebrowDetail,
  treeHero,
  completionHero,
  checkInHero,
}: {
  /**
   * Section heading rendered ABOVE the card — the live timetable block's name
   * ("Math Workshop"). Owned by the card, not the parent, so heading and card
   * gate together (see components/HomeSection.tsx).
   */
  eyebrow?: string;
  /** Subordinate line under the heading, e.g. "until 9:40 · with Ms. Rivera". */
  eyebrowDetail?: string | null;
  /** The one elevated Tree element. This component owns its placement so the
   *  hero and playlist cross the same loading boundary in one commit. */
  treeHero?: ReactNode;
  /** MapCompletionCard — renders ALWAYS FIRST, independent of playlist/load
   *  state (mirrors web app/scholar/page.tsx: completionCard is never
   *  reordered relative to the playlist). */
  completionHero?: ReactNode;
  /** CheckInHomeCard — renders directly above the playlist body, never
   *  reordered relative to it (only `treeHero` moves; mirrors web). Omitted
   *  from the `loadingCard` skeleton branch to avoid a reflow against the
   *  pre-existing treeHero boundary-crossing optimization. */
  checkInHero?: ReactNode;
} = {}) {
  const { isAuthenticated } = useConvexAuth();
  const router = useRouter();
  // `?highlightDomain=` — the reusable "land on the chooser with a tile
  // preselected" redirect target (f7's fold #2/#3 substrate): a summit
  // hand-off or any future "new frontier" moment links here instead of
  // straight into practice. Read from the HOME screen's own route params
  // (expo-router resolves `useLocalSearchParams` from the nearest Screen
  // regardless of which nested component calls it).
  const { highlightDomain } = useLocalSearchParams<{ highlightDomain?: string }>();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expanded, setExpanded] = useState(false);
  const [domainSwitcherOpen, setDomainSwitcherOpen] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);

  const standing = useQuery(
    api.standingPractice.myActiveStanding,
    isAuthenticated ? {} : "skip",
  );
  // The scholar's own "working toward" checkpoint — the goal (strand × grade)
  // a teacher planted for their group or for them. GOAL-ONLY (no steering
  // internals; see mathFocus.myMathCheckpoint). Renders a slim banner atop the
  // card; null when no checkpoint is set (most scholars, most of the time).
  const myCheckpoint = useQuery(
    api.mathFocus.myMathCheckpoint,
    isAuthenticated ? {} : "skip",
  ) as MathCheckpoint | null | undefined;
  const mathPlan = useQuery(
    api.mathPlans.myPlan,
    isAuthenticated ? {} : "skip",
  ) as MathPlan | undefined;
  // An explicit Math plan supersedes legacy standing practice configuration.
  // Keep the plan's loading boundary intact so the card cannot briefly launch a
  // stale standing pin before the authoritative source is known.
  const hasExplicitMathPlan = mathPlan?.scopeSource === "math_plan";
  const effectiveStanding = hasExplicitMathPlan ? null : standing;
  // Auto-blend needs the scholar id + their per-domain progress, but ONLY when
  // there's no standing pin (standing === null), mirroring web
  // app/scholar/practice/page.tsx's `wantsAutoBlend` gate.
  const me = useQuery(api.users.currentUser, isAuthenticated ? {} : "skip");
  const scholarId = me?._id;
  const serverDay = useQuery(
    api.institutions.currentDayForScholar,
    isAuthenticated ? {} : "skip",
  );
  const institutionDay = useInstitutionDay(serverDay);
  // Per-domain progress: powers BOTH the auto-blend (started domains) and the
  // "new territory" tiles (unstarted domains, the fold-in of the old
  // standalone "Explore a new territory" pills, f7). Queried whenever
  // authenticated (mirrors web app/scholar/page.tsx, which never gates it on
  // `standing`), so the chooser shows for teacher-pinned scholars too.
  const domainsInfo = useQuery(
    api.practiceSkills.domainsForScholar,
    isAuthenticated && scholarId ? { scholarId } : "skip",
  );
  const autoBlend = mathPlan !== undefined && effectiveStanding === null;
  const startedDomains = (domainsInfo ?? []).filter((d) => d.started).map((d) => d.domain);
  const anyDomainStarted = startedDomains.length > 0;
  // The map derivation's own honest state (finish-the-check-in decision 6):
  // the SAME `mapProgressForScholar` read-surface CheckInHomeCard renders from
  // — one derivation, one source of truth (T7/T11). It replaces the stale
  // `mixedPlacementCurrent` governor readout this card used to poll: that
  // query's `paused` flag is the standalone 30-probes/day SITTING budget, which
  // no longer governs the Option-D serving path (the `· mapping` band rides the
  // ordinary playlist), so reading it here reported a governor that had stopped
  // governing. Same args as CheckInHomeCard's own query, so convex/react shares
  // ONE subscription. Mirrors web app/scholar/page.tsx.
  const mapProgress = useQuery(
    api.practiceSkills.mapProgressForScholar,
    isAuthenticated && autoBlend && scholarId ? { scholarId } : "skip",
  );
  // Wait for `standing` so we subscribe once with the right domain (mirrors web).
  // The effective domain: a teacher's pin, else the scholar's own FIRST
  // started domain — never a hardcoded default (the straggler fix, f7). A
  // scholar who deep-linked into and placed a non-default domain must not see
  // a home card permanently stuck on a domain they never touched.
  const planDomains =
    hasExplicitMathPlan && mathPlan.practiceScope.kind === "limited"
      ? mathPlan.practiceScope.domains.map((entry) => entry.domain)
      : startedDomains;
  const effectiveDomain = selectedDomain ?? effectiveStanding?.domain ?? planDomains[0];
  const playlist = useQuery(
    api.practiceSkills.playlistForScholar,
    isAuthenticated &&
    mathPlan !== undefined &&
    (hasExplicitMathPlan || standing !== undefined) &&
    institutionDay
      ? effectiveDomain
        ? {
            domain: effectiveDomain,
            dayKey: institutionDay.dayKey,
            // Option D (Q6): the default (auto-blend) Start folds the `· mapping`
            // band, so the base preview must too (matching serve). A teacher's
            // single-domain pin serves without mapping, so it stays ordinary.
            ...(effectiveStanding ? {} : { includeMapping: true }),
            platform: "native",
          }
        : { dayKey: institutionDay.dayKey, includeMapping: true, platform: "native" }
      : "skip",
  );
  // Up to 3 bounded frontier picks plus the not-yet-started domain cards in one
  // server-composed subscription. The backend derives new-territory exclusions
  // from this same choiceSet, so the carousel no longer waits through a second
  // choiceSet → newTerritory round trip.
  const choiceCards = useQuery(
    api.practiceSkills.choiceCardsForSelf,
    isAuthenticated ? {} : "skip",
  );
  const choiceSet = choiceCards?.choiceSet;
  const newTerritoryCards = choiceCards?.newTerritory;
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
  // Do not flash choices away while the plan subscription is loading. Once the
  // limited scope resolves, the chooser only exposes server-permitted options.
  const availableChoiceCards =
    mathPlan?.practiceScope.kind === "limited"
      ? allChoiceCards.filter((choice) =>
          scopeAllowsChoice(mathPlan.practiceScope, choice),
        )
      : allChoiceCards;
  const scopeSentence = mathPlan
    ? practiceScopeSentence(mathPlan.practiceScope, {
        domainLabel: practiceDomainLabel,
        strandLabel: (strand, domain) => strandHeadlineFor(domain, strand),
      })
    : null;
  // The plan currently leaves nothing servable. Read the SERVER's `blocked`
  // flag, never the scope's shape: a limited scope is usually perfectly
  // servable, and the old shape check (every entry carrying an EMPTY `strands`
  // array) was vacuously-true-only — `validatePracticeScope` rejects a stored
  // `strands: []`, so it could never fire, and the scholar was told they were
  // caught up instead. Mirrors the web twin (components/practice/PlaylistCard.tsx).
  const scopeBlocked = (playlist as { blocked?: boolean } | undefined)?.blocked === true;
  const switchableDomains = hasExplicitMathPlan
    ? planDomains.filter((domain) =>
        mathPlan.practiceScope.kind === "limited"
          ? scopeAllowsDomain(mathPlan.practiceScope, domain)
          : true,
      )
    : effectiveStanding?.domains ?? [];
  // The controlled tile selection (select-and-recompose) — `null` means
  // "Today's blend" (the default set) is active.
  //
  // DERIVED, not clamped. The stored pick is only ever *honoured* while the set
  // still offers it, so a rotation can never leave an orphan selected. The
  // effect this replaces watched `allChoiceCards.length`, so a rotation that
  // kept the same length (the common case — the scholar advances and a card's
  // frontier skill changes) never re-ran it and the stale pick stayed
  // highlighted indefinitely, with the preview and Start both aimed at a strand
  // no longer on offer. Mirrors the web twin in `app/scholar/page.tsx`.
  const [storedChoice, setStoredChoice] = useState<ChoiceCard | null>(null);
  const selectedChoice =
    storedChoice &&
    allChoiceCards.some((c) => c.domain === storedChoice.domain && c.strand === storedChoice.strand)
      ? storedChoice
      : null;
  // The Stretch tile — a second, mutually-exclusive selection mode for the
  // challenge lane's standing home. Purely local state (native owns its own
  // queries; no lift needed).
  const [stretchSelected, setStretchSelected] = useState(false);
  // Apply the deep-link highlight AT MOST ONCE per `highlightDomain` value.
  // The dep is the card set's CONTENTS (not its `.length`), so a later rotation
  // that swaps the requested card in while keeping N cards still fires a match —
  // the old `.length` proxy silently missed that and stranded the scholar on
  // "Today's blend". The ref makes it fire-once: after the first successful
  // preselect we stop, so a rotation that happens AFTER the scholar has tapped a
  // different tile never re-selects the highlighted domain and stomps their
  // choice. A still-absent domain keeps waiting (ref unset) until it appears,
  // unless the scholar explicitly chooses another route first.
  // Mirrors the web twin in `app/scholar/page.tsx`.
  const consumedHighlightRef = useRef<string | null>(null);
  const disarmPendingHighlight = () => {
    // A manual chooser decision owns the card from this point on. Marking the
    // pending value consumed prevents a late subscription update from replacing
    // that decision when the requested tile finally arrives.
    if (highlightDomain) consumedHighlightRef.current = highlightDomain;
  };
  useEffect(() => {
    const match = pendingHighlightMatch(
      highlightDomain,
      consumedHighlightRef.current,
      allChoiceCards,
    );
    if (match && highlightDomain) {
      consumedHighlightRef.current = highlightDomain;
      setStoredChoice(match);
      setStretchSelected(false);
    }
  }, [highlightDomain, allChoiceCards]);
  // The RECOMPOSED preview for the selected strand — the SAME playlistForScholar
  // query as `playlist` above, scoped to the SELECTED card's own domain (never
  // the home's default effective domain — a cross-domain or "new territory"
  // pick would otherwise have its choiceHint silently dropped, since
  // practiceSession's own `choiceHint.domain === domain` gate requires an
  // exact match) with `choiceHint` set, so it reuses the identical composition
  // path (no forked scheduling logic) and is a byte-faithful stand-in for what
  // Start will actually serve. Skipped entirely when nothing is selected (the
  // blend already IS `playlist`).
  const choicePreview = useQuery(
    api.practiceSkills.playlistForScholar,
    isAuthenticated && institutionDay && selectedChoice
      ? {
          domain: selectedChoice.domain,
          dayKey: institutionDay.dayKey,
          choiceHint: { domain: selectedChoice.domain, strand: selectedChoice.strand },
          // Option D (Q6): the You-Pick Start folds mapping for an unmapped
          // domain, so this preview must recompose to the SAME `· mapping`
          // composition — never ordinary rows Start won't serve.
          includeMapping: true,
          platform: "native",
        }
      : "skip",
  );
  // The RECOMPOSED preview for the Stretch tile — playlistForScholar with
  // `stretchHint: true`, which returns challenge-tail items as the set.
  const stretchPreview = useQuery(
    api.practiceSkills.playlistForScholar,
    isAuthenticated && institutionDay && stretchSelected && effectiveDomain
      ? { domain: effectiveDomain, dayKey: institutionDay.dayKey, stretchHint: true, platform: "native" }
      : "skip",
  );
  const logPracticeChoice = useMutation(api.practiceSkills.logPracticeChoice);

  // The tile row is now a horizontal CAROUSEL (Andy's play-session finding:
  // 9+ tiles — blend + strands + new-territory — wrapped into a
  // messy 2-row grid). A selection made off-screen (most notably the
  // `highlightDomain` deep-link preselect from the frontier-moment / Summit
  // redirects, f7) must still scroll into view — mirrors web PlaylistCard's
  // same fix. RN's ScrollView has no DOM `scrollIntoView`, so this tracks each
  // tile's own x/width (via `onLayout`) plus the ScrollView's own viewport
  // (width via `onLayout`, current offset via `onScroll`) and computes the
  // minimal scroll needed to bring the active tile fully into view — the
  // native equivalent of `inline: "nearest"`.
  const scrollViewRef = useRef<ScrollView>(null);
  const tileOffsets = useRef<Map<string, { x: number; width: number }>>(new Map());
  const scrollX = useRef(0);
  const viewportWidth = useRef(0);
  const activeTileKey = stretchSelected
    ? "stretch"
    : selectedChoice
      ? `${selectedChoice.domain}::${selectedChoice.strand}`
      : "blend";
  useEffect(() => {
    const tile = tileOffsets.current.get(activeTileKey);
    if (!tile || !scrollViewRef.current) return;
    const viewStart = scrollX.current;
    const viewEnd = viewStart + viewportWidth.current;
    let target: number | null = null;
    if (tile.x < viewStart) {
      target = Math.max(0, tile.x - 8);
    } else if (tile.x + tile.width > viewEnd) {
      target = Math.max(0, tile.x + tile.width - viewportWidth.current + 8);
    }
    if (target !== null) scrollViewRef.current.scrollTo({ x: target, animated: true });
  }, [activeTileKey]);

  // Tapping a tile SELECTS it (or, tapping the already-selected strand tile
  // again, deselects back to the blend) — it never navigates and never logs.
  // Logging is deferred to Start itself (openPractice below), so a dabbled
  // select/deselect leaves no trace.
  const handleTileTap = (tapped: "blend" | "stretch" | ChoiceCard) => {
    disarmPendingHighlight();
    Haptics.selectionAsync().catch(() => {});
    if (tapped === "stretch") {
      const next = !stretchSelected;
      setStretchSelected(next);
      if (next) setStoredChoice(null);
      return;
    }
    setStretchSelected(false);
    setStoredChoice((current) => nextTileSelection(current, tapped));
  };

  // ── select-and-recompose: `rawActive`/`lastResolved` are HOOKS, so they must
  //    be declared unconditionally before the early returns below (rules of
  //    hooks) — `active` itself (the safe, always-defined derivation) is
  //    computed further down, once `playlist === undefined` has already
  //    returned null. `rawActive` is the BLEND when nothing is selected, or
  //    the recomposed preview once a strand tile is picked and its query has
  //    resolved — the exact set Start will actually serve. While that query is
  //    in flight, `lastResolved` keeps the rows on screen (a quiet shimmer via
  //    `isRecomposing`, never a layout jump). ──
  const rawActive = stretchSelected ? stretchPreview : selectedChoice ? choicePreview : playlist;
  const [lastResolved, setLastResolved] = useState<typeof playlist>(undefined);
  useEffect(() => {
    if (rawActive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Preserve the last resolved playlist while recomposition temporarily has no active result.
      setLastResolved(rawActive);
    }
  }, [rawActive]);

  // Everything needed to decide whether the playlist itself exists. This is
  // intentionally narrower than `loadingCard`: once these reads resolve to the
  // legacy nothing-to-serve state, optional masthead/chooser reads cannot make
  // the card visible, so do not keep its skeleton around for those stragglers.
  const loadingPresence =
    playlist === undefined ||
    mathPlan === undefined ||
    (autoBlend &&
      (domainsInfo === undefined || mapProgress === undefined));
  // The straggler fix (f7): `forceChooser` (any domain placed, or the check-in
  // otherwise underway) overrides the raw per-default-domain `needsPlacement`
  // so the chooser renders even though that single signal might still read
  // true — no longer gated on the FULL cross-domain check-in completing. The
  // derivation's `started` (any domain in flight or converged) subsumes the old
  // sitting-budget `paused` leg with fresher semantics: a sitting can only pause
  // after probes were answered, so a paused sitting is always a started check-in
  // (decision 6). A teacher pin (`!autoBlend`) never forces the chooser (its own
  // single-domain `playlist.needsPlacement` is the only gate, unchanged).
  const forceChooser = autoBlend && (anyDomainStarted || !!mapProgress?.started);
  const effectiveNeedsPlacement = (playlist?.needsPlacement ?? false) && !forceChooser;
  // The CTA's Start-vs-Resume verb, from the same derivation (decision 6) —
  // `started` is true once any domain is in flight or converged, so a scholar
  // who left the check-in mid-flight is never told to "Start" it again.
  const checkInStarted = autoBlend && !!mapProgress?.started;
  // The Stretch tile shows when `playlistForScholar` reports challenge items
  // available — zero new thresholds; candidate existence is the only gate.
  const showStretchTile = !!(playlist?.hasChallengeItems);
  // Nothing queued → no card at all.
  // A BLOCKED playlist is empty for a reason the scholar is owed: hiding the
  // card would make a teacher-drawn boundary silently indistinguishable from
  // having no math at all. So it stays visible to render the boundary line.
  const nothingToServe =
    !loadingPresence &&
    !scopeBlocked &&
    playlist!.set.length === 0 &&
    !playlist!.nextUp &&
    !playlist!.firstPostPlacementBlock &&
    effectiveNeedsPlacement === false;
  const visible = !loadingPresence && !nothingToServe;
  // One boundary for every remaining initial read that can change the visible
  // card's shape. The Tree hero crosses this boundary with the card below.
  const loadingCard =
    loadingPresence ||
    myCheckpoint === undefined ||
    choiceCards === undefined;
  // Same "has stuff to do" verdict the card's own copy already renders
  // ("all caught up" vs. an active playlist) — reused, not re-derived, so the
  // parent's Tree-hero-demotion decision can never disagree with what this
  // card is telling the scholar.
  const hasWork =
    visible && playlist !== undefined
      ? (() => {
          const verdict = derivePlaylistDoneness({
            set: playlist.set,
            nextUp: playlist.nextUp,
            firstPostPlacementBlock: playlist.firstPostPlacementBlock,
            blocked: (playlist as { blocked?: boolean }).blocked,
          });
          // Blocked is not work. `caughtUp` is deliberately false while blocked
          // (a boundary is not a finished day), so it has to be excluded here
          // or the Tree hero would demote behind a card offering nothing.
          return !verdict.caughtUp && !verdict.blocked;
        })()
      : false;

  // The playlist result itself is the first point at which legacy
  // nothing-to-serve can be known. Until then this skeleton is necessary for
  // visible playlists, so an empty result still has one honest residual
  // skeleton collapse; `loadingPresence` ensures no later query prolongs it.
  if (nothingToServe) {
    return (
      <>
        {completionHero}
        {checkInHero}
        {treeHero ?? null}
      </>
    );
  }

  // Neither real surface paints while this boundary is pending. The skeleton
  // targets 120pt including padding: the smallest real card's plain header plus
  // two rows. It deliberately omits optional masthead, chooser, and CTA height
  // so it may undershoot larger cards but never overshoots the minimum card.
  if (loadingCard) {
    return (
      <>
        {completionHero}
        <PracticePlaylistSkeleton
          eyebrow={eyebrow}
          eyebrowDetail={eyebrowDetail}
          styles={styles}
        />
      </>
    );
  }

  // `playlist` is narrowed to defined past the guards above, so this fallback
  // guarantees `active` is always defined too (never the transient `undefined`
  // `rawActive`/`lastResolved` could still be immediately after a fresh pick).
  const active = rawActive ?? lastResolved ?? playlist;
  const isRecomposing =
    (!!selectedChoice && choicePreview === undefined) ||
    (stretchSelected && stretchPreview === undefined);

  // Header-level fields are ALWAYS the BLEND's own — the header/meter/title
  // are a stable identity row above the tile fork, never themselves recomposed.
  // `blocked` keeps a plan boundary from reading as a finished day: a blocked
  // playlist arrives shaped exactly like one (empty set, no next up), so
  // without it the strip hands the scholar a green check and "— done".
  const { caughtUp: blendCaughtUp } = derivePlaylistDoneness({
    set: playlist.set,
    nextUp: playlist.nextUp,
    firstPostPlacementBlock: playlist.firstPostPlacementBlock,
    blocked: (playlist as { blocked?: boolean }).blocked,
  });
  // Raw count for the progress meter/receipt (not a done-ness verdict).
  const blendDoneCount = playlist.set.filter((s) => s.doneToday).length;
  const showTileRow =
    !effectiveNeedsPlacement && (availableChoiceCards.length > 0 || showStretchTile);

  const goalMin = effectiveStanding?.dailyGoalMinutes ?? null;
  const mastheadDateline = playlistMastheadDateline({
    effectiveNeedsPlacement,
    practicedToday: playlist.practicedToday,
    setLength: playlist.set.length,
    practicedCount: blendDoneCount,
    goalMin,
  });

  // Starting with a strand selected is a best-effort OBSERVATION log (never
  // blocks the navigation it drives) — a scholar choosing a strand is a signal
  // for teachers/observers, not a scholar-facing score. Starting the plain
  // blend logs nothing (mirrors the pre-existing "dabbling never counts" rule).
  // A strand selection overrides the whole checkin/mixed-domain resolution
  // below — it goes straight to the SAME ?choiceDomain=/?choiceStrand= route
  // the old tap-to-launch tiles used, unchanged.
  const {
    nextUp,
    set,
    practicedToday,
    firstPostPlacementBlock,
  } = active;
  const launchpad = active.launchpad;
  const { caughtUp, blocked: activeBlocked } = derivePlaylistDoneness({
    set,
    nextUp,
    firstPostPlacementBlock,
    blocked: (active as { blocked?: boolean }).blocked,
  });
  // Either the blend or a recomposed selection can be blocked (web parity).
  const noPracticeAvailable = scopeBlocked || activeBlocked;
  // `chosenPlaylist` feeds BOTH `deriveStartCta` and `expandMoreLabel` below —
  // a picked strand names itself in the CTA AND the collapsed-set expander
  // (Andy's play-session finding: "N more in today's set" read wrong once a
  // specific playlist was chosen; mirrors web PlaylistCard exactly).
  const chosenPlaylist = selectedChoice
    ? {
        strandLabel: strandHeadlineFor(
          selectedChoice.domain,
          selectedChoice.strand,
        ),
      }
    : null;
  const startCta = stretchSelected
    ? { verb: "Start Stretch", suffix: "→" as const, primary: true }
    : deriveStartCta(chosenPlaylist, {
        needsPlacement: effectiveNeedsPlacement,
        checkInStarted,
        caughtUp,
        practicedToday,
        hasNextUp: nextUp !== null,
      });

  // Resolve today's playlist domain set (mirrors web page.tsx): a teacher's mixed
  // pin (≥2 domains) → blend; a single-domain pin → that domain; else auto-blend
  // the scholar's started domains (≥2 → blend; a one-domain scholar stays single).
  const domainSet: string[] =
    effectiveStanding?.domains && effectiveStanding.domains.length > 1
      ? effectiveStanding.domains
      : effectiveStanding?.domain
        ? [effectiveStanding.domain]
        : planDomains;
  // A session-only switch becomes the explicit single-domain launch set.
  const selectedDomainSet = selectedDomain ? [selectedDomain] : domainSet;
  const isMixed = selectedDomainSet.length > 1;

  const openPractice = () => {
    Haptics.selectionAsync().catch(() => {});
    // Option D (OPTION_D_RULINGS): a fresh/unplaced scholar's Home CTA now opens
    // the DEFAULT mapping-folded playlist (plain `/practice`), NOT the retired
    // `?checkin=all` standalone check-in surface — an unmapped domain is a
    // `· mapping` band in the ordinary playlist. Mirrors web (which sets
    // includeMapping on the default entry). This closes the two-live-surfaces race.
    if (effectiveNeedsPlacement && autoBlend) {
      router.push(
        isMixed
          ? { pathname: "/practice", params: { domains: selectedDomainSet, blend: "1" } }
          : selectedDomainSet[0]
            ? { pathname: "/practice", params: { domain: selectedDomainSet[0], blend: "1" } }
            : "/practice",
      );
      return;
    }
    // Stretch selected — navigate into the challenge lane via stretchHint.
    // Uses the same domain routing as the blend, just with the stretch signal.
    if (stretchSelected) {
      router.push(
        isMixed
          ? { pathname: "/practice", params: { domains: selectedDomainSet, stretchHint: "1" } }
          : selectedDomainSet[0]
            ? { pathname: "/practice", params: { domain: selectedDomainSet[0], stretchHint: "1" } }
            : { pathname: "/practice", params: { stretchHint: "1" } },
      );
      return;
    }
    if (selectedChoice) {
      logPracticeChoice({
        domain: selectedChoice.domain,
        strand: selectedChoice.strand,
        source: "home_choice",
        clientPickId: makeClientPickId(),
        candidateSkillKeys: (choiceSet ?? []).map((c) => c.sampleSkillKey),
        playlistDomains: (choiceSet ?? []).map((c) => c.domain),
      }).catch(() => {
        // Best-effort — the scholar still gets to practice their pick even if
        // the observation log fails to write.
      });
      // The picked domain must ALSO travel as `domain`/`domains` — passing
      // ONLY `choiceDomain`/`choiceStrand` would silently collapse the
      // session to practice.tsx's single hardcoded default (discarding the
      // scholar's actual blend), since the choiceHint is layered on TOP of
      // whatever domain/domains those params separately resolve, never
      // derived from choiceDomain itself. A pick OUTSIDE the scholar's
      // started/blended set (a "new territory" tile — the fold-in of the old
      // "Explore a new territory" pills, f7) gets its OWN single-domain entry,
      // exactly like the old pill's `?domain=<slug>` link did.
      const inSet = selectedDomainSet.includes(selectedChoice.domain);
      router.push({
        pathname: "/practice",
        params: {
          choiceDomain: selectedChoice.domain,
          choiceStrand: selectedChoice.strand,
          // An in-set pick rides the DAILY BLEND (so it keeps the `· mapping`
          // band via ?blend=1); an out-of-set pick gets its own single-domain
          // entry, which folds mapping because choiceDomain === domain.
          ...(inSet
            ? isMixed
              ? { domains: selectedDomainSet, blend: "1" }
              : selectedDomainSet[0]
                ? { domain: selectedDomainSet[0], blend: "1" }
                : {}
            : { domain: selectedChoice.domain }),
        },
      });
      return;
    }
    router.push(
      isMixed
        ? { pathname: "/practice", params: { domains: selectedDomainSet, blend: "1" } }
        : selectedDomainSet[0]
          ? { pathname: "/practice", params: { domain: selectedDomainSet[0], blend: "1" } }
          : "/practice",
    );
  };

  // The multipack rows — built once so the card reads like Prep's list (mirrors
  // web PlaylistCard). The next-up skill always leads (even a teacher pin that's
  // outside the frontier set), then the rest of today's set in queue order.
  // Shows the top 3 by default; a quiet expander reveals the rest. Rows are
  // display-only — the single Start below drives the whole set.
  const DEFAULT_VISIBLE = 3;
  const nextInSet = nextUp ? set.some((s) => s.key === nextUp.key) : false;
  const goingDeeper =
    playlist.set.some((row) => row.reason === "stretch") ||
    myCheckpoint?.mode === "deeper";
  const blendTileHeadline = goingDeeper
    ? "Going deeper"
    : myCheckpoint
      ? "Toward your checkpoint"
      : "Today's blend";
  const rows: {
    key: string;
    label: string;
    kind: "next" | "queued" | "done";
    tag: string;
    /** What this row reads once it is NO LONGER next — see `withLaunchpadRow`.
     *  A doorway that leads the list demotes the skill behind it, and the tag
     *  has to move with the dot or the receipt names two next things. */
    queuedTag: string;
    muted: boolean;
    domain?: string;
  }[] = [];
  if (nextUp && !nextInSet) {
    const nextUpDomain =
      "domain" in nextUp && typeof nextUp.domain === "string" ? nextUp.domain : undefined;
    // Unreachable as a demotion target: the doorway is spliced at `at + 1` or
    // later whenever this row exists, so it is never the row behind it.
    rows.push({
      key: nextUp.key,
      label: nextUp.label,
      kind: "next",
      tag: nextUpTag(nextUp.reason),
      queuedTag: nextUpTag(nextUp.reason),
      muted: false,
      domain: nextUpDomain,
    });
  }
  set.forEach((row, i) => {
    const rowDomain =
      "domain" in row && typeof row.domain === "string"
        ? row.domain
        : undefined;
    const isNext = nextUp ? nextUp.key === row.key : rows.length === 0 && i === 0;
    const kind: "next" | "queued" | "done" = row.doneToday ? "done" : isNext ? "next" : "queued";
    const tag = row.doneToday
      ? "Done this block"
      : isNext
        ? nextUp
          ? nextUpTag(nextUp.reason)
          : "Next up"
        : reasonTag(row.reason);
    rows.push({
      key: row.key,
      label: row.label,
      kind,
      tag,
      queuedTag: row.doneToday ? "Done this block" : reasonTag(row.reason),
      muted: row.doneToday,
      domain: rowDomain,
    });
  });
  // Web parity (components/practice/PlaylistCard.tsx): the instructional doorway
  // is a beat of the run, so it is a row of the receipt. Same server-resolved
  // position, same shared splice, same "First look" label — a scholar on iPad
  // sees the same list a scholar on the web does.
  const rowsWithLaunchpad = launchpad
    ? withLaunchpadRow(rows, launchpad.at + (nextUp && !nextInSet ? 1 : 0), (kind) => ({
        key: "launchpad",
        label: launchpad.title,
        kind,
        tag: segmentBeatLabel("launchpad", true),
        queuedTag: segmentBeatLabel("launchpad", true),
        muted: false,
        domain: undefined,
      }))
    : rows;
  const visibleRows = expanded ? rowsWithLaunchpad : rowsWithLaunchpad.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = Math.max(0, rowsWithLaunchpad.length - DEFAULT_VISIBLE);

  return (
    <>
      {completionHero}
      {!hasWork ? treeHero : null}
      {checkInHero}
      <HomeSection label={eyebrow ?? ""} detail={eyebrowDetail} hidden={!eyebrow}>
        <View style={styles.card}>
      {/* "The Contents Rule" masthead (review/sketches-playlist-card-magazine.html
          §dirA) — ONE magazine masthead replacing BOTH the old checkpoint
          banner and the separate "Today's Math Playlists" header row/meter.
          Renders only when a checkpoint goal exists; no-checkpoint scholars
          keep today's plain strip below untouched. Top line: an eyebrow
          (checkered flag + "Working toward checkpoint" / "✓ Checkpoint
          reached", frontier gold vs. depth blue — same split as before) on
          the left, the day's dateline ("N of M skills practiced today", the
          same text that used to live in the strip's meter) quiet-muted on the
          right. The goal becomes a large cover headline (bigger than the old
          strip title), and the dot tally straightens into a full-width
          CONTENTS RULE — station dots joined by segment bars, the first
          `bandSolid` stations+segments filled solid in the mode accent, the
          rest hollow/hairline — read left-to-right as a progress spine
          instead of a badge. The mode sub-line drops to a quiet rule-caption
          underneath. */}
      {myCheckpoint ? (
        <View style={styles.mast}>
          <View style={styles.mastTop}>
            <View style={styles.mastEyebrow}>
              <CheckpointFlagIcon
                size={15}
                color={myCheckpoint.mode === "deeper" ? colors.indigo : FRONTIER_GOLD}
              />
              <Text
                style={[
                  styles.mastEyebrowText,
                  { color: myCheckpoint.mode === "deeper" ? colors.indigo : FRONTIER_GOLD },
                ]}
              >
                {myCheckpoint.mode === "deeper" ? "✓ Checkpoint reached" : "Working toward checkpoint"}
              </Text>
            </View>
            {mastheadDateline ? (
              <Text style={styles.mastDateline} numberOfLines={1}>
                {mastheadDateline}
              </Text>
            ) : null}
          </View>
          <Text style={styles.mastHead} numberOfLines={2}>
            {`Grade ${myCheckpoint.grade} · ${myCheckpoint.strandLabel}`}
          </Text>
          <View style={styles.mastRule} accessibilityElementsHidden>
            {Array.from({ length: myCheckpoint.bandTotal }, (_, i) => {
              const stationFilled = i < myCheckpoint.bandSolid || myCheckpoint.mode === "deeper";
              const segFilled = myCheckpoint.mode === "deeper" || i < myCheckpoint.bandSolid - 1;
              const accent = myCheckpoint.mode === "deeper" ? colors.indigo : FRONTIER_GOLD;
              return (
                <Fragment key={i}>
                  <View
                    style={[
                      styles.mastStation,
                      stationFilled && { backgroundColor: accent, borderColor: accent },
                    ]}
                  />
                  {i < myCheckpoint.bandTotal - 1 ? (
                    <View
                      style={[styles.mastSeg, segFilled && { backgroundColor: accent }]}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </View>
          <Text style={styles.mastCaption} numberOfLines={2}>
            {myCheckpoint.mode === "deeper"
              ? "Now going deeper — harder problems, new angles on the same ideas."
              : "Today leans here — reviews keep older skills sharp."}
          </Text>
        </View>
      ) : null}
      {/* Strip: glyph + neutral title + a done/queued meter. Pre-placement the
          CTA opens the check-in (placement quiz), not the daily set, so the
          strip names it a "Math Check-In" and the meter is off. Pluralizes to
          "Today's Math Playlists" exactly when the tile row below is showing
          (mirrors web); the meter/title stay BLEND-anchored — a stable
          identity row above the tile fork, never itself recomposed. Folded
          into the masthead above when a checkpoint goal exists (its title +
          meter would just repeat the masthead's dateline). */}
      {myCheckpoint ? null : (
        <View style={styles.strip}>
          <Text
            style={[
              styles.glyph,
              { color: blendCaughtUp && !effectiveNeedsPlacement ? colors.statusGreen : colors.teal },
            ]}
          >
            {GLYPH}
          </Text>
          <Text style={styles.stripTitle}>
            {effectiveNeedsPlacement
              ? CHECK_IN_HOME_TITLE
              : playlist.firstPostPlacementBlock
                ? "Your First Math Playlist"
                : `Today's Math ${showTileRow ? "Playlists" : "Playlist"}${blendCaughtUp ? " — done" : ""}`}
          </Text>
          {switchableDomains.length > 1 ? (
            <Pressable
              onPress={() => setDomainSwitcherOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Switch math domain, currently ${practiceDomainLabel(playlist.domain)}`}
            >
              <Text style={styles.domainSwitch}>{practiceDomainLabel(playlist.domain)} ▾</Text>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          {effectiveNeedsPlacement ? null : playlist.practicedToday && playlist.set.length > 0 ? (
            <View style={styles.meterRow}>
              <View style={styles.meterTrack}>
                <View
                  style={[
                    styles.meterFill,
                    { width: `${Math.round((blendDoneCount / playlist.set.length) * 100)}%` },
                  ]}
                />
              </View>
              <Text style={styles.meterText} numberOfLines={1}>
                {blendDoneCount} of {playlist.set.length} skills practiced today
              </Text>
            </View>
          ) : goalMin ? (
            <Text style={styles.stripTime}>~{goalMin} min</Text>
          ) : null}
        </View>
      )}
      {scopeSentence ? (
        <Text style={styles.scopeSentence}>{scopeSentence}</Text>
      ) : null}
      {noPracticeAvailable ? (
        <View>
          <Text style={styles.blockedHeadline}>{PRACTICE_SCOPE_BLOCKED_HEADLINE}</Text>
          <Text style={styles.blockedDetail}>{PRACTICE_SCOPE_BLOCKED_DETAIL}</Text>
        </View>
      ) : null}
      <DomainSwitcherSheet
        open={domainSwitcherOpen}
        onClose={() => setDomainSwitcherOpen(false)}
        currentDomain={playlist.domain}
        activeDomains={switchableDomains.map((domain, index) => ({
          domain,
          isPrimary: index === 0,
        }))}
        practiceScope={mathPlan?.practiceScope}
        onSelect={(domain) => {
          setSelectedDomain(domain);
          setStoredChoice(null);
          setStretchSelected(false);
          setDomainSwitcherOpen(false);
        }}
      />

      {/* The tile row — peer SELECTIONS under the strip's headline above:
          "Today's blend" (the default set, pre-selected) + up to 3 bounded
          frontier strand cards + "new territory" domain tiles + the folded-in
          check-in re-entry. A single-row horizontal CAROUSEL (Andy's play-
          session finding: 9+ tiles wrapped into a messy 2-row grid) — fixed-
          width tiles, snap-to-tile scrolling, no visible scrollbar. Tapping a
          tile never navigates — it recomposes the body below to the SAME set
          Start will actually serve. Hidden pre-placement (nothing to choose
          from yet) and whenever there's nothing to offer. */}
      {showTileRow ? (
        <View style={styles.youPick}>
          <ScrollView
            ref={scrollViewRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={TILE_WIDTH + TILE_GAP}
            snapToAlignment="start"
            onLayout={(e) => {
              viewportWidth.current = e.nativeEvent.layout.width;
            }}
            onScroll={(e) => {
              scrollX.current = e.nativeEvent.contentOffset.x;
            }}
            scrollEventThrottle={16}
            contentContainerStyle={styles.youPickRow}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: !selectedChoice && !stretchSelected }}
              accessibilityLabel={`Select ${blendTileHeadline}`}
              onPress={() => handleTileTap("blend")}
              onLayout={(e) => {
                tileOffsets.current.set("blend", { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width });
              }}
              style={({ pressed }) => [
                styles.youPickTile,
                !selectedChoice && !stretchSelected && styles.youPickTileSelected,
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={styles.youPickIcon}>
                <TileIcon
                  name={
                    goingDeeper
                      ? "Anchor"
                      : myCheckpoint
                        ? "Mountains"
                      : playlistTileIconName("blend")
                  }
                  color={!selectedChoice && !stretchSelected ? colors.violetSolid : colors.charcoalMuted}
                />
              </View>
              <Text
                style={[styles.youPickHeadline, !selectedChoice && !stretchSelected && styles.youPickHeadlineSelected]}
                numberOfLines={2}
              >
                {blendTileHeadline}
              </Text>
              <Text
                style={[styles.youPickSubtitle, !selectedChoice && !stretchSelected && styles.youPickSubtitleSelected]}
                numberOfLines={2}
              >
                {goingDeeper
                  ? "Same ideas, harder problems"
                  : "Reviews + new skills"}
              </Text>
            </Pressable>
            {availableChoiceCards.map((card) => {
              const selected =
                !!selectedChoice &&
                selectedChoice.domain === card.domain &&
                selectedChoice.strand === card.strand;
              const tileKey = `${card.domain}::${card.strand}`;
              return (
                <Pressable
                  key={tileKey}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Select ${strandHeadlineFor(card.domain, card.strand)}`}
                  onPress={() => handleTileTap(card)}
                  onLayout={(e) => {
                    tileOffsets.current.set(tileKey, { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width });
                  }}
                  style={({ pressed }) => [
                    styles.youPickTile,
                    selected && styles.youPickTileSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  {card.isNew && <Text style={styles.youPickNewBadge}>NEW</Text>}
                  <View style={styles.youPickIcon}>
                    <TileIcon
                      name={playlistTileIconName(card.isNew ? "new-territory" : "strand", card.domain)}
                      color={selected ? colors.violetSolid : colors.charcoalMuted}
                    />
                  </View>
                  <Text
                    style={[styles.youPickHeadline, selected && styles.youPickHeadlineSelected]}
                    numberOfLines={2}
                  >
                    {strandHeadlineFor(card.domain, card.strand)}
                  </Text>
                  <Text
                    style={[styles.youPickSubtitle, selected && styles.youPickSubtitleSelected]}
                    numberOfLines={2}
                  >
                    {superscriptExponents(card.sampleSkillLabel)}
                  </Text>
                </Pressable>
              );
            })}
            {showStretchTile && (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: stretchSelected }}
                accessibilityLabel={STRETCH_TILE_ARIA_LABEL}
                onPress={() => handleTileTap("stretch")}
                onLayout={(e) => {
                  tileOffsets.current.set("stretch", { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width });
                }}
                style={({ pressed }) => [
                  styles.youPickTile,
                  stretchSelected && styles.youPickTileSelected,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <View style={styles.youPickIcon}>
                  <TileIcon
                    name={playlistTileIconName("stretch")}
                    color={stretchSelected ? colors.violetSolid : colors.charcoalMuted}
                  />
                </View>
                <Text
                  style={[styles.youPickHeadline, stretchSelected && styles.youPickHeadlineSelected]}
                  numberOfLines={2}
                >
                  {STRETCH_TILE_HEADLINE}
                </Text>
                <Text
                  style={[styles.youPickSubtitle, stretchSelected && styles.youPickSubtitleSelected]}
                  numberOfLines={2}
                >
                  {STRETCH_TILE_SUBTITLE}
                </Text>
              </Pressable>
            )}
          </ScrollView>
        </View>
      ) : null}

      {/* Body — the recomposed preview: top 3 rows by default, hairline above
          every row, with a quiet expander for the rest (mirrors web
          PlaylistCard). Pre-placement, a short check-in framing instead.
          Opacity-shimmers (never a layout jump, never a skeleton) while a
          selected strand's preview query is in flight. */}
      <View style={{ opacity: isRecomposing ? 0.55 : 1 }} pointerEvents={isRecomposing ? "none" : "auto"}>
        {effectiveNeedsPlacement ? (
          <View style={styles.body}>
            <Text style={styles.caughtUp}>
              A few math questions to find where to start. Then your daily
              playlist picks up right where you&apos;re ready to grow.
            </Text>
          </View>
        ) : caughtUp ? (
          <View style={styles.body}>
            <Text style={styles.caughtUp}>
              You&apos;re all caught up — every skill in today&apos;s set is fresh.
            </Text>
          </View>
        ) : (
          <View>
            {/* No standalone day-attribution line — the banner's sub-line IS
                the attribution (a second sentence restating it below the
                carousel read as clutter; T3). Mirrors web PlaylistCard. */}
            {visibleRows.map((row) => (
              <PlaylistRow
                key={row.key}
                row={row}
                showDivider
                styles={styles}
                colors={colors}
              />
            ))}
            {hiddenCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={expanded ? "Hide the rest of today's set" : "Show more of today's set"}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setExpanded((e) => !e);
                }}
                style={({ pressed }) => [styles.more, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.moreCaret}>{expanded ? "▴" : "▾"}</Text>
                <Text style={styles.moreText}>
                  {expanded ? "Hide" : expandMoreLabel(hiddenCount, chosenPlaylist)}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      {/* Suppressed when the plan blocks practice: Start would open a run with
          nothing in it, so the boundary line above is the whole message.
          Mirrors the web twin. */}
      {noPracticeAvailable ? null : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={practiceCtaAccessibleLabel(startCta, {
          hasSelectedChoice: !!selectedChoice || stretchSelected,
          needsPlacement: effectiveNeedsPlacement,
          caughtUp,
          practicedToday,
          nextUpLabel: nextUp?.label ?? null,
          firstPostPlacementBlock,
        })}
        onPress={openPractice}
        style={({ pressed }) => [
          styles.ctaWrap,
          pressed && { opacity: 0.85 },
        ]}
      >
        <View
          style={[
            styles.cta,
            startCta.primary ? styles.ctaPrimary : styles.ctaSecondary,
          ]}
        >
          <Text
            style={[
              styles.ctaText,
              startCta.primary
                ? styles.ctaTextPrimary
                : styles.ctaTextSecondary,
            ]}
          >
            {startCta.verb}
            {startCta.suffix === "?" ? "?" : "  →"}
          </Text>
        </View>
      </Pressable>
      )}
        </View>
      </HomeSection>
      {hasWork ? treeHero : null}
    </>
  );
}

function PracticePlaylistSkeleton({
  eyebrow,
  eyebrowDetail,
  styles,
}: {
  eyebrow?: string;
  eyebrowDetail?: string | null;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <HomeSection
      label={eyebrow ?? ""}
      detail={eyebrowDetail}
      hidden={!eyebrow}
    >
      <View style={[styles.card, styles.skeletonCard]}>
        <Skeleton width="42%" height={14} radius={7} />
        <Skeleton height={32} radius={10} />
        <Skeleton height={32} radius={10} />
      </View>
    </HomeSection>
  );
}

function nextUpTag(reason: "teacher" | "review" | "next"): string {
  if (reason === "teacher") return "Your teacher set this next";
  if (reason === "review") return "Review, keeps it sharp";
  return "Next up";
}

function reasonTag(reason: "review" | "new" | "mapping" | "stretch"): string {
  if (reason === "mapping") return "· mapping";
  if (reason === "stretch") return "Go deeper";
  return reason === "review" ? "Review, keeps it sharp" : "In your set";
}

type PlaylistRowData = {
  key: string;
  label: string;
  kind: "next" | "queued" | "done";
  tag: string;
  muted: boolean;
  domain?: string;
};

/** Session-progress dot: ● next (violet ring) · ◌ queued (dashed) · ✓ done (green). */
function SessionDot({
  kind,
  styles,
  colors,
}: {
  kind: "next" | "queued" | "done";
  styles: ReturnType<typeof makeStyles>;
  colors: ColorSet;
}) {
  if (kind === "done") {
    return (
      <View style={[styles.dotBase, { backgroundColor: colors.green }]}>
        <Text style={styles.dotCheck}>✓</Text>
      </View>
    );
  }
  if (kind === "next") {
    return (
      <View style={[styles.dotBase, styles.dotNext]}>
        <View style={styles.dotNextInner} />
      </View>
    );
  }
  return <View style={[styles.dotBase, styles.dotQueued]} />;
}

function PlaylistRow({
  row,
  showDivider,
  styles,
  colors,
}: {
  row: PlaylistRowData;
  showDivider: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ColorSet;
}) {
  return (
    <View style={[styles.row, !showDivider && styles.rowNoDivider]}>
      <SessionDot kind={row.kind} styles={styles} colors={colors} />
      <Text
        style={[
          styles.rowLabel,
          row.kind === "next" ? styles.rowLabelNext : null,
          row.muted ? styles.rowLabelMuted : null,
        ]}
        numberOfLines={1}
      >
        {superscriptExponents(row.label)}
      </Text>
      {row.domain ? (
        <View style={styles.rowDomainChip}>
          <Text style={styles.rowDomainChipText} numberOfLines={1}>
            {practiceDomainLabel(row.domain)}
          </Text>
        </View>
      ) : null}
      <Text style={styles.rowTag}>{row.tag}</Text>
    </View>
  );
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(c: ColorSet) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
    },
    skeletonCard: {
      padding: 12,
      gap: 9,
    },
    // "You pick" — a hairline-bottomed strip above the main strip; the tiles
    // are even-bordered (no accent stripe) and equal-weight to each other.
    youPick: {
      paddingHorizontal: 14,
      paddingTop: 12,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    // "Today's Math Playlists" tile row — a horizontal CAROUSEL (Andy's play-
    // session finding: wrapping into a 2-row grid at 9+ tiles read as a mess)
    // of even-bordered peer tiles ("Today's blend" + up to 3 strand cards +
    // "new territory" domains + the check-in re-entry); a selected tile gets
    // a violet ring + tint, the same selection language used elsewhere in the
    // app. `paddingRight` on the row keeps the LAST tile from sticking flush
    // to the card's edge when scrolled to the end.
    youPickRow: { flexDirection: "row", gap: TILE_GAP, paddingRight: 6 },
    youPickTile: {
      width: TILE_WIDTH,
      position: "relative",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.gray200,
      backgroundColor: c.bg,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    youPickTileSelected: {
      borderColor: c.violet,
      backgroundColor: c.violetSubtle,
    },
    youPickIcon: { marginBottom: 6 },
    youPickHeadline: { fontFamily: fonts.bold, fontSize: 13, color: c.charcoal },
    youPickHeadlineSelected: { color: c.violetSolid },
    youPickSubtitle: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.charcoalMuted,
      marginTop: 2,
    },
    youPickSubtitleSelected: { color: c.violet },
    // The "new territory" accent — a subtle corner mark, no new component
    // family (the fold-in of the old "Explore a new territory" pills, f7).
    youPickNewBadge: {
      position: "absolute",
      top: 6,
      right: 8,
      fontFamily: fonts.bold,
      fontSize: 9,
      letterSpacing: 0.4,
      color: c.teal,
    },
    strip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    // "The Contents Rule" masthead (review/sketches-playlist-card-magazine.html
    // §dirA) — the ONE header a checkpoint goal renders: eyebrow + dateline on
    // top, the goal as a cover headline, a full-width station-dot rule, and a
    // quiet rule-caption. Replaces the old flat `checkpointBanner` AND the
    // separate strip title/meter row (folded into the dateline above).
    mast: {
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    mastTop: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 10,
    },
    mastEyebrow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
    },
    mastEyebrowText: {
      fontFamily: fonts.bold,
      fontSize: 10,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    mastDateline: {
      fontFamily: fonts.semibold,
      fontSize: 11,
      color: c.charcoalMuted,
      flexShrink: 0,
    },
    // The cover headline — the goal, bigger than the old strip title so the
    // eye lands on "what band I'm in" first.
    mastHead: {
      fontFamily: fonts.bold,
      fontSize: 21,
      lineHeight: 24,
      color: c.charcoal,
      marginTop: 5,
      letterSpacing: -0.2,
    },
    // The contents rule — station dots joined by segment bars, spanning the
    // full card width. Filled stations/segments (mode accent) trail off into
    // hollow/hairline for the rest of the band; scales to any `bandTotal`.
    mastRule: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 12,
    },
    mastStation: {
      flexShrink: 0,
      width: 12,
      height: 12,
      borderRadius: 999,
      backgroundColor: c.bg,
      borderWidth: 2,
      borderColor: c.gray300,
    },
    mastSeg: {
      flex: 1,
      height: 2,
      backgroundColor: c.gray200,
    },
    mastCaption: {
      fontFamily: fonts.regular,
      fontSize: 11,
      color: c.charcoalMuted,
      marginTop: 6,
    },
    // Day-attribution sentence — one line at the top of the served set,
    // styled like the existing `caughtUp` empty-state copy.
    checkpointAttribution: {
      fontFamily: fonts.regular,
      fontSize: 13,
      color: c.fgMuted,
      lineHeight: 18,
      marginBottom: 6,
    },
    glyph: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 20 },
    stripTitle: {
      flexShrink: 1,
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.3,
      color: c.charcoalMuted,
    },
    domainSwitch: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      color: c.violetSolid,
    },
    meterRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    meterTrack: {
      width: 52,
      height: 6,
      borderRadius: 999,
      backgroundColor: c.gray200,
      overflow: "hidden",
    },
    meterFill: { height: "100%", backgroundColor: c.green, borderRadius: 999 },
    meterText: { fontFamily: fonts.semibold, fontSize: 12, color: c.charcoalSubtle },
    stripTime: { fontFamily: fonts.regular, fontSize: 12, color: c.charcoalMuted },
    body: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
    caughtUp: { fontFamily: fonts.regular, fontSize: 14, color: c.fgMuted, lineHeight: 20 },
    // Multipack rows — a hairline above every row (incl. the first), 18px dot.
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: c.gray100,
    },
    scopeSentence: {
      paddingHorizontal: 14,
      paddingTop: 10,
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 18,
      color: c.charcoalMuted,
    },
    blockedHeadline: {
      paddingHorizontal: 14,
      paddingTop: 10,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: c.charcoalMuted,
    },
    blockedDetail: {
      paddingHorizontal: 14,
      paddingTop: 4,
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 18,
      color: c.fgMuted,
    },
    rowNoDivider: { borderTopWidth: 0 },
    dotBase: {
      width: 18,
      height: 18,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
    },
    dotNext: { borderWidth: 2, borderColor: c.violet },
    dotNextInner: { width: 6, height: 6, borderRadius: 999, backgroundColor: c.violet },
    dotQueued: { borderWidth: 1.5, borderStyle: "dashed", borderColor: c.gray300 },
    dotCheck: { color: c.white, fontSize: 10, fontFamily: fonts.bold, lineHeight: 12 },
    rowLabel: { flex: 1, minWidth: 0, fontFamily: fonts.medium, fontSize: 14, color: c.charcoal },
    rowLabelNext: { fontFamily: fonts.bold },
    rowLabelMuted: { color: c.charcoalSubtle },
    rowDomainChip: {
      flexShrink: 0,
      maxWidth: 132,
      borderWidth: 1,
      borderColor: c.gray200,
      borderRadius: 999,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    rowDomainChipText: {
      fontFamily: fonts.semibold,
      fontSize: 10,
      color: c.charcoalMuted,
    },
    rowTag: { fontFamily: fonts.regular, fontSize: 12, color: c.charcoalSubtle },
    // Quiet expander — a hairline-topped toggle mirroring the web caret button.
    more: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: c.gray100,
    },
    moreCaret: { fontFamily: fonts.bold, fontSize: 11, color: c.charcoalMuted },
    moreText: { fontFamily: fonts.regular, fontSize: 12, color: c.charcoalMuted },
    ctaWrap: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
    cta: {
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
      paddingVertical: 12,
    },
    ctaPrimary: { backgroundColor: c.teal },
    ctaSecondary: { backgroundColor: c.gray50, borderWidth: 1, borderColor: c.border },
    ctaText: { fontFamily: fonts.bold, fontSize: 15 },
    ctaTextPrimary: { color: c.white },
    ctaTextSecondary: { color: c.navy },
  });
}
