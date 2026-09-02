/**
 * The native World Workbench — the scholar's primary, tactile bench (plan §12).
 * The SAME scholar session as chat, a different renderer (the session route
 * branches here on `sessionMode === "workbench"`). The world viewport is
 * CENTER-STAGE; the deck, inspector, notebook, and tutor are SHEETS (finger-
 * reachable over one primary viewport — the sanctioned native/​web surface
 * difference, plan §12), not side columns.
 *
 * This root owns the cross-surface selection + scrub state; each sheet is
 * otherwise self-contained. Anti-offloading is structural (plan §7.1): the deck
 * is the only writer of automaton behavior, metrics report but never diagnose,
 * and Compare frames every result as a PERSONAL delta.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import type { SimulatorSceneV1, SimulatorSpec } from "../../../vendor/simulator/contract";
import { ecosystemBiome } from "../../../vendor/simulator/ecosystemTerrainTiles";
import { canAddSpeciesSlot } from "../../../vendor/simulator/helpers";
import {
  initialTerrainPreviewScene,
  type EcosystemSenseEvidenceRequest,
} from "../../../vendor/simulator/scene";
import { getWorkbenchRendererFamily } from "../../../vendor/simulator/templates/registry";
import { findActiveSimulatorRun } from "../../../vendor/shared/simulatorRunLauncher";
import {
  useWorkbenchBench,
  useWorkbenchNotebook,
  useWorkbenchRun,
  useWorkbenchRuns,
  type WorkbenchRunId,
} from "./useWorkbenchData";
import { useWorkbenchScene } from "./useWorkbenchScene";
import { CriterionBar } from "./CriterionBar";
import { SimulatorViewport } from "./SimulatorViewport";
import { DAY_ADVANCE_MS } from "./TickScrubber";
import { PromptDeckSheet } from "./PromptDeckSheet";
import { InspectorSheet } from "./InspectorSheet";
import { NotebookSheet } from "./NotebookSheet";
import { RunTray } from "./RunTray";
import { WorkbenchPanel } from "./WorkbenchPanel";
import { SidelineTutorSheet } from "./SidelineTutorSheet";
import { SpeciesIconResolvers } from "./SpeciesIcon";
import { personalDeltaHeadline, runCriterionScore } from "./helpers";

export function WorkbenchScreen({ sessionId }: { sessionId: Id<"sessions"> }) {
  const colors = useColors();
  const { width: screenWidth } = useWindowDimensions();
  // Wide widths (>= 900) use the immersive floating overlay; narrower
  // External-display and Split View widths retain the stacked layout so neither
  // floating control box may overlap another control or the world.
  const immersive = screenWidth >= 900;
  const { bench, isLoading, ensureError, retry } = useWorkbenchBench(sessionId);
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
  const [deckOpen, setDeckOpen] = useState(false);
  const [focusedSlotId, setFocusedSlotId] = useState<string | null>(null);
  const [deckDirty, setDeckDirty] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [speciesIcons, setSpeciesIcons] = useState<Record<string, string | undefined>>({});
  const addSpecies = useMutation(api.simulatorBenches.addSpeciesToBench);

  const onFocusSpecies = useCallback(
    (slotId: string) => {
      setFocusedSlotId(slotId);
      setDeckOpen(true);
    },
    [],
  );

  const onAddSpecies = useCallback(async () => {
    if (deckDirty) {
      Alert.alert("Save the deck first", "Save your prompt deck before adding a species.");
      return;
    }
    try {
      await addSpecies({ sessionId });
    } catch (error) {
      Alert.alert(
        "Couldn't add a species",
        error instanceof Error ? error.message : "Please try again.",
      );
    }
  }, [addSpecies, deckDirty, sessionId]);

  const onResolveIcon = useCallback((label: string, url: string | undefined) => {
    setSpeciesIcons((current) => (current[label] === url ? current : { ...current, [label]: url }));
  }, []);

  // Default to the most recent run (listForBench is desc) — derived, not synced.
  const activeRunId = selectedRunId ?? runs[0]?._id ?? null;
  const selectedRun = useWorkbenchRun(activeRunId);
  const simulatorSpec = bench?.simulatorSpec;
  const renderSpecJson = JSON.stringify(
    selectedRun?.simulatorSpecSnapshot ?? simulatorSpec ?? null,
  );
  const renderSpec = useMemo<SimulatorSpec | undefined>(() => {
    const parsed: unknown = JSON.parse(renderSpecJson);
    return parsed ? (parsed as SimulatorSpec) : undefined;
  }, [renderSpecJson]);
  const maxTick = selectedRun?.latestCommittedTick ?? 0;
  const rendererFamily = renderSpec ? getWorkbenchRendererFamily(renderSpec.templateId) : null;
  // The engine is still producing days (so the live head is "next day baking",
  // not "the end" — the transport waits to advance rather than showing a spinner).
  const moreComing =
    selectedRun?.status === "queued" || selectedRun?.status === "ticking";

  // Displayed tick follows the live head while `following`, else the scrub pos.
  const tick = following ? maxTick : Math.min(scrubTick, maxTick);

  // Scene subscription scoping (review Finding 5): only page chunks when we are
  // actually replaying (scrubbing) OR the inspector is open and needs the mind
  // record. A plain live watch draws `latestSceneJson` and costs no chunk reads.
  const sceneEnabled = rendererFamily !== "field" || !following || inspectorOpen;
  const sceneResult = useWorkbenchScene(
    activeRunId, tick, renderSpec, sceneEnabled, maxTick, senseEvidenceRequest,
  );
  const frame = sceneResult.status === "ready" ? sceneResult.frame : null;

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

  // Step-first transport (§7.5): scrubbing / stepping is a direct seek that also
  // pauses playback (the manual-seek path). Each single-day advance eases the
  // automata one recorded tick (the glide lives in SimulatorViewport), so a run reads
  // as legible day-by-day beats, never a blur.
  const onScrub = useCallback(
    (next: number) => {
      setPlaying(false);
      setScrubTick(next);
      setFollowing(next >= maxTick);
    },
    [maxTick],
  );

  // Play/pause. Pause freezes the current frame (detaches from the live head);
  // Play resumes from here, or replays from day 0 when parked at the end.
  const onTogglePlay = useCallback(() => {
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

  // The playback loop lives with the scrub state. It advances one recorded day per
  // DAY_ADVANCE_MS via setScrubTick (SimulatorViewport glides each step); when it
  // catches the live head it starts FOLLOWING, so play continues into freshly
  // committed days as they bake, and only stops once nothing more is coming.
  useEffect(() => {
    if (!playing) return;
    if (following) {
      if (!moreComing) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Playback must stop immediately when the followed stream reaches its true end.
        setPlaying(false);
      }
      return; // else the view follows the baking head on its own
    }
    if (scrubTick >= maxTick) {
      setFollowing(true); // caught up → follow the live head
      return;
    }
    const timer = setTimeout(() => {
      const nextTick = Math.min(maxTick, scrubTick + 1);
      setScrubTick(nextTick);
      if (nextTick >= maxTick) setFollowing(true);
    }, DAY_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [playing, following, moreComing, scrubTick, maxTick]);

  const onSelectAutomaton = useCallback((id: string) => {
    setSelectedAutomatonId(id);
    setInspectorTab("mind");
    setInspectorOpen(true);
  }, []);

  const onSelectRun = useCallback((runId: WorkbenchRunId) => {
    setSelectedRunId(runId);
    setSelectedAutomatonId(null);
    setFollowing(true);
    setPlaying(false);
  }, []);

  if (isLoading || (!bench && !ensureError)) {
    return (
      <SafeAreaView style={[styles.loading, { backgroundColor: colors.bg }]} edges={["bottom"]}>
        <ActivityIndicator size="large" color={colors.violet} />
        <Text style={[styles.loadingText, { color: colors.fgMuted }]}>opening the bench…</Text>
      </SafeAreaView>
    );
  }

  // The bench aggregate doesn't exist and the open attempt failed (e.g. a teacher
  // opened a World the scholar hasn't started — only the scholar can open it).
  // Show an explanation instead of an endless spinner (review Finding 8).
  if (!bench || !simulatorSpec || !renderSpec) {
    return (
      <SafeAreaView style={[styles.loading, { backgroundColor: colors.bg }]} edges={["bottom"]}>
        <Text style={[styles.errorTitle, { color: colors.fg }]}>This bench isn&apos;t open yet</Text>
        <Text style={[styles.errorBody, { color: colors.fgMuted }]}>
          {ensureError ?? "It hasn't been opened by the scholar yet."}
        </Text>
        {/* Web parity (components/workbench/WorkbenchSurface.tsx): a failed open
            must be recoverable in place, or a scholar whose bench failed to open
            is stuck on this screen with no way forward. */}
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={({ pressed }) => [
            styles.retryButton,
            { backgroundColor: colors.violetSolid, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={[styles.retryText, { color: colors.white }]}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const speciesLabels = renderSpec.speciesSlots.map((slot) => slot.label);
  // Warm the biome's resource icon alongside species icons so cell markers share
  // the same hosted asset on the replay's frozen terrain catalog.
  const resourceIconLabel =
    renderSpec.templateId === "ecosystemGrid"
      ? ecosystemBiome(renderSpec.config.biome).resource.iconLabel
      : undefined;
  if (resourceIconLabel && !speciesLabels.includes(resourceIconLabel)) {
    speciesLabels.push(resourceIconLabel);
  }

  // Personal-delta headline for the viewport (never a class ranking). Only
  // meaningful once there's more than one run to compare — on the first/only
  // run "your best deck yet" is nonsense (nothing to be best of).
  const runScore = selectedRun ? runCriterionScore(renderSpec, selectedRun.criterionScores) : null;
  const selectedRunExtinct =
    selectedRun?.extinct ??
    (bench.latestOutcome?.runId === activeRunId ? bench.latestOutcome.extinct : false);
  const personalDelta = personalDeltaHeadline(
    renderSpec,
    runScore,
    bench.bestScore,
    runs.length,
    selectedRunExtinct,
  );
  const runLabel = selectedRun
    ? `${rendererFamily === "field" ? "deck" : "strategy rules"} v${selectedRun.deckVersion}`
    : "no run";

  const criterionBar = (
    <CriterionBar
      spec={simulatorSpec}
      deck={bench.deck}
      speciesIcons={speciesIcons}
      bestScore={bench.bestScore}
      extinct={selectedRunExtinct}
      canAddSpecies={canAddSpeciesSlot(simulatorSpec)}
      onFocusSpecies={onFocusSpecies}
      onAddSpecies={onAddSpecies}
      historyOpen={historyOpen}
      onToggleHistory={() => setHistoryOpen((open) => !open)}
      tutorOpen={tutorOpen}
      onToggleTutor={() => setTutorOpen((open) => !open)}
      showUtilityActions={!immersive}
    />
  );

  const viewport = (
    <SimulatorViewport
      spec={renderSpec}
      scene={sceneResult}
      frame={frame}
      liveScene={liveScene ?? preRunScene}
      runId={activeRunId}
      run={selectedRun}
      tick={tick}
      maxTick={maxTick}
      moreComing={moreComing}
      playing={playing}
      onScrub={onScrub}
      onTogglePlay={onTogglePlay}
      onSelectAutomaton={onSelectAutomaton}
      selectedAutomatonId={selectedAutomatonId}
      speciesIcons={speciesIcons}
      runLabel={runLabel}
      personalDelta={personalDelta}
      showTransport={!immersive}
      contentInsets={immersive ? WORKBENCH_CONTENT_INSETS : undefined}
      onSenseEvidenceDemand={setSenseEvidenceRequest}
    />
  );
  const firstRunLauncher = !hasRuns ? (
    <View pointerEvents="box-none" style={styles.firstRunOverlay}>
      <View
        style={[
          styles.firstRunCard,
          { backgroundColor: colors.bg, borderColor: colors.border },
        ]}
      >
        <RunTray
          sessionId={sessionId}
          spec={simulatorSpec}
          deckDirty={deckDirty}
          deckVersion={bench.deckVersion}
          hasCompletedRun={bench.hasCompletedRun}
          activeRun={null}
          placement="empty"
          onLaunched={onSelectRun}
        />
      </View>
    </View>
  ) : null;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: WORKBENCH_BG }]} edges={["bottom"]}>
      <SpeciesIconResolvers templateId={renderSpec.templateId} labels={speciesLabels} onResolve={onResolveIcon} />

      {immersive ? (
        <View style={styles.world}>
          {viewport}
          {firstRunLauncher}
          <View pointerEvents="box-none" style={styles.overlay}>
            <View style={styles.criterion}>{criterionBar}</View>
            <WorkbenchPanel
              sessionId={sessionId}
              spec={simulatorSpec}
              activityDescription={bench.description}
              deckDirty={deckDirty}
              hasCompletedRun={bench.hasCompletedRun}
              hasRuns={hasRuns}
              activeRun={activeRun}
              onLaunched={onSelectRun}
              deckVersion={bench.deckVersion}
              onOpenDeck={() => setDeckOpen(true)}
              onOpenHistory={() => setHistoryOpen(true)}
              onToggleTutor={() => setTutorOpen((open) => !open)}
              tutorOpen={tutorOpen}
              selectedRun={selectedRun}
              tick={tick}
              maxTick={maxTick}
              moreComing={moreComing}
              playing={playing}
              onScrub={onScrub}
              onTogglePlay={onTogglePlay}
              populationTraitEvidence={frame?.populationTraitEvidence}
            />
          </View>
        </View>
      ) : (
        <>
          {criterionBar}
          <View style={styles.viewportFrame}>
            {viewport}
            {firstRunLauncher}
          </View>
          {hasRuns ? (
            <View style={[styles.dockBar, { borderTopColor: colors.border, backgroundColor: colors.bg }]}>
              <RunTray
                sessionId={sessionId}
                spec={simulatorSpec}
                deckDirty={deckDirty}
                deckVersion={bench.deckVersion}
                hasCompletedRun={bench.hasCompletedRun}
                activeRun={activeRun}
                onLaunched={onSelectRun}
              />
            </View>
          ) : null}
        </>
      )}

      <PromptDeckSheet
        open={deckOpen}
        onClose={() => setDeckOpen(false)}
        sessionId={sessionId}
        spec={simulatorSpec}
        deck={bench.deck}
        deckVersion={bench.deckVersion}
        compiledPolicies={bench.compiledPolicies}
        focusedSlotId={focusedSlotId}
        onDirtyChange={setDeckDirty}
        speciesIcons={speciesIcons}
        onSelectRun={onSelectRun}
      />

      <NotebookSheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        sessionId={sessionId}
        entries={notebook}
        runs={runs}
        selectedRunId={activeRunId}
        selectedRun={selectedRun}
        onSelectRun={onSelectRun}
        spec={simulatorSpec}
        populationTraitEvidence={frame?.populationTraitEvidence}
      />

      {/* Contextual overlays — float over either layout. */}
      <InspectorSheet
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        spec={simulatorSpec}
        frame={frame}
        run={selectedRun}
        runs={runs}
        selectedRunId={activeRunId}
        onSelectRun={onSelectRun}
        selectedAutomatonId={selectedAutomatonId}
        tab={inspectorTab}
        onTabChange={setInspectorTab}
      />

      <SidelineTutorSheet
        sessionId={sessionId}
        open={tutorOpen}
        onClose={() => setTutorOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  world: { flex: 1, minHeight: 0 },
  viewportFrame: { flex: 1, minHeight: 0, position: "relative" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, pointerEvents: "box-none" },
  firstRunOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  firstRunCard: {
    width: "100%",
    maxWidth: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 18,
  },
  criterion: { position: "absolute", top: 0, left: 0, right: 0 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  loadingText: { fontFamily: fonts.regular, fontSize: 13 },
  errorTitle: { fontFamily: fonts.bold, fontSize: 17, textAlign: "center" },
  errorBody: { fontFamily: fonts.regular, fontSize: 14, textAlign: "center" },
  retryButton: { marginTop: 6, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  retryText: { fontFamily: fonts.bold, fontSize: 14 },
  dockBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});

const WORKBENCH_CONTENT_INSETS = {
  top: 72,
  right: 272,
  bottom: 236,
  left: 352,
} as const;

const WORKBENCH_BG = "#ECFEFF";
