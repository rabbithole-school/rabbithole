"use client";

/**
 * The web World Workbench — the same scholar session as chat, a different
 * renderer (branched on the session's world activity). Three panes on wide
 * screens (deck · viewport · inspector), collapsing to drawers on narrow ones;
 * a Notebook overlay; a demoted sideline tutor. This root owns the cross-pane
 * selection + scrub state; each pane is otherwise self-contained.
 *
 * Anti-offloading is structural here (plan §7.1): the deck is the only writer of
 * automaton behavior, metrics report but never diagnose, and Compare frames every
 * result as a PERSONAL delta. See the child components for the enforcement points.
 *
 * RE-RENDER SCOPING (review Finding 5): every simulation tick invalidates the
 * run manifest + bench aggregate, so the root re-renders each tick. The panes
 * that do NOT consume live run data — the prompt deck, notebook, tutor, criterion
 * bar, icon resolvers — are memoized with referentially-stable props (a stabilized
 * `spec` + a stable species-label list), so a tick re-renders only the viewport,
 * the RunTray, and the Compare tab. RunTray is a sibling of the deck (not a child)
 * so the deck itself never re-subscribes to the live manifest.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Drawer,
  Flex,
  Portal,
  Spinner,
  Text,
  VStack,
  useBreakpointValue,
} from "@chakra-ui/react";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { SimulatorSceneV1, SimulatorSpec } from "@/lib/simulator/contract";
import { ecosystemBiome } from "@/lib/simulator/ecosystemTerrainTiles";
import { getWorkbenchRendererFamily } from "@/lib/simulator/templates/registry";
import { toaster } from "@/lib/toaster";
import { findActiveSimulatorRun } from "@/shared/simulatorRunLauncher";
import {
  useWorkbenchBench,
  useWorkbenchNotebook,
  useWorkbenchRun,
  useWorkbenchRuns,
  type WorkbenchRunId,
} from "@/hooks/useWorkbenchData";
import { useWorkbenchScene } from "@/hooks/useWorkbenchScene";
import {
  initialTerrainPreviewScene,
  type EcosystemSenseEvidenceRequest,
} from "@/lib/simulator/scene";
import { CriterionBar } from "./CriterionBar";
import { PromptDeckPanel } from "./PromptDeckPanel";
import { RunTray } from "./RunTray";
import { SimulatorViewport, DAY_ADVANCE_MS, TickScrubber } from "./SimulatorViewport";
import { InspectorPanel } from "./InspectorPanel";
import { NotebookPanel } from "./NotebookPanel";
import { WorkbenchPanel, type PanelTab } from "./WorkbenchPanel";
import { SidelineTutorDrawer } from "./SidelineTutorDrawer";
import { SpeciesIconResolvers } from "./SpeciesIcons";
import { TournamentCard } from "./TournamentCard";
import { WorkbenchEvidenceRenderer } from "./renderers/WorkbenchEvidenceRenderer";
import {
  canAddSpeciesSlot,
  personalDeltaHeadline,
  runCriterionScore,
} from "./helpers";

export function WorkbenchSurface({
  sessionId,
  onOpenSidebar,
}: {
  sessionId: Id<"sessions">;
  onOpenSidebar?: () => void;
}) {
  const { bench, isLoading, isUnopened, ensureError, retry } = useWorkbenchBench(sessionId);
  const runsResult = useWorkbenchRuns(sessionId);
  const runs = runsResult ?? [];
  const runsResolved = runsResult !== undefined;
  const notebook = useWorkbenchNotebook(sessionId);
  const activeRun = findActiveSimulatorRun(runs);
  const hasRuns = runs.length > 0;

  const [selectedRunId, setSelectedRunId] = useState<WorkbenchRunId | null>(null);
  const [scrubTick, setScrubTick] = useState(0);
  const [following, setFollowing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [selectedAutomatonId, setSelectedAutomatonId] = useState<string | null>(null);
  const [senseEvidenceRequest, setSenseEvidenceRequest] =
    useState<EcosystemSenseEvidenceRequest>();
  const [inspectorTab, setInspectorTab] = useState<"mind" | "compare">("mind");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [deckDrawerOpen, setDeckDrawerOpen] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [deckDirty, setDeckDirty] = useState(false);
  const [focusedSlotId, setFocusedSlotId] = useState<string | null>(null);
  const [speciesIcons, setSpeciesIcons] = useState<Record<string, string | undefined>>({});
  // The two-column right panel's active surface (wide only).
  const [panelTab, setPanelTab] = useState<PanelTab>("run");

  const isNarrow = useBreakpointValue({ base: true, lg: false }) ?? false;

  const addSpecies = useMutation(api.simulatorBenches.addSpeciesToBench);
  const onAddSpecies = useCallback(async () => {
    if (deckDirty) {
      toaster.error({ title: "Save the deck before adding a species." });
      return;
    }
    try {
      await addSpecies({ sessionId });
    } catch (error) {
      toaster.error({
        title: error instanceof Error ? error.message : "Could not add a species",
      });
    }
  }, [addSpecies, deckDirty, sessionId]);

  const onFocusSpecies = useCallback(
    (slotId: string) => {
      setFocusedSlotId(slotId);
      // Wide: the deck lives in the panel's Species tab; narrow: a slide-in drawer.
      if (isNarrow) setDeckDrawerOpen(true);
      else setPanelTab("species");
    },
    [isNarrow],
  );

  const onResolveIcon = useCallback((label: string, url: string | undefined) => {
    setSpeciesIcons((current) => (current[label] === url ? current : { ...current, [label]: url }));
  }, []);

  // Stabilize the world spec's reference across ticks. `getBench` returns a
  // fresh object each tick, so `bench.simulatorSpec` changes identity even though
  // the spec is immutable for the activity — which would defeat every memo that
  // takes `spec`. Keying a round-trip on the serialized spec restores a stable
  // reference the compiler can track (deps = the primitive string).
  const specJson = bench ? JSON.stringify(bench.simulatorSpec) : "";
  const spec = useMemo<SimulatorSpec | undefined>(
    () => (specJson ? (JSON.parse(specJson) as SimulatorSpec) : undefined),
    [specJson],
  );

  const activeRunId = selectedRunId ?? runs[0]?._id ?? null;
  const selectedRun = useWorkbenchRun(activeRunId);
  // A replay must use its frozen run spec, including the stable terrain catalog
  // id, rather than a teacher's later edit to the activity.
  const renderSpecJson = selectedRun
    ? JSON.stringify(selectedRun.simulatorSpecSnapshot)
    : specJson;
  const renderSpec = useMemo<SimulatorSpec | undefined>(
    () => (renderSpecJson ? (JSON.parse(renderSpecJson) as SimulatorSpec) : undefined),
    [renderSpecJson],
  );
  const rendererFamily = renderSpec
    ? getWorkbenchRendererFamily(renderSpec.templateId)
    : null;
  // A selected replay can be older than the activity's current spec. Resolve
  // icons from that frozen spec too, so a later biome edit cannot repaint it.
  const renderLabelKey = renderSpec
    ? renderSpec.speciesSlots.map((slot) => slot.label).join("\u0000")
    : "";
  const speciesLabels = useMemo(() => {
    const labels = renderLabelKey ? renderLabelKey.split("\u0000") : [];
    const resourceIconLabel =
      renderSpec?.templateId === "ecosystemGrid"
        ? ecosystemBiome(renderSpec.config.biome).resource.iconLabel
        : undefined;
    if (resourceIconLabel && !labels.includes(resourceIconLabel)) {
      labels.push(resourceIconLabel);
    }
    return labels;
  }, [renderLabelKey, renderSpec]);
  const maxTick = selectedRun?.latestCommittedTick ?? 0;
  // The engine is still producing days — so the live head is "next day baking",
  // not "the end"; playback keeps following into freshly-committed days.
  const moreComing = selectedRun?.status === "queued" || selectedRun?.status === "ticking";

  // The displayed tick follows the live head while `following`, else the last
  // scrub position — derived, so there is no setState-in-effect churn.
  const tick = following ? maxTick : Math.min(scrubTick, maxTick);
  const isLiveHead = following && tick === maxTick;

  const frame = useWorkbenchScene(activeRunId, tick, renderSpec, maxTick, senseEvidenceRequest);

  const latestSceneJson = selectedRun?.latestSceneJson;
  const liveScene = useMemo<SimulatorSceneV1 | null>(() => {
    if (!latestSceneJson) return null;
    try {
      return JSON.parse(latestSceneJson) as SimulatorSceneV1;
    } catch {
      return null;
    }
  }, [latestSceneJson]);
  const preRunScene = useMemo(
    () =>
      runsResolved && activeRunId === null && renderSpec
        ? initialTerrainPreviewScene(renderSpec)
        : null,
    [activeRunId, renderSpec, runsResolved],
  );

  const onScrub = useCallback(
    (next: number) => {
      setPlaying(false);
      setScrubTick(next);
      setFollowing(next >= maxTick);
    },
    [maxTick],
  );

  const onTogglePlay = useCallback(() => {
    // Pause freezes the current frame (detaches from the live head); Play resumes
    // from here, or replays from day 0 when parked at the end.
    if (playing) {
      setPlaying(false);
      setFollowing(false);
      setScrubTick(tick);
      return;
    }
    setScrubTick(tick >= maxTick ? 0 : tick);
    setFollowing(false);
    setPlaying(true);
  }, [playing, tick, maxTick]);

  // Playback advance. The setState lives inside an async timeout, so this is a
  // legitimate interval — not a synchronous setState-in-effect. It advances one
  // recorded day per DAY_ADVANCE_MS (SimulatorViewport glides each step); when it
  // catches the live head it starts FOLLOWING, so play continues into freshly
  // committed days as they bake, and only stops once nothing more is coming.
  useEffect(() => {
    if (!playing) return;
    if (following) {
      if (!moreComing) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- The playback state machine stops immediately when following reaches the true, final head.
        setPlaying(false);
      }
      return; // else the view follows the baking head on its own
    }
    if (scrubTick >= maxTick) {
      setFollowing(true); // caught up → follow the live head
      return;
    }
    const next = setTimeout(() => {
      const nextTick = Math.min(maxTick, scrubTick + 1);
      setScrubTick(nextTick);
      if (nextTick >= maxTick) setFollowing(true);
    }, DAY_ADVANCE_MS);
    return () => clearTimeout(next);
  }, [playing, following, moreComing, scrubTick, maxTick]);

  const onSelectAutomaton = useCallback((id: string) => {
    setSelectedAutomatonId(id);
    setInspectorTab("mind");
  }, []);

  const onSelectRun = useCallback((runId: WorkbenchRunId) => {
    setSelectedRunId(runId);
    setSelectedAutomatonId(null);
    setFollowing(true);
    setPlaying(false);
  }, []);

  // ── Non-ready states — every one renders something actionable (Finding 8) ──
  if (isLoading) {
    return (
      <Flex flex={1} align="center" justify="center" bg="gray.50" role="status" aria-label="Loading the Workbench">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }
  if (!bench || !spec) {
    // The aggregate does not exist yet. A scholar's open is in flight; a teacher
    // (or a real failure) cannot open it and must not stare at a bare spinner.
    return (
      <Flex flex={1} align="center" justify="center" bg="gray.50" p={8}>
        <VStack gap={3} maxW="360px" textAlign="center">
          {ensureError ? (
            <>
              <Text fontWeight="700" color="charcoal.600">
                This Workbench hasn&apos;t opened yet
              </Text>
              <Text fontSize="sm" color="gray.600">
                {ensureError.includes("scholar")
                  ? "It opens the first time the scholar visits it. Nothing to do here until then."
                  : ensureError}
              </Text>
              <Button size="sm" colorPalette="violet" onClick={retry}>
                Try again
              </Button>
            </>
          ) : isUnopened ? (
            <>
              <Text fontWeight="700" color="charcoal.600">
                Opening the Workbench…
              </Text>
              <Spinner color="violet.500" />
            </>
          ) : (
            <Spinner size="xl" color="violet.500" />
          )}
        </VStack>
      </Flex>
    );
  }

  // Personal-delta headline for the viewport (never a class ranking). Mirrors
  // native's rule exactly via the shared helper: needs ≥2 runs to compare.
  const runScore = selectedRun ? runCriterionScore(renderSpec ?? spec, selectedRun.criterionScores) : null;
  const selectedRunExtinct =
    selectedRun?.extinct ??
    (bench.latestOutcome?.runId === activeRunId ? bench.latestOutcome.extinct : false);
  const personalDelta = personalDeltaHeadline(
    renderSpec ?? spec,
    runScore,
    bench.bestScore,
    runs.length,
    selectedRunExtinct,
  );

  const runLabel = selectedRun ? `deck v${selectedRun.deckVersion}` : "no run";

  // Narrow keeps the deck as a slide-in drawer (+ the bottom launch bar); wide
  // folds it into the panel's Species tab.
  const deckColumn = (
    <Flex flexDir="column" h="100%" minH={0}>
      <Box flex={1} minH={0} overflowY="auto">
        <PromptDeckPanel
          sessionId={sessionId}
          spec={spec}
          deck={bench.deck}
          deckVersion={bench.deckVersion}
          speciesIcons={speciesIcons}
          compiledPolicies={bench.compiledPolicies}
          focusedSlotId={focusedSlotId}
          onDirtyChange={setDeckDirty}
        />
      </Box>
      <Box px={3} pb={3} flexShrink={0}>
        <TournamentCard sessionId={sessionId} onSelectRun={onSelectRun} />
      </Box>
    </Flex>
  );

  const inspector = (
    <InspectorPanel
      spec={spec}
      frame={frame}
      run={selectedRun}
      runs={runs}
      selectedRunId={activeRunId}
      onSelectRun={onSelectRun}
      selectedAutomatonId={selectedAutomatonId}
      tab={inspectorTab}
      onTabChange={setInspectorTab}
    />
  );

  const openAutomatonInspector = (id: string) => {
    onSelectAutomaton(id);
    setInspectorDrawerOpen(true);
  };
  const viewport =
    rendererFamily === "field" ? (
      <SimulatorViewport
        spec={renderSpec ?? spec}
        frame={frame}
        liveScene={liveScene ?? preRunScene}
        isLiveHead={isLiveHead}
        run={selectedRun}
        tick={tick}
        maxTick={maxTick}
        moreComing={moreComing}
        playing={playing}
        onScrub={onScrub}
        onTogglePlay={onTogglePlay}
        onSelectAutomaton={openAutomatonInspector}
        selectedAutomatonId={selectedAutomatonId}
        speciesIcons={speciesIcons}
        runLabel={runLabel}
        personalDelta={personalDelta}
        showTransport={isNarrow}
        onSenseEvidenceDemand={setSenseEvidenceRequest}
      />
    ) : renderSpec && renderSpec.templateId !== "ecosystemGrid" ? (
      <Flex flexDir="column" flex={1} minW={0} minH={0}>
        <WorkbenchEvidenceRenderer
          spec={renderSpec}
          frame={frame}
          tick={tick}
          onSelectAutomaton={openAutomatonInspector}
          hasRun={selectedRun !== null}
          onSelectRound={onScrub}
          runStatus={selectedRun?.status ?? null}
          totalRounds={selectedRun?.targetTicks ?? maxTick}
        />
        {isNarrow && selectedRun ? (
          <TickScrubber
            tick={tick}
            maxTick={maxTick}
            moreComing={moreComing}
            playing={playing}
            onScrub={onScrub}
            onTogglePlay={onTogglePlay}
            status={selectedRun.status}
            haltReason={selectedRun.haltReason}
            targetTicks={selectedRun.targetTicks}
            runKind={selectedRun.runKind}
            timeUnit="round"
          />
        ) : null}
      </Flex>
    ) : null;
  const viewportWithLauncher = (
    <Box flex={1} minH={0} minW={0} position="relative">
      {viewport}
      {!hasRuns ? (
        <Flex
          position="absolute"
          inset={0}
          align="center"
          justify="center"
          px={5}
          pointerEvents="none"
        >
          <Box
            w="full"
            maxW="360px"
            p={5}
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="xl"
            pointerEvents="auto"
          >
            <RunTray
              sessionId={sessionId}
              spec={spec}
              onLaunched={onSelectRun}
              deckDirty={deckDirty}
              deckVersion={bench.deckVersion}
              hasCompletedRun={bench.hasCompletedRun}
              activeRun={null}
              placement="empty"
            />
          </Box>
        </Flex>
      ) : null}
    </Box>
  );

  // The two-column right rail (wide): a persistent transport strip + the
  // Run / Species / History surfaces, nothing overlaying the grid.
  const workbenchPanel = (
    <WorkbenchPanel
      tab={panelTab}
      onTabChange={setPanelTab}
      sessionId={sessionId}
      spec={spec}
      activityDescription={bench.description}
      deckDirty={deckDirty}
      hasCompletedRun={bench.hasCompletedRun}
      hasRuns={hasRuns}
      activeRun={activeRun}
      onLaunched={onSelectRun}
      deck={bench.deck}
      deckVersion={bench.deckVersion}
      compiledPolicies={bench.compiledPolicies}
      focusedSlotId={focusedSlotId}
      onDeckDirtyChange={setDeckDirty}
      speciesIcons={speciesIcons}
      notebook={notebook}
      runs={runs}
      activeRunId={activeRunId}
      selectedRun={selectedRun}
      onSelectRun={onSelectRun}
      tick={tick}
      maxTick={maxTick}
      moreComing={moreComing}
      playing={playing}
      onScrub={onScrub}
      onTogglePlay={onTogglePlay}
      populationTraitEvidence={frame?.populationTraitEvidence}
    />
  );

  return (
    <Flex flexDir="column" flex={1} minH={0} minW={0} position="relative">
      <SpeciesIconResolvers
        templateId={(renderSpec ?? spec).templateId}
        labels={speciesLabels}
        onResolve={onResolveIcon}
      />

      <CriterionBar
        spec={spec}
        title={bench.title}
        deck={bench.deck}
        speciesIcons={speciesIcons}
        bestScore={bench.bestScore}
        extinct={selectedRunExtinct}
        canAddSpecies={canAddSpeciesSlot(spec)}
        onFocusSpecies={onFocusSpecies}
        onAddSpecies={onAddSpecies}
        onToggleHistory={() =>
          isNarrow
            ? setHistoryOpen((open) => !open)
            : setPanelTab((current) => (current === "history" ? "run" : "history"))
        }
        historyOpen={isNarrow ? historyOpen : panelTab === "history"}
        onToggleTutor={() => setTutorOpen((open) => !open)}
        tutorOpen={tutorOpen}
        onOpenMenu={onOpenSidebar}
      />

      {isNarrow ? (
        <>
          <Flex px={3} py={1.5} gap={2} borderBottom="1px solid" borderColor="gray.200">
            <Button size="xs" variant="outline" onClick={() => setDeckDrawerOpen(true)}>
              Deck
            </Button>
            <Button size="xs" variant="outline" onClick={() => setInspectorDrawerOpen(true)}>
              Inspector
            </Button>
          </Flex>
          {viewportWithLauncher}
          {hasRuns ? (
            <Box px={3} py={2} borderTop="1px solid" borderColor="gray.200" bg="white">
              <RunTray
                sessionId={sessionId}
                spec={spec}
                onLaunched={onSelectRun}
                deckDirty={deckDirty}
                deckVersion={bench.deckVersion}
                hasCompletedRun={bench.hasCompletedRun}
                activeRun={activeRun}
              />
            </Box>
          ) : null}
          <Drawer.Root open={deckDrawerOpen} onOpenChange={(e) => setDeckDrawerOpen(e.open)} placement="start">
            <Portal>
              <Drawer.Backdrop />
              <Drawer.Positioner>
                <Drawer.Content bg="white" maxW="320px">
                  {deckColumn}
                </Drawer.Content>
              </Drawer.Positioner>
            </Portal>
          </Drawer.Root>
        </>
      ) : (
        // Two-column bench: canvas on the left, the persistent Run/Species/History
        // panel on the right. Nothing overlays the grid.
        <Flex flex={1} minH={0}>
          {viewportWithLauncher}
          <Box w="380px" flexShrink={0} minH={0}>
            {workbenchPanel}
          </Box>
        </Flex>
      )}

      {/* Inspector — a contextual right-edge drawer, opened by selecting an
          automaton (both layouts), mirroring native's floating InspectorSheet. */}
      <Drawer.Root
        open={inspectorDrawerOpen}
        onOpenChange={(e) => setInspectorDrawerOpen(e.open)}
        placement="end"
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content bg="white" maxW="340px">
              {inspector}
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      {/* History as an overlay drawer is the STACKED layout's affordance; wide
          reads it from the panel's History tab. */}
      <NotebookPanel
        open={isNarrow && historyOpen}
        onClose={() => setHistoryOpen(false)}
        sessionId={sessionId}
        entries={notebook}
        runs={runs}
        selectedRunId={activeRunId}
        selectedRun={selectedRun}
        onSelectRun={onSelectRun}
        spec={spec}
      />
      <SidelineTutorDrawer sessionId={sessionId} open={tutorOpen} onClose={() => setTutorOpen(false)} />
    </Flex>
  );
}
