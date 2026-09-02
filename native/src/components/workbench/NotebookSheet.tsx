/**
 * History: the scholar's run log + typed notebook. The top section lists PAST
 * RUNS (score · days · when, newest first) — tap one to load it into the viewport
 * transport; the composer + timeline below hold hypotheses, engine-written run
 * markers, conclusions, and free notes. Entries are session messages of a typed
 * kind, so the observer already reads them (plan §5.1). Bottom sheet on native.
 */

import { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";
import type { PopulationTraitEvidence } from "../../../vendor/simulator/scene";
import type { NotebookRow, WorkbenchRunId, SimulatorRun, SimulatorRunListItem } from "./useWorkbenchData";
import { formatMetric, hypothesisLabel, metricLabel, runCriterionScore, workbenchTimeNoun } from "./helpers";
import { MetricStrip } from "./MetricStrip";
import { Sheet } from "./Sheet";
import { AppTextInput } from "@/components/AppTextInput";

const TAGS: Record<string, { label: string; color: string }> = {
  hypothesis: { label: "hypothesis", color: "#7C3AED" },
  run_marker: { label: "run", color: "#0E7490" },
  conclusion: { label: "conclusion", color: "#15803D" },
  note: { label: "note", color: "#6B7280" },
};

/**
 * A compact "when" — relative for recent runs, else a short date.
 *
 * Floor, never round: rounding says "1h ago" at 31 minutes and "13h ago" at
 * 12h31m, which overstates how stale a run is. Elapsed time reads as a count of
 * whole units passed. A negative diff (clock skew between device and server)
 * clamps to "just now" rather than rendering a run from the future.
 * Kept identical to the web twin in `components/workbench/NotebookPanel.tsx`.
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
  const colors = useColors();
  const stopRun = useMutation(api.simulatorRuns.stopRun);
  const active = run.status === "queued" || run.status === "ticking";
  const timeNoun = workbenchTimeNoun(spec);
  const score = spec ? runCriterionScore(spec, run.criterionScores) : null;
  const metric =
    score !== null && spec?.criterion.kind === "measured"
      ? metricLabel(spec.criterion.metricKey, score)
      : null;

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Load run — deck v${run.deckVersion}`}
      style={[
        styles.runRow,
        {
          borderColor: selected ? colors.violet : colors.border,
          backgroundColor: selected ? colors.violetSubtle : colors.bg,
        },
      ]}
    >
      <View style={styles.runRowMain}>
        <Text style={[styles.runScore, { color: colors.fg }]} numberOfLines={1}>
          {score !== null ? `${formatMetric(score)}${metric ? ` ${metric}` : ""}` : `v${run.deckVersion}`}
        </Text>
        <Text style={[styles.runMeta, { color: colors.fgMuted }]} numberOfLines={1}>
          v{run.deckVersion} · {timeNoun} {run.latestCommittedTick}/{run.targetTicks} · {relativeWhen(run.queuedAt)}
        </Text>
      </View>
      {active ? (
        <Pressable
          onPress={() => stopRun({ runId: run._id }).catch(() => {})}
          hitSlop={8}
          accessibilityLabel="Stop run"
        >
          <Text style={[styles.runStop, { color: colors.statusRed }]}>Stop</Text>
        </Pressable>
      ) : (
        <Text style={[styles.runStatus, { color: colors.fgMuted }]}>{run.status}</Text>
      )}
    </Pressable>
  );
}

function EntryRow({ row }: { row: NotebookRow }) {
  const colors = useColors();
  const entry = row.entry;
  const meta = TAGS[entry.kind] ?? TAGS.note;
  return (
    <View style={[styles.entry, { borderLeftColor: meta.color }]}>
      <Text style={[styles.entryKind, { color: meta.color }]}>{meta.label}</Text>
      {entry.kind === "hypothesis" ? (
        <Text style={[styles.entryText, { color: colors.fg }]}>
          guessed {hypothesisLabel(entry.prediction.prediction)}
          {entry.prediction.note ? ` — ${entry.prediction.note}` : ""}
        </Text>
      ) : entry.kind === "run_marker" ? (
        <Text style={[styles.entryText, { color: colors.fg }]}>
          ran deck v{entry.deckVersion}
          {entry.outcomeMetrics.length > 0
            ? ` · ${entry.outcomeMetrics
                .slice(0, 2)
                .map((metric) => `${formatMetric(metric.value)} ${metricLabel(metric.key, metric.value)}`)
                .join(" · ")}`
            : ""}
        </Text>
      ) : (
        <Text style={[styles.entryText, { color: colors.fg }]}>{entry.text}</Text>
      )}
      <Text style={[styles.entryTime, { color: colors.fgMuted }]}>
        {new Date(row.createdAt).toLocaleString()}
      </Text>
    </View>
  );
}
export function NotebookSheet({
  open,
  onClose,
  sessionId,
  entries,
  runs,
  selectedRunId,
  selectedRun,
  onSelectRun,
  spec,
  docked,
  populationTraitEvidence,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  entries: NotebookRow[];
  runs: SimulatorRunListItem[];
  selectedRunId: WorkbenchRunId | null;
  /** The selected run + spec drive the "log data" stats (the criterion
   *  sparklines) — these live HERE in the log, never on the main world screen. */
  selectedRun: SimulatorRun | null;
  onSelectRun: (runId: WorkbenchRunId) => void;
  spec: SimulatorSpec | undefined;
  /** Render inline in the right panel (landscape two-column) instead of a sheet. */
  docked?: boolean;
  populationTraitEvidence?: PopulationTraitEvidence;
}) {
  const colors = useColors();
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
          entry: { kind: "conclusion", runIds: selectedRun ? [selectedRun._id] : [], text },
        });
      } else {
        if (!text.trim()) return;
        await append({ sessionId, entry: { kind: "note", text } });
      }
      setText("");
    } catch (error) {
      Alert.alert("Couldn't save", error instanceof Error ? error.message : "Could not save the entry");
    } finally {
      setBusy(false);
    }
  };

  const needsRun = mode === "conclusion" && !selectedRunId;

  return (
    <Sheet open={open} onClose={onClose} side="right" eyebrow="🕰️" title="History" docked={docked}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
        <View style={styles.runsBlock}>
          <Text style={[styles.sectionLabel, { color: colors.fgMuted }]}>runs</Text>
          {runs.length === 0 ? (
            <Text style={[styles.empty, { color: colors.fgMuted }]}>
              your runs collect here — launch one to watch it unfold.
            </Text>
          ) : (
            runs.map((run) => (
              <HistoryRunRow
                key={run._id}
                run={run}
                spec={spec}
                selected={run._id === selectedRunId}
                onSelect={() => onSelectRun(run._id)}
              />
            ))
          )}
        </View>

        {selectedRun && spec ? (
          <View style={styles.statsBlock}>
            <Text style={[styles.sectionLabel, { color: colors.fgMuted }]}>this run · numbers</Text>
            <MetricStrip
              run={selectedRun}
              spec={spec}
              populationTraitEvidence={populationTraitEvidence}
            />
          </View>
        ) : null}

        {entries.length === 0 ? (
          <Text style={[styles.empty, { color: colors.fgMuted }]}>
            your hypotheses, runs, and conclusions collect here.
          </Text>
        ) : (
          [...entries]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((row) => <EntryRow key={row.entryId} row={row} />)
        )}
      </ScrollView>

      <View style={[styles.composer, { borderTopColor: colors.border }]}>
        <View style={styles.modeRow}>
          {(["note", "conclusion"] as const).map((option) => (
            <Pressable
              key={option}
              onPress={() => setMode(option)}
              style={[
                styles.modeChip,
                { backgroundColor: mode === option ? colors.violetSolid : colors.bg, borderColor: colors.violetMuted },
              ]}
            >
              <Text style={[styles.modeText, { color: mode === option ? colors.white : colors.violet }]}>
                {option}
              </Text>
            </Pressable>
          ))}
        </View>
        {needsRun ? (
          <Text style={[styles.warn, { color: colors.orange }]}>
            select a run first (this entry attaches to it)
          </Text>
        ) : null}
        <AppTextInput
          value={text}
          onChangeText={setText}
          placeholder={`write a ${mode}…`}
          placeholderTextColor={colors.fgMuted}
          style={[styles.input, { color: colors.fg, borderColor: colors.border }]}
          multiline
        />
        <Pressable
          onPress={submit}
          disabled={busy}
          style={[styles.addBtn, { backgroundColor: colors.violetSolid }]}
        >
          <Text style={[styles.addText, { color: colors.white }]}>{busy ? "Adding…" : `Add ${mode}`}</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scrollView: { flex: 1 }, // bounded height so the list actually scrolls (see PromptDeckSheet)
  list: { gap: 10, paddingBottom: 14 },
  // The run log at the top of History — tap a row to load it into the transport.
  runsBlock: { gap: 6 },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  runRowMain: { flex: 1, minWidth: 0, gap: 1 },
  runScore: { fontFamily: fonts.bold, fontSize: 14 },
  runMeta: { fontFamily: fonts.regular, fontSize: 11 },
  runStop: { fontFamily: fonts.semibold, fontSize: 12 },
  runStatus: { fontFamily: fonts.medium, fontSize: 10, textTransform: "uppercase" },
  // The run's numbers live here in the log (moved off the world screen). A quiet
  // section above the timeline; MetricStrip carries its own row padding.
  statsBlock: { gap: 2, marginBottom: 2 },
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  empty: { fontFamily: fonts.regular, fontSize: 14, paddingVertical: 12 },
  entry: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 3, gap: 1 },
  entryKind: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase" },
  entryText: { fontFamily: fonts.regular, fontSize: 14 },
  entryTime: { fontFamily: fonts.regular, fontSize: 10 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 8 },
  modeRow: { flexDirection: "row", gap: 6 },
  modeChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  modeText: { fontFamily: fonts.medium, fontSize: 12 },
  warn: { fontFamily: fonts.medium, fontSize: 11 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: fonts.regular,
    fontSize: 14,
    minHeight: 48,
    textAlignVertical: "top",
  },
  addBtn: { alignItems: "center", paddingVertical: 10, borderRadius: 10 },
  addText: { fontFamily: fonts.semibold, fontSize: 14 },
});
