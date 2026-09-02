"use client";

/**
 * Math Skills studio — one stable domain/strand/skill catalog with two lenses:
 * Mastery carries each scholar's canonical Tree dial plus teacher-controlled
 * domain/strand locks; Content carries the practice item pools and editors.
 *
 * DRY with the Tree Map: the detail pane is the SAME <NodeItemPool/> the
 * NodeDrawer embeds, and each row deep-links back here (?node=...). Backed by
 * convex/practiceItemPool.ts; the aide bot drives the same core helpers via
 * chat (list_practice_nodes / get_practice_item_pool / ...).
 *
 * The teacher dashboard layout owns the top navigation; this route changes only
 * the page body. Content keeps its existing Questions, Stories, and Instruction
 * editors rather than minting lighter duplicate forms; answer format (written
 * vs. hands-on) is a facet inside the Questions thread, not a fourth editor.
 */

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Heading,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { Play } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { isCurriculumRole, isTeacherRole } from "@/convex/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDefaultGroupScope } from "@/hooks/useDefaultGroupScope";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { Surface } from "@/components/ui/Surface";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { useSetAideScope } from "@/components/aide/AideDockProvider";
import { NodeItemPool } from "@/components/practice/NodeItemPool";
import { ManipulativeLibrary } from "@/components/manipulative/ManipulativeLibrary";
import type { ManipulativeKind } from "@/lib/manipulative/types";
import { MANIPULATIVE_KIND_LABELS } from "@/components/manipulative/catalog";
import { NodeStoryFamily, type StoryItem } from "@/components/NodeStoryFamily";
import {
  PracticeItemInventoryTable,
  type PracticeItemInventoryRow,
} from "@/components/practice/PracticeItemInventoryTable";
import {
  StoryInventoryTable,
  type StoryInventoryRow,
} from "@/components/practice/StoryInventoryTable";
import { isStrandInstructionKey } from "@/convex/lib/practice/instructionEntries";
import { MathSkillsMasteryView } from "@/components/practice/MathSkillsMasteryView";
import { MathSkillsStudioShell } from "@/components/practice/MathSkillsStudioShell";
import { StudioControlBar } from "@/components/practice/StudioControlBar";
import {
  ALL_DOMAINS_DOMAIN,
  FAST_MATH_DOMAIN,
  isSyntheticMathSkillsDomain,
} from "@/components/practice/MathSkillsDomainRail";
import { CheckpointGradePill, StrandHeading } from "@/components/practice/StrandHeading";
import {
  InstructionLaunchpadDetailPane,
  InstructionMediumBadge,
  type InstructionLaunchpadDetail,
} from "@/components/practice/InstructionLaunchpadDetail";
import {
  InstructionSegmentBodySkeleton,
  InventoryTableSkeleton,
  SkillPaneHeaderSkeleton,
  StoriesTabSkeleton,
} from "@/components/practice/MathSkillsContentSkeletons";
import {
  parseMasteryFilters,
  serializeMasteryFilters,
  type MasteryFilterKey,
} from "@/components/practice/mathSkillsMasteryFilters";
import {
  FACET_ORDER,
  THREAD_ORDER,
  formatFromParams,
  serializeFormat,
  tabFromParams,
  type AnswerFormat,
  type ContentSection,
} from "@/components/practice/mathSkillsContentSections";
import {
  instructionSegmentCount,
  nodeHasFacetContent,
  nodeHasThreadContent,
  parseGaps,
  serializeGaps,
  strandFacetCoverage,
  strandThreadCoverage,
} from "@/components/practice/mathSkillsThreadRail";

type MathSkillsLens = "mastery" | "content" | "manipulatives";
type InstructionCoverageRow = Omit<
  InstructionLaunchpadDetail,
  "domain" | "atoms" | "verifyReport"
>;

const TAB_LABEL: Record<ContentSection, string> = {
  questions: "Questions",
  stories: "Stories",
  instruction: "Instruction",
};

/** The answer-format facet's segment labels (sentence case). */
const FACET_LABEL: Record<AnswerFormat, string> = {
  all: "All",
  written: "Written",
  "hands-on": "Hands-on",
};

/** The Questions facet ⇒ the `NodeItemPool` / inventory `mode` it drives. No
 *  fourth mode is minted: the three existing values already map (all / written
 *  questions / hands-on manipulatives). */
function facetMode(format: AnswerFormat): "all" | "questions" | "manipulatives" {
  return format === "all"
    ? "all"
    : format === "hands-on"
      ? "manipulatives"
      : "questions";
}

/** The "gap" wash for a rail row that LACKS the active thread's content, shown
 *  only when "Show gaps" is on — a soft frontier-amber presence (the same
 *  family as KnowledgeTreePanel's frontier token), calibrated to read as
 *  "missing here", not an error. One variable only: has / hasn't. */
const GAP_BG = "#fbf4dd";
const GAP_BG_HOVER = "#f4e6bf";

function StrandGroup({
  strand,
  nodes,
  allNodes,
  instructionRow,
  selectedNode,
  selectedStrand,
  showSegmentRow,
  coverageMeta,
  onSelectSkill,
  onSelectStrand,
}: {
  strand: string;
  nodes: {
    nodeKey: string;
    label: string;
    grade: string | null;
    hasTemplate: boolean;
    itemCount: number;
    manipulativeCount: number;
    hasManipulative: boolean;
    stretchCount: number;
    hasStretch: boolean;
    serveable: boolean;
    /** Lacks the active thread's content — tint quietly (only ever true when
     *  "Show gaps" is on; the default filter drops these rows entirely). */
    missing: boolean;
    /** Instruction thread only: how many instructional segments apply to this
     *  skill (1 = inherits its strand's; 2 = also has its own node-grain).
     *  Undefined for the other threads (no pill). */
    segmentCount?: number;
  }[];
  /** The UNFILTERED strand nodes — the header's meta + grade pill read these,
   *  so a thread-filtered rail can't misreport the denominator or range. */
  allNodes: { grade: string | null }[];
  /** This strand's stored instructional segment (from the SAME domain-wide
   *  `instructionCoverage` read the rail already fetches), undefined when
   *  nothing is stored for this strand yet. */
  instructionRow: InstructionCoverageRow | undefined;
  /** The selected skill (null when a strand or nothing is selected). */
  selectedNode: string | null;
  /** The selected instructional-segment strand (null when a skill or nothing is
   *  selected) — mutually exclusive with `selectedNode`. */
  selectedStrand: string | null;
  /** Whether this strand's instructional-segment row renders (Instruction
   *  thread only). */
  showSegmentRow: boolean;
  /** The active thread's single meta line ("3 of 5 skills have
   *  manipulatives"), or null for NO meta line (Instruction thread — its
   *  segment row carries a status badge; the grade lives in the pill). */
  coverageMeta: string | null;
  /** Select a skill into the detail pane. */
  onSelectSkill: (nodeKey: string) => void;
  /** Select this strand's instructional segment into the detail pane — one
   *  click idiom, same as a skill row (no accordion). */
  onSelectStrand: (strand: string) => void;
}) {
  // A shown segment row with nothing stored is a gap (only reachable when "Show
  // gaps" is on for the Instruction thread) — tint it the same amber wash.
  const segmentMissing = !instructionRow;
  return (
    <Box>
      {/* Strand group header — a quiet gray.50 band with a hairline separator,
          matching Mastery's strand headers (a "meaty" anchor, same tokens).
          One meta line ("X of Y skills have …", from the UNFILTERED strand) and
          a right-aligned grade pill — the SAME CheckpointGradePill Mastery
          renders, here in its disabled non-interactive form (checkpoints are
          set where a scholar/group is in scope, i.e. the Mastery lens). */}
      <Flex
        px={3}
        py={2}
        bg="gray.50"
        borderBottomWidth="1px"
        borderColor="gray.100"
        align="center"
        justify="space-between"
        gap={2}
        // Sticky within the rail's scroll container, matching Mastery's strand
        // rows: the nearest header holds the top edge while its skills scroll
        // under it, then the next band pushes it out. Opaque bg is what makes
        // the overlap read cleanly.
        position="sticky"
        top={0}
        zIndex={1}
      >
        <StrandHeading strand={strand} nodes={allNodes} metaOverride={coverageMeta} />
        <CheckpointGradePill
          nodes={allNodes}
          altitude="strand"
          currentGrade={null}
          canSet={false}
          disabledHint="Checkpoints are set from the Mastery lens, where a group or scholar is in scope."
          onSetGrade={() => {}}
          onClear={() => {}}
        />
      </Flex>
      {/* The strand's instructional segment — a strand-level flush row at the TOP
          of the skill list (Instruction thread only). A plain SELECT row like
          every skill row (no accordion): clicking it selects the strand and the
          pane shows its segment detail. Skipped for the null-strand "other"
          bucket (segments are keyed by domain+strand). Violet.50 fill when
          selected (never an edge-only stripe); amber wash when it's a gap shown
          by "Show gaps". */}
      {strand !== "other" && showSegmentRow && (
        <Flex
          as="button"
          onClick={() => onSelectStrand(strand)}
          align="center"
          gap={2}
          px={3}
          py={2}
          cursor="pointer"
          bg={
            selectedStrand === strand
              ? "violet.50"
              : segmentMissing
                ? GAP_BG
                : "white"
          }
          borderBottomWidth="1px"
          borderColor="gray.100"
          _hover={{
            bg:
              selectedStrand === strand
                ? "violet.50"
                : segmentMissing
                  ? GAP_BG_HOVER
                  : "gray.50",
          }}
          textAlign="left"
          width="100%"
          data-testid={`strand-segment-${strand}`}
        >
          <Text
            fontSize="sm"
            fontWeight="600"
            color={
              selectedStrand === strand
                ? "violet.700"
                : instructionRow
                  ? "charcoal.700"
                  : "charcoal.400"
            }
            flex={1}
            minW={0}
            lineHeight="1.35"
            lineClamp={1}
          >
            Instructional segment
            {instructionRow ? ` · ${instructionRow.title}` : " — none yet"}
          </Text>
          {instructionRow && <InstructionMediumBadge medium={instructionRow.medium} />}
          {/* Only a NOT-passed segment shows a badge: a passed segment is the
              boring default, so no chip (actionable information only — the
              taste charter's one-variable rule; replaces the old 'passed'
              chip). */}
          {instructionRow && instructionRow.status !== "passed" && (
            <Badge colorPalette="gray" variant="outline" size="sm">
              draft
            </Badge>
          )}
        </Flex>
      )}
      {nodes.map((n) => {
        const isSel = n.nodeKey === selectedNode;
        return (
          <Flex
            key={n.nodeKey}
            as="button"
            onClick={() => onSelectSkill(n.nodeKey)}
            align="center"
            gap={2}
            px={3}
            py={2}
            cursor="pointer"
            bg={isSel ? "violet.50" : n.missing ? GAP_BG : "white"}
            borderBottomWidth="1px"
            borderColor="gray.100"
            _hover={{
              bg: isSel ? "violet.50" : n.missing ? GAP_BG_HOVER : "gray.50",
            }}
            textAlign="left"
            width="100%"
            data-testid={`pool-node-${n.nodeKey}`}
          >
            <Text
              fontSize="sm"
              fontWeight={isSel ? "700" : "600"}
              color={isSel ? "violet.700" : "charcoal.700"}
              flex={1}
              minW={0}
              lineHeight="1.35"
              lineClamp={1}
            >
              {n.label}
            </Text>
            {/* Right-aligned trailing cluster: an optional violet segment-count
                pill (Instruction thread), then the grade in its own consistent
                right-hand column so its x-position doesn't jitter with the
                truncating label — lining up with where Mastery reserves its
                checkpoint-flag column. The amber wash (Show gaps) stays the only
                per-row "has / hasn't" signal. */}
            <Flex align="center" gap={2} flexShrink={0}>
              {n.segmentCount !== undefined && n.segmentCount > 0 && (
                <Badge
                  colorPalette="violet"
                  variant="subtle"
                  size="sm"
                  data-testid={`content-count-${n.nodeKey}`}
                >
                  {n.segmentCount}
                </Badge>
              )}
              {n.grade && (
                <Text
                  fontSize="xs"
                  fontWeight="400"
                  color="charcoal.400"
                  minW="24px"
                  textAlign="right"
                >
                  G{n.grade}
                </Text>
              )}
            </Flex>
          </Flex>
        );
      })}
    </Box>
  );
}

/**
 * One domain's contribution to the Content-lens Skills rail (the unit that makes
 * "All domains" work): it owns its OWN `poolSummary` + `instructionCoverage`
 * reads, so N of these compose a cross-domain rail with no new Convex query.
 * Scopes its skills to the ACTIVE thread (default: only skills with that
 * thread's content; "Show gaps" reveals the have-nots with an amber wash), and
 * renders an optional domain heading (All-domains mode) above its strand groups.
 */
function RailDomainSection({
  domain,
  label,
  showHeading,
  thread,
  format,
  showGaps,
  storyCoveredKeys,
  storyCountByNode,
  selectedNode,
  selectedStrand,
  selectedStrandDomain,
  onSelectSkill,
  onSelectStrand,
}: {
  domain: string;
  label: string;
  showHeading: boolean;
  /** The active top-level thread — governs which content the rail is scoped to
   *  (skill rows for Questions/Stories; strand segment rows + node-grain skills
   *  for Instruction). */
  thread: ContentSection;
  /** The Questions thread's answer-format facet (All · Written · Hands-on) —
   *  narrows the Questions rail's coverage predicate + strand meta. Ignored by
   *  the Stories/Instruction threads. */
  format: AnswerFormat;
  /** "Show gaps" — off shows only the haves; on shows all rows and washes the
   *  have-nots amber. */
  showGaps: boolean;
  storyCoveredKeys: ReadonlySet<string>;
  /** Per-node world-connection story counts (derived from the already-fetched
   *  domain story list — no new query), feeding the Stories thread's count
   *  pill. */
  storyCountByNode: ReadonlyMap<string, number>;
  selectedNode: string | null;
  selectedStrand: string | null;
  selectedStrandDomain: string | null;
  onSelectSkill: (nodeKey: string) => void;
  onSelectStrand: (domain: string, strand: string) => void;
}) {
  const summary = useQuery(api.practiceItemPool.poolSummary, { domain });
  const coverage = useQuery(api.instruction.instructionCoverage, { domain });
  const instructionByStrand = useMemo(
    () =>
      new Map(
        (coverage?.strands ?? [])
          .filter((s) => isStrandInstructionKey(s.key))
          .map((s) => [s.strand, s]),
      ),
    [coverage],
  );
  // The skills that carry their OWN node-grain instructional segment (metadata
  // only — the full segment is fetched keyed for the selected skill). These are
  // genuine Instruction-thread content, so they show as skill rows in that
  // thread regardless of "Show gaps".
  const nodeSegmentKeys = useMemo(
    () => new Set((coverage?.nodeSegments ?? []).map((s) => s.nodeKey)),
    [coverage],
  );
  const isInstruction = thread === "instruction";
  const filteredStrands = useMemo(() => {
    const groups: { strand: string; nodes: NonNullable<typeof summary>["nodes"] }[] = [];
    for (const n of summary?.nodes ?? []) {
      const key = n.strand ?? "other";
      const g = groups.find((s) => s.strand === key);
      if (g) g.nodes.push(n);
      else groups.push({ strand: key, nodes: [n] });
    }
    return groups
      .map((s) => {
        if (isInstruction) {
          // Instruction thread: SKILL rows like every other thread (consistent),
          // each carrying a violet count pill = how many segments apply to it
          // (1 = inherits its strand's; 2 = also has its own node-grain). A skill
          // with 0 is a gap (no segment anywhere): hidden by default, amber-washed
          // under "Show gaps". The strand's own segment row stays at the top as the
          // strand-level doorway. Coverage meta reads like the other threads.
          const hasStrandSegment =
            s.strand !== "other" && instructionByStrand.has(s.strand);
          const showSegmentRow =
            s.strand !== "other" && (hasStrandSegment || showGaps);
          const withCount = s.nodes.map((n) => {
            const segmentCount = instructionSegmentCount(
              hasStrandSegment,
              nodeSegmentKeys.has(n.nodeKey),
            );
            return { ...n, missing: segmentCount === 0, segmentCount };
          });
          const haveCount = withCount.filter((n) => !n.missing).length;
          return {
            strand: s.strand,
            nodes: showGaps ? withCount : withCount.filter((n) => !n.missing),
            allNodes: s.nodes,
            showSegmentRow,
            coverageMeta: strandThreadCoverage(haveCount, s.nodes.length, thread),
          };
        }
        // Item threads (Questions / Stories): skill rows, scoped to the thread's
        // content. Default ⇒ only the haves; "Show gaps" ⇒ all, with the
        // have-nots flagged `missing` (washed amber). The strand header
        // annotates the count.
        //
        // Questions carries the answer-format FACET: its coverage predicate,
        // count pill, and strand meta all read the facet (this is the coverage
        // job the old Manipulatives thread supplied — Hands-on reproduces it
        // exactly; "Show gaps" is now scoped to the active facet).
        const isQuestions = thread === "questions";
        const withFlag = s.nodes.map((n) => ({
          ...n,
          missing: isQuestions
            ? !nodeHasFacetContent(n, format)
            : !nodeHasThreadContent(n, thread, storyCoveredKeys.has(n.nodeKey)),
          // The violet count pill. Stories: the world-connection count. Questions:
          // the hands-on count under the Hands-on / All facets (a manipulative is
          // a finite stored item, honestly countable); DELIBERATELY absent under
          // the Written facet — a code template serves ENDLESS variants, so no
          // honest integer covers a template-backed skill (the strand meta still
          // counts it as covered).
          segmentCount: isQuestions
            ? format === "written"
              ? undefined
              : n.hasManipulative
                ? n.manipulativeCount
                : undefined
            : thread === "stories"
              ? (storyCountByNode.get(n.nodeKey) ?? 0)
              : undefined,
        }));
        const haveCount = withFlag.filter((n) => !n.missing).length;
        // Questions reads a facet-aware, two-clause-capable meta (keeping the
        // "N of M skills have questions · K have hands-on" sentence verbatim);
        // Stories reads the plain thread-noun count. Both denominators are the
        // UNFILTERED strand node count.
        const writtenHave = s.nodes.filter(
          (n) => n.hasTemplate || n.itemCount > 0,
        ).length;
        const handsOnHave = s.nodes.filter((n) => n.hasManipulative).length;
        return {
          strand: s.strand,
          nodes: showGaps ? withFlag : withFlag.filter((n) => !n.missing),
          allNodes: s.nodes,
          showSegmentRow: false,
          coverageMeta: isQuestions
            ? strandFacetCoverage(writtenHave, handsOnHave, s.nodes.length, format)
            : strandThreadCoverage(haveCount, s.nodes.length, thread),
        };
      })
      .filter((s) => s.nodes.length > 0 || s.showSegmentRow);
  }, [
    summary?.nodes,
    thread,
    format,
    isInstruction,
    showGaps,
    storyCoveredKeys,
    storyCountByNode,
    instructionByStrand,
    nodeSegmentKeys,
  ]);

  const heading = showHeading ? (
    <Box
      px={3}
      py={1.5}
      bg="gray.50"
      borderBottomWidth="1px"
      borderColor="gray.100"
    >
      <Text
        fontSize="2xs"
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="0.04em"
        color="charcoal.500"
        lineClamp={1}
      >
        {label}
      </Text>
    </Box>
  ) : null;

  if (summary === undefined) {
    return (
      <Box>
        {heading}
        <Flex align="center" gap={2} py={4} justify="center">
          <Spinner size="sm" color="violet.500" />
          <Text fontSize="sm" color="charcoal.400">
            Loading skills…
          </Text>
        </Flex>
      </Box>
    );
  }
  if (filteredStrands.length === 0) {
    // In All-domains mode, silently skip a domain with nothing matching (don't
    // clutter the rail with empty headings); in single-domain, say so. The noun
    // follows the active facet on the Questions thread.
    if (showHeading) return null;
    const noun =
      thread === "questions"
        ? format === "hands-on"
          ? "hands-on items"
          : format === "written"
            ? "written items"
            : "questions"
        : thread;
    return (
      <Text fontSize="xs" color="charcoal.400" py={4} textAlign="center">
        {showGaps
          ? "No skills in this domain yet."
          : `No skills have ${noun} yet — turn on Show gaps to see them all.`}
      </Text>
    );
  }
  return (
    <Box>
      {heading}
      {filteredStrands.map((s) => (
        <StrandGroup
          key={s.strand}
          strand={s.strand}
          nodes={s.nodes}
          allNodes={s.allNodes}
          instructionRow={instructionByStrand.get(s.strand)}
          selectedNode={selectedNode}
          selectedStrand={selectedStrandDomain === domain ? selectedStrand : null}
          showSegmentRow={s.showSegmentRow}
          coverageMeta={s.coverageMeta}
          onSelectSkill={onSelectSkill}
          onSelectStrand={(strand) => onSelectStrand(domain, strand)}
        />
      ))}
    </Box>
  );
}

/**
 * One domain's inventory table for the no-skill worktable, scoped to the active
 * Questions-thread answer-format facet (all / written questions / hands-on
 * manipulatives). Owns its own `itemsForDomain` (+ `poolSummary` for the
 * question templates) read. In All-domains mode it is LAZY — a "Load <domain>"
 * button defers the read so eight domains don't fetch every item eagerly; in
 * single-domain mode it loads immediately.
 */
function DomainItemsWorktable({
  domain,
  label,
  mode,
  showHeading,
  eager,
  onSelectSkill,
}: {
  domain: string;
  label: string;
  mode: "questions" | "manipulatives" | "all";
  showHeading: boolean;
  eager: boolean;
  onSelectSkill: (nodeKey: string) => void;
}) {
  const [manualLoad, setManualLoad] = useState(false);
  // `eager` (single-domain) always loads; in All-domains it defers until the
  // teacher clicks "Load <domain>". Deriving `load` (rather than seeding
  // useState from `eager`) means a lens switch back to single-domain forces the
  // read even if this section had been left unloaded.
  const load = eager || manualLoad;
  const items = useQuery(
    api.practiceItemPool.itemsForDomain,
    load ? { domain } : "skip",
  );
  // Templates belong to the written pool, so they're fetched for every facet
  // except Hands-on (which shows manipulatives only).
  const summary = useQuery(
    api.practiceItemPool.poolSummary,
    load && mode !== "manipulatives" ? { domain } : "skip",
  );
  const heading = showHeading ? (
    <SectionEyebrow boxProps={{ mb: 2, lineClamp: 1 }}>{label}</SectionEyebrow>
  ) : null;
  return (
    <Box mb={showHeading ? 5 : 0}>
      {heading}
      {!load ? (
        <Button
          size="sm"
          variant="outline"
          colorPalette="violet"
          onClick={() => setManualLoad(true)}
          data-testid={`worktable-load-${domain}`}
        >
          Load {label}
        </Button>
      ) : items === undefined ? (
        <InventoryTableSkeleton columns={4} />
      ) : (
        <PracticeItemInventoryTable
          mode={mode}
          rows={items as PracticeItemInventoryRow[]}
          templateSkills={
            mode !== "manipulatives"
              ? (summary?.nodes ?? [])
                  .filter((node) => node.hasTemplate)
                  .map((node) => ({
                    nodeKey: node.nodeKey,
                    label: node.label,
                    strand: node.strand,
                    grade: node.grade,
                  }))
              : undefined
          }
          onSelectSkill={onSelectSkill}
        />
      )}
    </Box>
  );
}

function PracticePoolInner() {
  const router = useRouter();
  const params = useSearchParams();
  const nodeParam = params.get("node");
  const strandParam = params.get("strand");
  const viewParam = params.get("view");
  const lensParam = params.get("lens");

  const [selectedNode, setSelectedNode] = useState<string | null>(nodeParam);
  const [selectedStrand, setSelectedStrand] = useState<string | null>(strandParam);
  // The domain of the selected instructional segment. Needed because in "All
  // domains" mode the domain= param is the __all__ sentinel, so the strand's
  // real domain travels separately as sd=. Falls back to the domain= param for
  // a single-domain link that carries only strand= — but never the __all__
  // sentinel itself (a ?domain=__all__&strand=… link without sd= would
  // otherwise feed "__all__" into a domain-keyed query).
  const [selectedStrandDomain, setSelectedStrandDomain] = useState<string | null>(() => {
    const sd = params.get("sd");
    if (sd) return sd;
    const d = params.get("domain");
    return strandParam && d && !isSyntheticMathSkillsDomain(d) ? d : null;
  });
  const [pickedDomain, setPickedDomain] = useState<string | null>(params.get("domain"));
  // The active THREAD — one top-level switch (Questions · Instruction · Stories)
  // governs the whole surface (rail scope + pane content). Persists across skill
  // selections (so keeping Stories active and clicking down the rail browses
  // story after story), and round-trips through the URL as `view=` (an honest
  // tab param, with the legacy-value migration). Seeded from the URL: `view=`
  // directly, or a canonical `?strand=` Instruction link.
  const [tab, setTab] = useState<ContentSection>(() =>
    tabFromParams({ node: nodeParam, strand: strandParam, view: viewParam }),
  );
  // The Questions thread's answer-format FACET (All · Written · Hands-on) — the
  // fold's prize: written and hands-on live in one thread, narrowed by a facet
  // instead of split across two top-level threads. Applies only when Questions
  // is active; round-trips as `?format=` (default `all` drops the param). A
  // legacy `view=manipulatives` / `view=coverage` link seeds Hands-on so an old
  // bookmark lands on precisely the old view.
  const [format, setFormat] = useState<AnswerFormat>(() =>
    formatFromParams({ view: viewParam, format: params.get("format") }),
  );
  // "Show gaps" — the single rail toggle (round-trips as `gaps=1`). Off shows
  // only the skills that HAVE the active thread's content; on shows every skill
  // and washes the have-nots amber.
  const [showGaps, setShowGaps] = useState<boolean>(() =>
    parseGaps(params.get("gaps")),
  );
  const [lens, setLens] = useState<MathSkillsLens>(() => {
    if (lensParam === "mastery") return "mastery";
    if (lensParam === "manipulatives") return "manipulatives";
    // `view=` is a Content-lens-only param, so its mere presence pins the lens.
    // Without this a bare legacy `?view=manipulatives` / `?view=coverage`
    // bookmark fell through to Mastery and the migration silently did nothing —
    // the format migration below is correct, but it only ever runs under
    // Content. App-generated URLs always carry `lens=`, so this is the
    // hand-typed / pre-lens-era link path.
    if (lensParam === "content" || nodeParam || viewParam) return "content";
    return "mastery";
  });
  // The Library's "Use on a skill…" handoff, held as ephemeral state (not a
  // shareable URL param — it's a transient authoring intent, not a view). When
  // set, the Content-lens NodeItemPool opens preselected to this kind; cleared
  // the moment the teacher deliberately navigates lens/thread/facet away.
  const [pendingManipKind, setPendingManipKind] =
    useState<ManipulativeKind | null>(null);
  const [masteryScope, setMasteryScope] = useState(params.get("scope") ?? "");
  // A teacher who runs a math cohort opens on it, not on the whole school —
  // unless this visit already named a scope (a deep link wins). `has`, not a
  // truthiness check, so a bare `?scope=` is an expressible "all scholars, and
  // I mean it". Captured at first render so the default can't re-fire off its
  // own URL write.
  const [scopeCameFromUrl] = useState(() => params.has("scope"));
  useDefaultGroupScope({
    enabled: !scopeCameFromUrl,
    subject: "math",
    // The studio's participation filter starts enrolled-only and apply can't
    // widen it, so a guest-inclusive default would land hidden by its own
    // filter.
    includeProgramGuests: false,
    // Functional update so a scope the teacher picked during the roster-load
    // window survives — the default only fills an empty scope.
    apply: (id) => setMasteryScope((cur) => cur || id),
  });
  const [masteryScholar, setMasteryScholar] = useState(
    params.get("scholar") ?? "",
  );
  const [masterySearch, setMasterySearch] = useState(params.get("q") ?? "");
  const [masteryStatuses, setMasteryStatuses] = useState<
    Set<MasteryFilterKey>
  >(() => parseMasteryFilters(params.get("statuses")));
  const [masteryTreeView, setMasteryTreeView] = useState(
    params.get("mv") === "tree",
  );
  // The scholar whose full-bleed domain report (D2) is open, "" for none.
  const [reportScholar, setReportScholar] = useState(params.get("report") ?? "");
  const urlNavigationMode = useRef<"push" | "replace">("replace");
  // The search string this component last wrote to the URL (fix #1). The
  // param-sync effect below compares against it to tell an EXTERNAL navigation
  // (a cmd-K / NodeDrawer `router.push`, or back/forward) from our own URL-write
  // echo — only the former should re-hydrate local state. Seeded with the
  // initial search so the first param-sync run (identical to mount state) is a
  // no-op.
  const lastWrittenSearch = useRef<string | null>(params.toString());

  const pushUrlState = (update: () => void) => {
    urlNavigationMode.current = "push";
    update();
  };

  // Source-of-truth sync: whenever the URL's search params change from a source
  // OTHER than our own write — a cmd-K skill jump / NodeDrawer deep link
  // (`router.push` to this same route, which does NOT fire `popstate`), or
  // back/forward — re-hydrate local state from the params (fixes #1). Reading
  // `useSearchParams()` (reactive to both push and popstate) replaces the old
  // mount+popstate-only listener.
  const searchString = params.toString();
  useEffect(() => {
    if (
      lastWrittenSearch.current !== null &&
      searchString === lastWrittenSearch.current
    ) {
      return;
    }
    const next = params;
    const node = next.get("node");
    const strand = next.get("strand");
    const view = next.get("view");
    // A pending Library handoff belongs only to the in-app navigation that
    // created it. Back/forward, cmd-K, and pasted links start a new intent.
    setPendingManipKind(null);
    setSelectedNode(node);
    setSelectedStrand(strand);
    setSelectedStrandDomain(
      next.get("sd") ??
        (strand &&
        next.get("domain") &&
        !isSyntheticMathSkillsDomain(next.get("domain")!)
          ? next.get("domain")
          : null),
    );
    setPickedDomain(next.get("domain"));
    // The active thread: `view=` directly, or a canonical `?strand=` Instruction
    // link opens the Instruction thread.
    setTab(tabFromParams({ node, strand, view }));
    setFormat(formatFromParams({ view, format: next.get("format") }));
    setShowGaps(parseGaps(next.get("gaps")));
    const lensParam2 = next.get("lens");
    setLens(
      lensParam2 === "mastery"
        ? "mastery"
        : lensParam2 === "manipulatives"
          ? "manipulatives"
          : lensParam2 === "content" || node || view
            ? "content"
            : "mastery",
    );
    setMasteryScope(next.get("scope") ?? "");
    setMasteryScholar(next.get("scholar") ?? "");
    setMasterySearch(next.get("q") ?? "");
    setMasteryTreeView(next.get("mv") === "tree");
    setReportScholar(next.get("report") ?? "");
    const nextStatuses = parseMasteryFilters(next.get("statuses"));
    setMasteryStatuses((current) =>
      serializeMasteryFilters(current) === serializeMasteryFilters(nextStatuses)
        ? current
        : nextStatuses,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchString]);

  // The (dashboard) layout gates on isStaffRole, which admits the OPERATIONS STAFF —
  // a staff role the curriculum gate rejects. Don't mount a body whose
  // queries would throw "Forbidden" into the ErrorBoundary (the layout's own
  // rule for role-mismatched surfaces); show a notice instead.
  const { user, isLoading: userLoading } = useCurrentUser();
  const mayView = isCurriculumRole(user?.role);
  const mayViewMastery = isTeacherRole(user?.role);
  // Manipulatives (the Library) is cohort-agnostic and open to every curriculum
  // role; Mastery is teacher-only, so a non-teacher's "mastery" collapses to
  // Content. The Library is never gated down.
  const effectiveLens: MathSkillsLens =
    lens === "manipulatives"
      ? "manipulatives"
      : mayViewMastery
        ? lens
        : "content";

  const domains = useQuery(api.standingPractice.listDomains, mayView ? {} : "skip");
  // A ?node= deep link (e.g. from the Tree Map's NodeDrawer) may point at any
  // domain — resolve the node first, then follow its domain.
  const selectedPool = useQuery(
    api.practiceItemPool.poolForNode,
    mayView && selectedNode ? { nodeKey: selectedNode } : "skip",
  );
  // The selected skill's strand + domain, once its pool has resolved to the
  // CURRENT selection (during a selection change `selectedPool` briefly holds
  // the previous node). The DOMAIN comes from the node itself (not the page
  // `domain`, which is null in All-domains mode), so a selected skill's
  // instruction reads work in every mode.
  const selectedSkillStrand =
    selectedPool && selectedPool.node.nodeKey === selectedNode
      ? (selectedPool.node.strand ?? null)
      : null;
  const selectedSkillDomain =
    selectedPool && selectedPool.node.nodeKey === selectedNode
      ? selectedPool.node.domain
      : null;

  const domain =
    pickedDomain && isSyntheticMathSkillsDomain(pickedDomain)
      ? null
      : pickedDomain ?? selectedPool?.node.domain ?? domains?.[0]?.domain ?? null;
  // "All domains" (an experiment: cross-domain mastery grade level per
  // scholar) is picked via the SAME domain channel as a real domain, so it
  // travels through the URL/rail without a parallel piece of state — but it
  // must never reach the per-domain queries below (`domain` stays null for it).
  const isAllDomains = pickedDomain === ALL_DOMAINS_DOMAIN;
  const isFastMath = pickedDomain === FAST_MATH_DOMAIN;
  // Keep-previous so a domain switch doesn't unmount the whole mastery view to
  // a spinner — the prior domain's matrix stays on screen until the new
  // summary arrives, then swaps in one frame.
  const summary = useSmoothedQuery(
    api.practiceItemPool.poolSummary,
    mayView && domain ? { domain } : "skip",
  );
  // Per-node world-connection story counts for the mastery matrix row subtext
  // (replaces the developer-facing nodeKey slug with "· N stories").
  const storyCounts = useQuery(
    api.nodeNeighbourhood.storyCountsForDomain,
    mayView && effectiveLens === "mastery" && domain ? { domain } : "skip",
  );
  const stories = useQuery(
    api.edgeStories.listStories,
    mayView && effectiveLens === "content" ? {} : "skip",
  );
  const instructionCoverage = useQuery(
    api.instruction.instructionCoverage,
    mayView && effectiveLens === "content" && domain ? { domain } : "skip",
  );
  // The Instruction TAB's domain-wide detail — no skill selected, a strand
  // picked (via the rail's segment rows). Keyed by the strand's OWN domain
  // (`selectedStrandDomain`), so it works in All-domains mode too. Not gated on
  // the active tab so the (persistent, non-unmounting) Instruction panel keeps
  // its detail when you tab away and back.
  const selectedLaunchpad = useQuery(
    api.instruction.instructionLaunchpadForStrand,
    mayView &&
      effectiveLens === "content" &&
      selectedNode === null &&
      selectedStrand &&
      selectedStrandDomain
      ? { domain: selectedStrandDomain, strand: selectedStrand }
      : "skip",
  );
  // The SELECTED skill's strand instructional segment — feeds the pane's
  // Instruction tab (captioned "shared by every skill in this strand"). Keyed
  // by the skill's OWN domain + strand; no new query.
  const selectedSkillLaunchpad = useQuery(
    api.instruction.instructionLaunchpadForStrand,
    mayView &&
      effectiveLens === "content" &&
      selectedNode &&
      selectedSkillDomain &&
      selectedSkillStrand
      ? { domain: selectedSkillDomain, strand: selectedSkillStrand }
      : "skip",
  );
  // Resolve the segment the pane sees, so a STRANDLESS skill (the null-strand
  // "other" bucket) doesn't spin forever (fix #5): once the pool has resolved
  // for the selected skill and it has no strand, there is nothing to fetch —
  // pass an explicit `null` (the section's empty state) instead of the `undefined`
  // loading sentinel the skipped query returns.
  const selectedSkillLaunchpadResolved = selectedSkillStrand
    ? selectedSkillLaunchpad
    : selectedPool && selectedPool.node.nodeKey === selectedNode
      ? null
      : undefined;
  // The selected skill's story neighbourhood — feeds the unified pane's Stories
  // section. Fired whenever a skill is selected (the pane always renders every
  // section in one scroll).
  const selectedNeighbourhood = useQuery(
    api.nodeNeighbourhood.neighbourhood,
    mayView && effectiveLens === "content" && selectedNode
      ? { nodeKey: selectedNode }
      : "skip",
  );

  // Publish the on-screen domain/node to the shared teacher aide dock (the
  // header Robot opens it). The general aide picks up `practiceContext` so
  // "this node" / "these pools" resolve, and its practice item-pool tools can
  // survey coverage, read a node's pool, and author/edit stored items. Resets
  // to global scope on unmount.
  useSetAideScope({
    kind: "practice",
    domain,
    domainLabel: summary?.domainLabel ?? null,
    nodeKey: selectedNode,
    nodeLabel: selectedNode
      ? (selectedPool?.node.label ??
        summary?.nodes.find((node) => node.nodeKey === selectedNode)?.label ??
        null)
      : null,
  });

  // Keep the URL shareable as the teacher browses. `view=` is the active thread
  // (persists across skill selections). `strand=` is the selected instructional
  // segment (no skill selected, Instruction thread). `gaps=1` is the "Show gaps"
  // toggle.
  useEffect(() => {
    if (userLoading || !mayView || !(domain || isAllDomains || isFastMath)) return;
    const q = new URLSearchParams();
    q.set(
      "domain",
      isAllDomains
        ? ALL_DOMAINS_DOMAIN
        : isFastMath
          ? FAST_MATH_DOMAIN
          : (domain as string),
    );
    q.set("lens", effectiveLens);
    if (selectedNode) {
      q.set("node", selectedNode);
    } else if (
      effectiveLens === "content" &&
      tab === "instruction" &&
      selectedStrand
    ) {
      q.set("strand", selectedStrand);
      // Carry the strand's domain when it isn't already the domain= param
      // (i.e. in "All domains" mode).
      if (selectedStrandDomain && selectedStrandDomain !== domain) {
        q.set("sd", selectedStrandDomain);
      }
    }
    if (effectiveLens === "content") q.set("view", tab);
    // The answer-format facet only means anything on the Questions thread, so
    // only persist it there (and only when it isn't the `all` default).
    if (effectiveLens === "content" && tab === "questions") {
      const serializedFormat = serializeFormat(format);
      if (serializedFormat !== null) q.set("format", serializedFormat);
    }
    if (effectiveLens === "mastery" && masteryTreeView) q.set("mv", "tree");
    if (effectiveLens === "mastery" && reportScholar) q.set("report", reportScholar);
    if (masteryScope) q.set("scope", masteryScope);
    if (masteryScholar) q.set("scholar", masteryScholar);
    if (masterySearch) q.set("q", masterySearch);
    const serializedStatuses = serializeMasteryFilters(masteryStatuses);
    if (serializedStatuses !== null) q.set("statuses", serializedStatuses);
    // `colorBy` (the matrix's "Level coloring" mode) is owned and written by
    // MathSkillsMasteryView, not page state — read the live URL at write time
    // and pass it through so this rebuild doesn't strip it. Not a reactive
    // dep: the view's own router.replace echoes back through the guard below.
    if (effectiveLens === "mastery") {
      const liveColorBy = new URLSearchParams(window.location.search).get(
        "colorBy",
      );
      if (liveColorBy) q.set("colorBy", liveColorBy);
    }
    if (effectiveLens === "content") {
      const serializedGaps = serializeGaps(showGaps);
      if (serializedGaps !== null) q.set("gaps", serializedGaps);
    }
    const serialized = q.toString();
    // Record what we're writing so the param-sync effect can distinguish this
    // echo from a genuine external navigation (fix #1).
    lastWrittenSearch.current = serialized;
    const href = `/teacher/math-skills?${serialized}`;
    if (`${window.location.pathname}${window.location.search}` === href) {
      urlNavigationMode.current = "replace";
      return;
    }
    const navigationMode = urlNavigationMode.current;
    urlNavigationMode.current = "replace";
    router[navigationMode](href, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    domain,
    isAllDomains,
    isFastMath,
    effectiveLens,
    showGaps,
    format,
    masteryScholar,
    masteryScope,
    masterySearch,
    masteryStatuses,
    masteryTreeView,
    reportScholar,
    mayView,
    selectedNode,
    selectedStrand,
    selectedStrandDomain,
    tab,
    userLoading,
  ]);

  const strands: { strand: string; nodes: NonNullable<typeof summary>["nodes"] }[] = [];
  for (const n of summary?.nodes ?? []) {
    const key = n.strand ?? "other";
    const g = strands.find((s) => s.strand === key);
    if (g) g.nodes.push(n);
    else strands.push({ strand: key, nodes: [n] });
  }
  const storyRows = useMemo(
    () => (stories ?? []).filter((row) => row.fromDomain === domain),
    [domain, stories],
  );
  // Story coverage keyed by nodeKey GLOBALLY (node keys are globally unique, so
  // one set serves every domain — each rail section in All-domains mode looks up
  // only its own nodes' keys). `listStories` is domain-agnostic.
  const storyCoveredKeys = useMemo(() => {
    const covered = new Set<string>();
    for (const row of stories ?? []) {
      covered.add(row.fromKey);
      covered.add(row.toKey);
    }
    return covered;
  }, [stories]);
  // Per-node story COUNTS from the same already-fetched list (no new query) —
  // the Stories thread's count pill. An edge touches two nodes, so each
  // endpoint counts it once.
  const storyCountByNode = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of stories ?? []) {
      m.set(row.fromKey, (m.get(row.fromKey) ?? 0) + 1);
      m.set(row.toKey, (m.get(row.toKey) ?? 0) + 1);
    }
    return m;
  }, [stories]);
  // Launchpads are strand-level, so their coverage denominator is the domain's
  // real strands (the rail's groups, minus the null-strand "other" bucket), not
  // the per-node skill count the other modalities use.
  const domainStrandSlugs = useMemo(
    () =>
      [...new Set(strands.map((s) => s.strand).filter((s) => s !== "other"))].sort((a, b) =>
        a.localeCompare(b),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary?.nodes],
  );
  // The lifted pool handed to the unified pane / NodeItemPool so the page
  // doesn't fetch the same node twice. Passed only when it matches the
  // currently selected skill — during a selection change `selectedPool` briefly
  // still holds the previous node, so we pass `undefined` then and let the pane
  // fetch (deduped by the Convex client) until it catches up. `null` (unknown
  // node) is a resolved answer, so it passes straight through.
  const selectedPoolForNode =
    selectedPool === undefined || selectedPool === null
      ? selectedPool
      : selectedPool.node.nodeKey === selectedNode
        ? selectedPool
        : undefined;

  useEffect(() => {
    // Keeps the Instruction TAB's selected strand valid (no skill selected,
    // Instruction tab active). Inert otherwise.
    if (
      effectiveLens !== "content" ||
      selectedNode !== null ||
      tab !== "instruction"
    )
      return;
    // Don't touch the strand until the domain's strands are actually known —
    // otherwise a fresh `?strand=` URL gets nulled during the summary load
    // window (empty `domainStrandSlugs`) and never restored.
    if (summary === undefined) return;
    if (domainStrandSlugs.length === 0) {
      if (selectedStrand !== null) {
        // The loaded domain genuinely has no strands — drop a stale URL strand.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedStrand(null);
      }
      return;
    }
    if (selectedStrand && domainStrandSlugs.includes(selectedStrand)) return;
    // Default to the first strand when nothing valid is selected. Single-domain
    // only (guarded by `summary`), so the strand's domain is the page `domain`.
    setSelectedStrand(domainStrandSlugs[0]);
    if (domain) setSelectedStrandDomain(domain);
  }, [
    domainStrandSlugs,
    domain,
    effectiveLens,
    selectedNode,
    selectedStrand,
    summary,
    tab,
  ]);

  // The node-grain instructional segment for the currently selected skill, if
  // any — rendered in the unified pane's Instruction section captioned
  // skill-level. The domain-wide `instructionCoverage.nodeSegments` is now
  // METADATA ONLY (fix #7), so it only tells us WHETHER this skill has a
  // node-grain segment; the full atom stack is fetched via the keyed
  // `instructionSegmentForNode` — and ONLY for the selected skill that the
  // metadata says has one (skip otherwise), so the always-on coverage
  // subscription never carries every segment's bodies.
  const selectedNodeSegmentMeta = useMemo(
    () =>
      selectedNode
        ? instructionCoverage?.nodeSegments.find(
            (seg) => seg.nodeKey === selectedNode,
          )
        : undefined,
    [instructionCoverage, selectedNode],
  );
  const selectedNodeSegment = useQuery(
    api.instruction.instructionSegmentForNode,
    mayView &&
      effectiveLens === "content" &&
      selectedNode &&
      // Single-domain: the metadata gate avoids even the keyed fetch when the
      // skill has no node-grain segment. All-domains: the domain coverage isn't
      // loaded at page level, so fall through to the keyed read (it returns
      // null quickly for a skill with no node segment — one small node-keyed
      // read, NOT the always-on domain subscription fix #7 guards).
      (isAllDomains || selectedNodeSegmentMeta)
      ? { nodeKey: selectedNode }
      : "skip",
  );

  if (!userLoading && user && !mayView) {
    return (
      <Flex h="full" align="center" justify="center" bg="gray.50" px={6}>
        <Surface p={6} maxW="440px">
          <Text fontSize="sm" color="charcoal.600">
            Math skills is a curriculum-design surface (teachers,
            admins, and curriculum designers). Your account doesn&rsquo;t have
            access to it.
          </Text>
        </Surface>
      </Flex>
    );
  }

  // Shared by the rail's domain items and the "All domains" matrix's domain
  // labels. Numeric scholar × domain cells stay in All domains and open their
  // detail in place.
  const handleSelectDomain = (d: string) =>
    pushUrlState(() => {
      setPickedDomain(d);
      setSelectedNode(null);
      setSelectedStrand(null);
    });

  // Rail selection is ONE idiom: clicking a row SELECTS it into the right pane,
  // and skill vs. instructional-segment selection are mutually exclusive.
  // Selecting a skill clears any selected strand (the active tab persists, so
  // browsing down the rail keeps whatever tab you're reading). Selecting a
  // segment row clears the skill and opens the Instruction tab on that strand.
  // Both round-trip through the URL (node= / strand= / view=).
  const selectSkill = (nodeKey: string | null) => {
    setSelectedNode(nodeKey);
    if (nodeKey) setSelectedStrand(null);
  };
  const selectStrand = (strandDomain: string, strand: string) => {
    setSelectedNode(null);
    setSelectedStrand(strand);
    setSelectedStrandDomain(strandDomain);
    setTab("instruction");
  };

  const domainsForDisplay = (domains ?? []).map((practiceDomain) => ({
    domain: practiceDomain.domain,
    label: practiceDomain.label,
  }));
  // The domain(s) the Content lens renders across: every domain in All-domains
  // mode, else the one picked domain. Drives the rail sections + the no-skill
  // worktable sections.
  const contentDomains: { domain: string; label: string }[] = isAllDomains
    ? domainsForDisplay
    : domain
      ? [{ domain, label: summary?.domainLabel ?? domain }]
      : [];
  const contentDomainSlugs = new Set(contentDomains.map((d) => d.domain));
  const worktableStoryRows = isAllDomains
    ? (stories ?? []).filter((row) => contentDomainSlugs.has(row.fromDomain))
    : storyRows;

  return (
    <MathSkillsStudioShell
      lens={effectiveLens}
      onLensChange={(nextLens) =>
        pushUrlState(() => {
          // A deliberate lens switch drops any pending "use this kind" intent.
          if (nextLens !== "content") setPendingManipKind(null);
          if (nextLens !== "mastery" && isFastMath) {
            setPickedDomain(domainsForDisplay[0]?.domain ?? null);
          }
          setLens(nextLens);
        })
      }
      mayViewMastery={mayViewMastery}
      scopeKey={masteryScope}
      onSelectScope={(scopeKey, opts) =>
        opts?.replace
          ? setMasteryScope(scopeKey)
          : pushUrlState(() => setMasteryScope(scopeKey))
      }
      scholar={masteryScholar}
      onSelectScholar={(scholar) =>
        pushUrlState(() => setMasteryScholar(scholar))
      }
      domains={domainsForDisplay}
      selectedDomain={
        isAllDomains
          ? ALL_DOMAINS_DOMAIN
          : isFastMath
            ? FAST_MATH_DOMAIN
            : (domain ?? "")
      }
      onSelectDomain={handleSelectDomain}
    >
      {(ctx) => {
        const commonMasteryProps = {
          selectedNode,
          onSelectNode: (nodeKey: string) =>
            pushUrlState(() => selectSkill(nodeKey)),
          treeView: masteryTreeView,
          onToggleTreeView: (treeView: boolean) =>
            pushUrlState(() => setMasteryTreeView(treeView)),
          search: masterySearch,
          onSearchChange: setMasterySearch,
          statuses: masteryStatuses,
          onStatusesChange: (statuses: Set<MasteryFilterKey>) =>
            pushUrlState(() => setMasteryStatuses(statuses)),
          scopedScholars: ctx.scopedScholars,
          effectiveScholarId: ctx.effectiveScholarId,
          scopeGroupId: ctx.scopeGroupId,
          scopeGroupName: ctx.scopeGroupName,
          scopeControls: ctx.scopeControls,
          rosterLoading: ctx.rosterLoading,
          reportScholarId: reportScholar,
          onOpenReport: (scholarId: string | null) =>
            pushUrlState(() => setReportScholar(scholarId ?? "")),
          onOpenContentForNode: (nodeKey: string) =>
            pushUrlState(() => {
              setReportScholar("");
              setLens("content");
              // Cross-lens "open content" selects the skill (the unified pane
              // shows every section; its own jump strip is right there).
              selectSkill(nodeKey);
            }),
          onOpenStoriesForNode: (nodeKey: string) =>
            pushUrlState(() => {
              setReportScholar("");
              setLens("content");
              selectSkill(nodeKey);
            }),
        };
        return effectiveLens === "manipulatives" ? (
          // The Manipulative Library — a browse-first, kind-first catalog. Its
          // own idea rail replaces the domain rail (suppressed in the shell for
          // this lens), since the catalog spans every domain. "Use on a skill…"
          // hands the kind to the Content lens' node-scoped editor — no second
          // editor is built here.
          <ManipulativeLibrary
            onUseKind={(kind) =>
              pushUrlState(() => {
                setPendingManipKind(kind);
                setLens("content");
                setTab("questions");
                setFormat("hands-on");
              })
            }
          />
        ) : effectiveLens === "mastery" ? (
          isFastMath ? (
            <MathSkillsMasteryView
              domain={null}
              domainLabel="Fast math"
              fastMathView
              domains={domainsForDisplay}
              onSelectDomain={handleSelectDomain}
              nodes={[]}
              {...commonMasteryProps}
            />
          ) : isAllDomains ? (
            // "All domains": one ROW per registered domain (same set/order as
            // the left rail), one COLUMN per scholar — a real matrix, not a
            // single flat skill list (different domains' skills don't share
            // one coherent row order). See MathSkillsMasteryView's
            // `allDomains` branch.
            <MathSkillsMasteryView
              domain={null}
              domainLabel="All domains"
              allDomains
              domains={domainsForDisplay}
              onSelectDomain={handleSelectDomain}
              nodes={[]}
              {...commonMasteryProps}
            />
          ) : !domain ? (
            <Flex align="center" justify="center" gap={2} py={12} h="full">
              <Spinner size="sm" color="violet.500" />
              <Text fontSize="sm" color="charcoal.400">
                Loading skills…
              </Text>
            </Flex>
          ) : (
            <MathSkillsMasteryView
              domain={domain}
              nodesLoading={summary?.domain !== domain}
              domainLabel={
                summary?.domain === domain
                  ? summary.domainLabel
                  : (domainsForDisplay.find((entry) => entry.domain === domain)
                      ?.label ?? domain)
              }
              nodes={(summary?.domain === domain ? summary.nodes : []).map((node) => ({
                nodeKey: node.nodeKey,
                label: node.label,
                strand: node.strand,
                grade: node.grade,
              }))}
              storyCountByNode={storyCounts ?? undefined}
              {...commonMasteryProps}
            />
          )
        ) : (
          <Flex direction="column" h="full" minW={0} bg="white">
            {/* Shared control-bar strip — the SAME StudioControlBar the Mastery
                lens renders (skeleton convergence). In Content it holds the ONE
                thread bar (Questions · Instruction · Stories) that governs the
                whole surface — the rail is scoped to the active thread, and the
                pane shows it — plus the answer-format facet (Questions only) and
                the single "Show gaps" toggle. Counts, never percents (they live
                in the strand headers). */}
            <StudioControlBar testId="math-skills-content-bar">
              <ViewToggle
                items={THREAD_ORDER.map((t) => ({
                  value: t,
                  label: TAB_LABEL[t],
                }))}
                value={tab}
                onChange={(next) =>
                  pushUrlState(() => {
                    setPendingManipKind(null);
                    setTab(next as ContentSection);
                  })
                }
                ariaLabel="Content thread"
                testId="content-thread"
              />
              {/* Answer-format facet — All · Written · Hands-on. Sits immediately
                  right of the thread bar and is ALWAYS visible (never in an
                  overflow/menu) so it's discovered on the first visit — the
                  replacement for the old top-level Manipulatives thread lands in
                  the same eye-line. It only applies to the Questions thread, so
                  on the other threads it's dimmed + inert (visible, not gone). */}
              <Box
                opacity={tab === "questions" ? 1 : 0.4}
                pointerEvents={tab === "questions" ? "auto" : "none"}
                aria-hidden={tab !== "questions"}
                inert={tab !== "questions" || undefined}
                title={
                  tab === "questions"
                    ? undefined
                    : "Answer format applies to the Questions thread"
                }
                flexShrink={0}
              >
                <ViewToggle
                  items={FACET_ORDER.map((f) => ({
                    value: f,
                    label: FACET_LABEL[f],
                  }))}
                  value={format}
                  onChange={(next) =>
                    pushUrlState(() => {
                      // Leaving Hands-on deliberately drops the pending kind;
                      // choosing Hands-on keeps it so the handoff still lands.
                      if ((next as AnswerFormat) !== "hands-on") {
                        setPendingManipKind(null);
                      }
                      setFormat(next as AnswerFormat);
                    })
                  }
                  ariaLabel="Answer format"
                  testId="content-format"
                />
              </Box>
              <Box flex="1" minW={0} />
              {/* Show gaps — the single rail toggle. On reveals the skills that
                  LACK the active thread's (or facet's) content (washed amber);
                  off shows only the haves. Kept visually secondary on the right. */}
              <Checkbox.Root
                size="sm"
                checked={showGaps}
                onCheckedChange={() =>
                  pushUrlState(() => setShowGaps((cur) => !cur))
                }
                data-testid="content-gaps-toggle"
                flexShrink={0}
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="600"
                  color="charcoal.600"
                >
                  Show gaps
                </Checkbox.Label>
              </Checkbox.Root>
            </StudioControlBar>

            {/* Body — one edge-to-edge room, like Mastery's matrix: a tight
                Skills rail column (hairline separator, no floating card, no gray
                sea) meeting the detail pane that fills the rest on white.
                Switching lenses is the same room, different furniture. */}
            <Flex
              flex={1}
              minH={0}
              overflow="hidden"
              direction={{ base: "column", lg: "row" }}
            >
              {/* Skills rail — a tight bordered column flush under the control
                  bar (matches Mastery's continuous panel: dense rows, hairline
                  separators). Scoped to the active thread. */}
              <Flex
                direction="column"
                flexShrink={0}
                w={{ base: "full", lg: "300px" }}
                maxH={{ base: "40vh", lg: "none" }}
                minH={0}
                bg="white"
                borderBottomWidth={{ base: "1px", lg: "0" }}
                borderRightWidth={{ base: "0", lg: "1px" }}
                borderColor="gray.100"
              >
                {/* No rail header: the strand section bands carry the structure
                    (killed at Andy's call — the SKILLS eyebrow + count said
                    nothing the rail didn't already show). */}
                <Box flex={1} minH={0} overflowY="auto">
                  {/* One rail section per content domain (one in single-domain
                      mode, every domain in All-domains — the cross-domain browse
                      surface). Each owns its own reads + scopes to the active
                      thread. The old "All skills" row is gone: to return to the
                      no-selection worktable, click the already-active domain in
                      the Domains rail (it clears the node/strand selection). */}
                  {contentDomains.length === 0 ? (
                    <Flex align="center" gap={2} py={6} justify="center">
                      <Spinner size="sm" color="violet.500" />
                      <Text fontSize="sm" color="charcoal.400">
                        Loading skills…
                      </Text>
                    </Flex>
                  ) : (
                    contentDomains.map((d) => (
                      <RailDomainSection
                        key={d.domain}
                        domain={d.domain}
                        label={d.label}
                        showHeading={isAllDomains}
                        thread={tab}
                        format={format}
                        showGaps={showGaps}
                        storyCoveredKeys={storyCoveredKeys}
                        storyCountByNode={storyCountByNode}
                        selectedNode={selectedNode}
                        selectedStrand={selectedStrand}
                        selectedStrandDomain={selectedStrandDomain}
                        onSelectSkill={(nodeKey) =>
                          pushUrlState(() => selectSkill(nodeKey))
                        }
                        onSelectStrand={(strandDomain, strand) =>
                          pushUrlState(() => selectStrand(strandDomain, strand))
                        }
                      />
                    ))
                  )}
                </Box>
              </Flex>

              {/* Detail pane — fills the remaining width, edge-to-edge white (no
                  floating card). NO pane tabs: the top thread bar is the only
                  switch, so the pane is focused on the active thread. A skill
                  selected ⇒ that skill's content of the active thread; no skill
                  ⇒ the domain-wide worktable of that thread; a segment row
                  selected (Instruction thread) ⇒ that strand's segment detail. */}
              <Box flex={1} minW={0} minH={0} overflowY="auto" bg="white" px={{ base: 3, md: 5 }} py={{ base: 3, md: 4 }}>
                  {pendingManipKind && !selectedNode && (
                    <Box
                      role="status"
                      aria-live="polite"
                      mb={4}
                      color="charcoal.500"
                    >
                      <Text fontSize="sm" color="teal.800">
                        Hands-on mechanic ready:{" "}
                        <Text as="span" fontWeight="600" color="charcoal.700">
                          {MANIPULATIVE_KIND_LABELS[pendingManipKind]}
                        </Text>
                        {" · "}Select a skill to open the hands-on editor with it
                        preselected.
                      </Text>
                    </Box>
                  )}
                  {selectedNode && (
                    <Flex align="flex-start" justify="space-between" gap={3} mb={3}>
                      <Box minW={0}>
                        <Heading size="sm" color="navy.600">
                          {selectedPoolForNode?.node.label ??
                            summary?.nodes.find((n) => n.nodeKey === selectedNode)
                              ?.label ??
                            selectedNode}
                        </Heading>
                        {/* Grade · strand · standards row only mounts once the
                            pool resolves; render a skeleton in its place while
                            loading so the header keeps its height (no collapse /
                            jump on skill→skill). */}
                        {selectedPoolForNode ? (
                          <Flex gap={2} mt={1} align="center" wrap="wrap">
                            <Text fontSize="xs" color="charcoal.400">
                              {selectedPoolForNode.node.grade
                                ? `grade ${selectedPoolForNode.node.grade}`
                                : selectedPoolForNode.node.nodeKey}
                              {selectedPoolForNode.node.strand
                                ? ` · ${selectedPoolForNode.node.strand}`
                                : ""}
                            </Text>
                            {selectedPoolForNode.node.standardCodes.map((standard) => (
                              <Badge
                                key={`${standard.framework}-${standard.code}`}
                                colorPalette="gray"
                                variant="outline"
                                size="sm"
                              >
                                {standard.code}
                              </Badge>
                            ))}
                          </Flex>
                        ) : (
                          <SkillPaneHeaderSkeleton />
                        )}
                      </Box>
                    </Flex>
                  )}

                  {/* No pane tabs: the top thread bar is the only switch, so the
                      pane renders just the ACTIVE thread's content. On the
                      Questions thread the answer-format facet drives the pool's
                      mode (all / questions / manipulatives — the three values
                      NodeItemPool already accepts). NodeItemPool stays keyed by
                      node + facet so an open add/generate draft resets on a SKILL
                      or FACET change; switching THREADS is a deliberate context
                      change, so the previous thread's editor unmounting is
                      expected (there is no hidden tab left to preserve). */}
                  {tab === "questions" && (
                    <Box pt={1}>
                      {selectedNode ? (
                        <Box>
                          {/* Rehearse the skill's question pool AS A SCHOLAR — a
                              targeted single-skill practice run (?skill=). It
                              lives ON the Questions content it rehearses. Same
                              label / Play glyph / size as every other Rehearse. */}
                          {selectedPoolForNode &&
                            selectedPoolForNode.practiceServeable && (
                              <Flex justify="flex-end" mb={2}>
                                <Button
                                  asChild
                                  variant="ghost"
                                  size="xs"
                                  color="violet.700"
                                  fontFamily="heading"
                                  fontWeight="600"
                                  _hover={{ bg: "violet.50" }}
                                  data-testid="content-rehearse"
                                >
                                  <a
                                    href={`/scholar/practice?skill=${encodeURIComponent(selectedPoolForNode.node.nodeKey)}&rehearse=1`}
                                    target="_blank"
                                    rel="noopener"
                                  >
                                    <Play weight="fill" />
                                    Rehearse
                                  </a>
                                </Button>
                              </Flex>
                            )}
                          {/* Keyed by node + facet so an open add/generate draft
                              resets when the SKILL or the facet changes. The facet
                              drives the mode; the pool shows what the facet hides
                              as dimmed one-liners, and "Show" jumps back to All. */}
                          <NodeItemPool
                            key={`${selectedNode}-${format}`}
                            nodeKey={selectedNode}
                            mode={facetMode(format)}
                            pool={selectedPoolForNode}
                            initialManipulativeKind={
                              format === "hands-on"
                                ? (pendingManipKind ?? undefined)
                                : undefined
                            }
                            onRevealAll={() =>
                              pushUrlState(() => setFormat("all"))
                            }
                          />
                        </Box>
                      ) : (
                        <Box>
                          <Heading size="sm" color="navy.600" mb={1}>
                            {format === "hands-on"
                              ? "All hands-on items in "
                              : format === "written"
                                ? "All written questions in "
                                : "All questions in "}
                            {isAllDomains ? "every domain" : (summary?.domainLabel ?? "this domain")}
                          </Heading>
                          <Text fontSize="xs" color="charcoal.500" mb={3}>
                            {format === "hands-on"
                              ? "Every stored interactive item — select a row to open that skill."
                              : "Templates appear once; stored items appear individually."}
                          </Text>
                          {contentDomains.map((d) => (
                            <DomainItemsWorktable
                              key={d.domain}
                              domain={d.domain}
                              label={d.label}
                              mode={facetMode(format)}
                              showHeading={isAllDomains}
                              eager={!isAllDomains}
                              onSelectSkill={(nodeKey) =>
                                pushUrlState(() => selectSkill(nodeKey))
                              }
                            />
                          ))}
                        </Box>
                      )}
                    </Box>
                  )}

                  {tab === "stories" && (
                    <Box pt={1}>
                      {selectedNode ? (
                        selectedNeighbourhood === undefined ? (
                          <StoriesTabSkeleton />
                        ) : selectedNeighbourhood === null ? (
                          <EmptyState title="This skill is no longer available." />
                        ) : (
                          <NodeStoryFamily
                            key={selectedNode}
                            focalKey={selectedNode}
                            stories={selectedNeighbourhood.stories as StoryItem[]}
                            canEdit={mayView}
                          />
                        )
                      ) : (
                        <Box>
                          <Heading size="sm" color="navy.600" mb={1}>
                            All stories in{" "}
                            {isAllDomains ? "every domain" : (summary?.domainLabel ?? "this domain")}
                          </Heading>
                          <Text fontSize="xs" color="charcoal.500" mb={3}>
                            Select a row to open that skill&rsquo;s story neighbourhood.
                          </Text>
                          {stories === undefined ? (
                            <InventoryTableSkeleton columns={3} />
                          ) : worktableStoryRows.length === 0 ? (
                            <EmptyState title="No stories in this domain yet." />
                          ) : (
                            <StoryInventoryTable
                              rows={worktableStoryRows as StoryInventoryRow[]}
                              onSelect={(row) =>
                                pushUrlState(() => selectSkill(row.fromKey))
                              }
                            />
                          )}
                        </Box>
                      )}
                    </Box>
                  )}

                  {tab === "instruction" && (
                    <Box pt={1}>
                      {selectedNode ? (
                        // The skill's instruction: its strand segment (shared by
                        // every skill in the strand) + any node-grain segment
                        // authored for this specific skill.
                        <Flex direction="column" gap={4}>
                          <InstructionLaunchpadDetailPane
                            headingLabel={selectedPoolForNode?.node.strand ?? "this strand"}
                            caption="Strand-level — shared by every skill in this strand."
                            emptyTitle="This strand stays fully Socratic — no instructional segment yet."
                            launchpad={
                              selectedSkillLaunchpadResolved as
                                | InstructionLaunchpadDetail
                                | null
                                | undefined
                            }
                          />
                          {selectedNodeSegment && (
                            <InstructionLaunchpadDetailPane
                              headingLabel={
                                selectedPoolForNode?.node.label ?? selectedNode
                              }
                              caption="Skill-level — specific to this skill."
                              launchpad={{
                                key: selectedNodeSegment.key,
                                domain: selectedNodeSegment.domain,
                                strand: selectedNodeSegment.strand,
                                status: selectedNodeSegment.status,
                                provenance: selectedNodeSegment.provenance,
                                title: selectedNodeSegment.title,
                                subtitle: selectedNodeSegment.subtitle,
                                atoms: selectedNodeSegment.atoms,
                                atomKinds: selectedNodeSegment.atomKinds,
                                medium: selectedNodeSegment.medium,
                                hasWorkedExample: selectedNodeSegment.hasWorkedExample,
                                version: selectedNodeSegment.version,
                                updatedAt: selectedNodeSegment.updatedAt,
                                verifyReport: selectedNodeSegment.verifyReport,
                              }}
                            />
                          )}
                        </Flex>
                      ) : (
                        // The domain-wide instruction worktable — the strand
                        // picked in the rail's segment rows. In All-domains mode
                        // the strand carries its own domain (selectedStrandDomain),
                        // so the detail read works across domains.
                        <Box>
                          <Heading size="sm" color="navy.600" mb={1}>
                            Instructional segments in{" "}
                            {isAllDomains ? "every domain" : (summary?.domainLabel ?? "this domain")}
                          </Heading>
                          <Text fontSize="xs" color="charcoal.500" mb={3}>
                            One opt-in worked example per strand, offered the first time a
                            scholar meets it. Pick a strand&rsquo;s segment in the rail;
                            strands without an instructional segment stay fully Socratic.
                          </Text>
                          {!isAllDomains &&
                          (summary === undefined || instructionCoverage === undefined) ? (
                            <InstructionSegmentBodySkeleton />
                          ) : !isAllDomains &&
                            domainStrandSlugs.length === 0 &&
                            instructionCoverage!.strands.length === 0 ? (
                            <EmptyState title="No strands in this domain yet." />
                          ) : !selectedStrand ? (
                            <EmptyState title="Pick a strand's instructional segment in the rail." />
                          ) : (
                            <InstructionLaunchpadDetailPane
                              headingLabel={selectedStrand}
                              launchpad={
                                selectedLaunchpad as
                                  | InstructionLaunchpadDetail
                                  | null
                                  | undefined
                              }
                            />
                          )}
                        </Box>
                      )}
                    </Box>
                  )}
              </Box>
            </Flex>
          </Flex>
        );
      }}
    </MathSkillsStudioShell>
  );
}

export default function PracticePoolPage() {
  return (
    <Suspense
      fallback={
        <Flex h="full" align="center" justify="center" bg="gray.50">
          <Spinner size="lg" color="violet.500" />
        </Flex>
      }
    >
      <PracticePoolInner />
    </Suspense>
  );
}
