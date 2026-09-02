/**
 * The inspector — slides up on an automaton tap (plan §7.2). Tabbed:
 *  · Mind — for the tapped automaton, SAW (sense-filtered) / THOUGHT / DID from
 *    the persisted tick record + a NEUTRAL invalid-action marker. No oracle text:
 *    it reports what the automaton perceived and chose, never why a prompt "was
 *    unclear" (plan §4.3).
 *  · Compare — a dot strip of criterion score per run grouped by deck version, so
 *    two runs of the SAME deck scoring differently are visible; a PERSONAL-delta
 *    headline ("+3 vs your best deck"), never a class ranking (§7.3, §4.4).
 */

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type DimensionValue } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { useQuery } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { fonts, palette, useColors } from "@/theme";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";
import {
  describeAction,
  describeObservation,
} from "../../../vendor/simulator/observation";
import { isRedactedObservation } from "../../../vendor/simulator/screenText";
import type { SceneFrame } from "./useWorkbenchScene";
import type { WorkbenchRunId, SimulatorRun, SimulatorRunListItem } from "./useWorkbenchData";
import {
  criterionMetricKey,
  formatMetric,
  isBetter,
  metricLabel,
  runCompareDisplayValue,
  wordDiff,
} from "./helpers";
import { Sheet } from "./Sheet";
import { isRoundBasedWorkbench, workbenchActorNoun, workbenchTimeNoun } from "./workbenchTerminology";

type Tab = "mind" | "compare";

function Field({ label, value, mono, muted }: { label: string; value: string; mono?: boolean; muted?: boolean }) {
  const colors = useColors();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.fgMuted }]}>{label}</Text>
      <View style={[styles.fieldBox, { backgroundColor: colors.bgSubtle }]}>
        <Text
          style={[
            styles.fieldValue,
            {
              color: muted ? colors.fgMuted : colors.fg,
              fontFamily: mono ? fonts.mono : fonts.regular,
              fontStyle: muted ? "italic" : "normal",
            },
          ]}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

function MindTab({
  spec,
  frame,
  run,
  selectedAutomatonId,
}: {
  spec: SimulatorSpec;
  frame: SceneFrame | null;
  run: SimulatorRun | null;
  selectedAutomatonId: string | null;
}) {
  const colors = useColors();
  const roundBased = isRoundBasedWorkbench(spec);
  const actorNoun = workbenchActorNoun(spec);
  const timeNoun = workbenchTimeNoun(spec);
  const automaton =
    frame?.automata.find((entity) => entity.id === selectedAutomatonId) ??
    frame?.terminalAutomata.find((entity) => entity.id === selectedAutomatonId) ??
    null;
  if (!automaton) {
    return (
      <Text style={[styles.empty, { color: colors.fgMuted }]}>
        Tap a {roundBased ? actorNoun : "species"} to read what it saw, thought, and did.
      </Text>
    );
  }
  const policySlot = run?.compiledPolicySnapshot?.find(
    (slot) => slot.slotId === automaton.slotId,
  );
  const prompt = run?.deckSnapshot.find(
    (card) => card.slotId === automaton.slotId,
  )?.prompt;
  const labelBySlot = Object.fromEntries(
    spec.speciesSlots.map((slot) => [slot.slotId, slot.label]),
  );
  const sawRedacted = isRedactedObservation(automaton.saw);
  const sawLines = sawRedacted
    ? []
    : describeObservation(automaton.saw, labelBySlot);
  const didLine = describeAction(automaton.did, automaton.lastAction);
  return (
    <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} contentContainerStyle={styles.tabBody}>
      <View style={styles.mindHead}>
        <Text style={[styles.mindTitle, { color: colors.fg }]}>{automaton.speciesLabel}</Text>
        <Text style={[styles.mindMeta, { color: colors.fgMuted }]}>
          ({automaton.x}, {automaton.y})
          {automaton.energy !== undefined ? ` · energy ${formatMetric(automaton.energy)}` : ""}
        </Text>
      </View>
      {!automaton.alive ? (
        <Text style={[styles.lastDecision, { color: colors.fgMuted }]}>
          Last decision before the terminal outcome · {timeNoun} {automaton.lastDecisionTick}
        </Text>
      ) : null}
      {automaton.invalid ? (
        <View style={[styles.invalid, { backgroundColor: colors.orangeSubtle, borderColor: colors.orangeMuted }]}>
          <Text style={[styles.invalidText, { color: colors.orange }]}>⚠ invalid action this {timeNoun}</Text>
        </View>
      ) : null}
      {sawRedacted ? (
        <Field label="What it noticed" value="Hidden during tournaments" muted />
      ) : (
        <Field
          label="What it noticed"
          value={
            sawLines.length > 0
              ? sawLines.join("\n")
              : "senses quiet — nothing nearby"
          }
        />
      )}
      <Field label="Why it chose" value={automaton.policyTrace || automaton.thought || "—"} />
      <Field
        label="What it did"
        value={didLine}
      />
      {policySlot ? (
        <View style={[styles.policyBox, { borderColor: colors.border }]}>
          <Text style={[styles.policyTitle, { color: colors.fgMuted }]}>
            How this {roundBased ? "strategy" : "species"} follows its instructions
          </Text>
          <Text style={[styles.policyPrompt, { color: colors.fgMuted }]}>
            {roundBased ? "Strategy" : "Prompt"}: {prompt || "—"}
          </Text>
          {policySlot.status === "ready" ? (
            <View style={styles.policyRules}>
              {policySlot.ruleSummaries.map((summary, index) => (
                <Text
                  key={`${policySlot.slotId}-${index}`}
                  style={[styles.policyRule, { color: colors.fg }]}
                >
                  {index + 1}. {summary}
                </Text>
              ))}
              <Text style={[styles.policyDefault, { color: colors.fgMuted }]}>
                If none match, it chooses from what it noticed.
              </Text>
            </View>
          ) : (
            <Text style={[styles.policyError, { color: colors.orange }]}>
              {policySlot.reason === "failed"
                ? `These instructions were not ready for this run, so the ${roundBased ? "player" : "species"} chose from what it noticed.`
                : policySlot.reason === "compiling"
                  ? `These instructions were still getting ready when the run started, so the ${roundBased ? "player" : "species"} chose from what it noticed.`
                  : `These instructions were unavailable when the run started, so the ${roundBased ? "player" : "species"} chose from what it noticed.`}
            </Text>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

function DeckDiff({
  spec,
  runIdA,
  runIdB,
}: {
  spec: SimulatorSpec;
  runIdA: WorkbenchRunId;
  runIdB: WorkbenchRunId;
}) {
  const colors = useColors();
  // The frozen prompt decks live only on the detail projection — fetch the two
  // selected runs individually (bounded: exactly the pair the scholar chose).
  const runA = useQuery(api.simulatorRuns.get, { runId: runIdA as Id<"simulatorRuns"> });
  const runB = useQuery(api.simulatorRuns.get, { runId: runIdB as Id<"simulatorRuns"> });

  if (runA === undefined || runB === undefined) {
    return <Text style={[styles.small, { color: colors.fgMuted }]}>loading the two decks…</Text>;
  }
  if (!runA?.deckSnapshot || !runB?.deckSnapshot) {
    return (
      <Text style={[styles.small, { color: colors.fgMuted }]}>
        deck text isn&apos;t available for one of these runs.
      </Text>
    );
  }
  const bySlotA = new Map(runA.deckSnapshot.map((card) => [card.slotId, card]));
  const bySlotB = new Map(runB.deckSnapshot.map((card) => [card.slotId, card]));

  return (
    <View style={styles.diffWrap}>
      <Text style={[styles.diffHeader, { color: colors.fgMuted }]}>
        prompt changes · v{runA.deckVersion} → v{runB.deckVersion}
      </Text>
      {spec.speciesSlots.map((slot) => {
        const before = bySlotA.get(slot.slotId);
        const after = bySlotB.get(slot.slotId);
        const tokens = wordDiff(before?.prompt ?? "", after?.prompt ?? "");
        const changed = tokens.some((token) => token.kind !== "same");
        const countChanged = before && after && before.count !== after.count;
        return (
          <View key={slot.slotId} style={styles.diffSlot}>
            <Text style={[styles.diffSlotLabel, { color: colors.fg }]}>
              {slot.label}
              {countChanged ? `  ·  count ${before?.count} → ${after?.count}` : ""}
            </Text>
            {changed ? (
              <Text style={styles.diffLine}>
                {tokens.map((token, index) => (
                  <Text
                    key={index}
                    style={{
                      color:
                        token.kind === "added"
                          ? colors.green
                          : token.kind === "removed"
                            ? colors.statusRed
                            : colors.fgMuted,
                      textDecorationLine: token.kind === "removed" ? "line-through" : "none",
                      fontFamily: token.kind === "same" ? fonts.regular : fonts.semibold,
                    }}
                  >
                    {token.text + " "}
                  </Text>
                ))}
              </Text>
            ) : (
              <Text style={[styles.small, { color: colors.fgMuted }]}>no prompt change</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

function CompareOverlay({ spec, runs }: { spec: SimulatorSpec; runs: SimulatorRunListItem[] }) {
  const colors = useColors();
  const metricKey = criterionMetricKey(spec);
  const palette = ["#7C3AED", "#0E7490"];
  const width = 260;
  const height = 72;

  const seriesFor = (run: SimulatorRunListItem) =>
    metricKey
      ? run.summarySeries
          .map((sample) => {
            const value = sample.values.find((candidate) => candidate.key === metricKey);
            return value ? { tick: sample.tick, value: value.value } : null;
          })
          .filter((point): point is { tick: number; value: number } => point !== null)
      : [];

  const all = runs.flatMap(seriesFor);
  if (all.length < 2) {
    return (
      <Text style={[styles.small, { color: colors.fgMuted }]}>
        overlaid metric series appear once these runs have data.
      </Text>
    );
  }
  const maxTick = Math.max(...all.map((point) => point.tick), 1);
  const maxVal = Math.max(...all.map((point) => point.value), 1);
  const minVal = Math.min(...all.map((point) => point.value), 0);
  const valSpan = maxVal - minVal || 1;

  return (
    <View>
      <Text style={[styles.small, { color: colors.fgMuted, marginBottom: 4 }]}>
        {metricKey ? metricLabel(metricKey) : "metric"} over time
      </Text>
      <Svg width={width} height={height}>
        {runs.map((run, index) => {
          const points = seriesFor(run)
            .map((point) => {
              const px = (point.tick / maxTick) * width;
              const py = height - ((point.value - minVal) / valSpan) * (height - 4) - 2;
              return `${px.toFixed(1)},${py.toFixed(1)}`;
            })
            .join(" ");
          return <Polyline key={run._id} points={points} fill="none" stroke={palette[index % 2]} strokeWidth={1.8} />;
        })}
      </Svg>
      <View style={styles.legendRow}>
        {runs.map((run, index) => (
          <View key={run._id} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: palette[index % 2] }]} />
            <Text style={[styles.small, { color: colors.fgMuted }]}>
              v{run.deckVersion}{run.extinct ? " · terminal outcome" : ""}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function CompareTab({
  spec,
  runs,
  selectedRunId,
  onSelectRun,
}: {
  spec: SimulatorSpec;
  runs: SimulatorRunListItem[];
  selectedRunId: WorkbenchRunId | null;
  onSelectRun: (runId: WorkbenchRunId) => void;
}) {
  const colors = useColors();
  const [pair, setPair] = useState<WorkbenchRunId[]>([]);
  const metricKey = criterionMetricKey(spec);
  const terminalFill = colors.bg === palette.white ? palette.orange[800] : palette.orange[400];

  const compared = useMemo(
    () =>
      runs
        .map((run) => ({
          run,
          outcome: runCompareDisplayValue(spec, run.criterionScores, run.currentMetrics, run.extinct),
        }))
        .filter(
          (entry): entry is { run: SimulatorRunListItem; outcome: { value: number; terminal: boolean } } =>
            entry.outcome !== null,
        ),
    [runs, spec],
  );

  if (compared.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.fgMuted }]}>
        finished runs plot here — one dot per run, grouped by deck version, so you can see when the
        same deck lands differently.
      </Text>
    );
  }

  const values = compared.map((entry) => entry.outcome.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const scored = compared.filter((entry) => !entry.outcome.terminal);
  const best =
    scored.length > 0
      ? scored.reduce(
          (bestValue, entry) =>
            isBetter(spec, entry.outcome.value, bestValue) ? entry.outcome.value : bestValue,
          scored[0].outcome.value,
        )
      : null;

  const byVersion = new Map<number, typeof compared>();
  for (const entry of compared) {
    const list = byVersion.get(entry.run.deckVersion) ?? [];
    list.push(entry);
    byVersion.set(entry.run.deckVersion, list);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);

  const selected = scored.find((entry) => entry.run._id === selectedRunId);
  const delta = selected && best !== null ? selected.outcome.value - best : 0;
  const deltaLabel =
    selected && best !== null
      ? isBetter(spec, selected.outcome.value, best)
        ? "new best"
        : selected.outcome.value === best
          ? "matches your best"
          : `${delta > 0 ? "+" : ""}${formatMetric(delta)} vs your best deck`
      : null;

  const toggle = (runId: WorkbenchRunId) => {
    setPair((current) =>
      current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId].slice(-2),
    );
    onSelectRun(runId);
  };

  return (
    <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} contentContainerStyle={styles.tabBody}>
      {deltaLabel ? (
        <View style={[styles.deltaBox, { backgroundColor: colors.violetSubtle }]}>
          <Text style={[styles.deltaText, { color: colors.violet }]}>{deltaLabel}</Text>
          <Text style={[styles.small, { color: colors.fgMuted }]}>
            your result vs your own best — never a class ranking
          </Text>
        </View>
      ) : null}

      <Text style={[styles.small, { color: colors.fgMuted }]}>
        {metricKey ? metricLabel(metricKey) : "score"} · low {formatMetric(min)} → high {formatMetric(max)}
      </Text>
      {compared.some((entry) => entry.outcome.terminal) ? (
        <Text style={[styles.terminalHint, { color: colors.fgMuted }]}>
          square dots are terminal outcomes: final measured value, not a score.
        </Text>
      ) : null}

      {versions.map((version) => (
        <View key={version} style={styles.versionRow}>
          <Text style={[styles.versionLabel, { color: colors.fgMuted }]}>deck v{version}</Text>
          <View style={[styles.dotTrack, { backgroundColor: colors.bgSubtle }]}>
            {(byVersion.get(version) ?? []).map((entry) => {
              const on = pair.includes(entry.run._id);
              const { terminal, value } = entry.outcome;
              const left: DimensionValue = `${((value - min) / span) * 100}%`;
              return (
                <Pressable
                  key={entry.run._id}
                  onPress={() => toggle(entry.run._id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`deck v${version} ${terminal ? "terminal outcome, final measured value" : "run"}, ${formatMetric(value)} ${metricKey ? metricLabel(metricKey, value) : "score"}${terminal ? ", not a scored result" : value === best ? ", your best" : ""}`}
                  accessibilityState={{ selected: on }}
                  style={[
                    styles.scoreDot,
                    {
                      left,
                      width: on ? 15 : 12,
                      height: on ? 15 : 12,
                      marginLeft: on ? -7.5 : -6,
                      marginTop: on ? -7.5 : -6,
                      backgroundColor: terminal ? terminalFill : value === best ? colors.violetSolid : colors.cyan,
                      borderWidth: on ? 2 : 0,
                      borderColor: colors.fg,
                      borderStyle: "solid",
                      borderRadius: terminal ? 2 : 999,
                    },
                  ]}
                />
              );
            })}
          </View>
        </View>
      ))}

      {pair.length === 2 ? (
        <>
          <CompareOverlay spec={spec} runs={runs.filter((run) => pair.includes(run._id))} />
          <DeckDiff spec={spec} runIdA={pair[0]} runIdB={pair[1]} />
        </>
      ) : (
        <Text style={[styles.small, { color: colors.fgMuted }]}>
          tap two dots to overlay their runs and diff their prompt decks.
        </Text>
      )}
    </ScrollView>
  );
}

export function InspectorSheet({
  open,
  onClose,
  spec,
  frame,
  run,
  runs,
  selectedRunId,
  onSelectRun,
  selectedAutomatonId,
  tab,
  onTabChange,
}: {
  open: boolean;
  onClose: () => void;
  spec: SimulatorSpec;
  frame: SceneFrame | null;
  run: SimulatorRun | null;
  runs: SimulatorRunListItem[];
  selectedRunId: WorkbenchRunId | null;
  onSelectRun: (runId: WorkbenchRunId) => void;
  selectedAutomatonId: string | null;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  const colors = useColors();
  return (
    <Sheet open={open} onClose={onClose} eyebrow="Inspector" title="What happened" heightFraction={0.7}>
      <View style={[styles.tabs, { borderColor: colors.violetMuted }]}>
        {(["mind", "compare"] as Tab[]).map((option) => (
          <Pressable
            key={option}
            onPress={() => onTabChange(option)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === option }}
            accessibilityLabel={option === "mind" ? "Mind tab" : "Compare tab"}
            style={[
              styles.tabBtn,
              { backgroundColor: tab === option ? colors.violetSolid : "transparent" },
            ]}
          >
            <Text style={[styles.tabText, { color: tab === option ? colors.white : colors.violet }]}>
              {option === "mind" ? "Mind" : "Compare"}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === "mind" ? (
        <MindTab
          spec={spec}
          frame={frame}
          run={run}
          selectedAutomatonId={selectedAutomatonId}
        />
      ) : (
        <CompareTab spec={spec} runs={runs} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: "row",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 3,
    gap: 3,
    marginBottom: 10,
  },
  tabBtn: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: 8 },
  tabText: { fontFamily: fonts.semibold, fontSize: 13 },
  scrollView: { flex: 1 }, // bounded height so the tab scrolls (see PromptDeckSheet)
  tabBody: { gap: 12, paddingBottom: 24 },
  empty: { fontFamily: fonts.regular, fontSize: 14, paddingVertical: 16 },
  mindHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  mindTitle: { fontFamily: fonts.bold, fontSize: 15 },
  mindMeta: { fontFamily: fonts.regular, fontSize: 12 },
  lastDecision: { fontFamily: fonts.medium, fontSize: 12, marginTop: -8 },
  invalid: {
    alignSelf: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  invalidText: { fontFamily: fonts.medium, fontSize: 12 },
  field: { gap: 4 },
  fieldLabel: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.6 },
  fieldBox: { borderRadius: 8, padding: 10 },
  fieldValue: { fontSize: 12, lineHeight: 17 },
  policyBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 8 },
  policyTitle: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.6 },
  policyPrompt: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  policyRules: { gap: 5 },
  policyRule: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  policyDefault: { fontFamily: fonts.regular, fontSize: 11 },
  policyError: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  small: { fontFamily: fonts.regular, fontSize: 11 },
  deltaBox: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, gap: 2 },
  deltaText: { fontFamily: fonts.bold, fontSize: 15 },
  terminalHint: { fontFamily: fonts.regular, fontSize: 11, marginTop: -6 },
  versionRow: { gap: 4 },
  versionLabel: { fontFamily: fonts.regular, fontSize: 10 },
  dotTrack: { height: 20, borderRadius: 999, justifyContent: "center" },
  scoreDot: { position: "absolute", top: "50%", borderRadius: 999 },
  legendRow: { flexDirection: "row", gap: 12, marginTop: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  diffWrap: { gap: 10, marginTop: 6 },
  diffHeader: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase" },
  diffSlot: { gap: 2 },
  diffSlotLabel: { fontFamily: fonts.semibold, fontSize: 12 },
  diffLine: { fontSize: 13, lineHeight: 19 },
});
