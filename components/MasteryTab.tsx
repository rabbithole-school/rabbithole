"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  VStack,
  HStack,
  Text,
  Badge,
  Spinner,
  Button,
  Textarea,
  Menu,
  Portal,
} from "@chakra-ui/react";
import { Funnel, Star, Diamond, Lightbulb, CaretDown, CaretRight, PencilSimple, X, Check, ArrowCounterClockwise } from "@phosphor-icons/react";
import { formatTimeAgo } from "@/lib/relativeTime";
import { bloomLabel, bloomColor } from "@/lib/bloom";
import { evidenceExcerptLabel } from "@/lib/masteryProvenance";
import { fluencyTitleLabel } from "@/shared/masteryLexicon";

// Row marker icons share the domain-header chevron's size (16) so concept
// labels line up on one gridline regardless of which marker a row has.
const MARKER_SIZE = 16;

interface MasteryTabProps {
  scholarId: string;
}

// ─── Misconception helpers + palette ────────────────────────────────
// A misconception is a confidently-held WRONG belief — not a low point on the
// mastery ladder. We render it distinctly so a teacher never confuses "believes
// something false" with "hasn't learned this yet" — but gently (a soft
// grayish-pink), so it reads as a note worth attention, NOT a system error.

function isMisconception(o: { evidenceType?: string }): boolean {
  return o.evidenceType === "misconception_signal";
}

function isAddressed(o: { misconceptionStatus?: string }): boolean {
  return o.misconceptionStatus === "addressed";
}

// The "misconception" tag already labels the row, so a "Misconception:" prefix
// on the concept label is redundant — strip it (and re-capitalize the remainder).
function stripMcPrefix(label: string): string {
  const s = label.replace(/^\s*misconceptions?\s*[:\-–—]\s*/i, "");
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : label;
}
function displayLabel(o: { conceptLabel: string; evidenceType?: string }): string {
  return isMisconception(o) ? stripMcPrefix(o.conceptLabel) : o.conceptLabel;
}

// Muted grayish-pink (misconception) + soft sage (addressed). Explicit hex —
// Chakra's default red/green tokens are too loud for this.
const MC = {
  text: "#9c7782", // muted mauve
  badgeBg: "#f3e9ec",
  badgeColor: "#8f6f78",
  bannerBg: "#f9f3f5",
  bannerBorder: "#ecdde2",
};
const DONE = { badgeBg: "#eaefe6", badgeColor: "#6f7d5f" }; // soft sage

// ─── Observation flavors (filter) ───────────────────────────────────

type Flavor = "misconception" | "mastery" | "interest";
const FLAVOR_LABEL: Record<Flavor, string> = {
  misconception: "Misconceptions",
  mastery: "Mastery",
  interest: "Interests",
};
const FLAVOR_ORDER: Flavor[] = ["mastery", "misconception", "interest"];

function flavorOf(o: { evidenceType?: string }): Flavor {
  if (o.evidenceType === "misconception_signal") return "misconception";
  if (o.evidenceType === "interest_signal") return "interest";
  return "mastery"; // direct_demonstration | indirect_inference
}

// ─── Bloom's helpers ────────────────────────────────────────────────
// bloomLabel / bloomColor live in @/lib/bloom (shared with the Knowledge
// Tree drill-down so depth reads the same colour on every surface).

// Automaticity (fluency) ladder — the orthogonal "how effortless" axis;
// words live in @/shared/masteryLexicon (fluencyTitleLabel).

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

// timeAgo dropped — use formatTimeAgo from lib/relativeTime

function isStale(timestamp: number): boolean {
  return Date.now() - timestamp > SIX_MONTHS_MS;
}

// ─── Concept Detail Panel (inline expand) ───────────────────────────

export function ConceptDetail({
  scholarId,
  conceptLabel,
  standardId,
  observationId,
  title,
  onClose,
}: {
  scholarId: string;
  /** Concept-keyed (the Mastery list). */
  conceptLabel?: string;
  /** Standard-keyed (a Knowledge Tree node). */
  standardId?: string;
  /** Observation-keyed (a feed row / a ?obs= deep link). */
  observationId?: string;
  /** Optional display title (the Tree node uses its plain-language understanding). */
  title?: string;
  onClose: () => void;
}) {
  const detailByConcept = useQuery(
    api.masteryObservations.inspectConcept,
    conceptLabel ? { scholarId: scholarId as Id<"users">, conceptLabel } : "skip",
  );
  const detailByStandard = useQuery(
    api.masteryObservations.inspectStandard,
    standardId
      ? { scholarId: scholarId as Id<"users">, standardId: standardId as Id<"standards"> }
      : "skip",
  );
  const detailByObservation = useQuery(
    api.masteryObservations.inspectByObservation,
    observationId
      ? { observationId: observationId as Id<"masteryObservations"> }
      : "skip",
  );
  const detail = conceptLabel
    ? detailByConcept
    : standardId
      ? detailByStandard
      : detailByObservation;
  const setOverride = useMutation(api.teacherMasteryOverrides.setOverride);
  const removeOverride = useMutation(api.teacherMasteryOverrides.removeOverride);
  const setFluency = useMutation(api.masteryObservations.setFluency);

  const [overrideMode, setOverrideMode] = useState(false);
  const [overrideLevel, setOverrideLevel] = useState("");
  const [overrideNotes, setOverrideNotes] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  if (!detail) {
    return (
      <Flex py={4} justify="center">
        <Spinner size="sm" color="violet.500" />
      </Flex>
    );
  }

  const { observations, teacherOverride } = detail;
  const current = observations.find((o) => !o.isSuperseded);
  const displayTitle = title ?? conceptLabel ?? current?.conceptLabel ?? "";

  const handleSetFluency = async (level: 1 | 2 | 3 | null) => {
    if (!current) return;
    try {
      await setFluency({
        observationId: current._id as Id<"masteryObservations">,
        fluencyLevel: level,
      });
    } catch (err) {
      console.error("Error setting fluency:", err);
    }
  };

  const handleSaveOverride = async () => {
    if (!current || !overrideLevel) return;
    setIsSaving(true);
    try {
      await setOverride({
        observationId: current._id as Id<"masteryObservations">,
        masteryLevel: parseFloat(overrideLevel),
        notes: overrideNotes,
      });
      setOverrideMode(false);
    } catch (err) {
      console.error("Error saving override:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveOverride = async () => {
    if (!current) return;
    try {
      await removeOverride({
        observationId: current._id as Id<"masteryObservations">,
      });
    } catch (err) {
      console.error("Error removing override:", err);
    }
  };

  return (
    <Box bg="gray.50" borderRadius="md" p={4} mt={2} mb={1}>
      {/* Header */}
      <HStack justify="space-between" mb={3}>
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
          {current && isMisconception(current) ? stripMcPrefix(displayTitle) : displayTitle}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.400"
          onClick={onClose}
          _hover={{ color: "charcoal.600" }}
        >
          <X />
        </Button>
      </HStack>

      {/* Misconception banner + resolution (when this concept is a misconception) */}
      {current && isMisconception(current) && (
        <Box bg={MC.bannerBg} borderWidth="1px" borderColor={MC.bannerBorder} borderRadius="md" p={3} mb={3}>
          <Text fontSize="xs" fontWeight="600" color={MC.badgeColor} fontFamily="heading">
            {isAddressed(current)
              ? "Misconception — addressed"
              : "Misconception — worth revisiting (un-teaching, not first-teaching)"}
          </Text>
          <MisconceptionActions
            observationId={current._id}
            status={current.misconceptionStatus}
            note={current.misconceptionNote}
          />
        </Box>
      )}

      {/* Current assessment */}
      {current && (
        <Box mb={3}>
          <HStack gap={2} mb={2}>
            <Badge
              bg={`${bloomColor(teacherOverride ? teacherOverride.masteryLevel : current.masteryLevel)}.100`}
              color={`${bloomColor(teacherOverride ? teacherOverride.masteryLevel : current.masteryLevel)}.700`}
              fontSize="xs"
            >
              {bloomLabel(teacherOverride ? teacherOverride.masteryLevel : current.masteryLevel)}{" "}
              ({(teacherOverride ? teacherOverride.masteryLevel : current.masteryLevel).toFixed(1)})
            </Badge>
            <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
              conf {(current.confidenceScore * 100).toFixed(0)}%
            </Text>
            <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
              {formatTimeAgo(current.observedAt)}
            </Text>
            {current.studentInitiated && (
              <Badge bg="teal.50" color="teal.600" fontSize="xs">student-initiated</Badge>
            )}
          </HStack>

          {/* Evidence summary */}
          <Text fontSize="sm" color="charcoal.600" fontFamily="body" lineHeight="1.5" mb={2}>
            {current.evidenceSummary}
          </Text>

          {/* Evidence excerpt */}
          {current.transcriptExcerpt && (
            <Box bg="white" borderWidth="1px" borderColor="violet.200" pl={3} py={2} borderRadius="sm" mb={2}>
              <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>
                {evidenceExcerptLabel(current)}
              </Text>
              <Text fontSize="xs" color="charcoal.500" fontFamily="body" lineHeight="1.4" whiteSpace="pre-wrap">
                {current.transcriptExcerpt}
              </Text>
            </Box>
          )}

          {/* Teacher override display */}
          {teacherOverride && (
            <Box bg="orange.50" borderRadius="md" p={2} mb={2}>
              <HStack justify="space-between">
                <HStack gap={2}>
                  <Text fontSize="xs" fontWeight="600" color="orange.700" fontFamily="heading">
                    Teacher override: {bloomLabel(teacherOverride.masteryLevel)} ({teacherOverride.masteryLevel.toFixed(1)})
                  </Text>
                </HStack>
                <Button
                  size="xs"
                  variant="ghost"
                  color="orange.600"
                  _hover={{ bg: "orange.100" }}
                  onClick={handleRemoveOverride}
                >
                  Remove
                </Button>
              </HStack>
              {teacherOverride.notes && (
                <Text fontSize="xs" color="orange.600" fontFamily="body" mt={1}>
                  {teacherOverride.notes}
                </Text>
              )}
            </Box>
          )}

          {/* Override action */}
          {!overrideMode ? (
            <Button
              size="xs"
              variant="ghost"
              color="charcoal.400"
              fontFamily="heading"
              _hover={{ color: "violet.500", bg: "violet.50" }}
              onClick={() => {
                setOverrideLevel(
                  (teacherOverride ? teacherOverride.masteryLevel : current.masteryLevel).toFixed(1)
                );
                setOverrideNotes(teacherOverride?.notes ?? "");
                setOverrideMode(true);
              }}
            >
              <PencilSimple style={{ marginRight: "4px" }} />
              {teacherOverride ? "Edit override" : "Override level"}
            </Button>
          ) : (
            <Box bg="white" borderRadius="md" p={3} border="1px solid" borderColor="violet.200">
              <HStack gap={2} mb={2}>
                <Text fontSize="xs" fontFamily="heading" color="charcoal.500" flexShrink={0}>
                  Level:
                </Text>
                <select
                  value={overrideLevel}
                  onChange={(e) => setOverrideLevel(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "4px",
                    border: "1px solid #e2e8f0",
                    fontSize: "12px",
                    fontFamily: "inherit",
                    width: "180px",
                  }}
                >
                  <option value="0">0 - No Evidence</option>
                  <option value="1">1 - Remember</option>
                  <option value="1.5">1.5</option>
                  <option value="2">2 - Understand</option>
                  <option value="2.5">2.5</option>
                  <option value="3">3 - Apply</option>
                  <option value="3.5">3.5</option>
                  <option value="4">4 - Analyze</option>
                  <option value="4.5">4.5</option>
                  <option value="5">5 - Create</option>
                </select>
              </HStack>
              <Textarea
                size="sm"
                placeholder="Why do you disagree?"
                value={overrideNotes}
                onChange={(e) => setOverrideNotes(e.target.value)}
                rows={2}
                bg="gray.50"
                fontFamily="body"
                fontSize="xs"
                mb={2}
              />
              <HStack gap={2}>
                <Button
                  size="xs"
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  onClick={handleSaveOverride}
                  disabled={isSaving || !overrideLevel}
                >
                  Save
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => setOverrideMode(false)}
                >
                  Cancel
                </Button>
              </HStack>
            </Box>
          )}

          {/* Automaticity (fluency) — the teacher's highest-trust reading of
              "how effortless", the orthogonal axis the Bloom level can't carry.
              Explicit teacher input only, never inferred; timestamped so it can
              age out. 1 = effortful, 2 = fluent, 3 = automatic. */}
          <Box mt={3} data-testid="fluency-control">
            <Text fontSize="xs" fontFamily="heading" color="charcoal.400" mb={1}>
              Automaticity
              {current.fluencyLevel
                ? ` · ${fluencyTitleLabel(current.fluencyLevel) ?? current.fluencyLevel}${
                    current.fluencySource ? ` (${current.fluencySource})` : ""
                  }`
                : " · not set"}
            </Text>
            <HStack gap={1}>
              {([1, 2, 3] as const).map((lvl) => {
                const active = current.fluencyLevel === lvl;
                return (
                  <Button
                    key={lvl}
                    size="xs"
                    variant={active ? "solid" : "outline"}
                    colorPalette="teal"
                    fontFamily="heading"
                    data-testid={`fluency-set-${lvl}`}
                    data-active={active ? "true" : "false"}
                    onClick={() => handleSetFluency(active ? null : lvl)}
                  >
                    {fluencyTitleLabel(lvl)}
                  </Button>
                );
              })}
              {current.fluencyLevel ? (
                <Button
                  size="xs"
                  variant="ghost"
                  color="charcoal.400"
                  fontFamily="heading"
                  data-testid="fluency-clear"
                  onClick={() => handleSetFluency(null)}
                >
                  Clear
                </Button>
              ) : null}
            </HStack>
          </Box>
        </Box>
      )}
      {/* Observation history (if multiple versions) */}
      {observations.length > 1 && (
        <Box mt={2} pt={2} borderTop="1px solid" borderColor="gray.200">
          <Text fontSize="xs" fontWeight="600" fontFamily="heading" color="charcoal.400" mb={2}>
            History ({observations.length} observations)
          </Text>
          <VStack gap={1} align="stretch">
            {observations.map((o) => (
              <HStack
                key={o._id}
                gap={2}
                opacity={o.isSuperseded ? 0.5 : 1}
                py={1}
              >
                <Badge
                  bg={`${bloomColor(o.masteryLevel)}.100`}
                  color={`${bloomColor(o.masteryLevel)}.700`}
                  fontSize="2xs"
                >
                  {bloomLabel(o.masteryLevel)} ({o.masteryLevel.toFixed(1)})
                </Badge>
                <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
                  {formatTimeAgo(o.observedAt)}
                </Text>
                <Text fontSize="xs" color="charcoal.400" fontFamily="body" truncate flex={1}>
                  {o.evidenceSummary}
                </Text>
                {o.isSuperseded && (
                  <Badge bg="gray.100" color="gray.500" fontSize="2xs">superseded</Badge>
                )}
              </HStack>
            ))}
          </VStack>
        </Box>
      )}
    </Box>
  );
}

// ─── Bloom's Bar ────────────────────────────────────────────────────

function BloomBar({ level, maxLevel = 5 }: { level: number; maxLevel?: number }) {
  const pct = Math.min((level / maxLevel) * 100, 100);
  const color = bloomColor(level);
  return (
    <Box w="60px" h="6px" bg="gray.100" borderRadius="full" overflow="hidden" flexShrink={0}>
      <Box h="full" w={`${pct}%`} bg={`${color}.400`} borderRadius="full" />
    </Box>
  );
}

// ─── Misconception resolution control ───────────────────────────────

function MisconceptionActions({
  observationId,
  status,
  note,
}: {
  observationId: string;
  status: string | undefined;
  note: string | undefined;
}) {
  const setStatus = useMutation(api.masteryObservations.setMisconceptionStatus);
  const addressed = status === "addressed";
  const [editing, setEditing] = useState(false);
  const [noteText, setNoteText] = useState(note ?? "");
  const [saving, setSaving] = useState(false);

  const save = async (next: "open" | "addressed") => {
    setSaving(true);
    try {
      await setStatus({
        observationId: observationId as Id<"masteryObservations">,
        status: next,
        note: next === "addressed" ? noteText.trim() || undefined : undefined,
      });
      setEditing(false);
    } catch (err) {
      console.error("Error setting misconception status:", err);
    } finally {
      setSaving(false);
    }
  };

  if (addressed) {
    return (
      <HStack gap={2} mt={1}>
        <Badge bg={DONE.badgeBg} color={DONE.badgeColor} fontSize="2xs">
          <Check style={{ marginRight: 2 }} /> addressed
        </Badge>
        {note && (
          <Text fontSize="xs" color="charcoal.500" fontFamily="body" truncate>
            {note}
          </Text>
        )}
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.400"
          fontFamily="heading"
          _hover={{ color: "orange.600", bg: "orange.50" }}
          onClick={() => save("open")}
          disabled={saving}
        >
          <ArrowCounterClockwise style={{ marginRight: 4 }} /> Reopen
        </Button>
      </HStack>
    );
  }

  if (editing) {
    return (
      <Box mt={2}>
        <Textarea
          size="sm"
          placeholder="How was it addressed? (optional — e.g. 're-taught with the bowling-ball demo')"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          rows={2}
          bg="white"
          fontFamily="body"
          fontSize="xs"
          mb={2}
        />
        <HStack gap={2}>
          <Button
            size="xs"
            bg="green.500"
            color="white"
            _hover={{ bg: "green.600" }}
            fontFamily="heading"
            onClick={() => save("addressed")}
            disabled={saving}
          >
            <Check style={{ marginRight: 4 }} /> Mark addressed
          </Button>
          <Button
            size="xs"
            variant="ghost"
            fontFamily="heading"
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </HStack>
      </Box>
    );
  }

  return (
    <Button
      size="xs"
      variant="ghost"
      color="charcoal.400"
      fontFamily="heading"
      mt={1}
      _hover={{ color: "green.600", bg: "green.50" }}
      onClick={() => setEditing(true)}
    >
      <Check style={{ marginRight: 4 }} /> Mark addressed
    </Button>
  );
}

// ─── Flavor filter (show/hide misconceptions, mastery, interests) ────

function FlavorFilter({
  available,
  hidden,
  onToggle,
}: {
  available: Flavor[];
  hidden: Set<Flavor>;
  onToggle: (f: Flavor) => void;
}) {
  if (available.length < 2) return null;
  const shown = available.length - available.filter((f) => hidden.has(f)).length;
  const label =
    shown === available.length ? "All observations" : `${shown} of ${available.length} shown`;

  return (
    <Menu.Root closeOnSelect={false} positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.500"
          _hover={{ bg: "gray.100" }}
          aria-label="Filter observations"
        >
          <HStack gap={1.5}>
            <Funnel size={12} weight="regular" />
            <Text fontFamily="heading" fontSize="xs" fontWeight="600">
              {label}
            </Text>
            <CaretDown size={12} />
          </HStack>
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="200px">
            {available.map((f) => (
              <Menu.Item key={f} value={f} cursor="pointer" onClick={() => onToggle(f)}>
                <HStack gap={2} justify="space-between" w="full">
                  <Text>{FLAVOR_LABEL[f]}</Text>
                  <Text color="violet.600" fontSize="2xs" opacity={hidden.has(f) ? 0 : 1}>
                    ✓
                  </Text>
                </HStack>
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function MasteryTab({ scholarId }: MasteryTabProps) {
  const masteryByDomain = useQuery(api.masteryObservations.byScholarDomain, {
    scholarId: scholarId as Id<"users">,
  });

  const [expandedConcept, setExpandedConcept] = useState<string | null>(null);
  const [collapsedDomains, setCollapsedDomains] = useState<Set<string>>(new Set());
  const [hiddenFlavors, setHiddenFlavors] = useState<Set<Flavor>>(new Set());

  const toggleFlavor = (f: Flavor) => {
    setHiddenFlavors((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const toggleDomain = (domain: string) => {
    setCollapsedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  type MasteryDomains = NonNullable<typeof masteryByDomain>;
  const { availableFlavors, sortedDomains } = useMemo(() => {
    if (masteryByDomain === undefined) {
      return {
        availableFlavors: [] as Flavor[],
        sortedDomains: [] as Array<readonly [string, MasteryDomains[string]]>,
      };
    }

    const allObs = Object.values(masteryByDomain).flat();
    const availableFlavors = FLAVOR_ORDER.filter((f) =>
      allObs.some((o) => flavorOf(o) === f),
    );
    const sortedDomains = Object.entries(masteryByDomain)
      .map(([domain, obs]) => {
        const observations = obs
          .filter((o) => !hiddenFlavors.has(flavorOf(o)))
          .sort((a, b) => b.masteryLevel - a.masteryLevel);
        return [domain, observations] as const;
      })
      .filter(([, observations]) => observations.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));

    return { availableFlavors, sortedDomains };
  }, [hiddenFlavors, masteryByDomain]);

  if (masteryByDomain === undefined) {
    return (
      <Flex justify="center" py={8}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  if (Object.keys(masteryByDomain).length === 0) {
    return (
      <Text fontSize="sm" color="charcoal.300" fontFamily="heading" textAlign="center" py={8}>
        No mastery observations yet. These appear as the scholar works — tutor sessions, game rounds, scanned work, and reflections.
      </Text>
    );
  }

  return (
    <VStack gap={3} align="stretch" maxW="900px">
      <Flex justify="flex-end" align="center" minH="24px">
        <FlavorFilter
          available={availableFlavors}
          hidden={hiddenFlavors}
          onToggle={toggleFlavor}
        />
      </Flex>

      {sortedDomains.length === 0 && (
        <Text fontSize="sm" color="charcoal.300" fontFamily="heading" textAlign="center" py={6}>
          Nothing matches this filter.
        </Text>
      )}

      {sortedDomains.map(([domain, observations]) => {
        const isCollapsed = collapsedDomains.has(domain);

        return (
          <Box key={domain} bg="white" borderRadius="lg" shadow="xs" overflow="hidden">
            {/* Domain header */}
            <HStack
              px={4}
              py={3}
              cursor="pointer"
              _hover={{ bg: "gray.50" }}
              onClick={() => toggleDomain(domain)}
              justify="space-between"
            >
              <HStack gap={2}>
                {isCollapsed ? (
                  <CaretRight color="#666" size={MARKER_SIZE} />
                ) : (
                  <CaretDown color="#666" size={MARKER_SIZE} />
                )}
                <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
                  {domain}
                </Text>
              </HStack>
              <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
                {observations.length} concept{observations.length !== 1 ? "s" : ""}
              </Text>
            </HStack>

            {/* Concepts list */}
            {!isCollapsed && (
              <VStack gap={0} align="stretch" px={4} pb={3}>
                {observations.map((o) => {
                  const isExpanded = expandedConcept === o.conceptLabel;
                  const stale = isStale(o.observedAt);
                  const misconception = isMisconception(o);
                  const addressed = isAddressed(o);
                  return (
                    <Box key={o._id}>
                      <HStack
                        gap={3}
                        py={2}
                        cursor="pointer"
                        _hover={{ bg: "gray.50" }}
                        borderRadius="md"
                        px={2}
                        mx={-2}
                        opacity={stale ? 0.55 : 1}
                        onClick={() =>
                          setExpandedConcept(isExpanded ? null : o.conceptLabel)
                        }
                      >
                        {misconception ? (
                          <Lightbulb size={MARKER_SIZE} weight="fill" color={MC.text} style={{ flexShrink: 0 }} />
                        ) : o.studentInitiated ? (
                          <Star size={MARKER_SIZE} weight="fill" color="#2C7A7B" style={{ flexShrink: 0 }} />
                        ) : (
                          <Diamond size={MARKER_SIZE} weight="fill" color="#94A3B8" style={{ flexShrink: 0 }} />
                        )}
                        <Text
                          fontSize="sm"
                          color={
                            misconception
                              ? MC.text
                              : o.studentInitiated
                                ? "teal.600"
                                : "charcoal.600"
                          }
                          fontWeight="500"
                          fontFamily="heading"
                          flex={1}
                          minW={0}
                        >
                          {displayLabel(o)}
                        </Text>
                        {misconception ? (
                          // A misconception is a wrong belief, not a Bloom level —
                          // render it distinctly (gentle grayish-pink, not an
                          // alarm), never as "Remember (1.0) mastery".
                          <Badge
                            bg={addressed ? DONE.badgeBg : MC.badgeBg}
                            color={addressed ? DONE.badgeColor : MC.badgeColor}
                            fontSize="xs"
                            flexShrink={0}
                            minW="90px"
                            textAlign="center"
                          >
                            {addressed ? "✓ Addressed" : "Misconception"}
                          </Badge>
                        ) : (
                          <>
                            <BloomBar level={o.masteryLevel} />
                            <Badge
                              bg={`${bloomColor(o.masteryLevel)}.100`}
                              color={`${bloomColor(o.masteryLevel)}.700`}
                              fontSize="xs"
                              flexShrink={0}
                              minW="90px"
                              textAlign="center"
                            >
                              {bloomLabel(o.masteryLevel)} ({o.masteryLevel.toFixed(1)})
                            </Badge>
                          </>
                        )}
                        {stale && (
                          <Badge bg="gray.100" color="gray.500" fontSize="2xs" flexShrink={0}>
                            stale
                          </Badge>
                        )}
                        <Text
                          fontSize="xs"
                          color="charcoal.400"
                          fontFamily="heading"
                          flexShrink={0}
                          w="40px"
                          textAlign="right"
                        >
                          {(o.confidenceScore * 100).toFixed(0)}%
                        </Text>
                      </HStack>

                      {/* Expanded detail panel */}
                      {isExpanded && (
                        <ConceptDetail
                          scholarId={scholarId}
                          conceptLabel={o.conceptLabel}
                          onClose={() => setExpandedConcept(null)}
                        />
                      )}
                    </Box>
                  );
                })}
              </VStack>
            )}
          </Box>
        );
      })}
    </VStack>
  );
}
