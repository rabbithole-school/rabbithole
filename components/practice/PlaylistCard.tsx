"use client";

/**
 * PlaylistCard — the scholar-home "Today's Math Playlists" (raise-the-ceiling
 * plan §3 + the §C-2 select-and-recompose follow-up). Replaces the old generic
 * "Math Practice" CTA with a container card that says what today's practice
 * block actually holds: the single next-up skill, the rest of today's set, how
 * much is already done this block, and — when the engine has bounded frontier
 * choices to offer — a row of PEER playlist tiles ("Today's blend" + up to 3
 * strand cards) a scholar can select before starting.
 *
 * Ships as Option C (decided): the strip + the one next-up row + the CTA,
 * collapsed by default, with a quiet "N more in today's set ⌄" that expands to
 * the full set (Option A). One component, two densities — mirrors ActivityCard's
 * detailed/compact split.
 *
 * Identity is a coloured SLOT (the ∴ glyph in practice-teal) on a NEUTRAL strip
 * — never a colour-coded surface (the card system signals origin by slots). The
 * row dots read SESSION progress (● next · ◌ queued · ✓ done this block),
 * deliberately NOT the map's mastery/evidence colours: a skill turning fluent is
 * surfaced on the map + the wrap, never by a row going green here, so §2's
 * "green = fluent" invariant stays intact.
 *
 * Data: api.practiceSkills.playlistForScholar (frontier + review engine +
 * practiced-today). The standing-assignment framing (goal minutes) is merged in
 * from the `standing` prop (standingPractice.myActiveStanding), mirroring how
 * the home already builds its practice link.
 *
 * Select-and-recompose (tiles are SELECTIONS, never launch buttons): tapping a
 * tile is a controlled selection (`selectedChoice`/`onSelectChoice`, owned by
 * the page so it can fire the recomposed-preview query — see app/scholar/
 * page.tsx) — it never navigates. The preview list below the tiles recomposes
 * to the SAME set Start would actually serve (the `preview` prop, fetched via
 * `playlistForScholar`'s optional `choiceHint`, the identical composition path
 * `practiceSession` uses — no forked logic). The CTA relabels to
 * "Start with <strand headline> →"; picking logs nothing — `logPracticeChoice`
 * fires only when Start is actually pressed with a strand selected (see
 * `handleStartClick` below), never on a dabbled select/deselect.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Box, Flex, HStack, Text, Link as ChakraLink, chakra } from "@chakra-ui/react";
import {
  ArrowLineUp,
  BracketsCurly,
  CaretDown,
  CaretUp,
  Calculator,
  ChartPieSlice,
  Compass,
  DiceFive,
  FlagCheckered,
  Function as FunctionIcon,
  GridFour,
  MathOperations,
  Mountains,
  Anchor,
  Percent,
  Ruler,
  Shuffle,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
// The check-in title is the SAME string the accelerator card renders — the two
// surfaces hand off across `started`, so a hand-typed twin here would let the
// scholar see two spellings of one name across one lifecycle. Shared constant,
// never a drift copy (shared/checkInMapCopy.ts file header).
import { CHECK_IN_HOME_TITLE } from "@/shared/checkInMapCopy";
import { superscriptExponents } from "@/shared/mathNotation";
import { practiceDomainLabel, strandHeadlineFor } from "@/shared/practiceDomainLabels";
import { segmentBeatLabel, withLaunchpadRow } from "@/shared/practiceSegments";
import { derivePlaylistDoneness, playlistMastheadDateline } from "@/shared/playlistDoneness";
import {
  deriveStartCta,
  effectiveDomainSet,
  expandMoreLabel,
  isDomainOutsideEffectiveSet,
  nextTileSelection,
  playlistTileIconName,
  practiceCtaAccessibleLabel,
} from "@/shared/practiceChoiceSelection";
import {
  STRETCH_TILE_HEADLINE,
  STRETCH_TILE_SUBTITLE,
  STRETCH_TILE_ARIA_LABEL,
} from "@/shared/practiceLoop";
import {
  PRACTICE_SCOPE_BLOCKED_DETAIL,
  PRACTICE_SCOPE_BLOCKED_HEADLINE,
  practiceScopeSentence,
  scopeAllowsChoice,
  scopeAllowsDomain,
  type PracticeScope,
} from "@/shared/mathPlanScope";
import { Surface } from "@/components/ui/Surface";
import { DomainSwitcherDrawer } from "@/components/practice/DomainSwitcherDrawer";
import {
  RECEIPT_LEAD_W,
  RECEIPT_LEAD_GAP,
  RECEIPT_ROW_PX,
  RECEIPT_ROW_PY,
  RECEIPT_ROW_DIVIDER_COLOR,
  RECEIPT_TAG_FONT_SIZE,
  RECEIPT_TAG_COLOR,
  RECEIPT_LABEL_FONT_SIZE,
} from "@/components/practice/receiptRowStyle";

// Tile icons — resolves the framework-free NAME shared/practiceChoiceSelection's
// `playlistTileIconName` returns to the actual Phosphor component. The map's
// keys MUST cover every name that function can return (asserted implicitly:
// an unmapped name renders no icon rather than crashing — see `TileIcon`
// below — but the shared module's own test pins the exact name set, so a
// drift here would only show up visually, not as a build error).
const TILE_ICONS: Record<string, PhosphorIcon> = {
  ArrowLineUp,
  BracketsCurly,
  Shuffle,
  Mountains,
  Anchor,
  Compass,
  Calculator,
  ChartPieSlice,
  DiceFive,
  Ruler,
  Percent,
  GridFour,
  Function: FunctionIcon,
  MathOperations,
};

function TileIcon({ name, selected }: { name: string; selected: boolean }) {
  const Icon = TILE_ICONS[name];
  if (!Icon) return null;
  return (
    <Icon
      size={20}
      weight={selected ? "fill" : "regular"}
      color={selected ? "var(--chakra-colors-violet-500)" : "var(--chakra-colors-charcoal-400)"}
    />
  );
}

// The practice-teal ∴ glyph — the retired Math-Practice card's identity, kept
// as a coloured slot (not a surface tint). #16707e is the practice teal.
const GLYPH = "∴";
const GLYPH_COLOR = "#16707e";

// Shared lead-column geometry with UnitGroupCard: an 18px leading glyph + a
// 10px gap keeps the strip title, the row titles, and the CTA on one grid
// line. Also exported (via receiptRowStyle) to DailyRecapCard, the sibling
// "receipt" card on scholar-home, so the two cards' rows align exactly.
const LEAD_W = RECEIPT_LEAD_W;
const LEAD_GAP = RECEIPT_LEAD_GAP;

const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "-2px",
} as const;

type RowReason = "review" | "new" | "mapping" | "stretch";
type SetRow = {
  key: string;
  label: string;
  reason: RowReason;
  strand: string;
  doneToday: boolean;
  /** Present ONLY when this row's domain differs from the playlist's current
   *  domain (an out-of-current-domain due review). The wire omits it for
   *  same-domain rows. Drives the small muted domain chip. */
  domain?: string;
};
type NextUp = {
  key: string;
  label: string;
  reason: "teacher" | "review" | "next";
  domain?: string;
};

/** One api.practiceSkills.choiceSetForSelf / newTerritoryCards card — a
 *  bounded frontier choice, rendered as a peer tile alongside "Today's blend"
 *  (see PlaylistOptionTile below). */
export type ChoiceCard = {
  domain: string;
  domainLabel: string;
  strand: string;
  sampleSkillKey: string;
  sampleSkillLabel: string;
  /** True for a `newTerritoryCards` entry (a domain the scholar hasn't started
   *  yet) — the fold-in of the old standalone "Explore a new territory" pills
   *  (raise-the-ceiling consolidation, f7). Draws a subtle "NEW" accent, never
   *  a new component family. */
  isNew?: boolean;
};

/** The api.practiceSkills.playlistForScholar payload. The BLEND (default,
 *  no-hint) copy is owned + fetched by the scholar-home page so Home can place
 *  it relative to the Tree hero without giving this presentational card its own
 *  query. A strand SELECTION's recomposed preview is a second, page-fetched
 *  query with `choiceHint` set. */
export type PlaylistData = {
  domain: string;
  nextUp: NextUp | null;
  set: SetRow[];
  practicedToday: boolean;
  skillsPracticedToday: number;
  everPracticed: boolean;
  /** True when the scholar still needs the one-time placement quiz first — the
   *  CTA launches a check-in, NOT the daily set, so the card says so. */
  needsPlacement: boolean;
  /** True until the scholar records the first real drill after placement. */
  firstPostPlacementBlock: boolean;
  /** True when the session's challenge tail is non-empty — the ONLY condition
   *  that shows the Stretch playlist tile. Zero new thresholds; candidate
   *  existence is the sole gate. */
  hasChallengeItems?: boolean;
  /** Option D (Q6): the preview `set` is the `· mapping` composition Start will
   *  serve for this domain (rows tagged reason "mapping"), so the Home preview
   *  and Start never disagree. */
  mappingPreview?: boolean;
  /** Option D: the previewed run is 100% mapping (nothing else servable). */
  allMapping?: boolean;
  /** The instructional doorway Start will actually open with, and the `set`
   *  index it sits before (P1 follow-up). Resolved server-side by the SAME
   *  `resolveRunLaunchpad` the run uses, so listing it here can't invent a beat
   *  the run won't serve. Absent when there is none. */
  launchpad?: { at: number; title: string; subtitle?: string; domain: string; strand: string };
  /** The server's Math-plan boundary flag (`practiceSkills.playlistForScholar`):
   *  the scholar's plan leaves NOTHING servable — a requested domain outside
   *  scope, or no in-scope domain to resolve at all. It arrives shaped exactly
   *  like a finished day (`set: []`, `nextUp: null`), so the card must read this
   *  flag rather than infer done-ness, or it congratulates a scholar for a
   *  boundary a teacher drew. Never derived from the scope's SHAPE — a limited
   *  scope is usually perfectly servable. */
  blocked?: boolean;
};

/** Narrow local shape of `api.mathFocus.myMathCheckpoint`'s result — cast here
 *  because the vendored/generated Convex types haven't caught up yet with the
 *  parallel backend extension (QB regenerates before merge). `mode` splits the
 *  ONE banner into two states: still mapping toward the checkpoint ("toward")
 *  vs. already there and now going deeper on the same band ("deeper").
 *  `bandSolid`/`bandTotal` drive the dot tally (solid dots out of the total).
 *  Mirrors native's `MathCheckpoint`. */
type MathCheckpoint = {
  grade: string;
  strandLabel: string;
  mode: "toward" | "deeper";
  bandSolid: number;
  bandTotal: number;
};

/** Session-progress dot: ● next (violet) · ◌ queued (dashed) · ✓ done this block (green). */
function SessionDot({ kind }: { kind: "next" | "queued" | "done" }) {
  if (kind === "done") {
    return (
      <Flex
        w={LEAD_W}
        h={LEAD_W}
        flexShrink={0}
        rounded="full"
        bg="green.500"
        color="white"
        align="center"
        justify="center"
        fontSize="10px"
        fontWeight="bold"
        aria-hidden
      >
        ✓
      </Flex>
    );
  }
  if (kind === "next") {
    return (
      <Flex
        w={LEAD_W}
        h={LEAD_W}
        flexShrink={0}
        rounded="full"
        borderWidth="2px"
        borderColor="violet.500"
        align="center"
        justify="center"
        aria-hidden
      >
        <Box w="6px" h="6px" rounded="full" bg="violet.500" />
      </Flex>
    );
  }
  return (
    <Box
      w={LEAD_W}
      h={LEAD_W}
      flexShrink={0}
      rounded="full"
      borderWidth="1.5px"
      borderStyle="dashed"
      borderColor="gray.300"
      aria-hidden
    />
  );
}

function reasonTag(reason: RowReason): string {
  if (reason === "mapping") return "· mapping";
  if (reason === "stretch") return "Go deeper";
  return reason === "review" ? "Review, keeps it sharp" : "In your set";
}

function nextUpTag(reason: NextUp["reason"]): string {
  if (reason === "teacher") return "Your teacher set this next";
  if (reason === "review") return "Review, keeps it sharp";
  return "Next up";
}

function PlaylistRow({
  label,
  tag,
  kind,
  muted,
  showDivider,
  domainChip,
}: {
  label: string;
  tag: string;
  kind: "next" | "queued" | "done";
  muted?: boolean;
  showDivider: boolean;
  /** A small muted domain-label chip for an out-of-current-domain sweep review
   *  (plan §7a). Absent for same-domain rows. */
  domainChip?: string;
}) {
  return (
    <Flex
      align="center"
      gap={LEAD_GAP}
      px={RECEIPT_ROW_PX}
      py={RECEIPT_ROW_PY}
      borderTopWidth={showDivider ? "1px" : 0}
      borderColor={RECEIPT_ROW_DIVIDER_COLOR}
    >
      <SessionDot kind={kind} />
      <Text
        flexShrink={1}
        minW={0}
        lineClamp={1}
        fontSize={RECEIPT_LABEL_FONT_SIZE}
        fontWeight={kind === "next" ? "700" : "500"}
        color={muted ? "charcoal.300" : "charcoal.600"}
      >
        {superscriptExponents(label)}
      </Text>
      {domainChip && (
        <Text
          flexShrink={0}
          fontSize="10px"
          fontFamily="heading"
          fontWeight="600"
          color="charcoal.400"
          borderWidth="1px"
          borderColor="gray.200"
          rounded="full"
          px={1.5}
          py="1px"
          lineClamp={1}
        >
          {domainChip}
        </Text>
      )}
      <Box flex="1" minW={0} />
      <Text flexShrink={0} fontSize={RECEIPT_TAG_FONT_SIZE} color={RECEIPT_TAG_COLOR}>
        {tag}
      </Text>
    </Flex>
  );
}

/**
 * One "Today's Math Playlists" tile — a peer SELECTION, never a launch button
 * ("Today's blend", one bounded frontier strand choice, a "new territory"
 * domain, or the folded-in check-in re-entry). A leading Phosphor icon names
 * the SUBJECT at a glance (Andy's play-session finding: too many playlists
 * read as a wall of text — an icon per tile reads faster than a headline
 * alone); the headline is still the kid-facing hook and the subtitle names
 * the concrete thing it serves (the sample skill for a strand card, a short
 * descriptor for the blend), so the tap is never a blind bet. A selected tile
 * gets a violet ring + tint (the same selection language as the rest of the
 * app) and its icon fills solid; unselected tiles are even-bordered, no
 * accent stripe (visual-design rule) — identical weight to their siblings
 * either way. `isNew` draws a small subtle "NEW" mark (no new component
 * family — the same tile, one more corner label) for a not-yet-started
 * domain, the fold-in of the old "Explore a new territory" pills. Fixed width
 * (not flex-grow) — this is now a CAROUSEL item, not a wrapping-grid cell; a
 * `tileRef` callback lets the carousel scroll the active tile into view.
 */
function PlaylistOptionTile({
  headline,
  subtitle,
  iconName,
  selected,
  isNew,
  ariaLabel,
  onClick,
  tileRef,
}: {
  headline: string;
  subtitle: string;
  iconName: string;
  selected: boolean;
  isNew?: boolean;
  ariaLabel: string;
  onClick: () => void;
  tileRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <chakra.button
      ref={tileRef}
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={ariaLabel}
      position="relative"
      flex="0 0 auto"
      w="152px"
      scrollSnapAlign="start"
      textAlign="left"
      rounded="10px"
      borderWidth="1px"
      borderColor={selected ? "violet.400" : "gray.200"}
      bg={selected ? "violet.50" : "white"}
      px={3}
      py={2.5}
      transition="background 0.12s, border-color 0.12s"
      _hover={{ bg: selected ? "violet.50" : "gray.50", borderColor: selected ? "violet.400" : "gray.300" }}
      _focusVisible={FOCUS_RING}
    >
      {isNew && (
        <Text
          position="absolute"
          top="6px"
          right="8px"
          fontSize="9px"
          fontWeight="700"
          fontFamily="heading"
          letterSpacing="0.04em"
          color="teal.500"
        >
          NEW
        </Text>
      )}
      <Box mb={1.5} lineHeight="1">
        <TileIcon name={iconName} selected={selected} />
      </Box>
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color={selected ? "violet.700" : "charcoal.600"} lineClamp={2} pr={isNew ? "28px" : 0}>
        {headline}
      </Text>
      <Text fontSize="xs" color={selected ? "violet.500" : "charcoal.400"} lineClamp={2} mt={0.5}>
        {subtitle}
      </Text>
    </chakra.button>
  );
}

export function PlaylistCard({
  playlist,
  mathPlan,
  standing,
  startedDomains,
  choiceSet,
  forceChooser,
  checkInStarted,
  selectedChoice,
  onSelectChoice,
  preview,
  stretchSelected,
  onSelectStretch,
  stretchPreview,
  secondary,
  onSelectDomain,
  selectedDomain,
}: {
  /** The BLEND payload — fetched + gated by the page (presentational card). */
  playlist: PlaylistData;
  /** The page's plan query, scoped to the viewed scholar in teacher remote mode. */
  mathPlan: {
    practiceScope: PracticeScope;
    scopeSource: "math_plan" | "legacy_standing" | "open_default";
  } | undefined;
  /** standingPractice.myActiveStanding result (goal-minute + domain framing). */
  standing: { domain: string; domains?: string[]; dailyGoalMinutes: number | null; title: string | null } | null | undefined;
  /** Domains the scholar has STARTED (any mastery row) — the auto-blend set
   *  when there's no teacher pin. Used ONLY to decide whether a tile pick is
   *  "in set" (mirrors native's `domainSet`, see `practiceHref` below); never
   *  drives rendering. */
  startedDomains?: string[];
  /** api.practiceSkills.choiceSetForSelf + newTerritoryCards, MERGED by the
   *  page into one list — up to 3 bounded frontier choices plus one tile per
   *  not-yet-started domain (tagged `isNew`, the fold-in of the old "Explore a
   *  new territory" pills, f7). Rendered as peer tiles alongside "Today's
   *  blend". Omitted/empty ⇒ the tile row is hidden entirely and the card
   *  reverts to a single "Today's Math Playlist" (fetched by the page so this
   *  card stays presentational). */
  choiceSet?: ChoiceCard[];
  /** True once ANY domain has placed (or the sitting-budget pause fired,
   *  f1/#879) — renders the chooser even though `playlist.needsPlacement` (a
   *  single, default-domain-scoped signal) might still read true. The TOP
   *  STRAGGLER fix, f7: home no longer waits for the FULL cross-domain
   *  check-in to complete before showing tiles/preview. */
  forceChooser?: boolean;
  /** True once the check-in has been ENTERED — any domain in flight or
   *  converged (`mapProgressForScholar.started`, finish-the-check-in decision
   *  6). Relabels the primary CTA "Resume check-in" instead of "Start
   *  check-in" (pilot7 f18 finding: leaving mid-flight must not read as
   *  "never started"). */
  checkInStarted?: boolean;
  /** The controlled tile selection — `null` means "Today's blend" (the
   *  default). Owned by the page so it can drive the recomposed-preview query
   *  below; selecting a tile NEVER navigates. */
  selectedChoice: ChoiceCard | null;
  onSelectChoice: (choice: ChoiceCard | null) => void;
  /** The recomposed preview for `selectedChoice` — `playlistForScholar` called
   *  again with `choiceHint` set to the selected card. `undefined` while that
   *  second query is in flight (a selection is active but not yet loaded) —
   *  the card keeps showing the last-known rows with a quiet shimmer rather
   *  than a layout jump. Ignored entirely when `selectedChoice` is null (the
   *  blend already IS `playlist`, no second query needed). */
  preview?: PlaylistData;
  /** True when the Stretch tile is selected — owned by the page so it can
   *  drive the challenge-tail recompose query (`stretchPreview` below). Like
   *  `selectedChoice`, tapping the tile NEVER navigates; selection is
   *  deferred to the Start CTA. Mutually exclusive with `selectedChoice`. */
  stretchSelected?: boolean;
  onSelectStretch?: (selected: boolean) => void;
  /** The recomposed preview for the stretch tile — `playlistForScholar` called
   *  with `stretchHint: true`, returning challenge-tail items as the set so
   *  the scholar sees what the stretch round will actually contain. `undefined`
   *  while the query is in flight (a quiet shimmer, no layout jump). Ignored
   *  when `stretchSelected` is false. */
  stretchPreview?: PlaylistData;
  /** H1 fix: true while the scholar's Welcome unit is still active — forces
   *  the primary CTA to its existing OUTLINED/secondary treatment (the same
   *  styling `deriveStartCta`'s own `primary: false` branch already renders
   *  for "Practice more?") so the check-in card doesn't visually outshout
   *  the Welcome pin rendered above it on Home. Cosmetic only — the verb,
   *  destination, and every other behavior are unchanged. */
  secondary?: boolean;
  /** Notifies the page that the scholar picked a domain in the header switcher.
   *  The page owns the selection (it drives its own preview queries); the card
   *  reads it back through `selectedDomain` below. */
  onSelectDomain?: (domain: string) => void;
  /** The domain the scholar picked in the header switcher — the OTHER half of
   *  `onSelectDomain`, owned by the page (`app/scholar/page.tsx`). Without it
   *  the card knew a pick had happened but not what it was, so Start kept
   *  launching the mixed blend the switcher had just narrowed away from:
   *  preview and Start disagreed. Mirrors native's `selectedDomain` state
   *  (native/src/components/practice/PracticePlaylistCard.tsx), which the card
   *  owns because the native card owns its own queries. */
  selectedDomain?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [domainSwitcherOpen, setDomainSwitcherOpen] = useState(false);
  const logPracticeChoice = useMutation(api.practiceSkills.logPracticeChoice);
  // The teacher-planted checkpoint the scholar is working toward — goal only
  // (strand/grade + labels; NO steering internals). Drives the slim "Working
  // toward" banner atop the card, mirroring native (mathFocus.myMathCheckpoint).
  // The served playlist already soft-steers toward this strand in
  // playlistForScholar; the banner names the destination those items walk to.
  const myCheckpoint = useQuery(api.mathFocus.myMathCheckpoint, {}) as
    | MathCheckpoint
    | null
    | undefined;
  // An explicit Math plan supersedes legacy standing-practice configuration
  // entirely — the standing row is the retired primitive, so once a plan owns
  // the scope its domains/pin must not leak back into anything the scholar sees
  // or launches. Mirrors native's `effectiveStanding`
  // (native/src/components/practice/PracticePlaylistCard.tsx) and the practice
  // page's own gate (app/scholar/practice/page.tsx).
  const hasExplicitMathPlan = mathPlan?.scopeSource === "math_plan";
  const effectiveStanding = hasExplicitMathPlan ? null : standing;
  // Keep existing choices visible while the plan loads; only a resolved limited
  // plan narrows the client affordance (the server remains authoritative).
  const availableChoices =
    mathPlan?.practiceScope.kind === "limited"
      ? (choiceSet ?? []).filter((choice) =>
          scopeAllowsChoice(mathPlan.practiceScope, choice),
        )
      : choiceSet;
  const scopeSentence = mathPlan
    ? practiceScopeSentence(mathPlan.practiceScope, {
        domainLabel: practiceDomainLabel,
        strandLabel: (strand, domain) => strandHeadlineFor(domain, strand),
      })
    : null;
  // The scholar's plan domains — the switcher's and the launch derivation's
  // source once a plan exists. A limited plan names them; an OPEN plan names
  // none, so the started domains stay the honest set. Mirrors native.
  const planDomains =
    hasExplicitMathPlan && mathPlan.practiceScope.kind === "limited"
      ? mathPlan.practiceScope.domains.map((entry) => entry.domain)
      : (startedDomains ?? []);
  // Ported from native: the switcher offers the PLAN's in-scope domains, never
  // the retired standing row's. Reading `standing.domains` here meant a scholar
  // with a multi-domain plan and no legacy row saw no switcher at all, while a
  // scholar whose plan narrowed still got the removed domains offered.
  const switchableDomains = hasExplicitMathPlan
    ? planDomains.filter((domain) =>
        mathPlan.practiceScope.kind === "limited"
          ? scopeAllowsDomain(mathPlan.practiceScope, domain)
          : true,
      )
    : (effectiveStanding?.domains ?? []);

  // The tile row is now a horizontal CAROUSEL (Andy's play-session finding:
  // 9+ tiles — blend + strands + new-territory + check-in — wrapped into a
  // messy 2-row grid). A selection made off-screen (most notably the
  // `?highlightDomain=` deep-link preselect from the frontier-moment /
  // Summit redirects, f7) must still scroll into view — a scholar should
  // never land on a chooser whose OWN highlighted pick is hidden. Keyed by
  // the same identity the tiles themselves use ("blend" / "stretch" /
  // `${domain}::${strand}`), so the effect below only needs the active key.
  const tileRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const setTileRef = useCallback(
    (key: string) => (el: HTMLButtonElement | null) => {
      if (el) tileRefs.current.set(key, el);
      else tileRefs.current.delete(key);
    },
    [],
  );
  const activeTileKey = stretchSelected
    ? "stretch"
    : selectedChoice
      ? `${selectedChoice.domain}::${selectedChoice.strand}`
      : "blend";
  useEffect(() => {
    tileRefs.current.get(activeTileKey)?.scrollIntoView({
      behavior: "smooth",
      inline: "nearest",
      block: "nearest",
    });
  }, [activeTileKey]);

  // Tapping a tile SELECTS it (or, tapping the already-selected strand/checkin/
  // stretch tile again, deselects back to the blend) — it never navigates and
  // never logs. Logging is deferred to the Start CTA itself (handleStartClick
  // below), so a dabbled select/deselect leaves no trace.
  const handleTileTap = useCallback(
    (tapped: "blend" | "stretch" | ChoiceCard) => {
      if (tapped === "stretch") {
        const next = !stretchSelected;
        onSelectStretch?.(next);
        if (next) onSelectChoice(null);
        return;
      }
      onSelectStretch?.(false);
      onSelectChoice(nextTileSelection(selectedChoice, tapped));
    },
    [selectedChoice, onSelectChoice, onSelectStretch, stretchSelected],
  );

  // Starting with a strand selected is a best-effort OBSERVATION log (never
  // blocks the navigation it drives) — a scholar choosing a strand is a signal
  // for teachers/observers, not a scholar-facing score. Starting the plain
  // blend logs nothing (mirrors the pre-existing "dabbling never counts" rule).
  const handleStartClick = useCallback(() => {
    if (!selectedChoice) return;
    const clientPickId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `pick-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logPracticeChoice({
      domain: selectedChoice.domain,
      strand: selectedChoice.strand,
      source: "home_choice",
      clientPickId,
      candidateSkillKeys: (choiceSet ?? []).map((c) => c.sampleSkillKey),
      playlistDomains: (choiceSet ?? []).map((c) => c.domain),
    }).catch(() => {
      // Best-effort — the scholar still gets to practice their pick even if
      // the observation log fails to write.
    });
  }, [selectedChoice, logPracticeChoice, choiceSet]);

  // A MIXED standing assignment (≥2 domains) links to plain /scholar/practice so
  // the page resolves the whole blended set via myActiveStanding — pinning just
  // ?domain= would collapse it to the primary domain. Single/none keep ?domain=.
  // A strand selection overrides all of this — it goes straight to the SAME
  // ?choiceDomain=/?choiceStrand= route the old tap-to-launch tiles used
  // (app/scholar/practice/page.tsx). The check-in re-entry tile routes to
  // `/scholar/practice?checkin=all` — an EXPLICIT intent flag (pilot7 f19
  // finding: an incomplete/paused check-in must never preempt an ordinary
  // blend/strand entry, so those two keep NO checkin param at all — only this
  // tile means "yes, I want the check-in specifically"). Mirrors native's own
  // `?checkin=all` (native/src/components/practice/PracticePlaylistCard.tsx).
  // The scholar's EFFECTIVE domain set today — a teacher's mixed pin, a
  // single pin, or (no pin / an explicit Math plan) the plan's own domains,
  // falling back to the auto-blend of started domains. Mirrors native's own
  // `domainSet` exactly (PracticePlaylistCard.tsx), computed via the shared,
  // unit-tested helper (see shared/practiceChoiceSelection.ts) and reading
  // `effectiveStanding` so a superseded legacy row can't pin the launch.
  const domainSet = effectiveDomainSet({
    standingDomains: effectiveStanding?.domains,
    standingDomain: effectiveStanding?.domain,
    startedDomains: planDomains,
  });
  // Start must target what the scholar is LOOKING at. The header switcher only
  // renders with ≥2 switchable domains, so deriving "mixed" from the standing
  // row alone made every visible pick launch the bare `/scholar/practice`, which
  // the practice page re-resolves into the mixed blend across all domains —
  // preview and Start disagreeing on exactly the choice the scholar just made.
  // A pick collapses the set to that one domain, so the link pins `?domain=`
  // (top precedence on the practice page). Mirrors native's
  // `selectedDomainSet` / `isMixed` (PracticePlaylistCard.tsx).
  const selectedDomainSet = selectedDomain ? [selectedDomain] : domainSet;
  const isMixed = selectedDomainSet.length > 1;
  // A tile pick OUTSIDE that set (a "new territory" domain, ANY tile whose
  // domain a standing pin doesn't cover, or — once the switcher has narrowed
  // the set — any tile at all) must carry an EXPLICIT `?domain=` — otherwise
  // the practice page falls through to `standing`/auto-blend resolution (which
  // wins over an unmatched `choiceHint`, per its own `choiceHint.domain ===
  // domain` gate), silently serving a DIFFERENT territory than the one just
  // previewed. `?domain=` has top precedence there (checked before `standing`),
  // so this reliably targets the picked domain — mirrors native's `inSet`
  // ternary (PracticePlaylistCard.tsx's `openPractice`). An IN-SET pick with no
  // switcher narrowing is left exactly as before (no override — the page's own
  // standing/auto-blend resolution already serves it correctly, blend included).
  const pinPickDomain =
    !!selectedChoice &&
    (!!selectedDomain ||
      isDomainOutsideEffectiveSet(selectedChoice.domain, selectedDomainSet));
  // The launch domain for a plain blend/switcher entry, and whether that entry
  // folds the `· mapping` band. `?blend=1` marks "this `?domain=` was DERIVED
  // from the scholar's own blend / switcher pick", the same distinction the
  // practice page otherwise makes server-side (a bare `?domain=` — a deep link
  // or a teacher's legacy standing pin — is an explicit request that must not be
  // diluted with mapping). Mirrors native's `?blend=1`
  // (native/src/lib/practiceDeepLinkParams.ts `foldsMappingBand`), so Start
  // serves the identical composition the Home preview just showed.
  const blendDomain = selectedDomainSet[0];
  // Key the launch marker on the SAME effective source as Home's preview:
  // an explicit plan ignores any superseded standing row.
  const blendMarker = effectiveStanding ? "" : "&blend=1";
  // The ordinary blend/strand entries carry no explicit intent flag (see
  // `isMixed`'s comment above — the f19/#915 fix this depends on); the explicit
  // `?checkin=all` re-entry is CheckInHomeCard's job now, not a tile here.
  // Stretch-tile entry: uses the blend's own domain (hasChallengeItems is
  // always false on mixed, so this branch only fires on single-domain) +
  // `?stretch=1` so the practice page wires stretchHint into practiceSession.
  // Mirrors native's PracticePlaylistCard `openPractice` stretchHint routing.
  const practiceHref = stretchSelected
    ? `/scholar/practice?domain=${encodeURIComponent(playlist.domain)}&stretch=1`
    : selectedChoice
      ? `/scholar/practice?choiceDomain=${encodeURIComponent(selectedChoice.domain)}&choiceStrand=${encodeURIComponent(selectedChoice.strand)}${
          pinPickDomain ? `&domain=${encodeURIComponent(selectedChoice.domain)}` : ""
        }`
      : isMixed || !blendDomain
        ? "/scholar/practice"
        : `/scholar/practice?domain=${encodeURIComponent(blendDomain)}${blendMarker}`;

  // Header-level fields are ALWAYS the BLEND's own — the header is a stable
  // identity row above the tile fork, never itself recomposed by a selection.
  // `effectiveNeedsPlacement` folds in the straggler fix (f7): `forceChooser`
  // (any domain placed, or the sitting-budget pause fired) overrides the raw
  // per-default-domain `needsPlacement` so the chooser renders even though
  // that single signal might still read true.
  const { needsPlacement, firstPostPlacementBlock, everPracticed } = playlist;
  const goingDeeper =
    playlist.set.some((row) => row.reason === "stretch") ||
    myCheckpoint?.mode === "deeper";
  const blendTileHeadline = goingDeeper
    ? "Going deeper"
    : myCheckpoint
      ? "Toward your checkpoint"
      : "Today's blend";
  const effectiveNeedsPlacement = needsPlacement && !forceChooser;
  // The Stretch tile is visible ONLY when `hasChallengeItems` is true — zero
  // new thresholds; candidate existence is the sole condition (brief §BEHAVIOR).
  const showStretchTile = !effectiveNeedsPlacement && !!playlist.hasChallengeItems;
  const showTileRow =
    !effectiveNeedsPlacement && (((availableChoices?.length ?? 0) > 0) || showStretchTile);
  const goalMin = effectiveStanding?.dailyGoalMinutes ?? null;
  // A completed check-in always hands off to a fresh Start state. Even the
  // lowest placement can have no visible calibration rows yet; that must never
  // regress to the post-practice "Practice more?" state (the
  // firstPostPlacementBlock escape hatch inside derivePlaylistDoneness).
  // `blocked` is the second escape hatch: a scope-blocked playlist arrives
  // shaped exactly like a finished day, so without it the strip would hand a
  // scholar a green check and "— done" for a boundary someone else drew.
  const { caughtUp: blendCaughtUp, blocked: blendBlocked } = derivePlaylistDoneness({
    set: playlist.set,
    nextUp: playlist.nextUp,
    firstPostPlacementBlock,
    blocked: playlist.blocked,
  });
  // Raw count for the progress meter/receipt (not a done-ness verdict).
  const blendDoneCount = playlist.set.filter((s) => s.doneToday).length;
  const mastheadDateline = playlistMastheadDateline({
    effectiveNeedsPlacement,
    practicedToday: playlist.practicedToday,
    setLength: playlist.set.length,
    practicedCount: blendDoneCount,
    goalMin,
  });

  // ── Select-and-recompose: `active` is the BLEND when nothing is selected, or
  //    the recomposed `preview` once a strand tile is picked and its query has
  //    resolved — OR `stretchPreview` when the Stretch tile is selected and its
  //    query has resolved. While those queries are in flight, `lastResolved`
  //    keeps the rows on screen (a quiet shimmer via `isRecomposing`, never a
  //    layout jump — no skeleton, no height change). ──
  const rawActive = stretchSelected ? stretchPreview : selectedChoice ? preview : playlist;
  const [lastResolved, setLastResolved] = useState<PlaylistData>(playlist);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Keep the last resolved rows committed while a selected playlist recomposes asynchronously.
    if (rawActive) setLastResolved(rawActive);
  }, [rawActive]);
  const active = rawActive ?? lastResolved;
  const isRecomposing =
    (!!selectedChoice && preview === undefined) ||
    (!!stretchSelected && stretchPreview === undefined);

  const { nextUp, set, practicedToday, firstPostPlacementBlock: activeFirstBlock } = active;
  const launchpad = active.launchpad;
  const { caughtUp, blocked } = derivePlaylistDoneness({
    set,
    nextUp,
    firstPostPlacementBlock: activeFirstBlock,
    blocked: active.blocked,
  });
  // The plan currently leaves nothing servable. Read the SERVER's flag, never
  // the scope's shape: a limited scope is usually perfectly servable, and the
  // old shape check (every entry carrying an empty `strands` array) was
  // vacuously-true-only — `validatePracticeScope` rejects a stored `strands:
  // []`, so it could never fire and the scholar was told they were caught up
  // instead. Either the blend or a recomposed selection can be blocked.
  const noPracticeAvailable = blendBlocked || blocked;

  // ── The strip: ∴ glyph + neutral title + a session-progress meter ──
  // Pre-placement the CTA opens the placement quiz, not the daily set, so the
  // strip names it a "Math check-in" and the meter (a today's-set gauge) is off.
  // Pluralizes to "Today's Math Playlists" exactly when the tile row is
  // showing (the tiles read as sibling playlists under this one headline);
  // otherwise it's the plain singular, unchanged.
  const strip = (
    <Flex align="center" gap={2.5} px={3.5} py={2.5} bg="white" borderBottomWidth="1px" borderColor="gray.200">
      <Flex w={LEAD_W} justify="center" flexShrink={0} lineHeight="1" aria-hidden>
        <Text as="span" fontSize="18px" fontWeight="800" color={blendCaughtUp && !effectiveNeedsPlacement ? "#146c43" : GLYPH_COLOR} lineHeight="1">
          {GLYPH}
        </Text>
      </Flex>
      <Text fontFamily="heading" fontWeight="700" fontSize="xs" color="charcoal.500" letterSpacing="0.02em" lineClamp={1}>
        {effectiveNeedsPlacement
          ? CHECK_IN_HOME_TITLE
          : firstPostPlacementBlock
            ? "Your First Math Playlist"
            : `Today's Math ${showTileRow ? "Playlists" : "Playlist"}${blendCaughtUp ? " — done" : ""}`}
      </Text>
      {switchableDomains.length > 1 && onSelectDomain && (
        <chakra.button
          type="button"
          onClick={() => setDomainSwitcherOpen(true)}
          aria-label={`Switch math domain, currently ${practiceDomainLabel(playlist.domain)}`}
          fontSize="xs"
          color="violet.600"
          fontWeight="700"
          _focusVisible={FOCUS_RING}
        >
          {practiceDomainLabel(playlist.domain)} ▾
        </chakra.button>
      )}
      <Box flex={1} />
      {/* Right-aligned strip meta — the block's progress once started, else its
          time framing ("~N min"), so it sits in the same slot as Prep's
          "until HH:MM" (sibling parity). Suppressed pre-placement (check-in). */}
      {effectiveNeedsPlacement ? null : playlist.practicedToday && playlist.set.length > 0 ? (
        <HStack gap={2} flexShrink={0}>
          <Box w="52px" h="6px" rounded="full" bg="gray.200" overflow="hidden">
            <Box
              h="100%"
              w={`${Math.round((blendDoneCount / playlist.set.length) * 100)}%`}
              css={{
                background:
                  "linear-gradient(90deg, var(--chakra-colors-violet-500), var(--chakra-colors-green-400))",
              }}
            />
          </Box>
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading" whiteSpace="nowrap">
            {blendDoneCount} of {playlist.set.length} skills practiced today
          </Text>
        </HStack>
      ) : goalMin ? (
        <Text fontSize="xs" fontWeight="400" color="charcoal.400" fontFamily="heading" flexShrink={0} whiteSpace="nowrap">
          ~{goalMin} min
        </Text>
      ) : null}
    </Flex>
  );

  // ── CTA content by state — a picked strand always wins with an explicit
  // "Start with <headline>"; the Stretch tile wins with "Start stretch round →";
  // otherwise the existing verb ladder (Continue/Start/Practice more?/Start
  // check-in), centralized in the shared helper so web + native can never drift
  // on the copy. `chosenPlaylist` is the SAME shape fed to both `deriveStartCta`
  // and `expandMoreLabel` below — a picked strand names itself in both the CTA
  // and the collapsed-set expander (Andy's play-session finding: "N more in
  // today's set" read wrong once a specific playlist was chosen). ──
  const chosenPlaylist = selectedChoice
    ? {
        strandLabel: strandHeadlineFor(
          selectedChoice.domain,
          selectedChoice.strand,
        ),
      }
    : null;
  const startCta = stretchSelected
    ? { verb: "Start stretch round", suffix: "→" as const, primary: true }
    : deriveStartCta(chosenPlaylist, {
        needsPlacement: effectiveNeedsPlacement,
        checkInStarted,
        caughtUp,
        practicedToday,
        hasNextUp: nextUp !== null,
      });
  const ctaPrimary = startCta.primary && !secondary;

  // ── The multipack rows — built once so the card reads like Prep's list. The
  // next-up skill always leads (even a teacher pin that's outside the engine's
  // frontier set), then the rest of today's set in queue order. Shows the top 3
  // by default (display-only — one Start drives them), with a quiet expander
  // for the rest. ──
  const DEFAULT_VISIBLE = 3;
  const nextInSet = nextUp ? set.some((s) => s.key === nextUp.key) : false;
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
    /** Out-of-current-domain sweep review — drives the per-row domain chip. */
    domain?: string;
  }[] = [];
  if (nextUp && !nextInSet) {
    // Unreachable as a demotion target: the doorway is spliced at `at + 1` or
    // later whenever this row exists, so it is never the row behind it.
    rows.push({
      key: nextUp.key,
      label: nextUp.label,
      kind: "next",
      tag: nextUpTag(nextUp.reason),
      queuedTag: nextUpTag(nextUp.reason),
      muted: false,
      domain: nextUp.domain,
    });
  }
  set.forEach((row, i) => {
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
      domain: row.domain,
    });
  });
  // The instructional doorway is a real beat of the run, so it is a real row of
  // the receipt. Before this, Start could open with a "First look" card the
  // preview never mentioned — the card promised one thing and served another.
  // Position comes from the server (`launchpad.at`, an index into `set`), offset
  // by the next-up row this list prepends when that skill isn't in `set`.
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
    <Surface p={0} overflow="hidden">
      {/* ── Cover masthead ("Direction A — The Contents Rule",
          review/sketches-playlist-card-magazine.html#dirA, Andy-approved
          verbatim) — replaces BOTH the old "Working toward" checkpoint banner
          AND the strip's header row (title + progress pill) with one
          magazine-style header. Top line: eyebrow left (flag glyph + state
          label, mode accent — frontier gold #e0b84e still mapping toward the
          checkpoint vs. depth blue #5663c6 already reached it and going
          deeper, same accents as before) and a quiet dateline right (the same
          "N of M skills practiced today" text the strip used to show in its
          progress pill — the pill's bar is dropped, the text moves up).
          Below: the checkpoint goal as a cover headline, then the dot tally
          straightened into a full-width CONTENTS RULE — `bandTotal` station
          dots joined by flex segments, the first `bandSolid` stations (and
          the segments between them) filled solid in the mode accent, the
          rest hollow/hairline; `mode === "deeper"` fills the whole rule. Then
          the existing mode sub-line as a quiet rule-caption. Hidden when no
          checkpoint is set — the card falls back to the plain `strip` header
          exactly as before. Mirrors native PracticePlaylistCard. ── */}
      {myCheckpoint ? (
        <Box
          px="20px"
          pt="16px"
          pb="14px"
          borderBottomWidth="1px"
          borderColor="#eceaef"
          bg={myCheckpoint.mode === "deeper" ? "#f6f9ff" : "#fffdf7"}
        >
          <Flex align="baseline" justify="space-between" gap={3}>
            <Flex align="center" gap="7px" flexShrink={1} minW={0}>
              <Box
                color={myCheckpoint.mode === "deeper" ? "#5663c6" : "#e0b84e"}
                display="flex"
                flexShrink={0}
              >
                <FlagCheckered size={15} weight="fill" />
              </Box>
              <Text
                fontSize="10px"
                fontWeight="800"
                letterSpacing="0.14em"
                textTransform="uppercase"
                color={myCheckpoint.mode === "deeper" ? "#5663c6" : "#e0b84e"}
                lineClamp={1}
              >
                {myCheckpoint.mode === "deeper" ? "✓ Checkpoint reached" : "Working toward checkpoint"}
              </Text>
            </Flex>
            <Flex align="center" gap={2} flexShrink={0}>
              {mastheadDateline ? (
                <Text fontSize="11.5px" fontWeight="600" color="#8b8f9a" whiteSpace="nowrap">
                  {mastheadDateline}
                </Text>
              ) : null}
            </Flex>
          </Flex>
          <Text
            mt="6px"
            fontSize="23px"
            lineHeight="1.12"
            fontWeight="800"
            letterSpacing="-0.01em"
            color={myCheckpoint.mode === "deeper" ? "#122a52" : "#20233f"}
            lineClamp={1}
          >
            {`Grade ${myCheckpoint.grade} · ${myCheckpoint.strandLabel}`}
          </Text>
          {/* Contents rule — bandSolid filled stations (●) of bandTotal,
              joined by segments; the segment between two filled stations is
              filled too, the rest hairline. Flex-based so it scales to any
              bandTotal and always spans the card's full padded width. */}
          <Flex align="center" gap={0} mt="14px" mb="2px" aria-hidden>
            {Array.from({ length: myCheckpoint.bandTotal }, (_, i) => {
              const stationOn = i < myCheckpoint.bandSolid || myCheckpoint.mode === "deeper";
              const segDone =
                i + 1 < myCheckpoint.bandTotal &&
                (i + 1 < myCheckpoint.bandSolid || myCheckpoint.mode === "deeper");
              const accent = myCheckpoint.mode === "deeper" ? "#5663c6" : "#e0b84e";
              return (
                <Fragment key={i}>
                  <Box
                    flex="0 0 auto"
                    w="13px"
                    h="13px"
                    rounded="full"
                    bg={stationOn ? accent : "white"}
                    borderWidth="2px"
                    borderColor={
                      stationOn ? accent : myCheckpoint.mode === "deeper" ? "#c3cef0" : "#d9d2c0"
                    }
                  />
                  {i + 1 < myCheckpoint.bandTotal && (
                    <Box
                      flex="1 1 auto"
                      h="2px"
                      bg={
                        segDone ? accent : myCheckpoint.mode === "deeper" ? "#dbe3f6" : "#eae4d4"
                      }
                    />
                  )}
                </Fragment>
              );
            })}
          </Flex>
          <Text mt="6px" fontSize="11.5px" color="#8b8f9a" lineClamp={1}>
            {myCheckpoint.mode === "deeper"
              ? "Now going deeper — harder problems, new angles on the same ideas."
              : "Today leans here — reviews keep older skills sharp."}
          </Text>
        </Box>
      ) : (
        strip
      )}
      {scopeSentence && (
        <Text px={3.5} pt={2.5} fontSize="xs" color="charcoal.500">
          {scopeSentence}
        </Text>
      )}
      {noPracticeAvailable && (
        <Box px={3.5} pt={2.5}>
          <Text fontSize="sm" color="charcoal.500">
            {PRACTICE_SCOPE_BLOCKED_HEADLINE}
          </Text>
          <Text fontSize="xs" color="charcoal.400" mt={1}>
            {PRACTICE_SCOPE_BLOCKED_DETAIL}
          </Text>
        </Box>
      )}

      {/* ── The tile row — peer SELECTIONS under the one "Today's Math
          Playlists" headline above: "Today's blend" (the default set,
          pre-selected) + up to 3 bounded frontier strand cards + any
          new-territory/check-in tiles. A single-row horizontal CAROUSEL
          (Andy's play-session finding: wrapping into a 2-row grid at 9+
          tiles read as a mess) — fixed-width tiles, scroll-snap, no visible
          scrollbar (a swipeable strip, not a form). Tapping a tile never
          navigates — it recomposes the preview below to the SAME set Start
          will actually serve. Hidden entirely pre-placement (nothing to
          choose from yet) and whenever the page has no strand cards to
          offer (fetched by the page, so this stays presentational — no
          independent pop-in); the card then reverts to a single "Today's
          Math Playlist", no tile row. ── */}
      {showTileRow && (
        <Box px={3.5} py={3} borderBottomWidth="1px" borderColor="gray.200">
          <Flex
            gap={2}
            wrap="nowrap"
            overflowX="auto"
            pb="2px"
            css={{
              scrollSnapType: "x proximity",
              scrollbarWidth: "none",
              msOverflowStyle: "none",
              "&::-webkit-scrollbar": { display: "none" },
            }}
          >
            <PlaylistOptionTile
              headline={blendTileHeadline}
              subtitle={
                goingDeeper
                  ? "Same ideas, harder problems"
                  : "Reviews + new skills"
              }
              iconName={
                goingDeeper
                  ? "Anchor"
                  : myCheckpoint
                    ? "Mountains"
                  : playlistTileIconName("blend")
              }
              selected={!selectedChoice && !stretchSelected}
              ariaLabel={`Select ${blendTileHeadline}`}
              onClick={() => handleTileTap("blend")}
              tileRef={setTileRef("blend")}
            />
            {(availableChoices ?? []).map((card) => (
              <PlaylistOptionTile
                key={`${card.domain}::${card.strand}`}
                headline={strandHeadlineFor(card.domain, card.strand)}
                subtitle={superscriptExponents(card.sampleSkillLabel)}
                iconName={playlistTileIconName(card.isNew ? "new-territory" : "strand", card.domain)}
                selected={
                  !stretchSelected &&
                  !!selectedChoice &&
                  selectedChoice.domain === card.domain &&
                  selectedChoice.strand === card.strand
                }
                isNew={card.isNew}
                ariaLabel={`Select ${strandHeadlineFor(card.domain, card.strand)}`}
                onClick={() => handleTileTap(card)}
                tileRef={setTileRef(`${card.domain}::${card.strand}`)}
              />
            ))}
            {/* The Stretch tile — the standing, scholar-chosen home for the
                challenge lane. End-of-row, quiet treatment matching siblings.
                Visible ONLY when `playlist.hasChallengeItems` is true (the
                server surfaces a non-empty challenge tail): zero new thresholds,
                candidate existence is the sole condition. Selecting it recomposes
                the preview below to the challenge-tail items (via `stretchPreview`
                from the page's `stretchHint: true` query). The in-session
                "Want a challenge?" interstitial stays untouched — both paths
                consume the identical challenge lane; whether the tile later folds
                into the interstitial is an owner decision. */}
            {showStretchTile && (
              <PlaylistOptionTile
                headline={STRETCH_TILE_HEADLINE}
                subtitle={STRETCH_TILE_SUBTITLE}
                iconName={playlistTileIconName("stretch")}
                selected={!!stretchSelected}
                ariaLabel={STRETCH_TILE_ARIA_LABEL}
                onClick={() => handleTileTap("stretch")}
                tileRef={setTileRef("stretch")}
              />
            )}
          </Flex>
        </Box>
      )}

      {/* ── The recomposed preview — opacity-shimmers (never a layout jump,
          never a skeleton) while a selected strand's or stretch preview query
          is in flight; `active`/`isRecomposing` are derived above. ── */}
      <Box opacity={isRecomposing ? 0.55 : 1} transition="opacity 0.15s" pointerEvents={isRecomposing ? "none" : "auto"}>
        {effectiveNeedsPlacement ? (
          <Box px={3.5} py={3}>
            <Text fontSize="sm" color="charcoal.500" lineHeight="1.5">
              A few math questions to find where to start. Then your daily
              playlist picks up right where you&apos;re ready to grow.
            </Text>
          </Box>
        ) : caughtUp && !stretchSelected ? (
          <Box px={3.5} py={3}>
            <Text fontSize="sm" color="charcoal.500">
              {everPracticed
                ? "You're all caught up — every skill in today's set is fresh."
                : "Let's find where to start."}
            </Text>
          </Box>
        ) : (
          <>
            {/* No standalone day-attribution line — the banner's sub-line IS
                the attribution (a second sentence restating it below the
                carousel read as clutter; T3). Mirrors native. */}
            {/* The multipack — top 3 by default, hairline above every row. Rows are
                display-only; the single Start below drives the whole set. A
                cross-domain due review carries a small muted domain chip. */}
            {visibleRows.map((row) => (
              <PlaylistRow
                key={row.key}
                label={row.label}
                tag={row.tag}
                kind={row.kind}
                muted={row.muted}
                showDivider
                domainChip={row.domain ? practiceDomainLabel(row.domain) : undefined}
              />
            ))}

            {/* Quiet expand toggle — only when there's more than the top 3. */}
            {hiddenCount > 0 && (
              <chakra.button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                w="full"
                px={3.5}
                py={2}
                display="flex"
                alignItems="center"
                gap={1.5}
                borderTopWidth="1px"
                borderColor="gray.100"
                cursor="pointer"
                transition="background 0.12s"
                _hover={{ bg: "gray.50" }}
                _focusVisible={FOCUS_RING}
              >
                {expanded ? (
                  <CaretUp size={12} weight="bold" color="var(--chakra-colors-charcoal-400)" />
                ) : (
                  <CaretDown size={12} weight="bold" color="var(--chakra-colors-charcoal-400)" />
                )}
                <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
                  {expanded ? "Hide" : expandMoreLabel(hiddenCount, chosenPlaylist)}
                </Text>
              </chakra.button>
            )}
          </>
        )}
      </Box>

      {/* Primary CTA — the whole practice link (a stretched NextLink).
          Suppressed when the plan blocks practice: Start would open a run with
          nothing in it, so the boundary line above is the whole message. */}
      {!noPracticeAvailable && (
      <Box role="group" position="relative" px={3.5} py={3} borderTopWidth="1px" borderColor="gray.200" bg="white">
        <Flex
          align="center"
          justify="center"
          gap={1.5}
          rounded="10px"
          py={2.5}
          px={4}
          maxW="100%"
          fontWeight="700"
          fontSize="sm"
          bg={ctaPrimary ? GLYPH_COLOR : "white"}
          color={ctaPrimary ? "white" : "charcoal.500"}
          borderWidth={ctaPrimary ? 0 : "1px"}
          borderColor="gray.200"
          transition="background 0.15s"
          _groupHover={{ bg: ctaPrimary ? "#13606c" : "gray.50" }}
        >
          <Text as="span" flexShrink={0}>
            {startCta.verb}
          </Text>
          <Text as="span" flexShrink={0}>
            {startCta.suffix}
          </Text>
        </Flex>
        <ChakraLink
          asChild
          position="absolute"
          inset={0}
          aria-label={
            stretchSelected
              ? "Start your math stretch round"
              : practiceCtaAccessibleLabel(startCta, {
                  hasSelectedChoice: !!selectedChoice,
                  needsPlacement: effectiveNeedsPlacement,
                  caughtUp,
                  practicedToday,
                  nextUpLabel: nextUp?.label ?? null,
                  firstPostPlacementBlock,
                })
          }
          _focusVisible={FOCUS_RING}
        >
          <NextLink href={practiceHref} onClick={handleStartClick} />
        </ChakraLink>
      </Box>
      )}
      <DomainSwitcherDrawer
        open={domainSwitcherOpen}
        onClose={() => setDomainSwitcherOpen(false)}
        currentDomain={playlist.domain}
        activeDomains={switchableDomains.map((domain, index) => ({
          domain,
          isPrimary: index === 0,
        }))}
        practiceScope={mathPlan?.practiceScope}
        onSelect={(domain) => {
          onSelectDomain?.(domain);
          setDomainSwitcherOpen(false);
        }}
      />
    </Surface>
  );
}
