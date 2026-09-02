"use client";

/**
 * The two-column Workbench's right rail — a persistent, tabbed panel that holds
 * the three surfaces the stacked layout keeps as a bottom launch bar + overlay
 * drawers: Run (the launcher), Species (the deck), and History (runs + notebook).
 * The world viewport keeps the left canvas column; nothing overlays it anymore.
 *
 * Run vs Play lives here structurally (plan §7.1): the warm circular Run launcher
 * (make a FRESH run) sits in this panel, while the cool media transport that
 * REPLAYS the selected run is the persistent strip at the top of the same panel.
 * Deck + History stay mounted (display-toggled) so edit/scroll state survives a
 * tab switch — the same components the drawers use, rendered inline.
 */

import { Box, chakra, Flex, HStack, Text } from "@chakra-ui/react";

import type { Id } from "@/convex/_generated/dataModel";
import type { DeckCard, SimulatorSpec } from "@/lib/simulator/contract";
import type { PopulationTraitEvidence } from "@/lib/simulator/scene";
import {
  getWorkbenchRendererFamily,
  workbenchTimeNoun,
} from "@/lib/simulator/templates/registry";
import type { NotebookRow, SimulatorRun, SimulatorRunListItem, WorkbenchRunId } from "@/hooks/useWorkbenchData";
import { RunTray } from "./RunTray";
import { PromptDeckPanel } from "./PromptDeckPanel";
import { NotebookPanel } from "./NotebookPanel";
import { TournamentCard } from "./TournamentCard";
import { MetricStrip, TickScrubber } from "./SimulatorViewport";

export type PanelTab = "run" | "species" | "history";

const TABS: { key: PanelTab; label: string }[] = [
  { key: "run", label: "Run" },
  { key: "species", label: "Species" },
  { key: "history", label: "History" },
];

// Stable ids so each tab can point at the surface it controls (and back).
const tabId = (key: PanelTab) => `workbench-tab-${key}`;
const panelId = (key: PanelTab) => `workbench-panel-${key}`;

// A real <button> (not Box as="button") so `type="button"` is natively typed.
const TabButton = chakra("button");

type CompiledPolicies = React.ComponentProps<typeof PromptDeckPanel>["compiledPolicies"];

export function WorkbenchPanel({
  tab,
  onTabChange,
  sessionId,
  spec,
  activityDescription,
  // Run
  deckDirty,
  hasCompletedRun,
  hasRuns,
  activeRun,
  onLaunched,
  // Species (deck)
  deck,
  deckVersion,
  compiledPolicies,
  focusedSlotId,
  onDeckDirtyChange,
  speciesIcons,
  // History (notebook)
  notebook,
  runs,
  activeRunId,
  selectedRun,
  onSelectRun,
  // Playback transport — moved out of the viewport so the whole square is world.
  tick,
  maxTick,
  moreComing,
  playing,
  onScrub,
  onTogglePlay,
  populationTraitEvidence,
}: {
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  sessionId: Id<"sessions">;
  spec: SimulatorSpec;
  activityDescription?: string;
  deckDirty: boolean;
  hasCompletedRun: boolean;
  hasRuns: boolean;
  activeRun: SimulatorRunListItem | null;
  onLaunched: (runId: WorkbenchRunId) => void;
  deck: readonly DeckCard[];
  deckVersion: number;
  compiledPolicies: CompiledPolicies;
  focusedSlotId: string | null;
  onDeckDirtyChange: (dirty: boolean) => void;
  speciesIcons: Record<string, string | undefined>;
  notebook: NotebookRow[];
  runs: SimulatorRunListItem[];
  activeRunId: WorkbenchRunId | null;
  selectedRun: SimulatorRun | null;
  onSelectRun: (runId: WorkbenchRunId) => void;
  tick: number;
  maxTick: number;
  moreComing: boolean;
  playing: boolean;
  onScrub: (tick: number) => void;
  onTogglePlay: () => void;
  populationTraitEvidence?: PopulationTraitEvidence;
}) {
  const rendererFamily = getWorkbenchRendererFamily(spec.templateId);
  const tabs = TABS.map((item) =>
    item.key === "species" && rendererFamily !== "field"
      ? { ...item, label: "Strategies" }
      : item,
  );
  const timeUnit = workbenchTimeNoun(spec.templateId);
  // Arrow keys move between tabs (the ARIA tabs pattern); focus follows the
  // selection so the roving tab stop stays where the user is.
  const onTabKeyDown = (event: React.KeyboardEvent) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = tabs.findIndex((t) => t.key === tab);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    onTabChange(next.key);
    document.getElementById(tabId(next.key))?.focus();
  };

  return (
    <Flex flexDir="column" h="100%" minH={0} bg="gray.50" borderLeft="1px solid" borderColor="gray.200">
      {/* Persistent playback transport — replays the run showing on the left
          canvas, visible from any tab. Distinct from the Run launcher below. */}
      {selectedRun ? (
        <Box borderBottom="1px solid" borderColor="gray.200" bg="white">
          {spec.templateId === "ecosystemGrid" ? (
            <MetricStrip
              run={selectedRun}
              spec={spec}
              selectedTick={tick}
              populationTraitEvidence={populationTraitEvidence}
            />
          ) : null}
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
            timeUnit={timeUnit}
          />
        </Box>
      ) : null}

      <HStack
        gap={1}
        px={2}
        pt={2}
        borderBottom="1px solid"
        borderColor="gray.200"
        bg="white"
        role="tablist"
        aria-label="Workbench panel"
        onKeyDown={onTabKeyDown}
      >
        {tabs.map((t) => {
          const active = t.key === tab;
          return (
            <TabButton
              type="button"
              key={t.key}
              id={tabId(t.key)}
              role="tab"
              aria-selected={active}
              aria-controls={panelId(t.key)}
              // Roving tab stop: the strip is ONE stop and arrow keys move within
              // it, so a keyboard user isn't made to tab past every surface.
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange(t.key)}
              px={3}
              py={2}
              fontSize="xs"
              fontWeight="600"
              color={active ? "charcoal.600" : "gray.500"}
              borderBottom="2px solid"
              borderColor={active ? "violet.500" : "transparent"}
              _hover={active ? undefined : { color: "gray.700" }}
            >
              {t.label}
            </TabButton>
          );
        })}
      </HStack>

      {/* RUN — the fresh-run launcher. Only this tab's body toggles; the
          deck/history stay mounted. */}
      <Box
        flex={1}
        minH={0}
        overflowY="auto"
        display={tab === "run" ? "block" : "none"}
        p={4}
        id={panelId("run")}
        role="tabpanel"
        aria-labelledby={tabId("run")}
      >
        {activityDescription ? (
          <Box
            bg="cyan.50"
            borderWidth="1px"
            borderColor="cyan.200"
            borderRadius="lg"
            px={3}
            py={2.5}
            mb={4}
          >
            <Text fontSize="2xs" fontWeight="700" color="cyan.700" mb={1}>
              Your challenge
            </Text>
            <Text fontSize="xs" lineHeight="1.5" color="charcoal.600">
              {activityDescription}
            </Text>
          </Box>
        ) : null}
        {hasRuns ? (
          <RunTray
            sessionId={sessionId}
            spec={spec}
            deckDirty={deckDirty}
            deckVersion={deckVersion}
            hasCompletedRun={hasCompletedRun}
            activeRun={activeRun}
            onLaunched={onLaunched}
          />
        ) : null}
      </Box>

      {/* SPECIES — the deck (+ tournament), mounted so edits survive tab switches. */}
      <Flex
        flexDir="column"
        flex={1}
        minH={0}
        display={tab === "species" ? "flex" : "none"}
        id={panelId("species")}
        role="tabpanel"
        aria-labelledby={tabId("species")}
      >
        <Box flex={1} minH={0} overflowY="auto">
          <PromptDeckPanel
            sessionId={sessionId}
            spec={spec}
            deck={deck}
            deckVersion={deckVersion}
            speciesIcons={speciesIcons}
            compiledPolicies={compiledPolicies}
            focusedSlotId={focusedSlotId}
            onDirtyChange={onDeckDirtyChange}
          />
        </Box>
        <Box px={3} pb={3} flexShrink={0}>
          <TournamentCard sessionId={sessionId} onSelectRun={onSelectRun} />
        </Box>
      </Flex>

      {/* HISTORY — runs + notebook, docked inline (kept mounted). */}
      <Flex
        flexDir="column"
        flex={1}
        minH={0}
        display={tab === "history" ? "flex" : "none"}
        id={panelId("history")}
        role="tabpanel"
        aria-labelledby={tabId("history")}
      >
        <NotebookPanel
          docked
          open={tab === "history"}
          onClose={() => {}}
          sessionId={sessionId}
          entries={notebook}
          runs={runs}
          selectedRunId={activeRunId}
          selectedRun={selectedRun}
          onSelectRun={onSelectRun}
          spec={spec}
          populationTraitEvidence={populationTraitEvidence}
        />
      </Flex>
    </Flex>
  );
}
