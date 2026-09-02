"use client";

/**
 * History: the scholar's run log + typed notebook. The top section lists PAST
 * RUNS (score · days · when, newest first) — click one to load it into the
 * viewport transport; the composer + timeline below hold hypotheses, engine-
 * written run markers, conclusions, and free notes. Entries are session messages
 * of a typed kind, so the observer already reads them (plan §5.1). Right-side
 * overlay drawer.
 */

import { memo, useState } from "react";
import { useMutation } from "convex/react";
import {
  Box,
  Button,
  Drawer,
  Flex,
  HStack,
  Portal,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { SimulatorSpec } from "@/lib/simulator/contract";
import type { PopulationTraitEvidence } from "@/lib/simulator/scene";
import { workbenchTimeNoun } from "@/lib/simulator/templates/registry";
import { toaster } from "@/lib/toaster";
import type { NotebookRow, SimulatorRun, SimulatorRunListItem, WorkbenchRunId } from "@/hooks/useWorkbenchData";
import { formatMetric, hypothesisLabel, metricLabel, runCriterionScore } from "./helpers";
import { MetricStrip } from "./SimulatorViewport";

/**
 * A compact "when" — relative for recent runs, else a short date.
 *
 * Floor, never round: rounding says "1h ago" at 31 minutes and "13h ago" at
 * 12h31m, which overstates how stale a run is. Elapsed time reads as a count of
 * whole units passed. A negative diff (clock skew between device and server)
 * clamps to "just now" rather than rendering a run from the future.
 */
function relativeWhen(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

function HistoryRunRow({
  run,
  spec,
  selected,
  onSelect,
}: {
  run: SimulatorRunListItem;
  spec: SimulatorSpec | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const stopRun = useMutation(api.simulatorRuns.stopRun);
  const active = run.status === "queued" || run.status === "ticking";
  const timeUnit = spec ? workbenchTimeNoun(spec.templateId) : "day";
  const score = spec ? runCriterionScore(spec, run.criterionScores) : null;
  const metric =
    score !== null && spec?.criterion.kind === "measured"
      ? metricLabel(spec.criterion.metricKey, score)
      : null;
  return (
    <Box
      as="div"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Load run — deck v${run.deckVersion}`}
      borderWidth="1px"
      borderColor={selected ? "violet.400" : "gray.200"}
      bg={selected ? "violet.50" : "white"}
      borderRadius="md"
      px={2}
      py={1.5}
      cursor="pointer"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "1px" }}
    >
      <Flex justify="space-between" align="center" gap={2}>
        <Box minW={0}>
          <Text fontSize="sm" fontWeight="700" color="charcoal.600" lineClamp={1}>
            {score !== null ? `${formatMetric(score)}${metric ? ` ${metric}` : ""}` : `v${run.deckVersion}`}
          </Text>
          <Text fontSize="2xs" color="gray.500" lineClamp={1}>
            v{run.deckVersion} · {timeUnit} {run.latestCommittedTick}/{run.targetTicks} · {relativeWhen(run.queuedAt)}
          </Text>
        </Box>
        {active ? (
          <Button
            size="2xs"
            variant="ghost"
            colorPalette="red"
            onClick={(event) => {
              event.stopPropagation();
              stopRun({ runId: run._id }).catch(() => {});
            }}
          >
            Stop
          </Button>
        ) : (
          <Text fontSize="2xs" color="gray.400">
            {run.status}
          </Text>
        )}
      </Flex>
    </Box>
  );
}

function EntryRow({ row }: { row: NotebookRow }) {
  const entry = row.entry;
  const tag: Record<string, { label: string; color: string }> = {
    hypothesis: { label: "hypothesis", color: "violet.600" },
    run_marker: { label: "run", color: "cyan.700" },
    conclusion: { label: "conclusion", color: "green.700" },
    note: { label: "note", color: "gray.600" },
  };
  const meta = tag[entry.kind] ?? tag.note;
  return (
    <Box borderLeftWidth="3px" borderColor={meta.color} pl={2.5} py={1}>
      <Text fontSize="2xs" color={meta.color} fontWeight="700" textTransform="uppercase" letterSpacing="0.04em">
        {meta.label}
      </Text>
      {entry.kind === "hypothesis" ? (
        <Text fontSize="sm" color="charcoal.600">
          guessed {hypothesisLabel(entry.prediction.prediction)}
          {entry.prediction.note ? ` — ${entry.prediction.note}` : ""}
        </Text>
      ) : entry.kind === "run_marker" ? (
        <Text fontSize="sm" color="charcoal.600">
          ran deck v{entry.deckVersion}
          {entry.outcomeMetrics.length > 0
            ? ` · ${entry.outcomeMetrics
                .slice(0, 2)
                .map((metric) => `${formatMetric(metric.value)} ${metricLabel(metric.key, metric.value)}`)
                .join(" · ")}`
            : ""}
        </Text>
      ) : (
        <Text fontSize="sm" color="charcoal.600" whiteSpace="pre-wrap">
          {entry.text}
        </Text>
      )}
      <Text fontSize="2xs" color="gray.400">
        {new Date(row.createdAt).toLocaleString()}
      </Text>
    </Box>
  );
}

export const NotebookPanel = memo(function NotebookPanel({
  open,
  onClose,
  sessionId,
  entries,
  runs,
  selectedRunId,
  selectedRun,
  onSelectRun,
  spec,
  docked = false,
  populationTraitEvidence,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  entries: NotebookRow[];
  runs: SimulatorRunListItem[];
  selectedRunId: WorkbenchRunId | null;
  /** The loaded run — its summary series feeds the MetricStrip in docked mode. */
  selectedRun?: SimulatorRun | null;
  onSelectRun: (runId: WorkbenchRunId) => void;
  spec: SimulatorSpec | undefined;
  /** Render inline (the two-column panel's History tab) instead of as an overlay
   *  drawer. In docked mode the criterion MetricStrip leads the list. */
  docked?: boolean;
  populationTraitEvidence?: PopulationTraitEvidence;
}) {
  const append = useMutation(api.simulatorBenches.appendNotebook);
  const [mode, setMode] = useState<"note" | "conclusion">("note");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "conclusion") {
        if (!text.trim()) return;
        await append({
          sessionId,
          entry: { kind: "conclusion", runIds: selectedRunId ? [selectedRunId as Id<"simulatorRuns">] : [], text },
        });
      } else {
        if (!text.trim()) return;
        await append({ sessionId, entry: { kind: "note", text } });
      }
      setText("");
    } catch (error) {
      toaster.error({ title: error instanceof Error ? error.message : "Could not save the entry" });
    } finally {
      setBusy(false);
    }
  };

  const listBody = (
    <Box flex={1} minH={0} overflowY="auto" p={3}>
      {/* `spec` can still be loading when a run is already selected, so guard on
          it rather than casting — MetricStrip reads spec.criterion. */}
      {docked && selectedRun && spec ? (
        <Box mb={4}>
          <MetricStrip
            run={selectedRun}
            spec={spec}
            populationTraitEvidence={populationTraitEvidence}
          />
        </Box>
      ) : null}
      <Box mb={4}>
        <Text fontSize="2xs" color="gray.500" fontWeight="700" letterSpacing="0.04em" mb={1.5}>
          Runs
        </Text>
        {runs.length === 0 ? (
          <Text fontSize="sm" color="gray.400">
            your runs collect here — launch one to watch it unfold.
          </Text>
        ) : (
          <Flex flexDir="column" gap={1.5}>
            {runs.map((run) => (
              <HistoryRunRow
                key={run._id}
                run={run}
                spec={spec}
                selected={run._id === selectedRunId}
                onSelect={() => onSelectRun(run._id)}
              />
            ))}
          </Flex>
        )}
      </Box>

      {entries.length === 0 ? (
        <Text fontSize="sm" color="gray.400">
          your hypotheses, runs, and conclusions collect here.
        </Text>
      ) : (
        <Flex flexDir="column" gap={2}>
          {[...entries]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((row) => (
              <EntryRow key={row.entryId} row={row} />
            ))}
        </Flex>
      )}
    </Box>
  );

  const composer = (
    <Box p={3} borderTop="1px solid" borderColor="gray.200">
      <HStack gap={1} mb={2}>
        {(["note", "conclusion"] as const).map((option) => (
          <Button
            key={option}
            size="2xs"
            variant={mode === option ? "solid" : "outline"}
            colorPalette="violet"
            onClick={() => setMode(option)}
          >
            {option}
          </Button>
        ))}
      </HStack>
      {mode === "conclusion" && !selectedRunId ? (
        <Text fontSize="2xs" color="orange.600" mb={1}>
          select a run first (this entry attaches to it)
        </Text>
      ) : null}
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`write a ${mode}…`}
        rows={2}
        size="sm"
        resize="none"
      />
      <Button mt={2} size="sm" colorPalette="violet" w="full" loading={busy} onClick={submit}>
        Add {mode}
      </Button>
    </Box>
  );

  // Docked (the two-column History tab): inline, no drawer chrome — the panel's
  // tab strip already supplies the label, so nothing overlays the grid.
  if (docked) {
    return (
      <Flex flexDir="column" h="100%" minH={0} display={open ? "flex" : "none"}>
        {listBody}
        {composer}
      </Flex>
    );
  }

  return (
    <Drawer.Root open={open} onOpenChange={(event) => (event.open ? null : onClose())} placement="end">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content bg="white" maxW="400px">
            <Flex align="center" justify="space-between" p={3} borderBottom="1px solid" borderColor="gray.200">
              <Text fontWeight="700" color="charcoal.600">
                🕰️ History
              </Text>
              <Button size="xs" variant="ghost" onClick={onClose} aria-label="Close">
                <X />
              </Button>
            </Flex>

            {listBody}
            {composer}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
});
