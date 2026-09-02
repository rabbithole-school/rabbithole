"use client";

/**
 * ManipulativeLibrary — the browse-first catalog of manipulative mechanics, the
 * THIRD lens of the Math Skills studio (Mastery · Content · Manipulatives).
 *
 * The job, in Andy's words: "currently it's hard to preview the various
 * manipulative types because they all have different json schemas — make sure
 * when browsing the manipulatives it's easy." So browsing here involves ZERO
 * raw JSON: every one of the fifteen kinds is a LIVE, PLAYABLE canonical
 * example rendered through the ONE canonical `<Manipulative>` — no second
 * dispatcher is minted (this file imports it; it never re-switches on kind).
 *
 * Two views:
 *   - the GRID: one card per kind (a live example + name + one-line blurb +
 *     provenance), grouped in a left rail by idea (Number sense / Fractions /
 *     Multiplication / Geometry / Chance and data);
 *   - a KIND page, reached by the card's Rehearse: the large live example —
 *     which IS the rehearsal, interactive and writing nothing — plus the
 *     plain-language "what you can change" SENTENCE (never the schema), a
 *     collapsed "Show spec JSON" disclosure (the escape hatch, never the browse
 *     path), "Where it's used", and "Use on a skill…" which hands off to the
 *     existing node-scoped editor.
 *
 * Deliberately NOT here (later PR): Tier-3 generated sliders (a per-kind field
 * manifest). Kind usage — the "In use / Never used" rail rows, a per-card usage
 * count, and each kind's "Where it's used" list — is wired here, reading the
 * `manipulativeKindUsage` cross-reference (the one signal no surface could
 * answer before: which mechanics have items and which have none). This is
 * Tiers 1–2 plus usage: live example + prose + scoreboard.
 *
 * The catalog is code-owned and derived from the closed `ManipulativeKind`
 * union (`components/manipulative/catalog.ts`), so a new kind cannot ship
 * unlisted.
 */

import { useLayoutEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Collapsible,
  Flex,
  Heading,
  SimpleGrid,
  Text,
} from "@chakra-ui/react";
import { CaretRight, PencilSimple, Play } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Manipulative } from "@/components/manipulative/Manipulative";
import { ThemeIconAdmin } from "@/components/manipulative/ThemeIconAdmin";
import {
  EXAMPLE_BY_KIND,
  MANIPULATIVE_CATALOG,
  MANIPULATIVE_GROUP_ORDER,
  MANIPULATIVE_KIND_LABELS,
  MANIPULATIVE_KINDS,
  exampleSpecJson,
  type ManipulativeGroup,
} from "@/components/manipulative/catalog";
import type { ManipulativeKind, ManipulativeSpec } from "@/lib/manipulative/types";

/** One kind's usage row from `manipulativeKindUsage`, keyed for O(1) lookup. */
type KindUsage = {
  itemCount: number;
  skillCount: number;
  skills: { skillKey: string; label: string; count: number }[];
};

/** "N item(s) · M skill(s)" — the per-kind provenance line, or the red
 *  "never used" mark when a mechanic has no items yet (the whole point of the
 *  scoreboard: the four unauthored mechanics must be visually distinct). */
function usageSummary(usage: KindUsage): string {
  const items = `${usage.itemCount} item${usage.itemCount === 1 ? "" : "s"}`;
  const skills = `${usage.skillCount} skill${usage.skillCount === 1 ? "" : "s"}`;
  return `${items} · ${skills}`;
}

/** The left-rail selection: the whole catalog, one idea group, an in-use /
 *  never-used usage filter, or the staff "Theme assets" section. */
type LibrarySelection =
  | { kind: "all" }
  | { kind: "inUse" }
  | { kind: "neverUsed" }
  | { kind: "group"; group: ManipulativeGroup }
  | { kind: "staff" };

/** Kinds in an idea group, preserving the catalog's picker order. */
function kindsInGroup(group: ManipulativeGroup): ManipulativeKind[] {
  return MANIPULATIVE_KINDS.filter(
    (k) => MANIPULATIVE_CATALOG[k].group === group,
  );
}

/** The prototype mark — rendered ONLY when a mechanic is not production.
 *
 *  Every kind in the union is production today, so a pill that also fired on
 *  the production branch would print the identical words on all fifteen cards:
 *  a glyph encoding no variable, which is decoration (T2). "These ship with
 *  Rabbithole" is a property of the whole catalog, not of a card, so it is said
 *  once in the lens subtitle instead. The `production` flag stays in the
 *  catalog type — it is what makes a future promotion (whatever prototype next
 *  earns its own kind) a decision the author cannot skip. */
function PrototypeMark({ kind }: { kind: ManipulativeKind }) {
  if (MANIPULATIVE_CATALOG[kind].production) return null;
  return (
    <Badge
      size="sm"
      variant="subtle"
      colorPalette="orange"
      data-testid="manip-prototype"
    >
      Prototype
    </Badge>
  );
}

// ── one grid card ──────────────────────────────────────────────────────────

function KindCard({
  kind,
  usage,
  onOpen,
}: {
  kind: ManipulativeKind;
  usage?: KindUsage;
  onOpen: () => void;
}) {
  const spec = EXAMPLE_BY_KIND.get(kind);
  const entry = MANIPULATIVE_CATALOG[kind];
  const neverUsed = usage !== undefined && usage.itemCount === 0;
  return (
    <Flex
      direction="column"
      gap={3}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="16px"
      bg="white"
      p={4}
      data-testid={`manip-card-${kind}`}
    >
      <Flex align="baseline" justify="space-between" gap={2}>
        <Heading size="sm" color="navy.600">
          {MANIPULATIVE_KIND_LABELS[kind]}
        </Heading>
        <PrototypeMark kind={kind} />
      </Flex>
      <Text fontSize="sm" color="charcoal.600" lineHeight="1.5">
        {entry.blurb}
      </Text>
      {/* The live canonical example — you browse by SEEING the real thing, not
          by reading a schema. Same renderer a scholar gets, shown at roughly
          half scale inside a fixed-height window.

          Why scaled: a manipulative renders at scholar stage size (~450px
          tall), so fifteen at full size is ~10,000px of scrolling and a card
          per viewport — you could never see two mechanics at once, which is the
          one job this grid has. Scaling keeps the card RECOGNISABLE at a glance
          and fits several per screen; the kind page below is where it renders
          full size and is meant to be played.

          It renders the REAL component (not a screenshot, so it can never drift
          from the mechanic) but is deliberately inert here: a half-scale drag
          target is bad ergonomics and would compete with the card's own Open
          affordance. Playing happens one click away, at full size. */}
      {spec && <ManipulativePreview spec={spec} kind={kind} />}
      {usage !== undefined && (
        <Text
          fontSize="xs"
          fontWeight={neverUsed ? "600" : "400"}
          color={neverUsed ? "red.600" : "charcoal.500"}
          data-testid={`manip-card-usage-${kind}`}
        >
          {neverUsed ? "0 items · never used" : usageSummary(usage)}
        </Text>
      )}
      <Button
        size="xs"
        variant="outline"
        colorPalette="violet"
        alignSelf="flex-start"
        onClick={onOpen}
        aria-label={`Rehearse ${MANIPULATIVE_KIND_LABELS[kind]}`}
        data-testid={`manip-card-open-${kind}`}
      >
        {/* "Rehearse", not "Open …" — the page this opens leads with the same
            full-size, live, ungraded example every other Rehearse in the app
            gives you, so naming it after the mechanic ("Open number line") both
            undersold it and implied the card's own inert preview was the only
            way to see it. Same Play glyph + word as the Rehearse on a stored
            item, because it is the same promise. The caret stays: this
            navigates rather than opening a modal. */}
        <Play weight="fill" /> Rehearse
        <CaretRight weight="bold" />
      </Button>
    </Flex>
  );
}

/** Keep the catalog's fixed window while fitting unusually tall mechanics. */
function ManipulativePreview({ spec, kind }: { spec: ManipulativeSpec; kind: ManipulativeKind }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => {
      const height = element.scrollHeight;
      const width = element.scrollWidth;
      // A fully fitting Dice preview would be ~0.17× (1280px natural height),
      // which is too small to scan. Keep a legible floor and accept bounded,
      // centred cropping for unusually tall mechanics.
      setScale(Math.max(0.25, Math.min(0.5, 216 / Math.max(height, 1), 360 / Math.max(width, 1))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [kind]);

  return (
    <Flex
      h="240px"
      align="center"
      justify="center"
      overflow="hidden"
      borderRadius="12px"
      bg="gray.50"
      borderWidth="1px"
      borderColor="gray.100"
      data-testid={`manip-card-preview-${kind}`}
    >
      <Box
        ref={contentRef}
        transform={`scale(${scale})`}
        transformOrigin="center"
        w="200%"
        css={{ pointerEvents: "none" }}
      >
        <Flex justify="center">
          <Manipulative spec={spec} />
        </Flex>
      </Box>
    </Flex>
  );
}

// ── the kind detail page ───────────────────────────────────────────────────

function KindDetail({
  kind,
  usage,
  onBack,
  onUseKind,
}: {
  kind: ManipulativeKind;
  usage?: KindUsage;
  onBack: () => void;
  onUseKind: (kind: ManipulativeKind) => void;
}) {
  const spec = EXAMPLE_BY_KIND.get(kind);
  const entry = MANIPULATIVE_CATALOG[kind];
  const label = MANIPULATIVE_KIND_LABELS[kind];

  return (
    <Box data-testid={`manip-detail-${kind}`}>
      <Button
        size="xs"
        variant="ghost"
        colorPalette="violet"
        mb={3}
        onClick={onBack}
        data-testid="manip-detail-back"
      >
        ← All mechanics
      </Button>

      <Flex align="baseline" gap={3} wrap="wrap" mb={1}>
        <Heading size="lg" color="navy.600">
          {label}
        </Heading>
        <PrototypeMark kind={kind} />
      </Flex>
      <Text fontSize="sm" color="charcoal.500" mb={4}>
        {entry.group}
      </Text>

      <Text fontSize="sm" color="charcoal.700" lineHeight="1.6" mb={4} maxW="640px">
        {entry.blurb}
      </Text>

      {/* The large, live example — interactive, writing nothing (standalone
          Manipulative), exactly what a scholar gets. THIS IS THE REHEARSAL.
          There used to be a "Rehearse full size" button here that opened
          `ManipulativeRehearseModal` on this same spec: the identical component
          in a dialog NARROWER than this page, so it was both a second rendering
          of one signal (T1) and mislabelled — "full size" was smaller. Cut. The
          modal is still right for a STORED ITEM in a table row, which has no
          inline render of its own; here the page already is one. */}
      {spec && (
        <Flex direction="column" align="center" mb={5} gap={2} data-testid="manip-detail-preview">
          <Manipulative spec={spec} />
          <Text fontSize="xs" color="charcoal.400">
            Try it — this is exactly what a scholar gets, and nothing is saved.
          </Text>
        </Flex>
      )}

      {/* Tier 2: the plain-language "what you can change" SENTENCE — the same
          shape of sentence for every kind, which is what makes the fifteen
          different spec shapes comparable at all. NOT the schema. */}
      <Box
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="14px"
        bg="gray.50"
        p={4}
        mb={4}
        maxW="640px"
      >
        <Text
          fontSize="xs"
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.04em"
          color="charcoal.500"
          mb={1.5}
        >
          What you can change
        </Text>
        <Text fontSize="sm" color="charcoal.700" lineHeight="1.6">
          {entry.whatYouCanChange}
        </Text>
      </Box>

      {/* The JSON escape hatch — COLLAPSED by default. JSON is never the browse
          path; it's here for the one case (e.g. geoLocate's nested map spec) a
          sentence can't fully express. */}
      <Collapsible.Root maxW="640px">
        <Collapsible.Trigger
          asChild
          data-testid="manip-detail-json-trigger"
        >
          <Button size="xs" variant="ghost" colorPalette="gray" mb={2}>
            <CaretRight weight="bold" /> Show spec JSON
          </Button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Box
            as="pre"
            fontFamily="mono"
            fontSize="xs"
            color="charcoal.600"
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="12px"
            p={3}
            mb={2}
            overflowX="auto"
            data-testid="manip-detail-json"
          >
            {exampleSpecJson(kind)}
          </Box>
        </Collapsible.Content>
      </Collapsible.Root>

      {/* Where it's used — the kind → skill cross-reference the pool could never
          answer before. Every skill carrying an item of this kind, busiest
          first; an empty state that names the gap rather than hiding it, since a
          never-used mechanic is exactly what this surface exists to make
          visible. */}
      {usage !== undefined && (
        <Box
          mt={5}
          maxW="640px"
          data-testid="manip-detail-usage"
        >
          <Text
            fontSize="xs"
            fontWeight="700"
            textTransform="uppercase"
            letterSpacing="0.04em"
            color="charcoal.500"
            mb={2}
          >
            Where it&apos;s used
          </Text>
          {usage.skills.length === 0 ? (
            <Text fontSize="sm" color="red.600" fontWeight="600">
              No items yet — this mechanic is never used.
            </Text>
          ) : (
            <Flex direction="column" gap={0.5}>
              {usage.skills.map((s) => (
                <Flex
                  key={s.skillKey}
                  align="center"
                  justify="space-between"
                  gap={2}
                  py={1}
                  borderBottomWidth="1px"
                  borderColor="gray.100"
                  data-testid={`manip-detail-usage-skill-${s.skillKey}`}
                >
                  <Text fontSize="sm" color="charcoal.700" lineClamp={1}>
                    {s.label}
                  </Text>
                  <Text fontSize="xs" color="charcoal.400" flexShrink={0}>
                    {s.count}
                  </Text>
                </Flex>
              ))}
            </Flex>
          )}
        </Box>
      )}

      <Flex gap={2} mt={3} wrap="wrap">
        <Button
          size="sm"
          colorPalette="violet"
          onClick={() => onUseKind(kind)}
          data-testid="manip-detail-use"
        >
          <PencilSimple weight="bold" /> Use on a skill…
        </Button>
      </Flex>

    </Box>
  );
}

// ── the left rail ──────────────────────────────────────────────────────────

function RailRow({
  label,
  count,
  active,
  onClick,
  testId,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <Flex
      as="button"
      align="center"
      justify="space-between"
      w="full"
      textAlign="left"
      px={3}
      py={1.5}
      gap={2}
      bg={active ? "violet.50" : "transparent"}
      _hover={{ bg: active ? "violet.50" : "gray.50" }}
      onClick={onClick}
      data-testid={testId}
    >
      <Text
        fontSize="sm"
        fontWeight={active ? "600" : "400"}
        color={active ? "violet.700" : "charcoal.600"}
        lineClamp={1}
      >
        {label}
      </Text>
      {count !== undefined && (
        <Text fontSize="xs" color="charcoal.400" flexShrink={0}>
          {count}
        </Text>
      )}
    </Flex>
  );
}

function RailBand({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="xs"
      fontWeight="700"
      textTransform="uppercase"
      letterSpacing="0.05em"
      color="charcoal.400"
      px={3}
      pt={3}
      pb={1}
    >
      {children}
    </Text>
  );
}

// ── the lens ───────────────────────────────────────────────────────────────

export function ManipulativeLibrary({
  onUseKind,
}: {
  /** "Use on a skill…" — hands the chosen kind back to the studio, which
   *  switches to the Content lens (Questions · Hands-on) and opens the
   *  node-scoped editor preselected. The Library builds no second editor. */
  onUseKind: (kind: ManipulativeKind) => void;
}) {
  const [selection, setSelection] = useState<LibrarySelection>({ kind: "all" });
  const [openKind, setOpenKind] = useState<ManipulativeKind | null>(null);

  // The one cross-reference no surface could answer before: which mechanics
  // have items, and which have none. Catalog-wide (every registered domain),
  // staff-gated. `undefined` while loading — usage-dependent UI (the rail's In
  // use / Never used rows, the per-card line, the "Where it's used" list) hides
  // until it resolves rather than flashing a wrong "never used".
  const usageView = useQuery(api.practiceItemPool.manipulativeKindUsage, {});
  const usageByKind = new Map<ManipulativeKind, KindUsage>();
  if (usageView) {
    for (const entry of usageView.byKind) {
      usageByKind.set(entry.kind, {
        itemCount: entry.itemCount,
        skillCount: entry.skillCount,
        skills: entry.skills,
      });
    }
  }
  const usageLoaded = usageView !== undefined;
  const inUseKinds = MANIPULATIVE_KINDS.filter(
    (k) => (usageByKind.get(k)?.itemCount ?? 0) > 0,
  );
  const neverUsedKinds = MANIPULATIVE_KINDS.filter(
    (k) => (usageByKind.get(k)?.itemCount ?? 0) === 0,
  );

  // Opening a kind is orthogonal to the rail filter, so a rail click clears any
  // open detail and lands back on the (filtered) grid.
  const selectRail = (next: LibrarySelection) => {
    setSelection(next);
    setOpenKind(null);
  };

  const gridKinds =
    selection.kind === "group"
      ? kindsInGroup(selection.group)
      : selection.kind === "inUse"
        ? inUseKinds
        : selection.kind === "neverUsed"
          ? neverUsedKinds
          : MANIPULATIVE_KINDS;

  const paneHeading =
    selection.kind === "group"
      ? selection.group
      : selection.kind === "inUse"
        ? "In use"
        : selection.kind === "neverUsed"
          ? "Never used"
          : "All mechanics";

  return (
    // `h="full"`, NOT `flex={1}` — the shell mounts a lens inside a plain BLOCK
    // box (`<Box flex={1} minH={0} overflow="hidden">` in MathSkillsStudioShell),
    // where a `flex` value on the child means nothing: the child resolves to
    // height:auto, grows to the full height of fifteen stacked cards, and the
    // block parent's `overflow: hidden` silently clips it — so the pane below
    // never gets a bounded height and the lens cannot scroll at all. Filling the
    // parent's height explicitly is what re-bounds the chain.
    <Flex h="full" minH={0} overflow="hidden" bg="white">
      {/* Left rail — browse by idea, or by usage. "In use / Never used" read the
          `manipulativeKindUsage` cross-reference; they appear only once usage
          has loaded, since a filter on unknown counts would lie. */}
      <Flex
        direction="column"
        flexShrink={0}
        w={{ base: "200px", lg: "240px" }}
        minH={0}
        overflowY="auto"
        bg="white"
        borderRightWidth="1px"
        borderColor="gray.100"
        py={1}
      >
        <RailBand>Browse</RailBand>
        <RailRow
          label="All mechanics"
          count={MANIPULATIVE_KINDS.length}
          active={selection.kind === "all"}
          onClick={() => selectRail({ kind: "all" })}
          testId="manip-rail-all"
        />
        {usageLoaded && (
          <>
            <RailRow
              label="In use"
              count={inUseKinds.length}
              active={selection.kind === "inUse"}
              onClick={() => selectRail({ kind: "inUse" })}
              testId="manip-rail-inuse"
            />
            <RailRow
              label="Never used"
              count={neverUsedKinds.length}
              active={selection.kind === "neverUsed"}
              onClick={() => selectRail({ kind: "neverUsed" })}
              testId="manip-rail-neverused"
            />
          </>
        )}
        <RailBand>By idea</RailBand>
        {MANIPULATIVE_GROUP_ORDER.map((group) => {
          const n = kindsInGroup(group).length;
          if (n === 0) return null;
          return (
            <RailRow
              key={group}
              label={group}
              count={n}
              active={selection.kind === "group" && selection.group === group}
              onClick={() => selectRail({ kind: "group", group })}
              testId={`manip-rail-group-${group}`}
            />
          );
        })}
        <RailBand>Staff</RailBand>
        <RailRow
          label="Theme assets"
          active={selection.kind === "staff"}
          onClick={() => selectRail({ kind: "staff" })}
          testId="manip-rail-staff"
        />
      </Flex>

      {/* Pane */}
      <Box
        flex={1}
        minW={0}
        minH={0}
        overflowY="auto"
        bg="white"
        px={{ base: 3, md: 5 }}
        py={{ base: 3, md: 4 }}
      >
        {selection.kind === "staff" ? (
          <Box>
            <Heading size="sm" color="navy.600" mb={1}>
              Theme assets
            </Heading>
            <Text fontSize="xs" color="charcoal.500" mb={3} maxW="640px">
              The generative charm layer — every noun label a manipulative has
              themed with, and its cached art. Regenerate, hide, or clear an
              asset. Staff only; nothing renders until at least one label has
              been generated.
            </Text>
            <ThemeIconAdmin />
          </Box>
        ) : openKind ? (
          <KindDetail
            kind={openKind}
            usage={usageByKind.get(openKind)}
            onBack={() => setOpenKind(null)}
            onUseKind={onUseKind}
          />
        ) : (
          <Box>
            <Heading size="sm" color="navy.600" mb={1}>
              {paneHeading}
            </Heading>
            {/* Said once, here, rather than as an identical pill on all fifteen
                cards: these mechanics ship with the app — a teacher selects and
                configures one, never authors a new one (the same honesty the
                games picker uses). */}
            <Text fontSize="xs" color="charcoal.500" mb={4}>
              Mechanics that ship with Rabbithole — you choose and configure one,
              you don&apos;t create one. Every card is a live, playable example, no
              JSON to read. Open one to see what you can change and use it on a
              skill.
            </Text>
            {/* Items whose spec could not be attributed to a current mechanic
                (malformed JSON, or a legacy kind since removed from the union).
                Normally zero and therefore invisible. It is surfaced rather than
                dropped because the counts below are a SCOREBOARD — a wave of
                authoring is checked against them — and a total that quietly
                understates itself is worse than no total at all. If this ever
                shows a number, the "never used" set is not trustworthy until
                those rows are explained. */}
            {usageView !== undefined && usageView.unparseableCount > 0 && (
              <Text
                fontSize="xs"
                color="red.600"
                mb={4}
                data-testid="manip-usage-unparseable"
              >
                {usageView.unparseableCount} stored item
                {usageView.unparseableCount === 1 ? "" : "s"} could not be matched
                to a mechanic (unreadable or legacy spec) and {usageView.unparseableCount === 1 ? "is" : "are"} not
                counted below.
              </Text>
            )}
            {selection.kind === "neverUsed" && gridKinds.length === 0 ? (
              // The scoreboard's win state: the content wave has authored an
              // item for every mechanic. Named, not a blank grid.
              <Text fontSize="sm" color="charcoal.500">
                Every mechanic has at least one item — nothing is unused.
              </Text>
            ) : (
              <SimpleGrid columns={{ base: 1, xl: 2 }} gap={5}>
                {gridKinds.map((kind) => (
                  <KindCard
                    key={kind}
                    kind={kind}
                    usage={usageByKind.get(kind)}
                    onOpen={() => setOpenKind(kind)}
                  />
                ))}
              </SimpleGrid>
            )}
          </Box>
        )}
      </Box>
    </Flex>
  );
}
