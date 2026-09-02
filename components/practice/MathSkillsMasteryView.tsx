"use client";

/**
 * MathSkillsMasteryView — the Mastery lens BODY of the Math Skills studio. It
 * renders inside the studio shell's second panel (the shell owns the full-bleed
 * shell, the collapsible domain rail, and the group/scholar scope), so this
 * component is purely the mastery content: a List matrix (one dial per scholar
 * per skill) and a Map (the aggregate cohort Tree), plus a right detail panel
 * that leads with the skill's NEIGHBOURHOOD (prereqs / unlocks / stories) and
 * then the per-scholar readings.
 *
 * Colour discipline (shared with the rail): the mastery palette (green/amber/
 * teal + hollow `placed` ring) means MASTERY only. This is a mastery/checkpoint
 * surface with no serving/access axis — avatars are always the plain neutral
 * face (a small mastery-green check marks a completed domain); strand lock =
 * gray glyph; selection = violet ink.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { useNow } from "@/hooks/useNow";
import {
  Badge,
  Box,
  Button,
  ButtonGroup,
  Drawer,
  Flex,
  Heading,
  HStack,
  IconButton,
  Input,
  Menu,
  Popover,
  Portal,
  Spinner,
  Stack,
  Text,
  useBreakpointValue,
  VisuallyHidden,
} from "@chakra-ui/react";
import { ArrowsOutSimple, CaretLeft, CaretRight, Check, Funnel, ListBullets, MapTrifold, SidebarSimple, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { KnowledgeNodeDial, type MasteryState } from "@/components/KnowledgeNodeDial";
import { CohortTreeView } from "@/components/practice/CohortTreeView";
import { SkillNeighbourhoodPanel } from "@/components/practice/SkillNeighbourhoodPanel";
import { StudioControlBar } from "@/components/practice/StudioControlBar";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { MasteryDot } from "@/components/MasteryDot";
import { MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";
import { STRUGGLING_TITLE_LABEL } from "@/shared/masteryLexicon";
import type { RosterScholar } from "@/hooks/useScholarRoster";
import {
  bandCountsForScholar,
  MASTERY_FILTER_LABEL,
  MASTERY_FILTER_ORDER,
  masteryFilterKey,
  readingMatchesMasteryFilters,
  type MasteryFilterKey,
} from "@/components/practice/mathSkillsMasteryFilters";
import { ScholarDomainReport } from "@/components/practice/ScholarDomainReport";
import { selectableSurface, interactiveSurface } from "@/components/practice/selectionStyle";
import { toaster } from "@/lib/toaster";
import {
  StrandHeading,
  CheckpointGradePill,
  type StrandCheckpointContext,
} from "@/components/practice/StrandHeading";
import { RecentMissesForNode } from "@/components/practice/RecentMisses";
import { isDomainComplete } from "@/components/practice/serving";
import {
  formatMasteryGradeLevel,
  averageDomainMasteryLevel,
  masteryGradeLevel,
  levelFromGradeBuckets,
} from "@/components/practice/masteryGradeLevel";
import {
  gradeForAgeFromDob,
  gradeForAgeDisagreesWithTagged,
} from "@/components/practice/chronologicalGrade";
import {
  masteryLevelTint,
  masteryLevelToneLabel,
  type LevelColoringMode,
} from "@/components/practice/masteryLevelColor";
import { MappingMark } from "@/components/practice/MappingMark";
import {
  CheckpointCorner,
  CheckpointMark,
  MathPlanLegendItems,
  OutOfScopeSlash,
  SLASH_KEEP_OUT_D,
} from "@/components/practice/MathPlanMarks";
import { MathPlanRailSection } from "@/components/practice/MathPlanRailSection";
import { EditMathPlanDialog } from "@/components/practice/EditMathPlanDialog";
import { CheckpointBandControl } from "@/components/practice/CheckpointBandControl";
import { GroupCheckpointBandControl } from "@/components/practice/GroupCheckpointBandControl";
import { ConfirmGroupCheckpointDialog } from "@/components/practice/ConfirmGroupCheckpointDialog";
import {
  cellReadoutWithMarks,
  checkpointLabel,
  domainCellMarks,
  groupCheckpointIntent,
  joinReadout,
  sameCheckpointBand,
  scholarCheckpointState,
  skillCellMarks,
  type CheckpointCornerState,
  type GroupCheckpointIntent,
  type MathPlanCheckpoint,
  type MathPlanRow,
} from "@/components/practice/mathPlanProjection";
import { DomainMapStatusStrip } from "@/components/practice/DomainMapStatusStrip";
import { DomainRetentionStrip } from "@/components/practice/DomainRetentionStrip";
import { retentionHoverClause } from "@/components/practice/domainRetentionCopy";
import type { DomainRetentionSummary } from "@/convex/lib/practice/domainRetention";
import {
  MathPlanScopeStrip,
  planScopeExclusion,
} from "@/components/practice/MathPlanScopeStrip";
import {
  fastMathCellReadout,
  fastMathPercentTint,
  fastMathRowSubLabel,
  fastMathSliceCellReadout,
  FAST_MATH_OPERATION_GROUPS,
  type FastMathDetailedReading,
  type FastMathSliceReading,
} from "@/components/practice/fastMathRow";
import { FAST_MATH_DOMAIN } from "@/components/practice/MathSkillsDomainRail";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "@/convex/seed/wholeNumberArithmeticGraph";
import { normalizeGradeTag } from "@/shared/grade";
import { humanizeStrand } from "@/shared/practiceDomainLabels";

type SkillNode = {
  nodeKey: string;
  label: string;
  strand: string | null;
  grade: string | null;
};

// Natural grade order (K→8) for ordering skill rows top-to-bottom within a
// strand — the vertical mirror of the Map tab's left→right grade x-axis.
// Ungraded/foundational nodes lead (rank -1), matching the map's leftmost
// (no-grade) anchor.
const GRADE_RANK: Record<string, number> = {
  K: 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
};
function gradeRank(grade: string | null): number {
  const normalized = normalizeGradeTag(grade);
  if (normalized == null) return -1;
  const known = GRADE_RANK[normalized];
  if (known !== undefined) return known;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : -1;
}

// The all-domains empty readout: a small, deliberately RECEDING "N/A" — 11px,
// weight 600, a gray (#b8c0cc) below the row text's weight/darkness, slightly
// letter-spaced — so a field of empties reads as calm background and the
// colored real numbers carry the eye (plan §8). Shared by BOTH the header level
// and the domain cells. Local on purpose: the shared `formatMasteryGradeLevel`
// still returns "—" for the per-domain surfaces that rely on it. `title`
// mirrors the sibling number's hover so the two states speak one hover language.
function EmptyReadout({ title }: { title?: string }) {
  return (
    <Text
      as="span"
      fontSize="11px"
      fontWeight="600"
      color="#b8c0cc"
      letterSpacing="0.03em"
      textAlign="center"
      title={title}
    >
      N/A
    </Text>
  );
}

/**
 * A plain neutral scholar avatar for the matrix column header, with an
 * optional small mastery-green checkmark badge when the scholar has completed
 * the domain (every skill placed-out or mastered) — the one mastery signal
 * this face still carries. No ring, dim, or greyscale tied to any other axis.
 */
function MasteryAvatar({
  name,
  image,
  colorKey,
  complete,
  size = "xs",
}: {
  name: string;
  image: string | null | undefined;
  colorKey: string;
  complete: boolean;
  size?: "2xs" | "xs" | "sm" | "md";
}) {
  return (
    <Box position="relative" lineHeight={0} borderRadius="full">
      <Avatar size={size} name={name} src={image ?? undefined} colorKey={colorKey} />
      {complete && (
        <Box
          position="absolute"
          bottom="-3px"
          right="-3px"
          bg="green.500"
          color="white"
          borderRadius="full"
          borderWidth="1.5px"
          borderColor="white"
          w="14px"
          h="14px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          lineHeight={0}
        >
          <Check size={8} weight="bold" />
        </Box>
      )}
    </Box>
  );
}

/**
 * ScholarColumnHeader — the ONE scholar column heading shared by all three
 * Math Skills matrices (all-domains, Fast math, single-domain). The geometry
 * lives here, in one place, so the three headings can't drift into different
 * paddings (they had: two hugged the avatar at the top and padded 6px below,
 * which read as an off-centre violet rectangle once selected).
 *
 * Selected and unselected occupy the SAME footprint: `selectableSurface` only
 * swaps the ring/wash colour (its unselected border is transparent, not
 * absent), and the symmetric `px`/`py` centre the avatar + name stack inside
 * the ring. Callers pass extra lines (a mastery grade level) as children — they
 * stack under the name inside the same ring.
 *
 * A checkpoint is NOT one of those lines. The heading is the top of a column of
 * cells, so it wears the cells' own `CheckpointCorner` — same tile, same hue,
 * same top-left, same inward round — and the column reads as one visual system.
 * The corner is absolutely positioned and `pointerEvents: none`, so it neither
 * reflows the centred stack nor adds a second click target inside the button;
 * the checkpoint is spoken instead by the heading's own name and hover, built
 * with the same `cellReadoutWithMarks` joiner the cells below use.
 *
 * Exported so the ONE heading can be tested RENDERED (its corner's geometry,
 * its click/selection semantics, the absence of any nested control) rather than
 * by grepping this file — the drift these guard against is invisible in source.
 */
export function ScholarColumnHeader({
  scholar,
  selected,
  complete = false,
  checkpoint = null,
  title,
  testId,
  onSelect,
  children,
}: {
  scholar: Pick<RosterScholar, "id" | "name" | "image">;
  selected: boolean;
  complete?: boolean;
  /** This scholar's checkpoint mode, or null when they have no checkpoint in
   *  this matrix's scope. Null draws nothing — a heading never gains a mark it
   *  has no state for. */
  checkpoint?: CheckpointCornerState | null;
  title: string;
  testId: string;
  onSelect: () => void;
  children?: ReactNode;
}) {
  // One sentence for the hover AND the accessible name, so the corner can stay
  // decorative without the checkpoint becoming colour-only.
  const readout = cellReadoutWithMarks(title, {
    outOfScope: false,
    checkpoint,
  });
  return (
    <Box
      as="button"
      onClick={onSelect}
      position="relative"
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="2px"
      px={1}
      py="2px"
      {...interactiveSurface}
      {...selectableSurface(selected)}
      _hover={{ bg: selected ? "violet.50" : "gray.100" }}
      _focusVisible={{
        outline: "2px solid",
        outlineColor: "violet.500",
        outlineOffset: "1px",
      }}
      aria-pressed={selected}
      aria-label={readout}
      data-testid={testId}
      title={readout}
    >
      <MasteryAvatar
        name={scholar.name}
        image={scholar.image}
        colorKey={scholar.id}
        complete={complete}
      />
      <Text
        fontSize="2xs"
        fontWeight="700"
        color={selected ? "violet.700" : "charcoal.500"}
        textAlign="center"
        lineClamp={1}
        maxW="72px"
      >
        {scholar.name.split(" ")[0]}
      </Text>
      {children}
      {checkpoint && <CheckpointCorner state={checkpoint} />}
    </Box>
  );
}

// ── All-domains map status (Lane B's `mapStatusForScholars` seam) ───────────
// The canonical per-(scholar × domain) check-in state, from the backend's
// `domainMapStatus` classifier. `converged` is otherwise the tinted NUMBER;
// the other five are what the matrix's empty cells render (spec §6).
type DomainMapStatus =
  | "converged"
  | "in_flight"
  | "shadow_placed"
  | "queued"
  | "available"
  | "ineligible";
type ScholarMapStatus = {
  scholarId: string;
  mappedCount: number;
  eligibleCount: number;
  perDomain: {
    domain: string;
    status: DomainMapStatus;
    /** Domain keys whose maps must converge first (for `queued`). */
    blockedBy: string[];
  }[];
};
type MapStatusResult = { scholars: ScholarMapStatus[] };

// The signed Δ under a level, 1dp, tabular, with a true minus sign — the exact
// read the background wash carries pre-attentively (spec §4.1). "0.0" for an
// on-the-nose match (no sign), "+0.2" / "−2.6" otherwise.
function formatCellDelta(level: number, gradeForAge: number): string {
  const rounded = Math.round((level - gradeForAge) * 10) / 10;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)}`;
}

type CellVisual = {
  /** Background wash (tint token/hex), or undefined for a WHITE cell. */
  bg?: string;
  /** Hover background: needs-mapping / in-progress invite in violet; a tinted
   *  cell keeps its wash (no flash); everything else lightens to grey. */
  hoverBg: string;
  /** Centred content — number+Δ, a mapping mark, a blank state-4, or N/A. */
  content: ReactNode;
  /** The reading appended after "<name> · " in the cell's title + aria-label. */
  readout: string;
};

// The ONE cell renderer, shared by the per-domain rows AND the "Across all
// math" summary row so the two can never draw the same quantity two ways (T1).
// Branches primarily on the domain map status; a real level always wins as the
// graded number (spec §4, §6).
function matrixCellVisual({
  level,
  gradeForAge,
  mode,
  status,
  blockedBy,
  mapLoading,
  readoutLabel,
  domainLabelFor,
}: {
  level: number | null;
  gradeForAge: number | null;
  mode: LevelColoringMode;
  status: DomainMapStatus | undefined;
  blockedBy: string[];
  mapLoading: boolean;
  readoutLabel: string;
  domainLabelFor: (domain: string) => string;
}): CellVisual {
  // A real level is the graded number (covers `converged` with a level, and
  // any interpolated frontier level). The wash carries the band; the digit is
  // neutral navy; the Δ rides beneath it in age-relative mode.
  if (level != null) {
    const tint = masteryLevelTint(level, gradeForAge, mode) ?? undefined;
    const showDelta = mode === "ageRelative" && gradeForAge != null;
    // The tone word is an AGE-relative claim — meaningful only in age-relative
    // mode, so pass a null anchor otherwise and let the helper omit it.
    const tone = masteryLevelToneLabel(
      level,
      mode === "ageRelative" ? gradeForAge : null,
    );
    const levelText = formatMasteryGradeLevel(level);
    const noAnchorHint =
      mode === "ageRelative" && gradeForAge == null
        ? " — no birthdate on file, try Absolute coloring"
        : "";
    return {
      bg: tint,
      hoverBg: tint ?? "gray.100",
      content: (
        <Flex direction="column" align="center" gap={0} lineHeight="1.1">
          <Text
            as="span"
            fontSize="sm"
            fontWeight="700"
            color={CELL_NUMBER_COLOR}
            fontVariantNumeric="tabular-nums"
          >
            {levelText}
          </Text>
          {showDelta && (
            <Text
              as="span"
              fontSize="10.5px"
              fontWeight="700"
              color={CELL_DELTA_COLOR}
              fontVariantNumeric="tabular-nums"
              letterSpacing="0.01em"
            >
              {formatCellDelta(level, gradeForAge)}
            </Text>
          )}
        </Flex>
      ),
      readout: `${readoutLabel}: ${levelText}${tone ? ` (${tone})` : ""}${noAnchorHint}`,
    };
  }

  // Empty cell. While the map query is still loading we can't know which mark
  // belongs here — fall back to today's plain N/A rather than flash a wrong one.
  if (mapLoading || status === undefined) {
    return {
      hoverBg: "gray.100",
      content: <EmptyReadout />,
      readout: `${readoutLabel}: no data yet`,
    };
  }

  switch (status) {
    case "converged":
      // State 4 — measured, just getting started (converged, null level).
      return {
        bg: STATE4_FLOOR_TINT,
        hoverBg: STATE4_FLOOR_TINT,
        content: null,
        readout: `${readoutLabel}: mapped — just getting started`,
      };
    case "available":
    case "shadow_placed": {
      const readout =
        status === "shadow_placed"
          ? `${readoutLabel}: needs mapping — practiced but never mapped`
          : `${readoutLabel}: needs mapping`;
      return {
        hoverBg: "violet.50",
        content: <MappingMark state="needsMapping" title={readout} />,
        readout,
      };
    }
    case "in_flight": {
      const readout = `${readoutLabel}: in progress`;
      return {
        hoverBg: "violet.50",
        content: <MappingMark state="inProgress" title={readout} />,
        readout,
      };
    }
    case "queued": {
      const names = blockedBy
        .map(domainLabelFor)
        .filter(Boolean)
        .join(", ");
      const readout = names
        ? `${readoutLabel}: not ready — waiting on ${names} to be mapped first`
        : `${readoutLabel}: not ready`;
      return {
        hoverBg: "gray.100",
        content: <MappingMark state="notReady" title={readout} />,
        readout,
      };
    }
    case "ineligible":
    default: {
      const readout = `${readoutLabel}: not ready`;
      return {
        hoverBg: "gray.100",
        content: <MappingMark state="notReady" title={readout} />,
        readout,
      };
    }
  }
}

// The §5 legend's on-demand "about these colours" copy — the exact thresholds
// and caveats that don't earn always-on space.
const COLOR_LEGEND_ABOUT =
  "Age-relative colours each level by how far it sits from the scholar's grade " +
  "for age (Δ): behind (Δ below −0.75), on pace (−0.75 to +0.75), ahead (+0.75 " +
  "to +1.75), far ahead (beyond +1.75). Behind is a calm slate, never red — a " +
  "not-yet, not a deficit. Absolute colours by the level itself (K–1 … 8+), so " +
  "a shared colour means a shared instructional group, regardless of age. " +
  "Empty cells: not ready (outside the affect-safe grade ring), needs mapping " +
  "(run a placement check-in), in progress (resume it). A white cell means not " +
  "measured yet; a pale-green cell with no number means measured, just getting " +
  "started.";

// One legend swatch — shows the actual CELL TINT, so a hairline border keeps it
// visible on white (spec §5).
function LegendSwatch({ bg }: { bg: string }) {
  return (
    <Box
      as="span"
      w="13px"
      h="13px"
      borderRadius="sm"
      bg={bg}
      borderWidth="1px"
      borderColor="blackAlpha.200"
      flex="0 0 auto"
    />
  );
}

function LegendDivider() {
  return <Box w="1px" h="16px" bg="gray.200" flex="0 0 auto" />;
}

// The always-on key under the matrix (spec §5): the "Level coloring" mode
// toggle, the active mode's swatches (which change SHAPE with the mode — a mode
// cue in themselves), the empty-cell marks, and an "about these colours"
// popover. The swatches are pulled from the ONE tint source (masteryLevelColor)
// rather than hardcoded hexes, so the key can never drift from the cells.
function MatrixColorLegend({
  mode,
  onModeChange,
}: {
  mode: LevelColoringMode;
  onModeChange: (mode: LevelColoringMode) => void;
}) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const ageSwatches: { label: string; bg: string }[] = [
    { label: "Behind", bg: masteryLevelTint(0, 2, "ageRelative") ?? "white" },
    { label: "On pace", bg: masteryLevelTint(4, 4, "ageRelative") ?? "white" },
    { label: "Ahead", bg: masteryLevelTint(5, 4, "ageRelative") ?? "white" },
    {
      label: "Far ahead",
      bg: masteryLevelTint(6.5, 4, "ageRelative") ?? "white",
    },
  ];
  const absBands: { label: string; bg: string }[] = [
    { label: "K–1", bg: masteryLevelTint(1, null, "absolute") ?? "white" },
    { label: "2–3", bg: masteryLevelTint(2.5, null, "absolute") ?? "white" },
    { label: "4–5", bg: masteryLevelTint(4.5, null, "absolute") ?? "white" },
    { label: "6–7", bg: masteryLevelTint(6.5, null, "absolute") ?? "white" },
    { label: "8+", bg: masteryLevelTint(8, null, "absolute") ?? "white" },
  ];
  return (
    <Flex
      align="center"
      gap={3}
      flexWrap="wrap"
      px={4}
      py={2}
      borderTopWidth="1px"
      borderColor="gray.100"
      bg="gray.50"
      fontSize="12.5px"
      color="charcoal.500"
      flexShrink={0}
      data-testid="mastery-legend"
    >
      <HStack gap={2} align="center">
        <Text as="span" fontWeight="700" color="charcoal.600">
          Level coloring
        </Text>
        <ViewToggle<LevelColoringMode>
          items={[
            { value: "ageRelative", label: "Age-relative" },
            { value: "absolute", label: "Absolute" },
          ]}
          value={mode}
          onChange={onModeChange}
          ariaLabel="Level coloring"
          testId="mastery-coloring-toggle"
        />
      </HStack>
      <LegendDivider />
      {mode === "ageRelative" ? (
        <HStack gap={3} align="center" flexWrap="wrap">
          <Text as="span" fontWeight="700" color="charcoal.600">
            Δ vs. grade for age:
          </Text>
          {ageSwatches.map((swatch) => (
            <HStack key={swatch.label} gap={1.5} align="center">
              <LegendSwatch bg={swatch.bg} />
              <Text as="span">{swatch.label}</Text>
            </HStack>
          ))}
        </HStack>
      ) : (
        <HStack gap={2} align="center">
          <Text as="span" fontWeight="700" color="charcoal.600">
            Level (K–8):
          </Text>
          {/* A CONTIGUOUS ramp bar — a visibly different silhouette from the
              spaced diverging chips, itself a mode cue. */}
          <Flex
            borderRadius="sm"
            overflow="hidden"
            borderWidth="1px"
            borderColor="gray.200"
            flex="0 0 auto"
          >
            {absBands.map((band) => (
              <Flex
                key={band.label}
                bg={band.bg}
                w="34px"
                h="18px"
                align="center"
                justify="center"
                fontSize="9.5px"
                fontWeight="700"
                color={CELL_NUMBER_COLOR}
              >
                {band.label}
              </Flex>
            ))}
          </Flex>
        </HStack>
      )}
      <LegendDivider />
      <HStack gap={3} align="center" flexWrap="wrap">
        <HStack gap={1.5} align="center">
          <MappingMark state="notReady" />
          <Text as="span">Not ready</Text>
        </HStack>
        <HStack gap={1.5} align="center">
          <MappingMark state="needsMapping" />
          <Text as="span">Needs mapping</Text>
        </HStack>
        <HStack gap={1.5} align="center">
          <MappingMark state="inProgress" />
          <Text as="span">In progress</Text>
        </HStack>
        <HStack gap={1.5} align="center">
          {/* State 4 is a TINT, not a glyph (mapped, nothing green yet — the
              numberless palest wash), so its legend swatch is the wash itself;
              a MappingMark here would lie about which channel carries it. */}
          <Box
            w="14px"
            h="14px"
            bg={STATE4_FLOOR_TINT}
            borderWidth="1px"
            borderColor="gray.200"
            aria-hidden
          />
          <Text as="span">Just starting</Text>
        </HStack>
      </HStack>
      <LegendDivider />
      {/* The Math plan's two marks live in the SAME persistent legend as the
          mastery and mapping vocabulary — policy a teacher can only decode by
          hovering is policy nobody audits. */}
      <HStack gap={3} align="center" flexWrap="wrap">
        <MathPlanLegendItems />
      </HStack>
      <Popover.Root
        open={aboutOpen}
        onOpenChange={(details) => setAboutOpen(details.open)}
        positioning={{ placement: "top-end" }}
      >
        <Popover.Trigger asChild>
          <Box
            as="button"
            ml="auto"
            display="inline-flex"
            alignItems="center"
            gap={1}
            color="violet.600"
            fontWeight="600"
            fontSize="12.5px"
            cursor="pointer"
            _hover={{ color: "violet.700" }}
          >
            ⓘ about these colours
          </Box>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content
              maxW="340px"
              w="90vw"
              bg="white"
              borderColor="gray.200"
              shadow="lg"
            >
              <Popover.Arrow />
              <Popover.Body p={3}>
                <Text fontSize="xs" color="charcoal.600" lineHeight="1.6">
                  {COLOR_LEGEND_ABOUT}
                </Text>
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
    </Flex>
  );
}

// The grade pill in the domain/strand header is the MATH GROUP's checkpoint
// setter. A scholar's own checkpoint is authored in one place only — the math
// plan editor in the detail rail — so these two hints name the exact pathway
// rather than implying a second per-scholar control lives here.
const CHECKPOINT_GROUP_HINT =
  "Pick a math group to set its checkpoint.";
const CHECKPOINT_SCHOLAR_HINT =
  "This scholar's checkpoint is set in the math plan, in the detail panel.";

/**
 * One pending group-checkpoint confirmation, whichever surface raised it. The
 * trigger travels with it so focus returns to the control the teacher was on
 * (a menu item is already gone by the time the dialog closes).
 */
type GroupCheckpointRequest = {
  intent: GroupCheckpointIntent;
  /** The band to write; null IS the clear. */
  target: MathPlanCheckpoint | null;
  /** The policy row shown when this confirmation opened. */
  current: MathPlanCheckpoint | null;
  /** Immutable race guard for this confirmation, including no-row → row. */
  expectedUpdatedAt: number | null;
  trigger: HTMLElement | null;
};

/**
 * Which surface set an All-domains SCHOLAR-only focus. The column heading and
 * the "Across all math" summary cell open the same panel, so the selection has
 * to remember the origin or both light up for one click. A domain (or Fast
 * math) focus has one surface, so it carries `null`.
 */
type AllDomainsFocusSource = "header" | "summary" | null;

// Shared height for the two selectable matrix cells (the skill-label cell and
// each scholar × skill dot cell) so their selection outlines match — tall
// enough to seat the 40px mastery dial with a hair of breathing room.
const MATRIX_CELL_H = "44px";
// Strand group headers match a full skill row's pitch (the 44px cell + its
// 4px top/bottom margins) so the grid keeps a steady vertical rhythm and the
// strands read as "meaty" anchors rather than thin dividers.
const STRAND_HEADER_HEIGHT = "52px";
// Fixed height for the sticky scholar-avatar header row. It's a constant (not
// content-sized) because the strand group headers stick to the TOP right below
// it — they need an exact offset to land against, or they'd overlap it. Tall
// enough to seat the avatar + first name + the D1 band-mix meter under it. It
// does NOT vary with checkpoint state: the checkpoint is a non-flow corner on
// the heading, so a cohort gaining or losing checkpoints can never resize this
// row or shift the strand offset derived from it.
const SCHOLAR_HEADER_H = "82px";
// The ALL-DOMAINS matrix header is now avatar + first name ONLY (Andy's Paper
// structure — the aggregate number and grade chips moved into the "Across all
// math" summary row and the "Grade for age" reference row respectively). So it
// is LIGHTER than the single-domain header (no meter, no chip line) and shrinks
// accordingly. Kept SEPARATE from SCHOLAR_HEADER_H so the single-domain matrix
// keeps its own pitch. It's the only sticky element at top:0 in its branch and
// no strand offset depends on it, so it sizes independently.
const ALL_DOMAINS_HEADER_H = "58px";
// Width of the all-domains matrix's frozen domain-label column. Fixed, not
// stretchy — see `allDomainsGridTemplate`. Sized to seat the longest domain
// label ("Integers & the coordinate plane") on one line.
const ALL_DOMAINS_LABEL_COL_W = 260;
// The two BANNER rows (grade-for-age reference + across-all-math summary) sit
// above the per-domain rows at the SAME height as a domain row — a uniform
// spreadsheet rhythm (founder, v9: the shorter banner rows broke the vertical
// rhythm). The zone hierarchy is carried by the HEAVY bottom rules alone.
const ALL_DOMAINS_BANNER_ROW_H = MATRIX_CELL_H;
// The heatmap cell number rides a light background wash, so it goes NEUTRAL —
// the wash carries the band, not the digit (spec §4). A dark navy from the app
// palette, chosen to clear WCAG AA on every tint. The Δ beneath it is a muted
// grey (tabular), and the grade-for-age reference decimals a lighter grey still.
const CELL_NUMBER_COLOR = "navy.700"; // neutral dark ink on any tint
const CELL_DELTA_COLOR = "gray.600"; // muted signed Δ, AA on every age tint
const GRADE_FOR_AGE_COLOR = "gray.400"; // the quiet reference decimals
// "Measured, just getting started" (converged with a null level — the one
// sliver of `converged` that has no number). The palest FLOOR tint, no numeral
// (spec / mapping-mark-spike §3): tinted so it reads as MEASURED (unlike a white
// empty cell), numberless so it reads as not-yet (unlike a graded cell). A calm
// pale green in BOTH colouring modes — masteryLevelTint has no dedicated floor
// export, and a single celebratory floor tint reads correctly either way.
const STATE4_FLOOR_TINT = "#edf6f0";

function FastMathMatrixRow({
  label,
  subLabel,
  scholars,
  readings,
  sliceFor,
  group = false,
  rowKey,
  onSelectFamily,
  onOpenScholar,
}: {
  label: string;
  subLabel: string;
  scholars: RosterScholar[];
  readings: ReadonlyMap<string, FastMathDetailedReading>;
  sliceFor: (reading: FastMathDetailedReading) => FastMathSliceReading | undefined;
  group?: boolean;
  rowKey: string;
  onSelectFamily?: () => void;
  onOpenScholar: (scholarId: string) => void;
}) {
  const gridTemplate = `${ALL_DOMAINS_LABEL_COL_W}px repeat(${scholars.length}, 72px)`;
  return (
    <Box
      display="grid"
      gridTemplateColumns={gridTemplate}
      alignItems="center"
      w="100%"
      borderTopWidth={group ? "1px" : undefined}
      borderBottomWidth="1px"
      borderColor={group ? "gray.200" : "gray.100"}
      data-testid={`fast-math-row-${rowKey}`}
    >
      <Box
        position="sticky"
        left={0}
        zIndex={1}
        h={MATRIX_CELL_H}
        bg={group ? "gray.50" : "white"}
        display="flex"
        alignItems="center"
        pl={group ? 4 : 7}
        pr={2}
      >
        <Box
          as={onSelectFamily ? "button" : "div"}
          onClick={onSelectFamily}
          w="full"
          minW={0}
          textAlign="left"
          borderRadius="md"
          px={onSelectFamily ? 1 : 0}
          py={1}
          cursor={onSelectFamily ? "pointer" : undefined}
          _hover={onSelectFamily ? { bg: "gray.100" } : undefined}
          _focusVisible={
            onSelectFamily
              ? {
                  outline: "2px solid",
                  outlineColor: "violet.500",
                  outlineOffset: "1px",
                }
              : undefined
          }
        >
          <Text
            fontSize="sm"
            fontWeight={group ? "700" : "600"}
            color={group ? "charcoal.700" : "charcoal.600"}
            lineClamp={1}
            title={label}
          >
            {label}
          </Text>
          <Text fontSize="2xs" color="gray.500" lineHeight="1.1">
            {subLabel}
          </Text>
        </Box>
      </Box>
      {scholars.map((scholar) => {
        const reading = readings.get(scholar.id);
        const slice = reading ? sliceFor(reading) : undefined;
        const readout = fastMathSliceCellReadout({
          reading: slice,
          baselineKnown: reading?.baselineKnown,
          scholarName: scholar.name,
          label,
        });
        const tint =
          slice &&
          (readout.status === "progress" || readout.status === "ready")
            ? fastMathPercentTint(slice.percent)
            : "white";
        return (
          <Box
            as="button"
            key={scholar.id}
            onClick={() => onOpenScholar(scholar.id)}
            h={MATRIX_CELL_H}
            w="100%"
            display="flex"
            alignItems="center"
            justifyContent="center"
            bg={tint}
            {...interactiveSurface}
            _hover={{ boxShadow: "inset 0 0 0 2px var(--chakra-colors-violet-300)" }}
            _focusVisible={{
              outline: "2px solid",
              outlineColor: "violet.500",
              outlineOffset: "-2px",
            }}
            title={readout.title}
            aria-label={`${readout.title} Open ${scholar.name}'s quick-facts report.`}
            data-testid={`fast-math-cell-${rowKey}-${scholar.id}`}
          >
            <Text
              fontSize="sm"
              fontWeight="700"
              color={
                readout.status === "loading" ||
                readout.status === "uncalibrated"
                  ? "gray.400"
                  : CELL_NUMBER_COLOR
              }
              fontVariantNumeric="tabular-nums"
            >
              {readout.display}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function FastMathDomainMatrix({
  scholars,
  readings,
  loading,
  onSelectFamily,
  onOpenScholar,
  selectedScholarId,
  onSelectScholar,
}: {
  scholars: RosterScholar[];
  readings: ReadonlyMap<string, FastMathDetailedReading>;
  loading: boolean;
  onSelectFamily: (skillKey: string) => void;
  onOpenScholar: (scholarId: string) => void;
  /** The scholar whose detail panel is open, if any. */
  selectedScholarId: string | null;
  onSelectScholar: (scholarId: string) => void;
}) {
  const gridTemplate = `${ALL_DOMAINS_LABEL_COL_W}px repeat(${scholars.length}, 72px)`;
  const minWidth = ALL_DOMAINS_LABEL_COL_W + scholars.length * 72;
  if (loading) {
    return (
      <Flex align="center" justify="center" gap={2} py={12}>
        <Spinner size="sm" color="violet.500" />
        <Text fontSize="sm" color="charcoal.400">
          Loading Fast math…
        </Text>
      </Flex>
    );
  }
  if (scholars.length === 0) {
    return (
      <Text px={4} py={10} textAlign="center" color="charcoal.400">
        No scholars in this group.
      </Text>
    );
  }

  return (
    <Flex direction="column" flex={1} h="full" minW={0} minH={0} bg="white">
      <Box flex={1} minH={0} minW={0} overflow="auto">
        <Box minW={`${minWidth}px`}>
          <Box
            display="grid"
            gridTemplateColumns={gridTemplate}
            // Centred, like the single-domain matrix's header: the selection
            // ring is drawn around the heading itself, so a bottom-aligned row
            // pinned it against the header's bottom rule.
            alignItems="center"
            h={ALL_DOMAINS_HEADER_H}
            bg="gray.50"
            borderBottomWidth="1px"
            borderColor="gray.100"
            position="sticky"
            top={0}
            zIndex={3}
          >
            <Flex
              position="sticky"
              left={0}
              zIndex={1}
              bg="gray.50"
              h="full"
              align="center"
              px={4}
            >
              <Text
                fontSize="2xs"
                fontWeight="700"
                color="charcoal.400"
                textTransform="uppercase"
                letterSpacing="0.04em"
              >
                Fact family
              </Text>
            </Flex>
            {scholars.map((scholar) => {
              // The lighter of the two gestures: select the scholar and open
              // their panel. Cells stay the heavier one (straight to the
              // quick-facts report).
              const headerSelected = selectedScholarId === scholar.id;
              return (
                <ScholarColumnHeader
                  key={scholar.id}
                  scholar={scholar}
                  selected={headerSelected}
                  onSelect={() => onSelectScholar(scholar.id)}
                  testId={`fast-math-scholar-header-${scholar.id}`}
                  title={`${scholar.name} · Fast math`}
                />
              );
            })}
          </Box>
          {FAST_MATH_OPERATION_GROUPS.map((operation) => (
            <Box key={operation.op}>
              <FastMathMatrixRow
                label={operation.label}
                subLabel={`${readings.values().next().value?.byOperation[operation.op].denominator ?? "—"} facts`}
                scholars={scholars}
                readings={readings}
                sliceFor={(reading) => reading.byOperation[operation.op]}
                group
                rowKey={`operation-${operation.op}`}
                onOpenScholar={onOpenScholar}
              />
              {operation.families.map((family) => (
                <FastMathMatrixRow
                  key={family.skillKey}
                  label={family.label}
                  subLabel={`${readings.values().next().value?.byFamily[family.skillKey]?.denominator ?? "—"} facts`}
                  scholars={scholars}
                  readings={readings}
                  sliceFor={(reading) => reading.byFamily[family.skillKey]}
                  rowKey={`family-${family.skillKey}`}
                  onSelectFamily={() => onSelectFamily(family.skillKey)}
                  onOpenScholar={onOpenScholar}
                />
              ))}
            </Box>
          ))}
        </Box>
      </Box>
      <Flex
        align="center"
        gap={3}
        flexWrap="wrap"
        px={4}
        py={2}
        borderTopWidth="1px"
        borderColor="gray.100"
        bg="gray.50"
        fontSize="12.5px"
        color="charcoal.500"
        flexShrink={0}
        data-testid="fast-math-legend"
      >
        <Text as="span" fontWeight="700" color="charcoal.600">
          % automatic
        </Text>
        {[0, 50, 100].map((percent) => (
          <HStack key={percent} gap={1.5}>
            <LegendSwatch bg={fastMathPercentTint(percent)} />
            <Text as="span">{percent}%</Text>
          </HStack>
        ))}
        <Text as="span">
          Darker green means more facts are automatic. Families overlap; do not
          add rows together.
        </Text>
      </Flex>
    </Flex>
  );
}

const MASTERY_LABEL: Record<MasteryState, string> = {
  locked: "Not started",
  struggling: STRUGGLING_TITLE_LABEL,
  frontier: "Practicing",
  placed: "Placed",
  fluent: "Fluent",
  overlearned: "Rock solid",
};

function MasteryStatusMark({
  status,
  size = 16,
}: {
  status: MasteryFilterKey;
  size?: number;
}) {
  return <MasteryDot state={status} size={size} />;
}

function MasteryStatusFilter({
  selected,
  onChange,
}: {
  selected: ReadonlySet<MasteryFilterKey>;
  onChange: (next: Set<MasteryFilterKey>) => void;
}) {
  const toggle = (status: MasteryFilterKey) => {
    const next = new Set(selected);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange(next);
  };
  // "Filter" is now a compact control — access ("All | Served") is the primary
  // way to narrow the class, so this stays a quiet secondary. A small count
  // rides the funnel only when some mastery bands are hidden.
  const hiddenCount = MASTERY_FILTER_ORDER.length - selected.size;

  return (
    <Menu.Root closeOnSelect={false} positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          h="auto"
          minH="32px"
          px={2.5}
          py={1.5}
          gap={1.5}
          flexShrink={0}
          color={hiddenCount > 0 ? "violet.700" : "charcoal.500"}
          _hover={{ bg: "gray.50" }}
          aria-label="Filter skills by mastery"
        >
          <Funnel size={14} weight={hiddenCount > 0 ? "fill" : "regular"} />
          <Text fontFamily="heading" fontSize="sm" fontWeight="600">
            Filter
          </Text>
          {hiddenCount > 0 && (
            <Box
              as="span"
              minW="16px"
              h="16px"
              px={1}
              borderRadius="full"
              bg="violet.500"
              color="white"
              fontFamily="heading"
              fontSize="2xs"
              fontWeight="700"
              lineHeight="16px"
              textAlign="center"
            >
              {hiddenCount}
            </Box>
          )}
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="200px">
            {MASTERY_FILTER_ORDER.map((status) => (
              <Menu.CheckboxItem
                key={status}
                value={status}
                checked={selected.has(status)}
                cursor="pointer"
                onClick={() => toggle(status)}
              >
                <HStack gap={2.5} justify="space-between" w="full">
                  <HStack gap={2}>
                    <MasteryStatusMark status={status} />
                    <Text>{MASTERY_FILTER_LABEL[status]}</Text>
                  </HStack>
                  <Menu.ItemIndicator color="violet.600" />
                </HStack>
              </Menu.CheckboxItem>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function MathSkillsMasteryView({
  domain,
  domainLabel,
  nodes,
  nodesLoading = false,
  allDomains,
  fastMathView,
  domains,
  onSelectDomain,
  selectedNode,
  onSelectNode,
  treeView,
  onToggleTreeView,
  search,
  onSearchChange,
  statuses,
  onStatusesChange,
  scopedScholars,
  effectiveScholarId,
  scopeGroupId,
  scopeGroupName,
  scopeControls,
  rosterLoading,
  reportScholarId,
  onOpenReport,
  onOpenContentForNode,
  onOpenStoriesForNode,
  storyCountByNode,
}: {
  /** null while `allDomains` is set — there is no single selected domain. */
  domain: string | null;
  domainLabel: string;
  nodes: SkillNode[];
  /** The selected domain changed but its catalog has not arrived yet. Keeps this
   * component mounted (preserving a cell drill) without treating loading as an
   * empty domain. */
  nodesLoading?: boolean;
  /** The "All domains" rail item: one ROW per registered domain, one COLUMN
   *  per scholar (the SAME column header the single-domain matrix uses), a
   *  rough grade-level number in each cell, and each scholar's aggregate
   *  grade level (across every domain) under their name. `domain`/`nodes` are
   *  ignored (null / empty) in this mode; the cross-domain data comes from a
   *  dedicated query inside this component. */
  allDomains?: boolean;
  /** The synthetic Fast math rail item: operation groups and fact-family
   * automaticity percentages, never grade levels. */
  fastMathView?: boolean;
  /** The registered practice domains (same set + order as the left rail),
   *  driving the matrix's ROWS in `allDomains` mode. Unused otherwise. */
  domains?: { domain: string; label: string }[];
  /** Navigate to a single domain's matrix — reused for both a domain ROW and
   *  its cells in `allDomains` mode. Optional: when absent, rows/cells render
   *  inert (no click handler wired up). */
  onSelectDomain?: (domain: string) => void;
  selectedNode: string | null;
  onSelectNode: (nodeKey: string) => void;
  treeView: boolean;
  onToggleTreeView: (treeView: boolean) => void;
  search: string;
  onSearchChange: (search: string) => void;
  statuses: ReadonlySet<MasteryFilterKey>;
  onStatusesChange: (statuses: Set<MasteryFilterKey>) => void;
  /** Resolved scope from the studio shell. */
  scopedScholars: RosterScholar[];
  effectiveScholarId: string;
  /** The selected math-group id ("" ⇒ no group entity), for checkpoint scope. */
  scopeGroupId?: string | null;
  /** Durable selected-group data from the studio shell. Unlike the checkpoint
   * query, these arrive with the resolved group row and can mount its action. */
  scopeGroupName?: string | null;
  /** Scope pickers (group + scholar focus) rendered in this body's control row. */
  scopeControls?: ReactNode;
  rosterLoading: boolean;
  /** The scholar whose full-bleed domain report (D2) is open, or "" for none. */
  reportScholarId: string;
  /** Open (id) / close (null) the full-bleed report — URL-routed by the page. */
  onOpenReport: (scholarId: string | null) => void;
  /** Cross-lens deep links from a report skill row to its authored content. */
  onOpenContentForNode: (nodeKey: string) => void;
  onOpenStoriesForNode: (nodeKey: string) => void;
  /** Per-node world-connection story counts (keyed by nodeKey) for the skill
   *  row subtext. Undefined while loading — the row then shows just the grade,
   *  never the developer-facing nodeKey slug. */
  storyCountByNode?: Record<string, number>;
}) {
  // The "Level coloring" mode (age-relative Δ vs. absolute level ramp) — the
  // all-domains heatmap's colour axis (spec §4.3). Seeded from the URL
  // (`?colorBy=level` ⇒ absolute; default age-relative) and written back with a
  // shallow `router.replace` so a shared/reloaded link keeps the mode. Owned
  // HERE (not the page) by design — it's a property of this body's matrix.
  const router = useRouter();
  const searchParams = useSearchParams();
  const [coloringMode, setColoringMode] = useState<LevelColoringMode>(() =>
    searchParams.get("colorBy") === "level" ? "absolute" : "ageRelative",
  );
  const handleColoringModeChange = (next: LevelColoringMode) => {
    setColoringMode(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "absolute") params.set("colorBy", "level");
    else params.delete("colorBy");
    const query = params.toString();
    router.replace(query ? `?${query}` : "?", { scroll: false });
  };
  // Map view opens the neighbourhood/readings in a detail drawer instead of a
  // sticky right panel, so the map can go full width.
  const [mapDrawerOpen, setMapDrawerOpen] = useState(false);
  // The List-view right detail panel is dismissable (bug: no close box) so the
  // matrix can reclaim the width; a slim rail re-opens it.
  const [detailOpen, setDetailOpen] = useState(true);
  // Which scholar's cell is drilled in the detail panel. null ⇒ skill-scoped
  // (the cohort distribution "sample"). Set by clicking one individual dot;
  // cleared by selecting a skill label or a Tree node. Local to this body — it
  // does NOT change the studio's global scholar scope (the rail/picker owns
  // that), so the matrix stays a full cohort comparison while you drill a cell.
  const [focusedScholarId, setFocusedScholarId] = useState<string | null>(null);
  // Which scholar's whole-DOMAIN drawer is open. null ⇒ not domain-scoped.
  // Set by clicking a column avatar; the detail then summarises that scholar
  // across every skill in the domain (parallel to the per-cell scholar × skill
  // drill, one altitude up). Mutually exclusive with focusedScholarId. Local,
  // lightweight — it does NOT change the studio's global scholar scope.
  const [domainScholarId, setDomainScholarId] = useState<string | null>(null);
  // The All-domains matrix has two axes, so a number identifies one scholar ×
  // domain reading. Keep that lightweight drill local: the left rail remains on
  // All domains while the existing scholar-domain detail opens alongside it.
  //
  // `domain: null` is the scholar-only focus, and TWO surfaces set it: the
  // column heading and that scholar's "Across all math" summary cell. They open
  // the same panel but they are not the same gesture, so `source` records which
  // one was clicked — without it both surfaces light up for a click on either,
  // and the teacher cannot tell what they selected. `source` is null for a
  // domain (or Fast math) focus, which has exactly one surface.
  const [allDomainsFocus, setAllDomainsFocus] = useState<{
    domain: string | null;
    scholarId: string;
    source: AllDomainsFocusSource;
  } | null>(null);
  // Fast math's own scholar focus — one axis, so a scholar id is the whole
  // selection.
  const [fastMathScholarId, setFastMathScholarId] = useState<string | null>(
    null,
  );
  const detailPresentation = useBreakpointValue({
    base: "drawer",
    lg: "panel",
  });

  const scholarImageById = useMemo(
    () => new Map(scopedScholars.map((s) => [s.id, s.image])),
    [scopedScholars],
  );

  const scopedVisibleScholars = effectiveScholarId
    ? scopedScholars.filter((scholar) => scholar.id === effectiveScholarId)
    : scopedScholars;
  // Capped column pool that drives the matrix query.
  const queryScholars = scopedVisibleScholars.slice(0, 64);

  // Keep-previous so switching domain/scope doesn't drop the matrix to a
  // spinner — the prior readings stay until the new ones arrive, then swap.
  // Skipped entirely in "All domains" mode (no single domain to query).
  const mastery = useSmoothedQuery(
    api.cohortPractice.masteryForScholars,
    rosterLoading || allDomains || domain == null
      ? "skip"
      : {
          scholarIds: queryScholars.map(
            (scholar) => scholar.id as Id<"users">,
          ),
          domain,
        },
  );
  const masteryByScholar = useMemo(
    () =>
      new Map(
        (mastery?.scholars ?? []).map((masteryScholar) => [
          String(masteryScholar.scholarId),
          masteryScholar,
        ]),
      ),
    [mastery],
  );
  // Each scholar's placement "still mapping" state in this domain, adopted from
  // the retired cohort frontier table (spec §3.4) so a scholar the placement
  // engine hasn't finished mapping renders honestly under their column instead
  // of a bare "—". Absent on an older server → treated as "mapped".
  const mappingStateByScholar = useMemo(() => {
    const map = new Map<string, "mapped" | "mapping" | "in_progress">();
    for (const row of mastery?.scholars ?? []) {
      const state = (row as { mappingState?: "mapped" | "mapping" | "in_progress" })
        .mappingState;
      if (state) map.set(String(row.scholarId), state);
    }
    return map;
  }, [mastery]);

  // The "All domains" rail item's cross-domain source: raw green/total counts
  // by grade, split PER seeded domain (not just the selected one) — a sibling
  // teacherQuery, gated off in the ordinary per-domain case. Raw per-domain
  // counts, not a computed level, so the frontier-interpolation FORMULA lives
  // in exactly one place (masteryGradeLevel.ts), reused by both this and the
  // per-domain path; here it runs once per domain and the levels are averaged.
  const crossDomainMastery = useQuery(
    api.cohortPractice.crossDomainMasteryForScholars,
    rosterLoading || !allDomains
      ? "skip"
      : {
          scholarIds: queryScholars.map(
            (scholar) => scholar.id as Id<"users">,
          ),
        },
  );
  const allDomainsDetailMastery = useQuery(
    api.cohortPractice.masteryForScholars,
    rosterLoading ||
      !allDomains ||
      !allDomainsFocus?.domain ||
      allDomainsFocus.domain === FAST_MATH_DOMAIN
      ? "skip"
      : {
          scholarIds: queryScholars.map(
            (scholar) => scholar.id as Id<"users">,
          ),
          domain: allDomainsFocus.domain,
        },
  );
  const allDomainsDetailSummary = useQuery(
    api.practiceItemPool.poolSummary,
    allDomains &&
      allDomainsFocus?.domain &&
      allDomainsFocus.domain !== FAST_MATH_DOMAIN
      ? { domain: allDomainsFocus.domain }
      : "skip",
  );
  const allDomainsDetailMasteryByScholar = useMemo(
    () =>
      new Map(
        (allDomainsDetailMastery?.scholars ?? []).map((masteryScholar) => [
          String(masteryScholar.scholarId),
          masteryScholar,
        ]),
      ),
    [allDomainsDetailMastery],
  );

  // Domain skill keys, and each scholar's band mix over them — still the D2
  // full-bleed report's source (via `bandCountsForScholar`); the D1 header
  // meter that used to read this too was replaced by the grade-level readout
  // below (the bars weren't a meaningful "how far along" signal — see the
  // grade-level readout instead).
  const domainNodeKeys = useMemo(() => nodes.map((node) => node.nodeKey), [nodes]);
  const bandCountsByScholar = useMemo(() => {
    const map = new Map<string, ReturnType<typeof bandCountsForScholar>>();
    for (const [scholarId, readout] of masteryByScholar) {
      const readingByKey = new Map(
        readout.readings.map((reading) => [reading.nodeKey, reading]),
      );
      map.set(scholarId, bandCountsForScholar(readingByKey, domainNodeKeys));
    }
    return map;
  }, [masteryByScholar, domainNodeKeys]);

  // Each scholar's mastery GRADE LEVEL (e.g. "Grade 3.6") — the D1 header
  // readout, replacing the green/amber band-mix meter. "Green" = the
  // fluent-family bands (`placed`, `fluent`, `overlearned` — the same set
  // `MASTERY_FILTER_ORDER` treats as the earned/mastered tiers); `frontier`
  // (practicing) and `locked` (not started) are NOT green. Per-domain: the
  // frontier-interpolated level over THIS domain's graded skills. All-domains:
  // the mean of each domain's OWN frontier level (`averageDomainMasteryLevel`
  // → `levelFromGradeBuckets` per domain), so the readout stays inside the
  // range of the per-domain numbers instead of collapsing below them.
  const gradeLevelByScholar = useMemo(() => {
    const map = new Map<string, number | null>();
    if (allDomains) {
      for (const row of crossDomainMastery?.scholars ?? []) {
        map.set(
          String(row.scholarId),
          averageDomainMasteryLevel(row.domains, gradeRank),
        );
      }
      return map;
    }
    for (const [scholarId, readout] of masteryByScholar) {
      const readingByKey = new Map(
        readout.readings.map((reading) => [reading.nodeKey, reading]),
      );
      const level = masteryGradeLevel(
        nodes,
        (nodeKey) => {
          const reading = readingByKey.get(nodeKey);
          if (!reading) return false;
          const band = masteryFilterKey(reading);
          return band === "placed" || band === "fluent" || band === "overlearned";
        },
        gradeRank,
      );
      map.set(scholarId, level);
    }
    return map;
  }, [allDomains, crossDomainMastery, masteryByScholar, nodes]);

  // The "All domains" matrix's CELLS: each scholar's PER-domain frontier level
  // (not the aggregate above) — scholarId → domain → level. Reuses the same
  // pre-aggregated per-domain gradeCounts `crossDomainMastery` already fetches
  // for the aggregate, so the frontier FORMULA still lives in exactly one
  // place (`levelFromGradeBuckets`) rather than being re-derived here.
  const domainLevelByScholar = useMemo(() => {
    const map = new Map<string, Map<string, number | null>>();
    if (!allDomains) return map;
    for (const row of crossDomainMastery?.scholars ?? []) {
      const perDomain = new Map<string, number | null>();
      for (const entry of row.domains) {
        perDomain.set(
          entry.domain,
          levelFromGradeBuckets(entry.gradeCounts, gradeRank),
        );
      }
      map.set(String(row.scholarId), perDomain);
    }
    return map;
  }, [allDomains, crossDomainMastery]);

  // The "All domains" matrix's Tier 1 freshness read (spec §9/§10): each
  // scholar's PER-domain retention aggregate — scholarId → domain →
  // DomainRetentionSummary. Sourced from the SAME `crossDomainMastery` row the
  // level/Δ above reuse, so there is exactly one server round-trip and one
  // retention vocabulary; the tooltip clause below is the only place it
  // surfaces — never a mark on the cell itself (founder ruling).
  const domainRetentionByScholar = useMemo(() => {
    const map = new Map<string, Map<string, DomainRetentionSummary>>();
    for (const row of crossDomainMastery?.scholars ?? []) {
      const perDomain = new Map<string, DomainRetentionSummary>();
      for (const entry of row.domains) {
        if (entry.retention) perDomain.set(entry.domain, entry.retention);
      }
      map.set(String(row.scholarId), perDomain);
    }
    return map;
  }, [crossDomainMastery]);

  // One "now" snapshot for the whole render pass's retention day-math, so
  // every cell/strip agrees on "today" instead of drifting across a long
  // matrix render. `useNow` (not a bare `Date.now()` during render) keeps
  // this pure and, per the house rule (T11), makes the day boundary actually
  // roll over on a session left open past midnight rather than freezing.
  const retentionNow = useNow(60_000);

  // Each scholar's "domain complete" mastery signal (every skill placed-out or
  // mastered), derived from the matrix readings. Not meaningful in "All
  // domains" mode (no single domain to be complete for) — stays empty there.
  const completeByScholar = useMemo(() => {
    const map = new Map<string, boolean>();
    if (allDomains || domain == null) return map;
    for (const scholar of queryScholars) {
      const readout = masteryByScholar.get(scholar.id);
      if (!readout) continue;
      map.set(scholar.id, isDomainComplete(readout.readings));
    }
    return map;
  }, [allDomains, queryScholars, masteryByScholar, domain]);

  // The displayed + SORTED matrix columns — sorted by mastery grade level,
  // descending (most-advanced first), nulls (no green skills at all) sorted
  // last, with a stable name tiebreak. Applied in exactly ONE place so the
  // header row, the dot cells, and every other `visibleScholars` consumer
  // below stay aligned — this sort applies in BOTH per-domain and All-domains
  // modes (deliverable #2 is general, not just the All-domains item).
  const visibleScholars = useMemo(() => {
    return [...queryScholars].sort((a, b) => {
      const levelA = gradeLevelByScholar.get(a.id) ?? null;
      const levelB = gradeLevelByScholar.get(b.id) ?? null;
      if (levelA == null && levelB == null) return a.name.localeCompare(b.name);
      if (levelA == null) return 1;
      if (levelB == null) return -1;
      if (levelA !== levelB) return levelB - levelA;
      return a.name.localeCompare(b.name);
    });
  }, [queryScholars, gradeLevelByScholar]);

  // Each scholar's CONTINUOUS grade for age (from DOB + a single `now`), the
  // anchor the age-relative heatmap colours against: Δ = level − gradeForAge
  // (spec §4.1a). A null entry (missing/invalid DOB) means "no age anchor" — in
  // age-relative mode the tint is neutral and no relative claim is made; in
  // absolute mode the anchor is irrelevant. Reused by the grade-for-age row,
  // the cell tints, and the tone labels.
  const now = useMemo(() => new Date(), []);
  const gradeForAgeByScholar = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const scholar of visibleScholars) {
      map.set(scholar.id, gradeForAgeFromDob(scholar.dateOfBirth, now));
    }
    return map;
  }, [visibleScholars, now]);

  // The all-domains empty-cell states: per-(scholar × domain) map status from
  // Lane B's `mapStatusForScholars` (the cohort-wide `domainMapStatus`
  // classifier). Cast locally until codegen regenerates `api.d.ts`. Only
  // fetched in all-domains mode.
  const mapStatus = useQuery(
    (
      api.cohortPractice as unknown as {
        mapStatusForScholars: FunctionReference<
          "query",
          "public",
          { scholarIds: Id<"users">[] },
          MapStatusResult
        >;
      }
    ).mapStatusForScholars,
    rosterLoading || !allDomains
      ? "skip"
      : {
          scholarIds: queryScholars.map((scholar) => scholar.id as Id<"users">),
        },
  );
  // scholarId → domain → { status, blockedBy }, for the per-cell join.
  const mapStatusByScholar = useMemo(() => {
    const map = new Map<
      string,
      Map<string, { status: DomainMapStatus; blockedBy: string[] }>
    >();
    for (const row of mapStatus?.scholars ?? []) {
      const perDomain = new Map<
        string,
        { status: DomainMapStatus; blockedBy: string[] }
      >();
      for (const entry of row.perDomain) {
        perDomain.set(entry.domain, {
          status: entry.status,
          blockedBy: entry.blockedBy,
        });
      }
      map.set(String(row.scholarId), perDomain);
    }
    return map;
  }, [mapStatus]);

  // Each scholar's FAST MATH reading — the share of the canonical Quick-facts
  // space that is automatic for them, plus any calculator license an adult has
  // already granted. One bounded cohort query (same shape and cap as
  // `mapStatusForScholars`), never a per-scholar fanout. Cast locally until
  // codegen regenerates `api.d.ts` — same idiom as `mapStatusForScholars`.
  // Fetched for the all-domains roll-up and the dedicated Fast math view.
  const fastMath = useQuery(
    api.cohortPractice.fastMathForScholars,
    rosterLoading || (!allDomains && !fastMathView)
      ? "skip"
      : {
          scholarIds: queryScholars.map((scholar) => scholar.id as Id<"users">),
        },
  );
  const fastMathByScholar = useMemo(() => {
    const map = new Map<string, FastMathDetailedReading>();
    for (const row of fastMath?.scholars ?? []) {
      map.set(String(row.scholarId), {
        automaticCount: row.automaticCount,
        denominator: row.denominator,
        percent: row.percent,
        ready: row.ready,
        baselineKnown: row.baselineKnown,
        byOperation: row.byOperation,
        byFamily: row.byFamily,
        license: row.license,
      });
    }
    return map;
  }, [fastMath]);

  // Domain key → display label, spanning EVERY registered domain (not just the
  // selected one) — the scholar × domain map-status strip's `queued` line names
  // a prerequisite domain that may differ from the one in view. Falls back to
  // the raw key for an unregistered domain.
  const domainLabelForKey = useMemo(() => {
    const byKey = new Map((domains ?? []).map((d) => [d.domain, d.label]));
    return (key: string) => byKey.get(key) ?? key;
  }, [domains]);

  // ── The Math plan ───────────────────────────────────────────────────────
  // ONE batch read of both authored controls for EVERY visible scholar, so the
  // two marks are present in the default all-scholar view. (It replaces the old
  // group-gated checkpoint-mode query, which left the default view unmarked —
  // policy that only appears once you narrow the view is policy nobody audits.)
  // `queryScholars` is already capped to the query's 64-scholar bound.
  const mathPlanRows = useQuery(
    api.mathPlans.forScholars,
    queryScholars.length > 0
      ? {
          scholarIds: queryScholars.map((scholar) => scholar.id as Id<"users">),
        }
      : "skip",
  );
  const mathPlansLoading = queryScholars.length > 0 && mathPlanRows === undefined;
  const planByScholar = useMemo(
    () =>
      new Map<string, MathPlanRow>(
        (mathPlanRows ?? []).map((row) => [row.scholarId, row as MathPlanRow]),
      ),
    [mathPlanRows],
  );

  // The math GROUP's checkpoint stays inspectable and settable from the
  // domain/strand grade pill — it is the same one control at group altitude,
  // not a third one. A focused scholar degrades the pill to a read-only hint
  // pointing at the math plan editor, so there is exactly one per-scholar author.
  //
  // Every group-altitude author — the pill AND the panel band control — raises a
  // request that `ConfirmGroupCheckpointDialog` answers, and the single write
  // lives here behind it. There is deliberately no unguarded path: one pick
  // rewrites policy for every member of the group, including members a matrix
  // filter is currently hiding.
  const checkpointGroupId = scopeGroupId ?? null;
  const groupCheckpointEditable = !!checkpointGroupId && !effectiveScholarId;
  const setGroupCheckpoint = useMutation(api.mathFocus.setGroupCheckpoint);
  const clearGroupCheckpoint = useMutation(api.mathFocus.clearGroupCheckpoint);
  const checkpointForGroupState = useQuery(
    api.mathFocus.checkpointForGroup,
    checkpointGroupId
      ? { groupId: checkpointGroupId as Id<"scholarGroups"> }
      : "skip",
  );
  const [checkpointRequest, setCheckpointRequest] =
    useState<GroupCheckpointRequest | null>(null);
  // The control that opened the confirmation, kept OUTSIDE the request so it
  // survives the request being cleared — Ark asks for the return target while
  // closing, by which point the request is already gone.
  const checkpointTriggerRef = useRef<HTMLElement | null>(null);
  const [checkpointSaving, setCheckpointSaving] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  // The preview the confirmation reads. A set/move previews the PROPOSED target
  // (that is what resolves scope blockers); a clear has no target, so it
  // previews the group as it stands. Reactive on purpose — another teacher
  // moving a scholar while this is open should change what it says.
  const checkpointPreview = useQuery(
    api.mathFocus.checkpointForGroup,
    checkpointGroupId && checkpointRequest
      ? {
          groupId: checkpointGroupId as Id<"scholarGroups">,
          ...(checkpointRequest.target
            ? { target: checkpointRequest.target }
            : {}),
        }
      : "skip",
  );
  // Which grade the header pill shows as current: the focused scholar's own
  // effective checkpoint when one scholar is in view, else the group's.
  const focusedPlan = effectiveScholarId
    ? planByScholar.get(effectiveScholarId)
    : undefined;
  const currentCheckpointTarget = effectiveScholarId
    ? (focusedPlan?.checkpoint ?? null)
    : (checkpointForGroupState?.checkpoint ?? null);
  const checkpointHint = effectiveScholarId
    ? CHECKPOINT_SCHOLAR_HINT
    : CHECKPOINT_GROUP_HINT;
  const groupCheckpoint = checkpointForGroupState?.checkpoint ?? null;
  const groupCheckpointName =
    checkpointForGroupState?.groupName ?? scopeGroupName ?? "this math group";
  /** A checkpoint band in words, for whichever domain it lives in. */
  const bandInWords = (
    band: Pick<MathPlanCheckpoint, "domain" | "strand" | "grade">,
  ) =>
    checkpointLabel(band, {
      domainLabel: domainLabelForKey,
      strandLabel: humanizeStrand,
    });

  // Cohort standing against the checkpoint band, counted from the same rows the
  // marks come from. A suspended (out-of-scope) checkpoint has no mode, so it is
  // counted as needing attention instead of being folded into either mode.
  const checkpointModeRollup = useMemo(() => {
    if (!mathPlanRows) return null;
    let toward = 0;
    let deeper = 0;
    let needsAttention = 0;
    for (const row of mathPlanRows) {
      if (!row.checkpoint) continue;
      if (row.conflict) needsAttention += 1;
      else if (row.mode === "deeper") deeper += 1;
      else toward += 1;
    }
    if (toward + deeper + needsAttention === 0) return null;
    return { toward, deeper, needsAttention };
  }, [mathPlanRows]);

  // A pick never writes: it raises a request, and the confirmation below owns the
  // one mutation that follows. `move` vs `set` is read off the group's STORED
  // checkpoint so the dialog can name the band being left.
  const requestBandCheckpoint = (
    grade: string,
    strand: string | undefined,
    trigger: HTMLElement | null,
  ) => {
    if (
      !groupCheckpointEditable ||
      !checkpointGroupId ||
      domain == null ||
      checkpointForGroupState === undefined
    ) {
      return;
    }
    const target: MathPlanCheckpoint = {
      domain,
      grade,
      ...(strand === undefined ? {} : { strand }),
    };
    setCheckpointError(null);
    checkpointTriggerRef.current = trigger;
    setCheckpointRequest({
      intent: groupCheckpointIntent(groupCheckpoint, target),
      target,
      current: groupCheckpoint,
      expectedUpdatedAt: groupCheckpoint?.updatedAt ?? null,
      trigger,
    });
  };

  const requestClearBandCheckpoint = (trigger: HTMLElement | null) => {
    if (
      !groupCheckpointEditable ||
      !checkpointGroupId ||
      checkpointForGroupState === undefined
    ) {
      return;
    }
    setCheckpointError(null);
    checkpointTriggerRef.current = trigger;
    setCheckpointRequest({
      intent: "clear",
      target: null,
      current: groupCheckpoint,
      expectedUpdatedAt: groupCheckpoint?.updatedAt ?? null,
      trigger,
    });
  };

  const closeCheckpointRequest = () => {
    if (checkpointSaving) return;
    setCheckpointRequest(null);
    setCheckpointError(null);
  };

  // EXACTLY one write per confirmation, at group altitude — never N per-scholar
  // writes. A failure keeps the dialog open carrying the server's own words,
  // because the next move (widen a scope, free a scholar from another group) is
  // in them.
  const confirmCheckpointRequest = async () => {
    const checkpointPreviewRevision =
      checkpointPreview === undefined
        ? undefined
        : (checkpointPreview.checkpoint?.updatedAt ?? null);
    if (
      !checkpointRequest ||
      !checkpointGroupId ||
      checkpointPreviewRevision === undefined ||
      checkpointPreviewRevision !== checkpointRequest.expectedUpdatedAt
    ) {
      return;
    }
    setCheckpointSaving(true);
    setCheckpointError(null);
    try {
      if (checkpointRequest.target === null) {
        await clearGroupCheckpoint({
          groupId: checkpointGroupId as Id<"scholarGroups">,
          expectedUpdatedAt: checkpointRequest.expectedUpdatedAt,
        });
        toaster.create({
          description: "Cleared the math group checkpoint",
          type: "success",
        });
      } else {
        await setGroupCheckpoint({
          groupId: checkpointGroupId as Id<"scholarGroups">,
          ...checkpointRequest.target,
          expectedUpdatedAt: checkpointRequest.expectedUpdatedAt,
        });
        toaster.create({
          description: `Math group checkpoint set to Grade ${checkpointRequest.target.grade}`,
          type: "success",
        });
      }
      setCheckpointRequest(null);
    } catch (error) {
      setCheckpointError(
        error instanceof Error ? error.message : "Could not set checkpoint.",
      );
    } finally {
      setCheckpointSaving(false);
    }
  };

  // One scholar's plan, stated in words, wherever the rail resolves a scholar.
  // The same block in every rail path — a teacher should not have to learn two
  // places to read the same two controls.
  const [editPlanScholarId, setEditPlanScholarId] = useState<string | null>(null);
  // Collapsed by default: everywhere except All domains × scholar the panel's
  // subject is a specific domain, strand, or skill, and the plan is context for
  // it rather than the thing being read.
  const renderMathPlanFor = (
    scholarId: string,
    options?: { compact?: boolean },
  ) => (
    <MathPlanRailSection
      plan={planByScholar.get(scholarId)}
      loading={mathPlansLoading}
      domainLabel={domainLabelForKey}
      strandLabel={humanizeStrand}
      onEdit={() => setEditPlanScholarId(scholarId)}
      compact={options?.compact ?? true}
    />
  );
  const editPlanScholar = editPlanScholarId
    ? visibleScholars.find((scholar) => scholar.id === editPlanScholarId)
    : undefined;
  // ONE editor element, rendered by EVERY branch that hands the rail an
  // onEdit — a branch that renders the rail without this mounts a button that
  // sets state nothing reads.
  //
  // On narrow screens the rail is hosted inside a modal drawer, and a modal
  // Ark dialog marks the rest of the document inert (`hideContentBelow`) while
  // holding the focus trap. The editor is portalled as that drawer's SIBLING,
  // so opening it inside an open drawer puts it under that inert layer. Every
  // drawer that can host the rail therefore SUSPENDS while the editor is open
  // (`&& !editPlanScholarId` in its `open`) and returns when it closes: one
  // modal at a time, and the teacher lands back where they were. Flipping a
  // CONTROLLED Ark dialog's `open` does not fire `onOpenChange`, so suspending
  // a drawer never discards the selection it was showing.
  const editMathPlanDialog = (
    <EditMathPlanDialog
      open={!!editPlanScholarId}
      scholarId={editPlanScholarId}
      scholarName={editPlanScholar?.name ?? "this scholar"}
      plan={editPlanScholarId ? planByScholar.get(editPlanScholarId) : undefined}
      onClose={() => setEditPlanScholarId(null)}
    />
  );

  const checkpointConfirmDialog = (
    <ConfirmGroupCheckpointDialog
      open={!!checkpointRequest}
      intent={checkpointRequest?.intent ?? "set"}
      groupName={groupCheckpointName}
      targetLabel={
        checkpointRequest?.target ? bandInWords(checkpointRequest.target) : null
      }
      targetChipLabel={
        checkpointRequest?.target ? `G${checkpointRequest.target.grade}` : null
      }
      currentLabel={
        checkpointRequest?.current ? bandInWords(checkpointRequest.current) : null
      }
      expectedUpdatedAt={checkpointRequest?.expectedUpdatedAt}
      checkpointRevision={
        checkpointPreview === undefined
          ? undefined
          : (checkpointPreview.checkpoint?.updatedAt ?? null)
      }
      members={checkpointPreview?.members}
      saving={checkpointSaving}
      error={checkpointError}
      onConfirm={() => void confirmCheckpointRequest()}
      onCancel={closeCheckpointRequest}
      finalFocusEl={() => checkpointTriggerRef.current}
    />
  );

  const searchedNodes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? nodes.filter(
          (node) =>
            node.label.toLowerCase().includes(needle) ||
            node.nodeKey.toLowerCase().includes(needle) ||
            node.strand?.toLowerCase().includes(needle),
        )
      : nodes;
  }, [nodes, search]);
  const visibleNodes = useMemo(() => {
    if (mastery === undefined) return searchedNodes;
    return searchedNodes.filter((node) =>
      visibleScholars.some((visibleScholar) => {
        const reading = masteryByScholar
          .get(visibleScholar.id)
          ?.readings.find((candidate) => candidate.nodeKey === node.nodeKey);
        return reading
          ? readingMatchesMasteryFilters(reading, statuses)
          : false;
      }),
    );
  }, [mastery, masteryByScholar, searchedNodes, statuses, visibleScholars]);
  const strands = useMemo(() => {
    const grouped = new Map<string, SkillNode[]>();
    for (const node of visibleNodes) {
      const strand = node.strand ?? "other";
      grouped.set(strand, [...(grouped.get(strand) ?? []), node]);
    }
    // Order rows within each strand by natural grade (K→8), top to bottom —
    // the vertical mirror of the Map tab's left→right grade x-axis. visibleNodes
    // preserves the query's domain-wide topological `order`, and Array.sort is
    // stable, so nodes sharing a grade keep that order (the map's within-band
    // tiebreak) instead of appearing to jump around.
    for (const [, strandNodes] of grouped) {
      strandNodes.sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade));
    }
    return [...grouped];
  }, [visibleNodes]);
  const effectiveNodeKey =
    selectedNode && visibleNodes.some((node) => node.nodeKey === selectedNode)
      ? selectedNode
      : (visibleNodes[0]?.nodeKey ?? null);
  const effectiveNode = nodes.find((node) => node.nodeKey === effectiveNodeKey);
  // Resolve the scholar the detail panel drills: an explicitly clicked dot when
  // it is still in scope, else the studio's single-scholar scope (so a scoped
  // scholar auto-focuses), else null ⇒ skill-scoped distribution.
  const focusScholarId =
    focusedScholarId && visibleScholars.some((s) => s.id === focusedScholarId)
      ? focusedScholarId
      : effectiveScholarId || null;
  // The domain-scoped drawer scholar, resolved to a still-visible column. When
  // set it takes precedence over focusScholarId (scholar × domain, one altitude
  // above scholar × skill).
  const domainFocusId =
    domainScholarId && visibleScholars.some((s) => s.id === domainScholarId)
      ? domainScholarId
      : null;
  // The subject the detail drawer is titled after: the drilled scholar when the
  // drawer is showing one scholar across the domain, else the selected skill
  // (skill-scoped and scholar × skill are both fundamentally about the skill).
  const domainFocusScholar = domainFocusId
    ? visibleScholars.find((s) => s.id === domainFocusId)
    : undefined;
  const detailTitle = domainFocusScholar
    ? domainFocusScholar.name
    : (effectiveNode?.label ?? "Detail");
  const neighbourhood = useQuery(
    api.nodeNeighbourhood.neighbourhood,
    effectiveNode ? { nodeKey: effectiveNode.nodeKey } : "skip",
  );
  const storyCount = neighbourhood?.stories.length ?? 0;
  const storyCountLabel = `${storyCount} ${storyCount === 1 ? "story" : "stories"}`;
  const skillMeta = `${effectiveNode?.grade ? `Grade ${effectiveNode.grade} · ` : ""}${storyCountLabel}`;

  // The GROUP's checkpoint, authored on the band the selected skill names —
  // supplied ONLY to the desktop detail frame's mount, and once the checkpoint
  // preview resolves a real accessible member total. This count is server
  // authority, never a filtered matrix count.
  // The panel itself renders it only in the
  // skill-scoped branch, which is what keeps it off a drilled scholar: that
  // scholar's checkpoint is authored in the math plan, one author per altitude.
  const skillBand: MathPlanCheckpoint | null =
    domain != null && effectiveNode?.grade
      ? {
          domain,
          grade: effectiveNode.grade,
          ...(effectiveNode.strand === null
            ? {}
            : { strand: effectiveNode.strand }),
        }
      : null;
  const groupCheckpointControl =
    groupCheckpointEditable && domain != null && effectiveNode ? (
      checkpointForGroupState === undefined ? (
        <Box
          minH="44px"
          mb={4}
          display="flex"
          alignItems="center"
          data-testid="group-checkpoint-control-loading"
        >
          <Text fontSize="xs" color="charcoal.400">
            Checking group checkpoint…
          </Text>
        </Box>
      ) : checkpointForGroupState.members.total > 0 ? (
      <GroupCheckpointBandControl
        groupName={groupCheckpointName}
        memberTotal={checkpointForGroupState.members.total}
        band={skillBand}
        bandLabel={skillBand ? bandInWords(skillBand) : null}
        bandSkillCount={
          nodes.filter(
            (candidate) =>
              (effectiveNode.strand == null ||
                candidate.strand === effectiveNode.strand) &&
              candidate.grade === effectiveNode.grade,
          ).length
        }
        currentLabel={groupCheckpoint ? bandInWords(groupCheckpoint) : null}
        isCurrent={
          skillBand !== null && sameCheckpointBand(groupCheckpoint, skillBand)
        }
        onRequest={(intent, target, trigger) => {
          if (intent === "clear" || !target) {
            requestClearBandCheckpoint(trigger);
            return;
          }
          requestBandCheckpoint(target.grade, target.strand, trigger);
        }}
      />
      ) : undefined
    ) : undefined;

  const gridTemplate = `minmax(230px, 1fr) repeat(${visibleScholars.length}, 72px)`;
  const gridMinWidth = 230 + visibleScholars.length * 72;
  // The ALL-DOMAINS matrix pins its label column instead of letting it stretch
  // (`1fr`). Stretching made the column a spring: opening the 340px detail
  // panel narrowed the pane, the column collapsed to its 230px floor, and every
  // scholar column jumped left with it — a measured 250px shift of the exact
  // numbers the teacher just clicked. Pinned, the columns sit at a constant x,
  // so opening the panel only clips the right edge into the scroll the pane
  // already has. The single-domain matrix keeps `1fr`: its first column holds
  // long skill names that genuinely want the slack.
  const allDomainsGridTemplate = `${ALL_DOMAINS_LABEL_COL_W}px repeat(${visibleScholars.length}, 72px)`;
  const allDomainsGridMinWidth =
    ALL_DOMAINS_LABEL_COL_W + visibleScholars.length * 72;

  // Selecting a skill (label cell, Tree node, search) clears any drilled cell so
  // the detail returns to the skill-scoped cohort distribution.
  const handleSelectNode = (nodeKey: string) => {
    setFocusedScholarId(null);
    setDomainScholarId(null);
    setDetailOpen(true);
    onSelectNode(nodeKey);
    if (treeView) setMapDrawerOpen(true);
  };
  // Clicking one scholar's cell drills the detail to that scholar × this skill.
  const handleSelectCell = (nodeKey: string, scholarId: string) => {
    setDomainScholarId(null);
    setFocusedScholarId(scholarId);
    setDetailOpen(true);
    onSelectNode(nodeKey);
  };
  // Clicking a column avatar opens that scholar's whole-domain drawer — a
  // lightweight peek (NOT a scope change): it does not collapse the matrix or
  // flip the rail, it just re-scopes the detail panel to scholar × domain.
  const handleSelectScholarDomain = (scholarId: string) => {
    setFocusedScholarId(null);
    setDomainScholarId((current) => (current === scholarId ? null : scholarId));
    setDetailOpen(true);
  };
  // The same gesture on the All-domains matrix's headings, and on each
  // scholar's "Across all math" summary cell. No domain is chosen yet, so the
  // panel opens on the one reading that spans all of them: the scholar's Math
  // plan. Same panel from either surface, but only the surface actually clicked
  // takes the highlight — so `source` is part of the selection, and clicking
  // the other surface MOVES the highlight rather than lighting both.
  const handleSelectAllDomainsScholar = (
    scholarId: string,
    source: Exclude<AllDomainsFocusSource, null>,
  ) => {
    setAllDomainsFocus((current) =>
      current &&
      current.domain == null &&
      current.scholarId === scholarId &&
      current.source === source
        ? null
        : { domain: null, scholarId, source },
    );
    setDetailOpen(true);
  };
  // Fast math has one axis of readings per scholar, so its heading click is the
  // whole selection gesture: the panel states the overall reading and escalates
  // to the existing quick-facts report. Cells keep going straight to it.
  const handleSelectFastMathScholar = (scholarId: string) => {
    setFastMathScholarId((current) => (current === scholarId ? null : scholarId));
    setDetailOpen(true);
  };

  if (fastMathView) {
    const reportDomain =
      (domains ?? []).find(
        (entry) => entry.domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      )?.domain ?? null;
    const openFamily = (skillKey: string) => {
      if (!reportDomain) return;
      onSelectDomain?.(reportDomain);
      onSelectNode(skillKey);
    };
    const openScholar = (scholarId: string) => {
      if (reportDomain) onSelectDomain?.(reportDomain);
      onOpenReport(scholarId);
    };
    const fastMathScholar = fastMathScholarId
      ? visibleScholars.find((scholar) => scholar.id === fastMathScholarId)
      : undefined;
    const fastMathDetailBody = fastMathScholar ? (
      <FastMathScholarDetail
        scholar={fastMathScholar}
        orderedScholars={visibleScholars}
        scholarImageById={scholarImageById}
        reading={fastMathByScholar.get(fastMathScholar.id)}
        onStep={(scholarId) => setFastMathScholarId(scholarId)}
        onOpenReport={openScholar}
        onClose={() => setFastMathScholarId(null)}
      />
    ) : null;
    return (
      <Flex direction="column" h="full" minW={0} bg="white">
        <Flex flex={1} minH={0} overflow="hidden">
          <FastMathDomainMatrix
            scholars={visibleScholars}
            readings={fastMathByScholar}
            loading={rosterLoading || fastMath === undefined}
            onSelectFamily={openFamily}
            onOpenScholar={openScholar}
            selectedScholarId={fastMathScholarId}
            onSelectScholar={handleSelectFastMathScholar}
          />
          {fastMathDetailBody ? (
            detailOpen ? (
              <MasteryDetailFrame
                title={fastMathScholar?.name ?? ""}
                onClose={() => setDetailOpen(false)}
              >
                {fastMathDetailBody}
              </MasteryDetailFrame>
            ) : (
              <MasteryDetailRail onOpen={() => setDetailOpen(true)} />
            )
          ) : null}
        </Flex>
        {/* Narrow screens get the same body as a drawer. This one hosts no
            Math plan rail, so it never has to yield to the plan editor. */}
        <Drawer.Root
          open={
            detailPresentation === "drawer" && detailOpen && !!fastMathDetailBody
          }
          onOpenChange={(details) => {
            if (!details.open) setFastMathScholarId(null);
          }}
          placement="end"
          size="sm"
        >
          <Portal>
            <Drawer.Backdrop display={{ base: "block", lg: "none" }} />
            <Drawer.Positioner display={{ base: "flex", lg: "none" }}>
              <Drawer.Content bg="white">
                <Drawer.Header borderBottomWidth="1px" borderColor="gray.100">
                  <Drawer.Title color="navy.600">
                    {fastMathScholar?.name}
                  </Drawer.Title>
                  <Drawer.CloseTrigger asChild>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Close detail panel"
                    >
                      <X size={15} />
                    </Button>
                  </Drawer.CloseTrigger>
                </Drawer.Header>
                <Drawer.Body p={0}>{fastMathDetailBody}</Drawer.Body>
              </Drawer.Content>
            </Drawer.Positioner>
          </Portal>
        </Drawer.Root>
      </Flex>
    );
  }

  // ── "All domains" rail item ─────────────────────────────────────────────
  // A real matrix: one ROW per registered domain, one COLUMN per scholar (the
  // SAME scholar header the single-domain matrix uses), a rough grade-level
  // number in each cell, and each scholar's AGGREGATE grade level (across
  // every domain, already computed above by `gradeLevelByScholar`) under
  // their name. `domain == null` also covers here defensively (there is no
  // other reason it would be null). Quiet typography throughout — a bare
  // number, no colour scale, no percent (diagnostics, not scores).
  if (allDomains || domain == null) {
    const loading = rosterLoading || crossDomainMastery === undefined;
    const domainRows = domains ?? [];
    // Domain key → display label (the same source the rows render), for the
    // `queued` blocked-by tooltip. Falls back to the raw key if unregistered.
    const domainLabelByKey = new Map(
      domainRows.map((entry) => [entry.domain, entry.label]),
    );
    const domainLabelFor = (key: string) => domainLabelByKey.get(key) ?? key;
    // The map-status query is a second data source per cell; while it loads we
    // show N/A for empty cells rather than flash a wrong mark (spec §6).
    const mapLoading = mapStatus === undefined;
    // Every scholar shares the one canonical denominator; take it from the
    // first reading rather than restating the number in the client.
    const fastMathDenominator = fastMath?.scholars[0]?.denominator ?? null;
    const allDomainsFocusScholar = allDomainsFocus
      ? visibleScholars.find(
          (scholar) => scholar.id === allDomainsFocus.scholarId,
        )
      : undefined;
    const allDomainsFocusDomain = allDomainsFocus?.domain
      ? domainRows.find((entry) => entry.domain === allDomainsFocus.domain)
      : undefined;
    // A heading click focuses the scholar with no domain chosen yet.
    const allDomainsScholarOnly =
      !!allDomainsFocusScholar && allDomainsFocus?.domain == null;
    const allDomainsFastMath =
      !!allDomainsFocusScholar &&
      allDomainsFocus?.domain === FAST_MATH_DOMAIN;
    const allDomainsSummaryMatches =
      allDomainsDetailSummary !== undefined &&
      allDomainsDetailSummary.domain === allDomainsFocus?.domain;
    const allDomainsDetailNodes: SkillNode[] =
      allDomainsSummaryMatches
        ? allDomainsDetailSummary.nodes.map((node) => ({
            nodeKey: node.nodeKey,
            label: node.label,
            strand: node.strand,
            grade: node.grade,
          }))
        : [];
    const allDomainsDetailLoading =
      !!allDomainsFocusScholar &&
      !allDomainsScholarOnly &&
      (allDomainsDetailMastery === undefined ||
        allDomainsDetailSummary === undefined ||
        allDomainsDetailSummary.domain !== allDomainsFocus?.domain);
    const allDomainsDetailBody =
      allDomainsFocusScholar && allDomainsFastMath ? (
        <FastMathScholarDetail
          scholar={allDomainsFocusScholar}
          orderedScholars={visibleScholars}
          scholarImageById={scholarImageById}
          reading={fastMathByScholar.get(allDomainsFocusScholar.id)}
          onStep={(scholarId) =>
            setAllDomainsFocus(
              scholarId
                ? { domain: FAST_MATH_DOMAIN, scholarId, source: null }
                : null,
            )
          }
          onOpenReport={onOpenReport}
          onClose={() => setAllDomainsFocus(null)}
          backLabel="Back to all domains"
        />
      ) : allDomainsFocusScholar && allDomainsScholarOnly ? (
        <AllDomainsScholarDetail
          scholar={allDomainsFocusScholar}
          orderedScholars={visibleScholars}
          scholarImageById={scholarImageById}
          mathPlan={renderMathPlanFor(allDomainsFocusScholar.id, {
            compact: false,
          })}
          onStep={(scholarId) =>
            setAllDomainsFocus((current) =>
              scholarId
                ? {
                    domain: null,
                    scholarId,
                    source: current?.source ?? "header",
                  }
                : null,
            )
          }
          onClose={() => setAllDomainsFocus(null)}
        />
      ) : allDomainsFocusScholar && allDomainsFocusDomain ? (
        allDomainsDetailLoading ? (
          <Flex align="center" justify="center" gap={2} py={12}>
            <Spinner size="sm" color="violet.500" />
            <Text fontSize="sm" color="charcoal.400">
              Loading detail…
            </Text>
          </Flex>
        ) : (
          <ScholarDomainDetail
            scholar={allDomainsFocusScholar}
            orderedScholars={visibleScholars}
            scholarImageById={scholarImageById}
            masteryByScholar={allDomainsDetailMasteryByScholar}
            domain={allDomainsFocusDomain.domain}
            domainLabel={allDomainsFocusDomain.label}
            domainNodes={allDomainsDetailNodes}
            mapStatus={mapStatusByScholar
              .get(allDomainsFocusScholar.id)
              ?.get(allDomainsFocusDomain.domain)}
            domainLabelFor={domainLabelFor}
            mathPlan={renderMathPlanFor(allDomainsFocusScholar.id)}
            plan={planByScholar.get(allDomainsFocusScholar.id)}
            retentionNow={retentionNow}
            onStep={(scholarId) =>
              setAllDomainsFocus((current) =>
                current && scholarId ? { ...current, scholarId } : null,
              )
            }
            onDrillSkill={(nodeKey) => {
              onSelectDomain?.(allDomainsFocusDomain.domain);
              handleSelectCell(nodeKey, allDomainsFocusScholar.id);
            }}
            onOpenReport={(scholarId) => {
              onSelectDomain?.(allDomainsFocusDomain.domain);
              onOpenReport(scholarId);
            }}
            onClose={() => setAllDomainsFocus(null)}
            backLabel="Back to all domains"
          />
        )
      ) : null;
    return (
      <Flex direction="column" h="full" minW={0} bg="white">
        <Flex flex={1} minH={0} overflow="hidden">
          {/* Matrix column — the scrollable grid with the always-on colour
              legend pinned beneath it (spec §5). */}
          <Flex direction="column" flex={1} minW={0} minH={0}>
          <Box flex={1} minW={0} minH={0} overflow="auto">
          {loading ? (
            <Flex align="center" justify="center" gap={2} py={12}>
              <Spinner size="sm" color="violet.500" />
              <Text fontSize="sm" color="charcoal.400">
                Loading grade levels…
              </Text>
            </Flex>
          ) : visibleScholars.length === 0 ? (
            <Text px={4} py={10} textAlign="center" color="charcoal.400">
              No scholars in this group.
            </Text>
          ) : domainRows.length === 0 ? (
            <EmptyState
              title="No domains yet"
              hint="Seed a practice domain to see it here."
            />
          ) : (
            <Box minW={`${allDomainsGridMinWidth}px`}>
              {scopedVisibleScholars.length > queryScholars.length && (
                <Text
                  px={4}
                  py={2}
                  fontSize="xs"
                  color="charcoal.500"
                  bg="yellow.50"
                  borderBottomWidth="1px"
                  borderColor="yellow.100"
                >
                  Showing the first 64 scholars. Choose a group or an individual
                  for a narrower comparison.
                </Text>
              )}
              {/* Header row — avatar + first name ONLY (Andy's Paper structure).
                  The aggregate number moved to the "Across all math" summary row
                  and the grade chips to the "Grade for age" reference row. */}
              <Box
                display="grid"
                gridTemplateColumns={allDomainsGridTemplate}
                // Centred, matching the single-domain matrix: the heading's
                // selection ring reads as balanced only when the row centres it.
                alignItems="center"
                h={ALL_DOMAINS_HEADER_H}
                bg="gray.50"
                borderBottomWidth="1px"
                borderColor="gray.100"
                position="sticky"
                top={0}
                zIndex={3}
              >
                {/* Corner cell — freezes top-left, mirroring the per-domain
                    matrix's frozen skill-column corner. */}
                <Box position="sticky" left={0} zIndex={1} bg="gray.50" h="full" />
                {visibleScholars.map((scholar) => {
                  // Same gesture as the per-domain matrix's headings, one
                  // altitude up: select the scholar, open their panel, click
                  // again to clear.
                  const headerSelected =
                    allDomainsScholarOnly &&
                    allDomainsFocus?.source === "header" &&
                    allDomainsFocus?.scholarId === scholar.id;
                  return (
                    <ScholarColumnHeader
                      key={scholar.id}
                      scholar={scholar}
                      selected={!!headerSelected}
                      onSelect={() =>
                        handleSelectAllDomainsScholar(scholar.id, "header")
                      }
                      testId={`mastery-scholar-header-${scholar.id}`}
                      title={`${scholar.name} across all domains`}
                    />
                  );
                })}
              </Box>

              {/* Grade-for-age reference row — the anchor the age-relative
                  washes are read against (spec §4.1a). Hidden in absolute mode
                  (no anchor in play). Quiet grey decimals; a disagreement with
                  the enrolled grade flags a small amber ▲. Carries a HEAVY
                  bottom rule — the first zone divider. */}
              {coloringMode === "ageRelative" && (
                <Box
                  display="grid"
                  gridTemplateColumns={allDomainsGridTemplate}
                  alignItems="center"
                  h={ALL_DOMAINS_BANNER_ROW_H}
                  bg="white"
                  borderBottomWidth="2px"
                  borderColor="gray.200"
                >
                  <Box
                    position="sticky"
                    left={0}
                    zIndex={1}
                    bg="white"
                    h="full"
                    display="flex"
                    alignItems="center"
                    pl={4}
                  >
                    <Text fontSize="xs" fontWeight="600" color="gray.400">
                      Grade for age
                    </Text>
                  </Box>
                  {visibleScholars.map((scholar) => {
                    const gradeForAge =
                      gradeForAgeByScholar.get(scholar.id) ?? null;
                    const tagged = scholar.gradeLevel;
                    const disagrees = gradeForAgeDisagreesWithTagged(
                      gradeForAge,
                      tagged,
                    );
                    const taggedLabel = normalizeGradeTag(tagged) ?? tagged;
                    let title: string;
                    if (gradeForAge == null) {
                      title = `${scholar.name} · no birthdate on file`;
                    } else {
                      title =
                        `${scholar.name} · grade for age ${gradeForAge.toFixed(1)}` +
                        (taggedLabel ? ` · enrolled grade ${taggedLabel}` : "") +
                        (disagrees
                          ? " — profile may be stale, or accelerated"
                          : "");
                    }
                    return (
                      <Flex
                        key={scholar.id}
                        align="center"
                        justify="center"
                        gap="2px"
                        title={title}
                        data-testid={`mastery-grade-for-age-${scholar.id}`}
                      >
                        <Text
                          as="span"
                          fontSize="xs"
                          fontWeight="400"
                          color={GRADE_FOR_AGE_COLOR}
                          fontVariantNumeric="tabular-nums"
                        >
                          {gradeForAge == null ? "—" : gradeForAge.toFixed(1)}
                        </Text>
                        {disagrees && (
                          <Text
                            as="span"
                            aria-hidden
                            fontSize="9px"
                            lineHeight="1"
                            color="orange.400"
                          >
                            ▲
                          </Text>
                        )}
                      </Flex>
                    );
                  })}
                </Box>
              )}

              {/* Fast math — the ONE row measured in per cent rather than
                  grade level: the share of the canonical Quick-facts space
                  (`convex/lib/practice/fastMath.ts`) each scholar has made
                  automatic, beside the adult-issued calculator license. Same
                  cell geometry and label column as a domain row so it reads as
                  a peer, but deliberately NO wash — the heatmap's tints encode
                  grade level against age, and a per cent has no place on that
                  scale. Drill-in opens the dedicated family view. */}
              <Box
                display="grid"
                gridTemplateColumns={allDomainsGridTemplate}
                alignItems="center"
                w="100%"
                bg="white"
                borderBottomWidth="1px"
                borderColor="gray.100"
                role="group"
                _hover={{ bg: "gray.50" }}
              >
                <Box
                  position="sticky"
                  left={0}
                  zIndex={1}
                  bg="white"
                  _groupHover={{ bg: "gray.50" }}
                  alignSelf="stretch"
                  pl={2}
                  pr={1}
                  display="flex"
                  alignItems="center"
                >
                  <Box
                    as={onSelectDomain ? "button" : "div"}
                    onClick={
                      onSelectDomain
                        ? () => onSelectDomain(FAST_MATH_DOMAIN)
                        : undefined
                    }
                    flex="1"
                    minW={0}
                    h={MATRIX_CELL_H}
                    px={2}
                    display="flex"
                    flexDirection="column"
                    justifyContent="center"
                    borderRadius="md"
                    textAlign="left"
                    cursor={onSelectDomain ? "pointer" : undefined}
                    _hover={onSelectDomain ? { bg: "gray.100" } : undefined}
                    data-testid="mastery-fastmath-row"
                    title={
                      onSelectDomain
                        ? "Fast math — open the fact-family view"
                        : "Fast math"
                    }
                  >
                    <Text
                      fontSize="sm"
                      fontWeight="600"
                      color="charcoal.600"
                      lineClamp={1}
                    >
                      Fast math
                    </Text>
                    <Text
                      fontSize="2xs"
                      color="gray.500"
                      lineHeight="1.1"
                      lineClamp={1}
                    >
                      {fastMathRowSubLabel(fastMathDenominator)}
                    </Text>
                  </Box>
                </Box>
                {visibleScholars.map((scholar) => {
                  const readout = fastMathCellReadout({
                    reading: fastMathByScholar.get(scholar.id),
                    scholarName: scholar.name,
                  });
                  const selected =
                    allDomainsFocus?.domain === FAST_MATH_DOMAIN &&
                    allDomainsFocus.scholarId === scholar.id;
                  return (
                    <Box
                      as="button"
                      key={scholar.id}
                      onClick={() => {
                        setAllDomainsFocus((current) =>
                          current?.domain === FAST_MATH_DOMAIN &&
                          current.scholarId === scholar.id
                            ? null
                            : {
                                domain: FAST_MATH_DOMAIN,
                                scholarId: scholar.id,
                                source: null,
                              },
                        );
                        setDetailOpen(true);
                      }}
                      display="flex"
                      flexDirection="column"
                      alignItems="center"
                      justifyContent="center"
                      w="100%"
                      h={MATRIX_CELL_H}
                      borderRadius={0}
                      {...interactiveSurface}
                      bg={selected ? "violet.50" : undefined}
                      _hover={{ bg: selected ? "violet.50" : "gray.100" }}
                      _focusVisible={{
                        outline: "2px solid",
                        outlineColor: "violet.500",
                        outlineOffset: "-2px",
                      }}
                      data-testid={`mastery-fastmath-cell-${scholar.id}`}
                      title={readout.title}
                      aria-label={`${readout.title} Show Fast math detail.`}
                      aria-pressed={selected}
                    >
                      <Text
                        fontSize="sm"
                        fontWeight="600"
                        color={
                          readout.status === "loading" ||
                          readout.status === "uncalibrated"
                            ? "gray.400"
                            : CELL_NUMBER_COLOR
                        }
                        fontVariantNumeric="tabular-nums"
                        lineHeight="1.1"
                      >
                        {readout.display}
                      </Text>
                      {readout.subLabel && (
                        <Text
                          fontSize="2xs"
                          fontWeight="600"
                          lineHeight="1.1"
                          // The mastery palette's own meanings, unchanged: the
                          // fluent green for "at the top of this signal", the
                          // overlearned teal for the durable credential. No new
                          // hue, no second scale.
                          color={
                            readout.status === "licensed"
                              ? MASTERY_DOT_COLOR.overlearned
                              : MASTERY_DOT_COLOR.fluent
                          }
                        >
                          {readout.subLabel}
                        </Text>
                      )}
                    </Box>
                  );
                })}
              </Box>

              {/* Across-all-math summary row — the cross-domain aggregate per
                  scholar, styled exactly like a domain row (tint + Δ + tooltip +
                  empty states). Fast math sits above because this aggregate
                  explicitly excludes it. The HEAVY bottom rule separates both
                  summary rows from the per-domain rows. */}
              <Box
                display="grid"
                gridTemplateColumns={allDomainsGridTemplate}
                alignItems="center"
                w="100%"
                bg="white"
                borderBottomWidth="2px"
                borderColor="gray.200"
              >
                <Box
                  position="sticky"
                  left={0}
                  zIndex={1}
                  bg="white"
                  h="full"
                  display="flex"
                  flexDirection="column"
                  justifyContent="center"
                  pl={4}
                >
                  <Text
                    fontSize="sm"
                    fontWeight="700"
                    color="charcoal.700"
                    lineClamp={1}
                  >
                    Across all math
                  </Text>
                  <Text
                    fontSize="2xs"
                    color="gray.500"
                    lineHeight="1.1"
                    lineClamp={1}
                  >
                    Every domain except Fast math
                  </Text>
                </Box>
                {visibleScholars.map((scholar) => {
                  const level = gradeLevelByScholar.get(scholar.id) ?? null;
                  const gradeForAge =
                    gradeForAgeByScholar.get(scholar.id) ?? null;
                  // Only the surface that was clicked highlights: this cell and
                  // the column heading open the same panel from two origins.
                  const summarySelected =
                    allDomainsFocus?.domain == null &&
                    allDomainsFocus?.source === "summary" &&
                    allDomainsFocus?.scholarId === scholar.id;
                  const visual = matrixCellVisual({
                    level,
                    gradeForAge,
                    mode: coloringMode,
                    // No single map status for the aggregate — the summary only
                    // ever shows a number or the plain N/A.
                    status: undefined,
                    blockedBy: [],
                    mapLoading: false,
                    readoutLabel:
                      "aggregate grade level across every domain except Fast math",
                    domainLabelFor,
                  });
                  return (
                    <Flex
                      as="button"
                      key={scholar.id}
                      onClick={() =>
                        handleSelectAllDomainsScholar(scholar.id, "summary")
                      }
                      align="center"
                      justify="center"
                      w="100%"
                      h={ALL_DOMAINS_BANNER_ROW_H}
                      bg={summarySelected ? "violet.50" : visual.bg}
                      {...interactiveSurface}
                      _hover={{ bg: "violet.50" }}
                      _focusVisible={{
                        outline: "2px solid",
                        outlineColor: "violet.500",
                        outlineOffset: "-2px",
                      }}
                      data-testid={`mastery-summary-cell-${scholar.id}`}
                      title={`${scholar.name} · ${visual.readout}`}
                      aria-label={`${scholar.name} · ${visual.readout}. Show all-math detail.`}
                      aria-pressed={summarySelected}
                    >
                      {visual.content}
                    </Flex>
                  );
                })}
              </Box>

              {/* One ROW per registered domain (same labels + order as the
                  left rail). The label navigates to that domain's matrix; a
                  number keeps All domains in place and opens that scholar ×
                  domain reading in the right panel. */}
              {domainRows.map((row) => {
                const perScholar = new Map<string, number | null>();
                for (const scholar of visibleScholars) {
                  perScholar.set(
                    scholar.id,
                    domainLevelByScholar.get(scholar.id)?.get(row.domain) ??
                      null,
                  );
                }
                return (
                  <Box
                    key={row.domain}
                    display="grid"
                    gridTemplateColumns={allDomainsGridTemplate}
                    alignItems="center"
                    w="100%"
                    bg="white"
                    borderBottomWidth="1px"
                    borderColor="gray.100"
                    role="group"
                    _hover={{ bg: "gray.50" }}
                  >
                    <Box
                      position="sticky"
                      left={0}
                      zIndex={1}
                      bg="white"
                      _groupHover={{ bg: "gray.50" }}
                      alignSelf="stretch"
                      pl={2}
                      pr={1}
                      display="flex"
                      alignItems="center"
                    >
                      <Box
                        as={onSelectDomain ? "button" : "div"}
                        onClick={
                          onSelectDomain
                            ? () => onSelectDomain(row.domain)
                            : undefined
                        }
                        flex="1"
                        minW={0}
                        // No vertical margin: this button is the row's tallest
                        // child, so any margin here inflates the row past
                        // MATRIX_CELL_H and re-opens the white bands above and
                        // below every 44px wash (founder flush-cells fix,
                        // round 2 — the first round de-margined only the cells).
                        h={MATRIX_CELL_H}
                        px={2}
                        display="flex"
                        alignItems="center"
                        borderRadius="md"
                        textAlign="left"
                        cursor={onSelectDomain ? "pointer" : undefined}
                        _hover={onSelectDomain ? { bg: "gray.100" } : undefined}
                        data-testid={`mastery-domain-row-${row.domain}`}
                        title={
                          onSelectDomain
                            ? `${row.label} — open this domain's matrix`
                            : row.label
                        }
                      >
                        <Text
                          fontSize="sm"
                          fontWeight="600"
                          color="charcoal.600"
                          lineClamp={1}
                        >
                          {row.label}
                        </Text>
                      </Box>
                    </Box>
                    {visibleScholars.map((scholar) => {
                      const level = perScholar.get(scholar.id) ?? null;
                      const gradeForAge =
                        gradeForAgeByScholar.get(scholar.id) ?? null;
                      const planMarks = domainCellMarks(
                        planByScholar.get(scholar.id),
                        row.domain,
                      );
                      const mapEntry = mapStatusByScholar
                        .get(scholar.id)
                        ?.get(row.domain);
                      const retention = domainRetentionByScholar
                        .get(scholar.id)
                        ?.get(row.domain);
                      const cellSelected =
                        allDomainsFocus?.domain === row.domain &&
                        allDomainsFocus.scholarId === scholar.id;
                      const visual = matrixCellVisual({
                        level,
                        gradeForAge,
                        mode: coloringMode,
                        status: mapEntry?.status,
                        blockedBy: mapEntry?.blockedBy ?? [],
                        mapLoading,
                        readoutLabel: row.label,
                        domainLabelFor,
                      });
                      return (
                        <Box
                          as="button"
                          key={scholar.id}
                          onClick={() => {
                            setAllDomainsFocus((current) =>
                              current?.domain === row.domain &&
                              current.scholarId === scholar.id
                                ? null
                                : {
                                    domain: row.domain,
                                    scholarId: scholar.id,
                                    source: null,
                                  },
                            );
                            setDetailOpen(true);
                          }}
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          position="relative"
                          w="100%"
                          h={MATRIX_CELL_H}
                          {...interactiveSurface}
                          {...selectableSurface(cellSelected)}
                          // Flush, spreadsheet-like cells (founder, v9): the
                          // wash fills the whole cell — no vertical margin, no
                          // rounding — so adjacent tints meet with no white
                          // gutters. Overrides selectableSurface's rounding
                          // for THIS dense surface only; the selection ring
                          // still draws (border-box, no layout nudge).
                          borderRadius={0}
                          // The tint wash rides UNDER the selection ring: selected
                          // wins with violet, else the cell's own band tint.
                          bg={cellSelected ? "violet.50" : visual.bg}
                          _hover={{
                            bg: cellSelected ? "violet.50" : visual.hoverBg,
                          }}
                          _focusVisible={{
                            outline: "2px solid",
                            outlineColor: "violet.500",
                            outlineOffset: "-2px",
                          }}
                          data-testid={`mastery-domain-cell-${row.domain}-${scholar.id}`}
                          title={cellReadoutWithMarks(
                            joinReadout(
                              `${scholar.name} · ${visual.readout}`,
                              retentionHoverClause(retention, retentionNow),
                            ),
                            planMarks,
                          )}
                          aria-label={cellReadoutWithMarks(
                            joinReadout(
                              `${scholar.name} · ${visual.readout}`,
                              retentionHoverClause(retention, retentionNow),
                            ),
                            planMarks,
                            "Show detail",
                          )}
                          aria-pressed={cellSelected}
                        >
                          {/* The slash runs corner to corner here — a domain
                              cell's reading is a number, which stays legible
                              under a hairline, so no keep-out is needed. */}
                          {planMarks.outOfScope && <OutOfScopeSlash />}
                          {visual.content}
                          {planMarks.checkpoint && (
                            <CheckpointCorner state={planMarks.checkpoint} />
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                );
              })}
            </Box>
          )}
          </Box>
          {/* Always-on colour legend — the mode toggle, the active mode's
              swatches, the empty-cell marks, and an "about these colours"
              popover (spec §5). Pinned beneath the scrolling matrix. */}
          <MatrixColorLegend
            mode={coloringMode}
            onModeChange={handleColoringModeChange}
          />
          </Flex>
          {allDomainsDetailBody ? (
            detailOpen ? (
              <MasteryDetailFrame
                title={allDomainsFocusScholar?.name ?? ""}
                onClose={() => setDetailOpen(false)}
              >
                {allDomainsDetailBody}
              </MasteryDetailFrame>
            ) : (
              <MasteryDetailRail onOpen={() => setDetailOpen(true)} />
            )
          ) : null}
        </Flex>
        <Drawer.Root
          open={
            detailPresentation === "drawer" &&
            detailOpen &&
            !!allDomainsDetailBody &&
            // Yield the modal layer to the Math plan editor (see above).
            !editPlanScholarId
          }
          onOpenChange={(details) => {
            if (!details.open) setAllDomainsFocus(null);
          }}
          placement="end"
          size="sm"
        >
          <Portal>
            <Drawer.Backdrop display={{ base: "block", lg: "none" }} />
            <Drawer.Positioner display={{ base: "flex", lg: "none" }}>
              <Drawer.Content bg="white">
                <Drawer.Header
                  borderBottomWidth="1px"
                  borderColor="gray.100"
                >
                  <Drawer.Title color="navy.600">
                    {allDomainsFocusScholar?.name}
                  </Drawer.Title>
                  <Drawer.CloseTrigger asChild>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Close detail panel"
                    >
                      <X size={15} />
                    </Button>
                  </Drawer.CloseTrigger>
                </Drawer.Header>
                <Drawer.Body p={0}>{allDomainsDetailBody}</Drawer.Body>
              </Drawer.Content>
            </Drawer.Positioner>
          </Portal>
        </Drawer.Root>
        {/* This branch renders the Math plan rail too (in the drawer above and
            in the desktop detail frame), so it mounts the editor the rail's
            plan section opens. */}
        {editMathPlanDialog}
      </Flex>
    );
  }

  return (
    <Flex direction="column" h="full" minW={0} bg="white">
      {/* Content header — scope pills (left) · skill search + filter + layout
          toggle (right). Same StudioControlBar strip the Content lens uses, so
          the toggle swaps the bar's contents, not the frame (mock 4). */}
      <StudioControlBar>
        {/* Scholar-scope pills (group scope + single-scholar focus), lifted from
            the shell band so all "who am I viewing" controls sit together —
            left-aligned in their own bar. */}
        {scopeControls}
        <CheckpointGradePill
          nodes={nodes}
          altitude="domain"
          currentGrade={
            currentCheckpointTarget &&
            currentCheckpointTarget.domain === domain &&
            currentCheckpointTarget.strand === undefined
              ? currentCheckpointTarget.grade
              : null
          }
          canSet={groupCheckpointEditable}
          disabledHint={checkpointHint}
          onSetGrade={(grade, trigger) =>
            requestBandCheckpoint(grade, undefined, trigger)
          }
          onClear={(trigger) => requestClearBandCheckpoint(trigger)}
        />
        <HStack gap={2} align="center" flexShrink={0} ml="auto">
          {/* Group roll-up — one quiet line, only once a checkpoint-bearing
              group scope has resolved every scholar's mode. Counts, not names:
              a glance at how the room splits, not a callout of anyone. Lives
              in the right cluster: `scopeControls` is a zero-width wrapper
              whose pills overflow it, so anything placed inline after it
              collides.

              Both counts wear the canonical `CheckpointMark` in the same mode
              colors as the cells: yellow for working toward, blue for going
              deeper. The marks are decorative; one sr-only lead-in names the
              row so a reader hears it once, not per count. */}
          {checkpointModeRollup && (
            <Text
              fontSize="xs"
              color="charcoal.400"
              flexShrink={0}
              display={{ base: "none", lg: "inline-flex" }}
              alignItems="center"
              gap={1}
              data-testid="checkpoint-mode-rollup"
            >
              <VisuallyHidden>Checkpoint standing:</VisuallyHidden>
              <CheckpointMark state="toward" size={12} />
              {checkpointModeRollup.toward} working toward
              <Text as="span" color="charcoal.300" aria-hidden>
                ·
              </Text>
              <CheckpointMark state="deeper" size={12} />
              {checkpointModeRollup.deeper} going deeper
              {checkpointModeRollup.needsAttention > 0 && (
                <Text as="span" color="red.600">
                  · {checkpointModeRollup.needsAttention} need attention
                </Text>
              )}
            </Text>
          )}
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search skills…"
            aria-label="Search math skills"
            bg="white"
            size="sm"
            flex="0 1 auto"
            minW="88px"
            maxW={{ base: "130px", md: "200px" }}
            borderRadius="full"
          />
          {/* Mastery-band filter — a compact "Filter" button whose dropdown
              doubles as the dial-colour legend. Shared across List and Map. */}
          <MasteryStatusFilter selected={statuses} onChange={onStatusesChange} />
          <ViewToggle
            items={[
              {
                value: "list",
                label: "List",
                icon: <ListBullets size={14} />,
              },
              {
                value: "map",
                label: "Map",
                icon: <MapTrifold size={14} />,
              },
            ]}
            value={treeView ? "map" : "list"}
            onChange={(next) => onToggleTreeView(next === "map")}
            ariaLabel="Mastery layout"
            testId="mastery-layout"
          />
        </HStack>
      </StudioControlBar>

      {/* Body */}
      {nodesLoading ? (
        <Flex flex={1} align="center" justify="center" gap={2} py={12}>
          <Spinner size="sm" color="violet.500" />
          <Text fontSize="sm" color="charcoal.400">
            Loading skills…
          </Text>
        </Flex>
      ) : treeView ? (
        <Box flex={1} minH={0} overflow="hidden" position="relative">
          {visibleScholars.length === 0 ? (
            <Text px={4} py={10} textAlign="center" color="charcoal.400">
              No scholars in this group.
            </Text>
          ) : (
            <CohortTreeView
              scholarIds={visibleScholars.map((s) => s.id as Id<"users">)}
              domain={domain}
              selectedNode={effectiveNodeKey}
              onSelectNode={handleSelectNode}
              maxHeight="100%"
            />
          )}
        </Box>
      ) : (
        <Flex flex={1} minH={0} overflow="hidden">
          {/* Matrix column */}
          <Flex direction="column" flex={1} minW={0} overflow="hidden">
            {rosterLoading || mastery === undefined ? (
              <Flex align="center" justify="center" gap={2} py={12}>
                <Spinner size="sm" color="violet.500" />
                <Text fontSize="sm" color="charcoal.400">
                  Loading mastery…
                </Text>
              </Flex>
            ) : visibleScholars.length === 0 ? (
              <Text px={4} py={10} textAlign="center" color="charcoal.400">
                No scholars in this group.
              </Text>
            ) : (
              <Box flex={1} minH={0} overflow="auto">
                {scopedVisibleScholars.length > queryScholars.length && (
                  <Text
                    px={4}
                    py={2}
                    fontSize="xs"
                    color="charcoal.500"
                    bg="yellow.50"
                    borderBottomWidth="1px"
                    borderColor="yellow.100"
                  >
                    Showing the first 64 scholars. Choose a group or an
                    individual for a narrower comparison.
                  </Text>
                )}
                {visibleNodes.length === 0 ? (
                  <EmptyState
                    title="No skills match these filters"
                    hint="Show another status or change the skill search."
                  />
                ) : (
                  <Box>
                    <Box minW={`${gridMinWidth}px`}>
                      <Box
                        display="grid"
                        gridTemplateColumns={gridTemplate}
                        alignItems="center"
                        h={SCHOLAR_HEADER_H}
                        bg="gray.50"
                        borderBottomWidth="1px"
                        borderColor="gray.100"
                        position="sticky"
                        top={0}
                        zIndex={3}
                      >
                        {/* No column label over the skill names — "Skill" read
                            ambiguously against the strand group headers below.
                            This corner cell freezes to the top-LEFT so it masks
                            the avatar columns scrolling under the frozen skill
                            column. */}
                        <Box
                          position="sticky"
                          left={0}
                          zIndex={1}
                          bg="gray.50"
                          h="full"
                        />
                        {visibleScholars.map((scholar) => {
                          const domainSelected = scholar.id === domainFocusId;
                          const complete =
                            completeByScholar.get(scholar.id) ?? false;
                          return (
                            <ScholarColumnHeader
                              key={scholar.id}
                              scholar={scholar}
                              selected={domainSelected}
                              complete={complete}
                              // The cells' own corner, on the column that heads
                              // them: same tile, same mode hue, same top-left.
                              // Neutral-to-celebratory — "going deeper" is an
                              // honored state, never flagged as a problem.
                              checkpoint={scholarCheckpointState(
                                planByScholar.get(scholar.id),
                              )}
                              onSelect={() =>
                                handleSelectScholarDomain(scholar.id)
                              }
                              testId={`mastery-scholar-header-${scholar.id}`}
                              title={`${scholar.name} across ${domainLabel}`}
                            >
                              {/* D1: the mastery GRADE LEVEL under the name — a
                                  computed "how far along" magnitude (e.g. "3.6")
                                  from the scholar's green skills in this domain,
                                  replacing the old green/amber band-mix meter (a
                                  mix ratio wasn't a meaningful glance; a level
                                  is). Shown in fluent green so it reads as a
                                  mastery level, not a chronological grade. A
                                  scholar the placement engine hasn't finished
                                  mapping shows the honest "still mapping" state
                                  (spec §3.4) rather than a bare "—". */}
                              {(() => {
                                const level =
                                  gradeLevelByScholar.get(scholar.id) ?? null;
                                const mapping =
                                  mappingStateByScholar.get(scholar.id) ??
                                  "mapped";
                                if (level === null && mapping !== "mapped") {
                                  return (
                                    <Text
                                      fontSize="2xs"
                                      fontWeight="600"
                                      color="charcoal.300"
                                      fontStyle="italic"
                                      textAlign="center"
                                      title={`${scholar.name} · ${
                                        mapping === "in_progress"
                                          ? "placement in progress"
                                          : "still mapping — not yet placed"
                                      } in ${domainLabel}`}
                                    >
                                      {mapping === "in_progress"
                                        ? "in progress"
                                        : "still mapping"}
                                    </Text>
                                  );
                                }
                                return (
                                  <Text
                                    fontSize="2xs"
                                    fontWeight="700"
                                    color={MASTERY_DOT_COLOR.fluent}
                                    fontVariantNumeric="tabular-nums"
                                    textAlign="center"
                                    title={`${scholar.name} · mastery grade level in ${domainLabel}: ${formatMasteryGradeLevel(level)}`}
                                  >
                                    {formatMasteryGradeLevel(level)}
                                  </Text>
                                );
                              })()}
                            </ScholarColumnHeader>
                          );
                        })}
                      </Box>

                      {strands.map(([strand, strandNodes]) => {
                        // "other" is only a display bucket for strandless nodes,
                        // not a durable checkpoint strand. A whole-domain
                        // checkpoint remains available from the domain pill and
                        // selected-skill panel.
                        const checkpointStrand =
                          strand === "other" ? undefined : strand;
                        const strandCheckpoint: StrandCheckpointContext = {
                          currentGrade:
                            currentCheckpointTarget &&
                            currentCheckpointTarget.domain === domain &&
                            currentCheckpointTarget.strand === checkpointStrand
                              ? currentCheckpointTarget.grade
                              : null,
                          canSet:
                            groupCheckpointEditable &&
                            checkpointStrand !== undefined,
                          disabledHint:
                            checkpointStrand === undefined
                              ? "Strandless skills use the domain checkpoint."
                              : checkpointHint,
                          onSetGrade: (grade, trigger) => {
                            if (checkpointStrand === undefined) return;
                            requestBandCheckpoint(
                              grade,
                              checkpointStrand,
                              trigger,
                            );
                          },
                          onClear: (trigger) =>
                            requestClearBandCheckpoint(trigger),
                        };
                        return (
                        <Box key={strand}>
                          {/* Strand group header: two rows (name + gray meta),
                              echoing the per-skill label + subtext, and the same
                              height as a skill row so the grid keeps its rhythm
                              and the strands read as "meaty" anchors. Sticks to
                              the TOP just below the avatar header (so the strand
                              you're in stays labelled as you scroll its skills),
                              and its text sticks LEFT so the name survives a
                              horizontal scroll like the frozen skill column. Uses
                              the SAME grid template as the skill rows so its
                              frozen column-1 matches theirs — the checkpoint pill
                              then right-aligns into the per-skill checkpoint
                              "column" instead of stacking under the name. */}
                          <Box
                            h={STRAND_HEADER_HEIGHT}
                            bg="gray.50"
                            borderBottomWidth="1px"
                            borderColor="gray.100"
                            position="sticky"
                            top={SCHOLAR_HEADER_H}
                            zIndex={2}
                            display="grid"
                            gridTemplateColumns={gridTemplate}
                            alignItems="center"
                          >
                            <Box
                              position="sticky"
                              left={0}
                              bg="gray.50"
                              pl={3}
                              pr={1}
                              display="flex"
                              alignItems="center"
                              gap={2}
                              minW={0}
                            >
                              <Box flex="1" minW={0}>
                                <StrandHeading
                                  strand={strand}
                                  nodes={strandNodes}
                                />
                              </Box>
                              {/* Checkpoint pill, right-aligned into the frozen
                                  label column so it lands in the same vertical
                                  "checkpoint column" as each skill's flag. */}
                              <CheckpointGradePill
                                nodes={strandNodes}
                                altitude="strand"
                                {...strandCheckpoint}
                              />
                            </Box>
                          </Box>
                          {strandNodes.map((node) => {
                            const selected = node.nodeKey === effectiveNodeKey;
                            // Outline the skill label ONLY when the skill itself is
                            // what drives the detail panel. The detail resolves in
                            // priority order scholar×domain > scholar×skill > skill,
                            // so the label ring must yield to BOTH higher scopes: a
                            // drilled dot (focusScholarId → that cell owns the ring)
                            // AND an open scholar-domain drawer (domainFocusId → that
                            // avatar owns it). Without the domainFocusId guard the
                            // label and the avatar both showed selected while only the
                            // avatar controlled the detail.
                            const labelSelected =
                              selected && !focusScholarId && !domainFocusId;
                            // Row subtext: world-connection story count only
                            // (never the developer-facing nodeKey slug). The
                            // grade moved OUT of the subtext into a right-aligned
                            // grade column (below), so it reads as a column that
                            // lines up with the Content lens instead of riding
                            // inside the label's subtext.
                            const storyCount = storyCountByNode?.[node.nodeKey];
                            const subtextParts = [
                              storyCount
                                ? `${storyCount} ${storyCount === 1 ? "story" : "stories"}`
                                : null,
                            ].filter(Boolean);
                            return (
                              <Box
                                key={node.nodeKey}
                                display="grid"
                                gridTemplateColumns={gridTemplate}
                                alignItems="center"
                                w="100%"
                                bg="white"
                                borderBottomWidth="1px"
                                borderColor="gray.100"
                                role="group"
                                _hover={{ bg: "gray.50" }}
                              >
                                {/* Skill label = skill-scoped click target,
                                    frozen to the LEFT so the skill name stays
                                    visible while scrolling across scholars. The
                                    sticky wrapper carries the opaque row bg (and
                                    tracks the row hover via _groupHover) so dot
                                    cells scroll cleanly underneath it; the rounded
                                    surface inside keeps its 44px selection-ring
                                    height and now also encloses the flag. */}
                                <Box
                                  position="sticky"
                                  left={0}
                                  zIndex={1}
                                  bg="white"
                                  _groupHover={{ bg: "gray.50" }}
                                  alignSelf="stretch"
                                  pl={2}
                                  pr={1}
                                  display="flex"
                                  alignItems="center"
                                >
                                  {/* The rounded hover/selection surface wraps
                                      BOTH the skill label and its checkpoint flag,
                                      so the flag reads as living INSIDE the title
                                      cell — it lights with the same hover/selected
                                      rect. Purely cosmetic grouping: the flag stays
                                      its own button + click target, a sibling (not
                                      nested — button-in-button is invalid). The
                                      flag still sits flush at the frozen column's
                                      right edge, so it stays in the same vertical
                                      "checkpoint column" as the strand-header pill. */}
                                  <Box
                                    flex="1"
                                    minW={0}
                                    h={MATRIX_CELL_H}
                                    my="4px"
                                    display="flex"
                                    alignItems="center"
                                    {...selectableSurface(labelSelected)}
                                    _hover={{
                                      bg: labelSelected ? "violet.50" : "gray.100",
                                    }}
                                  >
                                    <Box
                                      as="button"
                                      onClick={() => handleSelectNode(node.nodeKey)}
                                      flex="1"
                                      minW={0}
                                      h="100%"
                                      px={2}
                                      display="flex"
                                      flexDirection="column"
                                      justifyContent="center"
                                      textAlign="left"
                                      borderRadius="md"
                                      {...interactiveSurface}
                                      _hover={{ color: "violet.700" }}
                                      data-testid={`mastery-skill-${node.nodeKey}`}
                                      title={`${node.label} — class distribution`}
                                    >
                                      <Text
                                        fontSize="sm"
                                        fontWeight={labelSelected ? "700" : "600"}
                                        color="charcoal.700"
                                        lineClamp={1}
                                      >
                                        {node.label}
                                      </Text>
                                      {subtextParts.length > 0 && (
                                        <Text
                                          fontSize="2xs"
                                          color="charcoal.400"
                                          lineClamp={1}
                                        >
                                          {subtextParts.join(" · ")}
                                        </Text>
                                      )}
                                    </Box>
                                    {/* Grade in its own right-aligned column, just
                                        left of the checkpoint flag — a consistent
                                        x across rows (not riding inside the
                                        truncating label), matching the Content
                                        rail's grade column so the two lenses line
                                        up. */}
                                    {node.grade && (
                                      <Text
                                        fontSize="xs"
                                        fontWeight="400"
                                        color="charcoal.400"
                                        flexShrink={0}
                                        minW="24px"
                                        textAlign="right"
                                      >
                                        G{node.grade}
                                      </Text>
                                    )}
                                  </Box>
                                </Box>
                                {/* Whole cell = the scholar × skill click
                                    target (not just the dot), so the hover band,
                                    hit area, AND selection outline span the full
                                    rounded-rect cell. The dot itself stays a
                                    circle. */}
                                {visibleScholars.map((scholar) => {
                                  const reading = masteryByScholar
                                    .get(scholar.id)
                                    ?.readings.find(
                                      (candidate) =>
                                        candidate.nodeKey === node.nodeKey,
                                    );
                                  const filteredOut =
                                    !!reading &&
                                    !readingMatchesMasteryFilters(
                                      reading,
                                      statuses,
                                    );
                                  const mark = filteredOut ? null : reading ? (
                                    <KnowledgeNodeDial
                                      mastery={reading.mastery}
                                      automaticity={reading.automaticity}
                                      depth={reading.depth}
                                      size={34}
                                      flankWidth={2}
                                      glyphs
                                    />
                                  ) : null;
                                  const cellSelected =
                                    selected && focusScholarId === scholar.id;
                                  const planMarks = skillCellMarks(
                                    planByScholar.get(scholar.id),
                                    domain,
                                    node,
                                  );
                                  return mark ||
                                    planMarks.checkpoint ||
                                    planMarks.outOfScope ? (
                                    <Box
                                      as="button"
                                      key={scholar.id}
                                      onClick={() =>
                                        handleSelectCell(
                                          node.nodeKey,
                                          scholar.id,
                                        )
                                      }
                                      display="flex"
                                      alignItems="center"
                                      justifyContent="center"
                                      position="relative"
                                      w="100%"
                                      h={MATRIX_CELL_H}
                                      my="4px"
                                      {...interactiveSurface}
                                      {...selectableSurface(cellSelected)}
                                      _hover={{
                                        bg: cellSelected
                                          ? "violet.50"
                                          : "gray.100",
                                      }}
                                      _focusVisible={{
                                        outline: "2px solid",
                                        outlineColor: "violet.500",
                                        outlineOffset: "-2px",
                                      }}
                                      data-testid={`mastery-cell-${node.nodeKey}-${scholar.id}`}
                                      title={cellReadoutWithMarks(
                                        `${scholar.name} — ${node.label}`,
                                        planMarks,
                                      )}
                                      aria-label={cellReadoutWithMarks(
                                        `${scholar.name} on ${node.label}`,
                                        planMarks,
                                      )}
                                    >
                                      {/* Masked around the 34px dial so the
                                          hairline can never read as a third
                                          mastery arc; unbroken where there is
                                          no reading to protect. */}
                                      {planMarks.outOfScope && (
                                        <OutOfScopeSlash
                                          keepOutD={mark ? SLASH_KEEP_OUT_D : 0}
                                        />
                                      )}
                                      <Box
                                        display="flex"
                                        alignItems="center"
                                        justifyContent="center"
                                        w="40px"
                                        h="40px"
                                      >
                                        {mark}
                                      </Box>
                                      {planMarks.checkpoint && (
                                        <CheckpointCorner
                                          state={planMarks.checkpoint}
                                        />
                                      )}
                                    </Box>
                                  ) : (
                                    <Box
                                      key={scholar.id}
                                      w="100%"
                                      minH="48px"
                                    />
                                  );
                                })}
                              </Box>
                            );
                          })}
                        </Box>
                        );
                      })}
                    </Box>
                  </Box>
                )}
              </Box>
            )}
          </Flex>

          {/* Right detail panel: neighbourhood (top) + scholar list, with a
              close box (bug: was undismissable). A slim rail re-opens it. */}
          {detailOpen ? (
            <MasteryDetailFrame
              title={detailTitle}
              meta={
                effectiveNode && !domainFocusScholar ? (
                  <Text fontSize="xs" color="charcoal.400" mt={0.5}>
                    {skillMeta}
                  </Text>
                ) : undefined
              }
              onClose={() => setDetailOpen(false)}
            >
              <SkillDetailPanel
                effectiveNode={effectiveNode}
                effectiveNodeKey={effectiveNodeKey}
                focusedScholarId={focusScholarId}
                domainScholarId={domainFocusId}
                onOpenReport={onOpenReport}
                globalScholarId={effectiveScholarId}
                domain={domain}
                domainLabel={domainLabel}
                domainNodes={nodes}
                orderedScholars={visibleScholars}
                scholarImageById={scholarImageById}
                masteryByScholar={masteryByScholar}
                onFocusScholar={setFocusedScholarId}
                onFocusScholarDomain={setDomainScholarId}
                onSelectCell={handleSelectCell}
                onSelectNode={onSelectNode}
                domainLabelFor={domainLabelForKey}
                mathPlanFor={renderMathPlanFor}
                onOpenPlan={setEditPlanScholarId}
                planByScholar={planByScholar}
                groupCheckpointControl={groupCheckpointControl}
                hideHeader
                retentionNow={retentionNow}
              />
            </MasteryDetailFrame>
          ) : (
            <MasteryDetailRail onOpen={() => setDetailOpen(true)} />
          )}
        </Flex>
      )}

      {/* Map node-detail drawer (Map view only). It hosts the Math plan rail,
          so it yields the modal layer to the editor (see above). */}
      <Drawer.Root
        open={treeView && mapDrawerOpen && !!effectiveNode && !editPlanScholarId}
        onOpenChange={(d) => setMapDrawerOpen(d.open)}
        placement="end"
        size="sm"
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content
              display="flex"
              flexDirection="column"
              bg="white"
            >
              <Drawer.Header
                borderBottomWidth="1px"
                borderColor="gray.100"
                display="flex"
                alignItems="flex-start"
                justifyContent="space-between"
                gap={3}
              >
                <Box minW={0}>
                  <Heading size="sm" color="navy.600" lineClamp={3} lineHeight="1.3">
                    {effectiveNode?.label}
                  </Heading>
                  <Text fontSize="xs" color="charcoal.400" mt={0.5}>
                    {skillMeta}
                  </Text>
                </Box>
                <Drawer.CloseTrigger asChild>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Close skill detail"
                    color="charcoal.400"
                  >
                    <X size={16} />
                  </Button>
                </Drawer.CloseTrigger>
              </Drawer.Header>
              <Drawer.Body>
                {/* No `onOpenPlan` on this mount, on purpose: the Map drawer is
                    the one surface where authoring in place still owes the
                    drawer/dialog inert-layer pass, so the per-cell checkpoint
                    control stays off it (D5) and the rail's editor route is the
                    only way to author from here. */}
                <SkillDetailPanel
                  effectiveNode={effectiveNode}
                  effectiveNodeKey={effectiveNodeKey}
                  focusedScholarId={focusScholarId}
                  domainScholarId={null}
                  onOpenReport={onOpenReport}
                  globalScholarId={effectiveScholarId}
                  domain={domain}
                  domainLabel={domainLabel}
                  domainNodes={nodes}
                  orderedScholars={visibleScholars}
                  scholarImageById={scholarImageById}
                  masteryByScholar={masteryByScholar}
                  onFocusScholar={setFocusedScholarId}
                  onFocusScholarDomain={setDomainScholarId}
                  onSelectCell={handleSelectCell}
                  onSelectNode={onSelectNode}
                  domainLabelFor={domainLabelForKey}
                  mathPlanFor={renderMathPlanFor}
                  planByScholar={planByScholar}
                  hideHeader
                  retentionNow={retentionNow}
                />
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      {/* D2: the full-bleed "[Scholar]'s mastery of [Domain]" report — the
          takeover DESTINATION reached by expanding the scholar × domain drawer
          (or a ?report= deep link). A fixed overlay so it takes over the whole
          surface; Back / Esc / browser-Back all close it. */}
      {(() => {
        const reportScholar = reportScholarId
          ? visibleScholars.find((s) => s.id === reportScholarId)
          : undefined;
        if (!reportScholar || nodesLoading) return null;
        const readout = masteryByScholar.get(reportScholar.id);
        const bands = bandCountsByScholar.get(reportScholar.id);
        if (!readout || !bands) return null;
        return (
          <ScholarDomainReport
            scholar={reportScholar}
            orderedScholars={visibleScholars}
            imageSrc={scholarImageById.get(reportScholar.id)}
            readings={readout.readings}
            bandCounts={bands}
            domain={domain}
            domainLabel={domainLabel}
            domainNodes={nodes}
            domainLabelFor={domainLabelForKey}
            onStep={(id) => onOpenReport(id)}
            onClose={() => onOpenReport(null)}
            onOpenContent={onOpenContentForNode}
            onOpenStories={onOpenStoriesForNode}
            onDrillCell={(nodeKey) => {
              onOpenReport(null);
              handleSelectCell(nodeKey, reportScholar.id);
            }}
          />
        );
      })()}

      {/* One atomic editor for the two authored controls. Mounted at the view
          root so it survives the rail path that opened it. */}
      {editMathPlanDialog}

      {/* The ONE guard in front of every group-altitude checkpoint write —
          shared by the header/strand grade pills and the panel band control, so
          no surface can author group policy unguarded. */}
      {checkpointConfirmDialog}
    </Flex>
  );
}

type MasteryScholarReadout = NonNullable<
  ReturnType<typeof useQuery<typeof api.cohortPractice.masteryForScholars>>
>["scholars"][number];

type ScholarReading = MasteryScholarReadout["readings"][number];

function MasteryDetailFrame({
  title,
  meta,
  onClose,
  children,
}: {
  title: string;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Box
      display={{ base: "none", lg: "flex" }}
      flexDirection="column"
      w={{ lg: "340px" }}
      flexShrink={0}
      borderLeftWidth="1px"
      borderColor="gray.100"
      bg="white"
    >
      <Flex
        align="flex-start"
        justify="space-between"
        gap={3}
        px={4}
        py={3}
        borderBottomWidth="1px"
        borderColor="gray.100"
        flexShrink={0}
      >
        <Box minW={0}>
          <Heading
            size="sm"
            color="navy.600"
            lineClamp={3}
            lineHeight="1.3"
          >
            {title}
          </Heading>
          {meta}
        </Box>
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.400"
          aria-label="Close detail panel"
          _hover={{ bg: "gray.100" }}
          onClick={onClose}
          flexShrink={0}
        >
          <X size={15} />
        </Button>
      </Flex>
      <Box flex={1} minH={0} overflowY="auto">
        {children}
      </Box>
    </Box>
  );
}

function MasteryDetailRail({ onOpen }: { onOpen: () => void }) {
  return (
    <Flex
      display={{ base: "none", lg: "flex" }}
      direction="column"
      align="center"
      w="44px"
      flexShrink={0}
      borderLeftWidth="1px"
      borderColor="gray.100"
      bg="white"
      pt={2}
    >
      <Button
        size="xs"
        variant="ghost"
        color="charcoal.400"
        aria-label="Open detail panel"
        _hover={{ bg: "gray.100" }}
        onClick={onOpen}
      >
        <SidebarSimple size={16} />
      </Button>
    </Flex>
  );
}

// The dial's two gauges become labelled mini-bars in the scholar drill. These
// are the automaticity/depth hues (NOT mastery-band colours), so reusing them
// here carries the same meaning without overloading the mastery palette.
const COLOR_AUTOMATICITY = "#43cf8e"; // mint
const COLOR_DEPTH = "#5663c6"; // indigo

function MiniGauge({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <Box>
      <Flex justify="space-between" mb={1}>
        <Text fontSize="2xs" color="charcoal.500">
          {label}
        </Text>
        <Text fontSize="2xs" fontWeight="700" color="charcoal.600">
          {pct}%
        </Text>
      </Flex>
      <Box h="4px" bg="gray.100" borderRadius="full" overflow="hidden">
        <Box h="100%" w={`${pct}%`} bg={color} borderRadius="full" />
      </Box>
    </Box>
  );
}

/**
 * ScholarStepperHeader — the shared header for BOTH scholar-scoped detail bodies
 * (scholar × domain and scholar × skill): the avatar + name on the left, and an
 * attached `‹ N of M ›` stepper on the right. One component so the two bodies
 * never drift. `subtitle` is optional context under the name (e.g. the domain
 * label in the scholar × domain drawer).
 */
function ScholarStepperHeader({
  scholar,
  index,
  total,
  subtitle,
  imageSrc,
  onStep,
  showName = true,
}: {
  scholar: RosterScholar;
  index: number;
  total: number;
  subtitle?: string;
  imageSrc: string | null | undefined;
  onStep: (delta: number) => void;
  showName?: boolean;
}) {
  const canStep = total > 1;
  return (
    <Flex align="center" justify="space-between" gap={3} mb={3}>
      <Flex align="center" gap={2.5} minW={0} flex={1}>
        <Avatar
          size="sm"
          name={scholar.name}
          src={imageSrc ?? undefined}
          colorKey={scholar.id}
        />
        <Box minW={0}>
          {showName && (
            <Text
              fontWeight="700"
              fontSize="sm"
              color="charcoal.700"
              lineClamp={1}
            >
              {scholar.name}
            </Text>
          )}
          {subtitle && (
            <Text fontSize="2xs" color="charcoal.400" lineClamp={1}>
              {subtitle}
            </Text>
          )}
        </Box>
      </Flex>
      <ButtonGroup attached size="xs" variant="outline" flexShrink={0}>
        <IconButton
          aria-label="Previous scholar"
          disabled={!canStep}
          onClick={() => onStep(-1)}
        >
          <CaretLeft size={14} />
        </IconButton>
        <Button
          disabled
          _disabled={{
            opacity: 1,
            cursor: "default",
            color: "charcoal.600",
          }}
          px={2}
          fontVariantNumeric="tabular-nums"
        >
          {index + 1} of {total}
        </Button>
        <IconButton
          aria-label="Next scholar"
          disabled={!canStep}
          onClick={() => onStep(1)}
        >
          <CaretRight size={14} />
        </IconButton>
      </ButtonGroup>
    </Flex>
  );
}

/**
 * Scholar × domain detail — one learner summarised across every skill in the
 * domain. The altitude above scholar × skill: a band distribution over the
 * domain's skills (the same shape as the skill-scoped "How the class sits", but
 * the other axis — skills of one scholar, not scholars on one skill), and a
 * prev/next stepper. Each band row drills into scholar × skill for
 * that band's first skill, linking the two altitudes. Opened by clicking a
 * column avatar; it is a lightweight peek, NOT a scope change (the matrix and
 * rail are untouched).
 */
function ScholarDomainDetail({
  scholar,
  orderedScholars,
  scholarImageById,
  masteryByScholar,
  domain,
  domainLabel,
  domainNodes,
  mapStatus,
  domainLabelFor,
  mathPlan,
  plan,
  onStep,
  onDrillSkill,
  onOpenReport,
  onClose,
  backLabel = "Back to class distribution",
  retentionNow,
}: {
  scholar: RosterScholar;
  orderedScholars: RosterScholar[];
  scholarImageById: Map<string, string | null>;
  masteryByScholar: Map<string, MasteryScholarReadout>;
  /** The domain key, for the Math plan scope test. */
  domain: string;
  domainLabel: string;
  domainNodes: SkillNode[];
  /** This scholar × this domain's check-in state, for the map-status strip +
   *  the honest "not yet measured" bucket relabel. Undefined while loading. */
  mapStatus?: { status: DomainMapStatus; blockedBy: string[] };
  /** Domain key → label, for the `queued` strip's blocked-by clause. */
  domainLabelFor: (key: string) => string;
  /** This scholar's Math plan block — the authored policy the readings below
   *  sit inside. */
  mathPlan?: ReactNode;
  /** The same plan as data, for the scope test. */
  plan?: MathPlanRow;
  onStep: (id: string | null) => void;
  onDrillSkill?: (nodeKey: string) => void;
  onOpenReport: (scholarId: string) => void;
  onClose: () => void;
  backLabel?: string;
  /** The render pass's shared "now" snapshot (from `useNow()` in the parent),
   *  threaded down for the Tier 2 retention strip's day-math. */
  retentionNow: number;
}) {
  const readout = masteryByScholar.get(scholar.id);
  const readingByKey = new Map(
    (readout?.readings ?? []).map((reading) => [reading.nodeKey, reading]),
  );

  // Until a check-in converges, an ABSENT mastery row means "never measured",
  // not "measured, at the floor" — so the empty bucket must not borrow the
  // converged vocabulary ("Not started"). One label per meaning (§6).
  const notConverged =
    mapStatus !== undefined && mapStatus.status !== "converged";
  const bucketLabelFor = (band: MasteryFilterKey) =>
    band === "locked" && notConverged
      ? "Not yet measured"
      : MASTERY_FILTER_LABEL[band];
  // GREEN readings only — must mirror the cell's state-4 test (the same
  // placed/fluent/overlearned family `masteryGradeLevel` counts), so a
  // practicing-only domain still gets its "just getting started" strip.
  const hasGreenReadings = domainNodes.some((node) => {
    const reading = readingByKey.get(node.nodeKey);
    if (!reading) return false;
    const band = masteryFilterKey(reading);
    return band === "placed" || band === "fluent" || band === "overlearned";
  });

  // Bucket the domain's skills by THIS scholar's band (missing reading ⇒
  // "locked"). Keep the node so a row can name a few skills and drill in.
  const bandNodes = new Map<MasteryFilterKey, SkillNode[]>();
  for (const node of domainNodes) {
    const reading = readingByKey.get(node.nodeKey);
    const band: MasteryFilterKey = reading
      ? masteryFilterKey(reading)
      : "locked";
    bandNodes.set(band, [...(bandNodes.get(band) ?? []), node]);
  }
  const total = domainNodes.length;

  const index = orderedScholars.findIndex((s) => s.id === scholar.id);
  const canStep = orderedScholars.length > 1;
  const step = (delta: number) => {
    if (!canStep) return;
    const next =
      orderedScholars[
        (index + delta + orderedScholars.length) % orderedScholars.length
      ];
    if (next) onStep(next.id);
  };
  const firstName = scholar.name.split(" ")[0] ?? scholar.name;
  const outOfScope = planScopeExclusion(plan, domain) !== null;

  return (
    <Box p={4}>
      <ScholarStepperHeader
        scholar={scholar}
        index={index}
        total={orderedScholars.length}
        subtitle={domainLabel}
        imageSrc={scholarImageById.get(scholar.id)}
        onStep={step}
        showName={false}
      />

      {mathPlan}

      {/* ONE note, the one that is true. Mapping guidance is a next action, and
          there is no next action while the plan excludes this domain — nothing
          in it is served, so a check-in would change nothing. */}
      {outOfScope ? (
        <MathPlanScopeStrip
          plan={plan}
          domain={domain}
          domainLabel={domainLabel}
          firstName={firstName}
        />
      ) : (
        <DomainMapStatusStrip
          status={mapStatus?.status}
          blockedBy={mapStatus?.blockedBy ?? []}
          domainLabelFor={domainLabelFor}
          firstName={firstName}
          hasGreenReadings={hasGreenReadings}
        />
      )}

      {/* Tier 2 freshness (spec §10.2) — the same retention aggregate Tier 1's
          cell hover reads, one tier down. Silent when nothing is due (T3): a
          fresh or empty domain adds nothing here either. Only alongside the
          map strip — the out-of-scope state above already replaces it. */}
      {!outOfScope && (
        <DomainRetentionStrip retention={readout?.retention} now={retentionNow} />
      )}

      {/* Escalate the lightweight peek to the full-bleed report (D2) — the same
          scholar × domain body, promoted to its own route with the frontier
          list, inline evidence, and the serve-next queue. */}
      <Button
        size="xs"
        variant="outline"
        colorPalette="violet"
        w="full"
        mb={3}
        onClick={() => onOpenReport(scholar.id)}
      >
        <ArrowsOutSimple size={13} /> Open full report
      </Button>

      {/* This scholar's spread ACROSS the domain — the other axis of the
          skill-scoped "How the class sits". Click a band to drill into its
          first skill for this scholar. */}
      <Text
        fontSize="2xs"
        fontWeight="700"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.04em"
        mb={2}
      >
        Across {domainLabel} ({total} {total === 1 ? "skill" : "skills"})
      </Text>
      <Flex direction="column" gap={0}>
        {MASTERY_FILTER_ORDER.map((band) => {
          const members = bandNodes.get(band) ?? [];
          if (members.length === 0) return null;
          const sample = members
            .slice(0, 3)
            .map((node) => node.label)
            .join(", ");
          const more = members.length > 3 ? ` +${members.length - 3}` : "";
          return (
            <Flex
              key={band}
              as={onDrillSkill ? "button" : "div"}
              onClick={
                onDrillSkill
                  ? () => onDrillSkill(members[0]!.nodeKey)
                  : undefined
              }
              align="flex-start"
              gap={2.5}
              py={2}
              px={2}
              borderRadius="md"
              borderBottomWidth="1px"
              borderColor="gray.100"
              textAlign="left"
              w="100%"
              cursor={onDrillSkill ? "pointer" : undefined}
              _hover={onDrillSkill ? { bg: "gray.50" } : undefined}
            >
              <Box mt={0.5}>
                <MasteryStatusMark status={band} />
              </Box>
              <Box minW={0} flex={1}>
                <Flex justify="space-between" align="baseline" gap={2}>
                  <Text fontSize="sm" fontWeight="600" color="charcoal.700">
                    {bucketLabelFor(band)}
                  </Text>
                  <Text fontSize="xs" fontWeight="700" color="charcoal.500">
                    {members.length}
                  </Text>
                </Flex>
                <Text fontSize="2xs" color="charcoal.400" lineClamp={1} mt={1}>
                  {sample}
                  {more}
                </Text>
              </Box>
            </Flex>
          );
        })}
      </Flex>

      <Button
        size="xs"
        variant="ghost"
        color="charcoal.500"
        mt={3}
        onClick={onClose}
        _hover={{ bg: "gray.100" }}
      >
        ← {backLabel}
      </Button>
    </Box>
  );
}

/**
 * All domains × scholar — the panel a HEADING click opens. No domain is chosen
 * yet, so this altitude has exactly one reading that spans all of them: the
 * scholar's Math plan, which is why it opens EXPANDED here and collapsed
 * everywhere below.
 *
 * It deliberately restates nothing. Every per-domain level and mark is already
 * in that scholar's matrix column, an arm's length away and better rendered
 * there; and "open full report" is a per-domain route, so offering it without a
 * domain would be offering a choice this panel cannot make. One quiet line says
 * what the next gesture is instead.
 */
function AllDomainsScholarDetail({
  scholar,
  orderedScholars,
  scholarImageById,
  mathPlan,
  onStep,
  onClose,
}: {
  scholar: RosterScholar;
  orderedScholars: RosterScholar[];
  scholarImageById: Map<string, string | null>;
  mathPlan?: ReactNode;
  onStep: (id: string | null) => void;
  onClose: () => void;
}) {
  const index = orderedScholars.findIndex((s) => s.id === scholar.id);
  const canStep = orderedScholars.length > 1;
  const step = (delta: number) => {
    if (!canStep) return;
    const next =
      orderedScholars[
        (index + delta + orderedScholars.length) % orderedScholars.length
      ];
    if (next) onStep(next.id);
  };
  const firstName = scholar.name.split(" ")[0] ?? scholar.name;

  return (
    <Box p={4} data-testid="all-domains-scholar-detail">
      <ScholarStepperHeader
        scholar={scholar}
        index={index}
        total={orderedScholars.length}
        subtitle="All domains"
        imageSrc={scholarImageById.get(scholar.id)}
        onStep={step}
        showName={false}
      />

      {mathPlan}

      <Text fontSize="xs" color="charcoal.400" lineHeight="1.5">
        Select a domain to see {firstName}&rsquo;s reading in it.
      </Text>

      <Button
        size="xs"
        variant="ghost"
        color="charcoal.500"
        mt={3}
        onClick={onClose}
        _hover={{ bg: "gray.100" }}
      >
        ← Back to all domains
      </Button>
    </Box>
  );
}

/**
 * Fast math × scholar — the panel a HEADING click opens, alongside the cell
 * click that already goes straight to the quick-facts report.
 *
 * One reading, then one escalation. The heatmap, the per-family table, and the
 * license controls all live in that report and in the matrix behind this panel;
 * repeating any of them here would be a second rendering of a signal that
 * already has a canonical home. Fast math also has no Math plan rail: the plan
 * authorises domains and strands, and this view is one fixed slice of one
 * domain, so there is no scope decision for a teacher to read here.
 */
function FastMathScholarDetail({
  scholar,
  orderedScholars,
  scholarImageById,
  reading,
  onStep,
  onOpenReport,
  onClose,
  backLabel = "Back to Fast math",
}: {
  scholar: RosterScholar;
  orderedScholars: RosterScholar[];
  scholarImageById: Map<string, string | null>;
  reading: FastMathDetailedReading | undefined;
  onStep: (id: string | null) => void;
  onOpenReport: (scholarId: string) => void;
  onClose: () => void;
  backLabel?: string;
}) {
  const index = orderedScholars.findIndex((s) => s.id === scholar.id);
  const canStep = orderedScholars.length > 1;
  const step = (delta: number) => {
    if (!canStep) return;
    const next =
      orderedScholars[
        (index + delta + orderedScholars.length) % orderedScholars.length
      ];
    if (next) onStep(next.id);
  };
  // The one canonical overall reading — the same number, word, and sentence the
  // matrix's own total cell announces, from the same helper.
  const readout = fastMathCellReadout({ reading, scholarName: scholar.name });

  return (
    <Box p={4} data-testid="fast-math-scholar-detail">
      <ScholarStepperHeader
        scholar={scholar}
        index={index}
        total={orderedScholars.length}
        subtitle="Fast math"
        imageSrc={scholarImageById.get(scholar.id)}
        onStep={step}
        showName={false}
      />

      <Box
        borderWidth="1px"
        borderColor="gray.100"
        borderRadius="lg"
        p={3}
        mb={3}
        data-testid="fast-math-scholar-reading"
      >
        <Text
          fontSize="2xl"
          fontWeight="700"
          color="charcoal.700"
          fontVariantNumeric="tabular-nums"
          lineHeight="1.1"
        >
          {readout.display}
        </Text>
        {readout.subLabel && (
          <Text fontSize="2xs" fontWeight="700" color="charcoal.400">
            {readout.subLabel}
          </Text>
        )}
        <Text fontSize="xs" color="charcoal.500" lineHeight="1.5" mt={1.5}>
          {readout.title}
        </Text>
      </Box>

      <Button
        size="xs"
        variant="outline"
        colorPalette="violet"
        w="full"
        mb={3}
        onClick={() => onOpenReport(scholar.id)}
        data-testid="fast-math-open-report"
      >
        <ArrowsOutSimple size={13} /> Open quick-facts report
      </Button>

      <Button
        size="xs"
        variant="ghost"
        color="charcoal.500"
        onClick={onClose}
        _hover={{ bg: "gray.100" }}
      >
        ← {backLabel}
      </Button>
    </Box>
  );
}

/**
 * The right-panel / drawer detail body. THREE scopes, in priority order:
 *
 *  • Scholar × DOMAIN (a column avatar clicked) — that scholar summarised
 *    across every skill in the domain: their band distribution over the domain,
 *    a primary badge, and a prev/next stepper. Each band row drills down into
 *    scholar × skill for that band's first skill.
 *  • Scholar × skill (one cell clicked, or a single scholar globally scoped) —
 *    that scholar's reading of THIS skill: band + automaticity/depth gauges +
 *    flag/lock chips, a cohort-context line, and a prev/next stepper.
 *  • Skill-scoped (nothing drilled) — the skill's neighbourhood (prereqs /
 *    unlocks / stories, restored from the old Tree-Map NodeDrawer) + a cohort
 *    band distribution "sample". This replaces the old full per-scholar roster,
 *    which just duplicated the matrix columns.
 *
 * Domain/strand ACCESS control is NOT here — it lives in the left domain rail,
 * scoped to the focused scholar, so the teacher acts on the same domain list
 * they navigate.
 */
function SkillDetailPanel({
  effectiveNode,
  effectiveNodeKey,
  focusedScholarId,
  domainScholarId,
  globalScholarId,
  domain,
  domainLabel,
  domainNodes,
  orderedScholars,
  scholarImageById,
  masteryByScholar,
  onFocusScholar,
  onFocusScholarDomain,
  onSelectCell,
  onSelectNode,
  onOpenReport,
  domainLabelFor,
  mathPlanFor,
  onOpenPlan,
  planByScholar,
  groupCheckpointControl,
  hideHeader = false,
  retentionNow,
}: {
  effectiveNode: SkillNode | undefined;
  effectiveNodeKey: string | null;
  focusedScholarId: string | null;
  domainScholarId: string | null;
  globalScholarId: string;
  domain: string;
  domainLabel: string;
  domainNodes: SkillNode[];
  orderedScholars: RosterScholar[];
  scholarImageById: Map<string, string | null>;
  masteryByScholar: Map<string, MasteryScholarReadout>;
  onFocusScholar: (id: string | null) => void;
  onFocusScholarDomain: (id: string | null) => void;
  onSelectCell: (nodeKey: string, scholarId: string) => void;
  onSelectNode: (nodeKey: string) => void;
  onOpenReport: (scholarId: string) => void;
  /** Domain key → label, for the scholar × domain map-status strip. */
  domainLabelFor: (key: string) => string;
  /** Renders one scholar's Math plan block; omitted where no scholar resolves. */
  mathPlanFor?: (scholarId: string) => ReactNode;
  /**
   * Opens the Math plan editor for one scholar. Supplied ONLY by the list
   * view's mount: it is what turns on the per-cell checkpoint control, and the
   * Map view's node drawer deliberately omits it — that drawer has its own
   * modal-suspension dance with the editor, and authoring from inside it is a
   * follow-up (D5), not a silent inheritance.
   */
  onOpenPlan?: (scholarId: string) => void;
  /** The same plans as data, for the scope test the strip runs. */
  planByScholar?: ReadonlyMap<string, MathPlanRow>;
  /**
   * The math GROUP's checkpoint control for the selected skill's band. Supplied
   * ONLY by the desktop detail frame's mount, and only when a real group scope
   * is selected with members; it renders in the skill-scoped branch alone, so a
   * drilled scholar never sees a group author beside their own plan.
   */
  groupCheckpointControl?: ReactNode;
  hideHeader?: boolean;
  /** The render pass's shared "now" snapshot (from `useNow()` in the parent),
   *  threaded down for the Tier 2 retention strip's day-math. */
  retentionNow: number;
}) {
  const nodeKey = effectiveNode?.nodeKey ?? null;
  // The scholar × domain drawer needs this domain's check-in state, but the
  // all-domains `mapStatusForScholars` query is skipped in single-domain mode —
  // so fetch it here for just the drilled scholar (same query, one id).
  const domainMapStatus = useQuery(
    (
      api.cohortPractice as unknown as {
        mapStatusForScholars: FunctionReference<
          "query",
          "public",
          { scholarIds: Id<"users">[] },
          MapStatusResult
        >;
      }
    ).mapStatusForScholars,
    domainScholarId
      ? { scholarIds: [domainScholarId as Id<"users">] }
      : "skip",
  );
  const domainScholarMapStatus = useMemo(() => {
    const perDomain = domainMapStatus?.scholars[0]?.perDomain.find(
      (entry) => entry.domain === domain,
    );
    return perDomain
      ? { status: perDomain.status, blockedBy: perDomain.blockedBy }
      : undefined;
  }, [domainMapStatus, domain]);
  const readingFor = (scholarId: string): ScholarReading | undefined =>
    nodeKey
      ? masteryByScholar
          .get(scholarId)
          ?.readings.find((candidate) => candidate.nodeKey === nodeKey)
      : undefined;

  // The true class spread for this skill (unfiltered — the distribution is a
  // full picture, distinct from the filter-respecting matrix). A scholar with no
  // reading yet buckets as "Not started".
  const bandMembers = new Map<MasteryFilterKey, RosterScholar[]>();
  for (const scholar of orderedScholars) {
    const reading = readingFor(scholar.id);
    const band: MasteryFilterKey = reading ? masteryFilterKey(reading) : "locked";
    bandMembers.set(band, [...(bandMembers.get(band) ?? []), scholar]);
  }
  const total = orderedScholars.length;

  const focusedScholar = focusedScholarId
    ? orderedScholars.find((scholar) => scholar.id === focusedScholarId)
    : undefined;
  const domainScholar = domainScholarId
    ? orderedScholars.find((scholar) => scholar.id === domainScholarId)
    : undefined;

  // ── Scholar × domain ───────────────────────────────────────────────────────
  // Highest priority: a whole-domain readout for one scholar. Needs no selected
  // node — it summarises every skill in the domain.
  if (domainScholar) {
    return (
      <ScholarDomainDetail
        scholar={domainScholar}
        orderedScholars={orderedScholars}
        scholarImageById={scholarImageById}
        masteryByScholar={masteryByScholar}
        domain={domain}
        domainLabel={domainLabel}
        domainNodes={domainNodes}
        mapStatus={domainScholarMapStatus}
        domainLabelFor={domainLabelFor}
        mathPlan={mathPlanFor?.(domainScholar.id)}
        plan={planByScholar?.get(domainScholar.id)}
        onStep={onFocusScholarDomain}
        onDrillSkill={(nodeKey) => onSelectCell(nodeKey, domainScholar.id)}
        onOpenReport={onOpenReport}
        onClose={() => onFocusScholarDomain(null)}
        retentionNow={retentionNow}
      />
    );
  }

  if (!effectiveNodeKey || !effectiveNode) {
    return (
      <Box p={4}>
        <Text fontSize="sm" color="charcoal.400">
          Select a skill to see what it builds on and leads to.
        </Text>
      </Box>
    );
  }

  // ── Scholar × skill ──────────────────────────────────────────────────────
  if (focusedScholar) {
    const reading = readingFor(focusedScholar.id);
    const index = orderedScholars.findIndex(
      (scholar) => scholar.id === focusedScholar.id,
    );
    const canStep = orderedScholars.length > 1;
    const step = (delta: number) => {
      if (!canStep) return;
      const next =
        orderedScholars[
          (index + delta + orderedScholars.length) % orderedScholars.length
        ];
      if (next) onFocusScholar(next.id);
    };
    return (
      <Box p={4}>
        <ScholarStepperHeader
          scholar={focusedScholar}
          index={index}
          total={orderedScholars.length}
          imageSrc={scholarImageById.get(focusedScholar.id)}
          onStep={step}
        />

        {mathPlanFor?.(focusedScholar.id)}

        {/* The checkpoint, authored on the band the clicked cell names. It sits
            directly under the plan summary and above the scope note, because it
            is the second half of the same authored policy — and it opens
            nothing, so the narrow-screen drawer never has to yield its layer. */}
        <CheckpointBandControl
          scholarId={focusedScholar.id}
          scholarName={focusedScholar.name}
          plan={planByScholar?.get(focusedScholar.id)}
          domain={domain}
          domainLabel={domainLabel}
          domainLabelFor={domainLabelFor}
          node={{ strand: effectiveNode.strand, grade: effectiveNode.grade }}
          bandSkillCount={
            domainNodes.filter(
              (candidate) =>
                (effectiveNode.strand == null ||
                  candidate.strand === effectiveNode.strand) &&
                candidate.grade === effectiveNode.grade,
            ).length
          }
          domainStrands={[
            ...new Set(
              domainNodes
                .map((candidate) => candidate.strand)
                .filter((strand): strand is string => strand !== null),
            ),
          ]}
          onOpenPlan={
            onOpenPlan ? () => onOpenPlan(focusedScholar.id) : undefined
          }
        />

        {/* The selected skill's strand may be outside this scholar's plan even
            when the domain is in it — same note, named at the altitude the
            panel is actually showing. */}
        <MathPlanScopeStrip
          plan={planByScholar?.get(focusedScholar.id)}
          domain={domain}
          domainLabel={domainLabel}
          strand={effectiveNode.strand}
          strandLabel={
            effectiveNode.strand ? humanizeStrand(effectiveNode.strand) : undefined
          }
          firstName={
            focusedScholar.name.split(" ")[0] ?? focusedScholar.name
          }
        />

        {/* This scholar's reading of THIS skill (the skill name is the drawer
            title now, so the card leads straight with the reading). */}
        <Box
          borderWidth="1px"
          borderColor="gray.100"
          borderRadius="lg"
          p={3}
          mb={4}
        >
          {reading ? (
            <>
              <Flex align="center" gap={3} mb={3}>
                <Box lineHeight={0} flexShrink={0}>
                  <KnowledgeNodeDial
                    mastery={reading.mastery}
                    automaticity={reading.automaticity}
                    depth={reading.depth}
                    size={44}
                    glyphs
                  />
                </Box>
                <Box minW={0} flex={1}>
                  <Text fontWeight="700" fontSize="sm" color="charcoal.700">
                    {MASTERY_LABEL[reading.mastery]}
                  </Text>
                  {reading.flagged && (
                    <Badge
                      colorPalette="orange"
                      variant="subtle"
                      size="sm"
                      mt={1}
                    >
                      Check in
                    </Badge>
                  )}
                </Box>
              </Flex>
              <Stack gap={2}>
                <MiniGauge
                  label="Automaticity"
                  value={reading.automaticity}
                  color={COLOR_AUTOMATICITY}
                />
                <MiniGauge
                  label="Depth"
                  value={reading.depth}
                  color={COLOR_DEPTH}
                />
              </Stack>
            </>
          ) : (
            <Text fontSize="sm" color="charcoal.400">
              No reading yet on this skill.
            </Text>
          )}
        </Box>

        {/* Teacher-only: this scholar's recent misses on this skill — the
            snapshotted stem, what they wrote vs. the expected answer, and any
            classified error pattern (Option 2 — see practiceAttempts schema
            comment). */}
        {nodeKey && (
          <RecentMissesForNode scholarId={focusedScholar.id} nodeKey={nodeKey} showLoading />
        )}
      </Box>
    );
  }

  // ── Skill-scoped (cohort distribution) ─────────────────────────────────────
  return (
    <Box p={4}>
      {!hideHeader && (
        <Text
          fontSize="2xs"
          fontWeight="700"
          color="charcoal.400"
          textTransform="uppercase"
          letterSpacing="0.04em"
          mb={2}
        >
          {effectiveNode.label} · neighbourhood
        </Text>
      )}
      {/* The math group's checkpoint, on the band this skill names. It leads the
          panel for the same reason the scholar control does: it is authored
          policy, and the readings below are what it is authored against. */}
      {groupCheckpointControl}
      <Box mb={5}>
        <SkillNeighbourhoodPanel
          nodeKey={effectiveNodeKey}
          scholarId={
            globalScholarId ? (globalScholarId as Id<"users">) : undefined
          }
          onNavigate={(navKey) => onSelectNode(navKey)}
        />
      </Box>

      {/* Cohort band distribution "sample" — the class spread on this skill.
          Click a band to drill into its first scholar. */}
      <Text
        fontSize="2xs"
        fontWeight="700"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.04em"
        mb={2}
      >
        How the class sits ({total})
      </Text>
      <Flex direction="column" gap={0}>
        {MASTERY_FILTER_ORDER.map((band) => {
          const members = bandMembers.get(band) ?? [];
          if (members.length === 0) return null;
          const sample = members
            .slice(0, 3)
            .map((scholar) => scholar.name)
            .join(", ");
          const more = members.length > 3 ? ` +${members.length - 3}` : "";
          return (
            <Flex
              key={band}
              as="button"
              onClick={() => onFocusScholar(members[0]!.id)}
              align="flex-start"
              gap={2.5}
              py={2}
              px={2}
              borderRadius="md"
              borderBottomWidth="1px"
              borderColor="gray.100"
              textAlign="left"
              w="100%"
              {...interactiveSurface}
              _hover={{ bg: "gray.50" }}
            >
              <Box mt={0.5}>
                <MasteryStatusMark status={band} />
              </Box>
              <Box minW={0} flex={1}>
                <Flex justify="space-between" align="baseline" gap={2}>
                  <Text fontSize="sm" fontWeight="600" color="charcoal.700">
                    {MASTERY_FILTER_LABEL[band]}
                  </Text>
                  <Text fontSize="xs" fontWeight="700" color="charcoal.500">
                    {members.length}
                  </Text>
                </Flex>
                <Text fontSize="2xs" color="charcoal.400" lineClamp={1} mt={1}>
                  {sample}
                  {more}
                </Text>
              </Box>
            </Flex>
          );
        })}
      </Flex>
    </Box>
  );
}
