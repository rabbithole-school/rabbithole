"use client";

/**
 * ScholarDomainReport — the full-bleed "[Scholar]'s mastery of [Domain]" report
 * (sketch Proposal D2). The takeover DESTINATION for the header band-meter (D1):
 * where A swaps the studio's right panel in place, D2 promotes the same
 * scholar × domain body into its own focus route — Back to exit, a scholar pager
 * to page through the visible scholar set, and room for the frontier list +
 * inline evidence + "Up next" that the drawer has no space for. `domain` and
 * `scholar` are always concrete, required props (there is no "unselected
 * domain" state for this report), so its data — including the "Up next" queue
 * — always runs unconditionally.
 *
 * It reuses existing primitives only: the mastery dial + palette, the shared
 * band-count meter, `nextForScholar` (the serve-next queue), and
 * `recentAttemptsForDomain` / `recentMissesForNode` (the domain's chronological
 * practice evidence and per-skill missed-problem detail). Frontier
 * ("all the yellows") is derived from the readings already loaded by the matrix
 * — a scholar's reading whose band is `frontier`.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import {
  Badge,
  Box,
  Button,
  ButtonGroup,
  Flex,
  IconButton,
  Spinner,
  Text,
} from "@chakra-ui/react";
import {
  ArrowLeft,
  ArrowSquareOut,
  BookOpen,
  CaretDown,
  CaretLeft,
  CaretRight,
  PencilSimple,
  Target,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ScholarFocusHeader } from "@/app/teacher/(dashboard)/_components/ScholarFocusHeader";
import { KnowledgeNodeDial } from "@/components/KnowledgeNodeDial";
import { ScholarBandMeter } from "@/components/practice/ScholarBandMeter";
import { MasteryDot } from "@/components/MasteryDot";
import {
  MASTERY_FILTER_LABEL,
  MASTERY_FILTER_ORDER,
  masteryFilterKey,
  type BandCounts,
  type MasteryFilterKey,
} from "@/components/practice/mathSkillsMasteryFilters";
import type { RosterScholar } from "@/hooks/useScholarRoster";
import { RecentMissesForNode } from "@/components/practice/RecentMisses";
import { RecentPracticeFeed } from "@/components/practice/RecentPracticeFeed";
import { FactHeatmap } from "@/components/practice/FactHeatmap";
import { CalculatorLicenseCard } from "@/components/practice/CalculatorLicenseCard";
import {
  DomainMapStatusStrip,
  type DomainMapStatus,
} from "@/components/practice/DomainMapStatusStrip";
import { isFactFamilySkill } from "@/shared/factKey";

export type ReportReading = {
  nodeKey: string;
  mastery: MasteryFilterKey;
  automaticity: number;
  depth: number;
  flagged: boolean;
};

export type ReportSkillNode = {
  nodeKey: string;
  label: string;
  strand: string | null;
  grade: string | null;
};

type MapStatusResult = {
  scholars: {
    scholarId: string;
    perDomain: { domain: string; status: DomainMapStatus; blockedBy: string[] }[];
  }[];
};

function BandMark({ band, size = 16 }: { band: MasteryFilterKey; size?: number }) {
  return <MasteryDot state={band} size={size} />;
}

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
    <Box flex={1}>
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
 * One skill row that expands in place to the scholar × skill evidence — the
 * "drill into specific data points" the report exists for. The expansion mounts
 * the shared `RecentMissesForNode` (their recent missed problems on this skill)
 * so the query only runs when a row is actually opened.
 */
function ReportSkillRow({
  node,
  reading,
  scholarId,
  bandLabelFor,
  onOpenContent,
  onOpenStories,
  onDrillCell,
}: {
  node: ReportSkillNode;
  reading: ReportReading | undefined;
  scholarId: string;
  bandLabelFor: (band: MasteryFilterKey) => string;
  onOpenContent: (nodeKey: string) => void;
  onOpenStories: (nodeKey: string) => void;
  onDrillCell: (nodeKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const band: MasteryFilterKey = reading ? masteryFilterKey(reading) : "locked";
  return (
    <Box borderBottomWidth="1px" borderColor="gray.100">
      <Flex
        as="button"
        onClick={() => setOpen((v) => !v)}
        align="center"
        gap={2.5}
        py={2.5}
        px={2}
        w="100%"
        textAlign="left"
        _hover={{ bg: "gray.50" }}
        aria-expanded={open}
      >
        <BandMark band={band} />
        <Box minW={0} flex={1}>
          <Text fontSize="sm" fontWeight="600" color="charcoal.700" lineClamp={1}>
            {node.label}
          </Text>
          <Text fontSize="2xs" color="charcoal.400" lineClamp={1}>
            {bandLabelFor(band)}
            {node.grade ? ` · Grade ${node.grade}` : ""}
          </Text>
        </Box>
        {reading?.flagged && (
          <Badge colorPalette="orange" variant="subtle" size="sm">
            Check in
          </Badge>
        )}
        <Box
          color="charcoal.300"
          transform={open ? "rotate(0deg)" : "rotate(-90deg)"}
          transition="transform 0.12s"
        >
          <CaretDown size={14} />
        </Box>
      </Flex>
      {open && (
        <Box px={2} pb={3}>
          {reading ? (
            <Flex gap={4} align="flex-start" mb={3} wrap="wrap">
              <Box lineHeight={0} flexShrink={0}>
                <KnowledgeNodeDial
                  mastery={reading.mastery}
                  automaticity={reading.automaticity}
                  depth={reading.depth}
                  size={44}
                  glyphs
                />
              </Box>
              <Flex direction="column" gap={2} flex={1} minW="160px">
                <MiniGauge label="Automaticity" value={reading.automaticity} color="#43cf8e" />
                <MiniGauge label="Depth" value={reading.depth} color="#5663c6" />
              </Flex>
            </Flex>
          ) : (
            <Text fontSize="xs" color="charcoal.400" mb={3}>
              No reading yet on this skill.
            </Text>
          )}

          <RecentMissesForNode scholarId={scholarId} nodeKey={node.nodeKey} />

          <Flex gap={2} wrap="wrap" mt={1}>
            <Button
              size="2xs"
              variant="outline"
              onClick={() => onOpenContent(node.nodeKey)}
            >
              <PencilSimple size={12} /> Practice items
            </Button>
            <Button
              size="2xs"
              variant="outline"
              onClick={() => onOpenStories(node.nodeKey)}
            >
              <BookOpen size={12} /> Stories
            </Button>
            <Button
              size="2xs"
              variant="ghost"
              color="charcoal.500"
              onClick={() => onDrillCell(node.nodeKey)}
            >
              <ArrowSquareOut size={12} /> Open in matrix
            </Button>
          </Flex>
        </Box>
      )}
    </Box>
  );
}


export function ScholarDomainReport({
  scholar,
  orderedScholars,
  imageSrc,
  readings,
  bandCounts,
  domain,
  domainLabel,
  domainNodes,
  domainLabelFor,
  onStep,
  onClose,
  onOpenContent,
  onOpenStories,
  onDrillCell,
}: {
  scholar: RosterScholar;
  orderedScholars: RosterScholar[];
  imageSrc: string | null | undefined;
  readings: ReportReading[];
  bandCounts: { counts: BandCounts; total: number; engaged: number };
  domain: string;
  domainLabel: string;
  domainNodes: ReportSkillNode[];
  /** Domain key → label, for the map-status strip's `queued` blocked-by clause. */
  domainLabelFor: (key: string) => string;
  onStep: (id: string) => void;
  onClose: () => void;
  onOpenContent: (nodeKey: string) => void;
  onOpenStories: (nodeKey: string) => void;
  onDrillCell: (nodeKey: string) => void;
}) {
  // Esc closes the report (parallels the Back button + browser Back).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const readingByKey = useMemo(
    () => new Map(readings.map((r) => [r.nodeKey, r])),
    [readings],
  );

  // This scholar × this domain's check-in state, for the map-status strip + the
  // honest "not yet measured" relabel. The all-domains matrix skips its own
  // map-status query in single-domain mode, so the report fetches it directly
  // for just this scholar (same query, one id). Cast until codegen regenerates.
  const mapStatusResult = useQuery(
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
    { scholarIds: [scholar.id as Id<"users">] },
  );
  const mapStatus = useMemo(() => {
    const perDomain = mapStatusResult?.scholars[0]?.perDomain.find(
      (entry) => entry.domain === domain,
    );
    return perDomain
      ? { status: perDomain.status, blockedBy: perDomain.blockedBy }
      : undefined;
  }, [mapStatusResult, domain]);
  // Until a check-in converges, an absent reading means "never measured", not
  // "measured, at the floor" — so the empty band must not borrow the converged
  // "Not started" vocabulary (one label per meaning).
  const notConverged =
    mapStatus !== undefined && mapStatus.status !== "converged";
  const bandLabelFor = (band: MasteryFilterKey) =>
    band === "locked" && notConverged
      ? "Not yet measured"
      : MASTERY_FILTER_LABEL[band];

  // Scholar × domain are always concrete, required props here (there is no
  // "unselected domain" state for this report), so the queue always runs.
  const upNext = useQuery(api.practiceSkills.nextForScholar, {
    scholarId: scholar.id as Id<"users">,
    domain,
    limit: 5,
  });

  // Group the domain's skills by this scholar's band, frontier first (the
  // yellows are what the teacher came for), then the rest in legend order.
  const nodesByBand = useMemo(() => {
    const map = new Map<MasteryFilterKey, ReportSkillNode[]>();
    for (const node of domainNodes) {
      const reading = readingByKey.get(node.nodeKey);
      const band: MasteryFilterKey = reading ? masteryFilterKey(reading) : "locked";
      map.set(band, [...(map.get(band) ?? []), node]);
    }
    return map;
  }, [domainNodes, readingByKey]);

  const frontierNodes = nodesByBand.get("frontier") ?? [];

  // Whether this domain contains any bare-fact families — the capability that
  // the +/−/× automaticity heatmap projects. Derived from the domain's own
  // skills (not a domain-name allowlist), so a future registered fact family
  // surfaces the grid automatically. The query is already domain-scoped.
  const hasFactFamilies = useMemo(
    () => domainNodes.some((node) => isFactFamilySkill(node.nodeKey)),
    [domainNodes],
  );
  const index = orderedScholars.findIndex((s) => s.id === scholar.id);
  const total = orderedScholars.length;
  const canStep = total > 1;
  const step = (delta: number) => {
    if (!canStep || index < 0) return;
    const next = orderedScholars[(index + delta + total) % total];
    if (next) onStep(next.id);
  };

  const skillCount = domainNodes.length;

  return (
    <Box
      position="fixed"
      inset={0}
      zIndex={1400}
      bg="gray.50"
      overflowY="auto"
      data-testid="scholar-domain-report"
    >
      {/* Sticky top bar — Back + pager. The pager stays HERE rather than
          folding into ScholarFocusHeader's pager slot: it must survive
          scrolling (this report is a full-screen overlay), and the shared
          header is a normal-flow band. Making the header sticky for one
          consumer would fork the primitive; keeping the pager sticky costs
          nothing and keeps "back out" and "step sideways" together. */}
      <Flex
        position="sticky"
        top={0}
        zIndex={1}
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.200"
        px={{ base: 3, md: 5 }}
        h="52px"
        align="center"
        justify="space-between"
        gap={3}
      >
        <Button
          size="sm"
          variant="ghost"
          color="charcoal.600"
          onClick={onClose}
          _hover={{ bg: "gray.100" }}
        >
          <ArrowLeft size={16} /> Back to matrix
        </Button>
        <ButtonGroup attached size="xs" variant="outline" flexShrink={0}>
          <IconButton
            aria-label="Previous scholar"
            disabled={!canStep}
            onClick={() => step(-1)}
          >
            <CaretLeft size={14} />
          </IconButton>
          <Button
            disabled
            _disabled={{ opacity: 1, cursor: "default", color: "charcoal.600" }}
            px={2}
            fontVariantNumeric="tabular-nums"
          >
            {index + 1} of {total}
          </Button>
          <IconButton
            aria-label="Next scholar"
            disabled={!canStep}
            onClick={() => step(1)}
          >
            <CaretRight size={14} />
          </IconButton>
        </ButtonGroup>
      </Flex>

      <ScholarFocusHeader
        scholarId={scholar.id}
        name={scholar.name}
        image={imageSrc ?? scholar.image}
        dateOfBirth={scholar.dateOfBirth}
        gradeLevel={scholar.gradeLevel}
        scale="report"
        detail={
          <Text lineClamp={1}>
            Mastery of {domainLabel} · {skillCount} {skillCount === 1 ? "skill" : "skills"}
          </Text>
        }
      />

      <Box maxW="720px" mx="auto" px={{ base: 3, md: 5 }} py={5}>
        {/* Map-status strip — makes the domain's check-in state legible in the
            same survey-plot language as the matrix cell that led here. */}
        <DomainMapStatusStrip
          status={mapStatus?.status}
          blockedBy={mapStatus?.blockedBy ?? []}
          domainLabelFor={domainLabelFor}
          firstName={scholar.name.split(" ")[0] ?? scholar.name}
          hasGreenReadings={readings.some(
            (r) =>
              r.mastery === "placed" ||
              r.mastery === "fluent" ||
              r.mastery === "overlearned",
          )}
        />

        {/* Big band-mix meter (same counts as the header glance, room for the
            legend). */}
        <Box
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="xl"
          p={4}
          mb={4}
        >
          <Text
            fontSize="2xs"
            fontWeight="700"
            textTransform="uppercase"
            letterSpacing="0.04em"
            color="charcoal.400"
            mb={2}
          >
            Mix across {domainLabel}
          </Text>
          <ScholarBandMeter
            counts={bandCounts.counts}
            total={bandCounts.total}
            engaged={bandCounts.engaged}
            height={12}
            showLegend
            ariaLabelPrefix={`${scholar.name} · ${domainLabel}`}
          />
        </Box>

        {/* Up next — the real serve-next queue for this scholar × domain. */}
        <Box
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="xl"
          p={4}
          mb={4}
        >
          <Flex align="center" gap={1.5} mb={2}>
            <Target size={14} color="#5663c6" weight="bold" />
            <Text fontSize="sm" fontWeight="700" color="charcoal.700">
              Up next
            </Text>
          </Flex>
          {upNext === undefined ? (
            <Flex align="center" gap={2}>
              <Spinner size="xs" color="violet.400" />
              <Text fontSize="xs" color="charcoal.400">
                Composing the queue…
              </Text>
            </Flex>
          ) : upNext.length === 0 ? (
            <Text fontSize="xs" color="charcoal.400">
              Nothing queued — the engine has no next skill for this domain.
            </Text>
          ) : (
            <Flex direction="column" gap={0}>
              {upNext.map((row, i) => (
                <Flex
                  key={row.key}
                  align="center"
                  gap={2.5}
                  py={2}
                  borderBottomWidth={i === upNext.length - 1 ? 0 : "1px"}
                  borderColor="gray.100"
                >
                  <Flex
                    w="20px"
                    h="20px"
                    borderRadius="full"
                    bg="violet.50"
                    color="violet.600"
                    align="center"
                    justify="center"
                    fontSize="2xs"
                    fontWeight="700"
                    flexShrink={0}
                  >
                    {i + 1}
                  </Flex>
                  <Text fontSize="sm" color="charcoal.700" lineClamp={1} flex={1} minW={0}>
                    {row.label}
                  </Text>
                  <Button
                    size="2xs"
                    variant="ghost"
                    color="charcoal.400"
                    onClick={() => onDrillCell(row.key)}
                  >
                    <ArrowSquareOut size={12} />
                  </Button>
                </Flex>
              ))}
            </Flex>
          )}
        </Box>

        <RecentPracticeFeed scholarId={scholar.id} domain={domain} />

        {/* Quick-facts automaticity heatmap — the per-fact +/−/× resolution the
            fact substrate buys. Shown wherever the current domain contains a
            bare-fact family (capability-derived, not a domain-name literal); the
            component itself renders nothing until the scholar has practiced a
            bare fact. */}
        {hasFactFamilies && (
          <FactHeatmap
            scholarId={scholar.id as Id<"users">}
            domain={domain}
            scholarName={scholar.name}
          />
        )}

        {/* The durable credential beside the heatmap: a proctored paper exam
            recorded by an adult. Lives at this scholar's detail rather than a
            standing panel. */}
        {hasFactFamilies && (
          <CalculatorLicenseCard
            scholarId={scholar.id as Id<"users">}
            scholarName={scholar.name}
          />
        )}

        {/* Frontier — all the yellows, up front. */}
        {frontierNodes.length > 0 && (
          <Box mb={4}>
            <Flex align="center" gap={2} mb={1.5}>
              <BandMark band="frontier" />
              <Text fontSize="sm" fontWeight="700" color="charcoal.700">
                Practicing now — {frontierNodes.length}{" "}
                {frontierNodes.length === 1 ? "skill" : "skills"}
              </Text>
            </Flex>
            <Box
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="xl"
              overflow="hidden"
            >
              {frontierNodes.map((node) => (
                <ReportSkillRow
                  key={node.nodeKey}
                  node={node}
                  reading={readingByKey.get(node.nodeKey)}
                  scholarId={scholar.id}
                  bandLabelFor={bandLabelFor}
                  onOpenContent={onOpenContent}
                  onOpenStories={onOpenStories}
                  onDrillCell={onDrillCell}
                />
              ))}
            </Box>
          </Box>
        )}

        {/* Everything else, by band. */}
        {MASTERY_FILTER_ORDER.filter((band) => band !== "frontier").map((band) => {
          const members = nodesByBand.get(band) ?? [];
          if (members.length === 0) return null;
          return (
            <Box key={band} mb={4}>
              <Flex align="center" gap={2} mb={1.5}>
                <BandMark band={band} />
                <Text fontSize="sm" fontWeight="700" color="charcoal.700">
                  {bandLabelFor(band)} — {members.length}
                </Text>
              </Flex>
              <Box
                bg="white"
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="xl"
                overflow="hidden"
              >
                {members.map((node) => (
                  <ReportSkillRow
                    key={node.nodeKey}
                    node={node}
                    reading={readingByKey.get(node.nodeKey)}
                    scholarId={scholar.id}
                    bandLabelFor={bandLabelFor}
                    onOpenContent={onOpenContent}
                    onOpenStories={onOpenStories}
                    onDrillCell={onDrillCell}
                  />
                ))}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
